"""The daily leaderboard's "All Levels" filter.

ALL is a pseudo-level: it has no sportId and is deliberately absent from
LEVELS. That makes normalize_level() actively dangerous here — it coerces
anything it does not recognise to AAA, so an endpoint that normalizes before
checking answers an all-levels request with Triple-A only, and does it
silently. These pin the guard order, and pin that the fan-out reads the SAME
per-level daily cache the single-level pages write (a second key would double
the work and let the two views disagree).
"""
import pytest
from fastapi.testclient import TestClient

import app as app_module
import levels


@pytest.fixture
def client():
    return TestClient(app_module.app)


# ── the pseudo-level itself ──

def test_all_is_not_a_real_level():
    assert levels.ALL_LEVELS not in levels.LEVELS
    assert levels.ALL_LEVELS not in levels.LEVEL_ORDER


def test_is_all_levels_accepts_what_a_query_string_can_carry():
    for value in ("ALL", "all", " All ", "all-levels", "All Levels"):
        assert levels.is_all_levels(value), value


def test_is_all_levels_rejects_real_levels_and_junk():
    for value in ["", None, "AAA", "AA", "A+", "R", "AFL", "11", "banana"]:
        assert not levels.is_all_levels(value), value


def test_normalize_level_still_coerces_all_to_aaa():
    """Pinning the trap, not endorsing it: normalize_level has no concept of
    ALL, which is exactly why every handler must ask is_all_levels FIRST."""
    assert levels.normalize_level("ALL") == "AAA"
    assert levels.is_statcast_level("ALL") is True


# ── the fan-out ──

def _stub_levels(monkeypatch, rows_by_level):
    seen = []

    def _fake(date_str, level, games=None):
        seen.append(level)
        return rows_by_level.get(level, [])

    monkeypatch.setattr(app_module, "get_level_results", _fake)
    monkeypatch.setattr(app_module, "get_agg_cache", lambda k: None)
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: None)
    monkeypatch.setattr(app_module, "_evict_box_transients", lambda: None)
    return seen


def _row(level, team, order=1, **kw):
    row = {"level": level, "team": team, "appearance_order": order,
           "pitcher_id": order, "game_pk": 1}
    row.update(kw)
    return row


def test_every_level_is_folded_in(monkeypatch):
    seen = _stub_levels(monkeypatch, {c: [_row(c, "X")] for c in levels.LEVEL_ORDER})
    rows = app_module._all_levels_results("2026-08-12")
    assert seen == levels.LEVEL_ORDER
    assert sorted(r["level"] for r in rows) == sorted(levels.LEVEL_ORDER)


def test_rows_come_back_highest_level_first(monkeypatch):
    _stub_levels(monkeypatch, {
        "A": [_row("A", "COL")],
        "AAA": [_row("AAA", "WOR", 2), _row("AAA", "WOR", 1)],
        "AA": [_row("AA", "POR")],
    })
    rows = app_module._all_levels_results("2026-08-12")
    assert [r["level"] for r in rows] == ["AAA", "AAA", "AA", "A"]
    # Within a level: team, then order of appearance.
    assert [r["appearance_order"] for r in rows[:2]] == [1, 2]


def test_one_dead_level_does_not_blank_the_others(monkeypatch):
    def _fake(date_str, level, games=None):
        if level == "AA":
            raise RuntimeError("statsapi 503")
        return [_row(level, "X")]

    monkeypatch.setattr(app_module, "get_level_results", _fake)
    monkeypatch.setattr(app_module, "get_agg_cache", lambda k: None)
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: None)
    monkeypatch.setattr(app_module, "_evict_box_transients", lambda: None)

    rows = app_module._all_levels_results("2026-08-12")
    assert {r["level"] for r in rows} == set(levels.LEVEL_ORDER) - {"AA"}


def test_raw_feed_payloads_are_dropped_between_levels(monkeypatch):
    """One instance folding six slates otherwise holds six slates of raw feeds
    in L1 — the memory shape that has OOM-killed warm loops before."""
    evictions = []
    monkeypatch.setattr(app_module, "get_level_results", lambda d, l, games=None: [])
    monkeypatch.setattr(app_module, "get_agg_cache", lambda k: None)
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: None)
    monkeypatch.setattr(app_module, "_evict_box_transients",
                        lambda: evictions.append(1))
    app_module._all_levels_results("2026-08-12")
    assert len(evictions) == len(levels.LEVEL_ORDER)


# ── cache sharing with the single-level pages ──

def test_fan_out_reads_the_same_daily_key_the_level_pages_write(monkeypatch):
    """A warm AA homepage must make the AA slice of All-Levels free, and a
    warmed All-Levels day must make the AA homepage free. One key, both ways."""
    warm = {app_module._box_results_key("2026-08-12", "AA"): [_row("AA", "POR")]}
    computed = []

    monkeypatch.setattr(app_module, "get_agg_cache", lambda k: warm.get(k))
    monkeypatch.setattr(app_module, "set_agg_cache",
                        lambda k, v: warm.__setitem__(k, v))
    monkeypatch.setattr(app_module, "get_level_results",
                        lambda d, l, games=None: computed.append(l) or [_row(l, "X")])
    monkeypatch.setattr(app_module, "_evict_box_transients", lambda: None)

    app_module._all_levels_results("2026-08-12")
    assert "AA" not in computed, "the warm level was rebuilt instead of read"
    # And the levels it did build are now warm for the single-level pages.
    assert app_module._box_results_key("2026-08-12", "AAA") in warm


def test_an_empty_level_is_not_cached_as_an_answer(monkeypatch):
    """A level with no games (or an API that just failed) must stay retryable
    rather than memoising 'nobody pitched today'."""
    writes = {}
    monkeypatch.setattr(app_module, "get_agg_cache", lambda k: None)
    monkeypatch.setattr(app_module, "set_agg_cache", lambda k, v: writes.__setitem__(k, v))
    monkeypatch.setattr(app_module, "get_level_results", lambda d, l, games=None: [])
    assert app_module._box_results_for_level("2026-08-12", "R") == []
    assert writes == {}


# ── the endpoints ──

def test_levels_endpoint_offers_all_without_polluting_the_registry(monkeypatch, client):
    monkeypatch.setattr(app_module, "all_orgs", lambda: ["BOS"])
    body = client.get("/api/levels").json()
    assert body["all_levels"] == {"code": "ALL", "label": "All Levels"}
    # `levels` stays the real registry — every reader of it resolves a sportId.
    assert [l["code"] for l in body["levels"]] == levels.LEVEL_ORDER


def test_games_and_pitch_data_answer_all_with_nothing(monkeypatch, client):
    """Both are level-scoped by nature. The failure mode being pinned is not
    the empty list — it is silently returning the AAA slate instead."""
    monkeypatch.setattr(app_module, "get_games",
                        lambda *a, **k: pytest.fail("get_games called for ALL"))
    monkeypatch.setattr(app_module, "aggregate_pitch_data",
                        lambda *a, **k: pytest.fail("aggregated pitch data for ALL"))
    assert client.get("/api/games?date=2026-08-12&level=ALL").json() == []
    assert client.get("/api/pitch-data?date=2026-08-12&level=ALL").json() == []


def test_pitcher_results_folds_every_level_instead_of_answering_aaa(monkeypatch, client):
    monkeypatch.setattr(app_module, "_all_levels_results",
                        lambda date_str: [_row("AA", "POR"), _row("A+", "GVL")])
    monkeypatch.setattr(app_module, "tag_mlb_experience", lambda rows: rows)
    monkeypatch.setattr(app_module, "aggregate_pitcher_results",
                        lambda *a, **k: pytest.fail("took the Statcast path for ALL"))
    rows = client.get("/api/pitcher-results?date=2026-08-12&level=ALL").json()
    assert [r["level"] for r in rows] == ["AA", "A+"]


def test_initial_load_serves_all_levels_with_no_slate(monkeypatch, client):
    monkeypatch.setattr(app_module, "get_default_date", lambda: "2026-08-12")
    monkeypatch.setattr(app_module, "_all_levels_results",
                        lambda date_str: [_row("R", "DSL")])
    monkeypatch.setattr(app_module, "tag_mlb_experience", lambda rows: rows)
    monkeypatch.setattr(app_module, "_resolve_stat_lines_updated_at", lambda d: None)
    monkeypatch.setattr(app_module, "get_games",
                        lambda *a, **k: pytest.fail("get_games called for ALL"))
    body = client.get("/api/initial-load?level=ALL").json()
    assert body["level"] == "ALL"
    assert body["games"] == [] and body["pitchData"] == []
    assert [r["level"] for r in body["resultsData"]] == ["R"]
