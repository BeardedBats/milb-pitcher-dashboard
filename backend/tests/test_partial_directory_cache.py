"""A cold instance must not refold the season to rebuild the same directory.

On serverless the background rebuild is disabled (a frozen thread resumes
inside a later invocation and allocates against it), so the cold-miss path is
all there is. It serves the best-effort partial list, and without caching that,
every cold instance repeats an identical ~140-day fold and leaves nothing
behind for the next one.

The partial is cached under the ordinary short-TTL key ONLY. The never-expiring
pitcher_dir: key is the canonical snapshot and must never be given an
incomplete list, or a season's worth of cold starts would serve a truncated
roster forever.
"""
import pandas as pd
import pytest

import data as D

START, END = "2026-04-01", "2026-04-03"
DAYS = ["2026-04-01", "2026-04-02", "2026-04-03"]


def _day(date_str, pitchers):
    return pd.DataFrame({
        "game_date": date_str,
        "game_pk": 1,
        "pitcher": pitchers,
        "player_name": [f"P{p}" for p in pitchers],
        "p_throws": "R",
        "pitcher_team": "ROC",
    })


@pytest.fixture
def stub(monkeypatch):
    state = {"present": {}, "sets": {}, "gets": {}, "folds": 0}

    def _load_day(d):
        day = state["present"].get(d)
        if day is not None:
            state["folds"] += 1
        return day

    monkeypatch.setattr(D, "_load_range_day", _load_day)
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: [
        d for d in D._date_strings(s, e) if d not in state["present"]
    ])
    monkeypatch.setattr(D, "_is_today", lambda d: False)
    monkeypatch.setattr(D, "_merge_daily_cache_for_day", lambda day, d: day)
    monkeypatch.setattr(D, "_pitchers_list_cache", {})
    monkeypatch.setattr(D, "_index_cache_key", lambda *a, **k: None)
    monkeypatch.setattr(D, "_background_build_pitcher_directory", lambda *a: None)
    monkeypatch.setattr(D, "redis_get", lambda k: state["gets"].get(k))
    monkeypatch.setattr(D, "redis_set",
                        lambda k, v, ttl=None: state["sets"].__setitem__(k, (v, ttl)))
    return state


def test_cold_miss_caches_the_partial_for_the_next_instance(stub):
    stub["present"] = {DAYS[0]: _day(DAYS[0], [1, 2])}

    rows = D.fetch_pitchers_directory(START, END)

    assert rows, "cold miss must still serve a list"
    key = D._pitchers_list_key(START, END)
    assert key in stub["sets"], "partial was not cached; every cold start refolds"
    cached, ttl = stub["sets"][key]
    assert cached == rows
    assert ttl == D.PARTIAL_DIR_TTL, "partial must expire, not linger as canonical"


def test_partial_never_touches_the_never_expiring_key(stub):
    """pitcher_dir: is the canonical snapshot and never expires. An incomplete
    list written there would outlive the gap that produced it."""
    stub["present"] = {DAYS[0]: _day(DAYS[0], [1])}

    D.fetch_pitchers_directory(START, END)

    assert D._pitcher_dir_key(START, END) not in stub["sets"]


def test_a_second_instance_reads_the_cache_instead_of_refolding(stub):
    stub["present"] = {d: _day(d, [1, 2]) for d in DAYS}

    first = D.fetch_pitchers_directory(START, END)
    folds_after_first = stub["folds"]
    assert folds_after_first > 0

    # Simulate a fresh instance: process-local cache empty, Redis retained.
    D._pitchers_list_cache.clear()
    key = D._pitchers_list_key(START, END)
    stub["gets"][key] = stub["sets"][key][0]

    second = D.fetch_pitchers_directory(START, END)

    assert second == first
    assert stub["folds"] == folds_after_first, "second instance refolded the range"


def test_nothing_is_cached_when_no_days_are_baked(stub):
    """An empty partial must not be written — it would mask a real directory
    for the whole TTL."""
    stub["present"] = {}

    assert D.fetch_pitchers_directory(START, END) == []
    assert stub["sets"] == {}


def test_warm_partial_helper_builds_and_persists(stub):
    """What warmup-daily falls back to when the strict build cannot run."""
    stub["present"] = {d: _day(d, [7]) for d in DAYS}

    rows = D.warm_partial_pitcher_directory(START, END)

    assert len(rows) == 1 and rows[0]["pitcher_id"] == 7
    cached, ttl = stub["sets"][D._pitchers_list_key(START, END)]
    assert cached == rows and ttl == D.PARTIAL_DIR_TTL
