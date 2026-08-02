// Play-by-play result formatting — pure helpers shared by PlayByPlayModal and
// PitcherCard. No React imports.
//
// NOTE: this is the PlayByPlayModal variant of the formatter (force outs get a
// "(FC)" suffix). PitcherCard previously carried a near-identical copy that was
// dead code (never called), so consolidating here is behavior-preserving.

// Out-type result formatted with batted-ball trajectory.
//   field_out + ground_ball  -> "Groundout"
//   force_out + ground_ball   -> "Groundout (FC)"
//   fielders_choice(_out)     -> "Fielder's Choice"
//   catcher_interf            -> "Catcher Interference"
// Everything else is title-cased from the raw snake_case event.
export function formatPaResult(result, trajectory) {
  if (!result) return "";
  const r = result.toLowerCase();
  if ((r === "field_out" || r === "force_out" || r === "fielders_choice" || r === "fielders_choice_out") && trajectory) {
    const t = trajectory.toLowerCase();
    let outType = "";
    if (t === "ground_ball") outType = "Groundout";
    else if (t === "fly_ball") outType = "Flyout";
    else if (t === "line_drive") outType = "Lineout";
    else if (t === "popup") outType = "Pop Out";
    if (outType) {
      if (r === "force_out") return outType + " (FC)";
      if (r === "fielders_choice" || r === "fielders_choice_out") return "Fielder's Choice";
      return outType;
    }
  }
  if (r === "catcher_interf") return "Catcher Interference";
  return result.replace(/_/g, " ").replace(/\b\w/g, c => c.toUpperCase());
}

// True when a PA result is a strikeout (regular or strikeout-double-play).
export function isStrikeoutResult(result) {
  if (!result) return false;
  const r = result.toLowerCase();
  return r === "strikeout" || r === "strikeout_double_play";
}
