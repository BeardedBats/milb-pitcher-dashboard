"""Season constants and pure helpers shared by app.py, data.py, aggregation.py.

This module must stay dependency-free (stdlib only) so any backend module can
import it without creating an import cycle.
"""
import unicodedata
import zoneinfo
from datetime import datetime

# First day of the regular-season window every season query uses. The month/day
# is stable across the codebase; only the year rolls over. Update SEASON_START
# once a year (the frontend mirrors it in api.js / PitcherCard.jsx /
# PlayerPage.jsx — see CLAUDE.md "Season Date Range").
SEASON_START_MD = "03-25"
SEASON_START = f"2026-{SEASON_START_MD}"

ET_ZONE = zoneinfo.ZoneInfo("America/New_York")


def season_start(year):
    """Season start date (YYYY-MM-DD) for a given year."""
    return f"{int(year)}-{SEASON_START_MD}"


def now_et():
    """Current time in US Eastern (the baseball clock)."""
    return datetime.now(ET_ZONE)


def strip_accents(s):
    """Remove accent marks (é→e, ñ→n) and soft hyphens for name matching."""
    if not s:
        return ""
    return "".join(
        c for c in unicodedata.normalize("NFKD", s)
        if not unicodedata.combining(c)
    ).replace("­", "")  # also drop soft hyphens


def ip_to_outs(ip_val):
    """Parse an MLB innings-pitched value ('7.1' = 7⅓ IP) into outs/thirds.

    Accepts strings, ints, floats, or None. Returns 0 for anything unparseable.
    """
    if ip_val is None:
        return 0
    try:
        parts = str(ip_val).split(".")
        whole = int(parts[0]) if parts[0] else 0
        thirds = int(parts[1]) if len(parts) > 1 and parts[1] else 0
        return whole * 3 + thirds
    except (ValueError, TypeError):
        return 0


def aggregate_game_log_to_totals(game_log):
    """Aggregate a list of per-game stat dicts into a season-totals dict.

    Pure function — no caching, no fetching. Returns {} for an empty/falsy log.
    The single source of truth for season-totals math (box-score season row,
    player-page results summary).
    """
    if not game_log:
        return {}
    total_pitches = sum(g.get("pitches", 0) for g in game_log)
    total_ip_thirds = sum(ip_to_outs(g.get("ip", "0.0")) for g in game_log)
    total_whiffs = sum(g.get("whiffs", 0) for g in game_log)
    total_strikes = sum(g.get("strikes", 0) for g in game_log)
    total_runs = sum(g.get("runs", 0) for g in game_log)
    total_batters_faced = sum(g.get("batters_faced", 0) for g in game_log)
    total_games_started = sum(g.get("games_started", 0) for g in game_log)
    total_pa_count = sum(g.get("pa_count", 0) for g in game_log)
    total_two_str_pas = sum(g.get("two_strike_pas", 0) for g in game_log)
    total_two_str_pitches = sum(g.get("two_strike_pitches", 0) for g in game_log)
    total_strikeouts_par = sum(g.get("strikeouts_for_par", 0) for g in game_log)
    last_game_date = max((g.get("date") or "" for g in game_log), default="")
    win_game_pks = sorted(
        int(g.get("game_pk"))
        for g in game_log
        if g.get("decision") == "W" and g.get("game_pk") is not None
    )
    loss_game_pks = sorted(
        int(g.get("game_pk"))
        for g in game_log
        if g.get("decision") == "L" and g.get("game_pk") is not None
    )
    return {
        "games": len(game_log),
        "game_pks": sorted(g.get("game_pk") for g in game_log if g.get("game_pk") is not None),
        "games_started": total_games_started,
        "ip": f"{total_ip_thirds // 3}.{total_ip_thirds % 3}",
        "ip_thirds": total_ip_thirds,
        "hits": sum(g.get("hits", 0) for g in game_log),
        "bbs": sum(g.get("bbs", 0) for g in game_log),
        "ks": sum(g.get("ks", 0) for g in game_log),
        "hrs": sum(g.get("hrs", 0) for g in game_log),
        "er": sum(g.get("er", 0) for g in game_log),
        "runs": total_runs,
        "batters_faced": total_batters_faced,
        "whiffs": total_whiffs,
        "strikes": total_strikes,
        "swstr_pct": round(total_whiffs / total_pitches * 100, 2) if total_pitches > 0 else 0,
        "csw_pct": round(sum(g.get("csw_pct", 0) * g.get("pitches", 0) for g in game_log) / total_pitches, 2) if total_pitches > 0 else 0,
        "strike_pct": round(total_strikes / total_pitches * 100, 2) if total_pitches > 0 else 0,
        "two_str_pct": round(total_two_str_pas / total_pa_count * 100, 2) if total_pa_count > 0 else 0,
        # PAR%: strikeouts / batters faced who reached a two-strike count.
        "par_pct": round(sum(g.get("ks", 0) for g in game_log) / total_two_str_pas * 100, 2) if total_two_str_pas > 0 else 0,
        "pitches": total_pitches,
        "pa_count": total_pa_count,
        "two_strike_pas": total_two_str_pas,
        "two_strike_pitches": total_two_str_pitches,
        "strikeouts_for_par": total_strikeouts_par,
        "wins": len(win_game_pks),
        "losses": len(loss_game_pks),
        "win_game_pks": win_game_pks,
        "loss_game_pks": loss_game_pks,
        "last_game_date": last_game_date or None,
    }
