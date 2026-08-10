"""The streaming pitcher-directory aggregator must match the whole-frame one.

Same contract as test_streaming_range_agg.py, for the directory path: folding
a range one day at a time has to produce EXACTLY what
build_pitchers_list_from_df produces from the concatenated frame. The failure
mode is not a crash, it is a directory that quietly loses a team tag, reports a
stale last_date, or undercounts pitches — all of which still render fine.

The whole-frame function is the reference implementation and stays in the
module for that reason; nothing on the request path may call it with a
season-wide frame.
"""
import numpy as np
import pandas as pd
import pytest

import data as D

DAYS = ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"]


def _make_day(date_str, seed, n=120):
    rng = np.random.default_rng(seed)
    pitchers = [101, 102, 103]
    names = {101: "Álvarez, A", 102: "Bravo, B", 103: "Charlie, C"}
    hands = {101: "L", 102: "R", 103: "R"}
    pid = rng.choice(pitchers, n)
    return pd.DataFrame({
        "game_date": date_str,
        "game_pk": rng.choice([seed * 1000 + 1, seed * 1000 + 2], n),
        "pitcher": pid,
        "player_name": [names[p] for p in pid],
        "p_throws": [hands[p] for p in pid],
        "pitcher_team": rng.choice(["WOR", "BUF", "SWB"], n),
    })


def _fold(days):
    acc = D.new_pitchers_list_accumulator()
    for day in days:
        D.accumulate_pitchers_list(acc, day)
    return D.finalize_pitchers_list(acc)


def _whole(days):
    return D.build_pitchers_list_from_df(pd.concat(days, ignore_index=True))


def _canonical(rows):
    """Team order is 'order of first appearance' in both implementations, but
    the assertion should not depend on it for rows that merely differ in which
    day a team first showed up. Sort teams for comparison; order is pinned
    separately in test_team_order_follows_first_appearance."""
    return [{**r, "teams": sorted(r["teams"])} for r in rows]


def test_matches_whole_frame_aggregation():
    days = [_make_day(d, i + 1) for i, d in enumerate(DAYS)]
    assert _canonical(_fold(days)) == _canonical(_whole(days))


def test_pitch_counts_sum_across_days():
    days = [_make_day(d, i + 1) for i, d in enumerate(DAYS)]
    total = sum(len(d) for d in days)
    assert sum(r["pitches"] for r in _fold(days)) == total


def test_last_date_is_the_max_not_the_last_folded():
    """Guards the running-extreme rule: a pitcher absent from the final day
    must keep the date he actually last appeared."""
    d1 = _make_day(DAYS[0], 1)
    d2 = _make_day(DAYS[1], 2)
    d2 = d2[d2["pitcher"] != 101]          # 101 sits out the later day
    rows = {r["pitcher_id"]: r for r in _fold([d1, d2])}
    assert rows[101]["last_date"] == DAYS[0]
    assert rows[102]["last_date"] == DAYS[1]


def _one_team_day(date_str, team, game_pk):
    return pd.DataFrame({
        "game_date": date_str, "game_pk": game_pk, "pitcher": [101],
        "player_name": "Solo, S", "p_throws": "R", "pitcher_team": [team],
    })


def test_team_order_follows_most_recent_appearance():
    """Matches _teams_by_recency: the club a pitcher was traded TO leads, even
    though the old one owns more of the season. Folding a per-(pitcher, team)
    max day by day has to give the same answer as the whole-frame groupby."""
    days = [
        _one_team_day(DAYS[0], "WOR", 1),
        _one_team_day(DAYS[1], "WOR", 2),
        _one_team_day(DAYS[2], "BUF", 3),
    ]
    assert _fold(days)[0]["teams"] == ["BUF", "WOR"]
    assert _fold(days) == _whole(days)


def test_a_return_to_a_former_club_puts_it_back_on_top():
    """Ordering is by LAST appearance, so a demotion-then-promotion reorders."""
    days = [
        _one_team_day(DAYS[0], "WOR", 1),
        _one_team_day(DAYS[1], "BUF", 2),
        _one_team_day(DAYS[2], "WOR", 3),
    ]
    assert _fold(days)[0]["teams"] == ["WOR", "BUF"]
    assert _fold(days) == _whole(days)


def test_blank_and_null_teams_are_dropped_from_the_recency_order():
    days = [
        _one_team_day(DAYS[0], "WOR", 1),
        _one_team_day(DAYS[1], None, 2),
        _one_team_day(DAYS[2], "  ", 3),
    ]
    assert _fold(days)[0]["teams"] == ["WOR"]


def test_frame_without_game_date_falls_back_to_first_appearance_order():
    """Partial/legacy frames carry no game_date, so there is nothing to order
    by — both implementations fall back to unique() order."""
    day = pd.DataFrame({
        "game_pk": [1, 2], "pitcher": [101, 101],
        "player_name": "Solo, S", "p_throws": "R", "pitcher_team": ["WOR", "BUF"],
    })
    assert _fold([day])[0]["teams"] == ["WOR", "BUF"]
    assert _fold([day]) == _whole([day])


def test_first_non_null_name_and_hand_win():
    """pandas .agg("first") skips NaN; the fold must too, including when the
    null day is folded first."""
    a = pd.DataFrame({
        "game_date": DAYS[0], "game_pk": 1, "pitcher": [101],
        "player_name": [None], "p_throws": [None], "pitcher_team": ["WOR"],
    })
    b = pd.DataFrame({
        "game_date": DAYS[1], "game_pk": 2, "pitcher": [101],
        "player_name": ["Late, L"], "p_throws": ["L"], "pitcher_team": ["WOR"],
    })
    row = _fold([a, b])[0]
    assert row["name"] == "Late, L"
    assert row["hand"] == "L"
    assert row["name_norm"] == "late, l"
    assert _fold([a, b]) == _whole([a, b])


def test_accents_are_stripped_for_search():
    rows = {r["pitcher_id"]: r for r in _fold([_make_day(DAYS[0], 1)])}
    assert rows[101]["name_norm"] == "alvarez, a"


@pytest.mark.parametrize("bad", [None, pd.DataFrame()])
def test_empty_and_missing_days_are_no_ops(bad):
    acc = D.new_pitchers_list_accumulator()
    D.accumulate_pitchers_list(acc, bad)
    assert D.finalize_pitchers_list(acc) == []


def test_frame_without_pitcher_column_is_ignored():
    acc = D.new_pitchers_list_accumulator()
    D.accumulate_pitchers_list(acc, pd.DataFrame({"game_pk": [1]}))
    assert D.finalize_pitchers_list(acc) == []


# ── The fetchers must never build a season-wide frame ──

@pytest.fixture
def stub_range(monkeypatch):
    """Same stubbing approach as test_fold_range.py."""
    state = {"present": {}, "today": None}
    monkeypatch.setattr(D, "_load_range_day", lambda d: state["present"].get(d))
    monkeypatch.setattr(D, "missing_range_days", lambda s, e: [
        d for d in D._date_strings(s, e) if d not in state["present"]
    ])
    monkeypatch.setattr(D, "_is_today", lambda d: d == state["today"])
    monkeypatch.setattr(D, "_cache", {})
    monkeypatch.setattr(D, "_merge_daily_cache_for_day", lambda day, d: day)
    monkeypatch.setattr(D, "_pitchers_list_cache", {})
    return state


def test_partial_skips_missing_days_instead_of_bailing(stub_range, monkeypatch):
    monkeypatch.setattr(D, "pd", pd)
    stub_range["present"] = {
        DAYS[0]: _make_day(DAYS[0], 1),
        # DAYS[1] deliberately absent — a transient gap
        DAYS[2]: _make_day(DAYS[2], 3),
    }
    rows = D.fetch_pitchers_list_partial(DAYS[0], DAYS[2])
    assert rows, "a gap must not empty the directory"
    expected = len(stub_range["present"][DAYS[0]]) + len(stub_range["present"][DAYS[2]])
    assert sum(r["pitches"] for r in rows) == expected


def test_materialized_returns_none_when_a_day_is_missing(stub_range, monkeypatch):
    """The strict fetcher keeps its 202 contract — a gap means 'not ready',
    never a silently short directory."""
    monkeypatch.setattr(D, "redis_get", lambda *a, **k: None)
    stub_range["present"] = {DAYS[0]: _make_day(DAYS[0], 1)}
    assert D.fetch_all_pitchers_list_materialized(DAYS[0], DAYS[2]) is None


def test_neither_fetcher_concatenates_the_range(stub_range, monkeypatch):
    """The regression guard proper: pd.concat over the range is the 1.3 GB
    allocation that OOM-killed these endpoints."""
    monkeypatch.setattr(D, "redis_get", lambda *a, **k: None)
    monkeypatch.setattr(D, "redis_set", lambda *a, **k: None)
    monkeypatch.setattr(D, "_index_cache_key", lambda *a, **k: None)
    stub_range["present"] = {d: _make_day(d, i + 1) for i, d in enumerate(DAYS)}

    def _boom(*a, **k):
        raise AssertionError("pd.concat over the range rebuilds the season frame")

    monkeypatch.setattr(D.pd, "concat", _boom)
    assert D.fetch_pitchers_list_partial(DAYS[0], DAYS[-1])
    assert D.fetch_all_pitchers_list_materialized(DAYS[0], DAYS[-1])


def test_background_directory_build_is_disabled_on_serverless(monkeypatch):
    """A thread that outlives the response is frozen mid-flight on Vercel and
    resumes inside an unrelated invocation. Must not start there."""
    started = []
    monkeypatch.setattr(D.threading, "Thread",
                        lambda *a, **k: started.append(k) or pytest.fail("thread started"))
    monkeypatch.setattr(D, "_IS_SERVERLESS", True)
    D._background_build_pitcher_directory(DAYS[0], DAYS[-1])
    assert started == []
