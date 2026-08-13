import io
import os
import json
import re
import time
import gzip
import base64
import threading
from datetime import datetime, timedelta, timezone
from concurrent.futures import ThreadPoolExecutor, as_completed
import numpy as np
import pandas as pd
import requests
from redis_cache import (
    redis_get, redis_set, redis_delete, redis_delete_many, redis_sadd,
    redis_smembers, redis_srem, redis_available, redis_incr, redis_exists,
)
from season import (
    SEASON_START, season_start, now_et as _now_et, ET_ZONE,
    strip_accents, aggregate_game_log_to_totals,
)
from caches import season_game_agg_cache
from levels import (
    DEFAULT_LEVEL, STATCAST_LEVELS, LEVEL_ORDER, normalize_level, schedule_url,
    is_statcast_level, org_for_team, team_meta_by_id,
)

# Every date-/game-scoped cache key carries a level scope so two levels playing
# the same date can never collide. The pitch pipeline covers all Statcast levels
# at once, so its scope token names the whole set.
STATCAST_SCOPE = "-".join(STATCAST_LEVELS)

# Mirrors app._IS_SERVERLESS. Duplicated rather than imported because app
# imports data, not the other way round.
_IS_SERVERLESS = os.environ.get("VERCEL") == "1" or os.environ.get("AWS_LAMBDA_FUNCTION_NAME") is not None

_cache = {}          # { date_str: (timestamp, dataframe) }
_season_cache = {}   # { (pitcher_id, season_year): (timestamp, dataframe) }
_batter_name_cache = {}  # { batter_id: "Full Name" }
LIVE_CACHE_TTL = 60  # seconds — refresh live data every 60s
# Per-pitcher full-season frames are immutable for past seasons (cache forever)
# but the in-progress season grows every game day. Refresh the current season's
# frame hourly so a just-completed game shows up on the player page / season
# totals without waiting for a process restart.
SEASON_CACHE_TTL = 3600

# ── Warmup / pre-fetch state ──
_warmup_status = {"ready": False, "loading": False, "error": None, "progress": ""}
_warmup_lock = threading.Lock()

# ── Pitch reclassification overrides ──
OVERRIDES_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pitch_overrides.json")
_overrides = {}  # { "gamePk_pitcherId_atBat_pitchNum": {"original":"FF","new":"FC",...} }
_override_version = 0  # Incremented on every save/remove to bust agg caches

# Cache-shape version. Bump whenever a cached payload (card, season totals,
# player page) gains or changes fields so all old cache entries miss after
# deploy. Included in every relevant cache key alongside _override_version.
# v11: per-pitch-type rate stats (strike_pct, cs_pct, swstr_pct, csw_pct) are
#     sent unrounded so the frontend's single Math.round agrees with
#     ResultsTable, fixing the X.45 → 45.5 → 46 double-rounding mismatch.
# v15: season totals and card results carry game_pks/raw counters so cards can
#     safely merge the current/live game when a stable season cache is stale.
# v17: pitcher-results rows include `innings_appeared` (distinct innings the
#     pitcher threw a pitch in), used as an ER-sort tiebreaker.
# v18: season totals include win/loss game_pks so finalized W/L decisions can
#     patch card totals even when the current game was already cached.
# v19: season totals carry raw strikes so stale-cache current-game merges can
#     recompute season Strike% correctly.
# v20: PAR% changes to strikeouts / batters faced who reached a two-strike count.
# v21: player/card season caches key by as-of date, card payloads include
#      player_page, range data persists by day, and Redis invalidation indexes
#      replace broad wildcard deletes.
# v22: pitcher card payloads include season averages, schedule, and linescore;
#      user-facing season range routes avoid synchronous Savant recomputes.
# v23: fetch_pitcher_season applies the full postprocess pipeline (teams,
#      overrides) so player_page game logs include opponent; card extras now
#      compute current+previous season averages on cache miss instead of
#      relying on a never-populated key.
# v24: SAVANT_PITCHER_SEASON_URL adds player_type=pitcher so player_name is
#      the pitcher (not the most common batter faced). v23 caches built
#      via pitcher_season_fallback have the wrong name baked in.
# v25: invalidate v24 card_/player_v2_/season_totals_ entries that were
#      built while range materialization was incomplete and ended up with
#      empty season_totals_mlb / null player_page.
# v26: v25 caches got split across two serverless instance pools because
#      a manual reclassify bumped _override_version on some instances but
#      not others. Bump schema once more to force every instance back to
#      the same key namespace.
# v27: pitcher-card now refuses to cache degraded payloads (built without
#      a materialized range). v26 was poisoned with such payloads during
#      a parallel warmup that raced an incomplete materialization.
# v28: re-enable include_season_context for homepage pitcher-results so
#      velo/ext deltas appear in the table. v27 daily_results_* caches
#      were built without context and have null velo_season / velo_delta /
#      velo_ext_delta — evict them.
# v29: card season_averages computation is now synchronous (was a fire-and-
#      forget background thread that didn't survive Vercel's serverless
#      lifecycle). v28 cards were cached with empty season_averages.current
#      / .previous, which killed the per-pitch deltas inside the card body.
# v30: intentional-ball "pitches" (MLB API details.code == "I") are dropped
#      from the pitch DataFrame and the linescore PBP. An IBB is now a PA
#      with zero pitches — fixes inflated pitch counts (e.g. Bryce Miller
#      85 -> 81). Evicts range_day/card caches built with the phantom pitches.
# v31: v30's filter only caught code "I"; modern automatic IBBs use code "V"
#      (and Savant carries them too). v31 filters by normalized description
#      ('automatic_ball' / 'intent_ball') — evict v30 caches built with the
#      incomplete filter.
# v32: MLB API code "W" (Swinging Strike Blocked) was missing from
#      _MLB_TYPE_MAP, so blocked whiffs got type="W" instead of "S" and were
#      undercounted in strike_pct. Whiffs/CSW (description-based) were still
#      correct, which made Strike% sometimes lower than SwStr% — impossible.
#      Evict v31 cards built from MLB API fallback data (live games, games
#      not yet on Savant) so the corrected mapping takes effect immediately.
# v33: live linescores preserve not-yet-played inning halves as null instead
#      of zero, and player/card cache reads rebuild stale empty debut payloads.
# v34: live linescores also suppress MLB-provided zeroes for half-innings
#      that exist in the feed but have not started yet.
# v35: (prior) — see above.
# v36: arm angle on movement plots no longer uses the release-point linear fit
#      when a native Hawk-Eye value is absent; it now resolves to Savant's
#      published per-pitcher arm angle (leaderboard). Evict cards/players cached
#      with the old (~14° off) approximation so the corrected value shows now.
#   37: per-pitch sz_top/sz_bot now ship in every pitch record so strikezone
#      plots can position pitches relative to each batter's individual zone
#      (matching Savant). Evict cards cached without the per-pitch zone fields.
#   38: every pitch record now ships an authoritative `runs_scored` (single
#      source of truth for the tooltip "x Run(s)" line, replacing client-side
#      des-parsing) and the Statcast `type` (B/S/X, so the filtered Pitch
#      Overview counts strikes like the backend). Evict cards/players cached
#      without these fields.
#   39: empty-day range snapshots are now written only when the MLB schedule
#      confirms the date was gameless; a transient Savant/MLB failure no
#      longer persists an empty 60-day snapshot that silently deleted the
#      day from every season aggregate. Bump flushes any already-poisoned
#      range_day keys.
#   40: E1 backend de-dup. Season-totals math unified into
#      season.aggregate_game_log_to_totals (player_page results_summary now
#      includes last_game_date); card `pitches` come from the shared
#      build_pitches_list (gain game_pk/game_date per pitch); season totals
#      compute per-pitcher first (never assemble the league range on the
#      request path) and asof-today season_totals_* keys are Redis-L2-backed
#      with the live 60s TTL so fresh instances don't recompute.
#   41: pitch_summary / per_game_summaries rows ship per-pitch-type 2-strike
#      counters (two_str_pitches / two_str_ks) for the game log's new
#      2-Str / PAR% columns. Evict payloads cached without them.
#   42: per-game/per-season percent fields (swstr/csw/strike/two_str/par_pct)
#      round to 2 decimals instead of 1 so single integer rounding in the UI
#      lands correctly (34.48 was shipping as 34.5 and displaying as 35%).
#   43: whiff/source unification. (a) A strikeout-ending pitch tagged "foul"
#      is reclassified to "foul_tip" (a whiff) — you can't strike out on a live
#      foul ball, and GUMBO/Savant disagreed on the label (card 12 vs game log
#      11 whiffs). (b) The card and the Regular Season game log now read the
#      SAME source at the same time: GUMBO live (fetch_date(today) is now
#      MLB-API-first), then the morning warmup's baked Savant snapshot
#      (fetch_game_pitches reads the range_day snapshot once it exists). Evict
#      every range_day/card/player/season cache built under the old labeling
#      and the card's always-GUMBO sourcing.
#   44: MiLB fork. Every pitch payload now comes from the minor-league Savant
#      endpoint (/statcast-search-minors + minors=true) instead of the MLB one,
#      carries a new `level` column (AAA/AFL only — sub-AAA rows are filtered
#      out), and every date-/game-scoped key gained a level scope. Card and
#      player-page payloads gained level tags and (org, level) team display.
#      Nothing cached under v43 describes minor-league games, so this bump
#      evicts the entire prior cache.
#   45: non-Statcast levels gained pitch-level metrics derived from the live
#      feed's play-by-play (whiffs, swstr_pct, csw_pct, gb/fb/ld/pu_pct,
#      hard_pct, tracked_pitches, bip). The adapted result rows and the
#      multi-level game log both changed shape, and `daily_results_box_*`
#      embeds this version — without the bump those keys keep serving the old
#      metric-less rows.
#   46: non-Statcast pitch metrics expanded to five families — count
#      (F-Strike%, 2Str%, PAR%), zone (Zone%, O/Z-Swing%, O/Z-Contact%, from
#      Gameday coordinates calibrated against AAA Savant), full contact quality
#      (Soft/Med/Hard), spray (Pull/Center/Oppo) and per-batter-hand splits.
#      Adapted rows and the multi-level game log both changed shape again.
#   47: retires the s46 daily keys. s46 was written by a deploy whose
#      per-game row cache still held v45 rows (that key was unversioned), so
#      the v46 daily payloads were populated with the OLD metric shape and
#      would never self-correct. _METRICS_VERSION now versions the per-game
#      keys; this bump clears the daily ones they poisoned. Bump BOTH together.
CARD_SCHEMA_VERSION = 47

STAT_LINES_REFRESH_PREFIX = "stat_lines_refresh"
RANGE_DAY_PREFIX = "range_day"
CACHE_INDEX_PREFIX = "cacheidx"
MATERIALIZE_PENDING_KEY = "materialize:pending"
# Per-day snapshot lifetime. This MUST outlast a full season. A season-scoped
# range is "materialized" only when EVERY day in it is still present, so a TTL
# shorter than the season guarantees the earliest days expire while the season
# is still being played and the range can never once be complete. At 60 days
# that is exactly what happened: by August the March and April snapshots were
# gone, so /api/org-page never upgraded AAA to Statcast columns and the
# materialize cron re-baked a perpetually expiring tail. 400 days spans a full
# season (late March through AFL in November, ~250 days) with room to spare,
# at the cost of holding a season of compressed snapshots in Upstash.
RANGE_DAY_TTL = 60 * 60 * 24 * 400
# The cache index is what date-scoped invalidation walks to find a day's
# snapshot (_delete_indexed("date", ...)). It must never expire BEFORE the keys
# it indexes, or invalidating an old date silently no-ops and the stale
# snapshot survives to its own much longer TTL. Index entries are just key
# names, so matching the longest indexed lifetime is cheap.
CACHE_INDEX_TTL = RANGE_DAY_TTL
MATERIALIZE_STATUS_TTL = 60 * 60 * 24


def _stat_lines_refresh_key(date_str):
    return f"{STAT_LINES_REFRESH_PREFIX}:{date_str}"


# _now_et is imported from season.py (single ET-clock helper).


# Tiny memoization for _get_today_str. It's called from _is_today, which is
# called from dozens of hot paths (fetch_date, every cache-key construction,
# the live cron loop, etc.) and each call did a fresh timezone-aware
# datetime.now() — meaningful CPU when multiplied across a request. 5s
# staleness is safe: the only date-rollover edge is the 5 AM ET cutoff in
# _get_today_str, and being 5s late there just means one tick of the live
# cron processes "yesterday" data for an extra moment, which is harmless.
_today_str_cache = (0.0, None)
_TODAY_STR_TTL = 5.0


def _get_today_str():
    """Get the current baseball date in US Eastern. Memoized for ~5s."""
    global _today_str_cache
    ts, cached = _today_str_cache
    now_mono = time.time()
    if cached is not None and (now_mono - ts) < _TODAY_STR_TTL:
        return cached
    now = _now_et()
    if now.hour < 5:
        now = now - timedelta(days=1)
    value = now.strftime("%Y-%m-%d")
    _today_str_cache = (now_mono, value)
    return value


def get_baseball_date():
    return _get_today_str()


def _count_runs_in_desc(desc, event):
    """Runs scored on a play — count of '<runner> scores' clauses in the play
    description plus the batter on a home run. Kept identical to the Statcast
    path (aggregation._runs_scored_series) so the per-pitch `runs_scored` field
    means the same thing for both data sources."""
    runs = len(re.findall(r"\bscores\b", (desc or "").lower()))
    if (event or "").lower() == "home_run":
        runs += 1
    return runs


def get_stat_lines_refresh(date_str):
    return redis_get(_stat_lines_refresh_key(date_str))


def record_stat_lines_refresh(date_str, timestamp=None):
    ts = timestamp or datetime.utcnow().isoformat()
    redis_set(_stat_lines_refresh_key(date_str), ts)
    return ts

def _load_overrides():
    global _overrides, _override_version
    # Try Redis first
    val = redis_get("overrides")
    if val is not None:
        _overrides = val
    elif os.path.exists(OVERRIDES_PATH):
        # Fall back to local file
        try:
            with open(OVERRIDES_PATH, "r") as f:
                _overrides = json.load(f)
            # Migrate to Redis
            redis_set("overrides", _overrides)
        except Exception:
            _overrides = {}
    # Restore override version from Redis so cache keys match across restarts.
    # If the key doesn't exist yet (first deploy with this fix), seed it from
    # the number of overrides so all processes start from the same baseline.
    ver = redis_get("override_version")
    if ver is not None:
        _override_version = int(ver)
    elif _overrides:
        _override_version = len(_overrides)
        redis_set("override_version", _override_version)
    return _overrides

def _save_overrides():
    # Save to Redis (primary)
    redis_set("overrides", _overrides)
    # Also save to local file (works locally, may fail on serverless)
    try:
        with open(OVERRIDES_PATH, "w") as f:
            json.dump(_overrides, f, indent=2)
    except Exception:
        pass

# Override version + dict are kept loosely in sync with Redis via a single
# TTL'd refresh. The TTL is deliberately generous (30s): overrides change
# only on a manual reclassification, which is rare, AND the reclassify
# endpoint returns the freshly-rebuilt card directly to the client — so the
# UI never has to wait on cross-instance version convergence. A 30s window
# is plenty, and it keeps get_override_version() (called on every card /
# game-view cache-key construction) off Redis on the hot path.
_overrides_synced_at = 0.0
_OVERRIDES_SYNC_TTL = 30.0  # seconds


def get_override_version():
    """Return the current override version counter for cache-busting.

    TTL-guarded Redis sync (see _OVERRIDES_SYNC_TTL above) — was previously
    an unconditional Redis read on every call, which put a read on the hot
    path for every card and game-view request and was a meaningful chunk of
    Upstash command volume.
    """
    _sync_overrides_from_redis()
    return _override_version


def _sync_overrides_from_redis():
    """Re-pull the overrides DICT and version counter from Redis (TTL-guarded).

    Used by both get_override_version() and _apply_overrides(). Throttled to
    one Redis round-trip per _OVERRIDES_SYNC_TTL window per instance, so the
    card / game-view hot path doesn't hit Redis on every request.
    """
    global _overrides, _override_version, _overrides_synced_at
    now = time.time()
    if now - _overrides_synced_at < _OVERRIDES_SYNC_TTL:
        return
    _overrides_synced_at = now
    if not redis_available():
        return
    try:
        val = redis_get("overrides")
        if isinstance(val, dict):
            _overrides = val
        ver = redis_get("override_version")
        if ver is not None:
            _override_version = int(ver)
    except Exception:
        pass

def _refresh_overrides_dict_from_redis():
    """Unconditionally re-pull the overrides dict from Redis.

    Called before any mutation (save/remove) so a serverless instance with
    a stale _overrides dict doesn't clobber overrides written by other
    instances when it persists its copy back.
    """
    global _overrides
    if not redis_available():
        return
    try:
        val = redis_get("overrides")
        if isinstance(val, dict):
            _overrides = val
    except Exception:
        pass


def save_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number, new_pitch_type):
    """Save a pitch reclassification override.
    new_pitch_type can be either a human name ('Four-Seamer') or a code ('FF').
    """
    global _override_version
    # Sync from Redis first so we merge into the current dict instead of
    # overwriting it with this instance's possibly-stale copy.
    _refresh_overrides_dict_from_redis()
    key = f"{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
    # Determine code and name regardless of which format was passed
    if new_pitch_type in PITCH_NAME_TO_CODE:
        # Human name passed (e.g., "Four-Seamer")
        new_code = PITCH_NAME_TO_CODE[new_pitch_type]
        new_name = new_pitch_type
    elif new_pitch_type in PITCH_TYPE_MAP:
        # Code passed (e.g., "FF")
        new_code = new_pitch_type
        new_name = PITCH_TYPE_MAP[new_pitch_type]
    else:
        new_code = new_pitch_type
        new_name = new_pitch_type
    _overrides[key] = {
        "new_type": new_code,
        "new_name": new_name,
    }
    _save_overrides()
    # Persist version to Redis so warmup crons and restarts use the same cache keys
    new_ver = redis_incr("override_version")
    if new_ver is not None:
        _override_version = new_ver
    else:
        _override_version += 1
    # Mark synced NOW: the reclassify endpoint immediately rebuilds the card,
    # and its _apply_overrides must use THIS instance's just-mutated dict.
    # Without this, the TTL-guarded _sync_overrides_from_redis could re-read
    # Redis and — if the _save_overrides write was slow/flaky — clobber the
    # local override before the rebuild applies it.
    global _overrides_synced_at
    _overrides_synced_at = time.time()
    return key

def remove_pitch_override(game_pk, pitcher_id, at_bat_number, pitch_number):
    """Remove a pitch reclassification override."""
    global _override_version
    # Sync from Redis first — otherwise an instance with a stale _overrides
    # dict (one that doesn't contain the override another instance just
    # saved) would think there's nothing to remove and silently no-op.
    _refresh_overrides_dict_from_redis()
    key = f"{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
    removed = _overrides.pop(key, None)
    if removed is None:
        # Legacy key shape from earlier versions
        legacy_key = f"mlb_{game_pk}_{pitcher_id}_{at_bat_number}_{pitch_number}"
        removed = _overrides.pop(legacy_key, None)
    if removed:
        _save_overrides()
        # Persist version to Redis so warmup crons and restarts use the same cache keys
        new_ver = redis_incr("override_version")
        if new_ver is not None:
            _override_version = new_ver
        else:
            _override_version += 1
    # Mark synced NOW regardless — the reclassify endpoint's immediate
    # rebuild must use this instance's just-mutated dict (see save_pitch_override).
    global _overrides_synced_at
    _overrides_synced_at = time.time()
    return removed is not None

def get_all_overrides():
    # Sync from Redis so this reflects overrides written by ANY instance,
    # not just whatever this instance happens to hold locally.
    _refresh_overrides_dict_from_redis()
    return dict(_overrides)

def _apply_overrides(df):
    # Pull the latest overrides from Redis first — on serverless this
    # instance's _overrides dict may be stale (a reclassify handled by a
    # different instance). TTL-guarded so this is at most one Redis read
    # per second per instance.
    _sync_overrides_from_redis()
    if not _overrides or df.empty:
        return df
    required = {"game_pk", "pitcher", "at_bat_number"}
    if not required.issubset(df.columns):
        return df
    has_pitch_number = "pitch_number" in df.columns
    for key, ov in _overrides.items():
        parts = key.split("_")
        # Support both 4-part (new) and 5-part legacy mlb_ prefixed keys
        if len(parts) == 5 and parts[0] == "mlb":
            gpk_s, pid_s, abn_s, pnum_s = parts[1], parts[2], parts[3], parts[4]
        elif len(parts) == 4:
            gpk_s, pid_s, abn_s, pnum_s = parts
        else:
            continue
        try:
            gpk, pid, abn, pnum = int(gpk_s), int(pid_s), int(abn_s), int(pnum_s)
        except ValueError:
            continue
        mask = (df["game_pk"] == gpk) & (df["pitcher"] == pid) & (df["at_bat_number"] == abn)
        if has_pitch_number:
            exact_mask = mask & (df["pitch_number"] == pnum)
            if exact_mask.any():
                idx = df.loc[exact_mask].index[0]
                df.at[idx, "pitch_type"] = ov["new_type"]
                df.at[idx, "pitch_name"] = ov["new_name"]
        else:
            matching_rows = df.loc[mask]
            if matching_rows.empty:
                continue
            indices = matching_rows.index.tolist()
            if pnum - 1 < len(indices):
                idx = indices[pnum - 1]
                df.at[idx, "pitch_type"] = ov["new_type"]
                df.at[idx, "pitch_name"] = ov["new_name"]
    return df


def _drop_intentional_ball_rows(df):
    """Remove intentional-ball / automatic-ball rows from a pitch DataFrame.

    Modern automatic IBBs (and pitch-clock-violation balls) are awarded
    without a pitch being thrown, yet both Savant and the MLB API emit them
    as rows with description 'automatic_ball' (legacy: 'intent_ball'). The
    rows have no pitch_type, so they showed up as phantom 'Unclassified'
    pitches and inflated pitch counts — an intentional walk added 4 (e.g.
    Bryce Miller 85 -> 81). Treat them as non-pitches: drop the rows so an
    IBB is a plate appearance with zero pitches. The walk and batter-faced
    are still counted from the authoritative boxscore line.
    """
    if df is None or df.empty or "description" not in df.columns:
        return df
    desc = df["description"].astype(str)
    non_pitch = desc.isin(("automatic_ball", "intent_ball"))
    if non_pitch.any():
        return df[~non_pitch].copy()
    return df


# Load overrides on module import
_load_overrides()

PITCH_TYPE_MAP = {
    "FF": "Four-Seamer", "SI": "Sinker", "FC": "Cutter",
    "SL": "Slider", "ST": "Sweeper", "CU": "Curveball",
    "KC": "Curveball", "CS": "Curveball", "CH": "Changeup",
    "FS": "Splitter", "KN": "Knuckleball", "EP": "Eephus",
    "SC": "Screwball", "FO": "Forkball", "SV": "Curveball",
}

# Reverse map: human-readable name -> primary pitch_type code
PITCH_NAME_TO_CODE = {
    "Four-Seamer": "FF", "Sinker": "SI", "Cutter": "FC",
    "Slider": "SL", "Sweeper": "ST", "Curveball": "CU",
    "Changeup": "CH", "Splitter": "FS", "Knuckleball": "KN",
    "Eephus": "EP", "Screwball": "SC", "Forkball": "FO",
}

# Minor-league Statcast. Two things differ from the MLB search URL and BOTH
# matter: the /statcast-search-minors path AND `minors=true`. Without the flag
# the endpoint silently serves MAJOR-league rows (verified 2026-07-30: 10 MLB
# game_pks, e.g. 824568 = NYY @ CWS), which is exactly the trap that makes a
# minors build look like it's working while showing big-league data.
#
# hfLevel is left empty on purpose: the response then covers every tracked
# minors park for the date (AAA plus the Single-A Florida State League parks,
# and AFL parks in the fall). Rows are tagged with their true level from the
# per-level schedules and filtered in fetch_date, so nothing below AAA leaks
# into a pitch view.
#
# Minors gameTypes are only R (regular) and PO (playoffs) — S/E/W/D/L/F are
# major-league-only and including them returns nothing.
SAVANT_CSV_URL = (
    "https://baseballsavant.mlb.com/statcast-search-minors/csv"
    "?hfPT=&hfAB=&hfGT=R%7CPO%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones="
    "&hfPull=&hfC=&hfSea=&hfSit=&player_type=pitcher&hfOuts=&hfOpponent="
    "&pitcher_throws=&batter_stands=&hfSA=&game_date_gt={date}&game_date_lt={date}"
    "&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield="
    "&hfInn=&hfBBT=&hfFlag=&hfLevel=&metric_1=&group_by=name&min_pitches=0"
    "&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed"
    "&sort_order=desc&type=details&all=true&minors=true&wbc=false"
)


def _fix_names_vectorized(series):
    """Vectorized name fixing: 'Last, First' -> 'First Last'."""
    mask = series.str.contains(", ", na=False)
    if not mask.any():
        return series
    fixed = series.copy()
    parts = series[mask].str.split(", ", n=1, expand=True)
    if parts.shape[1] >= 2:
        fixed[mask] = parts[1] + " " + parts[0]
    return fixed

def _resolve_batter_names(batter_ids):
    """Resolve a Series of numeric batter IDs to full names via MLB Stats API.
    Uses a persistent cache to minimize API calls."""
    global _batter_name_cache
    # Hydrate from Redis if L1 is empty
    if not _batter_name_cache:
        redis_names = redis_get("batter_names")
        if redis_names:
            _batter_name_cache = {int(k): v for k, v in redis_names.items()}
    unique_ids = set(int(x) for x in batter_ids.dropna().unique() if pd.notna(x) and int(x) > 0)
    missing = unique_ids - set(_batter_name_cache.keys())
    if missing:
        # MLB Stats API supports comma-separated person IDs
        # Batch in groups of 100 to avoid URL length issues
        missing_list = list(missing)
        for i in range(0, len(missing_list), 100):
            batch = missing_list[i:i+100]
            ids_str = ",".join(str(x) for x in batch)
            try:
                url = f"https://statsapi.mlb.com/api/v1/people?personIds={ids_str}"
                resp = requests.get(url, timeout=15)
                resp.raise_for_status()
                for person in resp.json().get("people", []):
                    _batter_name_cache[person["id"]] = person.get("fullName", "")
            except Exception:
                pass  # fail silently, names just stay empty
        # Fill any still-missing with empty string
        for bid in missing:
            if bid not in _batter_name_cache:
                _batter_name_cache[bid] = ""
        # Persist to Redis
        redis_set("batter_names", {str(k): v for k, v in _batter_name_cache.items()})
    return batter_ids.map(lambda x: _batter_name_cache.get(int(x), "") if pd.notna(x) and int(x) > 0 else "")

def _assign_teams_vectorized(df):
    """Vectorized pitcher_team/opponent assignment based on inning_topbot."""
    if "inning_topbot" not in df.columns or "home_team" not in df.columns:
        return df
    is_top = df["inning_topbot"] == "Top"
    computed_team = np.where(is_top, df["home_team"], df["away_team"])
    computed_opp = np.where(is_top, df["away_team"], df["home_team"])
    if "pitcher_team" not in df.columns:
        df["pitcher_team"] = computed_team
        df["opponent"] = computed_opp
    else:
        # Fill NaN values (e.g. Savant rows after concat with MLB API rows)
        df["pitcher_team"] = df["pitcher_team"].fillna(pd.Series(computed_team, index=df.index))
        df["opponent"] = df["opponent"].fillna(pd.Series(computed_opp, index=df.index))
    return df

def _fetch_from_savant(date_str):
    """Fetch one day's pitches from the Savant CSV endpoint.

    Returns an empty DataFrame only when Savant POSITIVELY reports no rows
    for the date; returns None when the fetch FAILED (network/5xx/parse) so
    callers never mistake an outage for a gameless day.
    """
    url = SAVANT_CSV_URL.format(date=date_str)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=60)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            return pd.DataFrame()
        return pd.read_csv(io.StringIO(content), low_memory=False)
    except Exception as e:
        print(f"Error fetching from Baseball Savant for {date_str}: {e}")
        return None

MLB_GAME_FEED_URL = "https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"

# Map MLB Stats API pitch descriptions to Baseball Savant format
_MLB_DESC_MAP = {
    "Called Strike": "called_strike",
    "Swinging Strike": "swinging_strike",
    "Swinging Strike (Blocked)": "swinging_strike_blocked",
    "Foul": "foul",
    "Foul Tip": "foul_tip",
    "Foul Bunt": "foul_bunt",
    "Missed Bunt": "missed_bunt",
    "Bunt Foul Tip": "bunt_foul_tip",
    "Ball": "ball",
    "Ball In Dirt": "ball",
    "Hit By Pitch": "hit_by_pitch",
    "In play, no out": "hit_into_play",
    "In play, out(s)": "hit_into_play",
    "In play, run(s)": "hit_into_play",
    "Pitchout": "pitchout",
    "Automatic Ball": "ball",
    "Automatic Strike": "called_strike",
    "Intent Ball": "ball",
    "Intentional Ball": "ball",
}

def _normalize_mlb_description(raw_desc):
    """Convert MLB API description to Savant-format description."""
    return _MLB_DESC_MAP.get(raw_desc, raw_desc.lower().replace(" ", "_") if raw_desc else "")

# MLB API details.code uses granular codes; Savant collapses to B/S/X
_MLB_TYPE_MAP = {
    "B": "B",   # Ball
    "C": "S",   # Called Strike → Strike
    "S": "S",   # Swinging Strike → Strike
    "W": "S",   # Swinging Strike (Blocked) → Strike
    "F": "S",   # Foul → Strike
    "T": "S",   # Foul Tip → Strike
    "L": "S",   # Foul Bunt → Strike
    "M": "S",   # Missed Bunt → Strike
    "X": "X",   # In play
    "D": "X",   # In play (no out) — some API versions
    "E": "X",   # In play (run(s))
    "H": "B",   # Hit By Pitch → Ball
    "P": "B",   # Pitchout → Ball
    "I": "B",   # Intentional Ball → Ball
    "V": "B",   # Automatic Ball → Ball
    "A": "S",   # Automatic Strike → Strike
    "*B": "B",  # Automatic Ball (alternate code) → Ball
    "*S": "S",  # Automatic Strike (alternate code) → Strike
}

def _normalize_mlb_type_code(code):
    """Convert MLB API details.code to Savant-format type (B/S/X)."""
    return _MLB_TYPE_MAP.get(code, code)

# MLB API event names to Savant format
_MLB_EVENT_MAP = {
    "Single": "single",
    "Double": "double",
    "Triple": "triple",
    "Home Run": "home_run",
    "Walk": "walk",
    "Intentional Walk": "walk",
    "Hit By Pitch": "hit_by_pitch",
    "Strikeout": "strikeout",
    "Strikeout Double Play": "strikeout_double_play",
    "Field Out": "field_out",
    "Flyout": "field_out",
    "Groundout": "field_out",
    "Lineout": "field_out",
    "Pop Out": "field_out",
    "Forceout": "force_out",
    "Force Out": "force_out",
    "Grounded Into DP": "grounded_into_double_play",
    "Double Play": "double_play",
    "Fielders Choice": "fielders_choice",
    "Fielders Choice Out": "fielders_choice_out",
    "Field Error": "field_error",
    "Sac Fly": "sac_fly",
    "Sac Bunt": "sac_bunt",
    "Sac Fly Double Play": "sac_fly_double_play",
    "Triple Play": "triple_play",
    "Catcher Interf": "catcher_interf",
    "Runner Out": "runner_out",
    "Caught Stealing 2B": "caught_stealing_2b",
    "Caught Stealing 3B": "caught_stealing_3b",
    "Caught Stealing Home": "caught_stealing_home",
    "Pickoff 1B": "pickoff_1b",
    "Pickoff 2B": "pickoff_2b",
    "Batter Interference": "batter_interference",
}

def _normalize_mlb_event(raw_event):
    """Convert MLB API event name to Savant-format event."""
    if not raw_event:
        return ""
    return _MLB_EVENT_MAP.get(raw_event, raw_event.lower().replace(" ", "_"))


_BASE_END_LABELS = {"1B": "1st", "2B": "2nd", "3B": "3rd"}


def _runner_wp_pb_reason(runner):
    """Return "Wild Pitch" / "Passed Ball" if this runner's movement was
    caused by one of those events; otherwise None."""
    details = runner.get("details", {}) or {}
    # Primary signals: details.event ("Wild Pitch") and details.eventType
    # ("wild_pitch"). movementReason carries a per-runner hint sometimes
    # prefixed with "r_" (e.g. "r_wild_pitch", "r_passed_ball").
    ev = str(details.get("event") or details.get("eventType") or "").lower().replace(" ", "_")
    reason = str(details.get("movementReason") or "").lower()
    if reason.startswith("r_"):
        reason = reason[2:]
    if ev == "wild_pitch" or reason == "wild_pitch":
        return "Wild Pitch"
    if ev == "passed_ball" or reason == "passed_ball":
        return "Passed Ball"
    return None


def _extract_wp_pb_moves(play_events):
    """Scan a PA's play_events for mid-PA wild-pitch / passed-ball actions and
    return { (runner_id, end_base): "Wild Pitch"|"Passed Ball" }. Used as a
    fallback when pa.runners' details.event doesn't carry the cause."""
    moves = {}
    for ev in play_events or []:
        det = ev.get("details", {}) or {}
        et = str(det.get("eventType") or "").lower()
        if et not in ("wild_pitch", "passed_ball"):
            continue
        reason = "Wild Pitch" if et == "wild_pitch" else "Passed Ball"
        for r in ev.get("runners", []) or []:
            runner_id = r.get("details", {}).get("runner", {}).get("id")
            end = r.get("movement", {}).get("end")
            if runner_id is not None and end:
                moves[(runner_id, end)] = reason
    return moves


def _enrich_pa_description(desc, runners, include_plain=False, play_events=None):
    """Enrich a PA description with runner-movement sentences.

    - Upgrades plain "X to 2nd." to "X advances to 2nd on Wild Pitch." (or
      Passed Ball) for any runner whose movement was caused by a WP/PB. Runs
      for every PA so mid-PA WP/PB advances get annotated regardless of how
      the PA ended.
    - When include_plain=True (walk/HBP PAs), appends missing plain "X to
      Nth." sentences so the description always lists all base movements.
    - If play_events is provided, mid-PA WP/PB actions are cross-referenced
      to catch cases where pa.runners' details.event points at the PA event
      instead of the specific mid-PA cause.
    """
    if not runners:
        return desc or ""
    desc = desc or ""
    wp_pb_moves = _extract_wp_pb_moves(play_events)
    append_list = []
    for runner in runners:
        mv = runner.get("movement", {}) or {}
        origin = mv.get("originBase")
        end = mv.get("end")
        if not origin:
            continue
        details = runner.get("details", {}) or {}
        name = details.get("runner", {}).get("fullName", "")
        if not name:
            continue
        wp_pb = _runner_wp_pb_reason(runner)
        if not wp_pb:
            runner_id = details.get("runner", {}).get("id")
            wp_pb = wp_pb_moves.get((runner_id, end)) if runner_id is not None else None
        if end == "score":
            plain = f"{name} scores."
            annotated = f"{name} scores on {wp_pb}." if wp_pb else None
        elif end in _BASE_END_LABELS:
            label = _BASE_END_LABELS[end]
            plain = f"{name} to {label}."
            annotated = f"{name} advances to {label} on {wp_pb}." if wp_pb else None
        else:
            continue

        if wp_pb and annotated:
            if annotated.lower() in desc.lower():
                continue  # already annotated
            pattern = re.compile(re.escape(plain), re.IGNORECASE)
            if pattern.search(desc):
                desc = pattern.sub(annotated, desc, count=1)
            else:
                append_list.append(annotated)
        elif include_plain:
            if plain.lower() not in desc.lower():
                append_list.append(plain)

    if append_list:
        desc = desc.rstrip()
        if desc and not desc.endswith("."):
            desc += "."
        joiner = "  " if desc else ""
        desc = f"{desc}{joiner}" + "  ".join(append_list)
    return desc

def _fetch_game_from_mlb_api(game_pk, date_str):
    """Fetch pitch-by-pitch data from MLB Stats API for a single game.
    Returns a DataFrame in the same column format as Savant data.
    Uses _get_game_feed for caching (final games cached forever in Redis)."""
    try:
        # Reuse the cached feed/live response — _get_game_feed handles
        # both in-memory and Redis caching, with permanent caching for
        # final games. This is critical for AA-and-below PBP fetches
        # where the same games may be queried for many pitchers.
        data = _get_game_feed(game_pk)
        if not data:
            return pd.DataFrame()

        game_data = data.get("gameData", {})
        teams = game_data.get("teams", {})
        home_abbrev = teams.get("home", {}).get("abbreviation", "")
        away_abbrev = teams.get("away", {}).get("abbreviation", "")
        # `gameData.game.type` carries the actual game type (R, S, P, A...).
        # Defaults to R for unknown so non-MLB games (AA, etc.) don't get
        # mis-tagged as Spring Training.
        game_type_code = (game_data.get("game", {}) or {}).get("type", "R")
        players = game_data.get("players", {})

        rows = []
        # Track base state across PAs by processing runner movements
        bases = {1: None, 2: None, 3: None}  # base number → runner ID or None
        prev_half = None  # (inning, isTop) to detect half-inning changes

        all_plays = data.get("liveData", {}).get("plays", {}).get("allPlays", [])
        for pa in all_plays:
            batter_id = pa.get("matchup", {}).get("batter", {}).get("id")
            pitcher_id = pa.get("matchup", {}).get("pitcher", {}).get("id")
            pitcher_name = pa.get("matchup", {}).get("pitcher", {}).get("fullName", "")
            pitcher_hand = pa.get("matchup", {}).get("pitchHand", {}).get("code", "")
            bat_side = pa.get("matchup", {}).get("batSide", {}).get("code", "")
            about = pa.get("about", {})
            is_top = about.get("isTopInning", True)
            inning = about.get("inning", 0)
            inning_topbot = "Top" if is_top else "Bot"

            # Clear bases on half-inning change
            cur_half = (inning, is_top)
            if cur_half != prev_half:
                bases = {1: None, 2: None, 3: None}
                prev_half = cur_half

            # Snapshot base state at start of this PA (before any movements)
            pa_on_1b = bases[1]
            pa_on_2b = bases[2]
            pa_on_3b = bases[3]

            # Result info — normalize to Savant format
            ab_result = _normalize_mlb_event(pa.get("result", {}).get("event", ""))
            ab_desc = pa.get("result", {}).get("description", "")

            # Annotate WP/PB-caused runner movements on every PA, and also
            # ensure walk/HBP PAs list all base movements (the MLB API
            # description usually has them, but not always).
            ab_desc = _enrich_pa_description(
                ab_desc,
                pa.get("runners"),
                include_plain=ab_result in ("walk", "hit_by_pitch"),
                play_events=pa.get("playEvents"),
            )

            at_bat_number = about.get("atBatIndex", 0)
            outs_when_up = pa.get("count", {}).get("outs", 0) if pa.get("count") else about.get("outs", 0)

            # Hit data — could be on the PA level or on the last playEvent
            hit_data = pa.get("hitData") or {}
            if not hit_data:
                # Check last playEvent for hitData
                play_events_all = pa.get("playEvents", [])
                if play_events_all:
                    hit_data = play_events_all[-1].get("hitData") or {}
            pa_launch_speed = hit_data.get("launchSpeed")
            pa_launch_angle = hit_data.get("launchAngle")
            pa_hc_x = hit_data.get("coordinates", {}).get("coordX")
            pa_hc_y = hit_data.get("coordinates", {}).get("coordY")

            # Collect pitch events; only last pitch gets the PA result (like Savant)
            pitch_events = [e for e in pa.get("playEvents", []) if e.get("isPitch")]
            # Intentional-/automatic-ball "pitches" (no pitch actually thrown)
            # are dropped downstream in _postprocess_pitch_df by their
            # normalized description ('automatic_ball' / 'intent_ball'), which
            # works for both this MLB API path and the Savant path.
            cur_balls = 0
            cur_strikes = 0
            for idx, event in enumerate(pitch_events):
                is_last_pitch = (idx == len(pitch_events) - 1)
                details = event.get("details", {})
                pitch_data = event.get("pitchData", {})
                coords = pitch_data.get("coordinates", {})
                breaks = pitch_data.get("breaks", {})

                # Normalize MLB API description to Savant format
                raw_desc = details.get("description", "")
                norm_desc = _normalize_mlb_description(raw_desc)

                row = {
                    "game_pk": game_pk,
                    "game_date": date_str,
                    "player_name": pitcher_name,
                    "pitcher": pitcher_id,
                    "batter": batter_id,
                    "stand": bat_side,
                    "p_throws": pitcher_hand,
                    "pitch_type": details.get("type", {}).get("code", ""),
                    "release_speed": pitch_data.get("startSpeed"),
                    "release_extension": pitch_data.get("extension"),
                    "plate_x": coords.get("pX"),
                    "plate_z": coords.get("pZ"),
                    # Savant stores pfx_x/pfx_z in feet; MLB API gives inches — convert
                    # Negate breakHorizontal: MLB API sign convention is opposite to Savant's pfx_x
                    "pfx_x": -breaks.get("breakHorizontal") / 12 if breaks.get("breakHorizontal") is not None else None,
                    "pfx_z": breaks.get("breakVerticalInduced") / 12 if breaks.get("breakVerticalInduced") is not None else None,
                    # Velocity/acceleration for HAVAA calculation
                    "vx0": coords.get("vX0"),
                    "vy0": coords.get("vY0"),
                    "vz0": coords.get("vZ0"),
                    "ax": coords.get("aX"),
                    "ay": coords.get("aY"),
                    "az": coords.get("aZ"),
                    # Release position for arm angle
                    "release_pos_x": coords.get("x0"),
                    "release_pos_z": coords.get("z0"),
                    "sz_top": pitch_data.get("strikeZoneTop"),
                    "sz_bot": pitch_data.get("strikeZoneBottom"),
                    "zone": pitch_data.get("zone"),
                    "description": norm_desc,
                    "type": _normalize_mlb_type_code(details.get("code", "")),  # Normalized to B/S/X
                    "home_team": home_abbrev,
                    "away_team": away_abbrev,
                    "inning": inning,
                    "inning_topbot": inning_topbot,
                    "events": ab_result if is_last_pitch else "",
                    "des": ab_desc if is_last_pitch else "",
                    "runs_scored": _count_runs_in_desc(ab_desc, ab_result) if is_last_pitch else 0,
                    "game_type": game_type_code,
                    # Hit data (only meaningful on last pitch of PA)
                    "launch_speed": pa_launch_speed if is_last_pitch else None,
                    "launch_angle": pa_launch_angle if is_last_pitch else None,
                    "hc_x": pa_hc_x if is_last_pitch else None,
                    "hc_y": pa_hc_y if is_last_pitch else None,
                    # Context fields for hover tooltips
                    "at_bat_number": at_bat_number,
                    "pitch_number": idx + 1,
                    "outs_when_up": outs_when_up,
                    "batter_name": pa.get("matchup", {}).get("batter", {}).get("fullName", ""),
                    "balls": cur_balls,
                    "strikes": cur_strikes,
                    "on_1b": pa_on_1b,
                    "on_2b": pa_on_2b,
                    "on_3b": pa_on_3b,
                }
                rows.append(row)

                # Update count for next pitch. Codes mirror _MLB_TYPE_MAP:
                # balls = B/H/P/I/V/*B, strikes = C/S/W/F/T/L/M/A/*S, in-play = X/D/E.
                # ("F" = foul, "W" = swinging strike blocked — both were missing
                # previously, which left cur_strikes stuck at <2 for affected PAs
                # and made PAR% denominators wildly under-counted.)
                code = details.get("code", "")
                if code in ("B", "H", "P", "I", "V", "*B"):
                    cur_balls = min(cur_balls + 1, 4)
                elif code in ("C", "S", "W", "F", "T", "L", "M", "A", "*S"):
                    cur_strikes = min(cur_strikes + 1, 2)

            # After this PA: update base state from runner movements
            _BASE_MAP = {"1B": 1, "2B": 2, "3B": 3}
            for runner in pa.get("runners", []):
                mv = runner.get("movement", {})
                origin = mv.get("originBase")
                end = mv.get("end")
                runner_id = runner.get("details", {}).get("runner", {}).get("id")
                # Clear the origin base
                if origin in _BASE_MAP:
                    bases[_BASE_MAP[origin]] = None
                # Set the end base (None/empty means scored or out)
                if end in _BASE_MAP:
                    bases[_BASE_MAP[end]] = runner_id

        return pd.DataFrame(rows) if rows else pd.DataFrame()
    except Exception as e:
        print(f"MLB API game feed error for {game_pk}: {e}")
        return pd.DataFrame()

def _fetch_missing_from_mlb_api(date_str, savant_pks, levels=STATCAST_LEVELS):
    """Fetch pitch data from the MLB live feed for games missing from Savant.

    This is the coverage backstop: AAA live feeds carry full pitchData (velo,
    spin, IVB, extension) and hitData, so a game the minors CSV skipped still
    produces a complete card. It spans every Statcast level, so an AFL game the
    CSV has no rows for (the normal case — Savant publishes no AFL Statcast)
    comes through here too.
    """
    schedule = []
    for code in levels:
        schedule.extend(_get_mlb_schedule(date_str, level=code) or [])
    if not schedule:
        return pd.DataFrame()

    missing_pks = [g["game_pk"] for g in schedule if g["game_pk"] not in savant_pks]
    if not missing_pks:
        return pd.DataFrame()

    print(f"Fetching {len(missing_pks)} games from MLB Stats API fallback...")
    dfs = []
    with ThreadPoolExecutor(max_workers=10) as pool:
        futures = {pool.submit(_fetch_game_from_mlb_api, pk, date_str): pk for pk in missing_pks}
        for f in as_completed(futures):
            try:
                gdf = f.result()
                if not gdf.empty:
                    dfs.append(gdf)
            except Exception as e:
                print(f"MLB API fallback error for game {futures[f]}: {e}")
    return pd.concat(dfs, ignore_index=True) if dfs else pd.DataFrame()


# A live foul ball never ends a plate appearance, so a pitch tagged "foul"
# that the feed also marks as the strikeout-ending pitch must really have been
# a caught foul tip — which is a whiff. GUMBO and Savant disagree on this label
# for the very same pitch (GUMBO -> foul_tip, Savant -> foul), which is what
# made the card show 12 whiffs and the game log 11. Normalizing here, on the
# one column both feeds share (events + description), makes whiff/CSW counts
# identical across sources. This only PROMOTES foul -> foul_tip (never demotes
# a real foul_tip), so "all foul_tip = whiff" still holds.
_STRIKEOUT_EVENTS = frozenset(["strikeout", "strikeout_double_play"])


def _reclassify_strikeout_fouls(df):
    if df is None or df.empty or "events" not in df.columns or "description" not in df.columns:
        return df
    events = df["events"].astype(str).str.lower()
    mask = events.isin(_STRIKEOUT_EVENTS) & (df["description"] == "foul")
    if mask.any():
        df.loc[mask, "description"] = "foul_tip"
        if "type" in df.columns:
            df.loc[mask, "type"] = "S"  # a foul tip is a strike
    return df


def _apply_levels(df, date_str):
    """Tag every row with its level and drop rows outside the Statcast levels.

    The minors CSV has no level column and returns every tracked minors park for
    the date — on 2026-07-30 that's the 18 AAA games PLUS 5 Single-A Florida
    State League games. Level comes from the per-level schedules; anything that
    isn't AAA/AFL (including an unmappable game_pk) is dropped here so no
    A-ball rows reach a pitch table, plot or card.
    """
    if df is None or df.empty or "game_pk" not in df.columns:
        return df
    mapping = get_game_level_map(date_str, levels=STATCAST_LEVELS)
    if not mapping:
        # Every schedule fetch failed — can't classify. Returning the frame
        # unfiltered would risk showing sub-AAA games as AAA, so drop it and let
        # the caller retry rather than cache a wrong answer.
        print(f"[Levels] no schedule for {date_str}; dropping {len(df)} unclassified pitch rows")
        return pd.DataFrame()
    pks = df["game_pk"].astype("Int64")
    df = df[pks.isin(list(mapping.keys()))].copy()
    if df.empty:
        return df
    df["level"] = df["game_pk"].map(lambda pk: mapping.get(int(pk)) if pd.notna(pk) else None)
    return df


def _apply_levels_multi_date(df):
    """Level-tag/filter a frame spanning MANY dates (range + per-pitcher season
    pulls), by resolving each distinct game_date against its own schedules."""
    if df is None or df.empty or "game_pk" not in df.columns or "game_date" not in df.columns:
        return df
    dates = sorted({str(d)[:10] for d in df["game_date"].dropna().unique()})
    mapping = {}
    for d in dates:
        mapping.update(get_game_level_map(d, levels=STATCAST_LEVELS))
    if not mapping:
        print(f"[Levels] no schedules across {len(dates)} dates; dropping {len(df)} pitch rows")
        return pd.DataFrame()
    pks = df["game_pk"].astype("Int64")
    df = df[pks.isin(list(mapping.keys()))].copy()
    if df.empty:
        return df
    df["level"] = df["game_pk"].map(lambda pk: mapping.get(int(pk)) if pd.notna(pk) else None)
    return df


def _postprocess_pitch_df(df, date_str=None):
    """Apply shared name/team/pitch-type normalization, level tagging, overrides."""
    if df is None or df.empty:
        return pd.DataFrame()

    df = df.copy()
    if date_str:
        df = _apply_levels(df, date_str)
        if df.empty:
            return df
    # Resolve batter IDs to names where batter_name is missing/empty
    if "batter" in df.columns:
        if "batter_name" not in df.columns:
            df["batter_name"] = _resolve_batter_names(df["batter"])
        else:
            missing_mask = (
                df["batter_name"].isna()
                | (df["batter_name"].astype(str).str.strip() == "")
                | (df["batter_name"].astype(str) == "nan")
            )
            if missing_mask.any():
                resolved = _resolve_batter_names(df.loc[missing_mask, "batter"])
                df.loc[missing_mask, "batter_name"] = resolved.values
    if "player_name" in df.columns:
        df["player_name"] = _fix_names_vectorized(df["player_name"])
    # Always map pitch_name from pitch_type codes for consistent naming
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df["pitch_name"] = df["pitch_name"].fillna("Unclassified")
    df = _assign_teams_vectorized(df)
    df = _drop_intentional_ball_rows(df)
    df = _reclassify_strikeout_fouls(df)
    return _apply_overrides(df)

def _is_today(date_str):
    """Check if the date string is today (US Eastern)."""
    try:
        return date_str == _get_today_str()
    except Exception:
        return False


_game_pitch_cache = {}  # { (date_str, game_pk): (timestamp, is_final, dataframe) }


def fetch_game_pitches(date_str, game_pk):
    """Fetch pitch data for a single game using the per-game feed when possible.

    This avoids rebuilding selected live-game views from the full day's pitch
    dataset. Live games use a short TTL; final games are cached indefinitely.
    """
    game_pk = int(game_pk)
    cache_key = (str(date_str), game_pk)
    if cache_key in _game_pitch_cache:
        ts, is_final, df = _game_pitch_cache[cache_key]
        if is_final or (time.time() - ts) < LIVE_CACHE_TTL:
            return df

    # Once the morning warmup has baked this date's Savant snapshot, serve the
    # card from it so the box score matches the Regular Season game log exactly
    # (both Savant, same numbers). Before the bake (today / live), fall through
    # to the MLB Stats API (GUMBO) so the card updates pitch-by-pitch. Snapshot
    # existence is the one switch both pipelines share. (The pre-existing
    # day-data fallback below already builds cards from this same shape, so
    # this is a well-trodden path — it just becomes the preferred one.)
    if not _is_today(date_str):
        snap = _load_range_day(date_str)
        if snap is not None and not snap.empty and "game_pk" in snap.columns:
            game_df = snap[snap["game_pk"] == game_pk].copy()
            if not game_df.empty:
                _game_pitch_cache[cache_key] = (time.time(), True, game_df)
                return game_df

    game_df = _fetch_game_from_mlb_api(game_pk, date_str)
    if game_df is not None and not game_df.empty:
        game_df = _postprocess_pitch_df(game_df, date_str)
        is_final = _is_game_final(_get_game_feed(game_pk))
        _game_pitch_cache[cache_key] = (time.time(), is_final, game_df)
        return game_df

    day_df = fetch_date(date_str)
    if day_df.empty or "game_pk" not in day_df.columns:
        empty = pd.DataFrame()
        _game_pitch_cache[cache_key] = (time.time(), False, empty)
        return empty
    game_df = day_df[day_df["game_pk"] == game_pk].copy()
    is_final = not _is_today(date_str)
    _game_pitch_cache[cache_key] = (time.time(), is_final, game_df)
    return game_df

def _day_confirmed_gameless(date_str):
    """True only when EVERY Statcast level's schedule POSITIVELY reports zero
    games for the date. A schedule fetch failure (None) means unknown — NOT
    gameless — so callers must not bake an empty range_day snapshot."""
    try:
        schedules = [_get_mlb_schedule(date_str, level=code) for code in STATCAST_LEVELS]
    except Exception:
        return False
    return all(s == [] for s in schedules)


def fetch_date(date_str):
    cache_key = date_str
    if cache_key in _cache:
        cached = _cache[cache_key]
        if isinstance(cached, tuple):
            ts, df = cached
            if _is_today(date_str) and (time.time() - ts) > LIVE_CACHE_TTL:
                pass  # cache expired, re-fetch below
            else:
                return df
        else:
            # Old-style cache entry (no timestamp) — return for past dates, re-fetch for today
            if not _is_today(date_str):
                return cached
            # else fall through to re-fetch

    is_today_date = _is_today(date_str)

    # Source-of-record depends on liveness, and the card + game log + data page
    # all flow through here so they agree at every moment:
    #   • TODAY (live): the MLB Stats API (GUMBO) is primary so every view
    #     updates pitch-by-pitch from one feed. Savant lags and silently
    #     re-tags pitches (e.g. foul vs foul_tip), so it is only a fallback for
    #     scheduled games GUMBO somehow lacks. The next-morning warmup bakes
    #     Savant for this date via the PAST path below, and from then on every
    #     view reads that one Savant snapshot.
    #   • PAST: Savant-first (the system of record the warmup bakes), with the
    #     MLB Stats API filling any games Savant is missing.
    # None from _fetch_from_savant means the fetch FAILED — not a gameless day.
    if is_today_date:
        primary = _fetch_missing_from_mlb_api(date_str, set())  # set() -> ALL scheduled games
        primary_pks = set(primary["game_pk"].unique()) if not primary.empty else set()
        missing_from_mlb = get_statcast_level_game_pks(date_str) - primary_pks
        savant_failed = False
        if missing_from_mlb or not primary_pks:
            savant_df = _fetch_from_savant(date_str)
            savant_failed = savant_df is None
            secondary = pd.DataFrame() if savant_failed else savant_df
            if not secondary.empty and primary_pks:
                secondary = secondary[~secondary["game_pk"].isin(primary_pks)]
        else:
            secondary = pd.DataFrame()  # GUMBO covered every scheduled game
    else:
        primary = _fetch_from_savant(date_str)
        savant_failed = primary is None
        primary = pd.DataFrame() if savant_failed else primary
        primary_pks = set(primary["game_pk"].unique()) if not primary.empty else set()
        secondary = _fetch_missing_from_mlb_api(date_str, primary_pks)

    # `secondary` is whichever feed backfills the gaps (MLB API on the PAST
    # path, Savant on the TODAY path). Align pitch_name/teams before concat so
    # columns line up; _postprocess_pitch_df below re-derives them anyway.
    if secondary is not None and not secondary.empty:
        if "pitch_type" in secondary.columns:
            secondary["pitch_name"] = secondary["pitch_type"].map(PITCH_TYPE_MAP).fillna("Unclassified")
        secondary = _assign_teams_vectorized(secondary)
    frames = [f for f in (primary, secondary) if f is not None and not f.empty]
    if not frames:
        df = pd.DataFrame()
    elif len(frames) == 1:
        df = frames[0]
    else:
        # Align columns before concat to avoid FutureWarning with empty/NA columns
        shared_cols = list(set(frames[0].columns) | set(frames[1].columns))
        df = pd.concat(
            [frames[0].reindex(columns=shared_cols), frames[1].reindex(columns=shared_cols)],
            ignore_index=True,
        )

    # Skip the Redis persist for TODAY's data. Today's snapshot was being
    # rewritten ~1440 times/day by the live-cards cron (~500 KB compressed
    # per write = ~720 MB/day inbound bandwidth) but nothing on the same
    # day ever READS it from Redis — fetch_date_range skips today (goes
    # straight to Savant), and user-facing fetch_date hits L1 directly.
    # The persisted snapshot is only useful tomorrow when range queries
    # start including this date, and the warmup-daily cron re-fetches and
    # persists the entire range fresh every morning at 5:30 AM ET — so the
    # archive shows up on time without paying for live updates we discard.
    # (is_today_date is computed above, where source-of-record is selected.)

    if df.empty:
        if savant_failed:
            # Savant errored and the MLB API had nothing either. Persist and
            # cache NOTHING so the next request retries — persisting here used
            # to write an empty 60-day range_day snapshot that silently deleted
            # the date from every season aggregate until the TTL expired.
            # (Today only: keep a TTL-bounded L1 entry so a Savant outage
            # during live hours doesn't hammer the endpoint every tick.)
            if is_today_date:
                _cache[cache_key] = (time.time(), pd.DataFrame())
            return pd.DataFrame()
        _cache[cache_key] = (time.time(), pd.DataFrame())
        if not is_today_date and _day_confirmed_gameless(date_str):
            _persist_range_day_snapshot(date_str, pd.DataFrame())
        return pd.DataFrame()

    df = _postprocess_pitch_df(df, date_str)
    if df is None or df.empty:
        # Everything was filtered out as non-Statcast (or unclassifiable).
        _cache[cache_key] = (time.time(), pd.DataFrame())
        return pd.DataFrame()
    _cache[cache_key] = (time.time(), df)
    if not is_today_date:
        _persist_range_day_snapshot(date_str, df)
    # Evict L1 boxscore/feed for today's live games so the next
    # _get_boxscore_stats / _get_game_feed call re-pulls fresh data from the
    # MLB API. We DON'T also redis_delete the L2 keys: live boxscores
    # aren't stored in Redis at all (only final ones are), and gamestate /
    # feed entries get overwritten on the very next write anyway — so the
    # explicit deletes were just burning Upstash commands on every
    # fetch_date(today) tick (~45 delete commands per minute during games).
    if is_today_date:
        for gpk in set(df["game_pk"].unique()) if not df.empty else []:
            _boxscore_cache.pop(int(gpk), None)
            _feed_cache.pop(int(gpk), None)
    return df

SAVANT_PITCHER_SEASON_URL = (
    "https://baseballsavant.mlb.com/statcast-search-minors/csv"
    "?all=true&type=details&player_type=pitcher"
    "&pitchers_lookup[]={pitcher_id}"
    "&game_date_gt={year}-03-20&game_date_lt={year}-11-01"
    "&min_pitches=0&min_results=0&min_pas=0&sort_col=pitches"
    "&player_event_sort=api_p_release_speed&sort_order=desc"
    "&minors=true&wbc=false"
)
# NOTE: player_type=pitcher is REQUIRED. Without it, Savant returns rows
# with player_name = the BATTER faced (default perspective), so
# compute_player_page would pick the most common batter as the pitcher's
# name (e.g. Slade Cecconi's page showed "Alex Bregman").

def _season_date_bounds(season_year):
    """Return the inclusive season window used for season-level pitch queries."""
    start_date = season_start(season_year)
    today = _get_today_str()
    season_end = f"{int(season_year)}-11-01"
    if today < start_date:
        return start_date, start_date
    return start_date, min(today, season_end)


def _season_cache_is_fresh(season_year, ts):
    """Past seasons are immutable — any cached frame is fresh forever. The
    in-progress season expires after SEASON_CACHE_TTL so new games appear."""
    try:
        if int(season_year) < int(get_baseball_date()[:4]):
            return True
    except (ValueError, TypeError):
        pass
    return (time.time() - ts) < SEASON_CACHE_TTL


def fetch_pitcher_season(pitcher_id, season_year):
    """Fetch all pitches for a pitcher in a given season. Cached (current-season
    frames refresh hourly so newly-completed games show up)."""
    cache_key = (pitcher_id, season_year)
    cached = _season_cache.get(cache_key)
    if cached is not None and _season_cache_is_fresh(season_year, cached[0]):
        return cached[1]
    url = SAVANT_PITCHER_SEASON_URL.format(pitcher_id=pitcher_id, year=season_year)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=90)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            _season_cache[cache_key] = (time.time(), pd.DataFrame())
            return _season_cache[cache_key][1]
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        # Apply the same postprocessing as fetch_date so downstream consumers
        # (game log opponent column, season-averages aggregation, etc.) see
        # pitcher_team/opponent/pitch_name/overrides — not raw Savant columns.
        # Season pulls span many dates, so level tagging goes through the
        # multi-date resolver rather than _postprocess_pitch_df's single-date one.
        if not df.empty:
            df = _postprocess_pitch_df(df)
            df = _apply_levels_multi_date(df)
        else:
            df = pd.DataFrame()
        _season_cache[cache_key] = (time.time(), df if df is not None and not df.empty else pd.DataFrame())
        return _season_cache[cache_key][1]
    except Exception as e:
        print(f"Error fetching season data for pitcher {pitcher_id}, year {season_year}: {e}")
        # On a transient fetch failure keep any previously-cached frame rather
        # than poisoning the cache with an empty one (which would hide all the
        # pitcher's games until the next TTL expiry).
        if cached is not None:
            _season_cache[cache_key] = (time.time(), cached[1])
            return cached[1]
        _season_cache[cache_key] = (time.time(), pd.DataFrame())
        return _season_cache[cache_key][1]

_range_cache = {}  # { "start_end": (timestamp, dataframe) }
RANGE_CACHE_TTL = 3600  # 1 hour

# ── Aggregation result cache ──
# Caches the final JSON-serializable results from aggregation functions
# so repeated leaderboard/team/player requests skip re-aggregation.
_agg_cache = {}  # { "agg_key": (timestamp, result_list) }
AGG_CACHE_TTL = 3600  # matches range cache TTL
LIVE_CARD_CACHE_TTL = 60  # today's live game cards should track live feeds closely
LIVE_GAME_VIEW_CACHE_TTL = 60  # selected live-game tables should stay close to the card view
_CARD_CACHE_KEY_RE      = re.compile(r"^card_\d{4}-\d{2}-\d{2}_(\d+)_")
_PLAYER_CACHE_KEY_RE    = re.compile(r"^player_v2_(\d+)_")
_SEASON_TOTALS_KEY_RE   = re.compile(r"^season_totals_(\d+)_")
_SEASON_AVG_KEY_RE      = re.compile(r"^season_avg(?:_fb)?_(\d+)_")
_CARD_EXTRAS_KEY_RE     = re.compile(r"^card_extras_(\d+)_")

SAVANT_RANGE_URL = (
    "https://baseballsavant.mlb.com/statcast-search-minors/csv"
    "?hfPT=&hfAB=&hfGT=R%7CPO%7C&hfPR=&hfZ=&hfStadium=&hfBBL=&hfNewZones="
    "&hfPull=&hfC=&hfSea=&hfSit=&player_type=pitcher&hfOuts=&hfOpponent="
    "&pitcher_throws=&batter_stands=&hfSA=&game_date_gt={start}&game_date_lt={end}"
    "&hfMo=&hfTeam=&home_road=&hfRO=&position=&hfInfield=&hfOutfield="
    "&hfInn=&hfBBT=&hfFlag=&hfLevel=&metric_1=&group_by=name&min_pitches=0"
    "&min_results=0&min_pas=0&sort_col=pitches&player_event_sort=api_p_release_speed"
    "&sort_order=desc&type=details&all=true&minors=true&wbc=false"
)


def _transform_range_df(df):
    """Apply standard transforms to a range DataFrame (names, pitch mapping, teams)."""
    df = df.copy()
    if "player_name" in df.columns:
        df["player_name"] = _fix_names_vectorized(df["player_name"])
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df["pitch_name"] = df["pitch_name"].fillna("Unclassified")
    df = _assign_teams_vectorized(df)
    df = _drop_intentional_ball_rows(df)
    df = _reclassify_strikeout_fouls(df)
    df = _apply_levels_multi_date(df)
    if df is None or df.empty:
        return pd.DataFrame()
    df = _apply_overrides(df)
    return df


def _fetch_savant_range_chunk(start_date, end_date):
    """Fetch a single chunk of CSV from Savant. Returns raw DataFrame."""
    url = SAVANT_RANGE_URL.format(start=start_date, end=end_date)
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    try:
        resp = requests.get(url, headers=headers, timeout=120)
        resp.raise_for_status()
        content = resp.content.decode("utf-8")
        if not content.strip() or "No Results" in content[:200]:
            return pd.DataFrame()
        df = pd.read_csv(io.StringIO(content), low_memory=False)
        if df.empty:
            return pd.DataFrame()
        return df
    except Exception as e:
        # None = chunk FAILED (≠ empty) — the range caller must not treat the
        # chunk's days as gameless.
        print(f"Error fetching date range {start_date} to {end_date}: {e}")
        return None


def _fetch_savant_range_raw(start_date, end_date):
    """Fetch raw CSV from Savant for a date range, chunking into weekly intervals
    to avoid the 25,000 row cap per request.

    Returns (df, complete) — complete is False when any chunk FAILED, so the
    caller must not backfill the range's missing days as empty snapshots.
    """
    from datetime import datetime, timedelta
    start_dt = datetime.strptime(start_date, "%Y-%m-%d")
    end_dt = datetime.strptime(end_date, "%Y-%m-%d")
    chunk_days = 5  # ~5 days per chunk keeps well under 25k rows
    frames = []
    complete = True
    cur = start_dt
    while cur <= end_dt:
        chunk_end = min(cur + timedelta(days=chunk_days - 1), end_dt)
        cs = cur.strftime("%Y-%m-%d")
        ce = chunk_end.strftime("%Y-%m-%d")
        print(f"Fetching Savant chunk {cs} to {ce}...")
        chunk_df = _fetch_savant_range_chunk(cs, ce)
        if chunk_df is None:
            complete = False
        elif not chunk_df.empty:
            frames.append(chunk_df)
        cur = chunk_end + timedelta(days=1)
    if not frames:
        return pd.DataFrame(), complete
    combined = pd.concat(frames, ignore_index=True)
    # Deduplicate in case of overlap
    if "game_pk" in combined.columns and "at_bat_number" in combined.columns and "pitch_number" in combined.columns:
        combined = combined.drop_duplicates(subset=["game_pk", "at_bat_number", "pitch_number"], keep="first")
    print(f"Savant range total: {len(combined)} rows across {combined['game_date'].nunique() if 'game_date' in combined.columns else '?'} dates")
    return combined, complete


def _range_day_key(date_str):
    return f"{RANGE_DAY_PREFIX}:{date_str}:lvl{STATCAST_SCOPE}:s{CARD_SCHEMA_VERSION}"


def _materialize_range_token(start_date, end_date):
    return f"{start_date}:{end_date}"


def _materialize_status_key(start_date, end_date):
    return f"materialize:status:{start_date}:{end_date}"


# Materialization is QUEUED into Redis and drained by the
# /api/cron/materialize-ranges cron. It cannot run in a background thread here:
# a Vercel function is frozen once its response is sent, so the thread may never
# finish, and per-instance state would be invisible to the next invocation.
def get_range_materialization_status(start_date, end_date):
    status = redis_get(_materialize_status_key(start_date, end_date))
    if status:
        return status
    if range_is_materialized(start_date, end_date):
        return {"status": "ready"}
    if not redis_available():
        return {"status": "error", "error": "Season cache rebuild is unavailable because Redis is not configured."}
    return {"status": "pending"}


def queue_range_materialization(start_date, end_date):
    # Runs on every 202 (_loading_response -> here), so this check must stay
    # cheap — it used to load the whole season to answer "is it ready?".
    if range_is_materialized(start_date, end_date):
        redis_set(_materialize_status_key(start_date, end_date), {"status": "ready"}, ttl=MATERIALIZE_STATUS_TTL)
        return {"status": "ready", "queued": False}
    if not redis_available():
        return {
            "status": "error",
            "queued": False,
            "error": "Season cache rebuild is unavailable because Redis is not configured.",
        }
    current = redis_get(_materialize_status_key(start_date, end_date)) or {}
    if current.get("status") in ("pending", "running"):
        # A job whose function was killed mid-run leaves its status on
        # "running" with no further heartbeat. Without this check that state is
        # terminal: the guard below keeps returning "running", the token is
        # never re-queued, and every range-backed endpoint 202s forever. Treat a
        # silent job as dead and let it be picked up again.
        beat = current.get("heartbeat")
        stale = beat is None or (time.time() - float(beat)) > MATERIALIZE_STALE_AFTER
        if not stale:
            return {**current, "queued": False}
        print(f"[Materialize] {start_date}:{end_date} looks stuck (no heartbeat) — re-queuing")
        redis_sadd(MATERIALIZE_PENDING_KEY, _materialize_range_token(start_date, end_date),
                   ttl=MATERIALIZE_STATUS_TTL)
        payload = {"status": "pending", "heartbeat": time.time()}
        redis_set(_materialize_status_key(start_date, end_date), payload, ttl=MATERIALIZE_STATUS_TTL)
        return {**payload, "queued": True}
    payload = {"status": "pending"}
    redis_set(_materialize_status_key(start_date, end_date), payload, ttl=MATERIALIZE_STATUS_TTL)
    redis_sadd(MATERIALIZE_PENDING_KEY, _materialize_range_token(start_date, end_date), ttl=MATERIALIZE_STATUS_TTL)
    return {**payload, "queued": True}


def _df_to_records(df):
    if df is None or df.empty:
        return []
    return json.loads(df.to_json(orient="records", date_format="iso"))


def _records_to_df(records):
    if not records:
        return pd.DataFrame()
    return pd.DataFrame.from_records(records)


# Upstash REST API caps SET request bodies at 10 MB. Raw JSON records for a
# regular-season day are 9-13 MB and were silently failing — the SDK raised
# "ERR max request size exceeded" inside redis_set's try/except, the caller
# saw nothing wrong, and reads then thought the day was unmaterialized.
# Gzip+base64 typically compresses the JSON 5-8x, so even the biggest days
# fit comfortably under 10 MB.
_GZ_MARKER = "__gz__"


def _compress_records(records):
    """Compress a records list to a Redis-storable wrapper dict.

    Wrapper shape: {"__gz__": True, "data": "<base64 of gzipped JSON>"}.
    The wrapper lets us round-trip through redis_set's json.dumps without a
    separate binary path, and lets _records_to_df_from_redis detect the
    compressed form without ambiguity (empty/legacy lists pass through as-is).
    """
    if not records:
        return []
    raw = json.dumps(records, separators=(",", ":"))
    gz = gzip.compress(raw.encode("utf-8"), compresslevel=6)
    b64 = base64.b64encode(gz).decode("ascii")
    return {_GZ_MARKER: True, "data": b64}


def _decompress_records(value):
    """Inverse of _compress_records. Accepts either a wrapper dict, a raw
    list (legacy uncompressed), or None. Returns a list of dict records."""
    if value is None:
        return None
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and value.get(_GZ_MARKER):
        try:
            gz = base64.b64decode(value["data"])
            raw = gzip.decompress(gz).decode("utf-8")
            return json.loads(raw)
        except Exception as e:
            print(f"[range_day] decompress error: {e}")
            return None
    return value


def _persist_range_day_snapshot(date_str, df):
    records = _df_to_records(df)
    payload = _compress_records(records) if records else []
    redis_set(_range_day_key(date_str), payload, ttl=RANGE_DAY_TTL)
    redis_sadd(f"{CACHE_INDEX_PREFIX}:date:{date_str}", _range_day_key(date_str), ttl=CACHE_INDEX_TTL)
    # Membership marker so missing_range_days can answer "is this day baked?"
    # with one SMEMBERS instead of loading every snapshot.
    _mark_range_day_baked(date_str)


def _date_strings(start_date, end_date):
    cur = datetime.strptime(start_date, "%Y-%m-%d")
    end = datetime.strptime(end_date, "%Y-%m-%d")
    while cur <= end:
        yield cur.strftime("%Y-%m-%d")
        cur += timedelta(days=1)


def _previous_date(date_str):
    return (datetime.strptime(date_str, "%Y-%m-%d") - timedelta(days=1)).strftime("%Y-%m-%d")


def _persist_range_day_snapshots(df, start_date=None, end_date=None, fill_missing=True):
    """Persist per-day snapshots for a range result.

    fill_missing=False skips writing empty snapshots for days absent from df
    (used when the upstream range fetch failed partway — absent then means
    "unknown", not "gameless"). Even when filling, a day is only written
    empty if the MLB schedule confirms it was actually gameless.
    """
    if df is None or df.empty or "game_date" not in df.columns:
        if start_date and end_date and fill_missing:
            for date_str in _date_strings(start_date, end_date):
                if _day_confirmed_gameless(date_str):
                    _persist_range_day_snapshot(date_str, pd.DataFrame())
        return
    seen = set()
    for date_str, day_df in df.groupby("game_date"):
        if date_str:
            normalized = str(date_str)
            seen.add(normalized)
            _persist_range_day_snapshot(normalized, day_df)
    if start_date and end_date and fill_missing:
        for date_str in _date_strings(start_date, end_date):
            if date_str not in seen and _day_confirmed_gameless(date_str):
                _persist_range_day_snapshot(date_str, pd.DataFrame())


_MISSING_RANGE_DAY = object()  # sentinel: a day's snapshot isn't in Redis


def _load_range_day(date_str):
    """Return the baked Savant snapshot DataFrame for a single date.

    Returns None when the date has NOT been materialized yet (the morning
    warmup hasn't run / nobody has loaded the range), an empty DataFrame when
    the date is materialized-but-gameless, and a populated DataFrame otherwise.
    This is the single artifact both the card and the game log key off: its
    presence is the moment the day "flips" from live GUMBO to baked Savant.
    """
    records = _decompress_records(redis_get(_range_day_key(date_str)))
    if records is None:
        return None  # not materialized
    if not records:
        return pd.DataFrame()  # materialized but gameless
    return _records_to_df(records)


def _load_persisted_range(start_date, end_date):
    # QUARANTINED — builds the whole range as one DataFrame. NO CALLERS outside
    # fetch_date_range / fetch_date_range_materialized, which are themselves
    # callerless. Over a season that frame is ~612k rows / ~1.3 GB against a
    # 3009 MB limit. Use fold_range_materialized (day at a time),
    # fetch_pitcher_rows_materialized (one pitcher) or range_is_materialized
    # (just the boolean). Pinned by tests/test_no_season_frame_on_request_paths.
    #
    # Per-key GETs. We tried batching with MGET (commit 3343975) to cut
    # Upstash command volume, but Upstash's REST response size cap (~5 MB)
    # means an MGET on even 2-3 full regular-season days raises — and the
    # exception path returned all-None, which made the caller think the
    # range wasn't materialized and triggered an endless re-fetch loop.
    # Per-key GETs are reliable; the volume hit is acceptable since cold
    # range loads are infrequent compared to the hot card / game-view path.
    #
    # The GETs are the slow part (~50+ round-trips for a full season), so issue
    # them with a bounded pool. pool.map preserves input order, so frames stay
    # in date order; each worker decompresses one day and drops the records as
    # soon as it returns its frame, keeping peak memory the same as the
    # sequential version while cutting cold-load latency ~5-8x.
    date_list = list(_date_strings(start_date, end_date))

    def _read_day(date_str):
        day = _load_range_day(date_str)
        if day is None:
            return _MISSING_RANGE_DAY  # not materialized
        if day.empty:
            return None  # materialized but gameless day — no frame
        return day

    # Cheap pre-check BEFORE loading anything. This path is not rare: it runs on
    # every 202, because _loading_response -> queue_range_materialization ->
    # fetch_date_range_materialized -> here. Loading a whole season of
    # decompressed Statcast only to discover day 57 is absent, return None and
    # throw it all away, is the single most expensive way to say "not ready".
    #
    # missing_range_days is one SMEMBERS. It can UNDER-report, though: the
    # membership marker was added later than the snapshots themselves, so a day
    # baked before it existed has a snapshot but no marker. Confirm with a
    # single real GET before trusting a "missing" verdict — one wasted GET on
    # the stale-marker path, versus ~110 on every 202 without this.
    probably_missing = missing_range_days(start_date, end_date)
    if probably_missing and _load_range_day(probably_missing[0]) is None:
        return None

    # Bail on the FIRST missing day rather than materializing every day and
    # checking afterwards. Submitting up front keeps the parallel fetch (the
    # round-trips are the slow part); consuming in date order stops frames
    # accumulating past the point the range is known incomplete. Reads already
    # running still finish — cancellation only reaches queued days — so this
    # bounds memory and latency, not GET count. The pre-check above is what
    # makes the common not-ready case cheap.
    pool = ThreadPoolExecutor(max_workers=8)
    try:
        futures = [pool.submit(_read_day, date_str) for date_str in date_list]
        frames = []
        for fut in futures:
            day = fut.result()
            if day is _MISSING_RANGE_DAY:
                return None
            if day is not None:
                frames.append(day)
    finally:
        # cancel_futures so an early return doesn't block on days we no longer
        # need; the default shutdown(wait=True) would wait for all of them.
        pool.shutdown(wait=False, cancel_futures=True)
    if not frames:
        return pd.DataFrame()
    return pd.concat(frames, ignore_index=True)


def _merge_daily_cache_for_day(day_df, date_str):
    """Per-day equivalent of _merge_daily_cache.

    Safe to do a day at a time because a game_pk belongs to exactly one
    game_date, so "which cached game_pks are absent from the range data" is a
    question that never spans days.
    """
    cached = _cache.get(date_str)
    cached_df = cached[1] if isinstance(cached, tuple) else cached
    if cached_df is None or cached_df.empty:
        return day_df
    if day_df is None or day_df.empty:
        return cached_df
    if "game_pk" not in day_df.columns or "game_pk" not in cached_df.columns:
        return day_df
    missing_pks = set(cached_df["game_pk"].unique()) - set(day_df["game_pk"].unique())
    if not missing_pks:
        return day_df
    extra = cached_df[cached_df["game_pk"].isin(missing_pks)]
    return pd.concat([day_df, extra], ignore_index=True)


# How many days to keep in flight. The Redis round-trips are the slow part, so
# reading strictly one day at a time would give back the ~5-8x the old parallel
# load bought. A bounded lookahead keeps most of that speedup while capping
# resident memory at (lookahead x one day) instead of the whole season.
RANGE_STREAM_LOOKAHEAD = 8


def fold_range_materialized(start_date, end_date, fold, skip_missing=False):
    """Stream a materialized range through `fold`, one day at a time.

    The memory-safe counterpart to fetch_date_range_materialized: same day set,
    same daily-cache merge, but it never builds a season-wide frame. A season is
    ~612k pitch rows — on the order of 1.3 GB as one frame, with a transient 2x
    during the concat, against a 3009 MB function limit.

    `fold(day_df)` is called once per day that has rows, in date order. Returns
    True when the range was complete, False when a day is not yet materialized
    (the caller should answer 202).

    `skip_missing=True` switches to best-effort: unmaterialized days are skipped
    instead of aborting, and the return is always True. That is the contract the
    pitcher directory's partial fallback wants — a roster assembled from
    whatever days exist beats no roster at all — and it must NOT be used by
    callers whose numbers would be silently wrong with days missing.
    """
    persisted_end = _previous_date(end_date) if _is_today(end_date) else end_date

    if persisted_end >= start_date:
        # Same cheap pre-check as _load_persisted_range: one SMEMBERS, and a
        # single confirming GET because the marker set can under-report.
        if not skip_missing:
            probably_missing = missing_range_days(start_date, persisted_end)
            if probably_missing and _load_range_day(probably_missing[0]) is None:
                return False

        date_list = list(_date_strings(start_date, persisted_end))
        pool = ThreadPoolExecutor(max_workers=RANGE_STREAM_LOOKAHEAD)
        try:
            pending = {}
            for idx, date_str in enumerate(date_list):
                # Top the queue up to the lookahead, then consume in date order.
                while len(pending) < RANGE_STREAM_LOOKAHEAD and (idx + len(pending)) < len(date_list):
                    ahead = date_list[idx + len(pending)]
                    pending[ahead] = pool.submit(_load_range_day, ahead)
                day = pending.pop(date_str).result()
                if day is None:
                    if skip_missing:
                        continue
                    return False  # not materialized — caller 202s
                day = _merge_daily_cache_for_day(day, date_str)
                if day is not None and not day.empty:
                    fold(day)
                del day
        finally:
            pool.shutdown(wait=False, cancel_futures=True)

    if _is_today(end_date):
        today_df = fetch_date(end_date)
        if today_df is not None and not today_df.empty:
            fold(today_df)
    return True


def _merge_daily_cache(df, start_date, end_date):
    """Merge any cached daily data into a range DataFrame.

    The daily cache (_cache) includes MLB API fallback data that the Savant
    range endpoint may not have (e.g., today's live games). This merges those
    extra game_pk rows into the range DataFrame so player pages show all games.
    """
    daily_frames = []
    for date_str, cached in _cache.items():
        if not isinstance(date_str, str):
            continue
        if date_str < start_date or date_str > end_date:
            continue
        if isinstance(cached, tuple):
            _, day_df = cached
        else:
            day_df = cached
        if day_df is not None and not day_df.empty:
            daily_frames.append(day_df)

    if not daily_frames:
        return df

    daily_all = pd.concat(daily_frames, ignore_index=True)
    if df.empty:
        return daily_all

    # Find game_pks in daily cache that are NOT in the range data
    range_pks = set(df["game_pk"].unique()) if "game_pk" in df.columns else set()
    daily_pks = set(daily_all["game_pk"].unique()) if "game_pk" in daily_all.columns else set()
    missing_pks = daily_pks - range_pks
    if not missing_pks:
        return df

    extra = daily_all[daily_all["game_pk"].isin(missing_pks)]
    merged = pd.concat([df, extra], ignore_index=True)
    return merged


def fetch_date_range(start_date, end_date):
    # QUARANTINED — see _load_persisted_range. NO CALLERS: this fetches and
    # concatenates the league's whole season. warmup_range_data used to call it
    # and now sweeps fetch_date(day) one day at a time instead.
    """Fetch all pitches across a date range from Savant, supplemented with daily cache."""
    cache_key = (start_date, end_date)
    if cache_key in _range_cache:
        ts, df = _range_cache[cache_key]
        if not _is_today(end_date) or (time.time() - ts) < RANGE_CACHE_TTL:
            # Past-date ranges never expire; today's data uses TTL-based refresh
            return _merge_daily_cache(df, start_date, end_date)

    persisted_end = _previous_date(end_date) if _is_today(end_date) else end_date
    persisted = None
    if persisted_end >= start_date:
        persisted = _load_persisted_range(start_date, persisted_end)
        if persisted is not None and not _is_today(end_date):
            _range_cache[cache_key] = (time.time(), persisted)
            return _merge_daily_cache(persisted, start_date, end_date)

    if _is_today(end_date) and persisted is not None:
        today_df = fetch_date(end_date)
        frames = [df for df in (persisted, today_df) if df is not None and not df.empty]
        df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        if not df.empty and "game_pk" in df.columns and "at_bat_number" in df.columns and "pitch_number" in df.columns:
            df = df.drop_duplicates(subset=["game_pk", "at_bat_number", "pitch_number"], keep="first")
        _range_cache[cache_key] = (time.time(), df)
        return _merge_daily_cache(df, start_date, end_date)

    df, fetch_complete = _fetch_savant_range_raw(start_date, end_date)
    if not df.empty:
        df = _transform_range_df(df)
        _persist_range_day_snapshots(df, start_date, end_date, fill_missing=fetch_complete)

    # Merge in any daily-cached data (includes MLB API fallback games)
    df = _merge_daily_cache(df if not df.empty else pd.DataFrame(), start_date, end_date)
    _persist_range_day_snapshots(df, start_date, end_date, fill_missing=fetch_complete)

    _range_cache[cache_key] = (time.time(), df)
    return df


def fetch_date_range_materialized(start_date, end_date):
    """QUARANTINED — see _load_persisted_range. NO CALLERS.

    Return a range DataFrame only from L1/Redis materialized data.
    Returns None when the range is not fully materialized, so user-facing
    endpoints can avoid synchronous Savant range recomputes."""
    cache_key = (start_date, end_date)
    if cache_key in _range_cache:
        ts, df = _range_cache[cache_key]
        if not _is_today(end_date) or (time.time() - ts) < RANGE_CACHE_TTL:
            return _merge_daily_cache(df, start_date, end_date)

    persisted_end = _previous_date(end_date) if _is_today(end_date) else end_date
    if persisted_end < start_date:
        persisted = pd.DataFrame()
    else:
        persisted = _load_persisted_range(start_date, persisted_end)
    if persisted is None:
        return None
    if _is_today(end_date):
        today_df = fetch_date(end_date)
        frames = [df for df in (persisted, today_df) if df is not None and not df.empty]
        persisted = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
        if not persisted.empty and "game_pk" in persisted.columns and "at_bat_number" in persisted.columns and "pitch_number" in persisted.columns:
            persisted = persisted.drop_duplicates(subset=["game_pk", "at_bat_number", "pitch_number"], keep="first")
    _range_cache[cache_key] = (time.time(), persisted)
    return _merge_daily_cache(persisted, start_date, end_date)


def fetch_pitcher_rows_materialized(pitcher_id, start_date, end_date):
    """One pitcher's rows across a materialized range, without the league frame.

    Same contract as fetch_date_range_materialized (None when a day is not
    baked) but it folds day by day and keeps only this pitcher's rows, so peak
    memory is one day plus one pitcher's season — a few thousand rows rather
    than ~612k. Concatenating at the end is safe precisely because the filter
    has already run.
    """
    try:
        pid = int(pitcher_id)
    except (TypeError, ValueError):
        return pd.DataFrame()

    mine = []

    def fold(day_df):
        if "pitcher" not in day_df.columns:
            return
        rows = day_df[day_df["pitcher"] == pid]
        if not rows.empty:
            mine.append(rows)

    if not fold_range_materialized(start_date, end_date, fold):
        return None
    return pd.concat(mine, ignore_index=True) if mine else pd.DataFrame()


def range_is_materialized(start_date, end_date):
    """Is this range fully baked? Answers the QUESTION without loading the data.

    Three callers only ever needed the boolean and were calling
    fetch_date_range_materialized for it, throwing away a whole season of
    decompressed Statcast to learn one bit. One of them
    (queue_range_materialization) runs on EVERY 202, which made "not ready yet"
    the single most expensive answer the backend could give.

    Cheap path first: if the marker set names a missing day, confirm that day
    with one real GET (the set can under-report). Otherwise fall back to EXISTS
    probes, stopping at the first hole, because the set can also over-report
    days whose snapshots have expired.
    """
    persisted_end = _previous_date(end_date) if _is_today(end_date) else end_date
    if persisted_end < start_date:
        return True  # nothing but today in the window; today is always live
    probably_missing = missing_range_days(start_date, persisted_end)
    if probably_missing and _load_range_day(probably_missing[0]) is None:
        return False
    return not unbaked_range_days(start_date, persisted_end, limit=1)


# Membership set of days that have a baked range_day snapshot.
#
# Existence has to be answered WITHOUT loading the snapshots: a season is ~110
# days of compressed Statcast, and pulling them just to ask "is this present?"
# is both slow and the exact memory profile that was OOM-killing the cron.
# One SMEMBERS answers it instead.
def _baked_days_key():
    return f"{RANGE_DAY_PREFIX}:baked:lvl{STATCAST_SCOPE}:s{CARD_SCHEMA_VERSION}"


def _mark_range_day_baked(date_str):
    try:
        redis_sadd(_baked_days_key(), date_str, ttl=RANGE_DAY_TTL)
    except Exception:
        pass


def missing_range_days(start_date, end_date):
    """Days in the window with no persisted range_day snapshot yet.

    CHEAP BUT NOT AUTHORITATIVE — one SMEMBERS, and it errs in BOTH directions:

      - it can UNDER-report, because the marker set postdates the snapshots, so
        a day baked before the set existed has a snapshot but no marker;
      - it can OVER-report a day as baked, because members outlive the thing
        they describe. Snapshots expire individually on RANGE_DAY_TTL, while
        the set's TTL is pushed forward by every new sadd, so the set keeps
        naming days whose snapshots are long gone.

    Use it to make the common case cheap, never to conclude that a range is
    complete — see unbaked_range_days for that.
    """
    try:
        baked = set(redis_smembers(_baked_days_key()) or [])
    except Exception:
        baked = set()
    return [
        day for day in _date_strings(start_date, end_date)
        # Today is fetched live and never baked, so it is never "missing".
        if not _is_today(day) and day not in baked
    ]


def unbaked_range_days(start_date, end_date, limit=None):
    """Days whose snapshot is ACTUALLY absent, verified with EXISTS.

    The authoritative counterpart to missing_range_days, for the one decision
    that must not be wrong: declaring a materialization job finished. Probes
    oldest-first because expiry reaches the oldest day first, and stops at
    `limit` hits so the "yes, something is missing" answer stays cheap.

    A day is only reported missing when Redis positively says the key is gone.
    An unreachable Redis yields no days, so a connection blip reads as "nothing
    to do" rather than triggering a full re-bake of the season.
    """
    found = []
    for day in _date_strings(start_date, end_date):
        if _is_today(day):
            continue  # fetched live, never baked
        if redis_exists(_range_day_key(day)) is False:
            found.append(day)
            if limit is not None and len(found) >= limit:
                break
    return found


# How many days one cron invocation will bake. A full season is ~134 days and
# each day costs a Savant pull plus a schedule lookup per Statcast level, so
# doing the whole range in one go blows the 300s function limit — the process
# is killed before it can write "ready" or clear the pending token, leaving the
# job stuck on "running" forever and every range-backed endpoint stuck on 202.
# Bounded slices make the work resumable: each tick advances it, and the
# 5-minute cron converges on a full season within a couple of hours.
MATERIALIZE_DAYS_PER_RUN = 12
# A job whose heartbeat is older than this is presumed dead (function killed
# mid-flight) and becomes eligible to run again.
MATERIALIZE_STALE_AFTER = 15 * 60


def drain_pending_materializations(max_jobs=1, deadline=None):
    """Advance Redis-backed materialization jobs INCREMENTALLY.

    Bakes at most MATERIALIZE_DAYS_PER_RUN missing days per call, writing a
    heartbeat as it goes, and only marks the job ready once no days are left.
    Safe to be killed at any point — the next tick picks up where this stopped,
    because progress lives in the per-day snapshots, not in the job record.
    """
    tokens = sorted(redis_smembers(MATERIALIZE_PENDING_KEY))
    drained = []
    for token in tokens[:max(1, int(max_jobs or 1))]:
        try:
            start_date, end_date = token.split(":", 1)
        except ValueError:
            redis_srem(MATERIALIZE_PENDING_KEY, token)
            continue
        status_key = _materialize_status_key(start_date, end_date)
        try:
            missing = missing_range_days(start_date, end_date)
            if not missing:
                # The marker set says complete — but it OVER-reports (see
                # missing_range_days), and this is the one place where
                # believing it is unrecoverable: the job would be marked ready
                # and dropped from the queue while the range is still full of
                # holes, and nothing re-queues it until the next daily warmup,
                # which would then be dequeued the same way. That is a silent
                # permanent stall, not a slow one. Confirm with real EXISTS.
                missing = unbaked_range_days(start_date, end_date)
            if not missing:
                redis_set(status_key, {"status": "ready"}, ttl=MATERIALIZE_STATUS_TTL)
                redis_srem(MATERIALIZE_PENDING_KEY, token)
                drained.append({"start_date": start_date, "end_date": end_date,
                                "status": "ready", "days_done": 0, "days_left": 0})
                continue

            baked = 0
            for day in missing[:MATERIALIZE_DAYS_PER_RUN]:
                if deadline is not None and time.time() >= deadline:
                    break
                try:
                    fetch_date(day)   # persists this day's range_day snapshot
                    baked += 1
                except Exception as e:
                    print(f"[Materialize] {day} failed: {e}")
                # Heartbeat after each day so a stuck job is detectable.
                redis_set(status_key, {
                    "status": "running",
                    "heartbeat": time.time(),
                    "days_left": max(0, len(missing) - baked),
                }, ttl=MATERIALIZE_STATUS_TTL)

            remaining = len(missing) - baked
            if remaining <= 0:
                # Arithmetic says done, which assumes every fetch_date that
                # didn't raise also persisted its snapshot. Confirm the same way
                # as above; limit=1 because all that matters here is whether ANY
                # day is still absent (so days_left reads as "at least 1").
                remaining = len(unbaked_range_days(start_date, end_date, limit=1))
            if remaining <= 0:
                redis_set(status_key, {"status": "ready"}, ttl=MATERIALIZE_STATUS_TTL)
                redis_srem(MATERIALIZE_PENDING_KEY, token)
                status = "ready"
            else:
                status = "running"
            drained.append({"start_date": start_date, "end_date": end_date,
                            "status": status, "days_done": baked, "days_left": max(0, remaining)})
        except Exception as e:
            message = str(e)[:500]
            redis_set(status_key, {"status": "error", "error": message}, ttl=MATERIALIZE_STATUS_TTL)
            redis_srem(MATERIALIZE_PENDING_KEY, token)
            drained.append({"start_date": start_date, "end_date": end_date, "status": "error", "error": message})
    return drained


def prefetch_boxscores(df, deadline=None):
    """Pre-fetch all boxscores for game_pks in df using parallel threads.

    When ``deadline`` (a ``time.time()`` epoch) is supplied, stop collecting
    results once it passes and shut the pool down WITHOUT waiting on in-flight
    fetches. This matters for hard-timeout callers (e.g. Vercel crons): a
    full-season ``df`` can carry 1000+ game_pks, and the default blocking
    ``ThreadPoolExecutor`` context manager (``shutdown(wait=True)``) would
    otherwise keep the function pinned on outstanding boxscore fetches well
    past the caller's budget — the exact shape that 504'd warmup-daily-2.
    With ``deadline=None`` the original blocking behavior is preserved, so
    callers that rely on completion are unaffected."""
    if df.empty or "game_pk" not in df.columns:
        return
    game_pks = [int(gpk) for gpk in df["game_pk"].unique()]
    # Filter out already-cached ones
    uncached = [gpk for gpk in game_pks if gpk not in _boxscore_cache]
    if not uncached:
        return
    print(f"Pre-fetching {len(uncached)} boxscores in parallel...")

    def _fetch_one(gpk):
        try:
            return gpk, _get_boxscore_stats(gpk)
        except Exception:
            return gpk, {}

    executor = ThreadPoolExecutor(max_workers=10)
    try:
        futures = {executor.submit(_fetch_one, gpk): gpk for gpk in uncached}
        for future in as_completed(futures):
            if deadline is not None and time.time() >= deadline:
                print("[prefetch_boxscores] Deadline hit, deferring remaining boxscores")
                break
            try:
                gpk, stats = future.result()
                # _get_boxscore_stats already populates _boxscore_cache
            except Exception:
                pass
    finally:
        # wait=False when bounded: never block on in-flight fetches past the
        # caller's budget (the serverless instance is frozen after we return).
        executor.shutdown(wait=(deadline is None))
    print(f"Boxscore pre-fetch complete ({len(uncached)} games)")


def _agg_key_is_live(key):
    """Check if an agg cache key references today's date (needs TTL-based refresh)."""
    return _get_today_str() in key


def _agg_key_ttl(key):
    """Return the effective TTL for an aggregation cache key."""
    if not _agg_key_is_live(key):
        return None
    if key.startswith("card_"):
        return LIVE_CARD_CACHE_TTL
    if key.startswith("game_view_"):
        return LIVE_GAME_VIEW_CACHE_TTL
    if key.startswith("daily_pitch_") or key.startswith("daily_results_"):
        return LIVE_GAME_VIEW_CACHE_TTL
    if key.startswith("player_v2_") or key.startswith("season_totals_"):
        # Player-page and season-totals payloads include today's game log /
        # totals; when end_date is today the cache key is suffixed with the
        # date so this branch fires and we track live games as closely as the
        # card view.
        return LIVE_CARD_CACHE_TTL
    return AGG_CACHE_TTL


def _agg_key_uses_redis_l2(key):
    """Past-date keys always use Redis; live cards, selected game views, and
    live player-page payloads also use Redis because their short TTLs keep
    cold-start reads fresh."""
    return (
        (not _agg_key_is_live(key))
        or key.startswith("card_")
        or key.startswith("game_view_")
        or key.startswith("player_v2_")
        # asof-today season totals were L1-only, so every fresh serverless
        # instance recomputed them; their short live TTL makes Redis safe.
        or key.startswith("season_totals_")
        # The rehab payload was also L1-only, which on serverless meant every
        # cold instance re-ran the full IL sweep. The cron re-warms it, but
        # the warm is worthless unless instances can actually SHARE it.
        or key.startswith("rehab_starts_")
    )


def _cache_index_key(scope, value):
    return f"{CACHE_INDEX_PREFIX}:{scope}:{value}"


def _index_cache_key(redis_key, logical_key=None):
    logical = logical_key or redis_key
    redis_sadd(_cache_index_key("all", "agg"), redis_key, ttl=CACHE_INDEX_TTL)
    for date_str in set(re.findall(r"\d{4}-\d{2}-\d{2}", logical)):
        redis_sadd(_cache_index_key("date", date_str), redis_key, ttl=CACHE_INDEX_TTL)
    for pattern in (_CARD_CACHE_KEY_RE, _PLAYER_CACHE_KEY_RE, _SEASON_TOTALS_KEY_RE, _SEASON_AVG_KEY_RE, _CARD_EXTRAS_KEY_RE):
        match = pattern.match(logical)
        if match:
            redis_sadd(_cache_index_key("pitcher", match.group(1)), redis_key, ttl=CACHE_INDEX_TTL)
            break
    if logical.startswith("team_"):
        redis_sadd(_cache_index_key("group", "team"), redis_key, ttl=CACHE_INDEX_TTL)
    if logical.startswith("pitchers:"):
        redis_sadd(_cache_index_key("group", "pitchers"), redis_key, ttl=CACHE_INDEX_TTL)


def _delete_indexed(scope, value):
    index_key = _cache_index_key(scope, value)
    keys = redis_smembers(index_key)
    deleted = redis_delete_many(keys)
    redis_delete(index_key)
    return deleted


def get_agg_cache(key):
    """Get a cached aggregation result. Checks L1 (dict) then L2 (Redis).
    Past-date keys never expire; today's live cards use LIVE_CARD_CACHE_TTL;
    other live keys use AGG_CACHE_TTL."""
    ttl = _agg_key_ttl(key)
    if key in _agg_cache:
        ts, result = _agg_cache[key]
        if ttl is None or (time.time() - ts) < ttl:
            return result
    # L2: Redis — trust past-date keys indefinitely and live cards only while
    # their short Redis TTL is active. Other live keys continue to avoid Redis
    # so cold starts don't resurrect stale hourly table aggregations.
    if _agg_key_uses_redis_l2(key):
        val = redis_get(f"agg:{key}")
        if val is not None:
            _agg_cache[key] = (time.time(), val)
            return val
    return None

def set_agg_cache(key, result):
    """Store an aggregation result in L1 (dict) and L2 (Redis).
    Live keys get a TTL in Redis matching the in-memory TTL."""
    _agg_cache[key] = (time.time(), result)
    ttl = _agg_key_ttl(key)
    redis_key = f"agg:{key}"
    redis_set(redis_key, result, ttl=ttl)
    _index_cache_key(redis_key, key)


def invalidate_pitcher_related_caches(pitcher_ids):
    """Clear stable caches for specific pitchers after data changes."""
    pid_set = {int(pid) for pid in (pitcher_ids or []) if pid is not None}
    if not pid_set:
        return {"season_rows": 0, "season_aggs": 0, "agg_keys": 0}

    season_rows = 0
    for cache_key in list(_season_cache.keys()):
        if not (isinstance(cache_key, tuple) and len(cache_key) == 2):
            continue
        cache_pid, _ = cache_key
        if int(cache_pid) in pid_set:
            _season_cache.pop(cache_key, None)
            season_rows += 1

    season_aggs = 0
    for cache_key in list(season_game_agg_cache.keys()):
        if not (isinstance(cache_key, tuple) and len(cache_key) == 3):
            continue
        cache_pid, _, _ = cache_key
        if int(cache_pid) in pid_set:
            season_game_agg_cache.pop(cache_key, None)
            season_aggs += 1

    agg_keys = 0
    for key in list(_agg_cache.keys()):
        clear = False
        for pattern in (
            _CARD_CACHE_KEY_RE,
            _PLAYER_CACHE_KEY_RE,
            _SEASON_TOTALS_KEY_RE,
            _SEASON_AVG_KEY_RE,
            _CARD_EXTRAS_KEY_RE,
        ):
            match = pattern.match(key)
            if match:
                clear = int(match.group(1)) in pid_set
                break
        if clear:
            _agg_cache.pop(key, None)
            redis_delete(f"agg:{key}")
            agg_keys += 1

    for pid in pid_set:
        agg_keys += _delete_indexed("pitcher", pid)

    return {"season_rows": season_rows, "season_aggs": season_aggs, "agg_keys": agg_keys}


_pitchers_list_cache = {}  # { "start_end": (timestamp, list) }


def _name_search_norm(s):
    """Lowercase + strip accents so search/resolve can match accent-insensitively
    ("emerson" ↔ "Émerson"). Precomputed once per pitcher at list-build time so the
    search endpoint never re-normalizes ~600 names on every keystroke."""
    return strip_accents((s or "").lower())


def _teams_by_recency(df):
    """{pitcher_id: [team, ...]} ordered by each team's LAST appearance, newest
    first.

    `unique()` returns first-appearance order, which puts the team a traded
    pitcher LEFT at the head of his list — the one place the season history
    is read as "who is he with". Ordering by last appearance instead makes the
    head of the list the best guess available from game data alone; the
    transaction feed then overrides it (mlb_status.tag_current_team) for the
    players it can resolve.
    """
    if "pitcher_team" not in df.columns or "game_date" not in df.columns:
        return {}
    last_seen = (
        df.groupby(["pitcher", "pitcher_team"])["game_date"].max().reset_index()
        .sort_values(["pitcher", "game_date"], ascending=[True, False])
    )
    out = {}
    for pid, team in zip(last_seen["pitcher"], last_seen["pitcher_team"]):
        if pd.isna(team) or not str(team).strip():
            continue
        out.setdefault(int(pid), []).append(str(team))
    return out


def build_pitchers_list_from_df(df):
    if df is None or df.empty:
        return []
    agg = {
        "player_name": "first",
        "pitcher_team": lambda x: list(x.unique()),
        "p_throws": "first",
    }
    # Relevance signals for client-side ranking: total pitches thrown in the
    # range (volume) and the most recent appearance date (recency). Guarded
    # because some partial/legacy frames may not carry game_date.
    has_game_date = "game_date" in df.columns
    if has_game_date:
        agg["game_date"] = "max"
    grouped = df.groupby("pitcher").agg(agg)
    grouped["pitches"] = df.groupby("pitcher").size()
    grouped = grouped.reset_index()
    records = grouped.to_dict(orient="records")
    recent_teams = _teams_by_recency(df)
    result = [{
        "pitcher_id": int(r["pitcher"]),
        "name": r["player_name"],
        # Precomputed accent-stripped lowercase name — see _name_search_norm.
        "name_norm": _name_search_norm(r["player_name"]),
        "teams": recent_teams.get(int(r["pitcher"])) or (
            r["pitcher_team"] if isinstance(r["pitcher_team"], list) else [r["pitcher_team"]]
        ),
        "hand": r["p_throws"],
        # Ranking signals consumed by the search UI (see SearchBar.jsx).
        "pitches": int(r["pitches"]),
        "last_date": str(r["game_date"])[:10] if has_game_date and r.get("game_date") is not None else None,
    } for r in records]
    result.sort(key=lambda r: r["name"])
    return result


# ── Streaming pitcher-directory aggregation ──
#
# build_pitchers_list_from_df needs the whole range as one frame. Across a
# season that is ~612k pitch rows / ~1.3 GB, and it is what OOM-killed
# /api/pitchers-directory (and, via the background rebuild thread, whatever
# unrelated request happened to share the warm instance). These three fold the
# same groupby one day at a time, so peak memory is one day.
#
# The aggregation is foldable because every field is either order-independent
# or a running extreme: first-non-null name/hand, summed pitch count, max
# game_date, and per-(pitcher, team) last-seen dates for the recency ordering.
# Days are folded in date order, so "first" means what it means in the
# whole-frame groupby. Equivalence is pinned by
# backend/tests/test_pitchers_directory_stream.py — keep that test green.

def _is_nullish(v):
    """pd.isna, but safe on the list/array values a groupby can hand back."""
    try:
        return v is None or bool(pd.isna(v))
    except (TypeError, ValueError):
        return False


def new_pitchers_list_accumulator():
    return {}


def accumulate_pitchers_list(acc, day_df):
    """Fold one day's pitch frame into a pitcher-directory accumulator."""
    if day_df is None or day_df.empty or "pitcher" not in day_df.columns:
        return
    spec = {}
    if "player_name" in day_df.columns:
        spec["player_name"] = "first"          # pandas "first" = first NON-NULL
    if "pitcher_team" in day_df.columns:
        spec["pitcher_team"] = lambda x: list(pd.unique(x))
    if "p_throws" in day_df.columns:
        spec["p_throws"] = "first"
    if "game_date" in day_df.columns:
        spec["game_date"] = "max"

    grouped = day_df.groupby("pitcher")
    sizes = grouped.size()
    day_agg = grouped.agg(spec) if spec else None

    # Per-(pitcher, team) last appearance — the streaming half of
    # _teams_by_recency. A max is a running extreme, so folding it day by day
    # gives exactly what the whole-frame groupby gives.
    if {"pitcher_team", "game_date"}.issubset(day_df.columns):
        day_last = day_df.groupby(["pitcher", "pitcher_team"])["game_date"].max()
    else:
        day_last = None

    for pid, n in sizes.items():
        entry = acc.get(pid)
        if entry is None:
            entry = {"name": None, "teams": [], "team_last": {}, "hand": None,
                     "pitches": 0, "last_date": None}
            acc[pid] = entry
        # Pitch count is a plain sum — the one field that would be wrong if a
        # day were folded twice, which is why the fold is strictly date-ordered.
        entry["pitches"] += int(n)
        if day_agg is None:
            continue
        row = day_agg.loc[pid]

        name = row.get("player_name")
        if entry["name"] is None and not _is_nullish(name):
            entry["name"] = name
        hand = row.get("p_throws")
        if entry["hand"] is None and not _is_nullish(hand):
            entry["hand"] = hand
        # First-appearance order, kept only as the no-game_date fallback that
        # build_pitchers_list_from_df also falls back to.
        teams = row.get("pitcher_team")
        if isinstance(teams, list):
            for t in teams:
                if t not in entry["teams"]:
                    entry["teams"].append(t)
        game_date = row.get("game_date")
        if not _is_nullish(game_date):
            game_date = str(game_date)
            if entry["last_date"] is None or game_date > entry["last_date"]:
                entry["last_date"] = game_date

    if day_last is not None:
        for (pid, team), seen in day_last.items():
            entry = acc.get(pid)
            if entry is None or _is_nullish(team) or not str(team).strip():
                continue
            team = str(team)
            seen = str(seen)
            if entry["team_last"].get(team) is None or seen > entry["team_last"][team]:
                entry["team_last"][team] = seen


def _ordered_teams(entry):
    """Newest club first — the streaming equivalent of _teams_by_recency.

    Ties are broken on team name so the order is deterministic; the whole-frame
    sort leaves same-date ties unspecified, so this is a tightening, not a
    divergence. Falls back to first-appearance order when the frames carried no
    game_date, exactly as build_pitchers_list_from_df does.
    """
    recency = entry["team_last"]
    if not recency:
        return list(entry["teams"])
    teams = sorted(recency)                                   # deterministic tiebreak
    teams.sort(key=lambda t: recency[t], reverse=True)        # stable: date DESC
    return teams


def finalize_pitchers_list(acc):
    result = [{
        "pitcher_id": int(pid),
        "name": entry["name"],
        # Precomputed accent-stripped lowercase name — see _name_search_norm.
        "name_norm": _name_search_norm(entry["name"]),
        "teams": _ordered_teams(entry),
        "hand": entry["hand"],
        # Ranking signals consumed by the search UI (see SearchBar.jsx).
        "pitches": int(entry["pitches"]),
        "last_date": str(entry["last_date"])[:10] if entry["last_date"] is not None else None,
    } for pid, entry in acc.items()]
    result.sort(key=lambda r: r["name"] or "")
    return result


# BUMP THIS whenever a row in the Savant-side pitcher list changes shape or
# ordering. Both keys below embed it, and both outlive an ordinary deploy —
# 'pitcher_dir:' never expires at all — so without a bump a shipped change
# keeps serving the old list indefinitely.
#   1: {pitcher_id, name, name_norm, teams, hand, pitches, last_date}
#   2: `teams` ordered by most recent appearance instead of first
PITCHER_DIR_VERSION = 2


def _pitcher_dir_key(start_date, end_date):
    return f"pitcher_dir:v{PITCHER_DIR_VERSION}:{start_date}_{end_date}"


def _pitchers_list_key(start_date, end_date):
    # Keeps the "pitchers:" prefix — clear_cache indexes the whole family off it.
    return f"pitchers:v{PITCHER_DIR_VERSION}:{start_date}_{end_date}"


def _persist_pitcher_directory(start_date, end_date, result):
    """Store the lightweight pitcher list under a never-expiring 'directory' key.

    The search/resolve endpoints read this first so they never have to
    materialize the full (170MB+) season DataFrame on the request path. A
    pitcher roster is stable across the season and the warmup crons refresh
    this on every tick, so a never-expiring copy is safe — a debut pitcher
    just shows up on the next cron rather than after a 7-30s cold rebuild.
    """
    try:
        dir_key = _pitcher_dir_key(start_date, end_date)
        redis_set(dir_key, result, ttl=None)
        _index_cache_key(dir_key, dir_key)
    except Exception:
        pass


def fetch_all_pitchers_list_materialized(start_date, end_date):
    cache_key = (start_date, end_date)
    if cache_key in _pitchers_list_cache:
        ts, result = _pitchers_list_cache[cache_key]
        if not _is_today(end_date) or (time.time() - ts) < RANGE_CACHE_TTL:
            return result
    redis_key = _pitchers_list_key(start_date, end_date)
    redis_val = redis_get(redis_key)
    if redis_val is not None:
        _pitchers_list_cache[cache_key] = (time.time(), redis_val)
        return redis_val
    # Ledger first: the season directory through yesterday is a running
    # accumulator, so this is one read + finalize with today layered on top.
    result = _directory_from_ledger(start_date, end_date)
    if result is None:
        # Streamed a day at a time — see the accumulator above. This used to
        # call fetch_date_range_materialized and hand a whole-season frame to
        # build_pitchers_list_from_df, the allocation that OOM-killed the
        # directory endpoints.
        acc = new_pitchers_list_accumulator()
        if not fold_range_materialized(start_date, end_date,
                                       lambda day_df: accumulate_pitchers_list(acc, day_df)):
            return None
        result = finalize_pitchers_list(acc)
    _pitchers_list_cache[cache_key] = (time.time(), result)
    # Long TTL — a pitcher roster is mostly stable across the season. The
    # daily/live warmup crons explicitly refresh this so debut pitchers
    # show up within a few minutes of their first appearance. Without a
    # long TTL the search bar is 7-30s on any cold Vercel instance.
    ttl = 86400 if _is_today(end_date) else None
    redis_set(redis_key, result, ttl=ttl)
    _index_cache_key(redis_key, redis_key)
    # Mirror into the never-expiring directory used by the search hot path.
    _persist_pitcher_directory(start_date, end_date, result)
    return result


# Tracks (start, end) ranges currently being rebuilt in the background so the
# search hot path doesn't spawn duplicate materialization threads.
_pitcher_dir_building = set()
_pitcher_dir_build_lock = threading.Lock()


def _background_build_pitcher_directory(start_date, end_date):
    """Refresh the directory keys off the request path. LOCAL ONLY.

    On Vercel a function is frozen the instant its response is sent, so this
    thread does not get to finish: it resumes inside whatever later invocation
    reuses the instance and allocates there, against that request's memory.
    That is how a directory rebuild OOM-killed /api/initial-load and
    /api/pitchers-search — endpoints that never touch the directory at all.
    It is the same reason range materialization is a cron and not a thread.

    The warmup-daily cron calls fetch_all_pitchers_list_materialized and
    persists both directory keys, so on serverless the rebuild is already
    covered; the request path serves the partial list until the cron lands.
    """
    if _IS_SERVERLESS:
        return
    key = (start_date, end_date)
    with _pitcher_dir_build_lock:
        if key in _pitcher_dir_building:
            return
        _pitcher_dir_building.add(key)

    def _run():
        try:
            fetch_all_pitchers_list_materialized(start_date, end_date)
        except Exception as e:
            print(f"[PitcherDir] background build failed for {key}: {e}")
        finally:
            with _pitcher_dir_build_lock:
                _pitcher_dir_building.discard(key)

    threading.Thread(target=_run, daemon=True).start()


def fetch_pitchers_directory(start_date, end_date):
    """Fast pitcher list for the search/resolve hot path.

    Order: in-memory cache → 'pitchers:' Redis key → never-expiring
    'pitcher_dir:' key. On a full miss it returns the cheap per-day partial
    list immediately and kicks off the heavy materialization in the
    background, so a cold instance answers in well under a second instead of
    blocking 7-30s on a full-season DataFrame rebuild.
    """
    cache_key = (start_date, end_date)
    if cache_key in _pitchers_list_cache:
        ts, result = _pitchers_list_cache[cache_key]
        if not _is_today(end_date) or (time.time() - ts) < RANGE_CACHE_TTL:
            return result
    # Canonical live/recent key (kept fresh by the warmup crons).
    redis_val = redis_get(_pitchers_list_key(start_date, end_date))
    if redis_val is not None:
        _pitchers_list_cache[cache_key] = (time.time(), redis_val)
        return redis_val
    # Never-expiring directory snapshot — survives the 'pitchers:' TTL.
    # Also try yesterday's key as a cross-day fallback: the key is keyed by
    # end_date, so it misses every morning until the warmup cron rebuilds it.
    # Yesterday's roster is 99%+ accurate for today (debuts are caught on the
    # next cron tick) and prevents a 504 when the warmup fails overnight.
    dir_val = redis_get(_pitcher_dir_key(start_date, end_date))
    if dir_val is None and _is_today(end_date):
        yesterday = _previous_date(end_date)
        if yesterday >= start_date:
            dir_val = redis_get(_pitcher_dir_key(start_date, yesterday))
    if dir_val is not None:
        _pitchers_list_cache[cache_key] = (time.time(), dir_val)
        # Refresh the canonical copy in the background if it has expired.
        _background_build_pitcher_directory(start_date, end_date)
        return dir_val
    # Cold miss: serve whatever per-day snapshots we have right now. On
    # serverless the background build is a no-op (see there), so without the
    # short-TTL write below EVERY cold instance would repeat the same ~140-day
    # fold and none of them would leave anything behind for the next one.
    _background_build_pitcher_directory(start_date, end_date)
    # Ledger first — a COMPLETE directory in one read. Only when the ledger is
    # behind does the best-effort partial fold below run at all.
    full = _directory_from_ledger(start_date, end_date)
    if full:
        _pitchers_list_cache[cache_key] = (time.time(), full)
        _persist_pitcher_directory(start_date, end_date, full)
        return full
    partial = fetch_pitchers_list_partial(start_date, end_date) or []
    if partial:
        _persist_partial_pitcher_directory(start_date, end_date, partial)
    return partial


# How long a PARTIAL directory may be served from Redis. Short on purpose: it
# is assembled from whatever days happen to be baked, so it must give way to
# the real list as soon as the range finishes materializing. Long enough that
# cold instances stop repeating an identical ~140-day fold.
PARTIAL_DIR_TTL = 60 * 60


def _persist_partial_pitcher_directory(start_date, end_date, result):
    """Cache an INCOMPLETE directory briefly, under the ordinary key only.

    Deliberately NOT the never-expiring pitcher_dir: key — that one is the
    canonical snapshot and must only ever hold a complete list. Writing the
    short-TTL key costs nothing in correctness: the value is exactly what the
    request already returns, so the only thing that changes is that the next
    cold instance reads it instead of recomputing it.
    """
    try:
        key = _pitchers_list_key(start_date, end_date)
        redis_set(key, result, ttl=PARTIAL_DIR_TTL)
        _index_cache_key(key, key)
    except Exception:
        pass


def warm_partial_pitcher_directory(start_date, end_date):
    """Build and cache the best-effort directory.

    For the daily cron to fall back on: warmup-daily's strict build returns
    None until the whole season is baked, and warmup-daily-2 (which queues the
    materialization) runs 20 minutes AFTER it. On any morning where the range
    is behind, that ordering leaves no directory at all for the rest of the
    day. This guarantees search has something fast to read either way.
    """
    result = fetch_pitchers_list_partial(start_date, end_date) or []
    if result:
        _persist_partial_pitcher_directory(start_date, end_date, result)
    return result


def _directory_from_ledger(start_date, end_date):
    """Full directory from the season ledger, or None.

    Only for the canonical window (season start through today) — the ledger
    has one high-water mark and cannot answer arbitrary ranges. Function-level
    import because ledger imports this module.
    """
    if start_date != SEASON_START or not _is_today(end_date):
        return None
    try:
        import ledger
        return ledger.directory_rows(today_df=fetch_date(end_date))
    except Exception as e:
        print(f"[Directory] ledger path failed: {e}")
        return None


def fetch_pitchers_list_partial(start_date, end_date):
    """Best-effort pitcher list assembled from whatever range_day snapshots
    happen to be in Redis right now.

    Unlike fetch_all_pitchers_list_materialized, this does NOT require every
    day in the window to be present — missing days are silently skipped.
    Used as a fallback for the search endpoint so users still get results
    when the canonical materialized range has a transient gap.

    Folded a day at a time (skip_missing=True). The previous version collected
    every day's frame and pd.concat'd them, which on a full season is the same
    ~1.3 GB object the rest of this module exists to avoid — and this is the
    COLD-MISS path, i.e. exactly the request least able to afford it.

    Sharing the fold also widened the day set slightly: it now picks up the
    daily cache and today's live day, which the old snapshot-only loop skipped.
    That is a superset (a debut pitcher is searchable the same day rather than
    after the next cron), and it makes the partial and strict directories agree
    on which days exist.
    """
    acc = new_pitchers_list_accumulator()
    fold_range_materialized(
        start_date, end_date,
        lambda day_df: accumulate_pitchers_list(acc, day_df),
        skip_missing=True,
    )
    return finalize_pitchers_list(acc)


# ── Startup warmup ──

def _get_default_end_date():
    """Get today's date in Eastern time."""
    return _now_et().strftime("%Y-%m-%d")


def is_custom_season_range(start_date, end_date):
    """True if (start_date, end_date) is NOT the canonical season-to-date range
    (current year's 03-25 through today ET). Custom ranges get a '_custom'
    suffix on player_v2 / season_totals cache keys so historical lookups
    don't collide with the stable, overwrite-in-place season key."""
    today = _get_default_end_date()
    current_year = today[:4]
    return start_date != season_start(current_year) or end_date != today


def season_cache_suffix(start_date, end_date):
    if is_custom_season_range(start_date, end_date):
        return f"_custom_{start_date}_{end_date}"
    return f"_asof{end_date}"


def warmup_range_data(start_date=SEASON_START, end_date=None):
    """Pre-fetch and warm all caches for the standard date range.
    Called on server startup in a background thread."""
    global _warmup_status
    if end_date is None:
        end_date = _get_default_end_date()

    with _warmup_lock:
        if _warmup_status["loading"]:
            return  # already running
        _warmup_status["loading"] = True
        _warmup_status["progress"] = "Fetching pitch data from Savant..."

    # Function-level import: aggregation imports data at module load, so this
    # must stay deferred. The *_range names were previously missing entirely —
    # the team-aggregation block below raised NameError into the broad except,
    # silently skipping team warming.
    from aggregation import (
        aggregate_pitch_data, aggregate_pitcher_results,
        new_results_accumulator, accumulate_pitcher_results, finalize_pitcher_results,
        new_pitch_data_accumulator, accumulate_pitch_data, finalize_pitch_data,
    )

    print(f"[Warmup] Starting data pre-fetch: {start_date} to {end_date}")
    t0 = time.time()
    # Hard wall-clock budget, comfortably under the 300s function maxDuration.
    # The user-critical homepage warm runs first and unconditionally; the heavier
    # season-wide warming (full-range load, boxscores, team aggregations) is
    # best-effort and stops at the deadline so the cron returns 200 instead of
    # running past 300s -> 504 (which used to skip the homepage warm entirely).
    deadline = t0 + 240
    try:
        # 1) USER-CRITICAL FIRST: warm the default-date / homepage caches so the
        #    first visitor of the day always gets the fast path, even when the
        #    season-wide warming below runs out of time. This block doesn't need
        #    the full-season range, so it must not sit behind it.
        with _warmup_lock:
            _warmup_status["progress"] = "Warming default date cache..."
        try:
            default_date = get_default_date()
            fetch_date(default_date)
            get_games(default_date)
            pd_result = aggregate_pitch_data(default_date, None)
            set_agg_cache(f"daily_pitch_{default_date}", pd_result)
            pr_result = aggregate_pitcher_results(default_date, None)
            set_agg_cache(f"daily_results_s{CARD_SCHEMA_VERSION}_{default_date}", pr_result)
            record_stat_lines_refresh(default_date)
            print(f"[Warmup] Daily aggregations for {default_date} cached")
        except Exception as e2:
            print(f"[Warmup] Default date warm failed: {e2}")

        # 2) BEST-EFFORT season-wide warming, bounded by the deadline.
        #
        # One day at a time. This used to call fetch_date_range(start, end),
        # which assembles the league's entire season — ~612k rows, on the order
        # of 1.3 GB — inside a job that also runs on Vercel via
        # /api/cron/warmup. fetch_date fetches AND persists a single day's
        # snapshot, so the same caches get warmed; the season just never exists
        # as one object. Boxscores are prefetched per day and team totals go
        # through the streaming accumulators.
        with _warmup_lock:
            _warmup_status["progress"] = "Fetching pitch data from Savant..."

        results_acc = {}
        pitch_acc = {}
        days_seen = 0
        rows_seen = 0
        swept_whole_range = True

        for date_str in _date_strings(start_date, end_date):
            if time.time() >= deadline:
                swept_whole_range = False
                break
            try:
                day_df = fetch_date(date_str)
            except Exception as day_err:
                # One bad day must not abandon the sweep, but it does mean the
                # range is no longer fully covered.
                print(f"[Warmup] {date_str} failed: {day_err}")
                swept_whole_range = False
                continue
            if day_df is None or day_df.empty:
                continue
            days_seen += 1
            rows_seen += len(day_df)

            with _warmup_lock:
                _warmup_status["progress"] = f"Warming {date_str} ({days_seen} days)..."
            prefetch_boxscores(day_df, deadline=deadline)

            if "pitcher_team" in day_df.columns:
                for team, tdf in day_df.groupby("pitcher_team"):
                    if tdf.empty:
                        continue
                    if team not in results_acc:
                        results_acc[team] = new_results_accumulator()
                        pitch_acc[team] = new_pitch_data_accumulator()
                    accumulate_pitcher_results(results_acc[team], tdf)
                    accumulate_pitch_data(pitch_acc[team], tdf)
            del day_df

        elapsed = time.time() - t0
        print(f"[Warmup] Savant data loaded: {rows_seen} rows across {days_seen} dates in {elapsed:.1f}s")

        # A team aggregation is only correct over the WHOLE range. The old code
        # got that for free by loading the full range before aggregating and
        # breaking per team; streaming means a deadline can cut the sweep
        # mid-season, and caching those accumulators would publish a silently
        # short stat line for every team. So: all days, or no team writes.
        if not swept_whole_range:
            print("[Warmup] Deadline hit during the season sweep - homepage caches warm, "
                  "deferring team aggregations rather than caching partial totals")
        elif results_acc:
            with _warmup_lock:
                _warmup_status["progress"] = "Pre-computing team aggregations..."
            warmed = 0
            for team in list(results_acc):
                if time.time() >= deadline:
                    print(f"[Warmup] Deadline hit - cached {warmed}/{len(results_acc)} teams, deferring rest")
                    break
                set_agg_cache(f"team_{team}_results_{start_date}_{end_date}",
                              finalize_pitcher_results(results_acc[team]))
                set_agg_cache(f"team_{team}_pitch-data_{start_date}_{end_date}",
                              finalize_pitch_data(pitch_acc[team]))
                warmed += 1
            else:
                print(f"[Warmup] Team aggregations cached for {len(results_acc)} teams")

        elapsed_total = time.time() - t0
        print(f"[Warmup] Complete in {elapsed_total:.1f}s")

        with _warmup_lock:
            _warmup_status["ready"] = True
            _warmup_status["loading"] = False
            _warmup_status["progress"] = "Ready"
            _warmup_status["error"] = None
    except Exception as e:
        print(f"[Warmup] Error: {e}")
        with _warmup_lock:
            _warmup_status["loading"] = False
            _warmup_status["error"] = str(e)
            _warmup_status["progress"] = f"Error: {e}"


def start_warmup(start_date=SEASON_START, end_date=None):
    """Kick off warmup in a background thread."""
    t = threading.Thread(target=warmup_range_data, args=(start_date, end_date), daemon=True)
    t.start()
    return t


# ── Player page computation (shared by API endpoint and warmup) ──

def compute_player_page(df, pitcher_id):
    """Compute the full player page result dict for a single pitcher.
    Expects the full season DataFrame (not pre-filtered).
    Returns the result dict, or None if the pitcher has no data."""
    from aggregation import (
        aggregate_pitch_data_range, get_pitcher_game_log,
        _prep_df, build_pitches_list,
    )

    pdf = df[df["pitcher"] == pitcher_id]
    if pdf.empty:
        return None
    # Exclude All-Star Game data
    if "game_type" in pdf.columns:
        pdf = pdf[pdf["game_type"] != "A"]
    if pdf.empty:
        return None
    pdf = pdf.copy()

    raw_names = (
        pdf["player_name"].dropna().astype(str).str.strip()
        if "player_name" in pdf.columns else pd.Series(dtype=str)
    )
    raw_names = raw_names[(raw_names != "") & (raw_names.str.lower() != "nan")]
    name = raw_names.mode().iloc[0] if not raw_names.empty else ""
    if name:
        pdf["player_name"] = name

    teams = []
    if "pitcher_team" in pdf.columns:
        teams = [str(t) for t in pd.unique(pdf["pitcher_team"]) if pd.notna(t) and str(t).strip()]

    raw_hands = (
        pdf["p_throws"].dropna().astype(str).str.strip()
        if "p_throws" in pdf.columns else pd.Series(dtype=str)
    )
    raw_hands = raw_hands[raw_hands != ""]
    hand = raw_hands.mode().iloc[0] if not raw_hands.empty else ""
    info = {"name": name, "teams": teams, "hand": hand, "pitcher_id": int(pitcher_id)}

    pdf_prepped = _prep_df(pdf)
    pitch_summary = aggregate_pitch_data_range(pdf_prepped, prepped=True)

    pdf_vs_l = pdf_prepped[pdf_prepped["stand"] == "L"] if "stand" in pdf_prepped.columns else pdf_prepped.iloc[0:0]
    pdf_vs_r = pdf_prepped[pdf_prepped["stand"] == "R"] if "stand" in pdf_prepped.columns else pdf_prepped.iloc[0:0]
    pitch_summary_vs_l = aggregate_pitch_data_range(pdf_vs_l, prepped=True) if not pdf_vs_l.empty else []
    pitch_summary_vs_r = aggregate_pitch_data_range(pdf_vs_r, prepped=True) if not pdf_vs_r.empty else []

    game_log = get_pitcher_game_log(df, pitcher_id)
    # Shared season-totals math (this block was a hand-maintained copy that
    # had drifted — it lacked last_game_date).
    results_summary = aggregate_game_log_to_totals(game_log)

    per_game_summaries = {}
    for gpk in pdf_prepped["game_pk"].unique():
        gpdf = pdf_prepped[pdf_prepped["game_pk"] == gpk]
        per_game_summaries[str(int(gpk))] = {
            "all": aggregate_pitch_data_range(gpdf, prepped=True),
            "vs_l": aggregate_pitch_data_range(gpdf[gpdf["stand"] == "L"], prepped=True) if (gpdf["stand"] == "L").any() else [],
            "vs_r": aggregate_pitch_data_range(gpdf[gpdf["stand"] == "R"], prepped=True) if (gpdf["stand"] == "R").any() else [],
        }

    all_pitches = build_pitches_list(pdf)
    sz_top = float(pdf["sz_top"].mean()) if "sz_top" in pdf.columns and pdf["sz_top"].notna().any() else 3.5
    sz_bot = float(pdf["sz_bot"].mean()) if "sz_bot" in pdf.columns and pdf["sz_bot"].notna().any() else 1.5

    return {
        "info": info, "pitch_summary": pitch_summary,
        "pitch_summary_vs_l": pitch_summary_vs_l, "pitch_summary_vs_r": pitch_summary_vs_r,
        "per_game_summaries": per_game_summaries, "results_summary": results_summary,
        "game_log": game_log, "pitches": all_pitches, "sz_top": sz_top, "sz_bot": sz_bot,
    }


def get_warmup_status():
    """Return current warmup status dict."""
    with _warmup_lock:
        return dict(_warmup_status)


def clear_cache(date_str=None, pitcher_ids=None):
    """Clear caches for a specific date, or everything if date_str is None."""
    if date_str:
        affected_pitchers = {int(pid) for pid in (pitcher_ids or []) if pid is not None}

        # Collect affected pitchers from the day's cached data before evicting
        cached_day = _cache.get(date_str)
        if cached_day is not None:
            day_df = cached_day[1] if isinstance(cached_day, tuple) else cached_day
            if day_df is not None and not day_df.empty and "pitcher" in day_df.columns:
                affected_pitchers.update(int(pid) for pid in day_df["pitcher"].dropna().unique())

        # Drop daily data cache for this date
        _cache.pop(date_str, None)
        redis_delete(_range_day_key(date_str))

        # Drop MLB schedule cache for this date (in-memory and Redis)
        _schedule_cache.pop(date_str, None)
        redis_delete(f"schedule:{date_str}")

        # Drop game-pitch cache entries for this date
        for k in list(_game_pitch_cache.keys()):
            if isinstance(k, tuple) and len(k) == 2 and k[0] == date_str:
                _game_pitch_cache.pop(k, None)

        # Clear daily agg caches that embed this date string
        for k in list(_agg_cache.keys()):
            if date_str in k:
                _agg_cache.pop(k, None)
                redis_delete(f"agg:{k}")
        _delete_indexed("date", date_str)

        # Clear range and pitchers-list caches covering this date
        for cache_dict in (_range_cache, _pitchers_list_cache):
            for k in list(cache_dict.keys()):
                if isinstance(k, tuple) and len(k) == 2:
                    start, end = k
                    if start <= date_str <= end:
                        cache_dict.pop(k, None)

        # Clear team aggregation caches
        for k in list(_agg_cache.keys()):
            if k.startswith("team_"):
                _agg_cache.pop(k, None)
                redis_delete(f"agg:{k}")
        _delete_indexed("group", "pitchers")
        _delete_indexed("group", "team")
        redis_delete(_stat_lines_refresh_key(date_str))

        if affected_pitchers:
            invalidate_pitcher_related_caches(affected_pitchers)
    else:
        # Nuclear: clear everything
        _cache.clear()
        _season_cache.clear()
        _range_cache.clear()
        _agg_cache.clear()
        _schedule_cache.clear()
        _game_pitch_cache.clear()
        _pitchers_list_cache.clear()
        _delete_indexed("all", "agg")
        _delete_indexed("group", "pitchers")
        _delete_indexed("group", "team")


def clear_live_refresh_cache(date_str, game_pk=None):
    """Fast cache clear for the manual refresh button.

    This helper clears only the slate/table/game caches that are re-read
    immediately by the home page and selected game views.
    """
    if not date_str:
        return {"cleared": 0, "affected_pitchers": 0}

    cleared = 0
    affected_pitchers = set()

    cached_day = _cache.get(date_str)
    if cached_day is not None:
        day_df = cached_day[1] if isinstance(cached_day, tuple) else cached_day
        if day_df is not None and not day_df.empty and "pitcher" in day_df.columns:
            affected_pitchers.update(int(pid) for pid in day_df["pitcher"].dropna().unique())

    # Collect today's gamePks so we can also evict per-game feed/boxscore caches.
    # These are keyed by gamePk only (no date), so without explicit eviction the
    # refresh button leaves them in place — and a stale Redis `feed:{pk}` (cached
    # from a brief Final state on a rescheduled doubleheader, etc.) keeps
    # shadowing the live feed indefinitely.
    today_game_pks = set()
    schedule_snapshot = _schedule_cache.get(date_str)
    if schedule_snapshot is not None:
        _, sched_games = schedule_snapshot
        for sg in sched_games or []:
            gpk = sg.get("game_pk") if isinstance(sg, dict) else None
            if gpk is not None:
                today_game_pks.add(int(gpk))
    if cached_day is not None:
        day_df = cached_day[1] if isinstance(cached_day, tuple) else cached_day
        if day_df is not None and not day_df.empty and "game_pk" in day_df.columns:
            today_game_pks.update(int(gpk) for gpk in day_df["game_pk"].dropna().unique())
    for key in list(_game_pitch_cache.keys()):
        if isinstance(key, tuple) and len(key) == 2 and key[0] == date_str:
            today_game_pks.add(int(key[1]))
    if game_pk is not None:
        today_game_pks.add(int(game_pk))

    if _cache.pop(date_str, None) is not None:
        cleared += 1

    if _schedule_cache.pop(date_str, None) is not None:
        cleared += 1
    redis_delete(f"schedule:{date_str}")

    for key in list(_game_pitch_cache.keys()):
        if isinstance(key, tuple) and len(key) == 2 and key[0] == date_str:
            if game_pk is None or int(key[1]) == int(game_pk):
                _game_pitch_cache.pop(key, None)
                cleared += 1

    for gpk in today_game_pks:
        if game_pk is not None and int(gpk) != int(game_pk):
            continue
        if _feed_cache.pop(gpk, None) is not None:
            cleared += 1
        if _boxscore_cache.pop(gpk, None) is not None:
            cleared += 1
        _game_state_cache.pop(gpk, None)
        redis_delete(f"feed:{gpk}")

    redis_delete(_range_day_key(date_str))

    exact_agg_keys = {
        f"daily_pitch_{date_str}",
        f"daily_results_s{CARD_SCHEMA_VERSION}_{date_str}",
    }
    if game_pk is not None:
        exact_agg_keys.add(
            f"game_view_{date_str}_{int(game_pk)}"
            f"_v{get_override_version()}_s{CARD_SCHEMA_VERSION}"
        )

    for key in list(_agg_cache.keys()):
        should_clear = key in exact_agg_keys
        if not should_clear and key.startswith("game_view_") and f"_{date_str}_" in key:
            should_clear = game_pk is None or f"_{int(game_pk)}_" in key
        if should_clear:
            _agg_cache.pop(key, None)
            redis_delete(f"agg:{key}")
            cleared += 1

    for key in exact_agg_keys:
        redis_delete(f"agg:{key}")

    redis_delete(_stat_lines_refresh_key(date_str))

    if affected_pitchers:
        invalidate_pitcher_related_caches(affected_pitchers)

    return {"cleared": cleared, "affected_pitchers": len(affected_pitchers)}

def _last_name(full_name):
    """Extract last name from full name (e.g. 'Gerrit Cole' → 'Cole')."""
    return full_name.split()[-1] if full_name else ""

# Schedules are per-LEVEL (sportId), never sportId=1 — this build excludes MLB
# everywhere. levels.schedule_url() owns the sportId/leagueId mapping.
def MLB_SCHEDULE_URL(date_str, level=DEFAULT_LEVEL):
    return schedule_url(date_str, level)


# Map full team names to abbreviations used by Savant
_TEAM_ABBREV = {
    "Arizona Diamondbacks": "AZ", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
    "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
    "New York Yankees": "NYY", "Oakland Athletics": "ATH", "Philadelphia Phillies": "PHI",
    "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD", "San Francisco Giants": "SF",
    "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL", "Tampa Bay Rays": "TB",
    "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR", "Washington Nationals": "WSH",
    "Athletics": "ATH",
    # WBC / International Teams
    "United States": "USA", "Japan": "JPN", "Dominican Republic": "DOM",
    "Puerto Rico": "PUR", "Korea": "KOR", "Cuba": "CUB", "Mexico": "MEX",
    "Venezuela": "VEN", "Netherlands": "NED", "Chinese Taipei": "TPE",
    "Italy": "ITA", "Israel": "ISR", "Great Britain": "GBR", "Australia": "AUS",
    "Panama": "PAN", "Czech Republic": "CZE", "Nicaragua": "NCA", "Colombia": "COL",
    "Canada": "CAN", "Brazil": "BRA", "China": "CHN", "New Zealand": "NZL",
}

_schedule_cache = {}  # { date_str: (timestamp, games_list) }
SCHEDULE_CACHE_TTL = 120  # past/future dates can sit a little longer
LIVE_SCHEDULE_CACHE_TTL = 60  # today's game tabs should feel near-live

_NOT_STARTED_GAME_STATES = frozenset({
    "Scheduled", "Pre-Game", "Warmup", "Delayed Start", "Cancelled", "Suspended",
})


def _schedule_cache_ttl(date_str):
    return LIVE_SCHEDULE_CACHE_TTL if _is_today(date_str) else SCHEDULE_CACHE_TTL


def _cached_live_day_game_pks(date_str):
    """Return today's cached game_pks when a fresh daily DataFrame is already in
    memory. This lets the games list reuse recent pitch-data work without
    re-pulling Savant just to compute `has_data`.
    """
    if not _is_today(date_str):
        return None
    cache_key = date_str
    cached = _cache.get(cache_key)
    if cached is None:
        return None
    if isinstance(cached, tuple):
        ts, df = cached
        if (time.time() - ts) > LIVE_CACHE_TTL:
            return None
    else:
        # Old-style cache entries have no timestamp; avoid trusting them for live
        # `has_data` decisions where false negatives are worse than omitting it.
        return None
    if df is None or df.empty or "game_pk" not in df.columns:
        return set()
    return {int(gpk) for gpk in df["game_pk"].dropna().unique()}


def _game_has_started(game):
    status = (game.get("status") or "").strip()
    abstract_state = (game.get("abstract_state") or "").strip()
    if abstract_state in {"Live", "Final"}:
        return True
    return status not in _NOT_STARTED_GAME_STATES and status != ""

def _get_mlb_schedule(date_str, force_refresh=False, level=DEFAULT_LEVEL):
    """Get one LEVEL's game list from the MLB Stats API for a date. Cached.

    Level is part of both cache keys — two levels play on the same date and
    would otherwise clobber each other.
    force_refresh=True bypasses both in-memory and Redis caches."""
    level = normalize_level(level)
    cache_key = (date_str, level)
    redis_key = f"schedule:{date_str}:{level}"
    ttl = _schedule_cache_ttl(date_str)
    if not force_refresh:
        if cache_key in _schedule_cache:
            ts, games = _schedule_cache[cache_key]
            if time.time() - ts < ttl:
                return games
        # L2: Redis
        redis_val = redis_get(redis_key)
        if redis_val is not None:
            _schedule_cache[cache_key] = (time.time(), redis_val)
            return redis_val
    try:
        url = MLB_SCHEDULE_URL(date_str, level)
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        games = []
        for date_entry in data.get("dates", []):
            for g in date_entry.get("games", []):
                away_name = g["teams"]["away"]["team"]["name"]
                home_name = g["teams"]["home"]["team"]["name"]
                away = g["teams"]["away"]["team"].get("abbreviation") or _TEAM_ABBREV.get(away_name, away_name)
                home = g["teams"]["home"]["team"].get("abbreviation") or _TEAM_ABBREV.get(home_name, home_name)
                # Probable pitchers
                away_sp = g["teams"]["away"].get("probablePitcher", {})
                home_sp = g["teams"]["home"].get("probablePitcher", {})
                # Game start time (ISO 8601 UTC)
                game_date_utc = g.get("gameDate", "")
                # Convert to ET for display
                game_time_et = ""
                if game_date_utc:
                    try:
                        dt_utc = datetime.fromisoformat(game_date_utc.replace("Z", "+00:00"))
                        dt_et = dt_utc.astimezone(ET_ZONE)
                        hour = dt_et.hour % 12 or 12
                        minute = dt_et.minute
                        ampm = "am" if dt_et.hour < 12 else "pm"
                        game_time_et = f"{hour}:{minute:02d}{ampm}"
                    except Exception:
                        pass
                # Linescore (scores + inning for live/final games)
                linescore = g.get("linescore", {})
                home_score = linescore.get("teams", {}).get("home", {}).get("runs")
                away_score = linescore.get("teams", {}).get("away", {}).get("runs")
                current_inning = linescore.get("currentInning", 0)
                inning_half = linescore.get("inningHalf", "")
                detailed_state = g["status"]["detailedState"]
                abstract_state = g["status"].get("abstractGameState", "")
                home_id = g["teams"]["home"]["team"].get("id")
                away_id = g["teams"]["away"]["team"].get("id")
                games.append({
                    "game_pk": g["gamePk"],
                    "label": f"{away} @ {home}",
                    "home_team": home,
                    "away_team": away,
                    "home_team_id": home_id,
                    "away_team_id": away_id,
                    "home_team_name": home_name,
                    "away_team_name": away_name,
                    "home_org": org_for_team(team_id=home_id, abbrev=home, level=level),
                    "away_org": org_for_team(team_id=away_id, abbrev=away, level=level),
                    "level": level,
                    "status": detailed_state,
                    "abstract_state": abstract_state,
                    "game_time_et": game_time_et,
                    "game_date_utc": game_date_utc,
                    "away_sp": _last_name(away_sp.get("fullName", "")) if away_sp else "",
                    "home_sp": _last_name(home_sp.get("fullName", "")) if home_sp else "",
                    "home_score": home_score if home_score is not None else None,
                    "away_score": away_score if away_score is not None else None,
                    "current_inning": current_inning,
                    "inning_half": inning_half,
                })
        _schedule_cache[cache_key] = (time.time(), games)
        redis_set(redis_key, games, ttl=ttl)
        return games
    except Exception as e:
        print(f"MiLB Schedule API error ({level} {date_str}): {e}")
        return None


# ── Game → level resolution ────────────────────────────────────────────────
# The minors Savant CSV carries no level column, so a date's game_pks are
# classified by asking each level's schedule which games it owns.

_game_level_cache = {}  # { date_str: (timestamp, {game_pk: level}) }


def get_game_level_map(date_str, levels=None, force_refresh=False):
    """{game_pk: level} for a date across the requested levels (default: all).

    A schedule fetch that FAILS contributes nothing rather than mislabeling —
    callers treat an unmapped game_pk as "unknown level" and drop it from
    level-scoped views instead of guessing.
    """
    levels = tuple(levels) if levels else tuple(LEVEL_ORDER)
    cache_key = (date_str, levels)
    ttl = _schedule_cache_ttl(date_str)
    if not force_refresh and cache_key in _game_level_cache:
        ts, mapping = _game_level_cache[cache_key]
        if time.time() - ts < ttl:
            return mapping
    mapping = {}
    for code in levels:
        sched = _get_mlb_schedule(date_str, force_refresh=force_refresh, level=code)
        for g in (sched or []):
            mapping[int(g["game_pk"])] = code
    _game_level_cache[cache_key] = (time.time(), mapping)
    return mapping


def get_statcast_level_game_pks(date_str, force_refresh=False):
    """game_pks on the date that belong to a level WITH Statcast (AAA, AFL)."""
    mapping = get_game_level_map(date_str, levels=STATCAST_LEVELS, force_refresh=force_refresh)
    return set(mapping.keys())


def get_probable_starter_ids(date_str, level=DEFAULT_LEVEL):
    """Return the set of MLB pitcher IDs listed as probable starters for the
    given date (away + home across every game). Used by warmup-daily-players
    so the per-pitcher caches (player_v2, season_totals) are warm for today's
    starters too — not just yesterday's actual pitchers — so the first card
    view of a starter who didn't pitch yesterday hits a warm cache instead of
    a per-pitcher Savant fallback. Returns an empty set on any error.
    """
    try:
        url = MLB_SCHEDULE_URL(date_str, level)
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        ids = set()
        for date_entry in data.get("dates", []):
            for g in date_entry.get("games", []):
                for side in ("away", "home"):
                    sp = g["teams"][side].get("probablePitcher") or {}
                    pid = sp.get("id")
                    if pid:
                        ids.add(int(pid))
        return ids
    except Exception as e:
        print(f"[ProbableStarters] error for {date_str}: {e}")
        return set()


def get_default_date():
    """Return the smart default date:
    - Yesterday (ET) if no game has started today yet
    - Today (ET) once any game is in progress or finished
    The 'day' starts at 5 AM ET — before that, treat it as the prior day."""
    now = _now_et()
    # Before 5 AM ET, treat "today" as the prior calendar day
    if now.hour < 5:
        now = now - timedelta(days=1)
    today_str = now.strftime("%Y-%m-%d")
    yesterday_str = (now - timedelta(days=1)).strftime("%Y-%m-%d")

    # Check if any AAA game today has started. AAA is the default level and the
    # deepest minors schedule, so it's the right proxy for "is there baseball".
    not_started = {"Scheduled", "Pre-Game", "Warmup", "Delayed Start"}
    schedule = _get_mlb_schedule(today_str, level=DEFAULT_LEVEL)
    if schedule:
        if any(g.get("status") not in not_started for g in schedule):
            return today_str
        # All games show not_started — but if any game's scheduled start
        # time has already passed, the cache is likely stale. Force a fresh
        # API fetch to verify.
        from datetime import timezone as _tz
        now_utc = datetime.now(_tz.utc)
        should_have_started = False
        for g in schedule:
            game_utc_str = g.get("game_date_utc", "")
            if game_utc_str:
                try:
                    game_utc = datetime.fromisoformat(game_utc_str.replace("Z", "+00:00"))
                    if now_utc >= game_utc:
                        should_have_started = True
                        break
                except Exception:
                    pass
        if should_have_started:
            schedule = _get_mlb_schedule(today_str, force_refresh=True, level=DEFAULT_LEVEL)
            if schedule and any(g.get("status") not in not_started for g in schedule):
                return today_str
    # No games started today (or no games at all) — show yesterday
    return yesterday_str

def get_games(date_str, level=DEFAULT_LEVEL):
    # Level is in the cache key: AAA and AA both play on the same date and
    # would otherwise overwrite each other's games list.
    level = normalize_level(level)
    cache_key = f"games_{level}_{date_str}"
    cacheable = not _is_today(date_str)
    if cacheable:
        cached = get_agg_cache(cache_key)
        if cached is not None:
            return cached

    mlb_games = _get_mlb_schedule(date_str, level=level)
    if mlb_games:
        # Today: keep the games list lightweight by reusing only fresh in-memory
        # day data when it already exists. Otherwise return schedule/status info
        # without forcing a new Savant pull just to derive `has_data`.
        if not cacheable:
            data_pks = _cached_live_day_game_pks(date_str)
            result = []
            for g in mlb_games:
                row = dict(g)
                if data_pks is not None:
                    row["has_data"] = row["game_pk"] in data_pks
                elif _game_has_started(row):
                    # We know the game is underway/final, but we intentionally
                    # skip the heavy day-data fetch here. Leave `has_data`
                    # unknown so the UI stays clickable without painting a false
                    # "no data" state.
                    row["has_data"] = None
                else:
                    row["has_data"] = False
                result.append(row)
            return sorted(result, key=lambda g: g.get("game_date_utc", "") or "9999")

        df = fetch_date(date_str)  # This includes MLB API fallback data
        data_pks = set(df["game_pk"].unique()) if not df.empty else set()
        result = []
        for g in mlb_games:
            row = dict(g)
            row["has_data"] = row["game_pk"] in data_pks
            result.append(row)
        # Sort by game start time (UTC ISO string sorts correctly)
        result = sorted(result, key=lambda g: g.get("game_date_utc", "") or "9999")
        if cacheable:
            set_agg_cache(cache_key, result)
        return result

    # Fallback to Savant-only if the schedule API fails. Only meaningful for a
    # Statcast level — every other level IS the schedule, so it returns nothing.
    if not is_statcast_level(level):
        return []
    df = fetch_date(date_str)  # This now includes MLB API fallback data
    if df.empty:
        return []
    if "level" in df.columns:
        df = df[df["level"] == level]
        if df.empty:
            return []
    games = []
    for game_pk, gdf in df.groupby("game_pk"):
        home = gdf["home_team"].iloc[0]
        away = gdf["away_team"].iloc[0]
        games.append({"game_pk": int(game_pk), "label": f"{away} @ {home}", "home_team": home, "away_team": away, "has_data": True,
                       "level": level,
                       "home_org": org_for_team(abbrev=home, level=level),
                       "away_org": org_for_team(abbrev=away, level=level),
                       "status": "", "abstract_state": "", "game_time_et": "", "game_date_utc": "",
                       "away_sp": "", "home_sp": "", "home_score": None, "away_score": None,
                       "current_inning": 0, "inning_half": ""})
    result = sorted(games, key=lambda g: g.get("game_date_utc", "") or "9999")
    if cacheable:
        set_agg_cache(cache_key, result)
    return result

_boxscore_cache = {}  # { game_pk: (timestamp, stats_map) }
_game_state_cache = {}  # { game_pk: { home_score, away_score, inning, inning_half, status } }
BOXSCORE_LIVE_TTL = 60  # seconds — refetch live game boxscores after this

def _get_boxscore_stats(game_pk, force_refresh=False):
    """Fetch pitching stats per pitcher from MLB Stats API boxscore.
    Returns dict: { pitcher_id: { 'er': int, 'runs': int, 'ip': str, 'hits': int, 'bbs': int, 'ks': int, 'hrs': int, 'batters_faced': int } }
    Live games use a 60s TTL; final games cache forever."""
    if force_refresh:
        _boxscore_cache.pop(int(game_pk), None)
        _game_state_cache.pop(int(game_pk), None)
        redis_delete(f"boxscore:{int(game_pk)}")
        redis_delete(f"gamestate:{int(game_pk)}")

    if game_pk in _boxscore_cache:
        ts, cached_stats = _boxscore_cache[game_pk]
        # Check if game is final (game_state "F" = final)
        gs = _game_state_cache.get(game_pk, {})
        is_final = gs.get("game_state", "") == "F"
        if is_final or (time.time() - ts) < BOXSCORE_LIVE_TTL:
            return cached_stats
        # Live game with stale cache — refetch below
    # L2: Redis (check game state to decide if we should use it)
    redis_val = None if force_refresh else redis_get(f"boxscore:{game_pk}")
    if redis_val is not None:
        converted = {int(k): v for k, v in redis_val.items()}
        # Also restore game state from Redis
        gs_val = redis_get(f"gamestate:{game_pk}")
        if gs_val is not None:
            _game_state_cache[game_pk] = gs_val
        # If game is final in Redis, cache forever
        is_final = (gs_val or {}).get("game_state", "") == "F"
        _boxscore_cache[game_pk] = (time.time(), converted)
        if is_final:
            return converted
        # Live game — only use Redis if no in-memory was available (first load)
        # On subsequent calls the TTL check above will handle refetching
        return converted
    try:
        url = f"https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"
        resp = requests.get(url, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        box = data.get("liveData", {}).get("boxscore", {})
        stats_map = {}
        for side in ["away", "home"]:
            team = box.get("teams", {}).get(side, {})
            for pid in team.get("pitchers", []):
                pinfo = team.get("players", {}).get(f"ID{pid}", {})
                stats = pinfo.get("stats", {}).get("pitching", {})
                er = stats.get("earnedRuns")
                runs = stats.get("runs")
                ip = stats.get("inningsPitched")
                hits = stats.get("hits")
                bbs = stats.get("baseOnBalls")
                ks = stats.get("strikeOuts")
                hrs = stats.get("homeRuns")
                bf = stats.get("battersFaced")
                gs = stats.get("gamesStarted")
                note = stats.get("note", "")
                if er is not None or ip is not None:
                    # Parse decision from note, e.g. "(W, 1-0)" -> "W".
                    # `decision` stays W/L/S-only for backward compat (season
                    # W/L totals key off it). `decision_codes` captures every
                    # token incl. H (hold) and BS (blown save); a note can carry
                    # two, e.g. "(L, 0-1)(BS, 1)" — a blown save that became a loss.
                    decision = ""
                    decision_codes = []
                    if note:
                        import re as _re
                        dm = _re.match(r"\(([WLS])", note)
                        if dm:
                            decision = dm.group(1)
                        decision_codes = _re.findall(r"\(([A-Z]{1,2}),", note)
                    stats_map[pid] = {
                        "er": er if er is not None else 0,
                        "runs": runs if runs is not None else 0,
                        "ip": ip,
                        "hits": hits if hits is not None else 0,
                        "bbs": bbs if bbs is not None else 0,
                        "ks": ks if ks is not None else 0,
                        "hrs": hrs if hrs is not None else 0,
                        "batters_faced": bf if bf is not None else 0,
                        "games_started": gs if gs is not None else 0,
                        "decision": decision,
                        "decision_codes": decision_codes,
                    }
        # Extract game state (scores, inning, status) from linescore
        linescore = data.get("liveData", {}).get("linescore", {})
        game_status = data.get("gameData", {}).get("status", {})
        detailed_state = game_status.get("detailedState", "")
        abstract_state = game_status.get("abstractGameState", "")
        home_score = linescore.get("teams", {}).get("home", {}).get("runs", 0)
        away_score = linescore.get("teams", {}).get("away", {}).get("runs", 0)
        current_inning = linescore.get("currentInning", 0)
        inning_half = linescore.get("inningHalf", "")  # "Top" or "Bottom"
        # Pitcher currently on the mound (the defensive pitcher). Used by the
        # live (T#/B#) indicator to color active vs. removed pitchers. This is
        # stale for final games, which is fine — the frontend only reads it
        # while the game is live.
        current_pitcher_id = ((linescore.get("defense") or {}).get("pitcher") or {}).get("id")
        # Build game state string: F (Final), T7 (Top 7), B3 (Bottom 3)
        if abstract_state == "Final" or "Final" in detailed_state:
            game_state_str = "F"
        elif inning_half and current_inning:
            game_state_str = ("T" if inning_half == "Top" else "B") + str(current_inning)
        else:
            game_state_str = ""
        gs_data = {
            "home_score": home_score if home_score is not None else 0,
            "away_score": away_score if away_score is not None else 0,
            "game_state": game_state_str,
            "current_pitcher_id": current_pitcher_id,
        }
        _game_state_cache[game_pk] = gs_data
        _boxscore_cache[game_pk] = (time.time(), stats_map)
        # Store in Redis with string keys (JSON requirement)
        # Only persist to Redis if game is final — live gamestate stays L1-only
        # (the unconditional write above contradicted this and was firing every
        # cache-miss tick during games).
        if gs_data.get("game_state") == "F":
            redis_set(f"boxscore:{game_pk}", {str(k): v for k, v in stats_map.items()})
            redis_set(f"gamestate:{game_pk}", gs_data)
        return stats_map
    except Exception as e:
        print(f"Error fetching boxscore for game {game_pk}: {e}")
        _boxscore_cache[game_pk] = (time.time(), {})
        return {}

def get_game_state(game_pk):
    """Return game state dict: { home_score, away_score, game_state }."""
    if game_pk not in _game_state_cache:
        # Trigger boxscore fetch which populates game state cache
        _get_boxscore_stats(game_pk)
    return _game_state_cache.get(game_pk, {})

def get_boxscore_full(game_pk):
    """Returns full boxscore stats: { pitcher_id: { er, ip, hits, bbs, ks, hrs } }"""
    return _get_boxscore_stats(game_pk)


def refresh_boxscore_full(game_pk):
    """Force-fetch the official current MLB boxscore and overwrite final-game cache."""
    return _get_boxscore_stats(int(game_pk), force_refresh=True)


_CORRECTION_STAT_KEYS = (
    "er", "runs", "ip", "hits", "bbs", "ks", "hrs",
    "batters_faced", "games_started", "decision",
)


def _normalize_correction_value(value):
    if value is None:
        return ""
    return str(value)


def check_boxscore_stat_corrections(game_pks):
    """Compare cached final pitcher lines to fresh official MLB boxscores.

    Returns a dict with changed pitcher IDs by game. Only games with an
    existing cached boxscore can produce a correction; uncached games are
    fetched and stored for future comparisons.
    """
    corrections = []
    affected_pitchers = set()
    for raw_gpk in game_pks or []:
        try:
            game_pk = int(raw_gpk)
        except (TypeError, ValueError):
            continue

        cached = get_boxscore_full(game_pk) or {}
        fresh = refresh_boxscore_full(game_pk) or {}
        if not cached:
            continue

        changed_pitchers = []
        for pid, fresh_stats in fresh.items():
            old_stats = cached.get(pid)
            if not old_stats:
                continue
            changes = {}
            for key in _CORRECTION_STAT_KEYS:
                old_val = _normalize_correction_value(old_stats.get(key))
                new_val = _normalize_correction_value(fresh_stats.get(key))
                if old_val != new_val:
                    changes[key] = {"old": old_stats.get(key), "new": fresh_stats.get(key)}
            if changes:
                changed_pitchers.append({"pitcher_id": int(pid), "changes": changes})
                affected_pitchers.add(int(pid))

        if changed_pitchers:
            corrections.append({"game_pk": game_pk, "pitchers": changed_pitchers})

    return {
        "corrections": corrections,
        "affected_pitchers": sorted(affected_pitchers),
    }


# ── Linescore + Play-by-Play ──────────────────────────────────────────

_feed_cache = {}  # { game_pk: (timestamp, full_json) }
FEED_LIVE_TTL = 60  # seconds — refetch live game feeds after this

_TERMINAL_DETAILED_STATES = frozenset({"Final", "Game Over", "Completed Early"})


def _is_game_final(feed_json):
    """Check if a game feed indicates the game is over.

    Matches the frontend's `isFinal` in GameTabs.jsx. The previous
    `"Final" in detailed` substring check was loose enough that any future
    MLB API status string containing the literal word "Final" (e.g. a
    transient "Final (Postponed)") could pin a game as terminal and pollute
    the Redis feed cache permanently.
    """
    if not feed_json:
        return False
    status = feed_json.get("gameData", {}).get("status", {})
    abstract = status.get("abstractGameState", "")
    detailed = status.get("detailedState", "")
    return abstract == "Final" or detailed in _TERMINAL_DETAILED_STATES


def _reduce_game_feed(feed_json):
    """Keep only fields used by pitch reconstruction and linescore/PBP UI."""
    if not feed_json:
        return feed_json
    game_data = feed_json.get("gameData", {}) or {}
    live_data = feed_json.get("liveData", {}) or {}
    return {
        "gameData": {
            "status": game_data.get("status", {}),
            "teams": game_data.get("teams", {}),
            "game": game_data.get("game", {}),
        },
        "liveData": {
            "linescore": live_data.get("linescore", {}),
            "plays": {
                "allPlays": (live_data.get("plays", {}) or {}).get("allPlays", []),
            },
        },
    }


def _feed_has_plays(feed_json):
    """True if the feed has at least one PA in liveData.plays.allPlays."""
    if not feed_json:
        return False
    plays = (feed_json.get("liveData", {}) or {}).get("plays", {}) or {}
    return bool(plays.get("allPlays"))


def _get_game_feed(game_pk):
    """Fetch and cache the MLB Stats API game feed.
    Live games use a 60s in-memory TTL; final games persist a reduced
    linescore/play-by-play projection in Redis."""
    if game_pk in _feed_cache:
        ts, data = _feed_cache[game_pk]
        # Trust the in-memory cache for live games only inside the TTL window,
        # and for terminal-state games only when they actually have plays —
        # an empty-plays Final entry (briefly Postponed/Cancelled/etc.) would
        # otherwise stick forever and shadow the real feed for the same pk.
        if (time.time() - ts) < FEED_LIVE_TTL:
            return data
        if _is_game_final(data) and _feed_has_plays(data):
            return data
        # Live game with stale cache, or terminal-state cache with no plays —
        # refetch below.
    # L2: Redis (only stores completed game feeds).
    # Same sanity check: an empty-plays cached payload is treated as a miss so
    # a previously-polluted key can't permanently override a now-live game.
    redis_val = redis_get(f"feed:{game_pk}")
    if redis_val is not None and _feed_has_plays(redis_val):
        _feed_cache[game_pk] = (time.time(), redis_val)
        return redis_val
    try:
        url = MLB_GAME_FEED_URL.format(game_pk=game_pk)
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        _feed_cache[game_pk] = (time.time(), data)
        # Persist to Redis only when the game is final AND actually has plays.
        # Caching an empty-plays "Final" (e.g. a rescheduled doubleheader game
        # whose pk briefly carried a postponed/cancelled status) would lock the
        # pk to an empty payload across restarts.
        if _is_game_final(data) and _feed_has_plays(data):
            redis_set(f"feed:{game_pk}", _reduce_game_feed(data))
        return data
    except Exception as e:
        print(f"Error fetching game feed for {game_pk}: {e}")
        return None

def get_game_linescore(game_pk, pitcher_id=None):
    """Return linescore, play-by-play, and pitcher exit info for a game."""
    feed = _get_game_feed(game_pk)
    if not feed:
        return {}

    game_data = feed.get("gameData", {})
    teams = game_data.get("teams", {})
    away_abbrev = teams.get("away", {}).get("abbreviation", "")
    home_abbrev = teams.get("home", {}).get("abbreviation", "")

    live = feed.get("liveData", {})

    # ── Linescore ──
    ls = live.get("linescore", {})
    innings_raw = ls.get("innings", [])
    innings = []
    game_status = game_data.get("status", {}).get("detailedState", "")
    is_final = game_status in ("Final", "Game Over", "Completed Early")
    current_inning = ls.get("currentInning", 0) or 0
    inning_half = ls.get("inningHalf", "")
    inning_state = ls.get("inningState", "")

    def _line_stat(team_line, key):
        return team_line.get(key) if key in team_line else None

    def _blank_line():
        return {"runs": None, "hits": None, "errors": None}

    def _half_has_started(inning_num, is_top):
        if is_final:
            return True
        if not current_inning:
            return False
        if inning_num < current_inning:
            return True
        if inning_num > current_inning:
            return False
        if is_top:
            return True
        return str(inning_half or inning_state).lower() in {"bottom", "end"}

    for inn in innings_raw:
        inning_num = inn.get("num", 0)
        away_line = inn.get("away", {})
        home_line = inn.get("home", {})
        innings.append({
            "num": inning_num,
            "away": {
                "runs": _line_stat(away_line, "runs"),
                "hits": _line_stat(away_line, "hits"),
                "errors": _line_stat(away_line, "errors"),
            } if _half_has_started(inning_num, True) else _blank_line(),
            "home": {
                "runs": _line_stat(home_line, "runs"),
                "hits": _line_stat(home_line, "hits"),
                "errors": _line_stat(home_line, "errors"),
            } if _half_has_started(inning_num, False) else _blank_line(),
        })

    ls_teams = ls.get("teams", {})
    totals = {
        "away": {
            "runs": ls_teams.get("away", {}).get("runs", 0),
            "hits": ls_teams.get("away", {}).get("hits", 0),
            "errors": ls_teams.get("away", {}).get("errors", 0),
        },
        "home": {
            "runs": ls_teams.get("home", {}).get("runs", 0),
            "hits": ls_teams.get("home", {}).get("hits", 0),
            "errors": ls_teams.get("home", {}).get("errors", 0),
        },
    }

    # ── Play-by-play ──
    all_plays = live.get("plays", {}).get("allPlays", [])
    # Group plays by (inning, isTop)
    half_innings = {}  # { (inning, is_top): [pa, ...] }
    # Track pitcher appearances: { pitcher_id: { last_inning, last_top, innings_set } }
    pitcher_tracker = {}

    for pa in all_plays:
        about = pa.get("about", {})
        inning = about.get("inning", 0)
        is_top = about.get("isTopInning", True)
        key = (inning, is_top)

        matchup = pa.get("matchup", {})
        batter_name = matchup.get("batter", {}).get("fullName", "")
        batter_id = matchup.get("batter", {}).get("id", 0)
        p_name = matchup.get("pitcher", {}).get("fullName", "")
        p_id = matchup.get("pitcher", {}).get("id", 0)
        bat_side = matchup.get("batSide", {}).get("code", "R")

        result = pa.get("result", {})
        result_event = result.get("event", "")
        result_desc = result.get("description", "")

        # Annotate WP/PB-caused runner movements on every PA, and also ensure
        # walk/HBP PAs list all base movements.
        _evt_lower = (result_event or "").lower().replace(" ", "_")
        result_desc = _enrich_pa_description(
            result_desc,
            pa.get("runners"),
            include_plain=_evt_lower in ("walk", "intentional_walk", "hit_by_pitch"),
            play_events=pa.get("playEvents"),
        )

        result_rbi = result.get("rbi", 0)
        result_home_score = result.get("homeScore")
        result_away_score = result.get("awayScore")

        # Hit data for this PA — could be on PA level or last playEvent
        pa_hit = pa.get("hitData") or {}
        if not pa_hit:
            play_events_all = pa.get("playEvents", [])
            if play_events_all:
                pa_hit = play_events_all[-1].get("hitData") or {}
        pa_ls = pa_hit.get("launchSpeed")
        pa_la = pa_hit.get("launchAngle")
        pa_hcx = pa_hit.get("coordinates", {}).get("coordX")
        pa_hcy = pa_hit.get("coordinates", {}).get("coordY")
        pa_trajectory = pa_hit.get("trajectory")  # ground_ball, fly_ball, line_drive, popup
        pa_hardness = pa_hit.get("hardness")  # hard, medium, soft
        pa_total_distance = pa_hit.get("totalDistance")
        pa_outs = about.get("outs", 0) if about else 0

        # Build pitch list (including non-pitch events like pickoffs, stolen bases)
        all_play_events = pa.get("playEvents", [])
        pitches = []
        balls = 0
        strikes = 0
        pitch_num = 0

        def _is_real_pitch(e):
            # Exclude intentional-ball ("I") and automatic-ball ("V") events —
            # no pitch is actually thrown for those (IBB / pitch-clock
            # violation). An IBB should show as a PA with zero pitches.
            return e.get("isPitch") and (e.get("details") or {}).get("code") not in ("I", "V")

        # Pre-compute last REAL pitch index (auto/intentional balls excluded).
        last_pitch_idx = max(
            (i for i, e in enumerate(all_play_events) if _is_real_pitch(e)),
            default=-1,
        )
        for eidx, ev in enumerate(all_play_events):
            det = ev.get("details", {})
            if ev.get("isPitch"):
                # Skip intentional-/automatic-ball "pitches" — an IBB (or a
                # pitch-clock-violation ball) is awarded without a pitch.
                if det.get("code") in ("I", "V"):
                    continue
                pitch_num += 1
                is_last_p = (eidx == last_pitch_idx)
                pd_ = ev.get("pitchData", {})
                pitch_type_code = det.get("type", {}).get("code", "")
                pitch_type_name = PITCH_TYPE_MAP.get(pitch_type_code, pitch_type_code)
                speed = pd_.get("startSpeed")
                desc = det.get("description", "")
                # Normalize: foul tip and swinging strike (blocked) → Swinging Strike
                if desc in ("Foul Tip", "Swinging Strike (Blocked)"):
                    desc = "Swinging Strike"
                code = det.get("code", "")
                p_coords = pd_.get("coordinates", {})
                p_breaks = pd_.get("breaks", {})

                count_str = f"{balls}-{strikes}"

                pitches.append({
                    "num": pitch_num,
                    "type": pitch_type_name,
                    "type_code": pitch_type_code,
                    "speed": round(speed, 1) if speed else None,
                    "desc": desc,
                    "count": count_str,
                    # Location & break for strikezone + hover
                    "plate_x": p_coords.get("pX"),
                    "plate_z": p_coords.get("pZ"),
                    # Per-pitch batter strike zone — lets plots position pitches
                    # relative to each batter's individual zone (matches Savant).
                    "sz_top": pd_.get("strikeZoneTop"),
                    "sz_bot": pd_.get("strikeZoneBottom"),
                    "pfx_x": round(-p_breaks.get("breakHorizontal", 0), 1) if p_breaks.get("breakHorizontal") is not None else None,
                    "pfx_z": round(p_breaks.get("breakVerticalInduced", 0), 1) if p_breaks.get("breakVerticalInduced") is not None else None,
                    "zone": pd_.get("zone"),
                    # Hit data on last pitch only
                    "launch_speed": pa_ls if is_last_p else None,
                    "launch_angle": pa_la if is_last_p else None,
                    "hc_x": pa_hcx if is_last_p else None,
                    "hc_y": pa_hcy if is_last_p else None,
                })

                # Update count for next pitch
                if code in ("B", "H", "P", "I", "V", "*B"):
                    balls = min(balls + 1, 4)
                elif code in ("C", "S", "T", "M", "L", "A", "*S"):
                    strikes = min(strikes + 1, 2)
                elif code == "F" and strikes < 2:
                    strikes += 1
                # X (in play) doesn't change count
            else:
                # Non-pitch event: pickoff, stolen base, balk, wild pitch, etc.
                event_type = det.get("eventType", "") or det.get("event", "") or ""
                desc = det.get("description", "")
                if not desc and not event_type:
                    continue
                # Determine if a run scored on this action
                runner_events = ev.get("runners", [])
                action_scored = any(
                    r.get("movement", {}).get("end") == "score"
                    for r in runner_events
                ) if runner_events else False
                # Determine if it was an error
                action_is_error = any(
                    r.get("details", {}).get("isScoringEvent") and "error" in (r.get("details", {}).get("event", "") or "").lower()
                    for r in runner_events
                ) if runner_events else ("error" in desc.lower())
                pitches.append({
                    "is_action": True,
                    "event_type": event_type,
                    "desc": desc,
                    "scored": action_scored,
                    "is_error": action_is_error,
                    "count": f"{balls}-{strikes}",
                })

        pa_obj = {
            "batter": batter_name,
            "batter_id": batter_id,
            "pitcher": p_name,
            "pitcher_id": p_id,
            "result": result_event,
            "description": result_desc,
            "rbi": result_rbi,
            "pitches": pitches,
            "outs": pa_outs,
            "stand": bat_side,
            "launch_speed": pa_ls,
            "launch_angle": pa_la,
            "hc_x": pa_hcx,
            "hc_y": pa_hcy,
            "trajectory": pa_trajectory,
            "hardness": pa_hardness,
            "total_distance": pa_total_distance,
            "home_score": result_home_score,
            "away_score": result_away_score,
        }

        if key not in half_innings:
            half_innings[key] = []
        half_innings[key].append(pa_obj)

        # Track pitcher appearances
        if p_id not in pitcher_tracker:
            pitcher_tracker[p_id] = {"name": p_name, "last_inning": inning, "last_top": is_top, "innings": set()}
        else:
            pitcher_tracker[p_id]["last_inning"] = inning
            pitcher_tracker[p_id]["last_top"] = is_top
        pitcher_tracker[p_id]["innings"].add(key)

    # Build ordered plays list
    plays = []
    for (inn, top) in sorted(half_innings.keys()):
        plays.append({
            "inning": inn,
            "top": top,
            "pas": half_innings[(inn, top)],
        })

    # Compute pitcher exit info
    pitcher_exit = {}
    for pid, info in pitcher_tracker.items():
        last_inn = info["last_inning"]
        last_top = info["last_top"]
        # Check if pitcher was pulled mid-inning: were there PAs after theirs in the same half-inning?
        key = (last_inn, last_top)
        pas_in_half = half_innings.get(key, [])
        # Find the index of the last PA by this pitcher
        last_idx = -1
        for i, pa in enumerate(pas_in_half):
            if pa["pitcher_id"] == pid:
                last_idx = i
        mid_inning = last_idx < len(pas_in_half) - 1 if last_idx >= 0 else False

        pitcher_exit[str(pid)] = {
            "name": info["name"],
            "last_inning": last_inn,
            "last_top": last_top,
            "mid_inning": mid_inning,
        }

    # Game status
    return {
        "away_team": away_abbrev,
        "home_team": home_abbrev,
        "innings": innings,
        "totals": totals,
        "plays": plays,
        "pitcher_exit": pitcher_exit,
        "is_final": is_final,
    }
