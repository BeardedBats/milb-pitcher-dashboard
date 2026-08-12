"""The Rehab Velo column reports the PRIMARY FASTBALL, not an all-pitch mean.

"Is his fastball back?" is the question that view exists to answer, and a mean
over every pitch answers a different one — it moves with pitch mix, so a start
with more breaking balls reads as lost velocity even when the fastball is
unchanged. These pin the selection rule and the cases where it must decline to
guess.
"""
import pytest

import boxscore_levels as b
from test_pitch_metrics import _feed, _play, _pitch


def _fb(index, call, pitch_code, speed):
    """A pitch carrying both a type code and a reading."""
    e = _pitch(index, call)
    if pitch_code:
        e["details"]["type"] = {"code": pitch_code}
    if speed is not None:
        e["pitchData"] = {"startSpeed": speed}
    return e


def _metrics(events):
    return b._derive_pitch_metrics(_feed([_play(1, events)]))[1]


def test_reports_the_fastball_he_threw_more_of():
    # Four sinkers at 92, two four-seamers at 97. Sinker wins on count, so the
    # column reads 92 — not the 93.7 all-pitch mean.
    m = _metrics([
        _fb(0, "C", "SI", 92.0), _fb(1, "B", "SI", 92.0),
        _fb(2, "S", "SI", 92.0), _fb(3, "B", "SI", 92.0),
        _fb(4, "C", "FF", 97.0), _fb(5, "S", "FF", 97.0),
    ])
    assert m["fb_pitch"] == "Sinker"
    assert m["fb_velo"] == 92.0
    assert m["fb_count"] == 4
    assert m["avg_velo"] != m["fb_velo"], "all-pitch mean should still differ"


def test_offspeed_never_drags_the_fastball_number():
    """THE point of the change: a start heavy on breaking balls must not read
    as lost velocity."""
    m = _metrics([
        _fb(0, "C", "FF", 96.0), _fb(1, "S", "FF", 96.0),
        _fb(2, "S", "SL", 84.0), _fb(3, "B", "CU", 78.0), _fb(4, "S", "CH", 86.0),
    ])
    assert m["fb_velo"] == 96.0
    assert m["avg_velo"] == 88.0, "sanity: the all-pitch mean really is much lower"


def test_ties_break_to_the_four_seamer():
    m = _metrics([_fb(0, "C", "FF", 95.0), _fb(1, "B", "SI", 93.0)])
    assert m["fb_pitch"] == "Four-Seamer"
    assert m["fb_velo"] == 95.0


def test_two_seam_code_folds_into_the_sinker():
    """FT is the retired two-seam code. Folding it in keeps one sinker sample
    instead of splitting it and handing the title to a smaller four-seam count."""
    m = _metrics([
        _fb(0, "C", "SI", 93.0), _fb(1, "B", "FT", 93.0), _fb(2, "S", "FT", 93.0),
        _fb(3, "C", "FF", 96.0), _fb(4, "S", "FF", 96.0),
    ])
    assert m["fb_pitch"] == "Sinker"
    assert m["fb_count"] == 3


def test_unspecified_fastball_counts_as_a_four_seamer():
    m = _metrics([_fb(0, "C", "FA", 94.0), _fb(1, "S", "FA", 96.0)])
    assert m["fb_pitch"] == "Four-Seamer"
    assert m["fb_velo"] == 95.0


def test_no_fastball_thrown_yields_none_rather_than_another_pitch():
    """A soft-tosser or knuckleballer gets a hyphen, never a number borrowed
    from a pitch that isn't a fastball."""
    m = _metrics([_fb(0, "C", "KN", 71.0), _fb(1, "S", "CU", 74.0)])
    assert m["fb_velo"] is None
    assert m["fb_pitch"] is None
    assert m["fb_count"] == 0
    assert m["avg_velo"] == 72.5, "the all-pitch mean is still computed"


def test_untracked_level_yields_none():
    """No startSpeed anywhere — the normal case below AAA."""
    m = _metrics([_fb(0, "C", "FF", None), _fb(1, "S", "SI", None)])
    assert m["fb_velo"] is None
    assert m["fb_pitch"] is None
    assert m["avg_velo"] is None


def test_a_fastball_with_no_reading_is_not_counted():
    """Mirrors avg_velo: a pitch without startSpeed must not enter the mean,
    and must not inflate the count that decides which fastball is primary."""
    m = _metrics([
        _fb(0, "C", "FF", 96.0), _fb(1, "B", "FF", None),
        _fb(2, "S", "SI", 93.0), _fb(3, "B", "SI", 93.0),
    ])
    assert m["fb_pitch"] == "Sinker", "the untracked four-seamer must not tie it"
    assert m["fb_count"] == 2
    assert m["fb_velo"] == 93.0


def test_pitch_with_no_type_code_is_ignored_safely():
    """Older or partial feeds omit details.type entirely."""
    m = _metrics([_fb(0, "C", None, 95.0), _fb(1, "S", "FF", 97.0)])
    assert m["fb_pitch"] == "Four-Seamer"
    assert m["fb_velo"] == 97.0
    assert m["avg_velo"] == 96.0


def test_lowercase_type_codes_still_match():
    m = _metrics([_fb(0, "C", "ff", 95.0), _fb(1, "S", "ff", 97.0)])
    assert m["fb_pitch"] == "Four-Seamer"
    assert m["fb_velo"] == 96.0


def test_each_pitcher_gets_an_independent_fastball():
    """Buckets must not share the per-family accumulator — one pitcher's
    sinkers must never end up in another's four-seam average."""
    from test_pitch_metrics import _sub

    out = b._derive_pitch_metrics(_feed([_play(1, [
        _fb(0, "C", "FF", 97.0), _fb(1, "S", "FF", 97.0),
        _sub(2, 2),
        _fb(3, "C", "SI", 91.0), _fb(4, "B", "SI", 91.0),
    ])]))

    assert out[1]["fb_pitch"] == "Four-Seamer" and out[1]["fb_velo"] == 97.0
    assert out[2]["fb_pitch"] == "Sinker" and out[2]["fb_velo"] == 91.0
