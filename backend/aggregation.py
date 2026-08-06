import numpy as np
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from data import fetch_date, fetch_game_pitches, fetch_pitcher_season, get_boxscore_full, get_game_state
from levels import org_for_team, team_display_name
from season import ip_to_outs as _ip_to_outs, season_start
from caches import season_game_agg_cache as _season_game_agg_cache


def _pitcher_season_game_aggregates(pitcher_id, season_year, before_date=None):
    """Per-game aggregates for a pitcher's season (cached).
    Returns a list of dicts: {game_pk, game_date, pitches, outs, appearance_order}.
    """
    cache_key = (int(pitcher_id), int(season_year), str(before_date) if before_date else None)
    if cache_key in _season_game_agg_cache:
        return _season_game_agg_cache[cache_key]

    # Use the materialized range only if it's ALREADY warm in _range_cache
    # (the homepage compute path keeps it warm via warmup_range_data). Don't
    # trigger a fresh load just to settle opener detection for one pitcher —
    # per-game callers (/api/pitcher-results?game_pk=, /api/game-view,
    # _build_selected_game_payload) would otherwise pay a Upstash range read
    # to slice out a single pitcher. On a cold range we go straight to
    # per-pitcher Savant (~1-3s) for the same data shape.
    df = None
    try:
        from data import _range_cache, _get_default_end_date
        start_date = season_start(season_year)
        end_date = _get_default_end_date()
        cached_range = _range_cache.get((start_date, end_date))
        if cached_range is not None:
            _ts, rng_df = cached_range
            if rng_df is not None and not rng_df.empty and "pitcher" in rng_df.columns:
                df = rng_df[rng_df["pitcher"] == int(pitcher_id)]
                if df.empty:
                    df = None
    except Exception:
        df = None
    if df is None:
        df = fetch_pitcher_season(pitcher_id, season_year)
    if df is None or df.empty:
        _season_game_agg_cache[cache_key] = []
        return []
    if before_date and "game_date" in df.columns:
        df = df[df["game_date"].astype(str) < str(before_date)]
        if df.empty:
            _season_game_agg_cache[cache_key] = []
            return []
    results = []
    group_cols = [c for c in ["game_pk", "game_date"] if c in df.columns]
    if not group_cols:
        _season_game_agg_cache[cache_key] = []
        return []
    for key, gdf in df.groupby(group_cols):
        game_pk = key[0] if isinstance(key, tuple) else key
        game_date = key[1] if isinstance(key, tuple) and len(key) > 1 else ""
        total_pitches = len(gdf)
        if "events" in gdf.columns:
            ev_col = gdf["events"].dropna()
            ev_col = ev_col[ev_col.astype(str) != ""].astype(str).str.lower()
            outs = _compute_outs_vectorized(ev_col)
        else:
            outs = 0
        appearance_order = int(gdf["at_bat_number"].min()) if "at_bat_number" in gdf.columns and gdf["at_bat_number"].notna().any() else 999
        results.append({
            "game_pk": int(game_pk),
            "game_date": str(game_date),
            "pitches": int(total_pitches),
            "outs": int(outs),
            "appearance_order": appearance_order,
        })
    _season_game_agg_cache[cache_key] = results
    return results


def _check_opener_swap(first, second, season_year, before_date=None):
    """Return True if the 'opener' swap applies (first=RP, second=SP).

    All four conditions must be true:
      A: first pitcher never threw more than 3 IP in any game this season
      B: first pitcher threw < 50 pitches OR <= 2 IP in this game
      C: second pitcher has thrown > 60 pitches in at least one game this season
         AND was labeled as SP (appearance_order == 1) in at least one prior game
      D: second pitcher threw more IP OR more pitches than first in this game
    """
    first_pitches = int(first.get("pitches", 0) or 0)
    first_outs = _ip_to_outs(first.get("ip", "0.0"))
    cond_b = first_pitches < 50 or first_outs <= 6
    if not cond_b:
        return False

    second_pitches = int(second.get("pitches", 0) or 0)
    second_outs = _ip_to_outs(second.get("ip", "0.0"))
    cond_d = (second_outs > first_outs) or (second_pitches > first_pitches)
    if not cond_d:
        return False

    first_season = _pitcher_season_game_aggregates(first["pitcher_id"], season_year, before_date=before_date)
    cond_a = all(g["outs"] <= 9 for g in first_season)
    if not cond_a:
        return False

    second_season = _pitcher_season_game_aggregates(second["pitcher_id"], season_year, before_date=before_date)
    cond_c_pitches = any(g["pitches"] > 60 for g in second_season)
    if not cond_c_pitches:
        return False
    cond_c_sp = any(g["appearance_order"] == 1 for g in second_season)
    return cond_c_sp


def classify_pitcher_roles(results_for_game, season_year=None, before_date=None):
    """Classify pitchers in a game as 'SP' or 'RP'.

    results_for_game: list of result rows for a single game's pitchers. Each row
    needs pitcher_id, team, appearance_order, ip, and pitches.

    Default rule: first pitcher (lowest appearance_order) per team = SP, rest = RP.
    Opener override: if _check_opener_swap returns True, first = RP and second = SP.

    Returns dict { pitcher_id: 'SP' | 'RP' }.
    """
    roles = {}
    if not results_for_game:
        return roles
    by_team = {}
    for r in results_for_game:
        by_team.setdefault(r.get("team", ""), []).append(r)
    for team, rows in by_team.items():
        sorted_rows = sorted(rows, key=lambda r: r.get("appearance_order", 999))
        for i, r in enumerate(sorted_rows):
            roles[r["pitcher_id"]] = "SP" if i == 0 else "RP"
        if len(sorted_rows) >= 2 and season_year is not None:
            first = sorted_rows[0]
            second = sorted_rows[1]
            if _check_opener_swap(first, second, season_year, before_date=before_date):
                roles[first["pitcher_id"]] = "RP"
                roles[second["pitcher_id"]] = "SP"
    return roles

# ── Vectorized classification sets ──
_SWING_DESCS = frozenset(["hit_into_play", "foul", "swinging_strike", "foul_tip", "swinging_strike_blocked", "foul_bunt", "missed_bunt", "bunt_foul_tip"])
_WHIFF_DESCS = frozenset(["swinging_strike", "swinging_strike_blocked", "foul_tip"])
_STRIKE_TYPES = frozenset(["S", "X"])
_HIT_EVENTS = frozenset(["single", "double", "triple", "home_run"])
_BB_EVENTS = frozenset(["walk"])
_K_EVENTS = frozenset(["strikeout", "strikeout_double_play"])
_HR_EVENTS = frozenset(["home_run"])


def _compute_two_strike_pa_stats(gdf):
    """Return (pa_count, two_strike_pas, two_strike_pitches, strikeouts) for a pitch DataFrame.

    - pa_count: total PAs (unique at_bat_numbers). Used as denominator for 2Str%.
    - two_strike_pas: PAs where any pitch was thrown with strikes >= 2 (i.e.
      the PA "reached" a 2-strike count). Numerator for 2Str% and
      denominator for PAR%.
    - two_strike_pitches: number of pitches thrown with strikes >= 2 at release.
      Retained as a raw counter for views that still need per-pitch context.
    - strikeouts: PAs that ended in a strikeout (events in _K_EVENTS).
      Raw K counter retained for total recomputation.
    """
    if gdf is None or gdf.empty or "at_bat_number" not in gdf.columns or "strikes" not in gdf.columns:
        return 0, 0, 0, 0
    strikes_col = gdf["strikes"]
    pa_two_strikes = gdf.groupby("at_bat_number")["strikes"].max() >= 2
    pa_count = int(pa_two_strikes.size)
    two_strike_pas = int(pa_two_strikes.sum())
    two_strike_pitches = int((strikes_col >= 2).sum())
    if "events" in gdf.columns:
        strikeouts = int(gdf["events"].dropna().astype(str).str.lower().isin(_K_EVENTS).sum())
    else:
        strikeouts = 0
    return pa_count, two_strike_pas, two_strike_pitches, strikeouts
_OUT_EVENTS = frozenset(["field_out", "strikeout", "grounded_into_double_play", "force_out", "double_play",
                          "fielders_choice", "fielders_choice_out", "strikeout_double_play", "triple_play",
                          "sac_fly", "sac_bunt", "sac_fly_double_play", "sac_bunt_double_play"])
_DOUBLE_PLAY_EVENTS = frozenset(["grounded_into_double_play", "double_play", "strikeout_double_play",
                                   "sac_fly_double_play", "sac_bunt_double_play"])
_TRIPLE_PLAY_EVENTS = frozenset(["triple_play"])

_HAVAA_COLS = ("vy0", "vz0", "ay", "az", "plate_z")


def _havaa_series(df):
    """HAVAA (Height-Adjusted Vertical Approach Angle), vectorized.
    From the pitch_angles.py reference implementation. Caller must ensure the
    _HAVAA_COLS columns exist."""
    vy0 = pd.to_numeric(df["vy0"], errors="coerce")
    vz0 = pd.to_numeric(df["vz0"], errors="coerce")
    ay = pd.to_numeric(df["ay"], errors="coerce")
    az = pd.to_numeric(df["az"], errors="coerce")
    pz = pd.to_numeric(df["plate_z"], errors="coerce")
    # vYf: velocity at plate (y direction), from y0=50 to y=17/12
    vy_f = -1 * (vy0 ** 2 - (2 * ay * (50 - 17.0 / 12.0))).clip(lower=0) ** 0.5
    # Time from y0=50 to plate
    t = np.where(ay != 0, (vy_f - vy0) / ay, 0)
    # vZf: vertical velocity at plate
    vz_f = vz0 + az * t
    # Raw VAA
    vaa = -1 * np.arctan(vz_f / vy_f) * (180.0 / np.pi)
    # Piecewise height adjustment
    vaa_z_adj = np.where(pz < 3.5,
                         pz * 1.5635 + (-10.092),
                         pz ** 2 * (-0.1996) + pz * 2.704 + (-11.69))
    return np.round(vaa - vaa_z_adj, 1)


def _prep_df(df):
    """Add computed boolean columns to a DataFrame for aggregation (vectorized)."""
    df = df.copy()
    # Vectorized zone check: convert to numeric, check 1-9
    zone_num = pd.to_numeric(df["zone"], errors="coerce")
    df["in_zone"] = (zone_num >= 1) & (zone_num <= 9)
    # Vectorized description checks using .isin()
    desc = df["description"]
    df["is_swing"] = desc.isin(_SWING_DESCS)
    df["is_whiff"] = desc.isin(_WHIFF_DESCS)
    df["is_called_strike"] = desc == "called_strike"
    # Vectorized strike check on type column
    df["is_strike"] = df["type"].isin(_STRIKE_TYPES) if "type" in df.columns else False
    if all(c in df.columns for c in _HAVAA_COLS):
        df["havaa"] = _havaa_series(df)
    return df


def _compute_outs_vectorized(events_series):
    """Compute total outs from an events Series without iterrows."""
    if events_series.empty:
        return 0
    is_out = events_series.isin(_OUT_EVENTS)
    is_dp = events_series.isin(_DOUBLE_PLAY_EVENTS)
    is_tp = events_series.isin(_TRIPLE_PLAY_EVENTS)
    # base outs: 1 per out event, +1 extra for DP, +2 extra for TP
    outs = int(is_out.sum()) + int(is_dp.sum()) + int(is_tp.sum() * 2)
    return outs

def _aggregate_pitch_df(df, full_df=None):
    """Core aggregation logic. df is the subset to aggregate, full_df is the full pitcher context for totals."""
    if full_df is None:
        full_df = df
    results = []
    if df.empty:
        return results

    # Pre-compute pitcher totals per game as a lookup dict (avoids per-row filtering)
    pitcher_game_totals = full_df.groupby(["pitcher", "game_pk"]).size().to_dict()
    # Pre-compute pitcher vs R/L totals per game
    if "stand" in full_df.columns:
        stand_totals = full_df.groupby(["pitcher", "game_pk", "stand"]).size().to_dict()
    else:
        stand_totals = {}

    grouped = df.groupby(["pitcher", "player_name", "pitcher_team", "opponent", "p_throws", "pitch_name", "game_pk"])
    for (pitcher_id, name, team, opp, hand, pitch_name, gp), gdf in grouped:
        pitch_type = gdf["pitch_type"].mode().iloc[0] if "pitch_type" in gdf.columns and not gdf["pitch_type"].mode().empty else ""
        total = len(gdf)
        pitcher_total = pitcher_game_totals.get((pitcher_id, gp), 0)
        stand_counts = gdf["stand"].value_counts() if "stand" in gdf.columns else pd.Series(dtype=int)
        vs_r_count = int(stand_counts.get("R", 0))
        vs_l_count = int(stand_counts.get("L", 0))
        in_zone = int(gdf["in_zone"].sum())
        out_zone = total - in_zone
        whiffs = int(gdf["is_whiff"].sum())
        called_strikes = int(gdf["is_called_strike"].sum())
        strikes = int(gdf["is_strike"].sum())
        o_swings = int(gdf.loc[~gdf["in_zone"], "is_swing"].sum()) if out_zone > 0 else 0
        pitcher_vs_r_total = stand_totals.get((pitcher_id, gp, "R"), 0)
        pitcher_vs_l_total = stand_totals.get((pitcher_id, gp, "L"), 0)

        appearance_order = int(gdf["at_bat_number"].min()) if "at_bat_number" in gdf.columns and gdf["at_bat_number"].notna().any() else 999

        row_level = gdf["level"].iloc[0] if "level" in gdf.columns and gdf["level"].notna().any() else None
        row = {
            "pitcher_id": int(pitcher_id), "game_pk": int(gp),
            "pitcher": name, "team": team, "hand": hand, "opponent": opp,
            "level": row_level,
            "team_display": team_display_name(abbrev=team, level=row_level),
            "org": org_for_team(abbrev=team, level=row_level),
            "opponent_org": org_for_team(abbrev=opp, level=row_level),
            "pitch_type": pitch_type, "pitch_name": pitch_name, "count": total,
            "velo": round(gdf["release_speed"].mean(), 1) if gdf["release_speed"].notna().any() else None,
            "usage": round(total / pitcher_total * 100, 1) if pitcher_total > 0 else 0,
            "vs_r": round(vs_r_count / total * 100, 1) if total > 0 else 0,
            "vs_l": round(vs_l_count / total * 100, 1) if total > 0 else 0,
            "usage_vs_r": round(vs_r_count / pitcher_vs_r_total * 100, 1) if pitcher_vs_r_total > 0 else 0,
            "usage_vs_l": round(vs_l_count / pitcher_vs_l_total * 100, 1) if pitcher_vs_l_total > 0 else 0,
            "count_vs_r": vs_r_count, "count_vs_l": vs_l_count,
            "ext": round(gdf["release_extension"].mean(), 1) if gdf["release_extension"].notna().any() else None,
            "ivb": round(gdf["pfx_z"].mean() * 12, 1) if gdf["pfx_z"].notna().any() else None,
            "ihb": round(gdf["pfx_x"].mean() * 12, 1) if gdf["pfx_x"].notna().any() else None,
            "havaa": round(gdf["havaa"].mean(), 1) if "havaa" in gdf.columns and gdf["havaa"].notna().any() else None,
            "whiffs": whiffs,
            "zone_pct": round(in_zone / total * 100, 1) if total > 0 else 0,
            "o_swing_pct": round(o_swings / out_zone * 100, 1) if out_zone > 0 else 0,
            # Rate stats are sent unrounded so the frontend's single Math.round
            # at display time agrees with ResultsTable, which rounds the raw
            # ratio in one step. Rounding here to 1 decimal first introduced a
            # double-rounding bug — values like 45.4545% snapped to 45.5,
            # which fmtPct then rounded UP to 46% (vs 45% from a one-step
            # round of the raw ratio).
            "strike_pct": (strikes / total * 100) if total > 0 else 0,
            "cs_pct": (called_strikes / total * 100) if total > 0 else 0,
            "swstr_pct": (whiffs / total * 100) if total > 0 else 0,
            "csw_pct": ((called_strikes + whiffs) / total * 100) if total > 0 else 0,
            "appearance_order": appearance_order,
            "home_team": gdf["home_team"].iloc[0] if "home_team" in gdf.columns else "",
            "away_team": gdf["away_team"].iloc[0] if "away_team" in gdf.columns else "",
        }
        results.append(row)
    results.sort(key=lambda r: (r["pitcher"], r["pitch_name"]))
    return results

def _filter_level(df, level):
    """Keep only rows from `level`. fetch_date returns every Statcast level for
    the date (AAA + AFL), so views scoped to one level slice here."""
    if df is None or df.empty or not level or "level" not in df.columns:
        return df
    return df[df["level"] == level]


def aggregate_pitch_data(date_str, game_pk=None, df=None, level=None):
    if df is None:
        df = fetch_date(date_str)
    if df.empty: return []
    df = _filter_level(df, level)
    if df.empty: return []
    if game_pk is not None:
        df = df[df["game_pk"] == game_pk]
        if df.empty: return []
    df = _prep_df(df)
    return _aggregate_pitch_df(df)

_FASTBALL_TYPES = ("Four-Seamer", "Sinker")


def _compute_game_fastball_velo(gdf):
    """Find the most-thrown fastball (Four-Seamer or Sinker) in a game df and
    return (pitch_name, mean_velo, mean_extension). Ties go to Four-Seamer.
    Either velo or ext can be None independently if their column is missing/all-NaN."""
    if gdf.empty or "pitch_name" not in gdf.columns:
        return None, None, None
    fb_df = gdf[gdf["pitch_name"].isin(_FASTBALL_TYPES)]
    if fb_df.empty:
        return None, None, None
    counts = fb_df["pitch_name"].value_counts()
    four_seam = int(counts.get("Four-Seamer", 0))
    sinker = int(counts.get("Sinker", 0))
    if four_seam == 0 and sinker == 0:
        return None, None, None
    pick = "Four-Seamer" if four_seam >= sinker else "Sinker"
    pick_df = fb_df[fb_df["pitch_name"] == pick]
    velo = None
    if "release_speed" in pick_df.columns and not pick_df["release_speed"].isna().all():
        velo = round(float(pick_df["release_speed"].mean()), 1)
    ext = None
    if "release_extension" in pick_df.columns and not pick_df["release_extension"].isna().all():
        ext = round(float(pick_df["release_extension"].mean()), 1)
    return pick, velo, ext


def _season_velo_day_partial(date_str, before_date):
    """Read one persisted range-day from Redis and return its per-(pitcher,
    pitch_name) fastball [velo_sum, velo_n, ext_sum, ext_n] partials.

    Returns None if the day isn't materialized (caller treats the whole range
    as not-ready), or {} for a materialized day with no qualifying fastballs.
    Built to run in a thread pool: it decompresses one ~2-3 MB day, extracts
    small partial sums, and discards the frame — so many days can be read in
    parallel without ever holding the whole range in memory.
    """
    from data import redis_get, _range_day_key, _decompress_records, _records_to_df
    records = _decompress_records(redis_get(_range_day_key(date_str)))
    if records is None:
        return None
    if not records:
        return {}
    day_df = _records_to_df(records)
    if day_df.empty or not all(c in day_df.columns for c in ("pitcher", "pitch_name", "release_speed")):
        return {}
    fb = day_df[day_df["pitch_name"].isin(_FASTBALL_TYPES)]
    if before_date is not None and "game_date" in fb.columns:
        fb = fb[fb["game_date"].astype(str) < str(before_date)]
    if fb.empty:
        return {}
    has_ext = "release_extension" in fb.columns
    cols = ["pitcher", "pitch_name", "release_speed"] + (["release_extension"] if has_ext else [])
    partial = {}
    for prow in fb[cols].itertuples(index=False):
        if pd.isna(prow.pitcher):
            continue
        slot = partial.get((prow.pitcher, prow.pitch_name))
        if slot is None:
            slot = [0.0, 0, 0.0, 0]
            partial[(prow.pitcher, prow.pitch_name)] = slot
        if pd.notna(prow.release_speed):
            slot[0] += float(prow.release_speed)
            slot[1] += 1
        if has_ext and pd.notna(prow.release_extension):
            slot[2] += float(prow.release_extension)
            slot[3] += 1
    return partial


def _compute_season_fastball_velos(pitcher_ids, season_year, before_date=None):
    """Batch-compute season-to-date fastball mean velos AND mean extensions
    for a list of pitcher IDs.

    Cached in Redis under a small per-(season, before_date, override_version)
    key. The full computed result for ALL pitchers is ~30 KB JSON, vs. the
    ~20 MB range read it replaces — the homepage was timing out at 45s on
    cold starts because every request was re-decompressing 52 days of pitch
    data just to recompute the same per-pitcher means.

    Returns {pitcher_id: {"Four-Seamer": {"velo": x, "ext": y}, "Sinker": ...}}.
    """
    if not pitcher_ids or season_year is None:
        return {}
    pid_set = {int(p) for p in pitcher_ids}

    # Tiny Redis cache. Key includes override_version so a reclassification
    # naturally busts it. The result is ALL pitchers in the range — same
    # cache serves every caller for the same before_date.
    from data import get_override_version
    from redis_cache import redis_get as _rget, redis_set as _rset
    cache_key = f"season_velos:y{int(season_year)}:b{before_date or 'open'}:v{get_override_version()}"
    cached = _rget(cache_key)
    if isinstance(cached, dict):
        # JSON deserialization turns int keys into strings.
        return {int(p): (cached.get(str(p)) or {}) for p in pid_set if str(p) in cached}

    # Read the season's per-day snapshots in parallel and accumulate per-(pitcher,
    # pitch_name) fastball velo/extension sums + counts. A running mean only needs
    # sum/count, and each worker decompresses just one ~2-3 MB day then discards it,
    # so peak memory stays at a handful of days — never the whole ~100-170 MB range
    # (which used to OOM-kill the function on cold loads). The cold cost is ~50+
    # sequential Upstash round-trips, so a bounded pool cuts first-call latency ~5-8x.
    #
    # Materialized-only: a None partial means that day isn't in Redis yet. We never
    # trigger a synchronous Savant fetch from a user-facing endpoint — if the range
    # isn't materialized we return no deltas this tick and the next request gets them.
    # We compute for EVERY pitcher in the range (not just the requested subset) so
    # the cached result also serves future callers (other dates / game-views).
    try:
        from data import _get_default_end_date, _previous_date, _date_strings
        start_date = season_start(season_year)
        # Season deltas exclude the viewing date itself, so we never need today's
        # live data — cap the range at before_date - 1 (and skip reading later days).
        end_date = _previous_date(str(before_date)) if before_date is not None else _get_default_end_date()
        acc = {}  # (pitcher, pitch_name) -> [velo_sum, velo_n, ext_sum, ext_n]
        if end_date >= start_date:
            day_list = list(_date_strings(start_date, end_date))
            with ThreadPoolExecutor(max_workers=8) as pool:
                for partial in pool.map(lambda d: _season_velo_day_partial(d, before_date), day_list):
                    if partial is None:
                        return {}  # a day isn't materialized yet — retry next request
                    for key, (vs, vn, es, en) in partial.items():
                        slot = acc.get(key)
                        if slot is None:
                            slot = [0.0, 0, 0.0, 0]
                            acc[key] = slot
                        slot[0] += vs
                        slot[1] += vn
                        slot[2] += es
                        slot[3] += en
    except Exception:
        return {}
    full_result = {}  # str(pid) -> {pitch_name -> {velo, ext}}
    for (pid, pn), (velo_sum, velo_n, ext_sum, ext_n) in acc.items():
        entry = {}
        if velo_n:
            entry["velo"] = round(velo_sum / velo_n, 1)
        if ext_n:
            entry["ext"] = round(ext_sum / ext_n, 1)
        if entry:
            full_result.setdefault(str(int(pid)), {})[pn] = entry
    # 24h TTL — past-date data is immutable, today's drifts but slowly enough
    # that a 24h ceiling is fine (override_version busts it on reclassifications).
    _rset(cache_key, full_result, ttl=86400)
    return {int(p): full_result.get(str(p), {}) for p in pid_set if str(p) in full_result}


def aggregate_pitcher_results(date_str, game_pk=None, df=None, include_season_context=True, level=None):
    if df is None:
        df = fetch_date(date_str)
    if df.empty: return []
    df = _filter_level(df, level)
    if df.empty: return []
    if game_pk is not None:
        df = df[df["game_pk"] == game_pk]
        if df.empty: return []
    df = df.copy()
    df["is_whiff"] = df["description"].isin(_WHIFF_DESCS)
    df["is_called_strike"] = df["description"] == "called_strike"

    # Pre-compute home/away per game_pk
    game_teams = {}
    if "home_team" in df.columns:
        for gp_val, gdf_teams in df.groupby("game_pk"):
            game_teams[gp_val] = (gdf_teams["home_team"].iloc[0], gdf_teams["away_team"].iloc[0])

    results = []
    grouped = df.groupby(["pitcher", "player_name", "pitcher_team", "opponent", "p_throws", "game_pk"])
    for (pitcher_id, name, team, opp, hand, gp), gdf in grouped:
        total_pitches = len(gdf)
        whiffs = int(gdf["is_whiff"].sum())
        called_strikes = int(gdf["is_called_strike"].sum())
        strikes_total = int(gdf["type"].isin(_STRIKE_TYPES).sum()) if "type" in gdf.columns else 0
        appearance_order = int(gdf["at_bat_number"].min()) if "at_bat_number" in gdf.columns and gdf["at_bat_number"].notna().any() else 999
        innings_appeared = int(gdf["inning"].nunique()) if "inning" in gdf.columns and gdf["inning"].notna().any() else 0
        events_df = gdf.dropna(subset=["events"])
        events_df = events_df[events_df["events"] != ""]
        ev_col = events_df["events"] if not events_df.empty else pd.Series(dtype=str)
        hits = int(ev_col.isin(_HIT_EVENTS).sum())
        bbs = int(ev_col.isin(_BB_EVENTS).sum())
        ks = int(ev_col.isin(_K_EVENTS).sum())
        hrs = int(ev_col.isin(_HR_EVENTS).sum())
        outs = _compute_outs_vectorized(ev_col)
        fallback_ip = f"{outs // 3}.{outs % 3}"
        home_team, away_team = game_teams.get(gp, ("", ""))
        _, two_strike_pas, two_strike_pitches, strikeouts_for_par = _compute_two_strike_pa_stats(gdf)
        velo_pitch, velo, velo_ext = _compute_game_fastball_velo(gdf)
        row_level = gdf["level"].iloc[0] if "level" in gdf.columns and gdf["level"].notna().any() else None
        row = {
            "pitcher_id": int(pitcher_id), "game_pk": int(gp),
            "pitcher": name, "team": team, "hand": hand, "opponent": opp,
            "level": row_level,
            "team_display": team_display_name(abbrev=team, level=row_level),
            "org": org_for_team(abbrev=team, level=row_level),
            "opponent_org": org_for_team(abbrev=opp, level=row_level),
            "ip": fallback_ip, "hits": hits, "bbs": bbs, "ks": ks,
            "whiffs": whiffs,
            "csw_pct": round((called_strikes + whiffs) / total_pitches * 100, 2) if total_pitches > 0 else 0,
            "strike_pct": round(strikes_total / total_pitches * 100, 2) if total_pitches > 0 else 0,
            "par_pct": round(ks / two_strike_pas * 100, 2) if two_strike_pas > 0 else 0,
            "pitches": total_pitches, "hrs": hrs,
            "two_strike_pas": two_strike_pas,
            "two_strike_pitches": two_strike_pitches,
            "strikeouts_for_par": strikeouts_for_par,
            "appearance_order": appearance_order,
            "innings_appeared": innings_appeared,
            "home_team": home_team, "away_team": away_team,
            "velo": velo, "velo_pitch": velo_pitch, "velo_ext": velo_ext,
        }
        results.append(row)
    # Fetch boxscore stats (ER, IP, Hits, BB, K, HR) from MLB API — in parallel
    game_pks = list(set(r["game_pk"] for r in results))
    box_maps = _prefetch_boxscores_parallel(game_pks)
    for r in results:
        box = box_maps.get(r["game_pk"], {}).get(r["pitcher_id"])
        if box:
            r["er"] = box.get("er", 0)
            r["runs"] = box.get("runs", 0)
            if box.get("ip") is not None:
                r["ip"] = box["ip"]
            # Override pitch-by-pitch derived stats with official boxscore
            r["hits"] = box.get("hits", r["hits"])
            r["bbs"] = box.get("bbs", r["bbs"])
            r["ks"] = box.get("ks", r["ks"])
            r["hrs"] = box.get("hrs", r["hrs"])
            r["batters_faced"] = box.get("batters_faced", 0)
            r["decision"] = box.get("decision", "")
            r["decision_codes"] = box.get("decision_codes", [])
            r["par_pct"] = round(r["ks"] / r["two_strike_pas"] * 100, 2) if r.get("two_strike_pas", 0) > 0 else 0
        else:
            r["er"] = 0
            r["runs"] = 0
            r["batters_faced"] = 0
            r["decision"] = ""
            r["decision_codes"] = []
    # Add game state (scores, inning, status, current pitcher) to each row
    for r in results:
        gs = get_game_state(r["game_pk"])
        r["home_score"] = gs.get("home_score", 0)
        r["away_score"] = gs.get("away_score", 0)
        r["game_state"] = gs.get("game_state", "")
        r["current_pitcher_id"] = gs.get("current_pitcher_id")
    # Classify SP/RP role per game (opener detection may override)
    try:
        season_year = int(str(date_str)[:4])
    except (ValueError, TypeError):
        season_year = None
    results_by_game = {}
    for r in results:
        results_by_game.setdefault(r["game_pk"], []).append(r)
    role_season_year = season_year if include_season_context else None
    for game_rows in results_by_game.values():
        roles = classify_pitcher_roles(game_rows, season_year=role_season_year, before_date=date_str)
        for r in game_rows:
            r["role"] = roles.get(r["pitcher_id"], "RP")
    # Attach season-to-date fastball velo + ext + deltas for each pitcher (batched)
    season_velos = (
        _compute_season_fastball_velos([r["pitcher_id"] for r in results], season_year, before_date=date_str)
        if include_season_context
        else {}
    )
    for r in results:
        pick = r.get("velo_pitch")
        season_entry = season_velos.get(r["pitcher_id"], {}).get(pick) if pick else None
        season_velo = season_entry.get("velo") if season_entry else None
        season_ext = season_entry.get("ext") if season_entry else None
        r["velo_season"] = season_velo
        r["velo_ext_season"] = season_ext
        if r.get("velo") is not None and season_velo is not None:
            r["velo_delta"] = round(r["velo"] - season_velo, 1)
        else:
            r["velo_delta"] = None
        if r.get("velo_ext") is not None and season_ext is not None:
            r["velo_ext_delta"] = round(r["velo_ext"] - season_ext, 1)
        else:
            r["velo_ext_delta"] = None
    results.sort(key=lambda r: (r["team"], r["appearance_order"]))
    return results

def _resolve_arm_angle(pitch_df, pitcher_id, season):
    """Ensure pitch_df has an 'arm_angle' column. Mutates and returns pitch_df.

    Priority:
      1. Native Savant Hawk-Eye arm_angle (present on Savant-sourced rows) — use as-is.
         The minors CSV populates this on ~99.5% of AAA pitches.
      2. Release-point estimate — LAST RESORT only. This is ~7° off on average
         (>10° for ~28% of pitchers) because the true value needs the pose-tracked
         shoulder, which release coordinates can't recover. Used only for rows the
         minors CSV left untagged and for MLB-API/live-feed rows.
    """
    native = pitch_df["arm_angle"] if "arm_angle" in pitch_df.columns else None
    # Only short-circuit when EVERY row already has a native Hawk-Eye value.
    # A partially-tracked frame (some Savant rows + MLB-API/live rows with no
    # arm_angle) must still backfill the NaN rows from the leaderboard/estimate,
    # otherwise those pitches render a blank arm angle.
    if native is not None and native.notna().all():
        return pitch_df
    # Savant publishes no arm-angle leaderboard for the minors, so the
    # release-point estimate is the only backfill left for rows the minors CSV
    # didn't tag (~0.5% of AAA pitches; MLB-API/live rows carry none at all).
    if all(c in pitch_df.columns for c in ["release_pos_x", "release_pos_z"]):
        rx = pd.to_numeric(pitch_df["release_pos_x"], errors="coerce").abs()
        rz = pd.to_numeric(pitch_df["release_pos_z"], errors="coerce")
        fill = np.round(4.45 * rx + 23.64 * rz - 106.0, 1)
    else:
        return pitch_df
    if native is not None:
        # Keep native values where present; fill only the gaps.
        pitch_df["arm_angle"] = native.where(native.notna(), fill)
    else:
        pitch_df["arm_angle"] = fill
    return pitch_df


def _pdf_pitcher_season(pdf):
    """Best-effort (pitcher_id, season) for a single-pitcher DataFrame, used to
    look up Savant's arm angle. Returns (None, None) if unavailable."""
    pid = None
    if "pitcher" in pdf.columns:
        pids = pdf["pitcher"].dropna()
        if not pids.empty:
            try:
                pid = int(pids.iloc[0])
            except (ValueError, TypeError):
                pid = None
    season = None
    if "game_date" in pdf.columns:
        yrs = pd.to_datetime(pdf["game_date"], errors="coerce").dt.year.dropna()
        if not yrs.empty:
            season = int(yrs.max())
    return pid, season


def _runs_scored_series(pitch_df):
    """Per-pitch runs scored on the play — computed once here so every tooltip
    reads one authoritative `runs_scored` value instead of re-parsing `des` on
    the client (which used three different methods that could disagree).

    Only the terminal pitch of a PA carries `events`/`des`; runs are the count
    of '<runner> scores' clauses in the play description plus the batter on a
    home run. Counting on the terminal pitch's `des` naturally excludes mid-AB
    action runs (wild pitch/balk), which live on their own earlier pitch rows."""
    n = len(pitch_df)
    has_des = "des" in pitch_df.columns
    has_ev = "events" in pitch_df.columns
    if not has_des and not has_ev:
        return pd.Series(0, index=pitch_df.index, dtype=int)
    if has_des:
        runs = pitch_df["des"].fillna("").astype(str).str.lower().str.count(r"\bscores\b")
    else:
        runs = pd.Series(0, index=pitch_df.index)
    if has_ev:
        ev = pitch_df["events"].fillna("").astype(str).str.lower()
        runs = runs + (ev == "home_run").astype(int)
    return runs.fillna(0).astype(int)


def build_pitches_list(pdf):
    """Build JSON-safe list of pitch dicts from a pitcher DataFrame.
    Converts pfx to inches and sanitizes NaN→None."""
    _pitch_cols = ["pitch_type", "pitch_name", "plate_x", "plate_z", "sz_top", "sz_bot", "pfx_x", "pfx_z",
                   "release_speed", "stand", "description", "type", "zone", "at_bat_number",
                   "pitch_number", "outs_when_up", "batter_name", "events", "des",
                   "launch_speed", "launch_angle", "hc_x", "hc_y", "release_extension",
                   "inning", "inning_topbot", "balls", "strikes", "on_1b", "on_2b", "on_3b",
                   "game_pk", "game_date",
                   "release_pos_x", "release_pos_z", "vx0", "vy0", "vz0", "ax", "ay", "az",
                   "arm_angle"]
    available_cols = [c for c in _pitch_cols if c in pdf.columns]
    pitch_df = pdf[available_cols].copy()
    if "pfx_x" in pitch_df.columns:
        pitch_df["pfx_x"] = pitch_df["pfx_x"] * 12
    if "pfx_z" in pitch_df.columns:
        pitch_df["pfx_z"] = pitch_df["pfx_z"] * 12
    if all(c in pitch_df.columns for c in _HAVAA_COLS):
        pitch_df["havaa"] = _havaa_series(pitch_df)
    # Arm angle: native Hawk-Eye → Savant leaderboard → release-point estimate
    _aa_pid, _aa_season = _pdf_pitcher_season(pdf)
    _resolve_arm_angle(pitch_df, _aa_pid, _aa_season)
    # Authoritative per-pitch runs scored (single source of truth for tooltips)
    pitch_df["runs_scored"] = _runs_scored_series(pitch_df)
    pitches_raw = pitch_df.to_dict(orient="records")
    pitches = []
    _int_fields = {"zone", "at_bat_number", "pitch_number", "outs_when_up", "inning", "balls", "strikes", "game_pk", "runs_scored"}
    _float_fields = {"plate_x", "plate_z", "sz_top", "sz_bot", "pfx_x", "pfx_z", "release_speed", "launch_speed", "launch_angle", "hc_x", "hc_y", "release_extension", "release_pos_x", "release_pos_z", "havaa", "arm_angle"}
    _bool_fields = {"on_1b", "on_2b", "on_3b"}
    _str_defaults = {"pitch_name": "Unclassified", "description": "", "type": "", "events": "", "des": "", "batter_name": "", "stand": "", "pitch_type": "", "game_date": ""}
    for row in pitches_raw:
        for k in list(row.keys()):
            v = row[k]
            if v is None:
                continue
            try:
                if isinstance(v, float) and np.isnan(v):
                    row[k] = None
            except (TypeError, ValueError):
                pass
        for f, default in _str_defaults.items():
            if row.get(f) is None:
                row[f] = default
        for f in _int_fields:
            v = row.get(f)
            if v is not None:
                row[f] = int(v)
        for f in _float_fields:
            v = row.get(f)
            if v is not None:
                row[f] = float(v)
        for f in _bool_fields:
            row[f] = bool(row.get(f) or False)
        # Ensure game_date is a string
        if "game_date" in row and row["game_date"]:
            row["game_date"] = str(row["game_date"])[:10]
        pitches.append(row)
    return pitches


def get_pitcher_card(date_str, pitcher_id, game_pk):
    df = fetch_game_pitches(date_str, game_pk)
    if df.empty:
        df = fetch_date(date_str)
    if df.empty: return {}
    pdf = df[(df["pitcher"] == pitcher_id) & (df["game_pk"] == game_pk)]
    if pdf.empty: return {}
    name = pdf["player_name"].iloc[0]
    team = pdf["pitcher_team"].iloc[0]
    hand = pdf["p_throws"].iloc[0]
    opp = pdf["opponent"].iloc[0]
    pdf_prepped = _prep_df(pdf)

    # Shared builder (same as the player page): column selection, pfx->inches,
    # HAVAA, arm angle, runs_scored, NaN sanitation. Card pitches additionally
    # carry game_pk/game_date now, which the frontend ignores (schema v40).
    pitches = build_pitches_list(pdf)
    sz_top = pdf["sz_top"].mean() if "sz_top" in pdf.columns and pdf["sz_top"].notna().any() else 3.5
    sz_bot = pdf["sz_bot"].mean() if "sz_bot" in pdf.columns and pdf["sz_bot"].notna().any() else 1.5

    # Aggregate pitch tables: all, vs L, vs R
    pitch_table = _aggregate_pitch_df(pdf_prepped, pdf_prepped)
    pitch_table = [r for r in pitch_table if r["pitcher_id"] == pitcher_id]

    pdf_vs_l = pdf_prepped[pdf_prepped["stand"] == "L"]
    pitch_table_vs_l = _aggregate_pitch_df(pdf_vs_l, pdf_prepped) if not pdf_vs_l.empty else []
    pitch_table_vs_l = [r for r in pitch_table_vs_l if r["pitcher_id"] == pitcher_id]

    pdf_vs_r = pdf_prepped[pdf_prepped["stand"] == "R"]
    pitch_table_vs_r = _aggregate_pitch_df(pdf_vs_r, pdf_prepped) if not pdf_vs_r.empty else []
    pitch_table_vs_r = [r for r in pitch_table_vs_r if r["pitcher_id"] == pitcher_id]

    # Compute pitcher result inline (avoids re-fetching date data)
    pdf_r = pdf.copy()
    pdf_r["is_whiff"] = pdf_r["description"].isin(_WHIFF_DESCS)
    pdf_r["is_called_strike"] = pdf_r["description"] == "called_strike"
    total_pitches = len(pdf_r)
    whiffs_r = int(pdf_r["is_whiff"].sum())
    called_strikes_r = int(pdf_r["is_called_strike"].sum())
    events_df_r = pdf_r.dropna(subset=["events"])
    events_df_r = events_df_r[events_df_r["events"] != ""]
    ev_col_r = events_df_r["events"] if not events_df_r.empty else pd.Series(dtype=str)
    hits_r = int(ev_col_r.isin(_HIT_EVENTS).sum())
    bbs_r = int(ev_col_r.isin(_BB_EVENTS).sum())
    ks_r = int(ev_col_r.isin(_K_EVENTS).sum())
    hrs_r = int(ev_col_r.isin(_HR_EVENTS).sum())
    outs_r = _compute_outs_vectorized(ev_col_r)
    ip_str_r = f"{outs_r // 3}.{outs_r % 3}"
    appearance_order_r = int(pdf_r["at_bat_number"].min()) if "at_bat_number" in pdf_r.columns and pdf_r["at_bat_number"].notna().any() else 999
    home_team_r = pdf_r["home_team"].iloc[0] if "home_team" in pdf_r.columns else ""
    away_team_r = pdf_r["away_team"].iloc[0] if "away_team" in pdf_r.columns else ""
    swings_r = int(pdf_r["description"].isin(_SWING_DESCS).sum())
    strikes_r = int(pdf_r["type"].isin(_STRIKE_TYPES).sum()) if "type" in pdf_r.columns else 0
    pa_count_r, two_strike_pas_r, two_strike_pitches_r, strikeouts_r = _compute_two_strike_pa_stats(pdf_r)
    pitcher_result = {
        "pitcher_id": int(pitcher_id), "game_pk": int(game_pk),
        "pitcher": name, "team": team, "hand": hand, "opponent": opp,
        "ip": ip_str_r, "hits": hits_r, "bbs": bbs_r, "ks": ks_r,
        "whiffs": whiffs_r,
        "swstr_pct": round(whiffs_r / total_pitches * 100, 2) if total_pitches > 0 else 0,
        "csw_pct": round((called_strikes_r + whiffs_r) / total_pitches * 100, 2) if total_pitches > 0 else 0,
        "strike_pct": round(strikes_r / total_pitches * 100, 2) if total_pitches > 0 else 0,
        # 2Str%: batters faced who reached a two-strike count / total BF
        "two_str_pct": round(two_strike_pas_r / pa_count_r * 100, 2) if pa_count_r > 0 else 0,
        # PAR%: strikeouts / batters faced who reached a two-strike count.
        "par_pct": round(ks_r / two_strike_pas_r * 100, 2) if two_strike_pas_r > 0 else 0,
        "pitches": total_pitches, "hrs": hrs_r,
        "strikes": strikes_r,
        "pa_count": pa_count_r,
        "two_strike_pas": two_strike_pas_r,
        "two_strike_pitches": two_strike_pitches_r,
        "strikeouts_for_par": strikeouts_r,
        "appearance_order": appearance_order_r,
        "home_team": home_team_r, "away_team": away_team_r,
    }
    # Fetch boxscore for official stats
    box = get_boxscore_full(game_pk)
    pbox = box.get(int(pitcher_id)) if box else None
    if pbox:
        pitcher_result["er"] = pbox.get("er", 0)
        pitcher_result["runs"] = pbox.get("runs", 0)
        if pbox.get("ip") is not None:
            pitcher_result["ip"] = pbox["ip"]
        pitcher_result["hits"] = pbox.get("hits", hits_r)
        pitcher_result["bbs"] = pbox.get("bbs", bbs_r)
        pitcher_result["ks"] = pbox.get("ks", ks_r)
        pitcher_result["hrs"] = pbox.get("hrs", hrs_r)
        pitcher_result["batters_faced"] = pbox.get("batters_faced", 0)
        pitcher_result["games_started"] = pbox.get("games_started", 0)
        pitcher_result["decision"] = pbox.get("decision", "")
    else:
        pitcher_result["er"] = 0
        pitcher_result["runs"] = 0
        pitcher_result["batters_faced"] = 0
        pitcher_result["games_started"] = 0
        pitcher_result["decision"] = ""
    pitcher_result["par_pct"] = (
        round((pitcher_result.get("ks", 0) or 0) / two_strike_pas_r * 100, 2)
        if two_strike_pas_r > 0 else 0
    )
    card_level = pdf["level"].iloc[0] if "level" in pdf.columns and pdf["level"].notna().any() else None
    return {
        "pitcher_id": pitcher_id, "game_pk": game_pk,
        "name": name, "team": team, "hand": hand, "opponent": opp,
        "level": card_level,
        "team_display": team_display_name(abbrev=team, level=card_level),
        "opponent_display": team_display_name(abbrev=opp, level=card_level),
        "org": org_for_team(abbrev=team, level=card_level),
        "pitches": pitches, "sz_top": float(sz_top), "sz_bot": float(sz_bot),
        "pitch_table": pitch_table,
        "pitch_table_vs_l": pitch_table_vs_l,
        "pitch_table_vs_r": pitch_table_vs_r,
        "result": pitcher_result,
        "card_type": "statcast",
    }

def get_season_averages(pitcher_id, season_year, before_date=None, exclude_game_pk=None):
    """Compute season averages per pitch type for a pitcher.

    Optional filters:
    - before_date: Only include games strictly before this date (YYYY-MM-DD).
      Used for "season-to-date" comparisons excluding the current game's date.
    - exclude_game_pk: Exclude this specific game_pk from the aggregation.
      Useful when before_date alone could include doubleheaders or same-day starts.
    """
    # Per-pitcher Savant covers this data shape (used as the fallback elsewhere
    # and as the primary source for the card path in _build_pitcher_card_payload).
    # Going Savant-first means a single card view / /api/season-averages call
    # never loads the whole league's materialized range just to slice out one
    # pitcher's rows — the same principle as the per-pitcher card path. If
    # Savant has no data for this pitcher we degrade to empty averages rather
    # than triggering the league load.
    df = fetch_pitcher_season(pitcher_id, season_year)
    if df is None or df.empty:
        return {}
    from data import PITCH_TYPE_MAP
    df = df.copy()
    if "pitch_type" in df.columns:
        df["pitch_name"] = df["pitch_type"].map(PITCH_TYPE_MAP)
        df = df.dropna(subset=["pitch_name"])
    if df.empty:
        return {}
    # Filter by date (for season-to-date comparisons)
    if before_date and "game_date" in df.columns:
        df = df[df["game_date"].astype(str) < str(before_date)]
        if df.empty:
            return {}
    if exclude_game_pk is not None and "game_pk" in df.columns:
        try:
            df = df[df["game_pk"] != int(exclude_game_pk)]
        except (ValueError, TypeError):
            pass
        if df.empty:
            return {}
    total_pitches = len(df)
    # Totals by batter hand (for usage_vs_r / usage_vs_l)
    has_stand = "stand" in df.columns
    total_vs_r = int((df["stand"] == "R").sum()) if has_stand else 0
    total_vs_l = int((df["stand"] == "L").sum()) if has_stand else 0
    result = {}
    for pitch_name, gdf in df.groupby("pitch_name"):
        count = len(gdf)
        vs_r_count = int((gdf["stand"] == "R").sum()) if has_stand else 0
        vs_l_count = int((gdf["stand"] == "L").sum()) if has_stand else 0
        avg = {
            "velo": round(gdf["release_speed"].mean(), 1) if "release_speed" in gdf.columns and gdf["release_speed"].notna().any() else None,
            "ihb": round(gdf["pfx_x"].mean() * 12, 1) if "pfx_x" in gdf.columns and gdf["pfx_x"].notna().any() else None,
            "havaa": round(gdf["havaa"].mean(), 1) if "havaa" in gdf.columns and gdf["havaa"].notna().any() else None,
            "ivb": round(gdf["pfx_z"].mean() * 12, 1) if "pfx_z" in gdf.columns and gdf["pfx_z"].notna().any() else None,
            "ext": round(gdf["release_extension"].mean(), 1) if "release_extension" in gdf.columns and gdf["release_extension"].notna().any() else None,
            "usage": round(count / total_pitches * 100, 1) if total_pitches > 0 else 0,
            "usage_vs_r": round(vs_r_count / total_vs_r * 100, 1) if total_vs_r > 0 else None,
            "usage_vs_l": round(vs_l_count / total_vs_l * 100, 1) if total_vs_l > 0 else None,
        }
        result[pitch_name] = avg
    return result


def find_previous_mlb_season(pitcher_id, current_year, max_lookback=5):
    """Return the most recent year (< current_year) with pitch data for this pitcher.
    Returns None if no prior season has data within lookback."""
    for years_back in range(1, max_lookback + 1):
        year = current_year - years_back
        df = fetch_pitcher_season(pitcher_id, year)
        if df is not None and not df.empty:
            return year
    return None


def _prefetch_boxscores_parallel(game_pks):
    """Pre-fetch all boxscores in parallel. Returns dict { gpk: stats_map }."""
    box_maps = {}
    # Check which are already cached
    uncached = []
    for gpk in game_pks:
        existing = get_boxscore_full(gpk)  # returns from cache if available
        if existing is not None:
            box_maps[gpk] = existing
        else:
            uncached.append(gpk)
    if not uncached:
        return box_maps

    def _fetch_one(gpk):
        return gpk, get_boxscore_full(gpk)

    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(_fetch_one, gpk): gpk for gpk in uncached}
        for future in as_completed(futures):
            try:
                gpk, stats = future.result()
                box_maps[gpk] = stats
            except Exception:
                box_maps[futures[future]] = {}
    return box_maps


def aggregate_pitcher_results_range(df):
    """Aggregate pitcher results across multiple games (no game_pk grouping)."""
    if df.empty:
        return []
    df = df.copy()
    df["is_whiff"] = df["description"].isin(_WHIFF_DESCS)
    df["is_called_strike"] = df["description"] == "called_strike"

    # Pre-fetch ALL boxscores in parallel before iterating pitchers
    all_game_pks = [int(gpk) for gpk in df["game_pk"].unique()]
    box_maps = _prefetch_boxscores_parallel(all_game_pks)

    # Pre-compute per-team min appearance_order per game — used to classify
    # each pitcher as SP/RP per game, then aggregate across the range.
    per_game_min_order = {}
    if "at_bat_number" in df.columns and "pitcher_team" in df.columns and "game_pk" in df.columns:
        ao = df.groupby(["game_pk", "pitcher_team", "pitcher"])["at_bat_number"].min()
        team_min = ao.groupby(level=[0, 1]).min()
        per_game_min_order = team_min.to_dict()

    results = []
    grouped = df.groupby(["pitcher", "player_name", "p_throws"])
    for (pitcher_id, name, hand), gdf in grouped:
        total_pitches = len(gdf)
        whiffs = int(gdf["is_whiff"].sum())
        called_strikes = int(gdf["is_called_strike"].sum())
        teams = list(gdf["pitcher_team"].unique()) if "pitcher_team" in gdf.columns else []
        team = teams[0] if len(teams) == 1 else "/".join(sorted(teams))
        games_played = int(gdf["game_pk"].nunique()) if "game_pk" in gdf.columns else 0

        events_df = gdf.dropna(subset=["events"])
        events_df = events_df[events_df["events"] != ""]
        ev_col = events_df["events"] if not events_df.empty else pd.Series(dtype=str)
        hits = int(ev_col.isin(_HIT_EVENTS).sum())
        bbs = int(ev_col.isin(_BB_EVENTS).sum())
        ks = int(ev_col.isin(_K_EVENTS).sum())
        hrs = int(ev_col.isin(_HR_EVENTS).sum())
        outs = _compute_outs_vectorized(ev_col)
        ip_str = f"{outs // 3}.{outs % 3}"

        # Use pre-fetched boxscore data (already in memory, no HTTP calls)
        total_er = 0
        total_ip_thirds = 0
        use_boxscore_ip = False
        game_pks = gdf["game_pk"].unique()
        for gpk in game_pks:
            box = box_maps.get(int(gpk), {})
            pbox = box.get(int(pitcher_id))
            if pbox:
                total_er += pbox.get("er", 0)
                if pbox.get("ip") is not None:
                    total_ip_thirds += _ip_to_outs(pbox["ip"])
                    use_boxscore_ip = True
        if use_boxscore_ip:
            ip_str = f"{total_ip_thirds // 3}.{total_ip_thirds % 3}"

        # Role across the range: SP if this pitcher was the first pitcher on
        # their team in a majority of their games; otherwise RP.
        sp_games = 0
        rp_games = 0
        if "at_bat_number" in gdf.columns:
            for (gpk, pteam), pgdf in gdf.groupby(["game_pk", "pitcher_team"]):
                my_min = int(pgdf["at_bat_number"].min())
                team_min = per_game_min_order.get((gpk, pteam))
                if team_min is not None and my_min == int(team_min):
                    sp_games += 1
                else:
                    rp_games += 1
        role = "SP" if sp_games > rp_games else "RP"

        row = {
            "pitcher_id": int(pitcher_id),
            "pitcher": name,
            "team": team,
            "hand": hand,
            "games": games_played,
            "ip": ip_str,
            "hits": hits,
            "bbs": bbs,
            "ks": ks,
            "hrs": hrs,
            "er": int(total_er),
            "whiffs": whiffs,
            "csw_pct": round((called_strikes + whiffs) / total_pitches * 100, 2) if total_pitches > 0 else 0,
            "pitches": total_pitches,
            "role": role,
        }
        results.append(row)
    results.sort(key=lambda r: r["pitches"], reverse=True)
    return results


def aggregate_pitch_data_range(df, prepped=False):
    """Aggregate pitch data across multiple games (no game_pk grouping).
    Groups by pitcher + pitch type for season-level per-pitch-type stats.
    If prepped=True, skip _prep_df (caller already added boolean columns)."""
    if df.empty:
        return []
    if not prepped:
        df = _prep_df(df)

    # Pre-compute pitcher totals as a dict for O(1) lookup
    pitcher_totals = df.groupby("pitcher").size().to_dict()

    # Pre-compute pitcher totals by batter hand for usage_vs_r / usage_vs_l
    has_stand = "stand" in df.columns
    pitcher_vs_r_totals = {}
    pitcher_vs_l_totals = {}
    if has_stand:
        for pid, sdf in df.groupby("pitcher"):
            pitcher_vs_r_totals[pid] = int((sdf["stand"] == "R").sum())
            pitcher_vs_l_totals[pid] = int((sdf["stand"] == "L").sum())

    results = []
    has_strikes = "strikes" in df.columns
    has_events = "events" in df.columns
    grouped = df.groupby(["pitcher", "player_name", "p_throws", "pitch_name", "pitch_type"])
    for (pitcher_id, name, hand, pitch_name, pitch_type), gdf in grouped:
        total = len(gdf)
        teams = list(gdf["pitcher_team"].unique()) if "pitcher_team" in gdf.columns else []
        team = teams[0] if len(teams) == 1 else "/".join(sorted(teams))
        pitcher_total = pitcher_totals.get(pitcher_id, 0)

        in_zone = int(gdf["in_zone"].sum())
        out_zone = total - in_zone
        whiffs = int(gdf["is_whiff"].sum())
        called_strikes = int(gdf["is_called_strike"].sum())
        strikes = int(gdf["is_strike"].sum())
        o_swings = int(gdf.loc[~gdf["in_zone"], "is_swing"].sum()) if out_zone > 0 else 0

        # Per-type 2-strike counters (same bucket math as UsageTable): pitches
        # of this type thrown with 2 strikes, and Ks recorded on those pitches.
        two_str_pitches = 0
        two_str_ks = 0
        if has_strikes:
            two_str_mask = gdf["strikes"] >= 2
            two_str_pitches = int(two_str_mask.sum())
            if has_events and two_str_pitches > 0:
                two_str_ks = int(
                    gdf.loc[two_str_mask, "events"].dropna().astype(str).str.lower().isin(_K_EVENTS).sum()
                )

        # Usage split by batter hand
        vs_r_count = int((gdf["stand"] == "R").sum()) if has_stand else 0
        vs_l_count = int((gdf["stand"] == "L").sum()) if has_stand else 0
        pitcher_vs_r_total = pitcher_vs_r_totals.get(pitcher_id, 0)
        pitcher_vs_l_total = pitcher_vs_l_totals.get(pitcher_id, 0)

        row = {
            "pitcher_id": int(pitcher_id),
            "pitcher": name,
            "team": team,
            "hand": hand,
            "pitch_type": pitch_type,
            "pitch_name": pitch_name,
            "count": total,
            "velo": round(gdf["release_speed"].mean(), 1) if gdf["release_speed"].notna().any() else None,
            "usage": round(total / pitcher_total * 100, 1) if pitcher_total > 0 else 0,
            "usage_vs_r": round(vs_r_count / pitcher_vs_r_total * 100, 1) if pitcher_vs_r_total > 0 else 0,
            "usage_vs_l": round(vs_l_count / pitcher_vs_l_total * 100, 1) if pitcher_vs_l_total > 0 else 0,
            "count_vs_r": vs_r_count, "count_vs_l": vs_l_count,
            "ext": round(gdf["release_extension"].mean(), 1) if gdf["release_extension"].notna().any() else None,
            "ivb": round(gdf["pfx_z"].mean() * 12, 1) if gdf["pfx_z"].notna().any() else None,
            "ihb": round(gdf["pfx_x"].mean() * 12, 1) if gdf["pfx_x"].notna().any() else None,
            "havaa": round(gdf["havaa"].mean(), 1) if "havaa" in gdf.columns and gdf["havaa"].notna().any() else None,
            "whiffs": whiffs,
            "zone_pct": round(in_zone / total * 100, 1) if total > 0 else 0,
            "o_swing_pct": round(o_swings / out_zone * 100, 1) if out_zone > 0 else 0,
            # See _aggregate_pitch_df: send unrounded so frontend rounds once.
            "strike_pct": (strikes / total * 100) if total > 0 else 0,
            "cs_pct": (called_strikes / total * 100) if total > 0 else 0,
            "swstr_pct": (whiffs / total * 100) if total > 0 else 0,
            "csw_pct": ((called_strikes + whiffs) / total * 100) if total > 0 else 0,
            # Raw counters (not rates) so the frontend can re-aggregate
            # shift-selected game subsets in the game log.
            "two_str_pitches": two_str_pitches,
            "two_str_ks": two_str_ks,
        }
        results.append(row)
    results.sort(key=lambda r: (r["pitcher"], r["pitch_name"]))
    return results


# ── Streaming range aggregation ────────────────────────────────────────────
#
# The functions above take ONE frame holding the whole range. For a season
# that frame is ~612k pitch rows (order of 1.3 GB, with a transient 2x while
# pd.concat builds it) against a 3009 MB function limit.
#
# These accumulate the same numbers a day at a time instead, so only one day is
# resident. They work because every quantity involved is either a sum, a count,
# or a set union — nothing needs to see the whole range at once. The two things
# that would NOT survive being split are handled explicitly:
#
#   * Rates (usage, csw_pct, zone_pct, ...) are derived in the finalize step
#     from merged totals. Averaging per-day percentages would be wrong.
#   * Means (velo, ivb, ihb, ext, havaa) carry a (sum, count) pair rather than
#     a mean, counting only non-NaN values so they match pandas' .mean().
#
# Grouping by game (games played, SP/RP role, boxscore ER/IP) is safe per day
# because a game_pk belongs to exactly one game_date.


def _mean_or_none(pair, scale=1.0, digits=1):
    total, count = pair
    if not count:
        return None
    return round(total / count * scale, digits)


def _sum_pair(series):
    """(sum, non-NaN count) — the additive form of a mean."""
    return (float(series.sum()), int(series.count())) if series is not None else (0.0, 0)


def _add_pair(acc, key, pair):
    prev = acc[key]
    acc[key] = (prev[0] + pair[0], prev[1] + pair[1])


def new_results_accumulator():
    return {}


def accumulate_pitcher_results(acc, day_df):
    """Fold one day into a pitcher-results accumulator."""
    if day_df is None or day_df.empty:
        return
    df = day_df.copy()
    df["is_whiff"] = df["description"].isin(_WHIFF_DESCS)
    df["is_called_strike"] = df["description"] == "called_strike"

    box_maps = _prefetch_boxscores_parallel([int(g) for g in df["game_pk"].unique()])

    per_game_min_order = {}
    if all(c in df.columns for c in ("at_bat_number", "pitcher_team", "game_pk")):
        ao = df.groupby(["game_pk", "pitcher_team", "pitcher"])["at_bat_number"].min()
        per_game_min_order = ao.groupby(level=[0, 1]).min().to_dict()

    for (pitcher_id, name, hand), gdf in df.groupby(["pitcher", "player_name", "p_throws"]):
        e = acc.setdefault((pitcher_id, name, hand), {
            "pitches": 0, "whiffs": 0, "called_strikes": 0,
            "teams": set(), "game_pks": set(),
            "hits": 0, "bbs": 0, "ks": 0, "hrs": 0, "outs": 0,
            "er": 0, "ip_thirds": 0, "use_box_ip": False,
            "sp_games": 0, "rp_games": 0,
        })
        e["pitches"] += len(gdf)
        e["whiffs"] += int(gdf["is_whiff"].sum())
        e["called_strikes"] += int(gdf["is_called_strike"].sum())
        if "pitcher_team" in gdf.columns:
            e["teams"].update(gdf["pitcher_team"].dropna().unique())
        if "game_pk" in gdf.columns:
            e["game_pks"].update(int(g) for g in gdf["game_pk"].unique())

        events_df = gdf.dropna(subset=["events"])
        events_df = events_df[events_df["events"] != ""]
        ev_col = events_df["events"] if not events_df.empty else pd.Series(dtype=str)
        e["hits"] += int(ev_col.isin(_HIT_EVENTS).sum())
        e["bbs"] += int(ev_col.isin(_BB_EVENTS).sum())
        e["ks"] += int(ev_col.isin(_K_EVENTS).sum())
        e["hrs"] += int(ev_col.isin(_HR_EVENTS).sum())
        e["outs"] += _compute_outs_vectorized(ev_col)

        for gpk in gdf["game_pk"].unique():
            pbox = box_maps.get(int(gpk), {}).get(int(pitcher_id))
            if pbox:
                e["er"] += pbox.get("er", 0)
                if pbox.get("ip") is not None:
                    e["ip_thirds"] += _ip_to_outs(pbox["ip"])
                    e["use_box_ip"] = True

        if "at_bat_number" in gdf.columns:
            for (gpk, pteam), pgdf in gdf.groupby(["game_pk", "pitcher_team"]):
                team_min = per_game_min_order.get((gpk, pteam))
                if team_min is not None and int(pgdf["at_bat_number"].min()) == int(team_min):
                    e["sp_games"] += 1
                else:
                    e["rp_games"] += 1


def finalize_pitcher_results(acc):
    """Turn a merged accumulator into the same rows aggregate_pitcher_results_range returns."""
    results = []
    for (pitcher_id, name, hand), e in acc.items():
        pitches = e["pitches"]
        outs = e["ip_thirds"] if e["use_box_ip"] else e["outs"]
        teams = sorted(e["teams"])
        results.append({
            "pitcher_id": int(pitcher_id),
            "pitcher": name,
            "team": teams[0] if len(teams) == 1 else "/".join(teams),
            "hand": hand,
            "games": len(e["game_pks"]),
            "ip": f"{outs // 3}.{outs % 3}",
            "hits": e["hits"], "bbs": e["bbs"], "ks": e["ks"], "hrs": e["hrs"],
            "er": int(e["er"]),
            "whiffs": e["whiffs"],
            "csw_pct": round((e["called_strikes"] + e["whiffs"]) / pitches * 100, 2) if pitches else 0,
            "pitches": pitches,
            "role": "SP" if e["sp_games"] > e["rp_games"] else "RP",
        })
    results.sort(key=lambda r: r["pitches"], reverse=True)
    return results


def new_pitch_data_accumulator():
    return {"groups": {}, "pitcher_totals": {}, "vs_r": {}, "vs_l": {}}


def accumulate_pitch_data(acc, day_df, prepped=False):
    """Fold one day into a pitch-data accumulator."""
    if day_df is None or day_df.empty:
        return
    df = day_df if prepped else _prep_df(day_df)
    if df.empty:
        return

    has_stand = "stand" in df.columns
    has_strikes = "strikes" in df.columns
    has_events = "events" in df.columns

    for pid, sdf in df.groupby("pitcher"):
        acc["pitcher_totals"][pid] = acc["pitcher_totals"].get(pid, 0) + len(sdf)
        if has_stand:
            acc["vs_r"][pid] = acc["vs_r"].get(pid, 0) + int((sdf["stand"] == "R").sum())
            acc["vs_l"][pid] = acc["vs_l"].get(pid, 0) + int((sdf["stand"] == "L").sum())

    grouped = df.groupby(["pitcher", "player_name", "p_throws", "pitch_name", "pitch_type"])
    for key, gdf in grouped:
        e = acc["groups"].setdefault(key, {
            "count": 0, "in_zone": 0, "out_zone": 0, "whiffs": 0,
            "called_strikes": 0, "strikes": 0, "o_swings": 0,
            "two_str_pitches": 0, "two_str_ks": 0,
            "vs_r": 0, "vs_l": 0, "teams": set(),
            "velo": (0.0, 0), "ext": (0.0, 0), "ivb": (0.0, 0),
            "ihb": (0.0, 0), "havaa": (0.0, 0),
        })
        total = len(gdf)
        in_zone = int(gdf["in_zone"].sum())
        e["count"] += total
        e["in_zone"] += in_zone
        e["out_zone"] += total - in_zone
        e["whiffs"] += int(gdf["is_whiff"].sum())
        e["called_strikes"] += int(gdf["is_called_strike"].sum())
        e["strikes"] += int(gdf["is_strike"].sum())
        if total - in_zone > 0:
            e["o_swings"] += int(gdf.loc[~gdf["in_zone"], "is_swing"].sum())
        if "pitcher_team" in gdf.columns:
            e["teams"].update(gdf["pitcher_team"].dropna().unique())

        if has_strikes:
            two_str_mask = gdf["strikes"] >= 2
            n_two_str = int(two_str_mask.sum())
            e["two_str_pitches"] += n_two_str
            if has_events and n_two_str:
                e["two_str_ks"] += int(
                    gdf.loc[two_str_mask, "events"].dropna().astype(str).str.lower().isin(_K_EVENTS).sum()
                )
        if has_stand:
            e["vs_r"] += int((gdf["stand"] == "R").sum())
            e["vs_l"] += int((gdf["stand"] == "L").sum())

        _add_pair(e, "velo", _sum_pair(gdf["release_speed"]))
        _add_pair(e, "ext", _sum_pair(gdf["release_extension"]))
        _add_pair(e, "ivb", _sum_pair(gdf["pfx_z"]))
        _add_pair(e, "ihb", _sum_pair(gdf["pfx_x"]))
        if "havaa" in gdf.columns:
            _add_pair(e, "havaa", _sum_pair(gdf["havaa"]))


def finalize_pitch_data(acc):
    """Turn a merged accumulator into the same rows aggregate_pitch_data_range returns."""
    results = []
    for (pitcher_id, name, hand, pitch_name, pitch_type), e in acc["groups"].items():
        total = e["count"]
        pitcher_total = acc["pitcher_totals"].get(pitcher_id, 0)
        vs_r_total = acc["vs_r"].get(pitcher_id, 0)
        vs_l_total = acc["vs_l"].get(pitcher_id, 0)
        teams = sorted(e["teams"])
        results.append({
            "pitcher_id": int(pitcher_id),
            "pitcher": name,
            "team": teams[0] if len(teams) == 1 else "/".join(teams),
            "hand": hand,
            "pitch_type": pitch_type,
            "pitch_name": pitch_name,
            "count": total,
            "velo": _mean_or_none(e["velo"]),
            "usage": round(total / pitcher_total * 100, 1) if pitcher_total else 0,
            "usage_vs_r": round(e["vs_r"] / vs_r_total * 100, 1) if vs_r_total else 0,
            "usage_vs_l": round(e["vs_l"] / vs_l_total * 100, 1) if vs_l_total else 0,
            "count_vs_r": e["vs_r"], "count_vs_l": e["vs_l"],
            "ext": _mean_or_none(e["ext"]),
            "ivb": _mean_or_none(e["ivb"], scale=12),
            "ihb": _mean_or_none(e["ihb"], scale=12),
            "havaa": _mean_or_none(e["havaa"]),
            "whiffs": e["whiffs"],
            "zone_pct": round(e["in_zone"] / total * 100, 1) if total else 0,
            "o_swing_pct": round(e["o_swings"] / e["out_zone"] * 100, 1) if e["out_zone"] else 0,
            # Unrounded, same as aggregate_pitch_data_range — frontend rounds once.
            "strike_pct": (e["strikes"] / total * 100) if total else 0,
            "cs_pct": (e["called_strikes"] / total * 100) if total else 0,
            "swstr_pct": (e["whiffs"] / total * 100) if total else 0,
            "csw_pct": ((e["called_strikes"] + e["whiffs"]) / total * 100) if total else 0,
            "two_str_pitches": e["two_str_pitches"],
            "two_str_ks": e["two_str_ks"],
        })
    results.sort(key=lambda r: (r["pitcher"], r["pitch_name"]))
    return results


def get_pitcher_game_log(df, pitcher_id):
    """Get per-game stats for a single pitcher from a date-range DataFrame."""
    if df.empty:
        return []
    pdf = df[df["pitcher"] == pitcher_id]
    if pdf.empty:
        return []
    pdf = pdf.copy()
    # Exclude All-Star Game data
    if "game_type" in pdf.columns:
        pdf = pdf[pdf["game_type"] != "A"]
    if pdf.empty:
        return []
    if "game_date" in pdf.columns:
        pdf["game_date"] = pdf["game_date"].astype(str)
    pdf["is_whiff"] = pdf["description"].isin(_WHIFF_DESCS)
    pdf["is_called_strike"] = pdf["description"] == "called_strike"
    pdf["is_swing"] = pdf["description"].isin(_SWING_DESCS)
    pdf["is_strike_type"] = pdf["type"].isin(_STRIKE_TYPES) if "type" in pdf.columns else False

    # Pre-fetch all boxscores for this pitcher's games in parallel
    pitcher_game_pks = [int(gpk) for gpk in pdf["game_pk"].unique()]
    box_maps = _prefetch_boxscores_parallel(pitcher_game_pks)

    results = []
    for game_pk, gdf in pdf.groupby("game_pk"):
        total_pitches = len(gdf)
        whiffs = int(gdf["is_whiff"].sum())
        called_strikes = int(gdf["is_called_strike"].sum())
        strikes_g = int(gdf["is_strike_type"].sum())
        game_date = str(gdf["game_date"].iloc[0])[:10] if "game_date" in gdf.columns else ""
        team = gdf["pitcher_team"].iloc[0] if "pitcher_team" in gdf.columns else ""
        opp = gdf["opponent"].iloc[0] if "opponent" in gdf.columns else ""
        home_team = gdf["home_team"].iloc[0] if "home_team" in gdf.columns else ""

        events_df = gdf.dropna(subset=["events"])
        events_df = events_df[events_df["events"] != ""]
        ev_col = events_df["events"] if not events_df.empty else pd.Series(dtype=str)
        hits = int(ev_col.isin(_HIT_EVENTS).sum())
        bbs = int(ev_col.isin(_BB_EVENTS).sum())
        ks = int(ev_col.isin(_K_EVENTS).sum())
        hrs = int(ev_col.isin(_HR_EVENTS).sum())
        outs = _compute_outs_vectorized(ev_col)
        ip_str = f"{outs // 3}.{outs % 3}"
        er = 0

        # Use pre-fetched boxscore (already in memory)
        runs = 0
        batters_faced = 0
        game_started = 0
        decision = ""
        box = box_maps.get(int(game_pk), {})
        pbox = box.get(int(pitcher_id))
        if pbox:
            er = pbox.get("er", 0)
            runs = pbox.get("runs", 0)
            if pbox.get("ip") is not None:
                ip_str = pbox["ip"]
            hits = pbox.get("hits", hits)
            bbs = pbox.get("bbs", bbs)
            ks = pbox.get("ks", ks)
            hrs = pbox.get("hrs", hrs)
            batters_faced = pbox.get("batters_faced", 0)
            game_started = pbox.get("games_started", 0)
            decision = pbox.get("decision", "")

        pa_count, two_strike_pas, two_strike_pitches, strikeouts = _compute_two_strike_pa_stats(gdf)
        results.append({
            "game_pk": int(game_pk),
            "date": game_date,
            "team": team,
            "opponent": opp,
            "home_team": home_team,
            "ip": ip_str,
            "hits": hits,
            "bbs": bbs,
            "ks": ks,
            "hrs": hrs,
            "er": er,
            "runs": runs,
            "batters_faced": batters_faced,
            "games_started": game_started,
            "decision": decision,
            "whiffs": whiffs,
            "swstr_pct": round(whiffs / total_pitches * 100, 2) if total_pitches > 0 else 0,
            "csw_pct": round((called_strikes + whiffs) / total_pitches * 100, 2) if total_pitches > 0 else 0,
            "strike_pct": round(strikes_g / total_pitches * 100, 2) if total_pitches > 0 else 0,
            "pitches": total_pitches,
            "strikes": strikes_g,
            # Raw counters retained so season totals can recompute these stats
            # without re-iterating per-pitch data.
            "pa_count": pa_count,
            "two_strike_pas": two_strike_pas,
            "two_strike_pitches": two_strike_pitches,
            "strikeouts_for_par": strikeouts,
            "two_str_pct": round(two_strike_pas / pa_count * 100, 2) if pa_count > 0 else 0,
            # PAR%: strikeouts / batters faced who reached a two-strike count.
            "par_pct": round(ks / two_strike_pas * 100, 2) if two_strike_pas > 0 else 0,
        })
    results.sort(key=lambda r: r["date"])
    return results
