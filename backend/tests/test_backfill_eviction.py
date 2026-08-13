"""The season backfill must not rebuild the season frame in process memory.

fetch_date pins each past day's full pitch DataFrame in data._cache forever —
correct for request instances, which touch a handful of days, but the backfill
walks the WHOLE season from one long-lived cron instance, a couple of days per
5-minute tick. Without eviction the instance accumulates day frames tick after
tick until it holds the season frame in L1 and Vercel OOM-kills the cron.
This happened in production on the backfill's first day (500s at 09:35, 10:25,
10:55 UTC on 2026-08-13, each ending in "instance was killed because it ran
out of available memory").

Pinned here:
- _backfill_daily_slates evicts each warmed day's process-local entries
  (day frame + agg rows) while leaving the Redis copies untouched.
- the cursor is persisted after each completed day, so a killed or timed-out
  tick keeps the days it finished instead of redoing them.
"""
import time

import pandas as pd
import pytest

import data as D
import boxscore_levels as B
import app as A


DAYS_DESC = ["2026-04-05", "2026-04-04", "2026-04-03"]


@pytest.fixture
def harness(monkeypatch):
    state = {"redis": {}, "warmed": [], "evicted_at": {}}

    monkeypatch.setattr(A, "get_default_date", lambda: "2026-04-13")
    monkeypatch.setattr(A, "_season_start", lambda year: "2026-04-03")
    monkeypatch.setattr(A, "redis_get", lambda k: state["redis"].get(k))
    monkeypatch.setattr(A, "redis_set", lambda k, v, **kw: state["redis"].__setitem__(k, v))
    monkeypatch.setattr(A, "get_games", lambda day, code: [])

    # Simulate the real caching behavior: aggregating a day parks the frame in
    # data._cache and the rows in data._agg_cache (L1), like fetch_date /
    # set_agg_cache do in production.
    def _warm_statcast(day, game_pk, level=None, **kw):
        D._cache[day] = (time.time(), pd.DataFrame({"pitcher": [1, 2]}))
        state["warmed"].append((day, level))
        return [{"pitcher_id": 1}]

    monkeypatch.setattr(A, "aggregate_pitch_data", _warm_statcast)
    monkeypatch.setattr(A, "aggregate_pitcher_results", _warm_statcast)
    monkeypatch.setattr(A, "get_level_results", lambda day, code: [{"pitcher_id": 2}])
    monkeypatch.setattr(A, "get_agg_cache", lambda key: None)  # every day is cold

    def _set_agg(key, rows):
        D._agg_cache[key] = (time.time(), rows)
        state["redis"][f"agg:{key}"] = rows

    monkeypatch.setattr(A, "set_agg_cache", _set_agg)
    return state


def test_backfill_evicts_local_day_and_keeps_redis(harness):
    # Pre-seed the per-game L1 dicts the box path fills in production — raw
    # box payloads chief among them; the walk must clear them all.
    D._boxscore_cache[999001] = (time.time(), {"er": 1})
    B._box_cache[999001] = (time.time(), True, {"huge": "raw payload"})
    B._rows_cache[(999001, "AA", True)] = (time.time(), [{"pitcher_id": 3}])
    B._pm_cache[999001] = (time.time(), {3: {"csw": 30}})

    result = A._backfill_daily_slates(deadline=time.time() + 3600, max_cold_days=3)

    assert result["warmed_days"] == DAYS_DESC
    # Process-local caches hold NONE of the walked days...
    for day in DAYS_DESC:
        assert day not in D._cache
        assert not any(k.endswith(f"_{day}") for k in D._agg_cache)
    # ...the per-game L1 dicts are empty...
    assert not D._boxscore_cache
    assert not B._box_cache
    assert not B._rows_cache
    assert not B._pm_cache
    # ...while the Redis copies (the product of the warm) survive.
    assert any(k.startswith("agg:") for k in harness["redis"])


def test_cursor_persists_per_day_not_only_at_end(harness):
    cursor_key = f"backfill:cursor:s{A.CARD_SCHEMA_VERSION}m{A._METRICS_VERSION}"
    writes = []
    real_set = harness["redis"].__setitem__

    def _tracking_set(k, v, **kw):
        if k == cursor_key:
            writes.append(v)
        real_set(k, v)

    import app as A2
    A2.redis_set = _tracking_set  # monkeypatched attr already points at stub

    A._backfill_daily_slates(deadline=time.time() + 3600, max_cold_days=2)
    # One write after each completed day (plus the final summary write) — a
    # tick killed mid-walk keeps its finished days.
    assert len(writes) >= 2
    assert writes[0] == "2026-04-04"  # advanced past the first day immediately


def test_evict_local_day_is_l1_only():
    D._cache["2026-05-01"] = (time.time(), pd.DataFrame({"x": [1]}))
    D._agg_cache["daily_pitch_AAA_2026-05-01"] = (time.time(), [1])
    D._agg_cache["daily_results_AAA_s99_2026-05-02"] = (time.time(), [2])

    D.evict_local_day("2026-05-01")

    assert "2026-05-01" not in D._cache
    assert "daily_pitch_AAA_2026-05-01" not in D._agg_cache
    # A different day's entry is untouched.
    assert "daily_results_AAA_s99_2026-05-02" in D._agg_cache
    D._agg_cache.pop("daily_results_AAA_s99_2026-05-02", None)
