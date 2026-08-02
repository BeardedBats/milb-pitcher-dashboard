import React, { useState, useRef, useEffect } from "react";
import { fetchPitchersDirectory, fetchPitchersSearch } from "../utils/api";

// Accent-stripped lowercase — mirrors backend _name_search_norm so client-side
// matching behaves identically ("emerson" ↔ "Émerson").
function normName(s) {
  return (s || "").normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase();
}

// Fetch the full pitcher directory once and share it across mounts. The list
// is small (~600 records) and stable across the season, so we filter locally
// and never hit the network per keystroke.
let directoryPromise = null;
function loadDirectory() {
  if (!directoryPromise) {
    directoryPromise = fetchPitchersDirectory()
      .then((data) => {
        const list = Array.isArray(data) ? data : [];
        // Don't cache an empty result — the backend may still be warming the
        // directory in the background. Allow a retry to pick up the full list.
        if (list.length === 0) directoryPromise = null;
        return list;
      })
      .catch(() => {
        directoryPromise = null;
        return [];
      });
  }
  return directoryPromise;
}

// Relevance-rank matches for a query: name-start beats word-start beats a
// mid-string hit; ties break by recency (most recent appearance), then volume
// (pitches thrown), then alphabetically.
function rankMatches(list, qNorm) {
  const scored = [];
  for (const p of list) {
    const nn = p.name_norm || normName(p.name);
    const idx = nn.indexOf(qNorm);
    if (idx === -1) continue;
    let matchScore;
    if (nn.startsWith(qNorm)) matchScore = 3;
    else if (nn.split(" ").some((w) => w.startsWith(qNorm))) matchScore = 2;
    else matchScore = 1;
    scored.push({ p, matchScore });
  }
  scored.sort((a, b) => {
    if (b.matchScore !== a.matchScore) return b.matchScore - a.matchScore;
    const ad = a.p.last_date || "";
    const bd = b.p.last_date || "";
    if (bd !== ad) return bd < ad ? -1 : 1; // most recent first
    const av = a.p.pitches || 0;
    const bv = b.p.pitches || 0;
    if (bv !== av) return bv - av; // higher volume first
    return a.p.name.localeCompare(b.p.name);
  });
  return scored.map((s) => s.p);
}

/**
 * Pitcher search. Fetches the full directory once on mount and filters/ranks
 * it client-side for instant, network-free results. Falls back to the
 * server-side /api/pitchers-search endpoint if the directory can't be loaded.
 */
export default function SearchBar({ onSelectPlayer }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const wrapperRef = useRef(null);
  const directoryRef = useRef(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Warm the directory as soon as the search bar mounts. If it comes back
  // empty (cold backend warming in the background), retry once shortly after.
  useEffect(() => {
    let alive = true;
    let retryTimer = null;
    const attempt = (retriesLeft) => {
      loadDirectory().then((list) => {
        if (!alive) return;
        directoryRef.current = list;
        if (list.length === 0 && retriesLeft > 0) {
          retryTimer = setTimeout(() => attempt(retriesLeft - 1), 3000);
        }
      });
    };
    attempt(2);
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
  }, []);

  // Stale-tolerant server fallback for when the directory failed to load.
  const serverSearch = (trimmed) => {
    const myReqId = ++reqIdRef.current;
    fetchPitchersSearch(trimmed)
      .then((data) => {
        if (myReqId !== reqIdRef.current) return;
        setResults(Array.isArray(data) ? data : []);
        setOpen(true);
        setHighlightIdx(-1);
      })
      .catch(() => {
        if (myReqId !== reqIdRef.current) return;
        setResults([]);
        setOpen(true);
      });
  };

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      setResults([]);
      setOpen(false);
      return;
    }
    const dir = directoryRef.current;
    if (dir && dir.length > 0) {
      // Client-side path — instant, no network.
      const qNorm = normName(trimmed);
      setResults(rankMatches(dir, qNorm).slice(0, 20));
      setOpen(true);
      setHighlightIdx(-1);
      return;
    }
    // Directory not ready (still loading or failed) — fall back to the server,
    // lightly debounced so we don't flood while it loads.
    const t = setTimeout(() => serverSearch(trimmed), 150);
    return () => clearTimeout(t);
  }, [query]);

  const handleSelect = (player, e) => {
    setQuery("");
    setResults([]);
    setOpen(false);
    setHighlightIdx(-1);
    // Server already gave us the pitcher_id — pass it directly.
    onSelectPlayer(player.pitcher_id, player.name, e);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      setOpen(false);
      e.target.blur();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIdx((prev) => Math.min(prev + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIdx((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && highlightIdx >= 0 && highlightIdx < results.length) {
      e.preventDefault();
      handleSelect(results[highlightIdx], e);
    }
  };

  return (
    <div className="search-bar" ref={wrapperRef}>
      <input
        type="text"
        className="search-input"
        placeholder="Player Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
      />
      {open && results.length > 0 && (
        <div className="search-dropdown">
          {results.map((p, idx) => (
            <div
              key={p.pitcher_id}
              className={`search-result${idx === highlightIdx ? " highlighted" : ""}`}
              onClick={(e) => handleSelect(p, e)}
              onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); handleSelect(p, e); } }}
            >
              <span className="search-result-name">{p.name}</span>
            </div>
          ))}
        </div>
      )}
      {open && results.length === 0 && query.trim() && (
        <div className="search-dropdown">
          <div className="search-result search-no-results">No pitchers found</div>
        </div>
      )}
    </div>
  );
}
