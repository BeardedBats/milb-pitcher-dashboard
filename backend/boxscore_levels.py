"""Box-score-only pitching data for levels without Statcast (AA, A+, A, R) and
for AFL games Savant never tracked.

Everything here comes straight off the MLB Stats API box score / gameLog — no
derived metrics beyond Str% (strikes / pitches) and GO/AO (groundOuts /
airOuts), both of which the API hands us the inputs for directly.

The Statcast levels (AAA, AFL-with-data) go through aggregation.py instead;
this module is the adapted-table path.
"""
import base64
import gzip
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from redis_cache import redis_get, redis_set
from levels import (
    DEFAULT_LEVEL, LEVEL_ORDER, LEVELS, normalize_level, org_for_team,
    team_display_name, team_meta_by_id,
)

_BOXSCORE_URL = "https://statsapi.mlb.com/api/v1/game/{game_pk}/boxscore"
# The live feed carries the box score AND the play-by-play in one response, so
# reading it costs the same one request as /boxscore but also yields per-pitch
# call codes and batted-ball trajectories. That is the whole reason the
# non-Statcast levels can have CSW%/SwStr%/GB% at all.
_FEED_URL = "https://statsapi.mlb.com/api/v1.1/game/{game_pk}/feed/live"

# Pitch-result call codes (details.call.code) present at every MiLB level.
# A foul tip is a whiff — same convention the Statcast pipeline uses (see
# data._reclassify_strikeout_fouls), so CSW/SwStr agree across the two paths.
_WHIFF_CODES = frozenset({"S", "W", "T"})   # swinging, swinging-blocked, foul tip
_CALLED_CODES = frozenset({"C"})            # called strike
_FOUL_CODES = frozenset({"F", "L"})         # foul, foul bunt
_INPLAY_CODES = frozenset({"X", "D", "E"})  # in play: out(s) / no out / run(s)
_CONTACT_CODES = _FOUL_CODES | _INPLAY_CODES
_SWING_CODES = _WHIFF_CODES | _CONTACT_CODES
# Anything that counts as a strike for F-Strike%: swings, called strikes, fouls,
# and balls put in play. (A foul tip is already in _WHIFF_CODES.)
_STRIKE_CODES = _SWING_CODES | _CALLED_CODES

# ── Gameday pixel -> feet, fitted against AAA games that have BOTH Savant
# plate_x/plate_z (feet) and a GUMBO feed (pixels). 1,090 matched pitches
# across 4 games, 3-sigma trimmed:
#     plate_x: R^2=0.9993, mean error 0.21", max 0.77"
#     plate_z: R^2=0.9998, mean error 0.13", max 0.49"
# The two axes have DIFFERENT scales (37.6 vs 26.5 px/ft) — a single assumed
# constant would be wrong, which is why these are fitted rather than guessed.
_PX_A, _PX_B = -0.02660355, 3.122211    # plate_x (ft) from coordinates.x
_PZ_A, _PZ_B = -0.03771641, 8.882287    # plate_z (ft) from coordinates.y

# Zone boundary, grid-fitted on 1,684 AAA pitches against Savant's own `zone`
# field: 98.69% agreement, Zone% 47.2 vs 47.6. The vertical pad came out at
# 0.12 ft = 1.44" — a ball radius — because a pitch is in-zone when any part of
# the ball crosses it, not just its center. The horizontal half-width already
# carried that allowance.
_ZONE_HALF_WIDTH = 0.83   # ft from plate center
_ZONE_PAD = 0.12          # ft, ball radius


def _plate_coords(pitch_data):
    """(plate_x, plate_z) in feet from a GUMBO pitchData block, or (None, None)."""
    c = (pitch_data or {}).get("coordinates") or {}
    x, y = c.get("x"), c.get("y")
    if x is None or y is None:
        return None, None
    return _PX_A * x + _PX_B, _PZ_A * y + _PZ_B


def _is_in_zone(plate_x, plate_z, sz_top, sz_bot):
    if plate_x is None or plate_z is None or sz_top is None or sz_bot is None:
        return None
    return (
        abs(plate_x) <= _ZONE_HALF_WIDTH
        and (sz_bot - _ZONE_PAD) <= plate_z <= (sz_top + _ZONE_PAD)
    )

# hitData.trajectory buckets. A bunt grounder is a ground ball.
_GB_TRAJ = frozenset({"ground_ball", "bunt_grounder"})
_FB_TRAJ = frozenset({"fly_ball"})
_LD_TRAJ = frozenset({"line_drive"})
_PU_TRAJ = frozenset({"popup"})
_GAMELOG_URL = (
    "https://statsapi.mlb.com/api/v1/people/{pitcher_id}/stats"
    "?stats=gameLog&group=pitching&season={season}&sportId={sport_id}"
)

_BOX_TTL_FINAL = 30 * 24 * 3600
_BOX_TTL_LIVE = 60
_box_cache = {}  # { game_pk: (timestamp, is_final, payload) }
_box_lock = threading.Lock()

# Everything in this module is two-tier: an in-process dict (L1) in front of
# Redis (L2). On a persistent uvicorn the L1 dict alone is enough, but on
# serverless every cold start begins with an empty L1 — without L2 a single
# player page would re-run 6 gameLog calls and an org page one request per
# affiliate, on every invocation.
_MILB_CACHE_PREFIX = "milb"
_rows_cache = {}  # { (game_pk, level, is_final): (timestamp, rows) }

# BUMP THIS whenever the shape of a derived row or a metrics dict changes.
#
# Every Redis key in this module embeds it. That is not belt-and-braces: the
# derived-row key has a 30-day TTL and sits BEHIND the daily agg key, so
# bumping only CARD_SCHEMA_VERSION is not enough — the daily key misses,
# recomputes, and then reads month-old rows straight back out of this cache.
# That is exactly what shipped v45's metrics to a v46 deploy.
#   2: initial derived rows (whiffs, CSW%, SwStr%, GB/FB/LD, Hard%) — shipped
#      as a hand-written literal "rows:v2", which is why numbering starts here
#   3: five metric families + per-hand splits
#
# Note the near-miss: replacing the literal with a constant set to 2 produced a
# byte-identical key and kept serving the very rows the bump was meant to
# retire. A version bump is only real if the resulting key string changes.
_METRICS_VERSION = 3


def _l2_get(key):
    try:
        return redis_get(key)
    except Exception:
        return None


def _l2_set(key, value, ttl):
    try:
        redis_set(key, value, ttl=ttl)
    except Exception:
        pass


# The all-levels directory is ~730 KB of JSON — under Upstash's 1 MB
# per-request ceiling today, but not with any headroom as the season adds
# pitchers. gzip+base64 takes it to ~160 KB. Mirrors data.py's range-snapshot
# compression; kept local here to avoid a boxscore_levels -> data import cycle.
_GZ_MARKER = "__gz__"


def _l2_set_compressed(key, value, ttl):
    try:
        raw = json.dumps(value, separators=(",", ":")).encode("utf-8")
        packed = base64.b64encode(gzip.compress(raw)).decode("ascii")
        redis_set(key, {_GZ_MARKER: packed}, ttl=ttl)
    except Exception as e:
        print(f"[BoxLevels] compressed set failed for {key}: {e}")


def _l2_get_compressed(key):
    val = _l2_get(key)
    if val is None:
        return None
    if isinstance(val, dict) and _GZ_MARKER in val:
        try:
            return json.loads(gzip.decompress(base64.b64decode(val[_GZ_MARKER])))
        except Exception as e:
            print(f"[BoxLevels] decompress failed for {key}: {e}")
            return None
    return val  # legacy uncompressed entry


def _two_tier(l1, l1_key, redis_key, ttl, compute):
    """L1 dict -> Redis -> origin. Only non-empty results are cached, so a
    transient API failure stays retryable instead of being memoized as 'none'."""
    now = time.time()
    hit = l1.get(l1_key)
    if hit and (now - hit[0]) < ttl:
        return hit[1]
    cached = _l2_get(redis_key)
    if cached is not None:
        l1[l1_key] = (now, cached)
        return cached
    value = compute()
    if value:
        l1[l1_key] = (now, value)
        _l2_set(redis_key, value, ttl)
    return value


def _num(v, default=0):
    if v is None:
        return default
    try:
        return int(v)
    except (ValueError, TypeError):
        try:
            return float(v)
        except (ValueError, TypeError):
            return default


def _pct(numerator, denominator):
    """Percentage 0-100, rounded to 1dp. None when the denominator is 0 so the
    UI renders an em dash instead of a misleading 0.0%."""
    if not denominator:
        return None
    return round(numerator / denominator * 100, 1)


def _ratio(numerator, denominator):
    if not denominator:
        return None
    return round(numerator / denominator, 2)


def _decision_from_note(note):
    """'(W, 2-9)' -> 'W'. Mirrors data._get_boxscore_stats so decisions read the
    same across the Statcast and box-score paths."""
    import re
    if not note:
        return ""
    m = re.match(r"\(([WLS])", note)
    return m.group(1) if m else ""


def _fetch_feed(game_pk):
    """One live-feed pull per game — box score + play-by-play together.

    L1 only: a feed is 1-3 MB, far too big for Redis. What DOES go to Redis is
    the small derived row set built from it (see _rows_for_game).
    """
    game_pk = int(game_pk)
    now = time.time()
    with _box_lock:
        hit = _box_cache.get(game_pk)
    if hit:
        ts, is_final, payload = hit
        if is_final or (now - ts) < _BOX_TTL_LIVE:
            return payload
    try:
        resp = requests.get(_FEED_URL.format(game_pk=game_pk), timeout=20)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        print(f"[BoxLevels] feed fetch failed for {game_pk}: {e}")
        return None
    state = (((payload.get("gameData") or {}).get("status") or {})
             .get("abstractGameState"))
    with _box_lock:
        _box_cache[game_pk] = (now, state == "Final", payload)
    return payload


def _new_bucket():
    return {
        "tracked_pitches": 0, "whiffs": 0, "called_strikes": 0, "swings": 0,
        "contact": 0, "in_zone": 0, "zone_known": 0, "o_swings": 0, "o_pitches": 0,
        "z_swings": 0, "z_contact": 0, "o_contact": 0,
        "first_pitches": 0, "first_pitch_strikes": 0,
        "two_strike_pitches": 0,
        "bip": 0, "gb": 0, "fb": 0, "ld": 0, "pu": 0,
        "soft": 0, "medium": 0, "hard": 0, "hardness_known": 0,
        "pull": 0, "center": 0, "oppo": 0, "spray_known": 0,
    }


# hitData.location is the fielder position that fielded the ball. Left side of
# the diamond is 5/6/7, right side 3/4/9, up the middle 1/2/8. Pull vs oppo
# flips with batter handedness. Two-digit codes (e.g. "78") are gaps — the
# first digit carries the side.
_LEFT_SIDE = {"5", "6", "7"}
_RIGHT_SIDE = {"3", "4", "9"}
_MIDDLE = {"1", "2", "8"}


def _spray_bucket(location, bat_side):
    """'pull' | 'center' | 'oppo' | None from fielder position + batter hand."""
    if not location or not bat_side:
        return None
    side = str(location)[0]
    if side in _MIDDLE:
        return "center"
    if side in _LEFT_SIDE:
        return "pull" if bat_side == "R" else "oppo"
    if side in _RIGHT_SIDE:
        return "oppo" if bat_side == "R" else "pull"
    return None


def _finalize(m):
    """Turn raw counters into the published metric dict."""
    p = m["tracked_pitches"]
    bip = m["bip"]
    zk = m["zone_known"]
    hk = m["hardness_known"]
    sk = m["spray_known"]
    return {
        "tracked_pitches": p,
        "whiffs": m["whiffs"],
        "called_strikes": m["called_strikes"],
        "swings": m["swings"],
        "csw_pct": _pct(m["whiffs"] + m["called_strikes"], p),
        "swstr_pct": _pct(m["whiffs"], p),
        "whiff_pct": _pct(m["whiffs"], m["swings"]),      # whiffs per SWING
        "swing_pct": _pct(m["swings"], p),
        "contact_pct": _pct(m["contact"], m["swings"]),
        # Count-based. first_pitches is exposed so it can be reconciled against
        # battersFaced and so season aggregates can re-weight the rate.
        "first_pitches": m["first_pitches"],
        "first_pitch_strikes": m["first_pitch_strikes"],
        "f_strike_pct": _pct(m["first_pitch_strikes"], m["first_pitches"]),
        "two_strike_pitches": m["two_strike_pitches"],
        "two_str_pct": _pct(m["two_strike_pitches"], p),
        # Zone (calibrated from Gameday pixels — see _plate_coords)
        "zone_pct": _pct(m["in_zone"], zk),
        "o_swing_pct": _pct(m["o_swings"], m["o_pitches"]),
        "z_swing_pct": _pct(m["z_swings"], m["in_zone"]),
        "z_contact_pct": _pct(m["z_contact"], m["z_swings"]),
        "o_contact_pct": _pct(m["o_contact"], m["o_swings"]),
        # Batted ball
        "bip": bip,
        "gb": m["gb"], "fb": m["fb"], "ld": m["ld"], "pu": m["pu"],
        "gb_pct": _pct(m["gb"], bip),
        "fb_pct": _pct(m["fb"], bip),
        "ld_pct": _pct(m["ld"], bip),
        "pu_pct": _pct(m["pu"], bip),
        "gb_fb_ratio": _ratio(m["gb"], m["fb"]),
        # Contact quality (full distribution, not just hard)
        "soft_pct": _pct(m["soft"], hk),
        "med_pct": _pct(m["medium"], hk),
        "hard_pct": _pct(m["hard"], hk),
        # Spray
        "pull_pct": _pct(m["pull"], sk),
        "center_pct": _pct(m["center"], sk),
        "oppo_pct": _pct(m["oppo"], sk),
    }


def _derive_pitch_metrics(feed):
    """Per-pitcher pitch-level metrics from the play-by-play.

    These levels have no Statcast — no velocity, pitch type or movement
    (verified: startSpeed and details.type are absent on every pitch at every
    level). But every pitch carries a CALL, a ball/strike COUNT, a batter
    HANDEDNESS and a plate LOCATION, and every ball in play carries a
    trajectory, hardness and fielder. That is enough for five metric families:

        plate discipline  CSW%, SwStr%, Whiff%, Swing%, Contact%
        count             F-Strike%, 2Str%, PAR%
        zone              Zone%, O-Swing%, Z-Swing%, Z-Contact%, O-Contact%
        batted ball       GB/FB/LD/PU%, GB/FB
        contact quality   Soft/Med/Hard%, Pull/Center/Oppo%

    Each family is also split by batter handedness into `splits.L` / `splits.R`.

    Attribution walks the events in order rather than trusting
    `matchup.pitcher.id`, which names the pitcher who FINISHED the plate
    appearance. On a mid-PA pitching change that misfiles every pitch the
    departing pitcher threw in that PA — observed on 2026-07-30 in Rookie game
    849353, where 3 pitches moved from De La Cruz to Martinez while the game
    total still reconciled. `pitching_substitution` action events carry the
    incoming `player.id`, so switching the active pitcher when one appears
    attributes every pitch correctly.

    Batted-ball rates are over ALL balls in play, unlike the box score's GO/AO
    which counts only balls in play that became OUTS. Both are exposed; they
    are different denominators, not a discrepancy.
    """
    plays = (((feed or {}).get("liveData") or {}).get("plays") or {}).get("allPlays") or []
    overall = {}
    splits = {}   # {pitcher_id: {"L": bucket, "R": bucket}}
    # PAR% needs plate-appearance granularity, not pitch granularity.
    pa_stats = {}  # {pitcher_id: {"two_strike_pas": n, "strikeouts": n}}

    def buckets_for(pid, bat_side):
        """Every counter update touches the overall bucket and, when the batter
        side is known, the matching split bucket."""
        out = [overall.setdefault(pid, _new_bucket())]
        if bat_side in ("L", "R"):
            out.append(splits.setdefault(pid, {}).setdefault(bat_side, _new_bucket()))
        return out

    active = None
    for play in plays:
        matchup = play.get("matchup") or {}
        play_pitcher = (matchup.get("pitcher") or {}).get("id")
        bat_side = ((matchup.get("batSide") or {}).get("code") or "").upper() or None
        events = sorted(play.get("playEvents") or [], key=lambda e: e.get("index", 0))
        has_sub = any(
            (e.get("details") or {}).get("eventType") == "pitching_substitution"
            for e in events
        )
        current = play_pitcher if not has_sub else (active if active is not None else play_pitcher)

        reached_two_strikes = False
        pa_ending_pitcher = current
        # GUMBO's `count` on a pitch event is the count AFTER that pitch, not
        # before it — verified against full PA sequences (a called strike on 0-0
        # reports 0-1). Metrics keyed on the count a pitch was THROWN in must
        # therefore use the previous event's count, which is what prev_count
        # carries. Naively reading `count` made F-Strike% match only
        # first-pitch balls in play (the one case where the count doesn't
        # advance) and report 100%.
        prev_count = (0, 0)
        for e in events:
            details = e.get("details") or {}
            if details.get("eventType") == "pitching_substitution":
                new_pid = (e.get("player") or {}).get("id")
                if new_pid is not None:
                    current = new_pid
                continue
            if current is None:
                continue

            if e.get("isPitch"):
                code = (details.get("call") or {}).get("code")
                after = e.get("count") or {}
                # The count this pitch was thrown IN.
                balls, strikes = prev_count
                is_first_pitch = (e.get("pitchNumber") == 1) or (balls == 0 and strikes == 0)
                pitch_data = e.get("pitchData") or {}
                plate_x, plate_z = _plate_coords(pitch_data)
                in_zone = _is_in_zone(
                    plate_x, plate_z,
                    pitch_data.get("strikeZoneTop"), pitch_data.get("strikeZoneBottom"),
                )
                is_swing = code in _SWING_CODES
                is_contact = code in _CONTACT_CODES

                for m in buckets_for(current, bat_side):
                    m["tracked_pitches"] += 1
                    if code in _WHIFF_CODES:
                        m["whiffs"] += 1
                    elif code in _CALLED_CODES:
                        m["called_strikes"] += 1
                    if is_swing:
                        m["swings"] += 1
                    if is_contact:
                        m["contact"] += 1
                    if is_first_pitch:
                        m["first_pitches"] += 1
                        if code in _STRIKE_CODES:
                            m["first_pitch_strikes"] += 1
                    if strikes == 2:
                        m["two_strike_pitches"] += 1
                    if in_zone is not None:
                        m["zone_known"] += 1
                        if in_zone:
                            m["in_zone"] += 1
                            if is_swing:
                                m["z_swings"] += 1
                                if is_contact:
                                    m["z_contact"] += 1
                        else:
                            m["o_pitches"] += 1
                            if is_swing:
                                m["o_swings"] += 1
                                if is_contact:
                                    m["o_contact"] += 1
                if (after.get("strikes") or 0) >= 2:
                    reached_two_strikes = True
                prev_count = (after.get("balls") or 0, after.get("strikes") or 0)
                pa_ending_pitcher = current

            hd = e.get("hitData")
            if hd:
                traj = hd.get("trajectory")
                hardness = hd.get("hardness")
                spray = _spray_bucket(hd.get("location"), bat_side)
                for m in buckets_for(current, bat_side):
                    m["bip"] += 1
                    if traj in _GB_TRAJ:
                        m["gb"] += 1
                    elif traj in _FB_TRAJ:
                        m["fb"] += 1
                    elif traj in _LD_TRAJ:
                        m["ld"] += 1
                    elif traj in _PU_TRAJ:
                        m["pu"] += 1
                    if hardness in ("soft", "medium", "hard"):
                        m["hardness_known"] += 1
                        m[hardness] += 1
                    if spray:
                        m["spray_known"] += 1
                        m[spray] += 1

        # PAR%: strikeouts as a share of the plate appearances that reached two
        # strikes. Credited to whoever finished the PA, matching how the box
        # score assigns the strikeout.
        if pa_ending_pitcher is not None and reached_two_strikes:
            st = pa_stats.setdefault(pa_ending_pitcher, {"two_strike_pas": 0, "strikeouts": 0})
            st["two_strike_pas"] += 1
            event_type = ((play.get("result") or {}).get("eventType") or "")
            if event_type.startswith("strikeout"):
                st["strikeouts"] += 1

        if current is not None:
            active = current

    out = {}
    for pid, m in overall.items():
        rec = _finalize(m)
        st = pa_stats.get(pid) or {}
        rec["two_strike_pas"] = st.get("two_strike_pas", 0)
        rec["par_pct"] = _pct(st.get("strikeouts", 0), st.get("two_strike_pas", 0))
        side_recs = {}
        for side, sm in (splits.get(pid) or {}).items():
            side_recs[side] = _finalize(sm)
        if side_recs:
            rec["splits"] = side_recs
        out[int(pid)] = rec
    return out


def _rows_for_game(game, level):
    """Adapted result rows for one game's pitchers, cached through Redis.

    The DERIVED rows are cached, not the raw box score — a box score payload is
    hundreds of KB and would blow past Upstash's per-request limit for a full
    slate, while the rows for one game are a few KB.

    A final game's rows never change, so they cache for 30 days — that lets the
    daily cron accumulate a season of pitch metrics that player-page game logs
    then read for free. A live game's rows cache for a minute.

    The key embeds _METRICS_VERSION so a shape change can never serve stale
    rows — see the note on that constant.
    """
    is_final = (game.get("abstract_state") == "Final")
    ttl = _BOX_TTL_FINAL if is_final else _BOX_TTL_LIVE
    game_pk = int(game["game_pk"])
    redis_key = f"{_MILB_CACHE_PREFIX}:rows:v{_METRICS_VERSION}:{level}:{game_pk}:{'F' if is_final else 'L'}"
    return _two_tier(
        _rows_cache, (game_pk, level, is_final), redis_key, ttl,
        lambda: _build_rows_for_game(game, level),
    )


def _build_rows_for_game(game, level):
    """Adapted result rows for one game's pitchers (both sides).

    Official counting stats come from the box score; plate-discipline and
    batted-ball rates are derived from the same feed's play-by-play.
    """
    feed = _fetch_feed(game["game_pk"])
    if not feed:
        return []
    box = ((feed.get("liveData") or {}).get("boxscore")) or {}
    metrics = _derive_pitch_metrics(feed)
    rows = []
    for side in ("away", "home"):
        team_box = (box.get("teams") or {}).get(side) or {}
        opp_side = "home" if side == "away" else "away"
        opp_box = (box.get("teams") or {}).get(opp_side) or {}
        team_id = ((team_box.get("team") or {}).get("id"))
        opp_id = ((opp_box.get("team") or {}).get("id"))
        team_meta = team_meta_by_id(team_id) or {}
        opp_meta = team_meta_by_id(opp_id) or {}
        team_abbrev = team_meta.get("abbrev") or (game.get(f"{side}_team") or "")
        opp_abbrev = opp_meta.get("abbrev") or (game.get(f"{opp_side}_team") or "")
        pitcher_ids = team_box.get("pitchers") or []
        for order, pid in enumerate(pitcher_ids, start=1):
            pinfo = (team_box.get("players") or {}).get(f"ID{pid}") or {}
            st = ((pinfo.get("stats") or {}).get("pitching")) or {}
            if not st or st.get("inningsPitched") is None:
                continue
            pitches = _num(st.get("numberOfPitches") or st.get("pitchesThrown"))
            strikes = _num(st.get("strikes"))
            ground_outs = _num(st.get("groundOuts"))
            air_outs = _num(st.get("airOuts"))
            rows.append({
                "date": game.get("date"),
                "level": level,
                "game_pk": int(game["game_pk"]),
                "pitcher_id": int(pid),
                "pitcher": (pinfo.get("person") or {}).get("fullName", ""),
                "team": team_abbrev,
                "team_id": team_id,
                "team_name": team_meta.get("name") or "",
                "team_display": team_display_name(team_id=team_id, abbrev=team_abbrev, level=level),
                "org": org_for_team(team_id=team_id, abbrev=team_abbrev, level=level),
                "opponent": opp_abbrev,
                "opponent_org": org_for_team(team_id=opp_id, abbrev=opp_abbrev, level=level),
                "home": side == "home",
                "decision": _decision_from_note(st.get("note")),
                "ip": st.get("inningsPitched"),
                "hits": _num(st.get("hits")),
                "runs": _num(st.get("runs")),
                "er": _num(st.get("earnedRuns")),
                "bbs": _num(st.get("baseOnBalls")),
                "ks": _num(st.get("strikeOuts")),
                "hrs": _num(st.get("homeRuns")),
                "batters_faced": _num(st.get("battersFaced")),
                "pitches": pitches,
                "strikes": strikes,
                "strike_pct": _pct(strikes, pitches),
                "ground_outs": ground_outs,
                "air_outs": air_outs,
                "go_ao": _ratio(ground_outs, air_outs),
                "games_started": _num(st.get("gamesStarted")),
                "appearance_order": order,
                # SP/RP uses the same rule as the Statcast pipeline: the first
                # pitcher a team uses is the starter. gamesStarted from the box
                # score confirms it, so we don't need the opener heuristic here.
                "role": "SP" if (_num(st.get("gamesStarted")) == 1 or order == 1) else "RP",
                # Plate-discipline + batted-ball metrics from the play-by-play.
                # Empty dict (not zeros) when a game has no tracked plays, so
                # the UI shows em dashes rather than a fake 0.0%.
                **(metrics.get(int(pid)) or {}),
            })
    return rows


def get_level_results(date_str, level=DEFAULT_LEVEL, games=None):
    """Adapted box-score result rows for every pitcher at `level` on `date_str`.

    `games` is the level's schedule (list of dicts with game_pk/home_team/...);
    callers that already have it pass it in to avoid a second schedule fetch.
    """
    level = normalize_level(level)
    if not games:
        from data import _get_mlb_schedule  # local import: data imports levels
        games = _get_mlb_schedule(date_str, level=level) or []
    started = [g for g in games if (g.get("abstract_state") in {"Live", "Final"})]
    if not started:
        return []
    rows = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(_rows_for_game, {**g, "date": date_str}, level): g["game_pk"]
            for g in started
        }
        for f in as_completed(futures):
            try:
                rows.extend(f.result() or [])
            except Exception as e:
                print(f"[BoxLevels] game {futures[f]} failed: {e}")
    rows.sort(key=lambda r: (r.get("team") or "", r.get("appearance_order", 99)))
    return rows


# ── Multi-level game log (player pages) ────────────────────────────────────

_LOG_TTL = 900
_log_cache = {}  # { (pitcher_id, season): (timestamp, rows) }


def _gamelog_for_level(pitcher_id, season, level):
    cfg = LEVELS[level]
    url = _GAMELOG_URL.format(pitcher_id=pitcher_id, season=season, sport_id=cfg["sport_id"])
    try:
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[BoxLevels] gameLog failed for {pitcher_id} {level}: {e}")
        return []
    rows = []
    for group in data.get("stats", []):
        for s in group.get("splits", []):
            st = s.get("stat") or {}
            if st.get("inningsPitched") is None:
                continue
            game_pk = ((s.get("game") or {}).get("gamePk"))
            team = s.get("team") or {}
            opp = s.get("opponent") or {}
            pitches = _num(st.get("numberOfPitches") or st.get("pitchesThrown"))
            strikes = _num(st.get("strikes"))
            ground_outs = _num(st.get("groundOuts"))
            air_outs = _num(st.get("airOuts"))
            decision = ""
            if _num(st.get("wins")):
                decision = "W"
            elif _num(st.get("losses")):
                decision = "L"
            elif _num(st.get("saves")):
                decision = "S"
            elif _num(st.get("holds")):
                decision = "H"
            elif _num(st.get("blownSaves")):
                decision = "BS"
            rows.append({
                "date": s.get("date"),
                "level": level,
                "game_pk": int(game_pk) if game_pk is not None else None,
                "team": (team_meta_by_id(team.get("id")) or {}).get("abbrev") or "",
                "team_id": team.get("id"),
                "team_name": team.get("name") or "",
                "team_display": team_display_name(team_id=team.get("id"), level=level),
                "org": org_for_team(team_id=team.get("id"), level=level),
                "opponent": (team_meta_by_id(opp.get("id")) or {}).get("abbrev") or "",
                "opponent_name": opp.get("name") or "",
                "home": bool(s.get("isHome")),
                "decision": decision,
                "ip": st.get("inningsPitched"),
                "hits": _num(st.get("hits")),
                "runs": _num(st.get("runs")),
                "er": _num(st.get("earnedRuns")),
                "bbs": _num(st.get("baseOnBalls")),
                "ks": _num(st.get("strikeOuts")),
                "hrs": _num(st.get("homeRuns")),
                "batters_faced": _num(st.get("battersFaced")),
                "pitches": pitches,
                "strikes": strikes,
                "strike_pct": _pct(strikes, pitches),
                "ground_outs": ground_outs,
                "air_outs": air_outs,
                "go_ao": _ratio(ground_outs, air_outs),
                "games_started": _num(st.get("gamesStarted")),
                "role": "SP" if _num(st.get("gamesStarted")) else "RP",
            })
    return rows


def get_multi_level_game_log(pitcher_id, season):
    """Every 2026 appearance across EVERY minor-league level, merged and sorted.

    One gameLog call per level (6 total, run in parallel), so a pitcher who was
    promoted mid-season shows AA and AAA rows in one chronological list. MLB
    (sportId 1) is never queried — this build excludes major-league games.
    """
    pitcher_id, season = int(pitcher_id), int(season)
    return _two_tier(
        _log_cache, (pitcher_id, season),
        f"{_MILB_CACHE_PREFIX}:gamelog:{pitcher_id}:{season}", _LOG_TTL,
        lambda: _build_multi_level_game_log(pitcher_id, season),
    )


def _build_multi_level_game_log(pitcher_id, season):
    rows = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {
            pool.submit(_gamelog_for_level, pitcher_id, season, code): code
            for code in LEVEL_ORDER
        }
        for f in as_completed(futures):
            try:
                rows.extend(f.result() or [])
            except Exception as e:
                print(f"[BoxLevels] gameLog level {futures[f]} failed: {e}")
    # Dedupe on game_pk — a pitcher can't appear twice in one game, and a
    # doubleheader has distinct game_pks.
    seen, deduped = set(), []
    for r in sorted(rows, key=lambda r: (r.get("date") or "", r.get("game_pk") or 0)):
        if r["game_pk"] in seen:
            continue
        seen.add(r["game_pk"])
        deduped.append(r)
    return deduped


_TEAM_SEASON_URL = (
    "https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching"
    "&season={season}&sportId={sport_id}&teamId={team_id}&playerPool=ALL&limit=300"
)

_team_season_cache = {}  # { (team_id, season): (timestamp, rows) }
_TEAM_SEASON_TTL = 1800


def get_team_season_pitchers(team_id, level, season):
    """Season pitching line for every pitcher on one affiliate.

    One request per affiliate, which is what makes org pages viable for the
    non-Statcast levels — the alternative (walking each team's schedule and
    pulling a box score per game) would be several hundred requests per org.
    """
    team_id, season = int(team_id), int(season)
    level = normalize_level(level)
    return _two_tier(
        _team_season_cache, (team_id, season),
        f"{_MILB_CACHE_PREFIX}:teamseason:{level}:{team_id}:{season}", _TEAM_SEASON_TTL,
        lambda: _build_team_season_pitchers(team_id, level, season),
    )


def _build_team_season_pitchers(team_id, level, season):
    cfg = LEVELS[normalize_level(level)]
    url = _TEAM_SEASON_URL.format(season=season, sport_id=cfg["sport_id"], team_id=team_id)
    rows = []
    try:
        resp = requests.get(url, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[BoxLevels] team season stats failed for {team_id} ({level}): {e}")
        return []
    meta = team_meta_by_id(team_id) or {}
    for group in data.get("stats", []):
        for s in group.get("splits", []):
            st = s.get("stat") or {}
            if st.get("inningsPitched") is None:
                continue
            player = s.get("player") or {}
            pitches = _num(st.get("numberOfPitches") or st.get("pitchesThrown"))
            strikes = _num(st.get("strikes"))
            ground_outs = _num(st.get("groundOuts"))
            air_outs = _num(st.get("airOuts"))
            games_started = _num(st.get("gamesStarted"))
            rows.append({
                "pitcher_id": player.get("id"),
                "pitcher": player.get("fullName") or "",
                "level": normalize_level(level),
                "team": meta.get("abbrev") or "",
                "team_id": team_id,
                "team_name": meta.get("name") or "",
                "org": meta.get("org"),
                "games": _num(st.get("gamesPlayed")),
                "games_started": games_started,
                "ip": st.get("inningsPitched"),
                "hits": _num(st.get("hits")),
                "runs": _num(st.get("runs")),
                "er": _num(st.get("earnedRuns")),
                "bbs": _num(st.get("baseOnBalls")),
                "ks": _num(st.get("strikeOuts")),
                "hrs": _num(st.get("homeRuns")),
                "batters_faced": _num(st.get("battersFaced")),
                "pitches": pitches,
                "strikes": strikes,
                "strike_pct": _pct(strikes, pitches),
                "ground_outs": ground_outs,
                "air_outs": air_outs,
                "go_ao": _ratio(ground_outs, air_outs),
                "era": st.get("era"),
                "whip": st.get("whip"),
                "role": "SP" if games_started else "RP",
            })
    rows.sort(key=lambda r: (-(r.get("games_started") or 0), -(r.get("games") or 0)))
    return rows


_PEOPLE_URL = "https://statsapi.mlb.com/api/v1/people/{pitcher_id}"
_person_cache = {}
# A player's name and throwing hand don't change — cache for a week.
_PERSON_TTL = 7 * 24 * 3600


def get_person_info(pitcher_id):
    """Name + throwing hand from the MLB people endpoint.

    Needed because a pitcher with no AAA games has no Savant rows at all, and
    the Savant frame is where the player page normally gets its identity — so
    without this the page would render a nameless header.
    """
    pitcher_id = int(pitcher_id)
    return _two_tier(
        _person_cache, pitcher_id,
        f"{_MILB_CACHE_PREFIX}:person:{pitcher_id}", _PERSON_TTL,
        lambda: _fetch_person_info(pitcher_id),
    )


def _fetch_person_info(pitcher_id):
    info = {}
    try:
        resp = requests.get(_PEOPLE_URL.format(pitcher_id=pitcher_id), timeout=15)
        resp.raise_for_status()
        people = resp.json().get("people") or []
        if people:
            p = people[0]
            info = {
                "name": p.get("fullName") or "",
                "hand": ((p.get("pitchHand") or {}).get("code")) or "",
                "position": ((p.get("primaryPosition") or {}).get("abbreviation")) or "P",
            }
    except Exception as e:
        print(f"[BoxLevels] people lookup failed for {pitcher_id}: {e}")
    return info


_pm_cache = {}  # { game_pk: (timestamp, {pitcher_id: metrics}) }


def get_game_pitch_metrics(game_pk, allow_fetch=True):
    """{pitcher_id: pitch metrics} for one game, cached small in Redis.

    Separate from _rows_for_game so a player-page game log — which knows only
    game_pks, not the schedule rows — can enrich itself. `allow_fetch=False`
    serves cache-only, for callers that must not pay a cold feed pull.
    """
    game_pk = int(game_pk)
    now = time.time()
    hit = _pm_cache.get(game_pk)
    if hit and (now - hit[0]) < _BOX_TTL_FINAL:
        return hit[1]
    key = f"{_MILB_CACHE_PREFIX}:pm:v{_METRICS_VERSION}:{game_pk}"
    cached = _l2_get(key)
    if cached is not None:
        # Redis JSON keys are strings; restore int keys for caller lookups.
        restored = {int(k): v for k, v in cached.items()}
        _pm_cache[game_pk] = (now, restored)
        return restored
    if not allow_fetch:
        return {}
    feed = _fetch_feed(game_pk)
    if not feed:
        return {}
    metrics = _derive_pitch_metrics(feed)
    if metrics:
        _pm_cache[game_pk] = (now, metrics)
        _l2_set(key, {str(k): v for k, v in metrics.items()}, _BOX_TTL_FINAL)
    return metrics


def enrich_log_with_pitch_metrics(rows, pitcher_id, deadline=None, max_fetch=25):
    """Attach per-game pitch metrics to a pitcher's non-Statcast game-log rows.

    AAA rows are skipped — the Savant merge already gives them richer versions
    of these same columns, and overwriting would replace per-pitch-accurate
    values with feed-derived ones.

    Bounded by `max_fetch` and an optional deadline: a cold 20-game log would
    otherwise pull 20 live feeds (1-3 MB each) on one page load. Cached games
    are always used; uncached ones beyond the budget simply stay blank and get
    filled by the daily cron.
    """
    targets = [r for r in rows if r.get("level") not in ("AAA", "AFL") and r.get("game_pk")]
    if not targets:
        return rows
    fetched = 0
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {}
        for r in targets:
            over_budget = fetched >= max_fetch or (deadline is not None and time.time() >= deadline)
            futures[pool.submit(get_game_pitch_metrics, r["game_pk"], not over_budget)] = r
            fetched += 1
        for f in as_completed(futures):
            r = futures[f]
            try:
                m = (f.result() or {}).get(int(pitcher_id))
            except Exception:
                m = None
            if m:
                r.update(m)
    return rows


_DIRECTORY_TTL = 6 * 3600
_directory_cache = {}  # { season: (timestamp, rows) }


def get_all_milb_pitchers(season, deadline=None):
    """Every pitcher with a 2026 appearance at ANY level, for search.

    The Savant-derived directory only sees AAA + AFL (that is the whole pitch
    universe), so on its own it makes ~80% of the players in this app
    unsearchable even though they all have player pages. This sweeps every
    affiliate of every org via the per-team season endpoint — one request per
    affiliate, the same cached calls org pages already make.

    Returns rows shaped like build_pitchers_list_from_df's so the two lists
    merge cleanly: {pitcher_id, name, name_norm, teams, hand, pitches,
    last_date, levels, orgs}. `hand` and `last_date` are unavailable from
    season stats and come back None — the Savant list fills them in for AAA,
    and the client's ranking already tolerates nulls.
    """
    from season import strip_accents
    season = int(season)
    now = time.time()
    hit = _directory_cache.get(season)
    if hit and (now - hit[0]) < _DIRECTORY_TTL:
        return hit[1]
    cached = _l2_get_compressed(f"{_MILB_CACHE_PREFIX}:directory:{season}")
    if cached is not None:
        _directory_cache[season] = (now, cached)
        return cached

    from levels import affiliates_for_org, all_orgs
    affiliates = [m for org in all_orgs() for m in affiliates_for_org(org)]
    by_pitcher = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {
            pool.submit(get_team_season_pitchers, m["team_id"], m["level"], season): m
            for m in affiliates
        }
        for f in as_completed(futures):
            if deadline is not None and time.time() >= deadline:
                break
            meta = futures[f]
            try:
                rows = f.result() or []
            except Exception as e:
                print(f"[Directory] {meta['name']} failed: {e}")
                continue
            for r in rows:
                pid = r.get("pitcher_id")
                if pid is None:
                    continue
                pid = int(pid)
                entry = by_pitcher.get(pid)
                if entry is None:
                    entry = {
                        "pitcher_id": pid,
                        "name": r.get("pitcher") or "",
                        "name_norm": strip_accents((r.get("pitcher") or "").lower()),
                        "teams": [],
                        # hand/last_date are not in season stats — the Savant
                        # merge fills them for AAA. Omitted rather than stored
                        # as 4,481 nulls (~130 KB of dead payload).
                        "pitches": 0,
                        "levels": [],
                        "orgs": [],
                    }
                    by_pitcher[pid] = entry
                if r.get("team") and r["team"] not in entry["teams"]:
                    entry["teams"].append(r["team"])
                if r.get("level") and r["level"] not in entry["levels"]:
                    entry["levels"].append(r["level"])
                if r.get("org") and r["org"] not in entry["orgs"]:
                    entry["orgs"].append(r["org"])
                entry["pitches"] += int(r.get("pitches") or 0)

    result = sorted(by_pitcher.values(), key=lambda r: r["name"])
    if result:
        _directory_cache[season] = (now, result)
        _l2_set_compressed(f"{_MILB_CACHE_PREFIX}:directory:{season}", result, _DIRECTORY_TTL)
    return result


def current_level(pitcher_id, season):
    """The level of the pitcher's MOST RECENT game. Never consults rosters or
    active status, per spec — last game played is the whole rule."""
    log = get_multi_level_game_log(pitcher_id, season)
    return log[-1]["level"] if log else None
