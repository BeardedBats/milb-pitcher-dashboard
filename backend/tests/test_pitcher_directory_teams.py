"""Directory rows must lead with the club a pitcher is on now.

`unique()` returns first-appearance order, which puts the team a traded pitcher
LEFT at the head of his list — and the head of that list is what the player
page header and the search dropdown read as "his team". These pin the recency
ordering on the Savant side and the never-blank guarantee on the merge side.
"""
import pandas as pd

from app import _with_fallback_team
from data import _teams_by_recency, build_pitchers_list_from_df


def _frame(rows):
    return pd.DataFrame(rows, columns=["pitcher", "pitcher_team", "game_date", "player_name", "p_throws"])


def test_teams_ordered_by_most_recent_appearance():
    # Traded mid-July: the new club has the later last-appearance, so it leads
    # even though the old one owns most of the season.
    df = _frame([
        (7, "DUR", "2026-05-01", "Ace Prospect", "R"),
        (7, "DUR", "2026-06-15", "Ace Prospect", "R"),
        (7, "SWB", "2026-08-02", "Ace Prospect", "R"),
    ])
    assert _teams_by_recency(df) == {7: ["SWB", "DUR"]}
    assert build_pitchers_list_from_df(df)[0]["teams"] == ["SWB", "DUR"]


def test_a_return_to_a_former_club_puts_it_back_on_top():
    # Promoted, sent down, promoted again. Ordering is by LAST appearance, not
    # by first, so AAA leads.
    df = _frame([
        (7, "DUR", "2026-04-05", "Ace Prospect", "R"),
        (7, "MON", "2026-05-05", "Ace Prospect", "R"),
        (7, "DUR", "2026-08-05", "Ace Prospect", "R"),
    ])
    assert _teams_by_recency(df) == {7: ["DUR", "MON"]}


def test_each_pitcher_is_ordered_independently():
    df = _frame([
        (7, "DUR", "2026-08-02", "Ace Prospect", "R"),
        (7, "SWB", "2026-05-01", "Ace Prospect", "R"),
        (9, "DUR", "2026-05-01", "Other Guy", "L"),
        (9, "SWB", "2026-08-02", "Other Guy", "L"),
    ])
    assert _teams_by_recency(df) == {7: ["DUR", "SWB"], 9: ["SWB", "DUR"]}


def test_null_and_blank_teams_are_dropped():
    df = _frame([
        (7, None, "2026-08-02", "Ace Prospect", "R"),
        (7, "  ", "2026-07-02", "Ace Prospect", "R"),
        (7, "DUR", "2026-05-01", "Ace Prospect", "R"),
    ])
    assert _teams_by_recency(df) == {7: ["DUR"]}


def test_frame_without_game_date_falls_back_to_unique_order():
    # Partial/legacy frames have no game_date. The list must still be built —
    # just in first-appearance order, which is what it always was.
    df = pd.DataFrame(
        [(7, "DUR", "Ace Prospect", "R"), (7, "SWB", "Ace Prospect", "R")],
        columns=["pitcher", "pitcher_team", "player_name", "p_throws"],
    )
    assert _teams_by_recency(df) == {}
    assert build_pitchers_list_from_df(df)[0]["teams"] == ["DUR", "SWB"]


def test_fallback_team_fills_from_history_when_unresolved():
    row = _with_fallback_team({"pitcher_id": 7, "teams": ["SWB", "DUR"], "orgs": ["NYY", "TB"]})
    assert row["team"] == "SWB"
    assert row["org"] == "NYY"


def test_fallback_never_overwrites_a_resolved_club():
    row = _with_fallback_team({
        "pitcher_id": 7, "team": "SWB", "org": "NYY",
        "teams": ["SWB", "DUR"], "orgs": ["NYY", "TB"],
    })
    assert row["team"] == "SWB"
    assert row["org"] == "NYY"


def test_fallback_tolerates_a_row_with_no_history():
    row = _with_fallback_team({"pitcher_id": 7})
    assert "team" not in row
    assert "org" not in row
