"""The season ledger: fold-forward running accumulators with a high-water mark.

The data this app serves is an append-only ledger — a finished game day never
changes — but until now the cache treated it as a lookup table that had to be
repeatedly rebuilt: every org page folded ~140 days, "is the season ready?"
was asked against a marker set that could drift, and season keys embedded
today's date so they rolled daily and expired hourly.

This module maintains the season-to-date answer ONCE, and moves it forward one
day at a time:

    state = { asof: "2026-08-11",          <- the high-water mark
              results: {team: acc},        <- running pitcher-results accs
              pitch:   {team: acc},        <- running pitch-data accs
              dir:     acc }               <- running search-directory acc

Every day <= asof is folded in exactly once, in date order. The accumulators
are the same mergeable structures the per-day aggregation already uses (sums,
counts, running extremes — the algebra pinned by test_streaming_range_agg), so
advancing the ledger is one fold of yesterday, not a re-fold of the season.
Readers finalize a deep copy and layer TODAY's cached day frame on top, so
season answers are one Redis read + one small finalize instead of a 140-day
pass.

Why one blob, pickled: the accumulators use tuple keys, sets and numpy
scalars, which JSON can't round-trip; pickle can, exactly. It is written and
read only by this backend against a private Redis, so pickle's trust model is
fine. gzip+base64 keeps the whole state a few hundred KB — inside Upstash's
per-request cap, and small enough to load per cold request.

Self-healing by construction:
  - a killed advance loses at most the days since the last checkpoint save,
    and re-folds them from the per-day snapshots (Redis reads, not Savant);
  - a reclassification bumps the override version, which resets the ledger
    and rebuilds it over the next cron ticks;
  - any load/unpickle failure reads as "no ledger", and every caller falls
    back to the old fold/202 path — the ledger can only make things faster,
    never wronger.

Deliberately NOT handled: stat corrections to past days (accepted staleness
for this app), and custom date windows (the ledger serves only the canonical
season window; anything else takes the old path).
"""
import base64
import copy
import gzip
import pickle
import time
from datetime import timedelta

from season import SEASON_START, now_et
from redis_cache import redis_get, redis_set
from data import (
    CARD_SCHEMA_VERSION, get_override_version,
    _load_range_day, fetch_date, _previous_date,
    new_pitchers_list_accumulator, accumulate_pitchers_list, finalize_pitchers_list,
)
from aggregation import (
    new_results_accumulator, accumulate_pitcher_results, finalize_pitcher_results,
    new_pitch_data_accumulator, accumulate_pitch_data, finalize_pitch_data,
)

LEDGER_VERSION = 1

# Persist every N folded days during a long build. A crash re-folds at most
# this many days from snapshots; saving every day would push ~100 MB of writes
# through Upstash on the initial season build for no benefit.
_CHECKPOINT_EVERY = 10

# In-process cache so a warm instance doesn't unpickle a few hundred KB on
# every request. The state only changes when the daily advance runs, so a
# short TTL is purely about picking that up promptly.
_STATE_TTL = 300
_state_cache = {"ts": 0.0, "state": None}


def _key():
    # CARD_SCHEMA_VERSION is part of the key on purpose: a schema bump changes
    # what the aggregation code computes, so the running state must rebuild.
    return f"ledger:v{LEDGER_VERSION}:s{CARD_SCHEMA_VERSION}"


def _yesterday_et():
    return (now_et() - timedelta(days=1)).strftime("%Y-%m-%d")


def _next_date(date_str):
    from datetime import datetime
    return (datetime.strptime(date_str, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")


def _fresh_state():
    return {
        "asof": _previous_date(SEASON_START),
        "ov": get_override_version(),
        "results": {},
        "pitch": {},
        "dir": new_pitchers_list_accumulator(),
    }


def load_state(max_age=_STATE_TTL):
    now = time.time()
    if _state_cache["state"] is not None and (now - _state_cache["ts"]) < max_age:
        return _state_cache["state"]
    raw = redis_get(_key())
    if not isinstance(raw, str):
        return None
    try:
        state = pickle.loads(gzip.decompress(base64.b64decode(raw)))
    except Exception as e:
        print(f"[Ledger] load failed ({e}); treating as absent")
        return None
    _state_cache.update(ts=now, state=state)
    return state


def _save_state(state):
    blob = base64.b64encode(gzip.compress(pickle.dumps(state, protocol=4))).decode("ascii")
    redis_set(_key(), blob)
    _state_cache.update(ts=time.time(), state=state)
    return len(blob)


def _fold_day(state, day_df):
    if day_df is None or day_df.empty:
        return
    if "pitcher_team" in day_df.columns:
        for team, tdf in day_df.groupby("pitcher_team"):
            if tdf.empty:
                continue
            if team not in state["results"]:
                state["results"][team] = new_results_accumulator()
                state["pitch"][team] = new_pitch_data_accumulator()
            accumulate_pitcher_results(state["results"][team], tdf)
            accumulate_pitch_data(state["pitch"][team], tdf)
    accumulate_pitchers_list(state["dir"], day_df)


def advance_ledger(deadline=None):
    """Fold forward to yesterday. Bounded, resumable, idempotent per day.

    Runs inside the 5-minute materialize cron, so a fresh season builds over a
    few ticks and the steady state is one day per morning. Days are folded
    strictly in order and the mark only moves after the fold, so a day can
    never be folded twice — the property that keeps sums honest.
    """
    state = load_state(max_age=0)
    if state is None or state.get("ov") != get_override_version():
        if state is not None:
            print("[Ledger] override version changed; rebuilding from scratch")
        state = _fresh_state()

    target = _yesterday_et()
    folded = 0
    dirty = False
    failed_day = None

    while state["asof"] < target:
        if deadline is not None and time.time() >= deadline:
            break
        day = _next_date(state["asof"])
        df = _load_range_day(day)
        if df is None:
            # Not baked yet — fetch it directly (this also persists the
            # snapshot). If even that fails, stop: days must fold in order,
            # so skipping would corrupt every sum behind it.
            try:
                df = fetch_date(day)
            except Exception as e:
                print(f"[Ledger] cannot fold {day}: {e}")
                failed_day = day
                break
        _fold_day(state, df)
        state["asof"] = day
        folded += 1
        dirty = True
        if folded % _CHECKPOINT_EVERY == 0:
            _save_state(state)
            dirty = False

    if dirty:
        _save_state(state)
    return {"asof": state["asof"], "target": target,
            "caught_up": state["asof"] >= target,
            "days_folded": folded,
            **({"failed_day": failed_day} if failed_day else {})}


# ── Readers ──
#
# All of these answer None when the ledger isn't caught up to yesterday, and
# every caller treats None as "use the old path". A behind ledger must never
# serve a silently short stat line.

def _ready_state():
    state = load_state()
    if state is None or state["asof"] != _yesterday_et():
        return None
    return state


def _layer_today(acc, accumulate, today_df, team=None):
    """Finalize against a COPY with today's rows folded in. The stored state
    must never be mutated by a read — it is the season through yesterday."""
    acc = copy.deepcopy(acc)
    if today_df is not None and not today_df.empty:
        if team is not None and "pitcher_team" in today_df.columns:
            today_df = today_df[today_df["pitcher_team"] == team]
        if not today_df.empty:
            accumulate(acc, today_df)
    return acc


def team_season_rows(team, view, today_df=None):
    """Season-to-date rows for one team, or None if the ledger isn't ready."""
    state = _ready_state()
    if state is None:
        return None
    if view == "pitch-data":
        acc = state["pitch"].get(team) or new_pitch_data_accumulator()
        acc = _layer_today(acc, accumulate_pitch_data, today_df, team=team)
        return finalize_pitch_data(acc)
    acc = state["results"].get(team) or new_results_accumulator()
    acc = _layer_today(acc, accumulate_pitcher_results, today_df, team=team)
    return finalize_pitcher_results(acc)


def aaa_rows_for_teams(teams, today_df=None):
    """{team: season results rows} for an org page's AAA affiliates, or None."""
    state = _ready_state()
    if state is None:
        return None
    out = {}
    for team in teams:
        acc = state["results"].get(team)
        if acc is None:
            continue
        acc = _layer_today(acc, accumulate_pitcher_results, today_df, team=team)
        rows = finalize_pitcher_results(acc)
        if rows:
            out[team] = rows
    return out


def directory_rows(today_df=None):
    """The full season pitcher directory, or None if the ledger isn't ready."""
    state = _ready_state()
    if state is None:
        return None
    acc = _layer_today(state["dir"], accumulate_pitchers_list, today_df)
    return finalize_pitchers_list(acc)
