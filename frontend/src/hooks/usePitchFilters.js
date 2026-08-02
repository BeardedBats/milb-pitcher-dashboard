import { useMemo, useState } from "react";
import { RESULT_FILTER_OPTIONS } from "../utils/pitchFilters";

// Shared pitch-filter state for the card and season views (PitcherCard,
// PlayerPage). Centralizes the filter atoms and selection logic that were
// copy-pasted between them, byte-for-byte:
//   - simple filters: pitchTypeFilter, resultFilter, contactFilter, batterFilter
//   - row-click pitch-type selection: selectedPitchTypes + toggle/clear, where
//     "all selected" collapses to "none selected" (== no filter)
//   - derived: effectivePitchTypeFilter, effectiveResultFilter (null == all)
//
// The hook takes `availablePitchTypes` because each view derives it differently
// (the card from its game's pitches; the season page from pitches narrowed by
// the game filter).
//
// Two pieces intentionally stay in the views, not here:
//   - gameFilter: only PlayerPage has it, and its `availablePitchTypes` depends
//     on it — owning it here would create a hook-arg cycle. PitcherCard has no
//     game filter (single game) and uses an inning filter instead.
//   - filteredPitches: the two views filter on different dimensions (card by
//     inning, season page by game), so a single shared filter would change
//     behavior. This hook owns the duplicated *state*, not the per-view filter.
export default function usePitchFilters(availablePitchTypes = []) {
  const [pitchTypeFilter, setPitchTypeFilter] = useState(null);
  const [resultFilter, setResultFilter] = useState(null);
  const [contactFilter, setContactFilter] = useState("all");
  const [batterFilter, setBatterFilter] = useState("all");
  // Pitch types selected by clicking rows in the pitch data / results / usage
  // tables. A non-empty Set filters the plots AND the totals row. Empty = no
  // filter.
  const [selectedPitchTypes, setSelectedPitchTypes] = useState(() => new Set());

  // null means "all" — lazily expand to the full set of available types.
  const effectivePitchTypeFilter = useMemo(() => {
    if (pitchTypeFilter === null) return new Set(availablePitchTypes);
    return pitchTypeFilter;
  }, [pitchTypeFilter, availablePitchTypes]);

  const effectiveResultFilter = useMemo(() => {
    if (resultFilter === null) return new Set(RESULT_FILTER_OPTIONS);
    return resultFilter;
  }, [resultFilter]);

  // Toggle a pitch type via row-click. If toggling would select every available
  // pitch, clear the set instead — "all selected" and "none selected" both mean
  // "no filter".
  const toggleSelectedPitch = (type) => {
    if (!type) return;
    setSelectedPitchTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      if (availablePitchTypes.length > 0 && availablePitchTypes.every((t) => next.has(t))) {
        return new Set();
      }
      return next;
    });
  };
  const clearSelectedPitches = () => setSelectedPitchTypes(new Set());

  return {
    pitchTypeFilter, setPitchTypeFilter,
    resultFilter, setResultFilter,
    contactFilter, setContactFilter,
    batterFilter, setBatterFilter,
    selectedPitchTypes, setSelectedPitchTypes,
    effectivePitchTypeFilter, effectiveResultFilter,
    toggleSelectedPitch, clearSelectedPitches,
  };
}
