"""MLB-side lookups: big-league experience and injured-list / rehab status.

Everything else in this app deliberately ignores sportId 1. These two features
are the exception — both are questions ABOUT the major leagues asked of
minor-league pitchers:

  * has this pitcher ever debuted in the majors?  (name highlight)
  * is he on an MLB injured list right now?       (Rehab SP view)

No major-league games or stats are ever displayed; only these two flags cross
the boundary.
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

# status.code values that mean "on an injured list". RA (Rehab Assignment) is
# included because that is precisely the state this feature is looking for —
# MLB flips a player to RA while he is out on a minor-league rehab stint, so
# excluding it would drop the very pitchers the view exists to show.
IL_STATUS_CODES = frozenset({"D7", "D10", "D15", "D60", "ILF", "RA"})

_debut_cache = {}     # {pitcher_id: bool}
_debut_lock = threading.Lock()
_roster_cache = {"ts": 0.0, "data": None}
_roster_lock = threading.Lock()


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
