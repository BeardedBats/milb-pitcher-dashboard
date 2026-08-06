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


# ── Count-based metrics ────────────────────────────────────────────────────
# GUMBO's `count` on a pitch event is the state AFTER the pitch. Anything keyed
# on the count a pitch was THROWN in must use the previous event's count.

def _pitch_c(index, code, after_balls, after_strikes, pitch_number=None, hit=None):
    e = _pitch(index, code, hit)
    e["count"] = {"balls": after_balls, "strikes": after_strikes}
    if pitch_number is not None:
        e["pitchNumber"] = pitch_number
    return e


def test_first_pitch_strike_uses_before_count_not_after():
    """Regression: reading `count` directly made F-Strike% match only
    first-pitch balls in play — the one case where the count doesn't advance —
    and report a bogus 100%."""
    feed = _feed([
        # PA 1: called strike on 0-0 (reports 0-1 after) -> a first-pitch strike
        _play(1, [_pitch_c(0, "C", 0, 1, pitch_number=1),
                  _pitch_c(1, "B", 1, 1, pitch_number=2)]),
        # PA 2: ball on 0-0 (reports 1-0 after) -> NOT a first-pitch strike
        _play(1, [_pitch_c(0, "B", 1, 0, pitch_number=1),
                  _pitch_c(1, "S", 1, 1, pitch_number=2)]),
    ])
    m = b._derive_pitch_metrics(feed)[1]
    assert m["first_pitches"] == 2           # one per PA, not per 0-0 count
    assert m["first_pitch_strikes"] == 1
    assert m["f_strike_pct"] == 50.0


def test_two_strike_pitches_count_pitches_thrown_in_two_strike_counts():
    feed = _feed([_play(1, [
        _pitch_c(0, "C", 0, 1, pitch_number=1),   # thrown 0-0
        _pitch_c(1, "C", 0, 2, pitch_number=2),   # thrown 0-1
        _pitch_c(2, "F", 0, 2, pitch_number=3),   # thrown 0-2  <- two-strike
        _pitch_c(3, "S", 0, 3, pitch_number=4),   # thrown 0-2  <- two-strike
    ])])
    m = b._derive_pitch_metrics(feed)[1]
    assert m["two_strike_pitches"] == 2


def test_par_pct_is_strikeouts_over_pas_that_reached_two_strikes():
    k_play = _play(1, [_pitch_c(0, "C", 0, 1, pitch_number=1),
                       _pitch_c(1, "C", 0, 2, pitch_number=2),
                       _pitch_c(2, "S", 0, 3, pitch_number=3)])
    k_play["result"] = {"eventType": "strikeout"}
    survived = _play(1, [_pitch_c(0, "C", 0, 1, pitch_number=1),
                         _pitch_c(1, "C", 0, 2, pitch_number=2),
                         _pitch_c(2, "X", 0, 2, pitch_number=3,
                                  hit={"trajectory": "ground_ball"})])
    survived["result"] = {"eventType": "field_out"}
    never_two = _play(1, [_pitch_c(0, "X", 0, 0, pitch_number=1,
                                   hit={"trajectory": "line_drive"})])
    never_two["result"] = {"eventType": "single"}
    m = b._derive_pitch_metrics(_feed([k_play, survived, never_two]))[1]
    assert m["two_strike_pas"] == 2   # the single never reached two strikes
    assert m["par_pct"] == 50.0


# ── Zone, calibrated from Gameday pixels ───────────────────────────────────

def test_plate_coords_and_zone_calibration():
    # Dead center of the plate in pixel space maps to ~0 ft horizontally.
    cx = -b._PX_B / b._PX_A
    px, pz = b._plate_coords({"coordinates": {"x": cx, "y": 150}})
    assert abs(px) < 0.01
    # In-zone requires both axes; the vertical pad is a ball radius.
    assert b._is_in_zone(0.0, 2.5, 3.5, 1.5) is True
    assert b._is_in_zone(1.2, 2.5, 3.5, 1.5) is False      # way outside
    assert b._is_in_zone(0.0, 1.45, 3.5, 1.5) is True      # just under, within pad
    assert b._is_in_zone(0.0, 1.2, 3.5, 1.5) is False      # below the pad
    assert b._is_in_zone(None, 2.5, 3.5, 1.5) is None      # missing data


def test_zone_rates_split_swings_by_location():
    inside = {"coordinates": {"x": -b._PX_B / b._PX_A, "y": 150},
              "strikeZoneTop": 10.0, "strikeZoneBottom": -10.0}
    outside = {"coordinates": {"x": 10, "y": 150},
               "strikeZoneTop": 10.0, "strikeZoneBottom": -10.0}
    e_in_swing = _pitch_c(0, "F", 0, 1, pitch_number=1); e_in_swing["pitchData"] = inside
    e_out_swing = _pitch_c(1, "S", 0, 2, pitch_number=2); e_out_swing["pitchData"] = outside
    e_out_take = _pitch_c(2, "B", 1, 2, pitch_number=3); e_out_take["pitchData"] = outside
    m = b._derive_pitch_metrics(_feed([_play(1, [e_in_swing, e_out_swing, e_out_take])]))[1]
    assert m["zone_pct"] == 33.3          # 1 of 3 in zone
    assert m["o_swing_pct"] == 50.0       # 1 of 2 out-of-zone pitches swung at
    assert m["z_swing_pct"] == 100.0
    assert m["z_contact_pct"] == 100.0    # the in-zone swing was a foul
    assert m["o_contact_pct"] == 0.0      # the out-of-zone swing was a whiff


# ── Platoon splits ─────────────────────────────────────────────────────────

def test_splits_by_batter_hand_sum_to_overall():
    def sided(pid, side, events):
        p = _play(pid, events)
        p["matchup"]["batSide"] = {"code": side}
        return p
    feed = _feed([
        sided(1, "L", [_pitch_c(0, "S", 0, 1, pitch_number=1)]),
        sided(1, "R", [_pitch_c(0, "C", 0, 1, pitch_number=1),
                       _pitch_c(1, "B", 1, 1, pitch_number=2)]),
    ])
    m = b._derive_pitch_metrics(feed)[1]
    assert m["tracked_pitches"] == 3
    assert m["splits"]["L"]["tracked_pitches"] == 1
    assert m["splits"]["R"]["tracked_pitches"] == 2
    assert m["splits"]["L"]["swstr_pct"] == 100.0
    assert m["splits"]["R"]["csw_pct"] == 50.0
    # No double counting between the overall bucket and the splits.
    assert sum(s["tracked_pitches"] for s in m["splits"].values()) == m["tracked_pitches"]


# ── Contact quality and spray ──────────────────────────────────────────────

def test_hardness_distribution_and_spray_flip_with_handedness():
    def bip(pid, side, location, hardness):
        p = _play(pid, [_pitch_c(0, "X", 0, 0, pitch_number=1,
                                 hit={"trajectory": "ground_ball",
                                      "hardness": hardness, "location": location})])
        p["matchup"]["batSide"] = {"code": side}
        return p
    # Fielder 5 (3B) is the left side: a pull for a righty, oppo for a lefty.
    m = b._derive_pitch_metrics(_feed([
        bip(1, "R", "5", "hard"),
        bip(1, "L", "5", "soft"),
        bip(1, "R", "8", "medium"),   # up the middle
    ]))[1]
    assert m["pull_pct"] == 33.3
    assert m["oppo_pct"] == 33.3
    assert m["center_pct"] == 33.3
    assert m["hard_pct"] == 33.3
    assert m["soft_pct"] == 33.3
    assert m["med_pct"] == 33.3
