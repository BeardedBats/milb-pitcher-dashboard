"""The warm crons must honour the priority order they claim to.

Every one of these jobs is budget-bounded, so "what gets warmed" is decided by
ORDER, not by intent. A warm loop that iterates an unordered set spends the
budget on whoever happens to sort first, which is how the player-page warm
came to prioritise low pitcher ids.

Also pins the signature bug that made warmup-daily-players return 500 every
morning: it passed deadline= to a helper that had no such parameter, and the
TypeError was swallowed by the endpoint's broad except. Nothing warmed player
pages at all for as long as that shipped.
"""
import inspect
import time

import pytest

import app as app_module


# ── the crash ──

def test_player_warm_helper_accepts_the_deadline_the_cron_passes():
    """The cron calls it with deadline=; the helper must take it. This raised
    TypeError -> 500 in production."""
    params = inspect.signature(app_module._warm_player_page_cache_for_pitchers).parameters
    assert "deadline" in params


def test_player_warm_helper_returns_a_mapping():
    """The cron splats the result with **stats. A tuple would raise."""
    out = app_module._warm_player_page_cache_for_pitchers(
        [], "2026-03-25", "2026-08-12", deadline=time.time() - 1,
    )
    assert isinstance(out, dict)
    assert {**out} == out


def test_the_exact_production_call_shape_works(monkeypatch):
    monkeypatch.setattr(app_module, "_build_player_page_payload",
                        lambda pid, s, e, preloaded_df=None: {"pid": pid})
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: None)
    out = app_module._warm_player_page_cache_for_pitchers(
        [1, 2], "2026-03-25", "2026-08-12", deadline=time.time() + 30,
    )
    assert out["warmed"] == 2
    assert {"status": "ok", **out}["status"] == "ok"


# ── priority: order is preserved, and the budget cuts the TAIL ──

@pytest.fixture
def warm_spy(monkeypatch):
    seen = []
    monkeypatch.setattr(app_module, "_build_player_page_payload",
                        lambda pid, s, e, preloaded_df=None: seen.append(pid) or {"pid": pid})
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: None)
    return seen


def test_warm_order_follows_the_caller_not_the_pitcher_id(warm_spy):
    """It used to sort(), which is random with respect to level and role."""
    app_module._warm_player_page_cache_for_pitchers(
        [900, 100, 500], "2026-03-25", "2026-08-12", deadline=time.time() + 30,
    )
    assert warm_spy == [900, 100, 500]


def test_duplicates_are_warmed_once_keeping_the_earliest_position(warm_spy):
    """A pitcher can be both a probable starter and in yesterday's results;
    the high-priority position must win and the work must not be repeated."""
    app_module._warm_player_page_cache_for_pitchers(
        [7, 8, 7, 9], "2026-03-25", "2026-08-12", deadline=time.time() + 30,
    )
    assert warm_spy == [7, 8, 9]


def test_budget_cut_drops_the_tail_not_the_head(monkeypatch):
    seen = []

    def _slow(pid, s, e, preloaded_df=None):
        seen.append(pid)
        return {"pid": pid}

    monkeypatch.setattr(app_module, "_build_player_page_payload", _slow)
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: None)

    # A deadline already in the past stops before the first pitcher; the point
    # is that the loop CHECKS, which the pre-fix helper never did.
    out = app_module._warm_player_page_cache_for_pitchers(
        [1, 2, 3], "2026-03-25", "2026-08-12", deadline=time.time() - 1,
    )
    assert seen == []
    assert out["budget_hit"] is True
    assert out["requested"] == 3


def test_no_deadline_warms_everything(warm_spy):
    """Callers without a budget must keep the old behaviour."""
    app_module._warm_player_page_cache_for_pitchers(
        [1, 2, 3], "2026-03-25", "2026-08-12",
    )
    assert warm_spy == [1, 2, 3]


# ── org payloads: one fold serves every org ──

def test_org_build_uses_supplied_rows_instead_of_folding(monkeypatch):
    """Warming 30 orgs must not mean 30 full-season passes."""
    folds = []
    monkeypatch.setattr(app_module, "fold_range_materialized",
                        lambda s, e, f: folds.append(1) or True)
    monkeypatch.setattr(app_module, "affiliates_for_org", lambda org: [
        {"level": "AAA", "team_id": 1, "abbrev": "WOR", "name": "Worcester"},
    ])
    monkeypatch.setattr(app_module, "team_display_name",
                        lambda team_id=None, level=None: "Worcester")
    monkeypatch.setattr(app_module, "get_team_season_pitchers",
                        lambda t, l, y: [{"pitcher_id": 1, "pitcher": "P"}])
    monkeypatch.setattr(app_module, "tag_mlb_experience", lambda rows: rows)

    payload, pending = app_module._build_org_page_payload(
        "BOS", "2026-03-25", "2026-08-12",
        aaa_rows_by_team={"WOR": [{"pitcher_id": 1, "csw_pct": 30.0}]},
    )

    assert folds == [], "supplied rows must short-circuit the range fold"
    assert pending is False
    aaa = payload["affiliates"][0]
    assert aaa["statcast"] is True and aaa["rows"][0]["csw_pct"] == 30.0


def test_org_build_still_folds_when_no_rows_are_supplied(monkeypatch):
    """The request path has nothing precomputed and must behave as before."""
    folds = []
    monkeypatch.setattr(app_module, "fold_range_materialized",
                        lambda s, e, f: folds.append(1) or False)
    monkeypatch.setattr(app_module, "queue_range_materialization", lambda s, e: None)
    monkeypatch.setattr(app_module, "affiliates_for_org", lambda org: [
        {"level": "AAA", "team_id": 1, "abbrev": "WOR", "name": "Worcester"},
    ])
    monkeypatch.setattr(app_module, "team_display_name",
                        lambda team_id=None, level=None: "Worcester")
    monkeypatch.setattr(app_module, "get_team_season_pitchers",
                        lambda t, l, y: [{"pitcher_id": 1, "pitcher": "P"}])
    monkeypatch.setattr(app_module, "tag_mlb_experience", lambda rows: rows)

    _, pending = app_module._build_org_page_payload("BOS", "2026-03-25", "2026-08-12")

    assert folds == [1]
    assert pending is True, "an incomplete range must still mark the page degraded"
