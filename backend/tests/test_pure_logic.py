import pytest

from aggregation import _ip_to_outs
from app import _ip_to_thirds
from data import _normalize_mlb_description, _normalize_mlb_type_code


@pytest.mark.parametrize("ip,expected", [
    ("7.1", 22),   # 7 1/3 innings
    ("7.2", 23),
    ("7.0", 21),
    ("0.2", 2),
    ("9", 27),
    (7, 21),
    (7.1, 22),
    (None, 0),
    ("", 0),
    ("junk", 0),
])
def test_ip_to_outs(ip, expected):
    assert _ip_to_outs(ip) == expected


@pytest.mark.parametrize("ip,expected", [
    ("7.1", 22),
    ("7.2", 23),
    ("7.0", 21),
    ("9", 27),
    (None, 0),
    ("", 0),
])
def test_ip_to_thirds(ip, expected):
    assert _ip_to_thirds(ip) == expected


def test_ip_parsers_agree_on_valid_input():
    # Two copies of the same parser live in app.py and aggregation.py (E1 will
    # unify them); until then they must stay in lockstep on real IP strings.
    for ip in ["0.0", "1.0", "5.2", "7.1", "9", "0.1"]:
        assert _ip_to_outs(ip) == _ip_to_thirds(ip), ip


@pytest.mark.parametrize("raw,expected", [
    ("Called Strike", "called_strike"),
    ("Swinging Strike (Blocked)", "swinging_strike_blocked"),
    ("Ball In Dirt", "ball"),
    ("In play, run(s)", "hit_into_play"),
    ("Hit By Pitch", "hit_by_pitch"),
    (None, ""),
    ("Some Future Thing", "some_future_thing"),  # unknown -> snake_case passthrough
])
def test_normalize_mlb_description(raw, expected):
    assert _normalize_mlb_description(raw) == expected


@pytest.mark.parametrize("code,expected", [
    ("B", "B"),
    ("C", "S"),
    ("W", "S"),
    ("T", "S"),
    ("X", "X"),
    ("E", "X"),
    ("H", "B"),
    ("*B", "B"),
    ("*S", "S"),
    ("Q", "Q"),  # unknown passthrough
])
def test_normalize_mlb_type_code(code, expected):
    assert _normalize_mlb_type_code(code) == expected
