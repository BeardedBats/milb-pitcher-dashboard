// Hash-routing + new-tab navigation helpers extracted from App.jsx.
//
// This module is the source of truth for the dashboard's hash-route shape and
// for the browser-specific "open in new tab" gesture handling. The destination
// app can keep these as adapters (or replace them with a real router) without
// hunting the behavior down inside App.jsx.
//
// Current hash routes:
//   #                                  → games (home)
//   #card/{date}/{pitcherId}/{gamePk}  → game-level pitcher card
//   #player/{pitcherId}                → season player page
//   #team/{teamAbbrev}                 → team page
//
// Hash builders return the route WITHOUT the leading "#": callers prepend "#"
// for href/pushState, and openHashInNewWindow adds it when constructing a URL.

export function getHashParts(rawHash) {
  const hash = (rawHash || "").replace(/^#/, "");
  if (!hash) return [];
  return hash.split("/");
}

// Parse a raw hash into a structured route descriptor. Returns { type: "home" }
// for the empty hash or any malformed route (callers then no-op), matching the
// original App.jsx branch guards exactly.
export function parseBaseballHash(rawHash) {
  const parts = getHashParts(rawHash);
  if (parts[0] === "player" && parts[1]) {
    return { type: "player", pitcherId: Number(parts[1]) };
  }
  if (parts[0] === "team" && parts[1]) {
    return { type: "team", team: parts[1] };
  }
  if (parts[0] === "card" && parts[1] && parts[2] && parts[3]) {
    return { type: "card", date: parts[1], pitcherId: Number(parts[2]), gamePk: Number(parts[3]) };
  }
  return { type: "home" };
}

export function buildCardHash({ date, pitcherId, gamePk }) {
  return `card/${date}/${pitcherId}/${gamePk}`;
}

export function buildPlayerHash(pitcherId) {
  return `player/${pitcherId}`;
}

export function buildTeamHash(teamAbbrev) {
  return `team/${teamAbbrev}`;
}

// True when Ctrl (or Cmd on Mac) or a middle-click was held during a click —
// the "open in a new tab" gesture.
export function isNewWindowClick(e) {
  return e && (e.ctrlKey || e.metaKey || e.button === 1);
}

// Open a hash route in a new tab (Electron or browser).
// Browser path: dispatches a synthetic click on a real <a target="_blank">.
// See "Create Tabs / Background-Tab Opening" in CLAUDE.md: the synthetic
// ctrlKey is ignored by Chrome — background vs foreground comes from the REAL
// gesture this runs inside, and the dispatch must stay synchronous within it.
export function openHashInNewWindow(hash) {
  if (window.electronAPI?.openNewWindow) {
    window.electronAPI.openNewWindow(hash);
    return true;
  }
  const url = window.location.origin + window.location.pathname + "#" + hash;
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener nofollow";
  a.style.display = "none";
  document.body.appendChild(a);
  // Dispatch a Ctrl+Click so the browser treats it as "open in background tab"
  a.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
  document.body.removeChild(a);
  return true;
}

export function openHashesInNewTabs(hashes) {
  if (window.electronAPI?.openNewWindow) {
    hashes.forEach(hash => window.electronAPI.openNewWindow(hash));
    return hashes.length;
  }

  // Open each card via a synthetic click on a real anchor — unlike a
  // window.open loop, the browser doesn't pop-up-block everything after the
  // first. Background vs foreground follows the REAL gesture this runs inside
  // (see openHashInNewWindow): middle-click or Ctrl/Cmd+click keeps focus here;
  // a plain click follows the last tab.
  hashes.forEach(hash => {
    const url = window.location.origin + window.location.pathname + "#" + hash;
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener nofollow";
    a.style.display = "none";
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent("click", { ctrlKey: true, bubbles: true, cancelable: true }));
    document.body.removeChild(a);
  });
  return hashes.length;
}

export function scrollToTopAfterRender() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => window.scrollTo(0, 0));
  });
}
