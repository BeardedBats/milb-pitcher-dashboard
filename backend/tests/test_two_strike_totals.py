"""2Str% season totals across a mixed-level game log.

2Str% is a plate-appearance rate, so its numerator (`two_strike_pas`) and its
denominator (`pa_count`) have to be summed over the SAME games. They come from
two different producers — Savant for AAA/AFL, the play-by-play feed for every
level below — and when only one of them shipped a denominator the season line
divided a whole-season numerator by a partial denominator and printed a rate
above 100%. These pin the pairing so that can't come back.
"""
from season import aggregate_game_log_to_totals


def _game(pk, **kw):
    row = {"game_pk": pk, "ip": "5.0", "ks": 5, "pitches": 80}
    row.update(kw)
    return row


def test_two_str_pct_pairs_numerator_and_denominator_per_game():
    log = [
        _game(1, pa_count=20, two_strike_pas=10),
        _game(2, pa_count=20, two_strike_pas=14),
    ]
    totals = aggregate_game_log_to_totals(log)
    assert totals["two_str_pct"] == 60.0     # 24 / 40
    assert totals["pa_count"] == 40
    assert totals["two_strike_pas"] == 24


def test_row_without_pa_count_cannot_push_the_rate_over_100():
    """The reported bug: nine AA games contributed two-strike PAs while only
    the AAA games contributed plate appearances."""
    log = [_game(i, pa_count=20, two_strike_pas=12) for i in range(10)]
    log += [_game(100 + i, two_strike_pas=10) for i in range(9)]   # no pa_count
    totals = aggregate_game_log_to_totals(log)
    assert totals["two_str_pct"] == 60.0     # 120 / 200 — the AAA games only
    assert 0 <= totals["two_str_pct"] <= 100


def test_par_pct_still_uses_every_game():
    """PAR% is ks / two-strike PAs. Its numerator comes off the box score and
    exists at every level, so pairing it the same way would shrink only the
    denominator and inflate the rate."""
    log = [
        _game(1, ks=6, pa_count=20, two_strike_pas=12),
        _game(2, ks=6, two_strike_pas=12),      # non-Statcast row, no pa_count
    ]
    totals = aggregate_game_log_to_totals(log)
    assert totals["ks"] == 12
    assert totals["two_strike_pas"] == 24
    assert totals["par_pct"] == 50.0            # 12 / 24, both levels counted


def test_no_pa_data_at_all_reports_zero_not_a_crash():
    totals = aggregate_game_log_to_totals([_game(1), _game(2)])
    assert totals["two_str_pct"] == 0
    assert totals["par_pct"] == 0
