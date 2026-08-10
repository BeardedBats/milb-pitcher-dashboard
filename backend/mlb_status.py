"""MLB-side lookups: big-league experience, injured-list status, current club.

Everything else in this app deliberately ignores sportId 1. These features are
the exception — each is a question ABOUT the major-league side asked of
minor-league pitchers:

  * has this pitcher ever debuted in the majors?  (name highlight)
  * is he on an MLB injured list right now?       (Rehab SP view)
  * which club is he on RIGHT NOW?                (player pool / current team)

No major-league games or stats are ever displayed; only these flags cross the
boundary.
"""
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

from redis_cache import redis_get, redis_set

_PEOPLE_URL = "https://statsapi.mlb.com/api/v1/people?personIds={ids}"
_MLB_TEAMS_URL = "https://statsapi.mlb.com/api/v1/teams?sportId=1&season={season}"
_ROSTER_URL = (
    "https://statsapi.mlb.com/api/v1/teams/{team_id}/roster"
    "?rosterType=fullRoster&season={season}"
)
_BY_DATE_RANGE_URL = (
    "https://statsapi.mlb.com/api/v1/stats?stats=byDateRange&group=pitching"
    "&sportId={sport_id}&startDate={start}&endDate={end}&playerPool=ALL&limit=2000"
)

_PREFIX = "mlbstatus"

# A debut date is immutable once set, so this caches hard. The only churn is
# players debuting mid-season, which a day's TTL picks up.
_DEBUT_TTL = 24 * 3600
# Roster/IL status moves daily; an hour keeps the Rehab view current without
# hammering 30 endpoints.
_ROSTER_TTL = 3600
# Current club moves on every transaction — and in the days around the trade
# deadline it moves in bursts. Six hours bounds how stale the player pool can
# be between the nightly rebuild and the manual refresh endpoint.
_CURRENT_TEAM_TTL = 6 * 3600

# status.code values that mean "on an injured list". RA (Rehab Assignment) is
# included because that is precisely the state this feature is looking for —
# MLB flips a player to RA while he is out on a minor-league rehab stint, so
# excluding it would drop the very pitchers the view exists to show.
IL_STATUS_CODES = frozenset({"D7", "D10", "D15", "D60", "ILF", "RA"})

_debut_cache = {}     # {pitcher_id: bool}
_debut_lock = threading.Lock()
_roster_cache = {"ts": 0.0, "data": None}
_roster_lock = threading.Lock()
_current_team_cache = {}   # {pitcher_id: (timestamp, resolved dict)}
_current_team_lock = threading.Lock()


def _l2_get(key):
    try:
        return redis_get(key)
    except Exception:
        return None


def _l2_set(key, value, ttl):
    try:
        redis_set(key, value, ttl=ttl)
    except Exception:
        pass


# ── MLB experience ─────────────────────────────────────────────────────────

def get_mlb_experience(pitcher_ids):
    """{pitcher_id: bool} — has this pitcher ever debuted in the majors?

    `mlbDebutDate` on the person record is the signal: present for anyone who
    has appeared in an MLB game, absent otherwise. Fetched in batches of 100
    (the same batching the batter-name lookup uses) and cached per player, so
    a full slate costs at most a couple of requests and usually zero.
    """
    ids = {int(p) for p in (pitcher_ids or []) if p is not None}
    if not ids:
        return {}
    out, missing = {}, []
    with _debut_lock:
        for pid in ids:
            if pid in _debut_cache:
                out[pid] = _debut_cache[pid]
            else:
                missing.append(pid)
    if missing:
        # L2 before hitting the API.
        still = []
        for pid in missing:
            cached = _l2_get(f"{_PREFIX}:debut:{pid}")
            if cached is None:
                still.append(pid)
            else:
                out[pid] = bool(cached.get("v") if isinstance(cached, dict) else cached)
                with _debut_lock:
                    _debut_cache[pid] = out[pid]
        for i in range(0, len(still), 100):
            batch = still[i:i + 100]
            try:
                resp = requests.get(
                    _PEOPLE_URL.format(ids=",".join(str(x) for x in batch)), timeout=20
                )
                resp.raise_for_status()
                people = resp.json().get("people") or []
            except Exception as e:
                print(f"[MLBStatus] debut lookup failed for {len(batch)} ids: {e}")
                continue
            seen = set()
            for p in people:
                pid = int(p["id"])
                seen.add(pid)
                val = bool(p.get("mlbDebutDate"))
                out[pid] = val
                with _debut_lock:
                    _debut_cache[pid] = val
                _l2_set(f"{_PREFIX}:debut:{pid}", {"v": val}, _DEBUT_TTL)
            # Anyone the API didn't return is treated as no-debut, but is NOT
            # cached — an API hiccup shouldn't permanently mark a big leaguer
            # as minors-only.
            for pid in batch:
                out.setdefault(pid, False)
    return out


def tag_mlb_experience(rows, id_key="pitcher_id", flag="mlb_exp"):
    """Set `mlb_exp` on every row in place. One bulk lookup for the whole list."""
    if not rows:
        return rows
    ids = [r.get(id_key) for r in rows if r.get(id_key) is not None]
    exp = get_mlb_experience(ids)
    for r in rows:
        pid = r.get(id_key)
        if pid is not None:
            r[flag] = bool(exp.get(int(pid), False))
    return rows


# ── Current club (the player pool's team mapping) ──────────────────────────
#
# WHY THIS IS NOT "the level of the last game".
#
# `current_level` is defined as the level of the pitcher's most recent
# appearance, and that rule stays exactly as it is. It cannot answer "who does
# this pitcher belong to?" though: a prospect traded at the deadline keeps a
# last game played for his OLD org until he takes the ball for the new one,
# which in practice can be a week or more (and for an injured player, never).
#
# The person record's `currentTeam` is the transaction feed's answer and flips
# the day the trade is processed, so it — not the game log — is what maps a
# player to his current club.


def _resolve_current_team(team):
    """Turn a person record's `currentTeam` into our (team, level, org) shape.

    Three cases, all real:
      * a MiLB affiliate  -> found in the level registry, org comes with it;
      * an MLB club       -> absent from the registry (sportId 1 is excluded
        everywhere), so the org is read off the club name instead and `level`
        stays None — the player is in the majors, not at a level this app
        covers;
      * anything else (foreign/independent clubs, a blank record) -> name only.
    """
    from levels import ORG_ABBREV, team_meta_by_id

    if not isinstance(team, dict):
        return None
    team_id = team.get("id")
    name = (team.get("name") or "").strip()
    meta = team_meta_by_id(team_id) if team_id is not None else None
    if meta:
        return {
            "team_id": int(meta["team_id"]),
            "team_name": meta.get("name") or name,
            "team": meta.get("abbrev") or "",
            "level": meta.get("level"),
            "org": meta.get("org"),
            "mlb_roster": False,
        }
    if not team_id and not name:
        return None
    org = ORG_ABBREV.get(name)
    return {
        "team_id": int(team_id) if team_id is not None else None,
        "team_name": name,
        # An MLB club has no MiLB abbreviation; the org abbrev is the sensible
        # display token ("TB"). `level` stays None rather than becoming "MLB":
        # every level string in this app is a registry code, and normalize_level
        # would silently coerce an unknown one to AAA. The flag carries the fact
        # instead.
        "team": org or "",
        "level": None,
        "org": org,
        "mlb_roster": bool(org),
    }


def _fetch_current_teams(batch):
    """One people call for up to 100 ids -> {pitcher_id: resolved dict}."""
    try:
        resp = requests.get(
            _PEOPLE_URL.format(ids=",".join(str(x) for x in batch)), timeout=20
        )
        resp.raise_for_status()
        people = resp.json().get("people") or []
    except Exception as e:
        print(f"[MLBStatus] currentTeam lookup failed for {len(batch)} ids: {e}")
        return {}
    out = {}
    for p in people:
        try:
            pid = int(p["id"])
        except (KeyError, TypeError, ValueError):
            continue
        resolved = _resolve_current_team(p.get("currentTeam"))
        if resolved:
            out[pid] = resolved
        # The same payload carries mlbDebutDate, so fill the debut cache for
        # free rather than paying for a second sweep of the same 100 players.
        debut = bool(p.get("mlbDebutDate"))
        with _debut_lock:
            _debut_cache[pid] = debut
        _l2_set(f"{_PREFIX}:debut:{pid}", {"v": debut}, _DEBUT_TTL)
    return out


def get_current_teams(pitcher_ids, refresh=False, deadline=None):
    """{pitcher_id: {team_id, team_name, team, level, org}} — where each pitcher
    is RIGHT NOW, per the MLB transaction feed.

    Batched 100 ids to a request (the people endpoint's practical limit) and
    cached per player, so the nightly directory rebuild costs ~45 requests for
    the whole player pool and every later reader costs zero.

    `refresh=True` bypasses both cache tiers — that is the trade-deadline
    button, for when a 6-hour-old mapping is not good enough. `deadline` caps
    how long the sweep may run: past it, the players not yet resolved are
    simply omitted, which degrades the pool to its season history rather than
    failing the caller outright.
    """
    ids = {int(p) for p in (pitcher_ids or []) if p is not None}
    if not ids:
        return {}
    out, missing = {}, []
    now = time.time()
    if refresh:
        missing = sorted(ids)
    else:
        with _current_team_lock:
            for pid in sorted(ids):
                hit = _current_team_cache.get(pid)
                if hit and (now - hit[0]) < _CURRENT_TEAM_TTL:
                    out[pid] = hit[1]
                else:
                    missing.append(pid)
        still = []
        for pid in missing:
            cached = _l2_get(f"{_PREFIX}:curteam:{pid}")
            if isinstance(cached, dict) and cached:
                out[pid] = cached
                with _current_team_lock:
                    _current_team_cache[pid] = (now, cached)
            else:
                still.append(pid)
        missing = still

    batches = [missing[i:i + 100] for i in range(0, len(missing), 100)]
    if batches:
        pool = ThreadPoolExecutor(max_workers=6)
        try:
            futures = [pool.submit(_fetch_current_teams, b) for b in batches]
            for f in as_completed(futures):
                if deadline is not None and time.time() >= deadline:
                    print("[MLBStatus] deadline hit, deferring remaining current-team batches")
                    break
                try:
                    fetched = f.result() or {}
                except Exception:
                    continue
                stamp = time.time()
                for pid, resolved in fetched.items():
                    out[pid] = resolved
                    with _current_team_lock:
                        _current_team_cache[pid] = (stamp, resolved)
                    _l2_set(f"{_PREFIX}:curteam:{pid}", resolved, _CURRENT_TEAM_TTL)
        finally:
            # Same rule as prefetch_boxscores: when bounded, never block on
            # in-flight requests past the caller's budget. A serverless
            # instance is frozen the moment it responds, so waiting on the
            # remaining batches only burns the cron's remaining seconds.
            pool.shutdown(wait=(deadline is None))
    return out


def tag_current_team(rows, id_key="pitcher_id", refresh=False, deadline=None):
    """Stamp `team`/`org`/`team_name` on directory rows and reorder their
    season history so the CURRENT club leads.

    The history lists (`teams`, `orgs`, `levels`) are kept intact — a traded
    pitcher's old affiliate is still where half his season happened, and the
    org pages need it. Only the ordering changes, plus the explicit current-*
    fields the UI reads.

    Rows whose current club can't be resolved are left exactly as they were:
    an unknown mapping must not overwrite a known-good season history.
    """
    if not rows:
        return rows
    current = get_current_teams(
        [r.get(id_key) for r in rows if r.get(id_key) is not None],
        refresh=refresh,
        deadline=deadline,
    )
    for r in rows:
        pid = r.get(id_key)
        if pid is None:
            continue
        info = current.get(int(pid))
        if not info:
            continue
        team, org, level = info.get("team"), info.get("org"), info.get("level")
        if team:
            r["team"] = team
        if org:
            r["org"] = org
        if info.get("team_name"):
            r["team_name"] = info["team_name"]
        # The level of the club he is on now — deliberately NOT `current_level`,
        # which is defined elsewhere as the level of his last game and must
        # keep meaning exactly that.
        #
        # Absent rather than null when there is no MiLB level to report, so the
        # directory doesn't carry ~4,500 dead keys; `mlb_roster` is what says
        # "he's up", and it is likewise only present when true.
        if level:
            r["team_level"] = level
        else:
            r.pop("team_level", None)
        if info.get("mlb_roster"):
            r["mlb_roster"] = True
        else:
            r.pop("mlb_roster", None)
        r["teams"] = _current_first(r.get("teams"), team)
        r["orgs"] = _current_first(r.get("orgs"), org)
        if level:
            r["levels"] = _current_first(r.get("levels"), level)
    return rows


def _current_first(values, current):
    """`values` with `current` moved to the front (added if absent)."""
    items = [v for v in (values or []) if v]
    if not current:
        return items
    return [current] + [v for v in items if v != current]


# ── Injured list ───────────────────────────────────────────────────────────

def _mlb_team_ids(season):
    try:
        resp = requests.get(_MLB_TEAMS_URL.format(season=season), timeout=20)
        resp.raise_for_status()
        return [t["id"] for t in resp.json().get("teams", []) if t.get("id")]
    except Exception as e:
        print(f"[MLBStatus] MLB team list failed: {e}")
        return []


def _roster_for_team(team_id, season):
    try:
        resp = requests.get(_ROSTER_URL.format(team_id=team_id, season=season), timeout=20)
        resp.raise_for_status()
        return resp.json().get("roster") or []
    except Exception as e:
        print(f"[MLBStatus] roster failed for {team_id}: {e}")
        return []


def get_il_pitchers(season):
    """{pitcher_id: {name, status, status_code, org_team_id, org_name}} for every
    PITCHER on an MLB injured list across all 30 clubs.

    Uses rosterType=fullRoster, which includes the organization's minor leaguers
    too — so the caller must still require MLB experience to distinguish a
    rehabbing big leaguer from an injured prospect.
    """
    season = int(season)
    now = time.time()
    with _roster_lock:
        if _roster_cache["data"] is not None and (now - _roster_cache["ts"]) < _ROSTER_TTL:
            return _roster_cache["data"]
    cached = _l2_get(f"{_PREFIX}:il:{season}")
    if cached is not None:
        restored = {int(k): v for k, v in cached.items()}
        with _roster_lock:
            _roster_cache.update({"ts": now, "data": restored})
        return restored

    team_ids = _mlb_team_ids(season)
    out = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        futures = {pool.submit(_roster_for_team, tid, season): tid for tid in team_ids}
        for f in as_completed(futures):
            try:
                roster = f.result() or []
            except Exception:
                continue
            for entry in roster:
                status = entry.get("status") or {}
                if status.get("code") not in IL_STATUS_CODES:
                    continue
                pos = (entry.get("position") or {}).get("abbreviation")
                if pos != "P":
                    continue
                person = entry.get("person") or {}
                pid = person.get("id")
                if pid is None:
                    continue
                team = entry.get("parentTeamId") or futures[f]
                out[int(pid)] = {
                    "name": person.get("fullName") or "",
                    "status": status.get("description") or "",
                    "status_code": status.get("code"),
                    "mlb_team_id": team,
                }
    if out:
        with _roster_lock:
            _roster_cache.update({"ts": now, "data": out})
        _l2_set(f"{_PREFIX}:il:{season}", {str(k): v for k, v in out.items()}, _ROSTER_TTL)
    return out


def get_starters_in_range(sport_id, start_date, end_date):
    """{pitcher_id: games_started} for one level over a date range.

    One request covers every pitcher at that level for the whole window, which
    is what makes the Rehab view cheap: six calls narrow thousands of pitchers
    to a few hundred starters before any per-player work happens.
    """
    key = f"{_PREFIX}:starters:{sport_id}:{start_date}:{end_date}"
    cached = _l2_get(key)
    if cached is not None:
        return {int(k): v for k, v in cached.items()}
    url = _BY_DATE_RANGE_URL.format(sport_id=sport_id, start=start_date, end=end_date)
    out = {}
    try:
        resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[MLBStatus] byDateRange failed for sport {sport_id}: {e}")
        return {}
    for group in data.get("stats", []):
        for s in group.get("splits", []):
            gs = (s.get("stat") or {}).get("gamesStarted") or 0
            if gs < 1:
                continue
            pid = ((s.get("player") or {}).get("id"))
            if pid is not None:
                out[int(pid)] = int(gs)
    if out:
        _l2_set(key, {str(k): v for k, v in out.items()}, _ROSTER_TTL)
    return out
