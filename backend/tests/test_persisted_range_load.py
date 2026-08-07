"""_load_persisted_range must not pay for a whole season to say "not ready".

It used to pool.map over every date, materialise all ~110 day frames, and only
then look for a missing one — returning None and discarding the lot. That path
is not rare: _loading_response -> queue_range_materialization ->
fetch_date_range_materialized -> here, so it ran on EVERY 202 while the season
baked.
"""
import pandas as pd
import pytest

import data as D


def _day_frame(date_str, rows=3):
    return pd.DataFrame({
        "game_date": [date_str] * rows,
        "game_pk": list(range(rows)),
        "pitcher": [100] * rows,
    })


@pytest.fixture
def loads(monkeypatch):
    """Track which days actually got read out of Redis."""
    seen = []

    def fake_load(date_str):
        seen.append(date_str)
        return _day_frame(date_str) if date_str in fake_load.present else None

    fake_load.present = set()
    monkeypatch.setattr(D, "_load_range_day", fake_load)
    return fake_load, seen


def test_incomplete_range_returns_none_without_loading_everything(monkeypatch, loads):
    fake_load, seen = loads
    days = [f"2026-04-{d:02d}" for d in range(1, 21)]
    fake_load.present = set(days[:10])          # second half never baked
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: days[10:])

    assert D._load_persisted_range("2026-04-01", "2026-04-20") is None
    # The marker said incomplete and one probe GET confirmed it. The old code
    # read all 20 days before reaching the same conclusion.
    assert len(seen) == 1, f"expected a single probe read, got {seen}"


def test_stale_marker_does_not_hide_a_materialized_range(monkeypatch, loads):
    """The membership set can under-report — days baked before the marker
    existed have a snapshot but no marker. A "missing" verdict must be
    confirmed against real data, never trusted outright."""
    fake_load, seen = loads
    days = [f"2026-04-{d:02d}" for d in range(1, 6)]
    fake_load.present = set(days)               # every day IS actually present
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: days[:2])  # stale

    out = D._load_persisted_range("2026-04-01", "2026-04-05")

    assert out is not None, "a stale marker must not fake an unmaterialized range"
    assert len(out) == 15                        # 5 days x 3 rows
    assert sorted(out["game_date"].unique()) == days


def test_complete_range_concatenates_in_date_order(monkeypatch, loads):
    fake_load, seen = loads
    days = [f"2026-04-{d:02d}" for d in range(1, 6)]
    fake_load.present = set(days)
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: [])

    out = D._load_persisted_range("2026-04-01", "2026-04-05")

    assert list(out["game_date"]) == [d for d in days for _ in range(3)]


def test_gameless_days_are_materialized_not_missing(monkeypatch):
    """An empty frame means "baked, no games" — it must not read as missing."""
    def fake_load(date_str):
        return pd.DataFrame() if date_str == "2026-04-03" else _day_frame(date_str)

    monkeypatch.setattr(D, "_load_range_day", fake_load)
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: [])

    out = D._load_persisted_range("2026-04-01", "2026-04-05")

    assert out is not None
    assert len(out) == 12                        # 4 days with games x 3 rows
    assert "2026-04-03" not in set(out["game_date"])


def test_missing_day_with_no_marker_help_still_returns_none(monkeypatch, loads):
    """If the marker set is unavailable (empty), correctness still comes from
    the real reads — an absent day must yield None, not a short range."""
    fake_load, seen = loads
    days = [f"2026-04-{d:02d}" for d in range(1, 6)]
    fake_load.present = set(days) - {"2026-04-04"}
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: [])

    assert D._load_persisted_range("2026-04-01", "2026-04-05") is None
