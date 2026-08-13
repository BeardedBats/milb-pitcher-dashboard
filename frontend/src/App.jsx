import React, { useState, useEffect, useMemo, useCallback, useRef as useReactRef, Suspense, lazy } from "react";
import DatePicker from "./components/DatePicker";
import GameTabs from "./components/GameTabs";
import PitchDataTable from "./components/PitchDataTable";
import PitcherResultsTable from "./components/PitcherResultsTable";
import PitcherCard from "./components/PitcherCard";
import Scoreboard from "./components/Scoreboard";
import PlayByPlayModal from "./components/PlayByPlayModal";
import ReclassifyModal from "./components/ReclassifyModal";
import SearchBar from "./components/SearchBar";
import AdaptedResultsTable, { ADAPTED_COLUMNS, ADAPTED_DEFAULT_HIDDEN } from "./components/AdaptedResultsTable";
import RehabStartsTable, { REHAB_COLUMNS, REHAB_DEFAULT_HIDDEN } from "./components/RehabStartsTable";
import ExportGameLogsModal from "./components/ExportGameLogsModal";
import { fetchGames, fetchPitchData, fetchPitcherResults, fetchPitcherCard, fetchDefaultDate, fetchGameLinescore, fetchGameView, reclassifyPitch, fetchInitialLoad, fetchRefresh, fetchLastRefresh, resolvePitcher, fetchLevels, fetchRehabStarts, DEFAULT_LEVEL } from "./utils/api";
import { PITCH_TYPE_FILTERS, PITCH_COLORS, TEAM_FULL_NAMES, PITCHER_RESULTS_COLUMNS } from "./constants";
import usePersistentState from "./hooks/usePersistentState";
import { usePolledLinescore } from "./hooks/useLiveLinescore";
import useIsMobile from "./hooks/useIsMobile";
import {
  getHashParts,
  parseBaseballHash,
  buildCardHash,
  buildPlayerHash,
  buildTeamHash,
  isNewWindowClick,
  openHashInNewWindow,
  openHashesInNewTabs,
  scrollToTopAfterRender,
  homePath,
  isRehabPath,
  REHAB_PATH,
} from "./utils/navigation";

// Columns dropdown sections for the adapted (non-Statcast) table.
const ADAPTED_COLUMN_GROUPS = Object.entries(
  ADAPTED_COLUMNS.filter(c => c.key !== "pitcher").reduce((acc, c) => {
    (acc[c.group || "Other"] = acc[c.group || "Other"] || []).push(c);
    return acc;
  }, {}),
);

// Lazy-load pages that aren't needed on initial render
const TeamPage = lazy(() => import("./components/TeamPage"));
const PlayerPage = lazy(() => import("./components/PlayerPage"));

function getYesterdayEST() {
  // Fallback: current time in US Eastern, minus 1 day
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  now.setDate(now.getDate() - 1);
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getBaseballDateEST() {
  // Match the backend's "baseball day" rollover: before 5 AM ET, treat the
  // current slate as yesterday's date.
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  if (now.getHours() < 5) {
    now.setDate(now.getDate() - 1);
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function isLiveGame(game) {
  if (!game) return false;
  return game.abstract_state === "Live" || ["In Progress", "Manager challenge"].includes(game.status);
}

export default function App() {
  const isMobile = useIsMobile();
  const startsOnHashRoute = React.useRef(getHashParts(window.location.hash).length > 0);
  // /rehab is a real, shareable URL. A hash route still wins — the hash is the
  // more specific destination and /rehab#player/123 must open the player.
  const startsOnRehab = React.useRef(isRehabPath() && !startsOnHashRoute.current);
  const [date, setDate] = useState(null);
  const [games, setGames] = useState([]);
  const [selectedGame, setSelectedGame] = useState(null);
  const [view, setView] = useState("pitcher-results");
  const [pitchData, setPitchData] = useState([]);
  const [resultsData, setResultsData] = useState([]);
  const [cardData, setCardData] = useState(null);
  const [pendingCard, setPendingCard] = useState(null);
  const [loading, setLoading] = useState(() => startsOnHashRoute.current);
  const [error, setError] = useState(null);
  // Bumping this triggers the date-driven data effect to re-run without
  // requiring a full page reload. Used by the error-banner Retry button.
  const [retryNonce, setRetryNonce] = useState(0);
  const [spOnly, setSpOnly] = useState(true);
  const [rpOnly, setRpOnly] = useState(false);
  const [splitByTeam, setSplitByTeam] = useState(false);
  // "Export Game Logs" lightbox (season CSV of the daily performance table).
  const [showExport, setShowExport] = useState(false);
  // Level + MLB-org filters for the main game log. Level drives which backend
  // pipeline answers (Statcast vs box-score); org is a pure client-side filter
  // on rows that already carry `org`.
  const [level, setLevel] = usePersistentState("pl_milb_level", DEFAULT_LEVEL);
  const [orgFilter, setOrgFilter] = usePersistentState("pl_milb_org", "");
  const [levelMeta, setLevelMeta] = useState(null);
  // Rehab is a cross-level PAGE (MLB arms on the IL rehabbing anywhere in the
  // minors), so it ignores the level/org filters and the selected date
  // entirely. It lives at /rehab; see utils/navigation.
  const [rehabData, setRehabData] = useState(null);
  const [rehabLoading, setRehabLoading] = useState(false);
  const [rehabError, setRehabError] = useState(null);
  const [rehabSortKey, setRehabSortKey] = useState("date");
  const [rehabSortDir, setRehabSortDir] = useState("desc");
  const [rehabHiddenCols, setRehabHiddenCols] = usePersistentState(
    "pl_milb_rehab_hidden", REHAB_DEFAULT_HIDDEN);
  const [showRehabColFilter, setShowRehabColFilter] = useState(false);
  // Green names for pitchers with big-league service. Persisted and applied via
  // a root class so every table (games, team, player, rehab) follows one
  // switch — see `.mlb-exp-on` in styles.css.
  const [mlbGreen, setMlbGreen] = usePersistentState("pl_milb_mlb_green", true);
  const [pitchFilter, setPitchFilter] = useState("Four-Seamer");
  const [resultsHiddenCols, setResultsHiddenCols] = useState(["team", "hand"]);
  // The adapted table has far more columns than the Statcast one (five metric
  // families), so most open hidden and the Columns dropdown reveals them.
  const [adaptedHiddenCols, setAdaptedHiddenCols] = usePersistentState(
    "pl_milb_adapted_hidden", ADAPTED_DEFAULT_HIDDEN);
  const [showColFilter, setShowColFilter] = useState(false);
  // Shown after a plain click on Create Tabs, where the browser will move
  // focus to the last opened tab and the page can't prevent it.
  const [tabsHint, setTabsHint] = useState(false);
  const tabsHintTimer = React.useRef(null);
  const [pbpModal, setPbpModal] = useState(null); // { inning, isTop } or null
  const [reclassifyPitch_, setReclassifyPitch] = useState(null); // pitch object to reclassify
  const [page, setPage] = useState(() => (startsOnRehab.current ? "rehab" : "games")); // "games" | "team" | "player" | "rehab"
  const [playerPageId, setPlayerPageId] = useState(null);
  const [selectedTeamPage, setSelectedTeamPage] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [toast, setToast] = useState(null); // { message, type: "success"|"error" }

  // Lifted sort state so it persists across card navigation
  const [resultsSortKey, setResultsSortKey] = useState("er");
  const [resultsSortDir, setResultsSortDir] = useState("asc");
  const [pitchSortKey, setPitchSortKey] = useState(null);
  const [pitchSortDir, setPitchSortDir] = useState("asc");
  const [currentTableRows, setCurrentTableRows] = useState([]);

  // Track whether this is the initial mount load (combined endpoint) vs user date change
  const initialLoadDone = React.useRef(false);
  // Ref to skip the date-change useEffect when navigating to a game card from player page
  const skipDateFetchForCard = React.useRef(false);
  // Ref to skip the pitch/results data fetch (e.g. after initial load already provided it)
  const skipNextDataFetch = React.useRef(false);
  const selectedGameMeta = useMemo(
    () => games.find(g => g.game_pk === selectedGame) || null,
    [games, selectedGame],
  );
  const selectedGameIsLive = isLiveGame(selectedGameMeta);

  const applyGameViewData = useCallback((data) => {
    setPitchData(data?.pitchData || []);
    setResultsData(data?.resultsData || []);
    if (data?.updatedAt) setLastRefresh(data.updatedAt);
  }, []);

  const loadSelectedGameView = useCallback(async (gamePk) => {
    if (!date || gamePk == null) return null;
    const data = await fetchGameView(date, gamePk, level);
    applyGameViewData(data);
    return data;
  }, [applyGameViewData, date, level]);

  // Fetch everything on mount in a single API call.
  useEffect(() => {
    const hashParts = getHashParts(window.location.hash);
    if (hashParts.length > 0) return; // Deep-link will handle its own loading
    // Landing on /rehab needs none of the slate: the Rehab view is its own
    // endpoint. resetToDefault() fetches the slate if the user navigates home.
    if (startsOnRehab.current) return;
    setLoading(true);
    fetchInitialLoad(level)
      .then(data => {
        initialLoadDone.current = true;
        skipNextDataFetch.current = true;
        setDate(data.date);
        setGames(data.games);
        setPitchData(data.pitchData);
        setResultsData(data.resultsData);
        setLastRefresh(data.statLinesUpdatedAt || null);
        setLoading(false);
      })
      .catch(() => {
        // Fallback to sequential flow — date change will trigger games fetch
        setLoading(false);
        fetchDefaultDate()
          .then(d => setDate(d))
          .catch(() => setDate(getYesterdayEST()));
      });
  }, []); // eslint-disable-line

  // Rehab SP data — fetched on first activation, then reused.
  //
  // In-flight state lives in a ref, NOT the dep array: setRehabLoading(true)
  // would re-run the effect, whose cleanup would flip `cancelled` and throw
  // away the response that was already on its way, leaving the view stuck on
  // "Finding rehab starts...".
  const rehabInFlight = React.useRef(false);
  useEffect(() => {
    if (page !== "rehab" || rehabData || rehabInFlight.current) return;
    rehabInFlight.current = true;
    setRehabLoading(true);
    setRehabError(null);
    fetchRehabStarts(14)
      .then(d => { setRehabData(d); })
      // A failure must not fall through to the table's empty state — "nobody is
      // rehabbing" and "the request died" are different answers.
      .catch(() => { setRehabError("Failed to load rehab starts."); })
      .finally(() => { rehabInFlight.current = false; setRehabLoading(false); });
  }, [page, rehabData]);

  // Level + org dropdown options (static per season).
  useEffect(() => {
    fetchLevels().then(setLevelMeta).catch(() => {});
  }, []);

  // Switching level re-pulls the whole slate: the games list, the tables, and
  // (for a non-Statcast level) a different backend pipeline entirely. Clear the
  // selected game first — a game_pk from AAA is meaningless at AA.
  const levelDidMount = React.useRef(false);
  useEffect(() => {
    if (!levelDidMount.current) { levelDidMount.current = true; return; }
    if (!date) return;
    let cancelled = false;
    setLoading(true);
    setSelectedGame(null);
    setCardData(null);
    Promise.all([
      fetchGames(date, level),
      fetchPitchData(date, null, level),
      fetchPitcherResults(date, null, level),
    ])
      .then(([g, pd, pr]) => {
        if (cancelled) return;
        setGames(g);
        setPitchData(pd);
        setResultsData(pr);
        // Pitch Data has nothing to show below AAA — fall back to results.
        if (!(level === "AAA" || level === "AFL")) setView("pitcher-results");
        setLoading(false);
      })
      .catch(() => { if (!cancelled) { setError("Failed to load level data"); setLoading(false); } });
    return () => { cancelled = true; };
  }, [level]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the refresh label tied to the selected slate's pitcher stat lines.
  useEffect(() => {
    if (!date) return;
    fetchLastRefresh(date)
      .then(data => { setLastRefresh(data.timestamp || null); })
      .catch(() => {});
  }, [date]);

  // Auto-dismiss toast after 3 seconds
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // Poll only today's games list so scores/statuses stay fresh without
  // reloading the heavier pitch-data tables every minute.
  useEffect(() => {
    if (!date || page !== "games" || date !== getBaseballDateEST()) return;
    let cancelled = false;
    let timer = null;

    const pollGames = async () => {
      if (document.hidden) {
        timer = setTimeout(pollGames, 60000);
        return;
      }
      try {
        const nextGames = await fetchGames(date, level);
        if (!cancelled) {
          setGames(nextGames);
        }
      } catch {
        // Keep the current list and try again on the next interval.
      }
      if (!cancelled) {
        timer = setTimeout(pollGames, 60000);
      }
    };

    timer = setTimeout(pollGames, 60000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [date, page]);

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      const gpk = cardData?.result?.game_pk || selectedGame;
      const data = await fetchRefresh(date, gpk);
      setLastRefresh(data.statLinesUpdatedAt || data.timestamp);
      setToast({ message: "Data refreshed", type: "success" });
      // Re-fetch current page data including linescore
      if (date) {
        const newGamesPromise = fetchGames(date, level);
        const selectedGamePromise = gpk != null ? fetchGameView(date, gpk, level) : null;
        const dailyPromise = gpk == null
          ? Promise.all([fetchPitchData(date, null, level), fetchPitcherResults(date, null, level)])
          : null;
        const linescorePromise = gpk ? fetchGameLinescore(gpk) : null;
        const [newGames, selectedGameData, dailyData, newLinescore] = await Promise.all([
          newGamesPromise,
          selectedGamePromise,
          dailyPromise,
          linescorePromise,
        ]);
        setGames(newGames);
        if (gpk != null) {
          applyGameViewData(selectedGameData);
        } else {
          setPitchData(dailyData?.[0] || []);
          setResultsData(dailyData?.[1] || []);
        }
        if (newLinescore) setLinescoreData(newLinescore);
      }
    } catch (e) {
      setToast({ message: "Refresh failed", type: "error" });
    } finally {
      setRefreshing(false);
    }
  };

  const formatRefreshTime = (isoStr) => {
    if (!isoStr) return "";
    try {
      const d = new Date(isoStr);
      return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
    } catch { return ""; }
  };

  const hashHandled = React.useRef(false);
  useEffect(() => {
    if (hashHandled.current) return;
    const parts = getHashParts(window.location.hash);
    if (parts.length === 0) { hashHandled.current = true; return; }
    hashHandled.current = true;
    // Home entry pushed behind the deep-linked route. homePath(), not the raw
    // pathname: a /rehab#player/123 link must leave Back pointing at the games
    // page, not at the Rehab view.
    const baseHash = homePath();
    const route = parseBaseballHash(window.location.hash);
    if (route.type === "player") {
      const pid = route.pitcherId;
      setPage("player"); setPlayerPageId(pid); setLoading(false);
      window.history.replaceState({ view: "list", page: "games", selectedGame: null }, "", baseHash);
      window.history.pushState({ view: "list", page: "player", pitcherId: pid }, "", `#${buildPlayerHash(pid)}`);
    } else if (route.type === "team") {
      const team = route.team;
      setPage("team"); setSelectedTeamPage(team); setLoading(false);
      window.history.replaceState({ view: "list", page: "games", selectedGame: null }, "", baseHash);
      window.history.pushState({ view: "list", page: "team", team }, "", `#${buildTeamHash(team)}`);
    } else if (route.type === "card") {
      const gameDate = route.date, pitcherId = route.pitcherId, gamePk = route.gamePk;
      skipDateFetchForCard.current = true; skipNextDataFetch.current = true;
      setPage("games"); setSelectedGame(gamePk); setDate(gameDate); setPendingCard({ gamePk, pitcherId, date: gameDate }); setLoading(true); setError(null);
      window.history.replaceState({ view: "list", page: "games", selectedGame: null, date: gameDate }, "", baseHash);
      window.history.pushState({ view: "card", selectedGame: gamePk, pitcherId, gamePk, date: gameDate }, "", `#${buildCardHash({ date: gameDate, pitcherId, gamePk })}`);
      Promise.all([
        fetchPitcherCard(gameDate, pitcherId, gamePk),
        fetchGames(gameDate, level),
        fetchGameLinescore(gamePk),
      ])
        .then(([cd, g, ls]) => {
          setGames(g); setLinescoreData(ls); setSelectedGame(gamePk);
          setCardData(cd); setPendingCard(null); setLoading(false);
        })
        .catch(e => { setPendingCard(null); setError(e.message); setLoading(false); });
    }
  }, []); // eslint-disable-line

  // Track whether we're currently handling a popstate event to avoid pushing duplicate history
  const isPopState = React.useRef(false);
  // Pending scroll restoration — stored in ref so a post-render effect can pick it up
  const pendingScrollY = React.useRef(null);

  const resetToDefault = useCallback(() => {
    setPendingCard(null);
    setCardData(null);
    setSelectedGame(null);
    setView("pitcher-results");
    setSpOnly(true);
    setSplitByTeam(false);
    setPage("games");
    setPlayerPageId(null);
    setSelectedTeamPage(null);
    window.history.pushState({ view: "list", page: "games", selectedGame: null }, "", homePath());
    // Deep-linking to #player/#team skips the mount initial-load entirely, so
    // `date` is still null here — without this fetch the home page rendered
    // the empty "No games found" state with nothing in flight.
    if (!date) {
      setLoading(true); setError(null);
      fetchInitialLoad(level)
        .then(data => {
          initialLoadDone.current = true;
          skipNextDataFetch.current = true;
          setDate(data.date);
          setGames(data.games);
          setPitchData(data.pitchData);
          setResultsData(data.resultsData);
          setLastRefresh(data.statLinesUpdatedAt || null);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
          fetchDefaultDate()
            .then(d => setDate(d))
            .catch(() => setDate(getYesterdayEST()));
        });
    }
  }, [date]);

  // Browser back/forward navigation support
  useEffect(() => {
    // Set initial state only if not deep-linking via hash. The page is stamped
    // so Back out of a card lands on whichever view the tab was opened at.
    if (!window.location.hash) {
      window.history.replaceState(
        { view: "list", page: startsOnRehab.current ? "rehab" : "games", selectedGame: null }, "");
    }
  }, []);

  const pushState = useCallback((state, title = "") => {
    const current = window.history.state;
    if (current && current.scrollY == null) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    let hash = "";
    if (state.view === "card" && state.date && state.pitcherId && state.gamePk) {
      hash = `#${buildCardHash({ date: state.date, pitcherId: state.pitcherId, gamePk: state.gamePk })}`;
    } else if (state.page === "player" && state.pitcherId) {
      hash = `#${buildPlayerHash(state.pitcherId)}`;
    } else if (state.page === "team" && state.team) {
      hash = `#${buildTeamHash(state.team)}`;
    }
    // A hash route always hangs off the home path — otherwise navigating from
    // /rehab to a player would produce /rehab#player/123, which reloads as the
    // Rehab view's URL. Rehab itself is the one state with a path of its own.
    const path = state.page === "rehab" ? REHAB_PATH : homePath();
    window.history.pushState(state, title, hash ? `${homePath()}${hash}` : path);
  }, []);

  useEffect(() => {
    const handlePopState = (e) => {
      const state = e.state;
      isPopState.current = true;
      if (!state || state.view === "list") {
        setPendingCard(null);
        setCardData(null);
        setSelectedGame(state?.selectedGame || null);
        if (state?.page === "team") { setPage("team"); setSelectedTeamPage(state.team); }
        else if (state?.page === "player") { setPage("player"); setPlayerPageId(state.pitcherId); }
        else if (state?.page === "rehab") { setPage("rehab"); }
        else { setPage("games"); }
      } else if (state.view === "game") {
        setPendingCard(null);
        setCardData(null);
        setSelectedGame(state.selectedGame);
        setPage("games");
      } else if (state.view === "card" && state.pitcherId && state.gamePk) {
        const cardDate = state.date || date;
        setPage("games");
        setSelectedGame(state.selectedGame);
        setPendingCard({ gamePk: state.gamePk, pitcherId: state.pitcherId, date: cardDate });
        setLoading(true);
        Promise.all([
          fetchPitcherCard(cardDate, state.pitcherId, state.gamePk),
          fetchGameLinescore(state.gamePk),
        ])
          .then(([cd, ls]) => { setLinescoreData(ls); setCardData(cd); setPendingCard(null); setLoading(false); })
          .catch(err => { setPendingCard(null); setError(err.message); setLoading(false); });
      }
      // Store scroll target — a post-render effect will restore it once React finishes
      if (state?.scrollY != null) {
        pendingScrollY.current = state.scrollY;
      }
      setTimeout(() => { isPopState.current = false; }, 0);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [date]);

  // Restore scroll position AFTER React re-renders the list view
  useEffect(() => {
    if (pendingScrollY.current == null || cardData) return; // wait until card is gone
    const targetY = pendingScrollY.current;
    pendingScrollY.current = null;
    let attempts = 0;
    const tryScroll = () => {
      window.scrollTo(0, targetY);
      attempts++;
      if (Math.abs(window.scrollY - targetY) > 5 && attempts < 60) {
        requestAnimationFrame(tryScroll);
      }
    };
    requestAnimationFrame(tryScroll);
  }, [cardData, page, selectedGame]);

  useEffect(() => {
    if (!date) return;  // Wait for smart default date to resolve
    // Skip if initial load already populated games/data
    if (initialLoadDone.current) {
      initialLoadDone.current = false;
      return;
    }
    // Skip if navigateToGameCard already fetched everything
    if (skipDateFetchForCard.current) {
      skipDateFetchForCard.current = false;
      return;
    }
    setGames([]); setSelectedGame(null); setCardData(null);
    setPitchData([]); setResultsData([]);
    setLoading(true); setError(null);
    fetchGames(date, level)
      .then(g => {
        setGames(g);
        // Keep the spinner on when the day has games — the table-data effect
        // (fired by the games 0->N transition) owns `loading` until the rows
        // arrive. Releasing it here would briefly render the empty table state
        // ("No pitcher results available.") while results are still loading.
        // With no games there is no follow-up fetch, so release it now.
        if (g.length === 0) setLoading(false);
      })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [date, retryNonce]);

  useEffect(() => {
    if (games.length === 0) return;
    if (skipNextDataFetch.current) {
      skipNextDataFetch.current = false;
      return;
    }
    // Don't nuke an open card or fetch table data while viewing a card
    if (cardData) return;
    // Spinner: always for a selected-game load; for the all-games slate only
    // when there are no rows to show (returning home from a deep-linked card
    // previously rendered the empty-table state while this fetch ran).
    if (selectedGame != null || (pitchData.length === 0 && resultsData.length === 0)) setLoading(true);
    setError(null);
    const request = selectedGame != null
      ? loadSelectedGameView(selectedGame)
      : Promise.all([
          fetchPitchData(date, null, level),
          fetchPitcherResults(date, null, level),
        ]).then(([pd, pr]) => {
          setPitchData(pd);
          setResultsData(pr);
        });
    // The refresh label is fetched ONLY by the dedicated [date] effect above —
    // fetching it here too made /api/last-refresh fire twice per date change.
    request
      // Always release the spinner once the table data arrives. The date-change
      // effect above leaves `loading` true while the day's games exist, so the
      // All-Games branch (selectedGame == null) must clear it here too — not
      // only the selected-game branch.
      .then(() => { setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
    // `date` is intentionally NOT a dep. The date-change effect above resets games
    // to [] and refetches, so the games.length 0->N transition is what drives this
    // fetch. Re-adding `date` makes it fire once against the STALE previous-date
    // games list before games reload — that's the duplicate-fetch bug (Bug 2).
  }, [selectedGame, games.length, cardData]); // eslint-disable-line

  useEffect(() => {
    if (page !== "games" || cardData || selectedGame == null || !selectedGameIsLive) return;
    let cancelled = false;
    let timer = null;

    const pollSelectedGame = async () => {
      if (document.hidden) {
        timer = setTimeout(pollSelectedGame, 60000);
        return;
      }
      try {
        const data = await fetchGameView(date, selectedGame, level);
        if (!cancelled) applyGameViewData(data);
      } catch {
        // Keep the current game table data and try again on the next interval.
      }
      if (!cancelled) {
        timer = setTimeout(pollSelectedGame, 60000);
      }
    };

    timer = setTimeout(pollSelectedGame, 60000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [applyGameViewData, cardData, date, page, selectedGame, selectedGameIsLive]);

  const linescoreGamePk = cardData?.result?.game_pk || selectedGame;
  const { linescoreData, setLinescoreData } = usePolledLinescore(linescoreGamePk, cardData?.linescore || null);

  // Poll the open card view every 60s while its game is still live. The
  // backend cron rebuilds the cached card every minute during game hours;
  // without this poll the user would have to manually refresh to see the
  // updated pitch count, results, etc.
  useEffect(() => {
    if (!cardData || !date) return;
    const cardGamePk = cardData?.result?.game_pk;
    const cardPitcherId = cardData?.result?.pitcher_id || cardData?.pitcher_id;
    if (!cardGamePk || !cardPitcherId) return;
    // Only poll for live games. is_final defaults to true if unknown.
    if (!linescoreData || linescoreData.is_final !== false) return;

    let cancelled = false;
    let timer = null;
    const pollCard = async () => {
      if (document.hidden) {
        timer = setTimeout(pollCard, 60000);
        return;
      }
      try {
        const fresh = await fetchPitcherCard(date, cardPitcherId, cardGamePk);
        if (!cancelled && fresh) setCardData(fresh);
      } catch {
        // Swallow — keep the old card, retry next tick.
      }
      if (!cancelled) timer = setTimeout(pollCard, 60000);
    };
    timer = setTimeout(pollCard, 60000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [cardData, date, linescoreData]);

  // Does a given LEVEL CODE have game cards? Distinct from isStatcastLevel
  // below, which answers it for the page's currently selected level. The Rehab
  // view ignores the level filter by design, so its rows span every level and
  // each one has to be asked separately.
  const isCardLevel = useCallback((code) => {
    if (!levelMeta) return code === "AAA" || code === "AFL";
    const entry = levelMeta.levels.find(l => l.code === code);
    return entry ? !!entry.statcast : false;
  }, [levelMeta]);

  const isStatcastLevel = useMemo(() => isCardLevel(level), [isCardLevel, level]);

  const filteredPitchData = useMemo(() => {
    let rows = pitchData;
    if (orgFilter) rows = rows.filter(r => r.org === orgFilter);
    if (pitchFilter) rows = rows.filter(r => r.pitch_name === pitchFilter);
    return rows;
  }, [pitchData, pitchFilter, orgFilter]);

  const filteredResultsData = useMemo(() => {
    let rows = resultsData;
    if (orgFilter) rows = rows.filter(r => r.org === orgFilter);
    if (rpOnly) rows = rows.filter(r => r.role === "RP");
    return rows;
  }, [resultsData, rpOnly, orgFilter]);

  const openCard = (pitcherId, gamePk, e) => {
    // Ctrl+Click / Cmd+Click / Middle-click → open in new tab, don't navigate current page
    if (isNewWindowClick(e) && date) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openHashInNewWindow(buildCardHash({ date, pitcherId, gamePk }));
      return;
    }
    // Save scroll position NOW — before setLoading(true) unmounts the table and resets scrollY to 0
    const current = window.history.state;
    if (current) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    // Forward navigation: reset scroll so the loading view (and the new card)
    // appear at the top. Back/forward restoration uses the saved scrollY above
    // via pendingScrollY, so this doesn't interfere with it.
    window.scrollTo(0, 0);
    setLoading(true); setError(null);
    setPendingCard({ gamePk, pitcherId, date });
    Promise.all([
      fetchPitcherCard(date, pitcherId, gamePk),
      fetchGameLinescore(gamePk),
    ])
      .then(([cd, ls]) => {
        setLinescoreData(ls);
        setCardData(cd); setPendingCard(null); setLoading(false);
        if (!isPopState.current) {
          pushState({ view: "card", selectedGame, pitcherId, gamePk, date }, "");
        }
        scrollToTopAfterRender();
      })
      .catch(e => { setPendingCard(null); setError(e.message); setLoading(false); });
  };

  const handleCreateTabs = () => {
    if (!date || !currentTableRows.length) return;
    const seen = new Set();
    const hashes = [];
    currentTableRows.forEach(row => {
      const pitcherId = row.pitcher_id;
      const gamePk = row.game_pk;
      if (!pitcherId || !gamePk) return;
      const key = `${pitcherId}:${gamePk}`;
      if (seen.has(key)) return;
      seen.add(key);
      hashes.push(buildCardHash({ date, pitcherId, gamePk }));
    });
    if (hashes.length) openHashesInNewTabs(hashes);
  };

  const flashTabsHint = (show) => {
    if (tabsHintTimer.current) clearTimeout(tabsHintTimer.current);
    setTabsHint(show);
    if (show) tabsHintTimer.current = setTimeout(() => setTabsHint(false), 15000);
  };

  const closeCard = () => {
    window.history.back();
  };

  const navigateToTeam = (teamAbbrev) => {
    setPage("team");
    setSelectedTeamPage(teamAbbrev);
    setPendingCard(null);
    setCardData(null);
    pushState({ view: "list", page: "team", team: teamAbbrev }, "");
  };

  const navigateToPlayer = async (pitcherId, playerName, e) => {
    // Ctrl+Click / Cmd+Click / Middle-click → open in new tab, don't navigate current page
    if (isNewWindowClick(e) && pitcherId) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openHashInNewWindow(buildPlayerHash(pitcherId));
      return;
    }
    // Save scroll position for back-restoration, then reset so the player
    // page's loading view appears at the top instead of mid-scroll.
    const curState = window.history.state;
    if (curState) {
      window.history.replaceState({ ...curState, scrollY: window.scrollY }, "");
    }
    window.scrollTo(0, 0);
    // If we have a pitcher ID, navigate directly
    if (pitcherId) {
      setPage("player");
      setPlayerPageId(pitcherId);
      setPendingCard(null);
      setCardData(null);
      pushState({ view: "list", page: "player", pitcherId }, "");
      return;
    }
    // Otherwise resolve from name via backend
    if (playerName) {
      try {
        const data = await resolvePitcher(playerName);
        if (data.pitcher_id) {
          // If Ctrl+Click was held, open resolved player in new tab
          if (isNewWindowClick(e)) {
            if (e && e.preventDefault) e.preventDefault();
            if (e && e.stopPropagation) e.stopPropagation();
            openHashInNewWindow(buildPlayerHash(data.pitcher_id));
            return;
          }
          setPage("player");
          setPlayerPageId(data.pitcher_id);
          setPendingCard(null);
          setCardData(null);
          pushState({ view: "list", page: "player", pitcherId: data.pitcher_id }, "");
        }
      } catch (err) {
        console.error("Failed to resolve pitcher:", err);
      }
    }
  };

  const navigateToGameCard = (gameDate, pitcherId, gamePk, e) => {
    // Ctrl+Click / Cmd+Click / Middle-click → open in new tab, don't navigate current page
    if (isNewWindowClick(e)) {
      if (e && e.preventDefault) e.preventDefault();
      if (e && e.stopPropagation) e.stopPropagation();
      openHashInNewWindow(buildCardHash({ date: gameDate, pitcherId, gamePk }));
      return;
    }
    // Save scroll position NOW — before setLoading(true) unmounts the content
    const current = window.history.state;
    if (current) {
      window.history.replaceState({ ...current, scrollY: window.scrollY }, "");
    }
    window.scrollTo(0, 0);
    // Navigate from player page game log to the pitcher card for that game
    // Signal the date-change useEffect to skip resetting everything
    skipDateFetchForCard.current = true;
    // Skip the data fetch triggered by selectedGame change (prevents race condition
    // where stale date + new gamePk returns empty data before card loads)
    skipNextDataFetch.current = true;
    setPage("games");
    setSelectedGame(gamePk);
    setPendingCard({ gamePk, pitcherId, date: gameDate });
    setLoading(true);
    // Fetch card and games for that date in parallel
    Promise.all([
      fetchPitcherCard(gameDate, pitcherId, gamePk),
      fetchGames(gameDate, level),
      fetchGameLinescore(gamePk),
    ]).then(([cd, g, ls]) => {
      setDate(gameDate);
      setGames(g);
      setLinescoreData(ls);
      setSelectedGame(gamePk);
      setCardData(cd);
      setPendingCard(null);
      setLoading(false);
      pushState({ view: "card", selectedGame: gamePk, pitcherId, gamePk, date: gameDate }, "");
      scrollToTopAfterRender();
    }).catch(e => { setPendingCard(null); setError(e.message); setLoading(false); skipDateFetchForCard.current = false; });
  };

  const navigateToRehab = (e) => {
    // Ctrl/Cmd/middle-click: let the real anchor open /rehab in a new tab.
    if (isNewWindowClick(e)) return;
    if (e && e.preventDefault) e.preventDefault();
    const curState = window.history.state;
    if (curState) {
      window.history.replaceState({ ...curState, scrollY: window.scrollY }, "");
    }
    window.scrollTo(0, 0);
    setPendingCard(null);
    setCardData(null);
    setSelectedGame(null);
    setPlayerPageId(null);
    setSelectedTeamPage(null);
    setPage("rehab");
    pushState({ view: "list", page: "rehab", selectedGame: null }, "");
  };

  const navigateBackToGames = () => {
    setPage("games");
    setPendingCard(null);
    setCardData(null);
    pushState({ view: "list", page: "games", selectedGame: null }, "");
  };

  // Header nav component (reused in both header renders)
  const headerNav = (
    <div className="header-nav">
      <button
        className={`refresh-btn${refreshing ? " refreshing" : ""}`}
        onClick={handleRefresh}
        disabled={refreshing}
        title="Refresh data"
      >
        <span className={`refresh-icon${refreshing ? " spinning" : ""}`}>&#x21bb;</span>
        {lastRefresh ? <span className="refresh-ts">Updated {formatRefreshTime(lastRefresh)}</span> : null}
      </button>
      <select
        className="team-select"
        value={page === "team" ? selectedTeamPage || "" : ""}
        onChange={(e) => { if (e.target.value) navigateToTeam(e.target.value); }}
      >
        {/* Team pages route per MLB ORG, so this lists the 30 orgs the backend
            actually has affiliates for — not TEAMS_LIST, which still carries
            WBC and legacy-MLB entries with no minor-league system. */}
        <option value="">Teams</option>
        {(levelMeta?.orgs || []).map(org => (
          <option key={org} value={org}>{TEAM_FULL_NAMES[org] || org}</option>
        ))}
      </select>
      <div className="header-nav-spacer" />
      {/* Cross-level view: MLB arms on an IL rehabbing anywhere in the system.
          A real anchor, so it can be middle-clicked, copied and shared. */}
      <a
        className={`nav-link-btn${page === "rehab" ? " active" : ""}`}
        href={REHAB_PATH}
        rel="nofollow"
        onClick={navigateToRehab}
        title="MLB pitchers on the IL who have made a minor-league start in the last two weeks"
      >
        Rehab
      </a>
      <SearchBar onSelectPlayer={(id, name, e) => navigateToPlayer(id, name, e)} />
    </div>
  );

  return (
    // One switch for the big-league-experience highlight, applied at the root
    // so every table below it follows without threading a prop through each.
    <div className={mlbGreen ? "app mlb-exp-on" : "app"}>
      {/* === HEADER (always shown when no card view) === */}
      {!cardData && (
        <div className="header">
          <h1 className="app-title"><a href={homePath()} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey && e.button !== 1) { e.preventDefault(); resetToDefault(); } }} style={{ color: "inherit", textDecoration: "none" }}>MiLB Pitch Dashboard</a></h1>
          {/* Rehab answers a fixed two-week window, so a date picker there would
              be a control that does nothing. */}
          {page !== "rehab" && <DatePicker date={date} onChange={setDate} />}
          {headerNav}
        </div>
      )}

      {/* === TOAST NOTIFICATION === */}
      {toast && (
        <div className={`toast-notification toast-${toast.type}`}>
          {toast.message}
        </div>
      )}

      {/* === TEAM PAGE === */}
      {page === "team" && selectedTeamPage && !cardData && (
        <Suspense fallback={<div className="loading"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}>
          <TeamPage key={selectedTeamPage} teamAbbrev={selectedTeamPage} onPlayerClick={(id, name, e) => navigateToPlayer(id, name, e)} onBack={navigateBackToGames} />
        </Suspense>
      )}

      {/* === PLAYER PAGE === */}
      {page === "player" && playerPageId && !cardData && (
        <Suspense fallback={<div className="loading"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}>
          <PlayerPage key={playerPageId} pitcherId={playerPageId} onBack={navigateBackToGames} onGameClick={navigateToGameCard} />
        </Suspense>
      )}

      {/* === REHAB PAGE (/rehab) === */}
      {page === "rehab" && !cardData && (
        <div className="main-table-area">
          <div className="controls-row">
            <div className="rehab-title">
              Rehab Starts
              {rehabData?.start_date ? <span className="rehab-subtitle">since {rehabData.start_date}</span> : null}
            </div>
            <div className="toggle-group">
              <label className="toggle-label" title="Show pitchers with major-league experience in green">
                <input type="checkbox" checked={mlbGreen} onChange={e => setMlbGreen(e.target.checked)} />
                <span>MLB Green</span>
              </label>
              <div className="col-filter-inline">
                <button className="col-filter-toggle" onClick={() => setShowRehabColFilter(v => !v)}>
                  Columns {showRehabColFilter ? "▲" : "▼"}
                </button>
                {showRehabColFilter && (
                  <div className="col-filter-dropdown">
                    {REHAB_COLUMNS.filter(c => c.key !== "date" && c.key !== "pitcher").map(c => (
                      <label key={c.key} className="col-filter-label" title={c.title || undefined}>
                        <input
                          type="checkbox"
                          checked={!rehabHiddenCols.includes(c.key)}
                          onChange={() => setRehabHiddenCols(prev => prev.includes(c.key)
                            ? prev.filter(k => k !== c.key)
                            : [...prev, c.key])}
                        />
                        {c.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="table-card">
            <div className="table-container">
              {rehabLoading
                ? <div className="loading-msg"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div>Finding rehab starts across all levels...</div>
                : rehabError
                ? <div className="rehab-empty">
                    {rehabError}{" "}
                    <button
                      type="button"
                      className="col-filter-toggle"
                      onClick={() => { setRehabError(null); setRehabData(null); }}
                    >
                      Retry
                    </button>
                  </div>
                : <RehabStartsTable
                    data={rehabData}
                    onPitcherClick={(id, e) => navigateToPlayer(id, null, e)}
                    onGameClick={navigateToGameCard}
                    isCardLevel={isCardLevel}
                    hiddenCols={rehabHiddenCols}
                    sortKey={rehabSortKey}
                    onSortKeyChange={setRehabSortKey}
                    sortDir={rehabSortDir}
                    onSortDirChange={setRehabSortDir}
                  />}
            </div>
          </div>
        </div>
      )}

      {/* === GAMES PAGE (original daily view) === */}
      {page === "games" && !cardData && !loading && (
        <>
          <GameTabs games={games} selectedGame={selectedGame} onSelectGame={gp => {
            if (gp !== selectedGame && !isPopState.current) {
              pushState({ view: "game", selectedGame: gp }, "");
            }
            setSelectedGame(gp); setCardData(null);
          }} />

          {games.length > 0 && selectedGame && linescoreData && (
            <Scoreboard data={linescoreData} onInningClick={(inn, isTop) => setPbpModal({ inning: inn, isTop })} />
          )}

          {games.length > 0 && (
            <>
              <div className="controls-row">
                <button className={`view-btn${view === "pitcher-results" ? " active" : ""}`} onClick={() => setView("pitcher-results")}>
                  Pitcher Results
                </button>
                {/* No pitch tracking below AAA, so there's no Pitch Data view
                    to offer at those levels. */}
                {isStatcastLevel && (
                  <button className={`view-btn${view === "pitch-data" ? " active" : ""}`} onClick={() => setView("pitch-data")}>
                    Pitch Data
                  </button>
                )}
                <div className="toggle-group">
                  <label className="level-select-label">
                    <span>Level</span>
                    <select
                      className="level-select"
                      value={level}
                      onChange={e => setLevel(e.target.value)}
                    >
                      {(levelMeta?.levels || [
                        { code: "AAA", label: "Triple-A" },
                        { code: "AA", label: "Double-A" },
                        { code: "A+", label: "High-A" },
                        { code: "A", label: "Single-A" },
                        { code: "R", label: "Rookie" },
                        { code: "AFL", label: "Arizona Fall League" },
                      ]).map(l => (
                        <option key={l.code} value={l.code}>{l.code}</option>
                      ))}
                    </select>
                  </label>
                  <label className="level-select-label">
                    <span>Org</span>
                    <select
                      className="level-select"
                      value={orgFilter}
                      onChange={e => setOrgFilter(e.target.value)}
                    >
                      <option value="">All</option>
                      {(levelMeta?.orgs || []).map(o => (
                        <option key={o} value={o}>{o}</option>
                      ))}
                    </select>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={spOnly} onChange={e => { setSpOnly(e.target.checked); if (e.target.checked) setRpOnly(false); }} />
                    <span>SP Only</span>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={rpOnly} onChange={e => { setRpOnly(e.target.checked); if (e.target.checked) setSpOnly(false); }} />
                    <span>RP Only</span>
                  </label>
                  <label className="toggle-label">
                    <input type="checkbox" checked={splitByTeam} onChange={e => setSplitByTeam(e.target.checked)} />
                    <span>By Team</span>
                  </label>
                  <label className="toggle-label" title="Show pitchers with major-league experience in green">
                    <input type="checkbox" checked={mlbGreen} onChange={e => setMlbGreen(e.target.checked)} />
                    <span>MLB Green</span>
                  </label>
                  {view === "pitcher-results" && (
                    <div className="col-filter-inline">
                      <button className="col-filter-toggle" onClick={() => setShowColFilter(v => !v)}>
                        Columns {showColFilter ? "\u25B2" : "\u25BC"}
                      </button>
                      {showColFilter && (
                        <div className="col-filter-dropdown">
                          {/* The adapted table carries five metric families, so its
                              options are grouped and most start hidden. */}
                          {isStatcastLevel
                            ? PITCHER_RESULTS_COLUMNS.filter(c => c.key !== "pitcher").map(c => (
                                <label key={c.key} className="col-filter-label">
                                  <input type="checkbox" checked={!resultsHiddenCols.includes(c.key)} onChange={() => setResultsHiddenCols(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key])} />
                                  {c.label}
                                </label>
                              ))
                            : ADAPTED_COLUMN_GROUPS.map(([group, cols]) => (
                                <React.Fragment key={group}>
                                  <div className="col-filter-group">{group}</div>
                                  {cols.map(c => (
                                    <label key={c.key} className="col-filter-label" title={c.title || undefined}>
                                      <input type="checkbox" checked={!adaptedHiddenCols.includes(c.key)} onChange={() => setAdaptedHiddenCols(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key])} />
                                      {c.label}
                                    </label>
                                  ))}
                                </React.Fragment>
                              ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {view === "pitch-data" && (
                <div className="pitch-type-filters">
                  {PITCH_TYPE_FILTERS.map(pt => (
                    <button key={pt}
                      className={`pitch-type-btn${pitchFilter === pt ? " active" : ""}`}
                      style={pitchFilter === pt
                        ? { background: PITCH_COLORS[pt] || "#555", color: "#1A1C30" }
                        : { background: "transparent", color: PITCH_COLORS[pt] || "#555", borderColor: PITCH_COLORS[pt] || "#555" }
                      }
                      onClick={() => setPitchFilter(pitchFilter === pt ? null : pt)}>
                      {pt}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* The Rehab page has its own loader and its own failure text — a slate
          fetch still in flight (or already failed) behind it must not paint a
          spinner or an error banner over it. */}
      {loading && page !== "rehab" && <div className="loading"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}
      {error && page !== "rehab" && (
        <div className="error" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <div>{error}</div>
          <button
            type="button"
            onClick={() => { setError(null); setRetryNonce(n => n + 1); }}
            style={{
              background: "rgba(85, 232, 255, 0.12)",
              border: "1px solid rgba(85, 232, 255, 0.4)",
              color: "#55e8ff",
              padding: "6px 16px",
              borderRadius: 4,
              cursor: "pointer",
              fontFamily: "inherit",
              fontSize: 13,
            }}
          >
            Retry
          </button>
        </div>
      )}

      {!loading && !error && !cardData && page === "games" && (
        <div className="main-table-area">
          <div className={splitByTeam ? "table-card-none" : "table-card"}>
            <div className="table-container">
              {view === "pitch-data" && isStatcastLevel && (
                <PitchDataTable data={filteredPitchData} date={date} onPitcherClick={openCard} splitByTeam={splitByTeam} spOnly={spOnly} isMobile={isMobile} sortKey={pitchSortKey} onSortKeyChange={setPitchSortKey} sortDir={pitchSortDir} onSortDirChange={setPitchSortDir} onSortedRowsChange={setCurrentTableRows} />
              )}
              {view === "pitcher-results" && isStatcastLevel && (
                <PitcherResultsTable data={filteredResultsData} date={date} onPitcherClick={openCard} spOnly={spOnly} splitByTeam={splitByTeam} isMobile={isMobile} sortKey={resultsSortKey} onSortKeyChange={setResultsSortKey} sortDir={resultsSortDir} onSortDirChange={setResultsSortDir} hiddenCols={resultsHiddenCols} onSortedRowsChange={setCurrentTableRows} />
              )}
              {/* Below AAA the box score is all there is — adapted columns only. */}
              {!isStatcastLevel && (
                <AdaptedResultsTable data={filteredResultsData} level={level} hiddenCols={adaptedHiddenCols} onPitcherClick={(id, e) => navigateToPlayer(id, null, e)} spOnly={spOnly} rpOnly={rpOnly} sortKey={resultsSortKey} onSortKeyChange={setResultsSortKey} sortDir={resultsSortDir} onSortDirChange={setResultsSortDir} onSortedRowsChange={setCurrentTableRows} />
              )}
            </div>
          </div>
          <div className="table-actions">
            {tabsHint && (
              <span className="create-tabs-hint">
                Tabs created — a plain click follows them. Middle-click or Ctrl+click to stay on this page.
              </span>
            )}
            <button
              type="button"
              className="export-btn"
              title="Download the daily performance table for a date range as one CSV"
              onClick={() => setShowExport(true)}
            >
              Export Game Logs
            </button>
            <a
              className={`create-tabs-btn${!currentTableRows.length ? " create-tabs-btn--disabled" : ""}`}
              href={homePath()}
              rel="nofollow"
              role="button"
              aria-disabled={!currentTableRows.length}
              title="Middle-click or Ctrl+click opens every card in background tabs (you stay on this page)"
              onClick={(e) => {
                e.preventDefault();
                if (!currentTableRows.length) return;
                handleCreateTabs();
                // Background tabs require the real gesture to carry Ctrl/Cmd or
                // middle-click; on a plain click the browser follows the last
                // tab and script can't stop it, so teach the gesture instead.
                const plain = !e.ctrlKey && !e.metaKey;
                flashTabsHint(plain && !window.electronAPI?.openNewWindow);
              }}
              onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); if (currentTableRows.length) { handleCreateTabs(); flashTabsHint(false); } } }}
              onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }}
            >
              Create Tabs
            </a>
          </div>
          {showExport && (
            <ExportGameLogsModal
              level={level}
              isStatcastLevel={isStatcastLevel}
              currentDate={date}
              spOnly={spOnly}
              rpOnly={rpOnly}
              orgFilter={orgFilter}
              onClose={() => setShowExport(false)}
            />
          )}
        </div>
      )}

      {!loading && !error && cardData && (
        <>
          <div className="header">
            <h1 className="app-title"><a href={homePath()} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey && e.button !== 1) { e.preventDefault(); resetToDefault(); } }} style={{ color: "inherit", textDecoration: "none" }}>MiLB Pitch Dashboard</a></h1>
            <DatePicker date={date} onChange={setDate} />
            {headerNav}
          </div>
          {games.length > 0 && (
            <GameTabs games={games} selectedGame={selectedGame} onSelectGame={gp => {
              if (gp !== selectedGame && !isPopState.current) {
                pushState({ view: "game", selectedGame: gp }, "");
              }
              setSelectedGame(gp); setCardData(null);
            }} />
          )}
          <div className="card-outer">
            <div className="card-top-row">
              <button className="back-btn" onClick={closeCard}>
                {"\u2190"} {(selectedGame || cardData?.result?.game_pk) ? "Back to Game" : "Back to All Games"}
              </button>
              {linescoreData && (
                <Scoreboard data={linescoreData} pitcherId={cardData?.result?.pitcher_id} onInningClick={(inn, isTop) => setPbpModal({ inning: inn, isTop })} />
              )}
            </div>
            <PitcherCard cardData={cardData} date={date} linescoreData={linescoreData} isMobile={isMobile} onPlayerClick={(id, e) => navigateToPlayer(id, null, e)} onNavigateToCard={navigateToGameCard} onGameClick={(e) => {
              const gamePk = cardData?.result?.game_pk || selectedGame;
              const pitcherId = cardData?.result?.pitcher_id;
              if (isNewWindowClick(e) && gamePk && date && pitcherId) {
                if (e && e.preventDefault) e.preventDefault();
                if (e && e.stopPropagation) e.stopPropagation();
                openHashInNewWindow(buildCardHash({ date, pitcherId, gamePk }));
                return;
              }
              if (gamePk) {
                setSelectedGame(gamePk);
                setCardData(null);
                pushState({ view: "game", selectedGame: gamePk }, "");
                // Force data re-fetch even if selectedGame hasn't changed
                setLoading(true); setError(null);
                loadSelectedGameView(gamePk)
                  .then(() => { setLoading(false); })
                  .catch(e => { setError(e.message); setLoading(false); });
              }
            }} onReclassify={(pitch) => setReclassifyPitch(pitch)} />
          </div>
        </>
      )}

      {!loading && !error && games.length === 0 && page === "games" && (
        <div className="no-data">No games found for this date. Try selecting a different date.</div>
      )}

      {pbpModal && linescoreData && (
        <PlayByPlayModal
          data={linescoreData}
          inning={pbpModal.inning}
          isTop={pbpModal.isTop}
          pitcherId={cardData?.result?.pitcher_id || null}
          onClose={() => setPbpModal(null)}
        />
      )}

      {reclassifyPitch_ && cardData && (
        <ReclassifyModal
          pitch={reclassifyPitch_}
          gamePk={cardData.game_pk || cardData.result?.game_pk || selectedGame}
          pitcherId={cardData.pitcher_id || cardData.result?.pitcher_id}
          date={date}
          onClose={() => setReclassifyPitch(null)}
          onConfirm={(req) => {
            setReclassifyPitch(null);
            setLoading(true);
            reclassifyPitch(req).then((res) => {
              // The reclassify endpoint rebuilds the affected card server-side
              // (on the instance with the fresh override state) and returns it.
              // Use it directly — no refetch, so we never depend on cross-
              // instance cache consistency for the update to show.
              if (res && res.card) {
                setCardData(res.card);
                setLoading(false);
                return;
              }
              // Fallback: endpoint didn't return a card — refetch.
              const pid = cardData.pitcher_id || cardData.result?.pitcher_id;
              const gpk = cardData.game_pk || cardData.result?.game_pk || selectedGame;
              if (pid && gpk) {
                fetchPitcherCard(date, pid, gpk)
                  .then(cd => { setCardData(cd); setLoading(false); })
                  .catch(err => { setError(err.message); setLoading(false); });
              } else {
                setLoading(false);
              }
            }).catch(err => { setError(err.message); setLoading(false); });
          }}
        />
      )}
    </div>
  );
}
