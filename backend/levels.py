"""Minor-league level registry: sportIds, schedules, and MLB-org mapping.

Everything level-aware in this build routes through here so there is exactly one
place that knows "AAA means sportId 11". MLB (sportId 1) is deliberately absent:
this dashboard never shows major-league games.

Only AAA and AFL have Statcast pitch data (see STATCAST_LEVELS). Every other
level is box-score only and renders the adapted results table.
"""
import threading
import time

import requests

from season import now_et

# Level code -> sportId + display metadata. `order` drives "highest level first"
# ordering on team pages; the codes themselves are what the UI passes around.
LEVELS = {
    "AAA": {"sport_id": 11, "label": "Triple-A", "order": 1},
    "AA":  {"sport_id": 12, "label": "Double-A", "order": 2},
    "A+":  {"sport_id": 13, "label": "High-A",   "order": 3},
    "A":   {"sport_id": 14, "label": "Single-A", "order": 4},
    "R":   {"sport_id": 16, "label": "Rookie",   "order": 5},
    # The AFL shares sportId 17 with other fall/winter circuits, so it also
    # needs leagueId=119 to isolate it.
    "AFL": {"sport_id": 17, "league_id": 119, "label": "Arizona Fall League", "order": 6},
}

# Display order for dropdowns and affiliate stacks: highest level first.
LEVEL_ORDER = ["AAA", "AA", "A+", "A", "R", "AFL"]

# Levels with Savant Statcast coverage — i.e. the only levels that get pitch
# tables, plots and game cards. Everything else is box-score only.
STATCAST_LEVELS = ("AAA", "AFL")

DEFAULT_LEVEL = "AAA"

# Pseudo-level for the daily leaderboard's "All Levels" filter: every level's
# pitchers on one date, in one table.
#
# It is NOT a member of LEVELS and never will be — it has no sportId, no
# schedule and no team map, so nothing that resolves a level can accept it.
# That makes the ordering rule below load-bearing: normalize_level() coerces
# anything it does not recognise to AAA, so an endpoint that normalizes BEFORE
# asking is_all_levels() answers an all-levels request with Triple-A only, and
# does it silently. Guard first, normalize second.
ALL_LEVELS = "ALL"
ALL_LEVELS_LABEL = "All Levels"

_ALL_LEVEL_ALIASES = frozenset({"ALL", "ALL LEVELS", "ALL-LEVELS", "ALL_LEVELS"})

SPORT_ID_TO_LEVEL = {cfg["sport_id"]: code for code, cfg in LEVELS.items()}

_SCHEDULE_URL = (
    "https://statsapi.mlb.com/api/v1/schedule?sportId={sport_id}{league}"
    "&gameType=R&gameType=PO&startDate={date}&endDate={date}"
    "&hydrate=team,probablePitcher,linescore"
)

_TEAMS_URL = "https://statsapi.mlb.com/api/v1/teams?sportId={sport_id}&season={season}"


def is_all_levels(level):
    """True for the "All Levels" pseudo-level. Ask this BEFORE normalize_level
    — see the note on ALL_LEVELS for why the order matters."""
    return str(level or "").strip().upper() in _ALL_LEVEL_ALIASES


def normalize_level(level):
    """Coerce any user/query input to a known level code (default AAA).

    Deliberately has no idea about ALL_LEVELS: "every level" is not a level,
    and returning it here would hand a sportId lookup something with no sportId.
    """
    if not level:
        return DEFAULT_LEVEL
    code = str(level).strip().upper()
    if code in LEVELS:
        return code
    # Tolerate the sportId itself and a few obvious aliases.
    aliases = {"HIGH-A": "A+", "SINGLE-A": "A", "ROOKIE": "R", "TRIPLE-A": "AAA", "DOUBLE-A": "AA"}
    if code in aliases:
        return aliases[code]
    try:
        return SPORT_ID_TO_LEVEL.get(int(code), DEFAULT_LEVEL)
    except (ValueError, TypeError):
        return DEFAULT_LEVEL


def is_statcast_level(level):
    return normalize_level(level) in STATCAST_LEVELS


def level_sort_key(level):
    return LEVELS.get(normalize_level(level), {}).get("order", 99)


def schedule_url(date_str, level):
    cfg = LEVELS[normalize_level(level)]
    league = f"&leagueId={cfg['league_id']}" if cfg.get("league_id") else ""
    return _SCHEDULE_URL.format(sport_id=cfg["sport_id"], league=league, date=date_str)


# ── MLB parent-org map ─────────────────────────────────────────────────────
# /api/v1/teams?sportId=N carries parentOrgName/parentOrgId for every affiliate.
# Cached for the process lifetime (affiliations change once a year at most).

_ORG_LOCK = threading.Lock()
_ORG_CACHE = {"ts": 0.0, "by_id": {}, "by_abbrev": {}}
_ORG_TTL = 24 * 3600

# parentOrgName -> the abbreviation the rest of the app uses for an MLB org.
ORG_ABBREV = {
    "Arizona Diamondbacks": "AZ", "Atlanta Braves": "ATL", "Baltimore Orioles": "BAL",
    "Boston Red Sox": "BOS", "Chicago Cubs": "CHC", "Chicago White Sox": "CWS",
    "Cincinnati Reds": "CIN", "Cleveland Guardians": "CLE", "Colorado Rockies": "COL",
    "Detroit Tigers": "DET", "Houston Astros": "HOU", "Kansas City Royals": "KC",
    "Los Angeles Angels": "LAA", "Los Angeles Dodgers": "LAD", "Miami Marlins": "MIA",
    "Milwaukee Brewers": "MIL", "Minnesota Twins": "MIN", "New York Mets": "NYM",
    "New York Yankees": "NYY", "Athletics": "ATH", "Oakland Athletics": "ATH",
    "Philadelphia Phillies": "PHI", "Pittsburgh Pirates": "PIT", "San Diego Padres": "SD",
    "San Francisco Giants": "SF", "Seattle Mariners": "SEA", "St. Louis Cardinals": "STL",
    "Tampa Bay Rays": "TB", "Texas Rangers": "TEX", "Toronto Blue Jays": "TOR",
    "Washington Nationals": "WSH",
}

# Reverse lookup for routing team pages by org abbreviation.
ABBREV_TO_ORG = {v: k for k, v in ORG_ABBREV.items() if v != "ATH" or k == "Athletics"}


def _fetch_org_map():
    """Build {team_id: meta} and {(level, abbrev): meta} across every level.

    `meta` = {team_id, name, abbrev, level, org, org_name}. AFL clubs report a
    parentOrgName of "Office of the Commissioner" (they are stocked from many
    systems), so their `org` is None and callers fall back to the level tag.
    """
    season = now_et().year
    by_id, by_abbrev = {}, {}
    for code, cfg in LEVELS.items():
        try:
            resp = requests.get(
                _TEAMS_URL.format(sport_id=cfg["sport_id"], season=season), timeout=15
            )
            resp.raise_for_status()
            teams = resp.json().get("teams", [])
        except Exception as e:
            print(f"[Levels] org map fetch failed for {code}: {e}")
            continue
        for t in teams:
            org_name = t.get("parentOrgName") or ""
            meta = {
                "team_id": t.get("id"),
                "name": t.get("name") or "",
                "abbrev": t.get("abbreviation") or "",
                "level": code,
                "org": ORG_ABBREV.get(org_name),
                "org_name": org_name if org_name in ORG_ABBREV else None,
            }
            if meta["team_id"] is not None:
                by_id[int(meta["team_id"])] = meta
            if meta["abbrev"]:
                # Keyed by (level, abbrev): MiLB abbreviations are NOT unique
                # across levels (e.g. COL = Columbia Fireflies at A, and is also
                # the Rockies' MLB abbrev).
                by_abbrev[(code, meta["abbrev"])] = meta
    return by_id, by_abbrev


def _org_maps():
    now = time.time()
    with _ORG_LOCK:
        if _ORG_CACHE["by_id"] and (now - _ORG_CACHE["ts"]) < _ORG_TTL:
            return _ORG_CACHE["by_id"], _ORG_CACHE["by_abbrev"]
    by_id, by_abbrev = _fetch_org_map()
    if by_id:
        with _ORG_LOCK:
            _ORG_CACHE.update({"ts": now, "by_id": by_id, "by_abbrev": by_abbrev})
    return by_id, by_abbrev


def team_meta_by_id(team_id):
    if team_id is None:
        return None
    by_id, _ = _org_maps()
    return by_id.get(int(team_id))


def team_meta_by_abbrev(abbrev, level=None):
    """Look up an affiliate by abbreviation. Prefers the given level, then
    scans the rest highest-level-first so a bare abbrev still resolves."""
    if not abbrev:
        return None
    _, by_abbrev = _org_maps()
    if level:
        hit = by_abbrev.get((normalize_level(level), abbrev))
        if hit:
            return hit
    for code in LEVEL_ORDER:
        hit = by_abbrev.get((code, abbrev))
        if hit:
            return hit
    return None


def team_display_name(team_id=None, abbrev=None, level=None):
    """Official team name + (MLB org, Level), e.g. 'Durham Bulls (TB, AAA)'.

    Falls back to '<name> (AAA)' when the org is unknown (AFL clubs) and to the
    bare abbreviation when the team isn't in the map at all.
    """
    meta = team_meta_by_id(team_id) if team_id is not None else None
    if meta is None:
        meta = team_meta_by_abbrev(abbrev, level)
    if meta is None:
        return abbrev or ""
    lvl = meta.get("level") or normalize_level(level)
    if meta.get("org"):
        return f"{meta['name']} ({meta['org']}, {lvl})"
    return f"{meta['name']} ({lvl})"


def org_for_team(team_id=None, abbrev=None, level=None):
    """MLB org abbreviation for an affiliate, or None (AFL / unmapped)."""
    meta = team_meta_by_id(team_id) if team_id is not None else None
    if meta is None:
        meta = team_meta_by_abbrev(abbrev, level)
    return (meta or {}).get("org")


def affiliates_for_org(org_abbrev):
    """Every affiliate of an MLB org, highest level first. AFL is excluded —
    its clubs have no parent org."""
    by_id, _ = _org_maps()
    rows = [m for m in by_id.values() if m.get("org") == org_abbrev]
    rows.sort(key=lambda m: (level_sort_key(m["level"]), m["name"]))
    return rows


def all_orgs():
    """Sorted list of MLB org abbreviations that have affiliates."""
    by_id, _ = _org_maps()
    return sorted({m["org"] for m in by_id.values() if m.get("org")})
