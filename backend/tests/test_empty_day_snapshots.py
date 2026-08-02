"""Regression tests for the empty-day cache-poisoning fix.

A transient Savant/MLB failure must never be persisted as a materialized
"this day had no games" snapshot (60-day TTL) — that silently deletes the
day from every season aggregate until the TTL expires.
"""
import pandas as pd
import pytest

import data


@pytest.fixture
def past_date_no_mlb(monkeypatch):
    monkeypatch.setattr(data, "_fetch_missing_from_mlb_api", lambda d, pks, levels=None: pd.DataFrame())
    monkeypatch.setattr(data, "_is_today", lambda d: False)


def _track_persists(monkeypatch):
    calls = []
    monkeypatch.setattr(data, "_persist_range_day_snapshot", lambda d, df: calls.append(d))
    return calls


def test_fetch_from_savant_returns_none_on_failure(monkeypatch):
    def boom(*args, **kwargs):
        raise data.requests.ConnectionError("savant down")

    monkeypatch.setattr(data.requests, "get", boom)
    assert data._fetch_from_savant("2026-04-15") is None


def test_savant_failure_is_not_cached_or_persisted(monkeypatch, past_date_no_mlb):
    calls = _track_persists(monkeypatch)
    monkeypatch.setattr(data, "_fetch_from_savant", lambda d: None)
    data._cache.pop("2026-04-15", None)

    out = data.fetch_date("2026-04-15")

    assert out.empty
    assert calls == []  # no empty 60-day snapshot
    assert "2026-04-15" not in data._cache  # next request retries


def test_confirmed_gameless_day_persists_empty_snapshot(monkeypatch, past_date_no_mlb):
    calls = _track_persists(monkeypatch)
    monkeypatch.setattr(data, "_fetch_from_savant", lambda d: pd.DataFrame())
    monkeypatch.setattr(data, "_get_mlb_schedule", lambda d, force_refresh=False, level=None: [])
    data._cache.pop("2026-04-16", None)

    out = data.fetch_date("2026-04-16")

    assert out.empty
    assert calls == ["2026-04-16"]
    data._cache.pop("2026-04-16", None)


def test_scheduled_day_with_no_pitches_is_not_persisted(monkeypatch, past_date_no_mlb):
    # Savant answered "no rows" but the schedule lists games (data gap,
    # postponement not yet resolved, ...) -> suspicious, don't bake a snapshot.
    calls = _track_persists(monkeypatch)
    monkeypatch.setattr(data, "_fetch_from_savant", lambda d: pd.DataFrame())
    monkeypatch.setattr(
        data, "_get_mlb_schedule", lambda d, force_refresh=False, level=None: [{"game_pk": 1}]
    )
    data._cache.pop("2026-04-17", None)

    out = data.fetch_date("2026-04-17")

    assert out.empty
    assert calls == []
    data._cache.pop("2026-04-17", None)


def test_schedule_failure_means_unknown_not_gameless(monkeypatch):
    monkeypatch.setattr(data, "_get_mlb_schedule", lambda d, force_refresh=False, level=None: None)
    assert data._day_confirmed_gameless("2026-04-18") is False


def test_incomplete_range_fetch_skips_empty_backfill(monkeypatch):
    calls = _track_persists(monkeypatch)
    monkeypatch.setattr(data, "_get_mlb_schedule", lambda d, force_refresh=False, level=None: [])

    # Range fetch failed partway -> fill_missing=False -> no empty snapshots
    data._persist_range_day_snapshots(pd.DataFrame(), "2026-04-01", "2026-04-03", fill_missing=False)
    assert calls == []

    # Complete fetch + schedule-confirmed gameless days -> backfill allowed
    data._persist_range_day_snapshots(pd.DataFrame(), "2026-04-01", "2026-04-03", fill_missing=True)
    assert calls == ["2026-04-01", "2026-04-02", "2026-04-03"]
