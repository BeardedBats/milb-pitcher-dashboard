"""Pitch-metric derivation for the non-Statcast levels.

These levels have no Statcast, but the live feed still records every pitch's
call and every ball in play's trajectory — that is where CSW%/SwStr%/GB% come
from. Pure functions over synthetic feeds: no network.
"""
import boxscore_levels as b


def _pitch(index, code, hit=None):
    e = {
        "index": index,
        "isPitch": True,
        "details": {"call": {"code": code}},
    }
    if hit:
        e["hitData"] = hit
    return e


def _sub(index, pitcher_id):
    return {
        "index": index,
        "isPitch": False,
        "details": {"eventType": "pitching_substitution"},
        "player": {"id": pitcher_id},
    }


def _feed(plays):
    return {"liveData": {"plays": {"allPlays": plays}}}


def _play(pitcher_id, events):
    return {"matchup": {"pitcher": {"id": pitcher_id}}, "playEvents": events}


def test_csw_and_swstr_from_call_codes():
    # C=called, S=swinging, W=blocked swinging, T=foul tip (all whiffs),
    # F=foul and B=ball (neither).
    feed = _feed([_play(1, [
        _pitch(0, "C"), _pitch(1, "S"), _pitch(2, "W"), _pitch(3, "T"),
        _pitch(4, "F"), _pitch(5, "B"),
    ])])
    m = b._derive_pitch_metrics(feed)[1]
    assert m["tracked_pitches"] == 6
    assert m["whiffs"] == 3          # S, W, T
    assert m["called_strikes"] == 1  # C
    assert m["swstr_pct"] == 50.0    # 3/6
    assert m["csw_pct"] == 66.7      # 4/6


def test_batted_ball_rates_use_all_balls_in_play():
    feed = _feed([_play(1, [
        _pitch(0, "X", {"trajectory": "ground_ball", "hardness": "hard"}),
        _pitch(1, "X", {"trajectory": "bunt_grounder", "hardness": "soft"}),
        _pitch(2, "D", {"trajectory": "fly_ball", "hardness": "medium"}),
        _pitch(3, "E", {"trajectory": "line_drive", "hardness": "hard"}),
    ])])
    m = b._derive_pitch_metrics(feed)[1]
    assert m["bip"] == 4
    assert m["gb"] == 2              # bunt grounder counts as a ground ball
    assert m["gb_pct"] == 50.0
    assert m["fb_pct"] == 25.0
    assert m["ld_pct"] == 25.0
    assert m["hard_pct"] == 50.0


def test_mid_pa_substitution_attributes_pitches_to_the_right_pitcher():
    """Regression: matchup.pitcher names who FINISHED the plate appearance.

    Trusting it moved 3 pitches from the departing pitcher to the reliever in
    Rookie game 849353 while the game total still reconciled — so a total-based
    check would not have caught it.
    """
    feed = _feed([
        _play(10, [_pitch(0, "B"), _pitch(1, "C")]),          # pitcher 10 alone
        _play(20, [                                            # 10 starts, 20 finishes
            _pitch(0, "B"),
            _pitch(1, "B"),
            _sub(2, 20),
            _pitch(3, "S"),
        ]),
    ])
    m = b._derive_pitch_metrics(feed)
    assert m[10]["tracked_pitches"] == 4   # 2 from play 1 + 2 before the sub
    assert m[20]["tracked_pitches"] == 1   # only the pitch after the sub
    assert m[20]["whiffs"] == 1
    # Nothing is lost or double-counted.
    assert sum(v["tracked_pitches"] for v in m.values()) == 5


def test_no_balls_in_play_leaves_rates_none_not_zero():
    # A pitcher who faced batters but induced no contact must render em dashes,
    # not a misleading 0.0% ground-ball rate.
    feed = _feed([_play(1, [_pitch(0, "S"), _pitch(1, "S"), _pitch(2, "S")])])
    m = b._derive_pitch_metrics(feed)[1]
    assert m["bip"] == 0
    assert m["gb_pct"] is None
    assert m["hard_pct"] is None
    assert m["swstr_pct"] == 100.0


def test_empty_feed_is_safe():
    assert b._derive_pitch_metrics({}) == {}
    assert b._derive_pitch_metrics(_feed([])) == {}
