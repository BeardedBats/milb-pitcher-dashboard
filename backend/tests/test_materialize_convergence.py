"""A materialization job must never be declared finished on a range with holes.

The marker set (missing_range_days) is a cheap approximation that errs in both
directions. Over-reporting a day as baked is the dangerous one, and it is not
hypothetical: per-day snapshots expire individually on RANGE_DAY_TTL (60 days)
while the set's TTL is pushed forward by every new sadd, so on a season longer
than the TTL the set keeps naming days whose snapshots are gone.

Believing it in drain_pending_materializations is unrecoverable rather than
merely slow: the job is marked ready and dropped from the queue while the range
is still incomplete, nothing re-queues it until the next daily warmup, and that
re-queue is dequeued the same way the next tick. The range never completes, the
5-minute cron does nothing forever, and every range-backed feature silently
degrades — /api/org-page just stops upgrading AAA to Statcast columns.
"""
import pandas as pd
import pytest

import data as D

START, END = "2026-04-01", "2026-04-05"
DAYS = ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05"]


@pytest.fixture
def redis_stub(monkeypatch):
    """Simulated Redis: `present` is the set of day keys that really exist,
    `markers` is what the (possibly stale) marker set claims."""
    state = {
        "present": set(DAYS),
        "markers": set(DAYS),
        "sets": {},
        "pending": {f"{START}:{END}"},
        "baked_calls": [],
        "exists_calls": [],
        "unreachable": False,
    }

    def _exists(key):
        state["exists_calls"].append(key)
        if state["unreachable"]:
            return None
        return any(key == D._range_day_key(d) for d in state["present"])

    def _smembers(key):
        if key == D.MATERIALIZE_PENDING_KEY:
            return set(state["pending"])
        if key == D._baked_days_key():
            return set(state["markers"])
        return set()

    def _fetch_date(day):
        state["baked_calls"].append(day)
        state["present"].add(day)       # a real bake persists the snapshot
        state["markers"].add(day)
        return pd.DataFrame({"pitcher": [1]})

    monkeypatch.setattr(D, "redis_exists", _exists)
    monkeypatch.setattr(D, "redis_smembers", _smembers)
    monkeypatch.setattr(D, "redis_set", lambda k, v, **kw: state["sets"].__setitem__(k, v))
    monkeypatch.setattr(D, "redis_srem", lambda k, *v: state["pending"].discard(*v))
    monkeypatch.setattr(D, "fetch_date", _fetch_date)
    monkeypatch.setattr(D, "_is_today", lambda d: False)
    return state


def _status(state):
    return state["sets"].get(D._materialize_status_key(START, END), {}).get("status")


# ── unbaked_range_days ──

def test_reports_only_days_redis_says_are_gone(redis_stub):
    redis_stub["present"] = {"2026-04-01", "2026-04-04"}
    assert D.unbaked_range_days(START, END) == ["2026-04-02", "2026-04-03", "2026-04-05"]


def test_uses_exists_not_get(redis_stub, monkeypatch):
    """Presence probes must not drag multi-MB payloads across the wire."""
    called = []
    monkeypatch.setattr(D, "redis_get", lambda k: called.append(k))
    D.unbaked_range_days(START, END)
    assert called == []
    assert redis_stub["exists_calls"], "expected EXISTS probes"


def test_limit_stops_early(redis_stub):
    redis_stub["present"] = set()
    assert D.unbaked_range_days(START, END, limit=1) == [DAYS[0]]
    assert len(redis_stub["exists_calls"]) == 1


def test_unreachable_redis_reports_nothing_missing(redis_stub):
    """A connection blip must not read as 'the whole season is gone' and
    trigger a full re-bake."""
    redis_stub["unreachable"] = True
    assert D.unbaked_range_days(START, END) == []


def test_today_is_never_missing(redis_stub, monkeypatch):
    redis_stub["present"] = set(DAYS) - {DAYS[-1]}
    monkeypatch.setattr(D, "_is_today", lambda d: d == DAYS[-1])
    assert D.unbaked_range_days(START, END) == []


# ── the drain must confirm before declaring victory ──

def test_stale_markers_trigger_a_rebake_instead_of_closing(redis_stub):
    """THE regression: markers claim every day is baked, but the early
    snapshots have expired. Before the fix this closed the job having baked
    nothing, leaving the range permanently holed."""
    redis_stub["present"] = {"2026-04-04", "2026-04-05"}   # 3 oldest expired
    redis_stub["markers"] = set(DAYS)                       # set still claims all

    D.drain_pending_materializations()

    assert redis_stub["baked_calls"] == ["2026-04-01", "2026-04-02", "2026-04-03"], \
        "expired days must be re-baked, not declared done"
    # Only 3 days were missing and a tick bakes up to 12, so the range really
    # is whole afterwards — closing here is correct.
    assert _status(redis_stub) == "ready"
    assert D.unbaked_range_days(START, END) == []


def test_job_stays_queued_while_days_remain(redis_stub, monkeypatch):
    """More holes than one tick can bake: the job must survive to the next."""
    monkeypatch.setattr(D, "MATERIALIZE_DAYS_PER_RUN", 2)
    redis_stub["present"] = set()
    redis_stub["markers"] = set(DAYS)                       # fully stale set

    out = D.drain_pending_materializations()

    assert _status(redis_stub) == "running", "job was closed on an incomplete range"
    assert f"{START}:{END}" in redis_stub["pending"], "job must stay queued"
    assert redis_stub["baked_calls"] == DAYS[:2]
    assert out[0]["status"] == "running"


def test_job_closes_when_the_range_really_is_complete(redis_stub):
    out = D.drain_pending_materializations()
    assert _status(redis_stub) == "ready"
    assert redis_stub["pending"] == set()
    assert redis_stub["baked_calls"] == []
    assert out[0]["days_left"] == 0


def test_bake_that_persists_nothing_keeps_the_job_open(redis_stub, monkeypatch):
    """Arithmetic (len(missing) - baked) assumes a non-raising fetch_date also
    persisted. When it doesn't, the job must not close on the hole."""
    redis_stub["markers"] = {"2026-04-05"}

    def _silent_noop(day):
        redis_stub["baked_calls"].append(day)
        redis_stub["markers"].add(day)      # marker written, snapshot is not
        return pd.DataFrame()

    monkeypatch.setattr(D, "fetch_date", _silent_noop)
    redis_stub["present"] = {"2026-04-05"}

    D.drain_pending_materializations()

    assert _status(redis_stub) == "running"
    assert f"{START}:{END}" in redis_stub["pending"]


def test_convergence_over_repeated_ticks(redis_stub, monkeypatch):
    """What the 5-minute cron actually does: a bounded slice per tick until the
    range is whole, then exactly one close."""
    monkeypatch.setattr(D, "MATERIALIZE_DAYS_PER_RUN", 2)
    redis_stub["present"] = set()
    redis_stub["markers"] = set()

    for _ in range(10):
        D.drain_pending_materializations()
        if not redis_stub["pending"]:
            break

    assert _status(redis_stub) == "ready"
    assert redis_stub["pending"] == set()
    assert sorted(set(redis_stub["baked_calls"])) == DAYS
