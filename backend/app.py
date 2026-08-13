import os
import csv
import io
import re
import threading
import time
from pathlib import Path
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests as http_requests
from fastapi import FastAPI, Query, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from season import (
    SEASON_START,
    season_start as _season_start,
    now_et as _now_et,
    strip_accents as _strip_accents,
    ip_to_outs as _ip_to_thirds,
    aggregate_game_log_to_totals as _aggregate_game_log_to_totals,
)
from data import (
    get_games, clear_cache, clear_live_refresh_cache, get_default_date, get_game_linescore,
    save_pitch_override, remove_pitch_override, get_all_overrides,
    prefetch_boxscores,
    fold_range_materialized, range_is_materialized,
    fetch_pitcher_rows_materialized,
    fetch_all_pitchers_list_materialized, warm_partial_pitcher_directory,
    fetch_pitchers_directory,
    queue_range_materialization, get_range_materialization_status,
    drain_pending_materializations,
    start_warmup, get_warmup_status, get_agg_cache, set_agg_cache,
    warmup_range_data, fetch_date, fetch_pitcher_season, compute_player_page,
    invalidate_pitcher_related_caches,
    get_override_version, CARD_SCHEMA_VERSION,
    get_baseball_date,
    season_cache_suffix as _season_cache_suffix,
    get_stat_lines_refresh, record_stat_lines_refresh, fetch_game_pitches,
    check_boxscore_stat_corrections, get_game_level_map,
    get_probable_starter_ids, _get_mlb_schedule,
)
from aggregation import (
    aggregate_pitch_data, aggregate_pitcher_results, get_pitcher_card,
    get_season_averages, get_pitcher_game_log,
    find_previous_mlb_season,
    new_results_accumulator, accumulate_pitcher_results, finalize_pitcher_results,
    new_pitch_data_accumulator, accumulate_pitch_data, finalize_pitch_data,
)
from levels import (
    DEFAULT_LEVEL, LEVELS, LEVEL_ORDER, STATCAST_LEVELS, normalize_level,
    is_statcast_level, all_orgs, affiliates_for_org, team_display_name,
    level_sort_key as _level_sort_key,
)
import ledger
from boxscore_levels import (
    get_team_last_games,
    get_level_results, get_multi_level_game_log, current_level, get_person_info,
    get_team_season_pitchers, get_all_milb_pitchers, cached_milb_pitchers,
    enrich_log_with_pitch_metrics, get_game_pitch_metrics,
    _METRICS_VERSION, _gamelog_for_level,
)
from mlb_status import (
    get_mlb_experience, tag_mlb_experience, get_il_pitchers, get_starters_in_range,
    tag_current_team,
)
from redis_cache import redis_get, redis_set, redis_delete

app = FastAPI(title="MiLB Pitcher Dashboard API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

# Reject malformed date query params at one chokepoint (400) before they can
# reach Savant request URLs or become unbounded cache keys.
_DATE_QUERY_PARAMS = ("date", "start_date", "end_date", "before_date", "game_date")


@app.middleware("http")
async def _reject_malformed_date_params(request: Request, call_next):
    for name in _DATE_QUERY_PARAMS:
        value = request.query_params.get(name)
        if value and not _valid_date_param(value):
            return JSONResponse(
                {"detail": f"Invalid {name}: expected YYYY-MM-DD"},
                status_code=400,
            )
    return await call_next(request)

# ── Serve React frontend in production ──
# Look for frontend build in ../frontend-build (relative to backend/)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend-build"

# ── Detect environment: serverless (Vercel) vs persistent (local/Electron) ──
_IS_SERVERLESS = os.environ.get("VERCEL") == "1" or os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None
# CARD_SCHEMA_VERSION is imported from data.py — bump it there when a cached
# payload shape changes so all card/season-totals/player-page caches miss.

# ── Startup: pre-fetch data in background (local/Electron only) ──
# NEVER on serverless: every cold start would kick off a full-season Savant
# fetch across all Statcast levels. Vercel warms caches via the crons instead.
@app.on_event("startup")
def on_startup():
    if not _IS_SERVERLESS:
        start_warmup()


# ── Helper: resolve end_date to today ET ──
def _resolve_end_date(end_date: str) -> str:
    if end_date:
        return end_date
    return _now_et().strftime("%Y-%m-%d")


def _is_today_str(date_str: str) -> bool:
    return bool(date_str) and date_str == _resolve_end_date("")


def _cache_scope_for_date(date_str: str) -> str:
    return "past" if date_str and date_str < get_baseball_date() else "live"


def _set_response_cache(response: Response, scope: str):
    if scope == "past":
        response.headers["Cache-Control"] = "public, max-age=3600, s-maxage=2592000, stale-while-revalidate=2592000"
    elif scope == "mutation":
        response.headers["Cache-Control"] = "no-store"
    else:
        response.headers["Cache-Control"] = "public, max-age=0, s-maxage=30, stale-while-revalidate=60"


def _json_response(payload, status_code=200, scope="live"):
    resp = JSONResponse(payload, status_code=status_code)
    if scope == "past":
        resp.headers["Cache-Control"] = "public, max-age=3600, s-maxage=2592000, stale-while-revalidate=2592000"
    elif scope == "mutation":
        resp.headers["Cache-Control"] = "no-store"
    else:
        resp.headers["Cache-Control"] = "public, max-age=0, s-maxage=30, stale-while-revalidate=60"
    return resp


# How long a client should wait before asking again. Materialization only
# advances when /api/cron/materialize-ranges runs, and that cron is on a
# 5-minute schedule — polling faster than this cannot observe new progress, it
# just bills another invocation. The client treats this as a floor and still
# applies its own backoff on top (see utils/pollBackoff.js), so this can only
# slow clients down, never speed them up.
LOADING_RETRY_AFTER_SECONDS = 15


def _loading_response(response: Response, start_date: str, end_date: str):
    _set_response_cache(response, "mutation")
    job = queue_range_materialization(start_date, end_date)
    status = job.get("status", "pending")
    resp = _json_response(
        {
            "status": status,
            "message": "Season cache is rebuilding",
            "start_date": start_date,
            "end_date": end_date,
            "materialization_started": bool(job.get("queued")),
            "retry_after": LOADING_RETRY_AFTER_SECONDS,
            **({"error": job.get("error")} if job.get("error") else {}),
        },
        status_code=202,
        scope="mutation",
    )
    resp.headers["Retry-After"] = str(LOADING_RETRY_AFTER_SECONDS)
    return resp


def _valid_date_param(value: str) -> bool:
    try:
        datetime.strptime(value, "%Y-%m-%d")
        return True
    except Exception:
        return False


def _resolve_stat_lines_updated_at(date_str: str):
    ts = get_stat_lines_refresh(date_str)
    if ts is not None:
        return ts
    # Transitional fallback so the label stays useful for the current slate
    # until every environment has recorded the new per-date timestamp.
    try:
        if date_str == get_default_date():
            return redis_get("last_refresh")
    except Exception:
        pass
    return None


def _build_selected_game_payload(date_str: str, game_pk: int):
    df = fetch_game_pitches(date_str, game_pk)
    pitch_data = aggregate_pitch_data(date_str, game_pk, df=df)
    results_data = aggregate_pitcher_results(date_str, game_pk, df=df)
    return {
        "pitchData": pitch_data,
        "resultsData": results_data,
        "updatedAt": datetime.utcnow().isoformat() + "Z",
    }


@app.get("/api/default-date")
def default_date(response: Response):
    _set_response_cache(response, "live")
    return {"date": get_default_date()}

@app.get("/api/warmup-status")
def warmup_status(response: Response):
    _set_response_cache(response, "live")
    return get_warmup_status()

@app.get("/api/levels")
def levels_meta(response: Response):
    """Level + org dropdown options. Static per season — safe to cache hard."""
    _set_response_cache(response, "past")
    return {
        "levels": [
            {"code": code, "label": LEVELS[code]["label"], "statcast": code in STATCAST_LEVELS}
            for code in LEVEL_ORDER
        ],
        "default_level": DEFAULT_LEVEL,
        "orgs": all_orgs(),
    }


@app.get("/api/games")
def games(response: Response, date: str = Query(...), level: str = Query(DEFAULT_LEVEL)):
    _set_response_cache(response, _cache_scope_for_date(date))
    return get_games(date, normalize_level(level))

@app.get("/api/pitch-data")
def pitch_data(
    response: Response,
    date: str = Query(...),
    game_pk: int = Query(None),
    level: str = Query(DEFAULT_LEVEL),
):
    _set_response_cache(response, _cache_scope_for_date(date))
    level = normalize_level(level)
    # Pitch data exists only where Statcast does. Non-Statcast levels render
    # the adapted box-score table and never ask for this, but an explicit empty
    # list beats a confusing partial answer if one does.
    if not is_statcast_level(level):
        return []
    if game_pk is None:
        # Level is in the key — AAA and AFL aggregate separately.
        agg_key = f"daily_pitch_{level}_{date}"
        cached = get_agg_cache(agg_key)
        if cached is not None:
            return tag_mlb_experience(cached)
        result = tag_mlb_experience(aggregate_pitch_data(date, game_pk, level=level))
        set_agg_cache(agg_key, result)
        record_stat_lines_refresh(date)
        return result
    return tag_mlb_experience(aggregate_pitch_data(date, game_pk, level=level))

@app.get("/api/pitcher-results")
def pitcher_results(
    response: Response,
    date: str = Query(...),
    game_pk: int = Query(None),
    level: str = Query(DEFAULT_LEVEL),
):
    _set_response_cache(response, _cache_scope_for_date(date))
    level = normalize_level(level)
    # Below AAA there is no pitch tracking at all, so these rows come straight
    # off the box score and carry the adapted column set (Str%, GO/AO) instead
    # of Statcast-derived metrics.
    if not is_statcast_level(level):
        agg_key = f"daily_results_box_{level}_s{CARD_SCHEMA_VERSION}m{_METRICS_VERSION}_{date}"
        cached = get_agg_cache(agg_key)
        if cached is not None:
            rows = tag_mlb_experience(cached)
        else:
            rows = tag_mlb_experience(get_level_results(date, level))
            if rows:
                set_agg_cache(agg_key, rows)
        if game_pk is not None:
            rows = [r for r in rows if r.get("game_pk") == int(game_pk)]
        return rows
    if game_pk is None:
        # Check agg cache for all-games daily aggregation
        agg_key = f"daily_results_{level}_s{CARD_SCHEMA_VERSION}_{date}"
        cached = get_agg_cache(agg_key)
        if cached is not None:
            return tag_mlb_experience(cached)
        # include_season_context drives the velo/ext deltas + opener-swap
        # detection. Both internal helpers read only already-materialized
        # per-day data, so this is safe to keep on (no Savant CSV roundtrips).
        result = tag_mlb_experience(aggregate_pitcher_results(date, game_pk, include_season_context=True, level=level))
        # Don't cache a degraded payload — if the materialized range was missing
        # when this aggregation ran, every row's velo_season / *_delta is null.
        # Caching that would lock out deltas until the next schema bump. Only
        # cache when at least one pitcher with a fastball got a season delta
        # populated, which proves the helper found materialized data.
        has_season_context = any(
            r.get("velo_season") is not None
            for r in result
            if r.get("velo") is not None
        )
        if has_season_context:
            set_agg_cache(agg_key, result)
            record_stat_lines_refresh(date)
        return result
    return tag_mlb_experience(aggregate_pitcher_results(date, game_pk, level=level))


@app.get("/api/game-view")
def game_view(
    response: Response,
    date: str = Query(...),
    game_pk: int = Query(...),
    level: str = Query(DEFAULT_LEVEL),
):
    _set_response_cache(response, _cache_scope_for_date(date))
    level = normalize_level(level)
    agg_key = (
        f"game_view_{level}_{date}_{int(game_pk)}"
        f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
    )
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    payload = _build_selected_game_payload(date, int(game_pk))
    set_agg_cache(agg_key, payload)
    return payload

@app.get("/api/initial-load")
def initial_load(response: Response, level: str = Query(DEFAULT_LEVEL)):
    """Combined endpoint: returns default date + games + pitch data + pitcher results in one call.
    Eliminates the frontend waterfall of sequential API calls on first load.
    Defaults to AAA — the only level with a full Statcast homepage."""
    _set_response_cache(response, "live")
    level = normalize_level(level)
    started = time.perf_counter()
    timings = {}

    section = time.perf_counter()
    date = get_default_date()
    timings["default_date"] = round((time.perf_counter() - section) * 1000, 1)

    section = time.perf_counter()
    games_list = get_games(date, level)
    timings["games"] = round((time.perf_counter() - section) * 1000, 1)

    if not is_statcast_level(level):
        # Box-score-only level: no pitch data, adapted results table.
        box_key = f"daily_results_box_{level}_s{CARD_SCHEMA_VERSION}m{_METRICS_VERSION}_{date}"
        rows = get_agg_cache(box_key)
        if rows is None:
            rows = tag_mlb_experience(get_level_results(date, level, games=games_list))
            if rows:
                set_agg_cache(box_key, rows)
        return {
            "date": date,
            "level": level,
            "games": games_list,
            "pitchData": [],
            "resultsData": rows,
            "statLinesUpdatedAt": _resolve_stat_lines_updated_at(date),
        }

    pitch_key = f"daily_pitch_{level}_{date}"
    results_key = f"daily_results_{level}_s{CARD_SCHEMA_VERSION}_{date}"
    cached_pitch = get_agg_cache(pitch_key)
    cached_results = get_agg_cache(results_key)

    section = time.perf_counter()
    # tag_mlb_experience runs on the cached branch too: the cache may predate
    # the flag, and the lookup is a no-op when every id is already known.
    pd_data = tag_mlb_experience(cached_pitch if cached_pitch is not None else aggregate_pitch_data(date, None, level=level))
    timings["pitch_data"] = round((time.perf_counter() - section) * 1000, 1)
    timings["pitch_data_cached"] = cached_pitch is not None

    section = time.perf_counter()
    # include_season_context=True so velo/ext deltas land on the homepage
    # table. The helpers are materialized-range-only so they don't trigger a
    # synchronous Savant range pull on the first paint.
    pr_data = tag_mlb_experience(cached_results if cached_results is not None else aggregate_pitcher_results(date, None, include_season_context=True, level=level))
    timings["pitcher_results"] = round((time.perf_counter() - section) * 1000, 1)
    timings["pitcher_results_cached"] = cached_results is not None

    stat_lines_updated_at = _resolve_stat_lines_updated_at(date)
    if cached_pitch is None:
        set_agg_cache(pitch_key, pd_data)
        stat_lines_updated_at = record_stat_lines_refresh(date)
    if cached_results is None:
        # Same degraded-payload guard as /api/pitcher-results — only persist
        # daily_results once season-context deltas successfully computed.
        has_season_context = any(
            r.get("velo_season") is not None
            for r in pr_data
            if r.get("velo") is not None
        )
        if has_season_context:
            set_agg_cache(results_key, pr_data)
            stat_lines_updated_at = record_stat_lines_refresh(date)

    timings["total"] = round((time.perf_counter() - started) * 1000, 1)
    print(f"[InitialLoad] date={date} level={level} timings_ms={timings}")

    return {
        "date": date,
        "level": level,
        "games": games_list,
        "pitchData": pd_data,
        "resultsData": pr_data,
        "statLinesUpdatedAt": stat_lines_updated_at,
    }

@app.post("/api/clear-cache")
def clear(response: Response, date: str = Query(None)):
    _set_response_cache(response, "mutation")
    clear_cache(date)
    return {"status": "ok", "cleared": date or "all"}

# _aggregate_game_log_to_totals and _ip_to_thirds are imported from season.py —
# the single copies of the season-totals math and IP parsing.


def _merge_current_game_into_totals(totals, game_row, game_date):
    """Return totals with the current card game included when a cache is stale."""
    if not totals or not game_row:
        return totals
    game_pk = game_row.get("game_pk")
    existing_pks = {
        int(pk) for pk in (totals.get("game_pks") or [])
        if pk is not None
    }
    if game_pk is not None and int(game_pk) in existing_pks:
        return _merge_current_game_decision_into_totals(totals, game_row)

    last_game_date = totals.get("last_game_date") or ""
    if not existing_pks and game_date and last_game_date >= game_date:
        return totals

    merged = dict(totals)
    old_pitches = merged.get("pitches", 0) or 0
    old_pa = merged.get("pa_count", 0) or 0
    old_strikes = merged.get("strikes")
    if old_strikes is None and old_pitches > 0 and totals.get("strike_pct") is not None:
        old_strikes = (totals.get("strike_pct", 0) or 0) / 100 * old_pitches
    if old_strikes is None:
        old_strikes = 0
    merged["strikes"] = old_strikes
    game_pitches = game_row.get("pitches", 0) or 0
    game_pa = game_row.get("pa_count", 0) or 0

    merged["games"] = (merged.get("games", 0) or 0) + 1
    merged["games_started"] = (merged.get("games_started", 0) or 0) + (game_row.get("games_started", 0) or 0)
    merged["ip_thirds"] = (merged.get("ip_thirds", 0) or 0) + _ip_to_thirds(game_row.get("ip"))
    merged["ip"] = f"{merged['ip_thirds'] // 3}.{merged['ip_thirds'] % 3}"
    for key in ("hits", "bbs", "ks", "hrs", "er", "runs", "batters_faced", "whiffs", "strikes",
                "pitches", "pa_count", "two_strike_pas", "two_strike_pitches", "strikeouts_for_par"):
        merged[key] = (merged.get(key, 0) or 0) + (game_row.get(key, 0) or 0)
    if game_row.get("decision") == "W":
        merged["wins"] = (merged.get("wins", 0) or 0) + 1
    if game_row.get("decision") == "L":
        merged["losses"] = (merged.get("losses", 0) or 0) + 1
    if game_pk is not None:
        merged["game_pks"] = sorted(existing_pks | {int(game_pk)})
        if game_row.get("decision") == "W":
            merged["win_game_pks"] = sorted({
                int(pk) for pk in (merged.get("win_game_pks") or [])
                if pk is not None
            } | {int(game_pk)})
        if game_row.get("decision") == "L":
            merged["loss_game_pks"] = sorted({
                int(pk) for pk in (merged.get("loss_game_pks") or [])
                if pk is not None
            } | {int(game_pk)})
    if game_date and game_date > last_game_date:
        merged["last_game_date"] = game_date

    total_pitches = old_pitches + game_pitches
    total_pa = old_pa + game_pa
    if total_pitches > 0:
        merged["swstr_pct"] = round((merged.get("whiffs", 0) or 0) / total_pitches * 100, 2)
        merged["csw_pct"] = round(
            ((totals.get("csw_pct", 0) or 0) * old_pitches + (game_row.get("csw_pct", 0) or 0) * game_pitches)
            / total_pitches,
            1,
        )
        merged["strike_pct"] = round((merged.get("strikes", 0) or 0) / total_pitches * 100, 2)
    if total_pa > 0:
        merged["two_str_pct"] = round((merged.get("two_strike_pas", 0) or 0) / total_pa * 100, 2)
    if (merged.get("two_strike_pas", 0) or 0) > 0:
        merged["par_pct"] = round((merged.get("ks", 0) or 0) / (merged.get("two_strike_pas", 0) or 0) * 100, 2)
    return merged


def _merge_current_game_decision_into_totals(totals, game_row):
    """Patch a finalized W/L into cached totals that already include the game."""
    decision = game_row.get("decision")
    game_pk = game_row.get("game_pk")
    if decision not in ("W", "L") or game_pk is None:
        return totals
    if "win_game_pks" not in totals or "loss_game_pks" not in totals:
        return totals

    game_pk = int(game_pk)
    win_pks = {
        int(pk) for pk in (totals.get("win_game_pks") or [])
        if pk is not None
    }
    loss_pks = {
        int(pk) for pk in (totals.get("loss_game_pks") or [])
        if pk is not None
    }
    if decision == "W":
        if game_pk in win_pks and game_pk not in loss_pks:
            return totals
        win_pks.add(game_pk)
        loss_pks.discard(game_pk)
    else:
        if game_pk in loss_pks and game_pk not in win_pks:
            return totals
        loss_pks.add(game_pk)
        win_pks.discard(game_pk)

    merged = dict(totals)
    merged["win_game_pks"] = sorted(win_pks)
    merged["loss_game_pks"] = sorted(loss_pks)
    merged["wins"] = len(win_pks)
    merged["losses"] = len(loss_pks)
    return merged


def _fetch_pitcher_season_window(pitcher_id, start_date, end_date):
    """Per-pitcher Savant frame clipped to [start_date, end_date].
    Returns None when the pitcher has no data in the window (or the fetch
    failed) so callers can fall back to another source."""
    try:
        df = fetch_pitcher_season(pitcher_id, int(start_date[:4]))
    except Exception:
        return None
    if df is None or df.empty:
        return None
    if "game_date" in df.columns:
        game_dates = df["game_date"].astype(str)
        df = df[(game_dates >= start_date) & (game_dates <= end_date)]
    if df.empty:
        return None
    return df


def _compute_season_totals(pitcher_id, start_date, end_date, preloaded_df=None):
    """Compute season totals for a pitcher. Returns dict or {} if no data."""
    suffix = _season_cache_suffix(start_date, end_date)
    agg_key = f"season_totals_{pitcher_id}_s{CARD_SCHEMA_VERSION}{suffix}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    if preloaded_df is not None and not preloaded_df.empty:
        df = preloaded_df
    else:
        # Per-pitcher fast path FIRST: one pitcher's totals must never require
        # assembling the whole league's season DataFrame (78+ range_day reads
        # + pd.concat — the main serverless OOM driver). fetch_pitcher_season
        # is a single per-pitcher Savant CSV (~1-3s cold, then cached
        # in-process for an hour) and is already trusted as the source for the
        # card path's totals/game log.
        df = _fetch_pitcher_season_window(pitcher_id, start_date, end_date)
        if df is None:
            # Rare fallback (per-pitcher fetch failed or pitcher has no rows):
            # read this pitcher's rows out of the already-baked range, still a
            # day at a time. Never a league-wide Savant fetch, and returns None
            # when the range is not materialized.
            df = fetch_pitcher_rows_materialized(pitcher_id, start_date, end_date)
        if df is None:
            return {}
    if df.empty:
        return {}
    game_log = get_pitcher_game_log(df, pitcher_id)
    result = _aggregate_game_log_to_totals(game_log)
    if result:
        set_agg_cache(agg_key, result)
    return result


def _compute_mlb_full_season_totals(pitcher_id, season_year, preloaded_df=None):
    """MLB-only season totals (existing Statcast-based path)."""
    season_start = _season_start(season_year)
    end_date = _resolve_end_date("")
    return _compute_season_totals(
        pitcher_id,
        season_start,
        end_date,
        preloaded_df=preloaded_df,
    )


def _cached_season_averages_for_card(pitcher_id, season_year, date_str, game_pk):
    suffix = f"_b{date_str}_x{game_pk}"
    current_key = f"season_avg_{pitcher_id}_{season_year}{suffix}"
    fb_key = f"season_avg_fb_{pitcher_id}_{season_year}"

    current = get_agg_cache(current_key) or {}
    previous_payload = get_agg_cache(fb_key)
    if previous_payload is None:
        previous_payload = get_agg_cache(f"season_avg_fb_{pitcher_id}_{season_year}{suffix}")

    # Compute synchronously on miss. get_season_averages now uses the
    # materialized range first (one shared Redis read filterable by
    # pitcher) so this is fast — typically <500ms on a warm instance and
    # ~3-5s on a cold one. The previous background-thread design didn't
    # survive Vercel's serverless lifecycle, so cards ended up cached with
    # empty season_averages dicts that never got filled in.
    if not current:
        try:
            avgs = get_season_averages(
                pitcher_id, season_year,
                before_date=date_str, exclude_game_pk=game_pk,
            ) or {}
            current = avgs
            if avgs:
                set_agg_cache(current_key, avgs)
        except Exception as e:
            print(f"[CardExtras] current season-avg compute failed pid={pitcher_id}: {e}")

    if previous_payload is None:
        try:
            previous_season = find_previous_mlb_season(pitcher_id, season_year)
            averages = (
                get_season_averages(pitcher_id, previous_season)
                if previous_season is not None else {}
            )
            previous_payload = {"season": previous_season, "averages": averages or {}}
            if previous_payload["averages"]:
                set_agg_cache(fb_key, previous_payload)
        except Exception as e:
            print(f"[CardExtras] previous season-avg compute failed pid={pitcher_id}: {e}")
            previous_payload = None

    return {
        "current": current,
        "previous": (previous_payload or {}).get("averages", {}),
        "previous_season": (previous_payload or {}).get("season"),
    }


_season_avg_warm_lock = threading.Lock()
_season_avg_warm_inflight = set()


def _kick_season_averages_warm_async(pitcher_id, season_year, date_str, game_pk,
                                     need_current=True, need_previous=True):
    """Best-effort background warm for the card's Compare-to dropdown averages.

    On serverless instances the thread may not survive long enough to finish;
    the next card load will just kick it again. On long-lived processes
    (local/Electron) the warm sticks and subsequent cards return instantly."""
    if not need_current and not need_previous:
        return
    inflight_key = (int(pitcher_id), int(season_year), date_str, int(game_pk))
    with _season_avg_warm_lock:
        if inflight_key in _season_avg_warm_inflight:
            return
        _season_avg_warm_inflight.add(inflight_key)

    def _warm():
        try:
            suffix = f"_b{date_str}_x{game_pk}"
            if need_current:
                current_key = f"season_avg_{pitcher_id}_{season_year}{suffix}"
                if get_agg_cache(current_key) is None:
                    avgs = get_season_averages(
                        pitcher_id, season_year,
                        before_date=date_str, exclude_game_pk=game_pk,
                    )
                    if avgs:
                        set_agg_cache(current_key, avgs)
            if need_previous:
                fb_key = f"season_avg_fb_{pitcher_id}_{season_year}"
                if get_agg_cache(fb_key) is None:
                    prev_season = find_previous_mlb_season(pitcher_id, season_year)
                    averages = get_season_averages(pitcher_id, prev_season) if prev_season is not None else {}
                    payload = {"season": prev_season, "averages": averages or {}}
                    if payload["averages"]:
                        set_agg_cache(fb_key, payload)
        except Exception as e:
            print(f"[SeasonAvgWarm] background warm failed pid={pitcher_id} year={season_year}: {e}")
        finally:
            with _season_avg_warm_lock:
                _season_avg_warm_inflight.discard(inflight_key)

    threading.Thread(target=_warm, daemon=True).start()


def _build_card_extras_payload(date_str, pitcher_id, game_pk, season_df=None, pitcher_name="", prebuilt_player_page=None):
    extras_key = f"card_extras_{pitcher_id}_{date_str}_{game_pk}_s{CARD_SCHEMA_VERSION}"
    cached = get_agg_cache(extras_key)
    if cached is not None:
        return cached

    timings = {}
    started = time.perf_counter()
    season_year = int(date_str[:4])
    season_start = _season_start(season_year)
    season_end = _resolve_end_date("")
    extras = {
        "player_page": None,
        "player_page_loading": prebuilt_player_page is None and season_df is None,
        "season_averages": _cached_season_averages_for_card(pitcher_id, season_year, date_str, game_pk),
        "schedule": {"starts": []},
        "linescore": {},
    }
    timings["averages"] = round((time.perf_counter() - started) * 1000, 1)

    section_start = time.perf_counter()
    if prebuilt_player_page is not None:
        # Caller pre-fetched the player_page (the card path uses the per-pitcher
        # player_v2 cache + a per-pitcher Savant fallback, so it never has to
        # load the whole league's materialized range just to slice out one
        # pitcher). Embed it directly.
        extras["player_page"] = prebuilt_player_page
        extras["player_page_loading"] = False
    elif season_df is not None:
        # Range was preloaded — building the player_page from that df is cheap
        # (~50ms), so embed it and skip the frontend's lazy fetch.
        extras["player_page"] = _build_player_page_payload(
            pitcher_id,
            season_start,
            season_end,
            preloaded_df=season_df,
            include_extras=False,
        )
        extras["player_page_loading"] = False
    else:
        # No preloaded source — leave it null so the frontend lazy-fetches via
        # /api/player-page after the card renders. That endpoint builds from
        # per-pitcher Savant when its cache is cold, so no data is lost.
        extras["player_page"] = None
        extras["player_page_loading"] = True
    timings["player_page"] = round((time.perf_counter() - section_start) * 1000, 1)


    set_agg_cache(extras_key, extras)
    timings["total"] = round((time.perf_counter() - started) * 1000, 1)
    print(f"[CardExtras] pitcher={pitcher_id} date={date_str} game={game_pk} timings_ms={timings}")
    return extras


def _player_page_has_game_log(player_page):
    return bool((player_page or {}).get("game_log"))


def _season_totals_have_games(totals):
    return (totals or {}).get("games") is not None


def _build_boxscore_card_payload(date_str, pitcher_id, game_pk, level):
    """Box-score card for a game with no Statcast rows.

    Spec: AFL cards try the Savant card first and fall back to this when the
    game has no Statcast. In practice that's every AFL game — Savant publishes
    no fall-league Statcast (verified against 2025-10-15: 3 games scheduled,
    0 CSV rows) — so this is the AFL card, not a rare edge case.

    It carries `card_type: "boxscore"` so the frontend renders the adapted
    columns instead of looking for pitch plots that will never exist.
    """
    rows = get_level_results(date_str, level)
    row = next(
        (r for r in rows
         if r.get("pitcher_id") == int(pitcher_id) and r.get("game_pk") == int(game_pk)),
        None,
    )
    if not row:
        return None
    season_year = int(date_str[:4])
    log = get_multi_level_game_log(pitcher_id, season_year)
    return {
        "pitcher_id": int(pitcher_id),
        "game_pk": int(game_pk),
        "name": row.get("pitcher") or (get_person_info(pitcher_id) or {}).get("name", ""),
        "team": row.get("team"),
        "team_display": row.get("team_display"),
        "org": row.get("org"),
        "opponent": row.get("opponent"),
        "hand": (get_person_info(pitcher_id) or {}).get("hand", ""),
        "level": level,
        "card_type": "boxscore",
        # No pitch tracking, so these stay empty rather than absent — the card
        # component checks card_type, and empty lists keep every downstream
        # `.map` safe.
        "pitches": [],
        "pitch_table": [],
        "pitch_table_vs_l": [],
        "pitch_table_vs_r": [],
        "result": row,
        "season_totals": _aggregate_game_log_to_totals(log),
        "player_page": {"game_log": log, "info": {}},
    }


def _build_pitcher_card_payload(date_str, pitcher_id, game_pk):
    section_start = time.perf_counter()
    result = get_pitcher_card(date_str, pitcher_id, game_pk)
    if not result:
        # No Statcast for this game. If it belongs to a level we still build
        # cards for (AFL), fall back to the box-score card.
        game_level = get_game_level_map(date_str, levels=STATCAST_LEVELS).get(int(game_pk))
        if game_level:
            return _build_boxscore_card_payload(date_str, pitcher_id, game_pk, game_level)
        return result
    timings = {"base": round((time.perf_counter() - section_start) * 1000, 1)}

    season_year = int(date_str[:4])
    season_start = _season_start(season_year)
    season_end = _resolve_end_date("")
    suffix = _season_cache_suffix(season_start, season_end)
    totals_key = f"season_totals_{pitcher_id}_s{CARD_SCHEMA_VERSION}{suffix}"
    page_key = f"player_v2_{pitcher_id}_s{CARD_SCHEMA_VERSION}{suffix}"

    # Per-pitcher caches first — never load the whole league's materialized
    # range from the card path just to slice out one pitcher. Both these keys
    # are pre-warmed by the warmup-daily-{players,cards} crons for yesterday's
    # pitchers and today's probable starters; on a cold key we fall back to a
    # single per-pitcher Savant fetch (~1-3s) and cache it for the rest of the
    # day. The codebase already trusts fetch_pitcher_season as the fallback
    # source for this exact totals/game-log data.
    section_start = time.perf_counter()
    cached_totals = get_agg_cache(totals_key)
    cached_page = get_agg_cache(page_key)
    pitcher_df = None
    cached_page_stale = cached_page is not None and not _player_page_has_game_log(cached_page)
    cached_totals_stale = cached_totals is not None and not _season_totals_have_games(cached_totals)
    if cached_totals is None or cached_page is None or cached_page_stale or cached_totals_stale:
        pitcher_df = _fetch_pitcher_season_window(pitcher_id, season_start, season_end)
    timings["per_pitcher_lookup"] = round((time.perf_counter() - section_start) * 1000, 1)

    # Season totals row (box score line at the top of the card).
    section_start = time.perf_counter()
    if cached_totals is not None and not cached_totals_stale:
        totals = cached_totals
    elif pitcher_df is not None and not pitcher_df.empty:
        totals = _compute_mlb_full_season_totals(
            pitcher_id,
            season_year,
            preloaded_df=pitcher_df,
        )
    else:
        # Per-pitcher Savant returned no data — degrade rather than trigger a
        # league-range load. season_totals is allowed to be empty; the card
        # still renders the per-game data fine.
        totals = {}
    card_game = dict(result.get("result") or {})
    card_game["date"] = date_str
    totals = _merge_current_game_into_totals(totals, card_game, date_str)
    result["season_totals_mlb"] = totals
    result["season_totals"] = totals  # backward compat for cached responses
    timings["season_totals"] = round((time.perf_counter() - section_start) * 1000, 1)

    # Player page (regular-season game log + summaries) — embed so the frontend
    # doesn't have to round-trip /api/player-page.
    section_start = time.perf_counter()
    if cached_page is not None and not cached_page_stale:
        player_page = cached_page
    elif pitcher_df is not None and not pitcher_df.empty:
        player_page = _build_player_page_payload(
            pitcher_id,
            season_start,
            season_end,
            preloaded_df=pitcher_df,
            include_extras=False,
        )
        if player_page:
            set_agg_cache(page_key, player_page)
    else:
        player_page = None  # falls back to the frontend's lazy /api/player-page
    timings["player_page"] = round((time.perf_counter() - section_start) * 1000, 1)

    result.update(_build_card_extras_payload(
        date_str, pitcher_id, game_pk,
        pitcher_name=result.get("name", ""),
        prebuilt_player_page=player_page,
    ))
    print(f"[PitcherCard] pitcher={pitcher_id} date={date_str} game={game_pk} timings_ms={timings}")
    return result


# Statcast-only fields on a game-log row. Present on AAA rows (which have pitch
# tracking) and absent from every other level, where the box score is all there is.
_STATCAST_LOG_FIELDS = (
    "whiffs", "csw_pct", "par_pct", "two_str_pct", "swstr_pct",
    "pa_count", "two_strike_pas", "two_strike_pitches", "strikeouts_for_par",
    "pitch_mix", "pitch_mix_vs_l", "pitch_mix_vs_r",
)


def _merge_multi_level_game_log(pitcher_id, season_year, savant_log):
    """The Regular Season log = EVERY level's games, merged and level-tagged.

    The box-score gameLog (one call per level) is the spine, because it is the
    only source that sees AA/A+/A/R at all. AAA rows are then enriched in place
    with the Statcast-derived columns (CSW%, whiffs, PAR%, pitch mix) from the
    Savant log, matched on game_pk. Non-AAA rows simply lack those keys and the
    table renders them as em dashes.

    AFL games live inside this same list, tagged AFL — not a separate section.
    """
    base = get_multi_level_game_log(pitcher_id, season_year)
    if base:
        # Non-Statcast rows get CSW%/SwStr%/batted-ball rates derived from each
        # game's play-by-play. Bounded so a cold log doesn't pull 20 feeds.
        try:
            base = enrich_log_with_pitch_metrics(base, pitcher_id, deadline=time.time() + 20)
        except Exception as e:
            print(f"[PlayerPage] pitch-metric enrich failed for {pitcher_id}: {e}")
    if not base:
        # No box-score log at all (very early season, API hiccup) — fall back to
        # whatever Savant gave us rather than showing an empty page.
        return savant_log or []
    by_pk = {r.get("game_pk"): r for r in (savant_log or []) if r.get("game_pk") is not None}
    merged = []
    for row in base:
        out = dict(row)
        sav = by_pk.get(row.get("game_pk"))
        if sav:
            for key in _STATCAST_LOG_FIELDS:
                if key in sav:
                    out[key] = sav[key]
            # Savant counts pitches per tracked pitch; prefer the box score's
            # official pitch count but keep Savant's when the box score has none.
            if not out.get("pitches") and sav.get("pitches"):
                out["pitches"] = sav["pitches"]
        merged.append(out)
    return merged


def _tag_info_current_team(info, pitcher_id):
    """Stamp the player-page header's `info` with the pitcher's current club.

    Best-effort by design: the header already renders from the game log, so a
    transaction-feed hiccup should cost the page its current-club tag and
    nothing else.
    """
    try:
        row = {"pitcher_id": int(pitcher_id), "teams": info.get("teams") or []}
        tag_current_team([row])
    except Exception as e:
        print(f"[PlayerPage] current-team lookup failed for {pitcher_id}: {e}")
        return info
    info["teams"] = row.get("teams") or info.get("teams") or []
    if row.get("team"):
        info["current_team"] = row["team"]
    elif info["teams"]:
        info["current_team"] = info["teams"][0]
    if row.get("org"):
        info["current_org"] = row["org"]
    if row.get("team_name"):
        info["current_team_name"] = row["team_name"]
    if row.get("mlb_roster"):
        info["on_mlb_roster"] = True
    return info


def _build_player_page_payload(pitcher_id, start_date, end_date, preloaded_df=None, include_extras=True, pitcher_season_fallback=False):
    empty = {
        "info": {}, "pitch_summary": [], "pitch_summary_vs_l": [],
        "pitch_summary_vs_r": [], "results_summary": {}, "game_log": [],
    }
    if preloaded_df is not None:
        df = preloaded_df
    else:
        # Per-pitcher, never the league. This used to fall back to
        # fetch_date_range(start, end) — a whole-season LIVE Savant pull to
        # render one player's page. No caller reaches that today (every one
        # passes preloaded_df or pitcher_season_fallback), which is exactly why
        # it was a landmine rather than an outage: it would have gone off the
        # first time someone added a caller without one of those.
        df = _fetch_pitcher_season_window(pitcher_id, start_date, end_date)
    # Spec: the player page's Savant data table is AAA ONLY. fetch_* returns
    # every Statcast level, so AFL rows are dropped here before any pitch
    # summary is computed — otherwise a fall-league outing would quietly land
    # in a pitcher's regular-season pitch mix.
    if df is not None and not df.empty and "level" in df.columns:
        df = df[df["level"] == "AAA"]
    result = compute_player_page(df, pitcher_id) if df is not None and not df.empty else dict(empty)
    if (
        pitcher_season_fallback
        and not (result or {}).get("game_log")
        and preloaded_df is not None
    ):
        fallback_df = _fetch_pitcher_season_window(pitcher_id, start_date, end_date)
        result = compute_player_page(fallback_df, pitcher_id) if fallback_df is not None and not fallback_df.empty else dict(empty)
    if result is None:
        result = dict(empty)
    season_year = int(start_date[:4])

    # ── Multi-level log + AAA-only Savant tables ──
    # `result` so far is Savant-derived, i.e. AAA (+ AFL) ONLY. Replace its log
    # with the merged all-levels one, and decide whether the Savant tables are
    # shown at all.
    result["game_log"] = _merge_multi_level_game_log(
        pitcher_id, season_year, result.get("game_log") or []
    )
    result["results_summary"] = _aggregate_game_log_to_totals(result["game_log"])

    # A pitcher with no AAA games has no Savant rows, so `info` (name, hand,
    # teams) came back empty — fill it from the people endpoint and the log.
    info = result.get("info") or {}
    if not info.get("name"):
        person = get_person_info(pitcher_id)
        info = {
            **info,
            "pitcher_id": int(pitcher_id),
            "name": person.get("name") or info.get("name") or "",
            "hand": person.get("hand") or info.get("hand") or "",
        }
    if not info.get("teams"):
        # Most recent affiliate first, deduped, in reverse chronological order.
        seen, teams = set(), []
        for g in reversed(result["game_log"]):
            t = g.get("team")
            if t and t not in seen:
                seen.add(t)
                teams.append(t)
        info["teams"] = teams
    # Where he is NOW, which is not necessarily where he last pitched — a
    # deadline trade moves a player weeks before his first game for the new
    # org, and never at all if he is hurt. tag_current_team reorders `teams`
    # so the current club leads and fills team/org/team_name in place.
    _tag_info_current_team(info, pitcher_id)
    result["info"] = info

    aaa_games = [g for g in result["game_log"] if g.get("level") == "AAA"]
    result["has_aaa_data"] = bool(aaa_games)
    result["levels_played"] = sorted(
        {g.get("level") for g in result["game_log"] if g.get("level")},
        key=_level_sort_key,
    )
    # Current level = wherever the LAST game was played. Never rosters, never
    # active status — the spec is explicit that last game played is the rule.
    result["current_level"] = result["game_log"][-1].get("level") if result["game_log"] else None
    if not aaa_games:
        # Spec: hide the Savant data table entirely — no empty state, no note.
        # Dropping the keys (rather than sending []) is what makes it absent
        # from the payload, so the frontend has nothing to render.
        for key in ("pitch_summary", "pitch_summary_vs_l", "pitch_summary_vs_r",
                    "per_game_summaries", "pitches"):
            result.pop(key, None)

    totals = _compute_mlb_full_season_totals(
        pitcher_id,
        season_year,
        preloaded_df=df if pitcher_season_fallback else preloaded_df,
    )
    result["season_totals_mlb"] = totals
    result["season_totals"] = totals  # backward compat
    if include_extras:
        previous_payload = get_agg_cache(f"season_avg_fb_{pitcher_id}_{season_year}")
        if previous_payload is None:
            previous_season = find_previous_mlb_season(pitcher_id, season_year)
            averages = get_season_averages(pitcher_id, previous_season) if previous_season is not None else {}
            previous_payload = {"season": previous_season, "averages": averages or {}}
            if previous_payload["averages"]:
                set_agg_cache(f"season_avg_fb_{pitcher_id}_{season_year}", previous_payload)
        result["season_averages"] = {
            "previous": (previous_payload or {}).get("averages", {}),
            "previous_season": (previous_payload or {}).get("season"),
        }
    return result


def _warm_player_page_cache_for_pitchers(
    pitcher_ids,
    start_date,
    end_date,
    preloaded_df=None,
    deadline=None,
):
    """Overwrite stable player-page cache entries for a small pitcher set.

    `pitcher_ids` is consumed IN THE ORDER GIVEN (deduped, first occurrence
    wins), so a caller can put the pitchers it cares about most at the front
    and have them survive a budget cut. It used to sort by pitcher id, which
    is effectively random with respect to level and role — under a deadline
    that spent the budget on whoever happened to have a low id.

    Returns a dict so the caller can splat it into a response body.
    """
    suffix = _season_cache_suffix(start_date, end_date)
    warmed = 0
    skipped = 0
    budget_hit = False

    ordered, seen = [], set()
    for p in (pitcher_ids or []):
        if p is None:
            continue
        pid = int(p)
        if pid not in seen:
            seen.add(pid)
            ordered.append(pid)

    for pid in ordered:
        if deadline is not None and time.time() >= deadline:
            budget_hit = True
            break
        agg_key = f"player_v2_{pid}_s{CARD_SCHEMA_VERSION}{suffix}"
        try:
            result = _build_player_page_payload(
                pid,
                start_date,
                end_date,
                preloaded_df=preloaded_df,
            )
            if result is not None:
                set_agg_cache(agg_key, result)
                warmed += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"[PlayerPageWarm] Error computing player {pid}: {e}")
            skipped += 1
    return {"warmed": warmed, "skipped": skipped, "budget_hit": budget_hit,
            "requested": len(ordered)}


def _pitcher_half_inning_settled(game_pk, pitcher_id):
    """Has the half-inning this pitcher LAST pitched in finished?

    Returns True when:
      - the game is final, OR
      - the linescore has a play in a half-inning after the pitcher's last one
        (which means inherited runners can no longer score on his line).

    Conservatively returns False if we can't determine state — we'd rather
    delay re-warming past cards than touch them while the inning is still in
    progress and a reliever can still cost the previous pitcher earned runs.
    """
    try:
        ls = get_game_linescore(int(game_pk))
    except Exception:
        return False
    if not ls or not isinstance(ls, dict):
        return False
    if ls.get("is_final"):
        return True
    pexit = (ls.get("pitcher_exit") or {}).get(str(int(pitcher_id)))
    if not pexit:
        return False
    last_inn = pexit.get("last_inning")
    last_top = pexit.get("last_top")
    if last_inn is None or last_top is None:
        return False
    for half in (ls.get("plays") or []):
        h_inn = half.get("inning", 0) or 0
        h_top = half.get("top", True)
        if h_inn > last_inn:
            return True
        if h_inn == last_inn and h_top != last_top:
            return True
    return False


def _collect_past_game_triples(df, pid_set, today, out):
    """Add (pitcher, game_date, game_pk) for these pitchers' games BEFORE today.

    Written to be called either on one day's frame (the streaming path) or on a
    whole preloaded frame — it only ever reads three columns and appends to a
    set, so both give the same result.
    """
    if df is None or df.empty:
        return
    if not {"pitcher", "game_date", "game_pk"}.issubset(df.columns):
        return
    rows = df[df["pitcher"].isin(pid_set) & (df["game_date"].astype(str) < today)]
    for pid, game_date, game_pk in zip(rows["pitcher"], rows["game_date"], rows["game_pk"]):
        out.add((int(pid), str(game_date)[:10], int(game_pk)))


def _rewarm_past_cards_for_pitchers(pitcher_ids, today, season_df=None, deadline=None):
    """Rebuild card_* entries for these pitchers' PRIOR games.

    invalidate_pitcher_related_caches deletes every card_*_{pid}_* key when a
    pitcher's state shifts (typically because they just finished a game and
    their season totals + game log changed). Without this re-warm, the next
    user click on any of those past cards pays a 5-30s cold rebuild.

    Time-budgeted via `deadline` (epoch seconds): stops early so we don't
    blow past Vercel's 60s function timeout. Whatever isn't done this run
    gets picked up by the next warmup-live-cards tick (every 10 min during
    game hours).
    """
    pid_set = {int(p) for p in (pitcher_ids or []) if p is not None}
    if not pid_set:
        return {"warmed": 0, "skipped": 0, "budget_hit": False}

    # All this needs from the season is three columns for a handful of
    # pitchers. It used to materialize the entire league's season frame to get
    # them; now the no-preloaded-frame path folds day by day and keeps only the
    # matching (pitcher, date, game) triples, so nothing scales with league
    # size. A game_pk belongs to exactly one game_date, so per-day collection
    # into a set dedupes identically to the old drop_duplicates.
    triples = set()
    if season_df is not None:
        if season_df.empty or "pitcher" not in season_df.columns:
            return {"warmed": 0, "skipped": len(pid_set), "budget_hit": False}
        _collect_past_game_triples(season_df, pid_set, today, triples)
    else:
        season_start = _season_start(today[:4])
        season_end = _resolve_end_date("")
        complete = fold_range_materialized(
            season_start, season_end,
            lambda day_df: _collect_past_game_triples(day_df, pid_set, today, triples),
        )
        if not complete:
            return {"warmed": 0, "skipped": len(pid_set), "budget_hit": False}

    if not triples:
        return {"warmed": 0, "skipped": 0, "budget_hit": False}

    # game_date DESC, then pitcher ASC — same order the old sort_values gave.
    # Python's sort is stable, so the secondary key is applied first. game_pk
    # is in the minor key purely to keep the order deterministic.
    ordered = sorted(triples, key=lambda t: (t[0], t[2]))
    ordered.sort(key=lambda t: t[1], reverse=True)

    warmed = 0
    skipped = 0
    budget_hit = False
    for pid, game_date, gpk in ordered:
        if deadline is not None and time.time() > deadline:
            budget_hit = True
            break
        agg_key = f"card_{game_date}_{pid}_{gpk}_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
        if get_agg_cache(agg_key) is not None:
            skipped += 1
            continue
        try:
            card = _build_pitcher_card_payload(game_date, pid, gpk)
            # _build_pitcher_card_payload's own cache-write guard (set in
            # /api/pitcher-card) skips degraded builds; replicate that here.
            if card and not card.get("player_page_loading"):
                set_agg_cache(agg_key, card)
                warmed += 1
            else:
                skipped += 1
        except Exception as e:
            print(f"[RewarmPastCards] Error {game_date}/{pid}/{gpk}: {e}")
            skipped += 1

    return {"warmed": warmed, "skipped": skipped, "budget_hit": budget_hit}


@app.get("/api/pitcher-card")
def pitcher_card(response: Response, date: str = Query(...), pitcher_id: int = Query(...), game_pk: int = Query(...)):
    _set_response_cache(response, _cache_scope_for_date(date))
    # Include override version in cache key so reclassifications always bust the cache
    agg_key = f"card_{date}_{pitcher_id}_{game_pk}_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    result = _build_pitcher_card_payload(date, pitcher_id, game_pk)
    if result:
        # Don't persist degraded cards. Two failure modes to catch:
        #   1. player_page failed to build (no season_df) → player_page_loading
        #   2. season_totals_mlb came back empty (no materialized range AND no
        #      prior season_totals_* cache hit) → totals.games is None
        # Any of these gets cached as a permanent empty until invalidated, so
        # we just skip the set_agg_cache call and let the next request retry.
        is_degraded = bool(result.get("player_page_loading"))
        if not is_degraded:
            totals = result.get("season_totals_mlb") or {}
            if not totals or totals.get("games") is None:
                is_degraded = True
        if not is_degraded:
            set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitcher-season-totals")
def pitcher_season_totals(response: Response, pitcher_id: int = Query(...), start_date: str = Query(SEASON_START), end_date: str = Query("")):
    """Return aggregated season totals for a pitcher's box score row."""
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    result = _compute_season_totals(pitcher_id, start_date, end_date)
    if result:
        return result
    # Only the boolean matters here — "is the range baked, or should the client
    # be told to wait?". Loading the season to decide that was the expensive way
    # to say "no".
    if not range_is_materialized(start_date, end_date):
        return _loading_response(response, start_date, end_date)
    return {}

@app.get("/api/game-linescore")
def game_linescore(response: Response, game_pk: int = Query(...)):
    _set_response_cache(response, "live")
    return get_game_linescore(game_pk)

@app.get("/api/season-averages")
def season_averages(
    response: Response,
    pitcher_id: int = Query(...),
    season: int = Query(...),
    before_date: str = Query(None),
    exclude_game_pk: int = Query(None),
    auto_fallback: bool = Query(False),
):
    _set_response_cache(response, _cache_scope_for_date(before_date) if before_date else "past")
    # Cache key includes optional filters so season-to-date and plain-season
    # results don't collide.
    suffix = ""
    if before_date:
        suffix += f"_b{before_date}"
    if exclude_game_pk is not None:
        suffix += f"_x{exclude_game_pk}"

    # auto_fallback: `season` is the CURRENT year; walk back year-by-year until
    # we find a prior season with data.
    if auto_fallback:
        fb_key = f"season_avg_fb_{pitcher_id}_{season}{suffix}"
        cached = get_agg_cache(fb_key)
        if cached is not None:
            return cached
        resolved_season = find_previous_mlb_season(pitcher_id, season)
        if resolved_season is None:
            return {"season": None, "averages": {}}
        averages = get_season_averages(
            pitcher_id,
            resolved_season,
            before_date=before_date,
            exclude_game_pk=exclude_game_pk,
        )
        payload = {"season": resolved_season, "averages": averages or {}}
        if averages:
            set_agg_cache(fb_key, payload)
        return payload

    agg_key = f"season_avg_{pitcher_id}_{season}{suffix}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    result = get_season_averages(
        pitcher_id,
        season,
        before_date=before_date,
        exclude_game_pk=exclude_game_pk,
    )
    if result:
        set_agg_cache(agg_key, result)
    return result

@app.get("/api/pitchers-search")
def pitchers_search(response: Response, q: str = Query(""), start_date: str = Query(SEASON_START), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    # Fast, non-blocking fetch: serves a cached/partial list immediately and
    # warms the full list in the background instead of materializing the whole
    # season DataFrame on the request path.
    pitchers = _merged_pitcher_directory(start_date, end_date)
    if q and pitchers:
        # Accent-insensitive substring match — "emerson" should find "Émerson"
        # and vice versa. Uses the name_norm precomputed at list-build time so
        # we don't re-strip accents on every name on every keystroke.
        q_norm = _strip_accents(q.lower())
        pitchers = [
            p for p in pitchers
            if q_norm in (p.get("name_norm") or _strip_accents((p.get("name") or "").lower()))
        ]
    return pitchers[:20]

def _merged_pitcher_directory(start_date, end_date):
    """Searchable directory covering EVERY level.

    Two sources, deliberately:
      - the Savant directory (AAA + AFL) carries the rich ranking signals the
        search UI sorts on — real pitch counts and a last-appearance date;
      - the affiliate sweep covers AA/A+/A/R, who have player pages but no
        Statcast and would otherwise be unsearchable.

    Savant wins on conflict for the fields it has, since its pitch counts are
    per-pitch-accurate and its `hand` is real. Level/org tags ride along from
    the sweep so results can show "(CLE, AA)".

    The sweep also carries the current-club mapping (`team`/`org`), resolved
    from the transaction feed rather than from where a pitcher last appeared —
    which is the only way a deadline trade shows up before the player's first
    game for his new org. Savant rows must not clobber it: its `teams` are
    appended to the season history, never promoted over the current club.
    """
    savant = fetch_pitchers_directory(start_date, end_date) or []
    try:
        milb = get_all_milb_pitchers(int(start_date[:4])) or []
    except Exception as e:
        print(f"[Directory] all-levels sweep failed, serving Savant-only: {e}")
        return [_with_fallback_team(dict(r)) for r in savant]

    merged = {int(r["pitcher_id"]): dict(r) for r in milb}
    for r in savant:
        pid = int(r["pitcher_id"])
        base = merged.get(pid)
        if base is None:
            # Savant-only (no season-stats row at any affiliate). No transaction
            # mapping for him, so the head of his recency-ordered team list is
            # the best available answer.
            merged[pid] = _with_fallback_team(dict(r))
            continue
        # Savant's signals are better where present; keep the sweep's tags.
        base.update({
            "name": r.get("name") or base.get("name"),
            "name_norm": r.get("name_norm") or base.get("name_norm"),
            "hand": r.get("hand") or base.get("hand"),
            "pitches": r.get("pitches") or base.get("pitches"),
            "last_date": r.get("last_date") or base.get("last_date"),
        })
        for t in (r.get("teams") or []):
            if t and t not in base.get("teams", []):
                base.setdefault("teams", []).append(t)
        _with_fallback_team(base)
    return sorted(merged.values(), key=lambda r: r.get("name") or "")


def _with_fallback_team(row):
    """Guarantee a `team`/`org` on a directory row.

    Every row the UI renders should name a club. When the transaction feed
    couldn't resolve one (a lookup failure, or a player the people endpoint
    doesn't return), fall back to the first entry of the recency-ordered
    season history — stale after a trade, but never blank.
    """
    if not row.get("team"):
        teams = row.get("teams") or []
        if teams:
            row["team"] = teams[0]
    if not row.get("org"):
        orgs = row.get("orgs") or []
        if orgs:
            row["org"] = orgs[0]
    return row


@app.get("/api/pitchers-directory")
def pitchers_directory(response: Response, start_date: str = Query(SEASON_START), end_date: str = Query("")):
    """Full lightweight pitcher directory for client-side search.

    Covers every level, not just the Statcast ones — a AA-only pitcher has a
    player page and must be findable. The list is stable across the season, so
    the UI fetches it once and filters/ranks locally. Each record carries
    name_norm (accent-stripped) plus ranking signals (pitches, last_date) and
    level/org tags.
    """
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    return _merged_pitcher_directory(start_date, end_date)

@app.get("/api/resolve-pitcher")
def resolve_pitcher(response: Response, name: str = Query(...), start_date: str = Query(SEASON_START), end_date: str = Query("")):
    """Resolve a pitcher name to a pitcher_id from cached data. Uses accent-insensitive matching."""
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    pitchers = _merged_pitcher_directory(start_date, end_date)
    if not pitchers:
        return {"pitcher_id": None, "name": name}

    name_norm = _strip_accents(name).lower()
    # Try exact match first, then accent-insensitive
    for p in pitchers:
        if p["name"].lower() == name.lower():
            return {"pitcher_id": p["pitcher_id"], "name": p["name"]}
    for p in pitchers:
        if _strip_accents(p["name"]).lower() == name_norm:
            return {"pitcher_id": p["pitcher_id"], "name": p["name"]}
    return {"pitcher_id": None, "name": name}

@app.get("/api/team-pitchers")
def team_pitchers(response: Response, team: str = Query(...), start_date: str = Query(SEASON_START), end_date: str = Query(""), view: str = Query("results")):
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    # Check aggregation cache first
    agg_key = f"team_{team}_{view}_{start_date}_{end_date}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    # Ledger fast path: season-through-yesterday is precomputed as running
    # accumulators, so this is one Redis read + a finalize, with today's cached
    # day frame layered on top. Only for the canonical season window — the
    # ledger has exactly one high-water mark, so any other window folds below.
    if start_date == SEASON_START and _is_today_str(end_date):
        try:
            rows = ledger.team_season_rows(team, view, today_df=fetch_date(end_date))
        except Exception as e:
            print(f"[TeamPitchers] ledger path failed: {e}")
            rows = None
        if rows is not None:
            result = tag_mlb_experience(rows)
            if result:
                set_agg_cache(agg_key, result)
            return result

    # Streamed a day at a time rather than materializing the whole season into
    # one frame first — see fold_range_materialized. Only this team's rows are
    # ever accumulated, so peak memory is one day, not ~612k pitch rows.
    pitch_view = view == "pitch-data"
    acc = new_pitch_data_accumulator() if pitch_view else new_results_accumulator()

    def fold(day_df):
        if "pitcher_team" in day_df.columns:
            day_df = day_df[day_df["pitcher_team"] == team]
        if day_df.empty:
            return
        if pitch_view:
            accumulate_pitch_data(acc, day_df)
        else:
            accumulate_pitcher_results(acc, day_df)

    if not fold_range_materialized(start_date, end_date, fold):
        return _loading_response(response, start_date, end_date)

    result = tag_mlb_experience(
        finalize_pitch_data(acc) if pitch_view else finalize_pitcher_results(acc)
    )
    if not result:
        return []
    set_agg_cache(agg_key, result)
    return result

# How long the Rehab view may spend pulling live feeds for its pitch metrics.
# Past it, the remaining rows serve cache-only and their rate columns stay
# blank rather than the whole page timing out; per-game metrics cache for 30
# days, so the next rebuild fills in whatever this pass skipped.
_REHAB_ENRICH_BUDGET_S = 40


def _rehab_starts_payload(days=14):
    """MLB pitchers on an injured list who have made a minor-league START recently.

    Shared by the endpoint and the cron warm below. Cache-first: a hit is a
    dict lookup, so callers may invoke this speculatively.

    The obvious implementation — walk every IL pitcher's game log — is ~6 calls
    per player across levels. This funnels instead, cheapest filter first:

      1. MLB rosters (30 calls, hourly cache) -> pitchers with an IL/RA status
      2. one byDateRange call PER LEVEL (6) -> everyone with a start in the window
      3. intersect: an IL pitcher who started in the minors is a rehab start
      4. require MLB experience, so an injured PROSPECT on the org's full roster
         isn't mistaken for a rehabbing big leaguer
      5. only now, for that handful, pull game logs for the exact start dates

    Steps 1-2 are shared and cached, so the per-player cost lands on a list that
    is typically a few dozen long rather than several hundred.
    """
    days = max(1, min(int(days or 14), 45))
    today = _now_et().date()
    start_date = (today - timedelta(days=days)).isoformat()
    end_date = today.isoformat()
    season = today.year

    cache_key = f"rehab_starts_{days}_{end_date}_s{CARD_SCHEMA_VERSION}m{_METRICS_VERSION}"
    cached = get_agg_cache(cache_key)
    if cached is not None:
        return cached

    il = get_il_pitchers(season)
    if not il:
        return {"start_date": start_date, "end_date": end_date, "pitchers": []}

    # Which levels did each IL pitcher start at during the window?
    started_at = {}   # {pitcher_id: [level, ...]}
    for code in LEVEL_ORDER:
        sport_id = LEVELS[code]["sport_id"]
        for pid in get_starters_in_range(sport_id, start_date, end_date):
            if pid in il:
                started_at.setdefault(pid, []).append(code)
    if not started_at:
        payload = {"start_date": start_date, "end_date": end_date, "pitchers": []}
        set_agg_cache(cache_key, payload)
        return payload

    # An injured prospect is on the org's full roster too — only a pitcher who
    # has actually debuted in the majors is on a rehab assignment.
    exp = get_mlb_experience(list(started_at.keys()))
    candidates = {pid: lv for pid, lv in started_at.items() if exp.get(pid)}

    rows = []
    enrich_deadline = time.time() + _REHAB_ENRICH_BUDGET_S

    def _attach_pitch_metrics(row, pid):
        """SwStr%/CSW%/velocity for the one start the table renders.

        The box-score gameLog carries none of these, so they come from the
        game's play-by-play feed. Only the LATEST start is enriched — that is
        the only row the view shows — which keeps this at one feed per
        rehabbing pitcher rather than one per start, and every feed is cached
        by game_pk for 30 days.
        """
        game_pk = row.get("game_pk")
        if not game_pk:
            return
        allow_fetch = time.time() < enrich_deadline
        try:
            metrics = (get_game_pitch_metrics(game_pk, allow_fetch) or {}).get(int(pid))
        except Exception as e:
            print(f"[RehabStarts] pitch metrics failed for game {game_pk}: {e}")
            return
        if not metrics:
            return
        row["csw_pct"] = metrics.get("csw_pct")
        row["swstr_pct"] = metrics.get("swstr_pct")
        row["whiffs"] = metrics.get("whiffs")
        # Velocity exists only where the level is pitch-tracked. Gating on the
        # level rather than on the feed keeps the column honest: a stray reading
        # in a Rookie-ball feed would otherwise print as a real average.
        if row.get("level") in STATCAST_LEVELS:
            row["avg_velo"] = metrics.get("avg_velo")
            # The Velo column reads the primary fastball, not the all-pitch
            # mean: "is his fastball back" is the question this view exists to
            # answer, and an all-pitch mean moves with pitch mix instead.
            row["fb_velo"] = metrics.get("fb_velo")
            row["fb_pitch"] = metrics.get("fb_pitch")
            row["fb_count"] = metrics.get("fb_count")

    def _starts_for(pid, levels):
        found = []
        for code in levels:
            for g in (_gamelog_for_level(pid, season, code) or []):
                if g.get("date", "") < start_date or not g.get("games_started"):
                    continue
                found.append(g)
        if found:
            found.sort(key=lambda g: g.get("date") or "")
            _attach_pitch_metrics(found[-1], pid)
        return found

    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_starts_for, pid, lv): pid for pid, lv in candidates.items()}
        for f in as_completed(futures):
            pid = futures[f]
            try:
                starts = f.result() or []
            except Exception as e:
                print(f"[RehabStarts] game log failed for {pid}: {e}")
                continue
            if not starts:
                continue
            starts.sort(key=lambda g: g.get("date") or "")
            latest = starts[-1]
            info = il.get(pid) or {}
            rows.append({
                **latest,
                "pitcher_id": pid,
                "pitcher": info.get("name") or (get_person_info(pid) or {}).get("name", ""),
                "il_status": info.get("status"),
                "il_status_code": info.get("status_code"),
                "rehab_starts": len(starts),
                "start_dates": [g.get("date") for g in starts],
                "mlb_exp": True,
            })

    # Most recent rehab start first — that is the question this view answers.
    rows.sort(key=lambda r: (r.get("date") or "", r.get("pitcher") or ""), reverse=True)
    payload = {"start_date": start_date, "end_date": end_date, "pitchers": rows}
    set_agg_cache(cache_key, payload)
    return payload


@app.get("/api/rehab-starts")
def rehab_starts(response: Response, days: int = Query(14)):
    _set_response_cache(response, "live")
    return _rehab_starts_payload(days)


def _org_agg_key(org, start_date, end_date):
    return f"org_{org}_s{CARD_SCHEMA_VERSION}_{start_date}_{end_date}"


def _overlay_statcast_on_block(block, statcast_rows, pitch_rows):
    """Merge Statcast season extras onto an AAA block's box-score base rows.

    The box rows stay the base ON PURPOSE: they carry the official season line
    (ERA, WHIP, GS, GO/AO, Strike%, batters faced) that the Statcast fold does
    not track. The overlay adds only what box scores cannot know — per-pitch
    rates and the primary fastball's flight — so every level shares one row
    shape and AAA simply has more of it filled in.
    """
    by_pid = {int(r["pitcher_id"]): r for r in (statcast_rows or []) if r.get("pitcher_id") is not None}
    fb_by_pid = {}
    for r in (pitch_rows or []):
        if r.get("pitcher_id") is None:
            continue
        pt = r.get("pitch_type")
        # Four-seamer preferred, sinker fallback — same rule as the Rehab Velo
        # column. Cutters/splitters deliberately excluded.
        rank = 0 if pt in ("FF", "FA") else 1 if pt in ("SI", "FT") else None
        if rank is None:
            continue
        pid = int(r["pitcher_id"])
        cur = fb_by_pid.get(pid)
        if cur is None or rank < cur[0]:
            fb_by_pid[pid] = (rank, r)
    matched = 0
    for row in block["rows"]:
        try:
            pid = int(row.get("pitcher_id"))
        except (TypeError, ValueError):
            continue
        sc = by_pid.get(pid)
        if sc:
            matched += 1
            pitches = sc.get("pitches") or 0
            row["csw_pct"] = sc.get("csw_pct")
            row["swstr_pct"] = round(sc["whiffs"] / pitches * 100, 1) if pitches else None
        fb = fb_by_pid.get(pid)
        if fb:
            row["velo"] = fb[1].get("velo")
            row["ext"] = fb[1].get("ext")
            row["ivb"] = fb[1].get("ivb")
    return matched > 0


def _build_org_page_payload(org, start_date, end_date, aaa_rows_by_team=None):
    """Build one org's affiliate blocks. Returns (payload, statcast_pending).

    `aaa_rows_by_team` lets a caller that has ALREADY folded the season supply
    the AAA rows instead of making this function fold again. That is not a
    micro-optimisation: the fold walks every day in the range, so warming all
    30 orgs without it would mean 30 separate full-season passes.
    warmup-daily-2 runs exactly one pass for its per-team aggregates and hands
    the result here.
    """
    affiliates = affiliates_for_org(org)
    if not affiliates:
        return {"org": org, "affiliates": []}, False

    # Every affiliate — INCLUDING AAA — is built from the per-team season
    # endpoint, one request each. That is the whole page's data.
    #
    # This used to require the materialized Statcast range for AAA and 202 when
    # it was missing, which made team pages unloadable whenever materialization
    # was behind (and permanently unloadable once a timed-out job left its
    # status stuck on "running"). A team page must not be hostage to a
    # season-wide cache: it now always renders, and AAA is UPGRADED in place
    # with Statcast columns only if the range happens to be ready.
    season_year = int(start_date[:4])
    blocks = []
    for meta in affiliates:
        code = meta["level"]
        rows = tag_mlb_experience(get_team_season_pitchers(meta["team_id"], code, season_year))
        blocks.append({
            "level": code,
            "team_id": meta["team_id"],
            "team": meta["abbrev"],
            "team_name": meta["name"],
            "team_display": team_display_name(team_id=meta["team_id"], level=code),
            # Statcast columns are only meaningful once the AAA upgrade below
            # succeeds; otherwise the block renders the box-score column set.
            "statcast": False,
            "rows": rows,
        })

    # "Last Game" for every row — one batched hydrate call per affiliate,
    # cached alongside the season rows. Failure degrades to a hyphen column,
    # never a failed page.
    for block in blocks:
        try:
            last = get_team_last_games(
                block["team_id"], block["level"], season_year,
                [r.get("pitcher_id") for r in block["rows"]],
            )
        except Exception as e:
            print(f"[OrgPage] last-game lookup failed for {block['team']}: {e}")
            last = {}
        for r in block["rows"]:
            r["last_game"] = last.get(str(r.get("pitcher_id")))

    # Season fastball flight (velo/ext/ivb) for the AAA overlay. Ledger first;
    # the per-team agg key warmup-daily-2 writes is the fallback. None is fine —
    # those three columns just render as hyphens until the ledger catches up.
    def _aaa_pitch_rows(team):
        try:
            rows = ledger.team_season_rows(team, "pitch-data")
            if rows is not None:
                return rows
        except Exception as e:
            print(f"[OrgPage] pitch-data ledger read failed for {team}: {e}")
        return get_agg_cache(f"team_{team}_pitch-data_{start_date}_{end_date}")

    # Optional AAA upgrade: richer per-pitch columns (CSW%, whiffs) when the
    # season range is materialized. Never blocks the response.
    #
    # Streamed per day (see fold_range_materialized) with one accumulator per
    # AAA affiliate, so the whole season is never resident. Previously this
    # built the entire league-wide season frame just to slice a few teams out
    # of it — on a page that treats the result as optional.
    aaa_blocks = [b for b in blocks if b["level"] == "AAA"]
    # Set when the AAA block SHOULD carry Statcast columns but could not get
    # them this time. The payload is still correct and still worth returning —
    # it just must not be CACHED, because the agg TTL would then freeze
    # box-score columns onto the page for an hour over a gap that typically
    # repairs itself in a couple of minutes. Same rule /api/pitcher-card uses
    # for degraded payloads.
    statcast_pending = False
    if aaa_blocks and aaa_rows_by_team is None and _is_today_str(end_date) \
            and start_date == SEASON_START:
        # Ledger fast path — same one-read shape as team pages. None when the
        # ledger is behind, in which case the fold below decides as before.
        try:
            aaa_rows_by_team = ledger.aaa_rows_for_teams(
                [b["team"] for b in aaa_blocks], today_df=fetch_date(end_date))
        except Exception as e:
            print(f"[OrgPage] ledger path failed: {e}")
            aaa_rows_by_team = None
    if aaa_blocks and aaa_rows_by_team is not None:
        # Rows already folded by the caller — no range pass at all.
        for block in aaa_blocks:
            block["statcast"] = _overlay_statcast_on_block(
                block, aaa_rows_by_team.get(block["team"]), _aaa_pitch_rows(block["team"]))
    elif aaa_blocks:
        accs = {b["team"]: new_results_accumulator() for b in aaa_blocks}

        def fold(day_df):
            if "level" in day_df.columns:
                day_df = day_df[day_df["level"] == "AAA"]
            if day_df.empty or "pitcher_team" not in day_df.columns:
                return
            for team_abbrev, tdf in day_df.groupby("pitcher_team"):
                if team_abbrev in accs and not tdf.empty:
                    accumulate_pitcher_results(accs[team_abbrev], tdf)

        try:
            complete = fold_range_materialized(start_date, end_date, fold)
        except Exception as e:
            print(f"[OrgPage] materialized range lookup failed: {e}")
            complete = False
        if complete:
            for block in aaa_blocks:
                block["statcast"] = _overlay_statcast_on_block(
                    block, finalize_pitcher_results(accs[block["team"]]),
                    _aaa_pitch_rows(block["team"]))
        else:
            statcast_pending = True
            # Nothing else re-queues a range that lapses mid-day: the 5-minute
            # cron only drains a queue, and the job that fills it runs once at
            # 07:40. Without this an org page can sit on box-score columns
            # until tomorrow. Cheap — queue_range_materialization answers from
            # the marker set and returns immediately when a job is already
            # running, so repeat views during a gap do not pile up work.
            try:
                queue_range_materialization(start_date, end_date)
            except Exception as e:
                print(f"[OrgPage] could not queue materialization: {e}")

    return {"org": org, "affiliates": blocks}, statcast_pending


def _org_page_cached(org, start_date, end_date, aaa_rows_by_team=None):
    """Get-or-build one org payload, applying the don't-cache-degraded rule."""
    agg_key = _org_agg_key(org, start_date, end_date)
    cached = get_agg_cache(agg_key)
    if cached is not None:
        return cached
    payload, statcast_pending = _build_org_page_payload(
        org, start_date, end_date, aaa_rows_by_team=aaa_rows_by_team,
    )
    if any(b["rows"] for b in payload["affiliates"]) and not statcast_pending:
        set_agg_cache(agg_key, payload)
    return payload


@app.get("/api/org-page")
def org_page(
    response: Response,
    org: str = Query(...),
    start_date: str = Query(SEASON_START),
    end_date: str = Query(""),
):
    """One MLB org's whole system, one table per affiliate, highest level first.

    Team pages route per MLB ORG (LAD, not "Oklahoma City"), so this returns an
    ordered list of affiliate blocks — AAA, AA, A+, A, R. The AAA block carries
    full Statcast result rows; the rest carry adapted box-score rows aggregated
    over the date range from each pitcher's gameLog. AFL has no parent org, so
    it never appears here.
    """
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    org = (org or "").strip().upper()
    return _org_page_cached(org, start_date, end_date)


@app.get("/api/player-page")
def player_page(response: Response, pitcher_id: int = Query(...), start_date: str = Query(SEASON_START), end_date: str = Query("")):
    end_date = _resolve_end_date(end_date)
    _set_response_cache(response, _cache_scope_for_date(end_date))
    suffix = _season_cache_suffix(start_date, end_date)
    agg_key = f"player_v2_{pitcher_id}_s{CARD_SCHEMA_VERSION}{suffix}"
    cached = get_agg_cache(agg_key)
    if cached is not None:
        if _player_page_has_game_log(cached) or _season_totals_have_games(cached.get("season_totals_mlb")):
            return cached
    # On a cold cache, build from per-pitcher Savant (~1-3s) instead of loading
    # the whole league's materialized range (~170 MB) just to slice out one
    # pitcher. The codebase already trusts fetch_pitcher_season as the fallback
    # source for this exact totals/game-log data, and warmup-daily-players
    # pre-warms today's probable starters into this cache so cold-path hits are
    # rare. _build_player_page_payload uses fetch_pitcher_season internally
    # when preloaded_df is omitted and pitcher_season_fallback=True.
    result = _build_player_page_payload(
        pitcher_id, start_date, end_date, pitcher_season_fallback=True,
    )
    set_agg_cache(agg_key, result)
    return result

class ReclassifyRequest(BaseModel):
    game_pk: int
    pitcher_id: int
    at_bat_number: int
    pitch_number: int
    new_pitch_type: str
    date: str = ""

def _rebuild_card_after_override(date_str, pitcher_id, game_pk):
    """Rebuild + cache the single card affected by a reclassify/undo, and
    return the freshly-built card so the endpoint can hand it straight back
    to the client.

    The endpoint instance that just did save/remove_pitch_override has the
    freshest override state (and save/remove pinned _overrides_synced_at so
    the rebuild's _apply_overrides uses that local dict). So this instance
    produces the CORRECT card regardless of whether the Redis "overrides"
    write propagated. Returning it directly means the frontend never has to
    rely on cross-instance cache consistency for the immediate update.

    We still cache it (at whatever override_version Redis currently reports)
    so subsequent requests are warm — if the redis_incr was flaky and the
    version didn't move, we simply overwrite the old key with the new card,
    which is still correct.
    """
    if not (date_str and pitcher_id and game_pk):
        return None
    try:
        card = _build_pitcher_card_payload(date_str, int(pitcher_id), int(game_pk))
        if card and not card.get("player_page_loading"):
            agg_key = (
                f"card_{date_str}_{int(pitcher_id)}_{int(game_pk)}"
                f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
            )
            set_agg_cache(agg_key, card)
        return card
    except Exception as e:
        print(f"[Reclassify] Card rebuild error {date_str}/{pitcher_id}/{game_pk}: {e}")
        return None


@app.post("/api/pitch-reclassify")
def reclassify_pitch(response: Response, req: ReclassifyRequest):
    _set_response_cache(response, "mutation")
    key = save_pitch_override(req.game_pk, req.pitcher_id, req.at_bat_number, req.pitch_number, req.new_pitch_type)
    card = None
    if req.date:
        clear_cache(req.date, pitcher_ids=[req.pitcher_id])
        card = _rebuild_card_after_override(req.date, req.pitcher_id, req.game_pk)
    return {"status": "ok", "key": key, "card": card}

@app.delete("/api/pitch-reclassify")
def undo_reclassify(response: Response, game_pk: int = Query(...), pitcher_id: int = Query(...), at_bat_number: int = Query(...), pitch_number: int = Query(...), date: str = Query("")):
    _set_response_cache(response, "mutation")
    removed = remove_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number)
    card = None
    if date:
        clear_cache(date, pitcher_ids=[pitcher_id])
        card = _rebuild_card_after_override(date, pitcher_id, game_pk)
    return {"status": "ok" if removed else "not_found", "card": card}

@app.get("/api/pitch-overrides")
def pitch_overrides(response: Response):
    _set_response_cache(response, "live")
    return get_all_overrides()


def _require_cron_auth(request: Request):
    """Cron + materialize endpoints fail CLOSED on serverless.

    An unset CRON_SECRET must NOT mean "open to everyone" — that was the
    fail-open bug the upstream audit fixed. Locally (_IS_SERVERLESS false) the
    guard is skipped so these stay callable by hand.
    """
    if not _IS_SERVERLESS:
        return None
    cron_secret = os.environ.get("CRON_SECRET")
    auth = request.headers.get("authorization")
    if not cron_secret or auth != f"Bearer {cron_secret}":
        return _json_response({"error": "Unauthorized"}, status_code=401, scope="mutation")
    return None


@app.get("/api/materialize-range")
def materialize_range(
    request: Request,
    response: Response,
    start_date: str = Query(...),
    end_date: str = Query(...),
):
    _set_response_cache(response, "mutation")
    cron_secret = os.environ.get("CRON_SECRET")
    auth = request.headers.get("authorization")
    if not cron_secret or auth != f"Bearer {cron_secret}":
        return _json_response({"error": "Unauthorized"}, status_code=401, scope="mutation")
    if not (_valid_date_param(start_date) and _valid_date_param(end_date)):
        return _json_response({"error": "Invalid date format; expected YYYY-MM-DD"}, status_code=400, scope="mutation")
    if start_date > end_date:
        return _json_response({"error": "start_date must be before or equal to end_date"}, status_code=400, scope="mutation")
    job = queue_range_materialization(start_date, end_date)
    return _json_response(
        {
            "status": job.get("status", "pending"),
            "start_date": start_date,
            "end_date": end_date,
            "materialization_started": bool(job.get("queued")),
            **({"error": job.get("error")} if job.get("error") else {}),
        },
        status_code=202,
        scope="mutation",
    )


@app.get("/api/materialize-status")
def materialize_status(
    request: Request,
    response: Response,
    start_date: str = Query(...),
    end_date: str = Query(...),
):
    _set_response_cache(response, "mutation")
    cron_secret = os.environ.get("CRON_SECRET")
    auth = request.headers.get("authorization")
    if not cron_secret or auth != f"Bearer {cron_secret}":
        return _json_response({"error": "Unauthorized"}, status_code=401, scope="mutation")
    if not (_valid_date_param(start_date) and _valid_date_param(end_date)):
        return _json_response({"error": "Invalid date format; expected YYYY-MM-DD"}, status_code=400, scope="mutation")
    return _json_response(get_range_materialization_status(start_date, end_date), scope="mutation")


@app.get("/api/cron/materialize-ranges")
def cron_materialize_ranges(request: Request, response: Response, max_jobs: int = Query(1)):
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        # Leave headroom inside the 300s limit so the job can write its
        # heartbeat and, if it finished, its ready state before being killed.
        deadline = time.time() + 240
        drained = drain_pending_materializations(max_jobs=max_jobs, deadline=deadline)
        # Advance the season ledger with whatever budget remains. Steady state
        # is one folded day per morning; an initial or post-override rebuild
        # spreads across a few ticks via the checkpointed high-water mark.
        try:
            ledger_status = ledger.advance_ledger(deadline=deadline)
        except Exception as e:
            print(f"[Ledger] advance failed: {e}")
            ledger_status = {"error": str(e)}
        # Keep the Rehab page warm. Its key rolls hourly (it embeds today's
        # date and takes the live TTL), and the build is the most
        # request-hostile sweep in the app — rosters, six per-level scans,
        # game logs, then play-by-play enrichment. Calling the builder here is
        # a dict lookup while the cache holds and at most one rebuild per
        # hour when it lapses; during game hours that also folds in starts
        # that completed since the last pass.
        try:
            _rehab_starts_payload(14)
        except Exception as e:
            print(f"[RehabWarm] {e}")
        return {"status": "ok", "count": len(drained), "drained": drained,
                "ledger": ledger_status}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/warmup")
def cron_warmup(request: Request, response: Response):
    """Off-season hourly warmup. Covers the Statcast levels only — that's the
    whole pitch-data universe (see data.STATCAST_SCOPE)."""
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        warmup_range_data()
        now = _now_et().isoformat()
        redis_set("last_refresh", now)
        return {"status": "ok", "timestamp": now}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


# ── Daily warmup: every level, budgeted ────────────────────────────────────
# The MLB app warmed ONE slate per day. Here there are six, so each daily cron
# loops levels under a deadline and reports which ones it got to. Statcast
# levels (AAA/AFL) get the pitch + results aggregations; the rest get the
# box-score results table, which is all that exists for them.

def _recent_dates_for_stat_corrections(days_back=14):
    today = _now_et().date()
    return [(today - timedelta(days=offset)).isoformat() for offset in range(1, days_back + 1)]


def _final_game_pks_for_date(date_str, levels=STATCAST_LEVELS):
    """Final game_pks on a date across the given levels.

    Never sportId=1 — the MLB version of this helper hardcoded it, which would
    have swept major-league games this app doesn't even display.
    """
    game_pks = []
    for code in levels:
        for game in (_get_mlb_schedule(date_str, level=code) or []):
            abstract_state = (game.get("abstract_state") or "")
            detailed_state = (game.get("status") or "")
            if abstract_state == "Final" or "Final" in detailed_state:
                game_pks.append(int(game["game_pk"]))
    return game_pks


@app.get("/api/cron/stat-corrections")
def cron_stat_corrections(request: Request, response: Response, days_back: int = Query(14)):
    """Daily stat-correction sweep.

    Re-fetches recent final Statcast-level boxscores, compares them against
    cached final lines, and clears date/player caches when official pitcher
    lines changed. The box-score levels have no pitch-derived lines to compare,
    so their daily caches are simply dropped for the swept dates and recompute
    on next request.
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        # Reserve ~60s of the 300s maxDuration for the trailing past-card rewarm
        # (which has its own 40s budget) + FastAPI/network slop.
        deadline = time.time() + 200
        days = max(1, min(int(days_back or 14), 30))
        changed_dates = {}
        scanned_games = 0
        all_affected = set()
        swept_dates = []
        for date_str in _recent_dates_for_stat_corrections(days):
            if time.time() >= deadline:
                print(f"[StatCorrections] Deadline hit - scanned {scanned_games} games / {len(changed_dates)} changed dates, deferring rest")
                break
            swept_dates.append(date_str)
            game_pks = _final_game_pks_for_date(date_str)
            scanned_games += len(game_pks)
            result = check_boxscore_stat_corrections(game_pks)
            affected = result.get("affected_pitchers") or []
            corrections = result.get("corrections") or []
            if not corrections:
                continue
            clear_cache(date_str, pitcher_ids=affected)
            all_affected.update(int(p) for p in affected)
            changed_dates[date_str] = {
                "affected_pitchers": affected,
                "corrections": corrections,
            }

        # Box-score levels: no pitch lines to diff, so just invalidate their
        # daily caches for the swept window and let them rebuild on demand.
        box_cleared = 0
        for date_str in swept_dates:
            for code in LEVEL_ORDER:
                if code in STATCAST_LEVELS:
                    continue
                key = f"daily_results_box_{code}_s{CARD_SCHEMA_VERSION}m{_METRICS_VERSION}_{date_str}"
                try:
                    redis_delete(f"agg:{key}")
                    box_cleared += 1
                except Exception:
                    pass

        rewarm_stats = {"warmed": 0, "skipped": 0, "budget_hit": False}
        if all_affected:
            try:
                today_str = _now_et().strftime("%Y-%m-%d")
                rewarm_stats = _rewarm_past_cards_for_pitchers(
                    all_affected, today_str, deadline=time.time() + 40,
                )
            except Exception as e:
                print(f"[StatCorrections] Past-card rewarm error: {e}")

        return {
            "status": "ok",
            "days_back": days,
            "scanned_games": scanned_games,
            "changed_dates": changed_dates,
            "box_caches_cleared": box_cleared,
            "past_cards_rewarmed": rewarm_stats.get("warmed", 0),
            "past_cards_rewarm_budget_hit": rewarm_stats.get("budget_hit", False),
        }
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/warmup-daily")
def cron_warmup_daily(request: Request, response: Response):
    """Daily cron (8:00 UTC = 4:00 AM EDT): warms the homepage caches for the
    default date at EVERY level. Scheduled before the 5 AM ET date rollover so
    get_default_date() still resolves to the just-completed slate."""
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 240
        default_date = get_default_date()
        warmed, skipped = [], []
        for code in LEVEL_ORDER:
            if time.time() >= deadline:
                skipped.append(code)
                continue
            try:
                get_games(default_date, code)
                if is_statcast_level(code):
                    fetch_date(default_date)
                    pd_result = aggregate_pitch_data(default_date, None, level=code)
                    set_agg_cache(f"daily_pitch_{code}_{default_date}", pd_result)
                    pr_result = aggregate_pitcher_results(default_date, None, level=code)
                    set_agg_cache(f"daily_results_{code}_s{CARD_SCHEMA_VERSION}_{default_date}", pr_result)
                else:
                    # get_level_results pulls each game's live feed once and
                    # derives the pitch metrics, so this also warms the
                    # per-game metric cache that player-page logs read.
                    rows = get_level_results(default_date, code)
                    if rows:
                        set_agg_cache(f"daily_results_box_{code}_s{CARD_SCHEMA_VERSION}m{_METRICS_VERSION}_{default_date}", rows)
                warmed.append(code)
            except Exception as e:
                print(f"[WarmupDaily] {code} failed: {e}")
                skipped.append(code)
        record_stat_lines_refresh(default_date)
        print(f"[WarmupDaily] {default_date}: warmed {warmed}, skipped {skipped}")
        try:
            sl_start = _season_start(_now_et().year)
            totals_end = _resolve_end_date("")
            if fetch_all_pitchers_list_materialized(sl_start, totals_end) is None:
                # Strict build needs the WHOLE season baked, and the job that
                # queues that (warmup-daily-2) runs 20 minutes after this one.
                # So on any morning materialization is behind, this would leave
                # no directory at all and every cold instance would refold the
                # season for the rest of the day. Persist the partial instead.
                rows = warm_partial_pitcher_directory(sl_start, totals_end)
                print(f"[WarmupDaily] Range incomplete; cached partial directory ({len(rows)} pitchers)")
        except Exception as e:
            print(f"[WarmupDaily] Pitcher list warm error: {e}")

        # Last week's slates, so paging back a day on the homepage is instant.
        #
        # This is cheap in the steady state and that is the whole point: a
        # PAST-date agg key never expires (see _agg_key_ttl), so a given date
        # costs this once and is then permanent. After the first run the loop
        # is a handful of cache hits, and only the newly-rolled-off day does
        # real work. Nothing warmed these before — the first person to page
        # back paid the full aggregation for that date.
        #
        # Runs LAST on purpose. It shares the deadline with the directory warm
        # above, which serves search, and search is the higher priority; a slow
        # morning should cut this tail rather than that.
        # AAA leads because it is the homepage default.
        recent_levels = ["AAA"] + [c for c in LEVEL_ORDER if c != "AAA"]
        recent_warmed, recent_skipped = 0, 0
        base_day = datetime.strptime(default_date, "%Y-%m-%d")
        for back in range(1, 8):
            day = (base_day - timedelta(days=back)).strftime("%Y-%m-%d")
            for code in recent_levels:
                if time.time() >= deadline:
                    recent_skipped += 1
                    continue
                try:
                    if is_statcast_level(code):
                        pitch_key = f"daily_pitch_{code}_{day}"
                        results_key = f"daily_results_{code}_s{CARD_SCHEMA_VERSION}_{day}"
                        if (get_agg_cache(pitch_key) is not None
                                and get_agg_cache(results_key) is not None):
                            continue
                        get_games(day, code)
                        set_agg_cache(pitch_key, aggregate_pitch_data(day, None, level=code))
                        set_agg_cache(results_key,
                                      aggregate_pitcher_results(day, None, level=code))
                    else:
                        box_key = (f"daily_results_box_{code}_s{CARD_SCHEMA_VERSION}"
                                   f"m{_METRICS_VERSION}_{day}")
                        if get_agg_cache(box_key) is not None:
                            continue
                        get_games(day, code)
                        rows = get_level_results(day, code)
                        if rows:
                            set_agg_cache(box_key, rows)
                    recent_warmed += 1
                except Exception as e:
                    print(f"[WarmupDaily] recent slate {day}/{code} failed: {e}")
                    recent_skipped += 1

        now = _now_et().isoformat()
        redis_set("last_refresh", now)
        return {"status": "ok", "timestamp": now, "date": default_date,
                "levels_warmed": warmed, "levels_skipped": skipped,
                "recent_slates_warmed": recent_warmed,
                "recent_slates_skipped": recent_skipped}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/warmup-daily-2")
def cron_warmup_daily_season(request: Request, response: Response):
    """Season-wide org aggregations (4:05 AM ET).

    Org pages are the expensive page in this build: 30 orgs x ~7 affiliates.
    The AAA block comes from the materialized range; every other affiliate is
    one season-stats call. `offset` lets the job be split across runs if the
    full sweep ever outgrows the 300s budget.
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 260
        start_date = _season_start(_now_et().year)
        end_date = _resolve_end_date("")
        # Per-affiliate AAA team aggregations (same shape as the MLB app's).
        #
        # Streamed a day at a time with one accumulator per team, rather than
        # materializing the league's whole season and slicing it ~30 ways. The
        # accumulators are equivalence-tested against the aggregate_*_range
        # functions this replaces (backend/tests/test_streaming_range_agg.py),
        # so the cached payloads are byte-for-byte what they were.
        # groupby drops NaN keys, matching the old dropna() on the team column.
        results_acc = {}
        pitch_acc = {}

        def fold(day_df):
            if "pitcher_team" not in day_df.columns:
                return
            for team, tdf in day_df.groupby("pitcher_team"):
                if tdf.empty:
                    continue
                if team not in results_acc:
                    results_acc[team] = new_results_accumulator()
                    pitch_acc[team] = new_pitch_data_accumulator()
                accumulate_pitcher_results(results_acc[team], tdf)
                accumulate_pitch_data(pitch_acc[team], tdf)

        if not fold_range_materialized(start_date, end_date, fold):
            # Range not materialized yet — queue it and let the materialize
            # cron pick it up rather than doing a blocking season fetch here.
            queue_range_materialization(start_date, end_date)
            return {"status": "deferred", "reason": "range not materialized",
                    "start_date": start_date, "end_date": end_date}

        # Finalized once, used twice: for the team_ keys below and for every
        # org payload further down. Building the org pages from these rows is
        # what makes warming all 30 affordable — each would otherwise run its
        # own full-season fold.
        aaa_rows_by_team = {}
        for team in list(results_acc):
            if time.time() >= deadline:
                break
            rows = finalize_pitcher_results(results_acc[team])
            aaa_rows_by_team[team] = rows
            set_agg_cache(f"team_{team}_results_{start_date}_{end_date}", rows)
            set_agg_cache(f"team_{team}_pitch-data_{start_date}_{end_date}",
                          finalize_pitch_data(pitch_acc[team]))

        warmed_orgs, skipped_orgs = [], []
        season_year = int(start_date[:4])
        for org in all_orgs():
            if time.time() >= deadline:
                skipped_orgs.append(org)
                continue
            try:
                for meta in affiliates_for_org(org):
                    if meta["level"] == "AAA":
                        continue  # comes from the materialized range above
                    get_team_season_pitchers(meta["team_id"], meta["level"], season_year)
                warmed_orgs.append(org)
            except Exception as e:
                print(f"[WarmupDaily2] org {org} failed: {e}")
                skipped_orgs.append(org)

        # The org payloads THEMSELVES, not just their inputs. Nothing warmed
        # these before, so every org page view rebuilt ~7 affiliate blocks plus
        # a full-season fold for the AAA upgrade. Here the fold has already
        # happened once above, so each org costs only its non-AAA affiliate
        # lookups — which the loop above just warmed.
        orgs_cached = 0
        for org in warmed_orgs:
            if time.time() >= deadline:
                break
            try:
                _org_page_cached(org, start_date, end_date,
                                 aaa_rows_by_team=aaa_rows_by_team)
                orgs_cached += 1
            except Exception as e:
                print(f"[WarmupDaily2] org payload {org} failed: {e}")

        # All-levels search directory. Every affiliate call it needs is warm
        # from the loop above, so this is nearly free here and saves the first
        # searcher of the day a ~200-request cold sweep.
        directory_size = 0
        try:
            directory_size = len(get_all_milb_pitchers(season_year, deadline=deadline) or [])
        except Exception as e:
            print(f"[WarmupDaily2] directory build failed: {e}")

        return {"status": "ok", "orgs_warmed": len(warmed_orgs),
                "org_pages_cached": orgs_cached,
                "orgs_skipped": skipped_orgs,
                "directory_pitchers": directory_size,
                "budget_hit": bool(skipped_orgs) or orgs_cached < len(warmed_orgs)}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/refresh-player-pool")
def cron_refresh_player_pool(request: Request, response: Response):
    """Re-resolve every pitcher's current club and rebuild the player pool.

    `warmup-daily-2` already rebuilds the pool nightly, and the current-club
    mapping has a 6-hour TTL on top of that — which is the right cadence for
    an ordinary week and the wrong one for deadline day, when a few dozen
    prospects change organizations inside an hour. This is the button for
    that: it bypasses both cache tiers and reports what actually moved, so a
    refresh can be verified instead of assumed.
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 260
        season_year = _now_et().year
        before = {
            int(r["pitcher_id"]): (r.get("team"), r.get("org"))
            for r in (cached_milb_pitchers(season_year) or [])
            if r.get("pitcher_id") is not None
        }
        pool = get_all_milb_pitchers(season_year, deadline=deadline, refresh=True) or []
        moved = []
        for r in pool:
            pid = r.get("pitcher_id")
            if pid is None or int(pid) not in before:
                continue
            was_team, was_org = before[int(pid)]
            now_team, now_org = r.get("team"), r.get("org")
            if (was_team, was_org) != (now_team, now_org):
                moved.append({
                    "pitcher_id": int(pid), "name": r.get("name") or "",
                    "from": {"team": was_team, "org": was_org},
                    "to": {"team": now_team, "org": now_org},
                })
        moved.sort(key=lambda m: m["name"])
        return {
            "status": "ok",
            "season": season_year,
            "pitchers": len(pool),
            "compared_against_cache": bool(before),
            "changed": len(moved),
            # Capped: deadline week can move a few hundred players and this
            # response is read by a human, not a machine.
            "moves": moved[:100],
            "moves_truncated": max(0, len(moved) - 100),
            "budget_hit": time.time() >= deadline,
        }
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/warmup-daily-players")
def cron_warmup_daily_players(request: Request, response: Response):
    """Player pages for everyone who pitched yesterday, at ANY level (4:15 AM ET).

    Pulls the pitcher set from every level's results, not just AAA — a AA-only
    pitcher has a player page too, and it is the slowest one to build cold
    (6 gameLog calls).
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 250
        default_date = get_default_date()
        season_start_str = _season_start(_now_et().year)
        end_date = _resolve_end_date("")

        # Warm order matters: this job is budget-bounded, so whatever is at the
        # front is what actually gets warmed on a slow morning. Priority is
        # AAA starters, then the rest of AAA, then every other level.
        aaa_starters, aaa_rest, other_levels = [], [], []
        for code in LEVEL_ORDER:
            if time.time() >= deadline:
                break
            try:
                if is_statcast_level(code):
                    rows = get_agg_cache(f"daily_results_{code}_s{CARD_SCHEMA_VERSION}_{default_date}") \
                        or aggregate_pitcher_results(default_date, None, level=code)
                else:
                    rows = get_agg_cache(f"daily_results_box_{code}_s{CARD_SCHEMA_VERSION}m{_METRICS_VERSION}_{default_date}") \
                        or get_level_results(default_date, code)
                for r in (rows or []):
                    pid = r.get("pitcher_id")
                    if pid is None:
                        continue
                    if code != "AAA":
                        other_levels.append(int(pid))
                    elif r.get("role") == "SP":
                        aaa_starters.append(int(pid))
                    else:
                        aaa_rest.append(int(pid))
            except Exception as e:
                print(f"[WarmupDailyPlayers] {code} results failed: {e}")

        # Today's probable starters too, so the first card view of a pitcher who
        # didn't appear yesterday still hits a warm cache. AAA's go to the very
        # front — a probable starter is the most likely player page to be opened
        # today, and he has no row in yesterday's results to be found under.
        probable_aaa, probable_other = [], []
        for code in STATCAST_LEVELS:
            try:
                ids = [int(p) for p in get_probable_starter_ids(default_date, level=code)]
            except Exception:
                continue
            (probable_aaa if code == "AAA" else probable_other).extend(ids)

        ordered_ids = probable_aaa + aaa_starters + aaa_rest + probable_other + other_levels
        stats = _warm_player_page_cache_for_pitchers(
            ordered_ids, season_start_str, end_date, deadline=deadline,
        )
        return {"status": "ok", "date": default_date, **stats}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/warmup-daily-cards")
def cron_warmup_daily_cards(request: Request, response: Response):
    """Pre-compute game cards (4:30 AM ET).

    Cards exist only for AAA and AFL, so this never touches the other levels —
    warming them would burn the whole budget building payloads no page renders.
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 260
        default_date = get_default_date()
        warmed, failed = 0, 0
        for code in STATCAST_LEVELS:
            rows = get_agg_cache(f"daily_results_{code}_s{CARD_SCHEMA_VERSION}_{default_date}") \
                or aggregate_pitcher_results(default_date, None, level=code)
            # Starters first within each level. This loop is budget-bounded, so
            # on a slow morning the tail is dropped — and a starter's card is
            # both the likelier click and the more expensive one to build cold.
            rows = sorted((rows or []), key=lambda r: r.get("role") != "SP")
            for r in rows:
                if time.time() >= deadline:
                    print(f"[WarmupDailyCards] Deadline hit after {warmed} cards")
                    return {"status": "ok", "date": default_date, "cards_warmed": warmed,
                            "failed": failed, "budget_hit": True}
                pid, gpk = r.get("pitcher_id"), r.get("game_pk")
                if pid is None or gpk is None:
                    continue
                try:
                    payload = _build_pitcher_card_payload(default_date, int(pid), int(gpk))
                    if payload:
                        agg_key = (
                            f"card_{default_date}_{int(pid)}_{int(gpk)}"
                            f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
                        )
                        set_agg_cache(agg_key, payload)
                        warmed += 1
                except Exception as e:
                    failed += 1
                    print(f"[WarmupDailyCards] card {pid}/{gpk} failed: {e}")
        return {"status": "ok", "date": default_date, "cards_warmed": warmed,
                "failed": failed, "budget_hit": False}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


def _live_games_for_statcast_levels(today: str):
    """Live/in-progress games across AAA + AFL only."""
    live = []
    for code in STATCAST_LEVELS:
        for g in (get_games(today, code) or []):
            if g.get("abstract_state") == "Live" or g.get("status") in ("In Progress", "Manager challenge"):
                live.append((code, g))
    return live


@app.get("/api/cron/warmup-live-cards")
def cron_warmup_live_cards(request: Request, response: Response):
    """Refresh cards for in-progress games every 10 min during game hours.

    AAA + AFL only — the other levels have no cards to refresh.
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 260
        today = get_default_date()
        live = _live_games_for_statcast_levels(today)
        if not live:
            return {"status": "ok", "date": today, "live_games": 0, "warmed": 0}
        warmed, failed = 0, 0
        for code, game in live:
            if time.time() >= deadline:
                break
            gpk = int(game["game_pk"])
            try:
                rows = aggregate_pitcher_results(today, gpk, level=code)
            except Exception as e:
                print(f"[LiveCards] results failed for {gpk}: {e}")
                continue
            for r in (rows or []):
                if time.time() >= deadline:
                    break
                pid = r.get("pitcher_id")
                if pid is None:
                    continue
                # Skip pitchers still mid-inning: their line is about to change
                # anyway, so caching it just burns budget on a stale payload.
                try:
                    if not _pitcher_half_inning_settled(gpk, int(pid)):
                        continue
                except Exception:
                    pass
                try:
                    payload = _build_pitcher_card_payload(today, int(pid), gpk)
                    if payload:
                        agg_key = (
                            f"card_{today}_{int(pid)}_{gpk}"
                            f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
                        )
                        set_agg_cache(agg_key, payload)
                        warmed += 1
                except Exception as e:
                    failed += 1
                    print(f"[LiveCards] card {pid}/{gpk} failed: {e}")
        return {"status": "ok", "date": today, "live_games": len(live),
                "warmed": warmed, "failed": failed}
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.get("/api/cron/warmup-live-game-views")
def cron_warmup_live_game_views(request: Request, response: Response):
    """Refresh the per-game tables for in-progress games every 2 min.

    AAA + AFL only, and the cache key carries the level so an AAA and an AFL
    game on the same date can't collide.
    """
    _set_response_cache(response, "mutation")
    denied = _require_cron_auth(request)
    if denied:
        return denied
    try:
        deadline = time.time() + 260
        today = get_default_date()
        live = _live_games_for_statcast_levels(today)
        warmed, skipped_empty = 0, 0
        for code, game in live:
            if time.time() >= deadline:
                break
            gpk = int(game["game_pk"])
            agg_key = (
                f"game_view_{code}_{today}_{gpk}"
                f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
            )
            try:
                payload = _build_selected_game_payload(today, gpk)
                if payload.get("pitchData") or payload.get("resultsData"):
                    set_agg_cache(agg_key, payload)
                    warmed += 1
                else:
                    skipped_empty += 1
            except Exception as e:
                print(f"[LiveGameViews] Game error {gpk}: {e}")
        return {
            "status": "ok",
            "date": today,
            "live_games": len(live),
            "warmed": warmed,
            "skipped_empty": skipped_empty,
        }
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


@app.post("/api/refresh")
def manual_refresh(response: Response, date: str = Query(None), game_pk: int = Query(None)):
    """Lightweight refresh for the dashboard button."""
    _set_response_cache(response, "mutation")
    try:
        target_date = date or get_default_date()
        refresh_info = clear_live_refresh_cache(target_date, game_pk)
        refreshed_game_view = False

        if game_pk is not None:
            payload = _build_selected_game_payload(target_date, int(game_pk))
            if payload.get("pitchData") or payload.get("resultsData"):
                agg_key = (
                    f"game_view_{target_date}_{int(game_pk)}"
                    f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
                )
                set_agg_cache(agg_key, payload)
                refreshed_game_view = True

        now = _now_et().isoformat()
        stat_lines_updated_at = record_stat_lines_refresh(target_date, timestamp=now)
        redis_set("last_refresh", now)
        return {
            "status": "ok",
            "date": target_date,
            "timestamp": now,
            "statLinesUpdatedAt": stat_lines_updated_at,
            "gameViewRefreshed": refreshed_game_view,
            **refresh_info,
        }
    except Exception as e:
        return _json_response({"error": str(e)}, status_code=500, scope="mutation")


# ── Last refresh timestamp ──
@app.get("/api/last-refresh")
def last_refresh(response: Response, date: str = Query(None)):
    _set_response_cache(response, "live")
    if date:
        return {"timestamp": _resolve_stat_lines_updated_at(date), "date": date}
    ts = redis_get("last_refresh")
    return {"timestamp": ts}


# ── Serve React frontend (must be AFTER all /api routes) ──
if _FRONTEND_DIR.is_dir():
    # Serve static assets (JS, CSS, images)
    app.mount("/static", StaticFiles(directory=_FRONTEND_DIR / "static"), name="static")

    # SPA catch-all: any non-API route returns index.html so React Router works
    @app.get("/{full_path:path}")
    def serve_frontend(full_path: str):
        # Try to serve the exact file first (favicon.ico, manifest.json, etc.)
        file_path = _FRONTEND_DIR / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        # Otherwise return index.html for client-side routing
        return FileResponse(_FRONTEND_DIR / "index.html")

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
