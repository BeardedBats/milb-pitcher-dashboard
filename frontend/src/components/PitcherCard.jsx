import React, { useState, useEffect, useMemo } from "react";
import StrikeZonePlot from "./StrikeZonePlot";
import MovementPlot from "./MovementPlot";
import PitchDataTable from "./PitchDataTable";
import PitchFilterDropdown from "./PitchFilterDropdown";
import ResultsTable from "./ResultsTable";
import UsageTable from "./UsageTable";
import VelocityChart from "./VelocityChart";
import RegularSeasonTable from "./RegularSeasonTable";
import PitchPlayByPlaySection from "./PitchPlayByPlaySection";
import PitcherHeader from "./PitcherHeader";
import BoxScoreSection from "./BoxScoreSection";
import { PITCH_COLORS, CARD_PITCH_DATA_COLUMNS, displayTeamAbbrev } from "../constants";
import { fetchPlayerPage } from "../utils/api";
import { aggregateGameLogTotals } from "../utils/seasonTotals";
import { isBallInPlay, classifyBIPQuality, matchesResultFilter, RESULT_FILTER_OPTIONS, RESULT_QUICK_ACTIONS } from "../utils/pitchFilters";
import { aggregatePitchTable } from "../utils/pitchTableAgg";
import { buildCardHash, buildPlayerHash } from "../utils/navigation";
import usePitchFilters from "../hooks/usePitchFilters";

// The null guard lives in this thin wrapper so PitcherCardInner's ~20 hooks
// always run unconditionally (react-hooks/rules-of-hooks).
export default function PitcherCard(props) {
  if (!props.cardData) return null;
  return <PitcherCardInner {...props} />;
}

function PitcherCardInner({ cardData, date, linescoreData, onGameClick, onNavigateToCard, onReclassify, onPlayerClick, isMobile }) {
  const { name, team, hand, opponent, pitches,
    pitch_table, pitch_table_vs_l, pitch_table_vs_r, result, pitcher_id } = cardData;

  const dateDisplay = date || "";
  const isHome = result && result.home_team === team;
  const oppPrefix = isHome ? "vs." : "@";
  const nameWithOrg = name;
  const playerHref = `#${buildPlayerHash(pitcher_id)}`;
  const cardHref = `#${buildCardHash({ date, pitcherId: pitcher_id, gamePk: result?.game_pk || "" })}`;

  // Compute projected decision for live games
  const gameLive = linescoreData && linescoreData.is_final === false;
  const projectedDecision = useMemo(() => {
    if (!gameLive || !linescoreData?.totals || !result) return null;
    const dec = result.decision;
    if (dec) return null; // already has a real decision
    const homeRuns = linescoreData.totals.home?.runs || 0;
    const awayRuns = linescoreData.totals.away?.runs || 0;
    const teamRuns = isHome ? homeRuns : awayRuns;
    const oppRuns = isHome ? awayRuns : homeRuns;
    if (teamRuns > oppRuns) return "W";
    if (teamRuns < oppRuns) return "L";
    return "ND";
  }, [gameLive, linescoreData, result, isHome]);

  // Strikezone color mode
  const [szColorMode, setSzColorMode] = useState("pitch-type");

  // Metrics view toggle
  const [metricsView, setMetricsView] = useState("pitch-data"); // "pitch-data" | "play-by-play"

  // PBP inline state: which PA is active (shows SZ) and which are expanded (pitch-by-pitch)
  const [pbpActivePa, setPbpActivePa] = useState("0-0"); // "segIdx-paIdx"
  const [pbpExpanded, setPbpExpanded] = useState({});
  const [pbpPitchHover, setPbpPitchHover] = useState(null);

  // Season-average deltas can compare against this season-to-date before the
  // selected game or the player's most recent prior MLB season with data.
  const [currentSeasonAvgs, setCurrentSeasonAvgs] = useState(() => cardData.season_averages?.current || null);
  const [prevSeasonAvgs, setPrevSeasonAvgs] = useState(() => cardData.season_averages?.previous || null);
  const [prevSeason, setPrevSeason] = useState(() => cardData.season_averages?.previous_season || null);
  const [compareTo, setCompareTo] = useState("current");
  const [loadingAvgs, setLoadingAvgs] = useState(false);

  // Cross-component pitch hover highlight (shared between SZ plots and movement plot)
  const [crossHoverPitch, setCrossHoverPitch] = useState(null);

  // Inning filter for plots (PitcherCard-only; null = all selected on init)
  const [inningFilter, setInningFilter] = useState(null);

  // Available pitch types in this game (for filter options + selection logic).
  const availablePitchTypes = useMemo(() => {
    if (!pitches) return [];
    const types = new Set(pitches.map(p => p.pitch_name).filter(Boolean));
    return [...types].sort();
  }, [pitches]);

  // Shared pitch-filter state: batter hand, pitch-type/result/contact filters,
  // and row-click pitch-type selection. selectedPitchTypes filters the totals
  // row in the tables AND the pitches shown in the strikezone / movement plots;
  // "all selected" collapses back to "none" (== no filter). The inning filter
  // stays local above (PitcherCard-specific).
  const {
    pitchTypeFilter, setPitchTypeFilter,
    resultFilter, setResultFilter,
    contactFilter, setContactFilter,
    batterFilter, setBatterFilter,
    selectedPitchTypes,
    effectivePitchTypeFilter, effectiveResultFilter,
    toggleSelectedPitch, clearSelectedPitches,
  } = usePitchFilters(availablePitchTypes);

  const currentYear = date ? parseInt(date.slice(0, 4)) : new Date().getFullYear();

  useEffect(() => {
    setCurrentSeasonAvgs(cardData.season_averages?.current || {});
    setPrevSeasonAvgs(cardData.season_averages?.previous || {});
    setPrevSeason(cardData.season_averages?.previous_season || null);
    setLoadingAvgs(false);
  }, [cardData.season_averages]);

  const hasAvgData = (avgs) => avgs && Object.keys(avgs).length > 0;
  const seasonAvgs = compareTo === "current" ? currentSeasonAvgs : prevSeasonAvgs;

  useEffect(() => {
    if (loadingAvgs) return;
    if (compareTo === "prev" && !hasAvgData(prevSeasonAvgs) && hasAvgData(currentSeasonAvgs)) {
      setCompareTo("current");
    } else if (compareTo === "current" && !hasAvgData(currentSeasonAvgs) && hasAvgData(prevSeasonAvgs)) {
      setCompareTo("prev");
    }
  }, [compareTo, currentSeasonAvgs, loadingAvgs, prevSeasonAvgs]);

  const cachedSeasonTotals = (cardData.season_totals_mlb && cardData.season_totals_mlb.games)
    ? cardData.season_totals_mlb
    : (cardData.season_totals && cardData.season_totals.games)
    ? cardData.season_totals
    : null;

  // Fetch the player-page payload so we can render the Regular Season game
  // log + season totals at the bottom of the card. The endpoint is already
  // cached server-side, so this is cheap after the first request.
  const [playerPageData, setPlayerPageData] = useState(() => cardData.player_page ?? null);
  useEffect(() => {
    // The server populates cardData.player_page when extras are built. Empty
    // game_log is a valid answer (Spring Training / WBC games before the
    // regular season starts) — only re-fetch when the field is truly missing.
    if (cardData.player_page != null) {
      setPlayerPageData(cardData.player_page);
      return;
    }
    if (!pitcher_id) {
      setPlayerPageData(null);
      return;
    }
    let cancelled = false;
    const startDate = date ? `${date.slice(0, 4)}-03-25` : "2026-03-25";
    fetchPlayerPage(pitcher_id, startDate)
      .then(d => { if (!cancelled) setPlayerPageData(d); })
      .catch(() => { if (!cancelled) setPlayerPageData(null); });
    return () => { cancelled = true; };
  }, [cardData.player_page, pitcher_id, date]);

  const enrichedPlayerPageData = useMemo(() => {
    if (!playerPageData || !result?.game_pk || !date) return playerPageData;
    const gameLog = Array.isArray(playerPageData.game_log) ? playerPageData.game_log : [];
    if (gameLog.some(row => Number(row.game_pk) === Number(result.game_pk))) {
      return playerPageData;
    }
    const currentGameRow = {
      game_pk: result.game_pk,
      date,
      team: result.team || "",
      opponent: result.opponent || "",
      home_team: result.home_team || "",
      ip: result.ip || "0.0",
      hits: result.hits || 0,
      bbs: result.bbs || 0,
      ks: result.ks || 0,
      hrs: result.hrs || 0,
      er: result.er || 0,
      runs: result.runs || 0,
      batters_faced: result.batters_faced || 0,
      games_started: result.games_started || 0,
      decision: result.decision || "",
      whiffs: result.whiffs || 0,
      swstr_pct: result.swstr_pct,
      csw_pct: result.csw_pct,
      strike_pct: result.strike_pct,
      pitches: result.pitches || 0,
      strikes: result.strikes || 0,
      pa_count: result.pa_count || result.batters_faced || 0,
      two_strike_pas: result.two_strike_pas || 0,
      two_strike_pitches: result.two_strike_pitches || 0,
      strikeouts_for_par: result.strikeouts_for_par || result.ks || 0,
      two_str_pct: result.two_str_pct,
      par_pct: result.par_pct,
    };
    // Also seed a per-game summary for this game from the card's own pitch
    // tables, so the Regular Season log's pitch-type / vs-L/vs-R view shows the
    // current game's real metrics instead of an all-dashes (count 0) row and
    // dropping it from the totals.
    const prevSummaries = playerPageData.per_game_summaries || {};
    const currentSummary = {
      all: pitch_table || [],
      vs_l: pitch_table_vs_l || [],
      vs_r: pitch_table_vs_r || [],
    };
    // Also append the card's own raw pitches (they carry game_pk) so the
    // game log views computed from data.pitches — Results, Usage, vs-hand
    // splits, innings — include the current game too.
    const currentPitches = (pitches || []).filter(p => p.game_pk != null);
    return {
      ...playerPageData,
      game_log: [...gameLog, currentGameRow],
      per_game_summaries: { ...prevSummaries, [String(result.game_pk)]: currentSummary },
      pitches: [...(playerPageData.pitches || []), ...currentPitches],
    };
  }, [date, playerPageData, result, pitch_table, pitch_table_vs_l, pitch_table_vs_r, pitches]);

  const seasonTotals = useMemo(() => {
    const gameLogTotals = aggregateGameLogTotals(
      enrichedPlayerPageData?.game_log,
      result ? { ...result, date } : null,
    );
    return gameLogTotals || cachedSeasonTotals;
  }, [cachedSeasonTotals, date, enrichedPlayerPageData, result]);

  // Select correct server pitch table based on batter filter (full game)
  const serverPitchTable = useMemo(() => {
    let table;
    if (batterFilter === "L" && pitch_table_vs_l) table = pitch_table_vs_l;
    else if (batterFilter === "R" && pitch_table_vs_r) table = pitch_table_vs_r;
    else table = pitch_table;
    // Sort by count descending
    if (table) return [...table].sort((a, b) => (b.count || 0) - (a.count || 0));
    return [];
  }, [batterFilter, pitch_table, pitch_table_vs_l, pitch_table_vs_r]);

  // Build play-by-play data from linescore. For every half-inning the pitcher
  // appeared in we keep the ENTIRE inning's PAs (not just this pitcher's) so a
  // mid-inning hook still shows how the rest of the frame played out. The
  // featured pitcher's PAs are highlighted; relief changes are marked inline.
  const pitcherPBP = useMemo(() => {
    if (!linescoreData?.plays || !pitcher_id) return null;
    const segments = [];
    for (const half of linescoreData.plays) {
      const allPas = half.pas || [];
      if (!allPas.some(pa => pa.pitcher_id === pitcher_id)) continue;
      segments.push({
        inning: half.inning,
        isTop: half.top,
        label: `${half.top ? "Top" : "Bot"} ${half.inning}`,
        pas: allPas,
        allPas,
      });
    }
    if (segments.length === 0) return null;
    const totalPAs = segments.reduce((sum, s) => sum + s.pas.length, 0);
    return { segments, totalPAs };
  }, [linescoreData, pitcher_id]);

  // Since each inning now shows every PA, default the active (strikezone) PA to
  // the featured pitcher's first plate appearance rather than whoever batted
  // first in the inning.
  useEffect(() => {
    if (!pitcherPBP) return;
    for (let si = 0; si < pitcherPBP.segments.length; si++) {
      const idx = pitcherPBP.segments[si].pas.findIndex(pa => pa.pitcher_id === pitcher_id);
      if (idx >= 0) { setPbpActivePa(`${si}-${idx}`); break; }
    }
  }, [pitcherPBP, pitcher_id]);

  // Available innings the pitcher pitched in (for inning filter options)
  const availableInnings = useMemo(() => {
    if (!pitches) return [];
    const innings = new Set();
    for (const p of pitches) {
      if (p.inning != null) innings.add(String(p.inning));
    }
    return [...innings].sort((a, b) => Number(a) - Number(b));
  }, [pitches]);

  // Lazy-init inning filter to all available innings
  const effectiveInningFilter = useMemo(() => {
    if (inningFilter === null) return new Set(availableInnings);
    return inningFilter;
  }, [inningFilter, availableInnings]);

  // Filter pitches for plots: batter hand + pitch type + row selection + result + contact quality
  const filteredPitches = useMemo(() => {
    if (!pitches) return [];
    let fp = pitches;
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");
    // Apply pitch type filter (dropdown)
    if (pitchTypeFilter !== null) {
      fp = fp.filter(p => effectivePitchTypeFilter.has(p.pitch_name));
    }
    // Apply row-click selection (additional filter, intersected with dropdown)
    if (selectedPitchTypes.size > 0) {
      fp = fp.filter(p => selectedPitchTypes.has(p.pitch_name));
    }
    // Apply inning filter (dropdown)
    if (inningFilter !== null) {
      fp = fp.filter(p => p.inning != null && effectiveInningFilter.has(String(p.inning)));
    }
    // Apply contact quality filter (Hard BIP / Weak BIP) — only balls in play
    if (contactFilter !== "all") {
      fp = fp.filter(p => {
        if (!isBallInPlay(p)) return false;
        const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
        return contactFilter === "hard" ? quality === "Hard" : quality === "Weak";
      });
    }
    // Apply result filter
    if (resultFilter !== null) {
      fp = fp.filter(p => matchesResultFilter(p, effectiveResultFilter));
    }
    return fp;
  }, [pitches, batterFilter, pitchTypeFilter, effectivePitchTypeFilter, selectedPitchTypes, contactFilter, resultFilter, effectiveResultFilter, inningFilter, effectiveInningFilter]);

  // The Result + Inning filters (in the visuals controls) also drive every
  // metrics tab (Pitch Overview, Results, Usage). `metricsPitches` is the raw
  // pitch list narrowed by those two filters only — each table applies its own
  // LHB/RHB split on top. When neither filter narrows anything, this equals the
  // full pitch list, so the tables behave exactly as before.
  const metricsPitches = useMemo(() => {
    if (!pitches) return [];
    let fp = pitches;
    if (inningFilter !== null) fp = fp.filter(p => p.inning != null && effectiveInningFilter.has(String(p.inning)));
    if (resultFilter !== null) fp = fp.filter(p => matchesResultFilter(p, effectiveResultFilter));
    return fp;
  }, [pitches, inningFilter, effectiveInningFilter, resultFilter, effectiveResultFilter]);

  // Pitch Overview is server-aggregated, so when either filter is active we
  // re-aggregate it client-side from metricsPitches (respecting the LHB/RHB
  // split) instead of using the server's full-game table.
  const inningFilterActive = inningFilter !== null && availableInnings.some(i => !effectiveInningFilter.has(i));
  const resultFilterActive = resultFilter !== null && RESULT_FILTER_OPTIONS.some(o => !effectiveResultFilter.has(o));
  const tableFilterActive = inningFilterActive || resultFilterActive;

  const tablePitches = useMemo(() => {
    if (!tableFilterActive) return null;
    let fp = metricsPitches;
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");
    return fp;
  }, [tableFilterActive, metricsPitches, batterFilter]);

  const activePitchTable = useMemo(() => {
    if (tablePitches) return aggregatePitchTable(tablePitches);
    return serverPitchTable;
  }, [tablePitches, serverPitchTable]);

  return (
    <div className="card">
      {/* ===== TOP ROW: Player Info + Box Score ===== */}
      <div className="card-top">
        <PitcherHeader
          nameWithOrg={nameWithOrg}
          playerHref={playerHref}
          pitcherId={pitcher_id}
          onPlayerClick={onPlayerClick}
          team={team}
          hand={hand}
          dateDisplay={dateDisplay}
          oppPrefix={oppPrefix}
          opponent={opponent}
          cardHref={cardHref}
          onGameClick={onGameClick}
        />
        {result && (
          <BoxScoreSection
            result={result}
            nameWithOrg={nameWithOrg}
            projectedDecision={projectedDecision}
            gameLive={gameLive}
            seasonTotals={seasonTotals}
          />
        )}
      </div>

      {/* ===== PITCH TYPE METRICS / PLAY-BY-PLAY ===== */}
      <div className="card-section">
        <div className="metrics-header">
          {isMobile ? (
            <select className="metrics-subnav-mobile" value={metricsView} onChange={e => setMetricsView(e.target.value)}>
              <option value="pitch-data">Pitch Overview</option>
              <option value="results">Results</option>
              <option value="usage">Usage</option>
              <option value="velocity-trend">Velocity Trend</option>
              {pitcherPBP && <option value="play-by-play">Play-by-Play</option>}
            </select>
          ) : (
            <div className="metrics-subnav">
              <button className={`metrics-subnav-btn${metricsView === "pitch-data" ? " active" : ""}`} onClick={() => setMetricsView("pitch-data")}>
                Pitch Overview
              </button>
              <button className={`metrics-subnav-btn${metricsView === "results" ? " active" : ""}`} onClick={() => setMetricsView("results")}>
                Results
              </button>
              <button className={`metrics-subnav-btn${metricsView === "usage" ? " active" : ""}`} onClick={() => setMetricsView("usage")}>
                Usage
              </button>
              <button className={`metrics-subnav-btn${metricsView === "velocity-trend" ? " active" : ""}`} onClick={() => setMetricsView("velocity-trend")}>
                Velocity Trend
              </button>
              {pitcherPBP && (
                <button className={`metrics-subnav-btn${metricsView === "play-by-play" ? " active" : ""}`} onClick={() => setMetricsView("play-by-play")}>
                  Play-by-Play
                </button>
              )}
            </div>
          )}
          <div className="metrics-controls">
            <div className="filter-pill-group">
              <span className="filter-pill-label">Compare to</span>
              <select className="game-filter-select" value={compareTo}
                onChange={e => setCompareTo(e.target.value)}>
                <option value="prev" disabled={!loadingAvgs && !hasAvgData(prevSeasonAvgs)}>
                  {prevSeason || currentYear - 1}
                </option>
                <option value="current" disabled={!loadingAvgs && !hasAvgData(currentSeasonAvgs)}>
                  {currentYear}
                </option>
              </select>
            </div>
            <div className="filter-pill-group">
              <span className="filter-pill-label">LHB/RHB</span>
              <select className="game-filter-select" value={batterFilter}
                onChange={e => setBatterFilter(e.target.value)}>
                <option value="all">vs. All</option>
                <option value="L">vs LHB</option>
                <option value="R">vs RHB</option>
              </select>
            </div>
          </div>
        </div>
        {metricsView === "pitch-data" && (
          <div className="metrics-card">
            <PitchDataTable data={activePitchTable} columns={CARD_PITCH_DATA_COLUMNS}
              splitByTeam={false} spOnly={false} pitcherHand={hand}
              sortable={false}
              showChange={true} seasonAvgs={seasonAvgs}
              batterFilter={batterFilter} isMobile={isMobile}
              selectedPitchTypes={selectedPitchTypes}
              onPitchTypeClick={toggleSelectedPitch}
              onClearSelection={clearSelectedPitches} />
            {loadingAvgs && <div className="loading-avgs"><div className="loading-bars loading-bars-sm"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}
          </div>
        )}
        {metricsView === "results" && (
          <div className="metrics-card">
            <ResultsTable pitches={metricsPitches} batterFilter={batterFilter} gameFilter="all" isMobile={isMobile}
              selectedPitchTypes={selectedPitchTypes}
              onPitchTypeClick={toggleSelectedPitch}
              onClearSelection={clearSelectedPitches} />
          </div>
        )}
        {metricsView === "usage" && (
          <div className="metrics-card">
            <UsageTable pitches={metricsPitches} batterFilter={batterFilter} gameFilter="all" isMobile={isMobile}
              selectedPitchTypes={selectedPitchTypes}
              onPitchTypeClick={toggleSelectedPitch}
              onClearSelection={clearSelectedPitches} />
          </div>
        )}
        {metricsView === "velocity-trend" && (
          <div className="metrics-card">
            <VelocityChart mode="game" pitches={filteredPitches} onReclassify={onReclassify} isMobile={isMobile} linescoreData={linescoreData} pitcherId={pitcher_id} />
          </div>
        )}
        {metricsView === "play-by-play" && pitcherPBP && (
          <PitchPlayByPlaySection
            pitcherPBP={pitcherPBP}
            pitcherId={pitcher_id}
            linescoreData={linescoreData}
            pbpActivePa={pbpActivePa}
            setPbpActivePa={setPbpActivePa}
            pbpExpanded={pbpExpanded}
            setPbpExpanded={setPbpExpanded}
            pbpPitchHover={pbpPitchHover}
            setPbpPitchHover={setPbpPitchHover}
          />
        )}
      </div>

      {/* ===== VISUALS: Strike zones side by side + Movement ===== */}
      <div className="card-visuals-section">
        <div className="sz-mode-select-row filter-controls-row">
          <div className="filter-pill-group">
            <span className="filter-pill-label">Plot Display</span>
            <select className="sz-mode-select" value={szColorMode} onChange={e => setSzColorMode(e.target.value)}>
              <option value="pitch-type">Pitch Types</option>
              <option value="pitch-result">Pitch Results</option>
              <option value="pa-result">PA Results</option>
            </select>
          </div>
          <div className="filter-pill-group">
            <span className="filter-pill-label">Pitch Type Filter</span>
            <PitchFilterDropdown
              label="All Pitches"
              options={availablePitchTypes}
              selected={effectivePitchTypeFilter}
              onChange={setPitchTypeFilter}
              colorMap={PITCH_COLORS}
            />
          </div>
          <div className="filter-pill-group">
            <span className="filter-pill-label">Result Filter</span>
            <PitchFilterDropdown
              label="Results"
              options={RESULT_FILTER_OPTIONS}
              selected={effectiveResultFilter}
              onChange={setResultFilter}
              columns={2}
              quickActions={RESULT_QUICK_ACTIONS}
            />
          </div>
          {availableInnings.length > 0 && (
            <div className="filter-pill-group">
              <span className="filter-pill-label">Inning</span>
              <PitchFilterDropdown
                label="Innings"
                options={availableInnings}
                selected={effectiveInningFilter}
                onChange={setInningFilter}
              />
            </div>
          )}
          <div className="filter-pill-group">
            <span className="filter-pill-label">Contact</span>
            <select className="game-filter-select" value={contactFilter} onChange={e => setContactFilter(e.target.value)}>
              <option value="all">All Pitches</option>
              <option value="hard">Hard BIP</option>
              <option value="weak">Weak BIP</option>
            </select>
          </div>
        </div>
        <div className="card-visuals">
          <div className="card-sz-pair">
            {(batterFilter === "all" || batterFilter === "L") && (
              <div className="viz-card">
                <div className="viz-card-label">vs LHB</div>
                <StrikeZonePlot pitches={filteredPitches} stand="L" colorMode={szColorMode} onReclassify={onReclassify} isMobile={isMobile} highlightPitch={crossHoverPitch} highlightType={null} onPitchHover={setCrossHoverPitch} />
              </div>
            )}
            {(batterFilter === "all" || batterFilter === "R") && (
              <div className="viz-card">
                <div className="viz-card-label">vs RHB</div>
                <StrikeZonePlot pitches={filteredPitches} stand="R" colorMode={szColorMode} onReclassify={onReclassify} isMobile={isMobile} highlightPitch={crossHoverPitch} highlightType={null} onPitchHover={setCrossHoverPitch} />
              </div>
            )}
        </div>
          <div className="viz-card">
            <div className="viz-card-label">Pitch Movement</div>
            <MovementPlot pitches={filteredPitches} hand={hand} onReclassify={onReclassify} isMobile={isMobile} highlightPitch={crossHoverPitch} highlightType={null} onPitchHover={setCrossHoverPitch} />
          </div>
        </div>
      </div>

      {/* ===== Regular Season game log + season totals ===== */}
      {enrichedPlayerPageData && (
        <div className="card-regular-season">
          <RegularSeasonTable
            data={enrichedPlayerPageData}
            pitcherId={pitcher_id}
            displayAbbrev={(abbr) => displayTeamAbbrev(abbr)}
            buildCardHref={(d, gpk) => `#${buildCardHash({ date: d, pitcherId: pitcher_id, gamePk: gpk })}`}
            onGameClick={onNavigateToCard}
            prevSeasonAvgs={prevSeasonAvgs}
          />
        </div>
      )}
    </div>
  );
}
