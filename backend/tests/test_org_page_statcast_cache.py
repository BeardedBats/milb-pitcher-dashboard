"""An org page must not cache an AAA block that failed to get Statcast columns.

/api/org-page always renders — the AAA Statcast columns are an optional
upgrade layered on top of the box-score rows, so a missing materialized range
degrades the page instead of breaking it. That is the right behaviour for the
RESPONSE and the wrong one for the CACHE: org payloads live for AGG_CACHE_TTL
(an hour), so a range gap lasting two minutes would otherwise pin box-score
columns onto the page for the rest of the hour.

The gap is not hypothetical. Snapshots written before RANGE_DAY_TTL was raised
still carry their original expiry, so days keep dropping out of the range and
being re-baked. Observed in production: two org pages fetched minutes apart
disagreed, one cached during a lapse and one after it.

Mirrors the degraded-payload rule /api/pitcher-card already applies.
"""
import pytest
from fastapi.testclient import TestClient

import app as app_module


@pytest.fixture
def client(monkeypatch):
    state = {"cached": {}, "queued": [], "complete": True, "folded": 0}

    monkeypatch.setattr(app_module, "get_agg_cache", lambda k: state["cached"].get(k))
    monkeypatch.setattr(app_module, "set_agg_cache",
                        lambda k, v: state["cached"].__setitem__(k, v))
    monkeypatch.setattr(app_module, "affiliates_for_org", lambda org: [
        {"level": "AAA", "team_id": 1, "abbrev": "WOR", "name": "Worcester Red Sox"},
        {"level": "AA", "team_id": 2, "abbrev": "POR", "name": "Portland Sea Dogs"},
    ])
    monkeypatch.setattr(app_module, "team_display_name",
                        lambda team_id=None, level=None: f"team{team_id} ({level})")
    monkeypatch.setattr(app_module, "get_team_season_pitchers",
                        lambda team_id, level, year: [
                            {"pitcher_id": 10 * team_id, "pitcher": f"P{team_id}", "ip": "10.0"}
                        ])
    monkeypatch.setattr(app_module, "tag_mlb_experience", lambda rows: rows)
    monkeypatch.setattr(app_module, "queue_range_materialization",
                        lambda s, e: state["queued"].append((s, e)))

    def _fold(start, end, fold):
        state["folded"] += 1
        return state["complete"]

    monkeypatch.setattr(app_module, "fold_range_materialized", _fold)
    # The upgrade path only runs when the fold reports completeness.
    monkeypatch.setattr(app_module, "finalize_pitcher_results",
                        lambda acc: [{"pitcher_id": 10, "pitcher": "P1", "csw_pct": 30.0}])

    return TestClient(app_module.app), state


def _get(client, org="BOS"):
    r = client.get(f"/api/org-page?org={org}")
    assert r.status_code == 200
    return r.json()


def test_complete_range_upgrades_aaa_and_caches(client):
    c, state = client
    body = _get(c)

    aaa = next(b for b in body["affiliates"] if b["level"] == "AAA")
    assert aaa["statcast"] is True
    assert state["cached"], "a complete payload should be cached"
    assert state["queued"] == [], "nothing to re-queue when the range is whole"


def test_incomplete_range_still_renders_but_is_not_cached(client):
    """THE regression: an hour of box-score columns from a two-minute gap."""
    c, state = client
    state["complete"] = False

    body = _get(c)

    aaa = next(b for b in body["affiliates"] if b["level"] == "AAA")
    assert aaa["statcast"] is False, "must still render, just without the upgrade"
    assert aaa["rows"], "box-score rows are the fallback, not an empty page"
    assert state["cached"] == {}, "degraded payload was cached and will persist"


def test_incomplete_range_requeues_the_materialization(client):
    """The 5-minute cron only drains a queue; the job that fills it runs once
    at 07:40. Without this a mid-day lapse waits until tomorrow."""
    c, state = client
    state["complete"] = False

    _get(c)

    assert len(state["queued"]) == 1, "expected exactly one re-queue"
    start, end = state["queued"][0]
    assert start == app_module.SEASON_START
    assert end >= start, "end_date should resolve forward to today"


def test_recovery_caches_once_the_range_returns(client):
    """A gap must not poison later requests: the next complete build caches."""
    c, state = client
    state["complete"] = False
    _get(c)
    assert state["cached"] == {}

    state["complete"] = True
    body = _get(c)

    aaa = next(b for b in body["affiliates"] if b["level"] == "AAA")
    assert aaa["statcast"] is True
    assert state["cached"], "recovered payload should cache normally"


def test_org_with_no_aaa_affiliate_still_caches(client, monkeypatch):
    """Nothing to upgrade means nothing to wait for — an all-box-score org
    must not be permanently uncacheable."""
    c, state = client
    monkeypatch.setattr(app_module, "affiliates_for_org", lambda org: [
        {"level": "AA", "team_id": 2, "abbrev": "POR", "name": "Portland Sea Dogs"},
    ])
    state["complete"] = False

    body = _get(c)

    assert all(b["statcast"] is False for b in body["affiliates"])
    assert state["cached"], "no AAA block, so the payload is final and cacheable"
    assert state["queued"] == [], "no AAA block means no range dependency"
