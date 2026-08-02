"""Process-local caches shared across backend modules.

Lives in its own dependency-free module so data.py and aggregation.py can both
reach the same dicts without importing each other's privates (the old
data ⇄ aggregation circular import).
"""

# { (pitcher_id, year, before_date): [game_dicts] } — per-game aggregates used
# by opener detection (aggregation._pitcher_season_game_aggregates) and
# invalidated per-pitcher by data.invalidate_pitcher_related_caches.
season_game_agg_cache = {}
