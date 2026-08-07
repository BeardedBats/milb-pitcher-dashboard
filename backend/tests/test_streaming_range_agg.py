"""The streaming aggregators must produce EXACTLY what the whole-frame ones do.

This is the safety net for splitting a season-wide aggregation into per-day
folds. The failure mode being guarded against is not a crash — it is a subtly
wrong number that still looks plausible, e.g. averaging per-day percentages
instead of deriving the rate from merged totals.

The data is synthetic but shaped like the real frame; what is being proven is
the algebra, not the fetch path.
"""
import numpy as np
import pandas as pd
import pytest

import aggregation as A

DAYS = ["2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04"]
DESCRIPTIONS = [
    "swinging_strike", "called_strike", "foul", "ball",
    "hit_into_play", "swinging_strike_blocked", "blocked_ball",
]
EVENTS = ["", "single", "double", "home_run", "walk", "strikeout", "field_out"]
PITCHES = [("FF", "4-Seam Fastball"), ("SL", "Slider"), ("CH", "Changeup")]


def _make_day(date_str, seed, n=260):
    """One day's pitch frame. Games belong to exactly one date, which is the
    property that makes per-day folding valid."""
    rng = np.random.default_rng(seed)
    base_pk = seed * 1000
    pitch_idx = rng.integers(0, len(PITCHES), n)
    return pd.DataFrame({
        "game_date": date_str,
        "game_pk": rng.choice([base_pk + 1, base_pk + 2, base_pk + 3], n),
        "pitcher": rng.choice([101, 102, 103], n),
        "player_name": "x",           # replaced below, per pitcher
        "p_throws": "R",
        "pitcher_team": rng.choice(["WOR", "BUF"], n),
        "opponent": "SWB",
        "pitch_type": [PITCHES[i][0] for i in pitch_idx],
        "pitch_name": [PITCHES[i][1] for i in pitch_idx],
        "description": rng.choice(DESCRIPTIONS, n),
        "events": rng.choice(EVENTS, n),
        "stand": rng.choice(["R", "L"], n),
        "strikes": rng.integers(0, 3, n),
        "balls": rng.integers(0, 4, n),
        "zone": rng.integers(1, 15, n),
        "at_bat_number": rng.integers(1, 40, n),
        "pitch_number": rng.integers(1, 7, n),
        # Deliberate NaNs: means must count only non-NaN, like pandas .mean().
        "release_speed": np.where(rng.random(n) < 0.1, np.nan, rng.random(n) * 20 + 80),
        "release_extension": np.where(rng.random(n) < 0.2, np.nan, rng.random(n) * 2 + 5),
        "pfx_z": np.where(rng.random(n) < 0.15, np.nan, rng.random(n) * 2 - 1),
        "pfx_x": np.where(rng.random(n) < 0.15, np.nan, rng.random(n) * 2 - 1),
        "plate_x": rng.random(n) * 2 - 1,
        "plate_z": rng.random(n) * 2 + 1.5,
        "sz_top": 3.4, "sz_bot": 1.6,
        "launch_speed": np.nan, "launch_angle": np.nan,
    }).assign(player_name=lambda d: d["pitcher"].map(
        {101: "Alpha, A", 102: "Bravo, B", 103: "Charlie, C"}))


@pytest.fixture
def days():
    return [_make_day(d, i + 1) for i, d in enumerate(DAYS)]


@pytest.fixture(autouse=True)
def no_boxscores(monkeypatch):
    """Boxscore lookups are network. Stub them identically for both paths so the
    comparison isolates the aggregation algebra."""
    monkeypatch.setattr(A, "_prefetch_boxscores_parallel", lambda pks: {})


def test_pitch_data_streaming_matches_whole_frame(days):
    whole = A.aggregate_pitch_data_range(pd.concat(days, ignore_index=True))

    acc = A.new_pitch_data_accumulator()
    for day in days:
        A.accumulate_pitch_data(acc, day)
    streamed = A.finalize_pitch_data(acc)

    assert len(streamed) == len(whole) > 0
    for got, want in zip(streamed, whole):
        assert got.keys() == want.keys()
        for k in want:
            if isinstance(want[k], float) and want[k] is not None:
                assert got[k] == pytest.approx(want[k], rel=1e-9, abs=1e-9), k
            else:
                assert got[k] == want[k], k


def test_pitcher_results_streaming_matches_whole_frame(days):
    whole = A.aggregate_pitcher_results_range(pd.concat(days, ignore_index=True))

    acc = A.new_results_accumulator()
    for day in days:
        A.accumulate_pitcher_results(acc, day)
    streamed = A.finalize_pitcher_results(acc)

    assert len(streamed) == len(whole) > 0
    assert streamed == whole


def test_pitcher_results_match_when_boxscores_supply_er_and_ip(days, monkeypatch):
    """With the boxscore stub empty, ER stays 0 and IP falls back to events —
    so the branch most at risk of double-counting across days (per-game ER and
    IP thirds, summed per pitcher) goes untested. Give it real boxscores.

    The stub is deterministic per game_pk, so the whole-frame path (one call
    with every pk) and the streaming path (one call per day) see identical
    numbers — any difference is the accumulator's fault, not the stub's.
    """
    def fake_boxscores(pks):
        return {
            int(pk): {
                pid: {"er": (int(pk) + pid) % 4, "ip": f"{(int(pk) + pid) % 6}.{pid % 3}"}
                for pid in (101, 102, 103)
            }
            for pk in pks
        }

    monkeypatch.setattr(A, "_prefetch_boxscores_parallel", fake_boxscores)

    whole = A.aggregate_pitcher_results_range(pd.concat(days, ignore_index=True))

    acc = A.new_results_accumulator()
    for day in days:
        A.accumulate_pitcher_results(acc, day)
    streamed = A.finalize_pitcher_results(acc)

    assert streamed == whole
    # Guard the guard: the fixture must actually be exercising this path.
    assert any(r["er"] > 0 for r in whole), "boxscore stub produced no ER"
    assert any(r["ip"] != "0.0" for r in whole)


def test_day_order_does_not_change_the_result(days):
    acc_fwd = A.new_pitch_data_accumulator()
    for day in days:
        A.accumulate_pitch_data(acc_fwd, day)

    acc_rev = A.new_pitch_data_accumulator()
    for day in reversed(days):
        A.accumulate_pitch_data(acc_rev, day)

    assert A.finalize_pitch_data(acc_fwd) == A.finalize_pitch_data(acc_rev)


def test_rates_are_derived_from_totals_not_averaged(days):
    """The specific bug this refactor could introduce: a pitcher throwing 1
    pitch on a heavy day and 100 on a light one must not have those days'
    percentages weighted equally."""
    lopsided = [_make_day("2026-05-01", 11, n=400), _make_day("2026-05-02", 12, n=5)]
    whole = A.aggregate_pitch_data_range(pd.concat(lopsided, ignore_index=True))

    acc = A.new_pitch_data_accumulator()
    for day in lopsided:
        A.accumulate_pitch_data(acc, day)
    streamed = A.finalize_pitch_data(acc)

    by_key = {(r["pitcher_id"], r["pitch_type"]): r for r in whole}
    for row in streamed:
        want = by_key[(row["pitcher_id"], row["pitch_type"])]
        for k in ("csw_pct", "usage", "zone_pct", "strike_pct", "swstr_pct"):
            assert row[k] == pytest.approx(want[k], rel=1e-9, abs=1e-9), k


def test_empty_and_absent_days_are_harmless(days):
    acc = A.new_pitch_data_accumulator()
    A.accumulate_pitch_data(acc, pd.DataFrame())
    A.accumulate_pitch_data(acc, None)
    for day in days:
        A.accumulate_pitch_data(acc, day)
    A.accumulate_pitch_data(acc, pd.DataFrame())

    whole = A.aggregate_pitch_data_range(pd.concat(days, ignore_index=True))
    assert A.finalize_pitch_data(acc) == whole
