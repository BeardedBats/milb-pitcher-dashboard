import React, { useState, useEffect, useMemo } from "react";
import { PITCH_COLORS, CARD_PITCH_DATA_COLUMNS, displayTeamAbbrev } from "../constants";
import useIsMobile from "../hooks/useIsMobile";
import PitchDataTable from "./PitchDataTable";
import StrikeZonePlot from "./StrikeZonePlot";
import MovementPlot from "./MovementPlot";
import PitchFilterDropdown from "./PitchFilterDropdown";
import ResultsTable from "./ResultsTable";
import UsageTable from "./UsageTable";
import { classifyPitchResult, isRunScored, isStrikeoutPitch, isBallInPlay, classifyBIPQuality, RESULT_FILTER_OPTIONS, RESULT_QUICK_ACTIONS } from "../utils/pitchFilters";
import { fetchPlayerPageResource, fetchWarmupStatus } from "../utils/api";
import { buildCardHash } from "../utils/navigation";
import useWarmupBackedResource from "../hooks/useWarmupBackedResource";
import WarmupStalled from "./WarmupStalled";
import LoadError from "./LoadError";
import usePitchFilters from "../hooks/usePitchFilters";
import VelocityChart from "./VelocityChart";
import RegularSeasonTable from "./RegularSeasonTable";

export default function PlayerPage({ pitcherId, onBack, onGameClick }) {
  const isMobile = useIsMobile();
  const buildCardHref = (gameDate, gamePk) => `#${buildCardHash({ date: gameDate, pitcherId, gamePk })}`;
  const { data, loading, message: loadMsg, error, stalled, reload } = useWarmupBackedResource({
    key: [pitcherId],
    load: () => fetchPlayerPageResource(pitcherId, { startDate: "2026-03-25" }),
    pollWarmup: fetchWarmupStatus,
    initialMessage: "Loading player data...",
  });
  const [seasonAvgs, setSeasonAvgs] = useState(null);
  const [loadingAvgs, setLoadingAvgs] = useState(false);
  const [szColorMode, setSzColorMode] = useState("pitch-type");
  const [metricsView, setMetricsView] = useState("pitch-data"); // "pitch-data" | "results" | "velocity-trend"

  const [crossHoverPitch, setCrossHoverPitch] = useState(null);

  // Game filter for plots AND pitch metrics. Kept local (not in usePitchFilters)
  // because availablePitchTypes is derived from it — see the hook's notes.
  const [gameFilter, setGameFilter] = useState("all");

  // Previous MLB season (resolved at fetch time — may be 2024 or earlier for
  // players returning from injury / first-year starters / etc.)
  const [prevSeason, setPrevSeason] = useState(null);

  // Available pitch types for the filter dropdown (narrowed by the game filter).
  const availablePitchTypes = useMemo(() => {
    if (!data?.pitches) return [];
    let ps = data.pitches;
    if (gameFilter !== "all") {
      ps = ps.filter(p => String(p.game_pk) === String(gameFilter));
    }
    const types = new Set(ps.map(p => p.pitch_name).filter(Boolean));
    return [...types].sort();
  }, [data, gameFilter]);

  // Shared pitch-filter state: batter hand, pitch-type/result/contact filters,
  // and row-click pitch-type selection.
  const {
    pitchTypeFilter, setPitchTypeFilter,
    resultFilter, setResultFilter,
    contactFilter, setContactFilter,
    batterFilter, setBatterFilter,
    selectedPitchTypes, setSelectedPitchTypes,
    effectivePitchTypeFilter, effectiveResultFilter,
    toggleSelectedPitch, clearSelectedPitches,
  } = usePitchFilters(availablePitchTypes);

  // Always fetch season averages for change display.
  // auto_fallback resolves the most recent prior MLB season with data — so
  // deltas and (NEW) tags are relative to the player's actual last MLB season,
  // not a hardcoded year.
  useEffect(() => {
    if (!data) return;
    const payload = data.season_averages || {};
    setSeasonAvgs(payload.previous || {});
    setPrevSeason(payload.previous_season || null);
    setLoadingAvgs(false);
  }, [data]);

  // Select correct pitch table based on batter filter AND game filter
  const activePitchData = useMemo(() => {
    if (!data) return [];
    let table;
    if (gameFilter !== "all" && data.per_game_summaries) {
      const gameSummary = data.per_game_summaries[String(gameFilter)];
      if (gameSummary) {
        if (batterFilter === "L") table = gameSummary.vs_l;
        else if (batterFilter === "R") table = gameSummary.vs_r;
        else table = gameSummary.all;
      }
    }
    if (!table) {
      if (batterFilter === "L" && data.pitch_summary_vs_l) table = data.pitch_summary_vs_l;
      else if (batterFilter === "R" && data.pitch_summary_vs_r) table = data.pitch_summary_vs_r;
      else table = data.pitch_summary;
    }
    if (table) return [...table].sort((a, b) => (b.count || 0) - (a.count || 0));
    return [];
  }, [data, batterFilter, gameFilter]);

  const sortedLog = useMemo(() => {
    if (!data?.game_log) return [];
    return [...data.game_log].sort((a, b) => a.date.localeCompare(b.date));
  }, [data]);

  // Game options for dropdown: numbered by date order
  const gameOptions = useMemo(() => {
    return sortedLog.map((g, i) => ({
      idx: i + 1,
      date: g.date,
      game_pk: g.game_pk,
      opponent: g.opponent,
      label: `${i + 1}. ${formatCompactDate(g.date)} vs ${displayTeamAbbrev(g.opponent)}`,
    }));
  }, [sortedLog]);

  // Reset row-click selection whenever the underlying pitch universe changes
  // (game filter switches what's available).
  useEffect(() => {
    setSelectedPitchTypes(new Set());
  }, [gameFilter, setSelectedPitchTypes]);

  // Filtered pitches for plots
  const filteredPitches = useMemo(() => {
    if (!data?.pitches) return [];
    let fp = data.pitches;
    // Game filter
    if (gameFilter !== "all") {
      fp = fp.filter(p => String(p.game_pk) === String(gameFilter));
    }
    // Batter hand filter
    if (batterFilter === "L") fp = fp.filter(p => p.stand === "L");
    else if (batterFilter === "R") fp = fp.filter(p => p.stand === "R");
    // Pitch type filter
    if (pitchTypeFilter !== null) {
      fp = fp.filter(p => effectivePitchTypeFilter.has(p.pitch_name));
    }
    // Row-click pitch type selection (intersects with dropdown filter)
    if (selectedPitchTypes.size > 0) {
      fp = fp.filter(p => selectedPitchTypes.has(p.pitch_name));
    }
    // Result filter
    if (resultFilter !== null) {
      fp = fp.filter(p => {
        const cat = classifyPitchResult(p);
        // "Run(s)" is an overlay category — check separately
        if (effectiveResultFilter.has("Run(s)") && isRunScored(p)) return true;
        // "Strikeout" is an overlay — strikeout PA's last pitch is classified as
        // Called Strike or Whiff by description, so check the event directly
        if (effectiveResultFilter.has("Strikeout") && isStrikeoutPitch(p)) return true;
        // "Walk" overlay — the ball-four pitch that ends a walk PA only. Requires:
        // balls==3 pre-pitch, pitch outcome is a ball, PA event is a walk, not HBP.
        if (effectiveResultFilter.has("Walk")) {
          const ev = (p.events || "").toLowerCase();
          const desc = (p.description || "").toLowerCase();
          if (p.balls === 3 && cat === "Ball" && ev === "walk" && desc !== "hit_by_pitch") return true;
        }
        return effectiveResultFilter.has(cat) || cat === "Other";
      });
    }
    // Contact filter (Weak BIP / Hard BIP)
    if (contactFilter !== "all") {
      fp = fp.filter(p => {
        if (!isBallInPlay(p)) return false;
        const quality = classifyBIPQuality(p.launch_speed, p.launch_angle);
        if (contactFilter === "weak") return quality === "Weak";
        if (contactFilter === "hard") return quality === "Hard";
        return true;
      });
    }
    return fp;
  }, [data, gameFilter, batterFilter, pitchTypeFilter, effectivePitchTypeFilter, selectedPitchTypes, resultFilter, effectiveResultFilter, contactFilter]);

  // Play-by-Play availability: enabled when single game or specific game selected
  const multiGame = sortedLog.length > 1;
  const pbpDisabled = multiGame && gameFilter === "all";

  // Resolve the game_pk for PBP navigation
  const pbpGamePk = useMemo(() => {
    if (gameFilter !== "all") return gameFilter;
    if (sortedLog.length === 1) return sortedLog[0].game_pk;
    return null;
  }, [gameFilter, sortedLog]);

  const pbpGameDate = useMemo(() => {
    if (!pbpGamePk) return null;
    const g = sortedLog.find(g => String(g.game_pk) === String(pbpGamePk));
    return g?.date || null;
  }, [pbpGamePk, sortedLog]);

  const handlePbpClick = () => {
    if (pbpDisabled || !pbpGamePk || !pbpGameDate) return;
    onGameClick(pbpGameDate, pitcherId, pbpGamePk);
  };

  // Before the "Player not found" branch below — a failed request is not a
  // missing player, and conflating them hides outages behind a plausible
  // "no such pitcher".
  if (error) {
    return (
      <div className="pp-outer-centered">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <LoadError message="Couldn't load this player." detail={error.message} onRetry={reload} />
      </div>
    );
  }

  if (stalled) {
    // Retry budget spent — polling has stopped. Unlike the loading branch the
    // back button IS shown: this is a resting state the user may want to leave.
    return (
      <div className="pp-outer-centered">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <WarmupStalled message={loadMsg} onRetry={reload} />
      </div>
    );
  }

  if (loading) {
    // The back button's placement is tied to the player card. While loading,
    // the centered layout (display: table) would render it in the middle of
    // the page, then snap it left once the card mounts. Hide it until the
    // card is ready so it appears in place, at the same time as the card.
    return (
      <div className="pp-outer-centered">
        <div className="loading-msg"><div className="loading-bars"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div>{loadMsg}</div>
      </div>
    );
  }

  if (!data?.info?.name) {
    return (
      <div className="pp-outer-centered">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
        <div className="loading-msg">Player not found</div>
      </div>
    );
  }

  const info = data.info;
  const hasData = data.game_log && data.game_log.length > 0;
  // The Savant section (pitch metrics, plots, velocity, PBP) is AAA-only. When
  // a pitcher has no AAA games the backend omits `pitch_summary` entirely and
  // we render nothing at all — no empty state, no explanatory note, per spec.
  // The Regular Season log still shows every level.
  const hasSavant = Array.isArray(data.pitch_summary);

  return (
    <div className="pp-outer-centered">
      <div className="pp-back-row">
        <a className="back-btn" href={window.location.pathname} rel="nofollow" onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); onBack(); } }} style={{ textDecoration: "none" }}>← Back</a>
      </div>
      <div className="card">
        {/* ===== Header: name + meta ===== */}
        <div className="pp-header-row">
          <div className="card-info">
            <div className="card-name">{info.name}</div>
            <div className="card-meta">
              {info.teams?.map(t => displayTeamAbbrev(t)).join("/") || ""} · {info.hand === "R" ? "RHP" : "LHP"}
            </div>
          </div>
        </div>

        {/* ===== Regular Season — full width, above Pitch Overview ===== */}
        {hasData && (
          <RegularSeasonTable
            data={data}
            pitcherId={pitcherId}
            displayAbbrev={displayTeamAbbrev}
            buildCardHref={buildCardHref}
            onGameClick={onGameClick}
            className="card-gameline-box--full"
          />
        )}
        {hasData && hasSavant && (
          <>
            {/* ===== PITCH TYPE METRICS ===== */}
            <div className="card-section">
              <div className="metrics-header">
                {isMobile ? (
                  <select className="metrics-subnav-mobile" value={metricsView} onChange={e => setMetricsView(e.target.value)}>
                    <option value="pitch-data">Pitch Overview</option>
                    <option value="results">Results</option>
                    <option value="usage">Usage</option>
                    <option value="velocity-trend">Velocity Trend</option>
                    <option value="play-by-play" disabled={pbpDisabled}>Play-by-Play</option>
                  </select>
                ) : (
                  <div className="metrics-subnav">
                    <button className={`metrics-subnav-btn${metricsView === "pitch-data" ? " active" : ""}`} onClick={() => setMetricsView("pitch-data")}>Pitch Overview</button>
                    <button className={`metrics-subnav-btn${metricsView === "results" ? " active" : ""}`} onClick={() => setMetricsView("results")}>Results</button>
                    <button className={`metrics-subnav-btn${metricsView === "usage" ? " active" : ""}`} onClick={() => setMetricsView("usage")}>Usage</button>
                    <button className={`metrics-subnav-btn${metricsView === "velocity-trend" ? " active" : ""}`} onClick={() => setMetricsView("velocity-trend")}>Velocity Trend</button>
                    {!pbpDisabled && pbpGamePk && pbpGameDate ? (
                      <a
                        className="metrics-subnav-btn"
                        href={buildCardHref(pbpGameDate, pbpGamePk)}
                        rel="nofollow"
                        onClick={(e) => { if (!e.ctrlKey && !e.metaKey) { e.preventDefault(); handlePbpClick(); } }}
                        style={{ textDecoration: "none" }}
                      >
                        Play-by-Play
                      </a>
                    ) : (
                      <button
                        className="metrics-subnav-btn metrics-subnav-disabled"
                        disabled
                      >
                        Play-by-Play
                      </button>
                    )}
                  </div>
                )}
                <div className="metrics-controls">
                  <div className="filter-pill-group">
                    <span className="filter-pill-label">Game</span>
                    <select className="game-filter-select" value={gameFilter} onChange={e => {
                      setGameFilter(e.target.value);
                      setPitchTypeFilter(null);
                    }}>
                      <option value="all">All Games</option>
                      {gameOptions.map(g => (
                        <option key={g.game_pk} value={g.game_pk}>{g.label}</option>
                      ))}
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
                  <PitchDataTable
                    data={activePitchData}
                    columns={CARD_PITCH_DATA_COLUMNS}
                    splitByTeam={false}
                    spOnly={false}
                    pitcherHand={info.hand}
                    sortable={false}
                    showChange={true}
                    seasonAvgs={seasonAvgs}
                    batterFilter={batterFilter}
                    isMobile={isMobile}
                    selectedPitchTypes={selectedPitchTypes}
                    onPitchTypeClick={toggleSelectedPitch}
                    onClearSelection={clearSelectedPitches}
                  />
                  {loadingAvgs && <div className="loading-avgs"><div className="loading-bars loading-bars-sm"><div className="loading-bar" /><div className="loading-bar" /><div className="loading-bar" /></div></div>}
                </div>
              )}
              {metricsView === "results" && (
                <div className="metrics-card">
                  <ResultsTable pitches={data?.pitches} batterFilter={batterFilter} gameFilter={gameFilter} isMobile={isMobile}
                    selectedPitchTypes={selectedPitchTypes}
                    onPitchTypeClick={toggleSelectedPitch}
                    onClearSelection={clearSelectedPitches} />
                </div>
              )}
              {metricsView === "usage" && (
                <div className="metrics-card">
                  <UsageTable pitches={data?.pitches} batterFilter={batterFilter} gameFilter={gameFilter} isMobile={isMobile}
                    selectedPitchTypes={selectedPitchTypes}
                    onPitchTypeClick={toggleSelectedPitch}
                    onClearSelection={clearSelectedPitches} />
                </div>
              )}
              {metricsView === "velocity-trend" && (
                <div className="metrics-card">
                  <VelocityChart mode="season" pitches={filteredPitches} isMobile={isMobile} />
                </div>
              )}
            </div>

            {/* ===== VISUALS: Strike zones + Movement ===== */}
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
                  <span className="filter-pill-label">Game</span>
                  <select className="game-filter-select" value={gameFilter} onChange={e => {
                    setGameFilter(e.target.value);
                    setPitchTypeFilter(null);
                  }}>
                    <option value="all">All Games</option>
                    {gameOptions.map(g => (
                      <option key={g.game_pk} value={g.game_pk}>{g.label}</option>
                    ))}
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
                <div className="filter-pill-group">
                  <span className="filter-pill-label">Contact</span>
                  <select className="sz-mode-select" value={contactFilter} onChange={e => setContactFilter(e.target.value)}>
                    <option value="all">All Pitches</option>
                    <option value="weak">Weak BIP</option>
                    <option value="hard">Hard BIP</option>
                  </select>
                </div>
              </div>
              <div className="card-visuals">
                <div className="card-sz-pair">
                  {(batterFilter === "all" || batterFilter === "L") && (
                    <div className="viz-card">
                      <div className="viz-card-label">vs LHB</div>
                      <StrikeZonePlot pitches={filteredPitches} stand="L" colorMode={szColorMode} isMobile={isMobile} highlightPitch={crossHoverPitch} onPitchHover={setCrossHoverPitch} />
                    </div>
                  )}
                  {(batterFilter === "all" || batterFilter === "R") && (
                    <div className="viz-card">
                      <div className="viz-card-label">vs RHB</div>
                      <StrikeZonePlot pitches={filteredPitches} stand="R" colorMode={szColorMode} isMobile={isMobile} highlightPitch={crossHoverPitch} onPitchHover={setCrossHoverPitch} />
                    </div>
                  )}
                </div>
                <div className="viz-card">
                  <div className="viz-card-label">Pitch Movement</div>
                  <MovementPlot pitches={filteredPitches} hand={info.hand} isMobile={isMobile} highlightPitch={crossHoverPitch} onPitchHover={setCrossHoverPitch} />
                </div>
              </div>
            </div>
          </>
        )}

        {!hasData && <div className="pp-empty">No Game Results</div>}
      </div>
    </div>
  );
}

function formatCompactDate(dateStr) {
  if (!dateStr) return "";
  const parts = dateStr.split("-");
  if (parts.length < 3) return dateStr;
  const m = parseInt(parts[1], 10);
  const d = parseInt(parts[2], 10);
  return `${m}-${parts[2]}`;
}
