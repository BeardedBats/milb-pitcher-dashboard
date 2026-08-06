"""fold_range_materialized must match fetch_date_range_materialized's day set.

It is the memory-safe replacement for that function on the two endpoints that
were rebuilding a season-wide frame. Same days, same daily-cache merge, same
"not materialized -> caller 202s" contract — the only difference is that the
season never exists as one object.
"""
import pandas as pd
import pytest

import data as D


def _day(date_str, pks=(1, 2)):
    return pd.DataFrame({
        "game_date": [date_str] * len(pks),
        "game_pk": list(pks),
        "pitcher": [101] * len(pks),
    })


@pytest.fixture
def stub(monkeypatch):
    state = {"present": {}, "today": None, "live": None, "cache": {}}

    monkeypatch.setattr(D, "_load_range_day", lambda d: state["present"].get(d))
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: [
        d for d in D._date_strings(s, e) if d not in state["present"]
    ])
    monkeypatch.setattr(D, "_is_today", lambda d: d == state["today"])
    monkeypatch.setattr(D, "fetch_date", lambda d: state["live"])
    monkeypatch.setattr(D, "_cache", state["cache"])
    return state


def _collect(start, end):
    seen = []
    complete = D.fold_range_materialized(start, end, seen.append)
    return complete, seen


def test_complete_range_folds_every_day_in_order(stub):
    days = ["2026-04-01", "2026-04-02", "2026-04-03"]
    stub["present"] = {d: _day(d) for d in days}

    complete, seen = _collect("2026-04-01", "2026-04-03")

    assert complete is True
    assert [f["game_date"].iloc[0] for f in seen] == days


def test_missing_day_reports_incomplete(stub):
    stub["present"] = {"2026-04-01": _day("2026-04-01")}

    complete, seen = _collect("2026-04-01", "2026-04-03")

    assert complete is False


def test_gameless_days_are_skipped_not_treated_as_missing(stub):
    stub["present"] = {
        "2026-04-01": _day("2026-04-01"),
        "2026-04-02": pd.DataFrame(),      # baked, no games
        "2026-04-03": _day("2026-04-03"),
    }

    complete, seen = _collect("2026-04-01", "2026-04-03")

    assert complete is True
    assert len(seen) == 2


def test_today_comes_from_the_live_fetch_not_a_snapshot(stub):
    stub["present"] = {"2026-04-01": _day("2026-04-01")}
    stub["today"] = "2026-04-02"
    stub["live"] = _day("2026-04-02", pks=(9,))

    complete, seen = _collect("2026-04-01", "2026-04-02")

    assert complete is True
    assert [f["game_date"].iloc[0] for f in seen] == ["2026-04-01", "2026-04-02"]


def test_range_of_only_today_needs_no_snapshots(stub):
    stub["today"] = "2026-04-02"
    stub["live"] = _day("2026-04-02")

    complete, seen = _collect("2026-04-02", "2026-04-02")

    assert complete is True
    assert len(seen) == 1


def test_daily_cache_backfills_games_absent_from_the_snapshot(stub):
    """_merge_daily_cache_for_day is the per-day form of _merge_daily_cache:
    games the MLB API had but Savant lacked still have to reach the caller."""
    stub["present"] = {"2026-04-01": _day("2026-04-01", pks=(1, 2))}
    stub["cache"]["2026-04-01"] = (0, _day("2026-04-01", pks=(2, 3)))

    complete, seen = _collect("2026-04-01", "2026-04-01")

    assert complete is True
    assert sorted(seen[0]["game_pk"]) == [1, 2, 3]   # 3 backfilled, 2 not duplicated


def test_stale_marker_does_not_abort_a_materialized_range(stub, monkeypatch):
    """Same under-reporting hazard as _load_persisted_range: a day baked before
    the membership marker existed has a snapshot but no marker."""
    days = ["2026-04-01", "2026-04-02"]
    stub["present"] = {d: _day(d) for d in days}
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: days)   # stale

    complete, seen = _collect("2026-04-01", "2026-04-02")

    assert complete is True
    assert len(seen) == 2
