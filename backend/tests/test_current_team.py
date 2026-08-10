"""The player pool's current-club mapping.

A pitcher traded at the deadline keeps a last game played for his OLD org until
he takes the ball for the new one — so the game log cannot answer "who does he
belong to?" and the transaction feed has to. These pin the resolution, the
history reordering, and the two things that make the mapping safe: an
unresolved player is never blanked out, and an MLB roster spot never leaks a
bogus level code into a registry that deliberately excludes sportId 1.

No network: the people fetch and the level registry are both stubbed.
"""
import pytest

import mlb_status


# Durham Bulls (Rays AAA) and Somerset Patriots (Yankees AA), shaped like the
# level registry's `meta` dicts.
_REGISTRY = {
    234: {"team_id": 234, "name": "Durham Bulls", "abbrev": "DUR", "level": "AAA", "org": "TB"},
    1860: {"team_id": 1860, "name": "Somerset Patriots", "abbrev": "SWB", "level": "AA", "org": "NYY"},
}


@pytest.fixture(autouse=True)
def _isolate_caches(monkeypatch):
    """Every test starts with empty caches and a dead Redis, like a cold box."""
    monkeypatch.setattr(mlb_status, "_current_team_cache", {})
    monkeypatch.setattr(mlb_status, "_debut_cache", {})
    monkeypatch.setattr(mlb_status, "_l2_get", lambda key: None)
    monkeypatch.setattr(mlb_status, "_l2_set", lambda key, value, ttl: None)


@pytest.fixture(autouse=True)
def _stub_registry(monkeypatch):
    import levels
    monkeypatch.setattr(levels, "team_meta_by_id", lambda tid: _REGISTRY.get(int(tid)) if tid else None)


def _stub_people(monkeypatch, people):
    """Stand in for the batched /people fetch, recording the ids requested."""
    calls = []

    def fake_fetch(batch):
        calls.append(list(batch))
        out = {}
        for pid in batch:
            person = people.get(int(pid))
            if person is None:
                continue
            resolved = mlb_status._resolve_current_team(person.get("currentTeam"))
            if resolved:
                out[int(pid)] = resolved
        return out

    monkeypatch.setattr(mlb_status, "_fetch_current_teams", fake_fetch)
    return calls


def test_resolves_a_milb_affiliate_from_the_registry():
    resolved = mlb_status._resolve_current_team({"id": 234, "name": "Durham Bulls"})
    assert resolved == {
        "team_id": 234, "team_name": "Durham Bulls", "team": "DUR",
        "level": "AAA", "org": "TB", "mlb_roster": False,
    }


def test_mlb_club_resolves_to_an_org_with_no_level():
    # A pitcher on the 40-man in the majors: his club is absent from the MiLB
    # registry, so the org comes off the club name. `level` must stay None —
    # normalize_level would coerce any unknown string to AAA.
    resolved = mlb_status._resolve_current_team({"id": 139, "name": "Tampa Bay Rays"})
    assert resolved["org"] == "TB"
    assert resolved["level"] is None
    assert resolved["mlb_roster"] is True


@pytest.mark.parametrize("team", [None, {}, "Durham Bulls", {"id": None, "name": ""}])
def test_unusable_current_team_resolves_to_nothing(team):
    assert mlb_status._resolve_current_team(team) is None


def test_foreign_club_keeps_its_name_but_claims_no_org():
    resolved = mlb_status._resolve_current_team({"id": 9999, "name": "Yomiuri Giants"})
    assert resolved["team_name"] == "Yomiuri Giants"
    assert resolved["org"] is None
    assert resolved["mlb_roster"] is False


def test_traded_pitcher_is_mapped_to_his_new_club(monkeypatch):
    # Pitched all season for Durham; traded to the Yankees and assigned to
    # Somerset without appearing for them yet.
    _stub_people(monkeypatch, {7: {"currentTeam": {"id": 1860, "name": "Somerset Patriots"}}})
    rows = [{"pitcher_id": 7, "teams": ["DUR"], "orgs": ["TB"], "levels": ["AAA"]}]

    mlb_status.tag_current_team(rows)

    assert rows[0]["team"] == "SWB"
    assert rows[0]["org"] == "NYY"
    assert rows[0]["team_level"] == "AA"
    # History survives the move, current club first — the old affiliate is
    # still where the season's innings were thrown.
    assert rows[0]["teams"] == ["SWB", "DUR"]
    assert rows[0]["orgs"] == ["NYY", "TB"]
    assert rows[0]["levels"] == ["AA", "AAA"]


def test_unmoved_pitcher_keeps_a_single_history_entry(monkeypatch):
    _stub_people(monkeypatch, {7: {"currentTeam": {"id": 234, "name": "Durham Bulls"}}})
    rows = [{"pitcher_id": 7, "teams": ["DUR"], "orgs": ["TB"], "levels": ["AAA"]}]

    mlb_status.tag_current_team(rows)

    assert rows[0]["teams"] == ["DUR"]
    assert rows[0]["orgs"] == ["TB"]


def test_unresolved_pitcher_is_left_exactly_as_he_was(monkeypatch):
    # The people endpoint didn't return him. A blank mapping must never
    # overwrite a known-good season history.
    _stub_people(monkeypatch, {})
    rows = [{"pitcher_id": 7, "teams": ["DUR"], "orgs": ["TB"], "levels": ["AAA"]}]

    mlb_status.tag_current_team(rows)

    assert rows[0] == {"pitcher_id": 7, "teams": ["DUR"], "orgs": ["TB"], "levels": ["AAA"]}


def test_promoted_pitcher_reports_mlb_roster_and_no_level(monkeypatch):
    _stub_people(monkeypatch, {7: {"currentTeam": {"id": 139, "name": "Tampa Bay Rays"}}})
    rows = [{"pitcher_id": 7, "teams": ["DUR"], "orgs": ["TB"], "levels": ["AAA"]}]

    mlb_status.tag_current_team(rows)

    assert rows[0]["mlb_roster"] is True
    # Absent, not null — `mlb_roster` is what carries "he's up", and the pool
    # can't afford a dead key per player.
    assert "team_level" not in rows[0]
    # The MiLB level history is untouched: `levels` is where he PITCHED.
    assert rows[0]["levels"] == ["AAA"]


def test_a_stale_level_tag_is_cleared_on_promotion(monkeypatch):
    # Re-tagging an already-tagged row must not leave the old level behind.
    _stub_people(monkeypatch, {7: {"currentTeam": {"id": 139, "name": "Tampa Bay Rays"}}})
    rows = [{"pitcher_id": 7, "teams": ["DUR"], "team_level": "AAA", "team": "DUR"}]

    mlb_status.tag_current_team(rows)

    assert "team_level" not in rows[0]
    assert rows[0]["mlb_roster"] is True


def test_lookups_are_batched_and_then_cached(monkeypatch):
    people = {pid: {"currentTeam": {"id": 234, "name": "Durham Bulls"}} for pid in range(250)}
    calls = _stub_people(monkeypatch, people)

    first = mlb_status.get_current_teams(range(250))
    assert len(first) == 250
    assert sorted(len(c) for c in calls) == [50, 100, 100]

    calls.clear()
    again = mlb_status.get_current_teams(range(250))
    assert again == first
    assert calls == []  # served entirely from the per-player cache


def test_refresh_bypasses_the_cache(monkeypatch):
    calls = _stub_people(monkeypatch, {7: {"currentTeam": {"id": 234, "name": "Durham Bulls"}}})
    mlb_status.get_current_teams([7])
    assert len(calls) == 1

    # Deadline day: a six-hour-old answer is not good enough.
    mlb_status.get_current_teams([7], refresh=True)
    assert len(calls) == 2


def test_empty_input_never_touches_the_network(monkeypatch):
    calls = _stub_people(monkeypatch, {})
    assert mlb_status.get_current_teams([]) == {}
    assert mlb_status.get_current_teams([None]) == {}
    assert calls == []


@pytest.mark.parametrize("values,current,expected", [
    (["DUR"], "SWB", ["SWB", "DUR"]),
    (["DUR", "SWB"], "SWB", ["SWB", "DUR"]),
    ([], "SWB", ["SWB"]),
    (["DUR"], None, ["DUR"]),
    (None, "SWB", ["SWB"]),
    ([None, "", "DUR"], "SWB", ["SWB", "DUR"]),
])
def test_current_first_ordering(values, current, expected):
    assert mlb_status._current_first(values, current) == expected
