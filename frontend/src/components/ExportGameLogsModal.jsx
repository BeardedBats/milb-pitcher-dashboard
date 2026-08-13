import React, { useEffect, useMemo, useRef, useState } from "react";
import { fetchPitcherResults } from "../utils/api";
import { ADAPTED_COLUMNS } from "./AdaptedResultsTable";
import { downloadCsv } from "../utils/csv";

// "Export Game Logs" lightbox for the homepage: pick a date range (bounded by
// the season start and the current slate) and get every day's daily
// performance table as ONE CSV, with a Date column prepended.
//
// Exports what the page shows: the current level, with the SP Only / RP Only /
// Org filters applied. Column set follows the level the same way the page
// does — the Statcast table's columns for AAA/AFL, the adapted box-score
// columns everywhere else.
//
// Each day is one /api/pitcher-results call — the same request paging the date
// picker back makes, so warmed days are CDN/cache hits. A modest concurrency
// cap keeps a season-long export from stampeding cold serverless instances.

export const SEASON_START_DATE = "2026-03-25";
const CONCURRENCY = 4;

// Statcast rows mark home games via home_team/away_team (the box rows carry a
// `home` boolean instead) — same test the on-screen table uses.
const statcastAway = (r) => !(r.home_team && r.team === r.home_team);

// Statcast (AAA/AFL) export columns — the daily performance table's fields,
// raw. Velo/EXT export the number without the UI's delta annotation.
const STATCAST_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "level", label: "Level" },
  { key: "pitcher", label: "Pitcher" },
  { key: "team", label: "Team" },
  { key: "org", label: "Org" },
  { key: "hand", label: "Hand" },
  { key: "role", label: "Role" },
  { key: "opponent", label: "Opp", value: r => (statcastAway(r) ? "@ " : "") + (r.opponent || "") },
  { key: "decision", label: "Dec" },
  { key: "ip", label: "IP" },
  { key: "runs", label: "R" },
  { key: "er", label: "ER" },
  { key: "hits", label: "H" },
  { key: "bbs", label: "BB" },
  { key: "ks", label: "K" },
  { key: "whiffs", label: "Whiffs" },
  // Daily statcast rows don't carry swstr_pct — derive it from whiffs/pitches.
  { key: "swstr_pct", label: "SwStr%", value: r => (r.swstr_pct != null ? r.swstr_pct : (r.pitches > 0 && r.whiffs != null ? Math.round((r.whiffs / r.pitches) * 1000) / 10 : "")) },
  { key: "csw_pct", label: "CSW%" },
  { key: "strike_pct", label: "Strike%" },
  { key: "par_pct", label: "PAR%" },
  { key: "pitches", label: "Pitches" },
  { key: "hrs", label: "HR" },
  { key: "velo", label: "FB MPH" },
  { key: "velo_pitch", label: "FB Type" },
  { key: "velo_ext", label: "Ext" },
];

// Box-score levels: the adapted table's on-by-default columns (its own `date`
// column already leads), plus Level/Org/Role context for a flat file.
const BOX_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "level", label: "Level" },
  ...ADAPTED_COLUMNS.filter(c => !c.off && c.key !== "date").map(({ key, label }) => {
    if (key === "opponent") return { key, label: "Opp", value: r => (r.home ? "" : "@ ") + (r.opponent || "") };
    return { key, label };
  }),
  { key: "org", label: "Org" },
  { key: "role", label: "Role" },
];

function listDates(start, end) {
  const out = [];
  const d = new Date(`${start}T12:00:00Z`);
  const stop = new Date(`${end}T12:00:00Z`);
  while (d <= stop) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

export default function ExportGameLogsModal({
  level,
  isStatcastLevel,
  currentDate,      // the slate the page is on — upper bound + default end
  spOnly,
  rpOnly,
  orgFilter,
  onClose,
}) {
  const maxDate = currentDate || new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(SEASON_START_DATE);
  const [end, setEnd] = useState(maxDate);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [failedDays, setFailedDays] = useState([]);
  const [error, setError] = useState(null);
  // Per-run cancellation token: each export gets its own object, so starting a
  // new run can never un-cancel a previous run's still-in-flight workers.
  const runToken = useRef(null);

  useEffect(() => () => { if (runToken.current) runToken.current.cancelled = true; }, []);

  const dates = useMemo(() => {
    if (!start || !end || start > end) return [];
    return listDates(start < SEASON_START_DATE ? SEASON_START_DATE : start,
                     end > maxDate ? maxDate : end);
  }, [start, end, maxDate]);

  const runExport = async () => {
    if (!dates.length || running) return;
    const token = { cancelled: false };
    runToken.current = token;
    setRunning(true);
    setError(null);
    setFailedDays([]);
    setDone(0);
    setTotal(dates.length);

    const byDate = new Map();
    const failed = [];
    let idx = 0;
    let completed = 0;

    const worker = async () => {
      while (!token.cancelled) {
        const i = idx++;
        if (i >= dates.length) return;
        const day = dates[i];
        try {
          const rows = await fetchPitcherResults(day, null, level);
          byDate.set(day, Array.isArray(rows) ? rows : []);
        } catch (e) {
          failed.push(day);
        }
        completed += 1;
        // A cancelled run's in-flight fetches still resolve — don't let them
        // clobber a newer run's progress counter.
        if (!token.cancelled) setDone(completed);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, dates.length) }, worker));

    if (token.cancelled) return;

    // Flatten in date order, applying the page's filters, and stamp the date
    // on every row (statcast rows don't carry one; box rows do, but the loop's
    // day is authoritative either way).
    const out = [];
    for (const day of dates) {
      let rows = byDate.get(day) || [];
      if (orgFilter) rows = rows.filter(r => r.org === orgFilter);
      if (spOnly) rows = rows.filter(r => r.role === "SP");
      else if (rpOnly) rows = rows.filter(r => r.role === "RP");
      for (const r of rows) out.push({ ...r, date: day, level: r.level || level });
    }

    if (!out.length) {
      setRunning(false);
      setFailedDays(failed);
      setError(failed.length
        ? "Every day in the range failed to load — try again in a minute."
        : "No games found in that range with the current filters.");
      return;
    }

    const cols = isStatcastLevel ? STATCAST_COLUMNS : BOX_COLUMNS;
    const roleTag = spOnly ? "_SP" : rpOnly ? "_RP" : "";
    const orgTag = orgFilter ? `_${orgFilter}` : "";
    downloadCsv(
      `daily-results_${level}${orgTag}${roleTag}_${dates[0]}_to_${dates[dates.length - 1]}.csv`,
      cols,
      out,
    );
    setFailedDays(failed);
    setRunning(false);
  };

  const cancel = () => {
    if (runToken.current) runToken.current.cancelled = true;
    setRunning(false);
  };

  const filterSummary = [
    level,
    orgFilter || null,
    spOnly ? "SP only" : rpOnly ? "RP only" : null,
  ].filter(Boolean).join(" · ");

  return (
    <div className="export-backdrop" onClick={running ? undefined : onClose}>
      <div className="export-panel" onClick={e => e.stopPropagation()}>
        <div className="export-header">
          <span className="export-title">Export Game Logs</span>
          <button className="export-close" onClick={() => { cancel(); onClose(); }}>×</button>
        </div>
        <div className="export-body">
          <div className="export-note">
            One CSV of the daily performance table for every day in the range,
            with a Date column. Exports what the page shows: <b>{filterSummary}</b>.
          </div>
          <div className="export-range-row">
            <label className="level-select-label">
              <span>From</span>
              <input
                type="date"
                value={start}
                min={SEASON_START_DATE}
                max={maxDate}
                disabled={running}
                onChange={e => setStart(e.target.value)}
              />
            </label>
            <label className="level-select-label">
              <span>To</span>
              <input
                type="date"
                value={end}
                min={SEASON_START_DATE}
                max={maxDate}
                disabled={running}
                onChange={e => setEnd(e.target.value)}
              />
            </label>
            <span className="export-day-count">
              {dates.length ? `${dates.length} day${dates.length === 1 ? "" : "s"}` : "Pick a valid range"}
            </span>
          </div>
          {running && (
            <div className="export-progress">
              <div className="export-progress-track">
                <div
                  className="export-progress-fill"
                  style={{ width: total ? `${Math.round((done / total) * 100)}%` : 0 }}
                />
              </div>
              <span>{done} / {total} days</span>
            </div>
          )}
          {error && <div className="export-error">{error}</div>}
          {!running && !error && failedDays.length > 0 && (
            <div className="export-error">
              Exported, but {failedDays.length} day{failedDays.length === 1 ? "" : "s"} failed to
              load and {failedDays.length === 1 ? "is" : "are"} missing: {failedDays.slice(0, 6).join(", ")}{failedDays.length > 6 ? "…" : ""}
            </div>
          )}
          <div className="export-actions">
            {running ? (
              <button className="export-btn export-btn-cancel" onClick={cancel}>Cancel</button>
            ) : (
              <button className="export-btn" disabled={!dates.length} onClick={runExport}>
                Export CSV
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
