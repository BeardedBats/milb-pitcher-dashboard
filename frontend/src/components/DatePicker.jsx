import React, { useRef } from "react";
import useIsMobile from "../hooks/useIsMobile";

/**
 * Click anywhere on the date field → opens the browser's native calendar
 * picker. Numbers cannot be edited inline — keyboard input is swallowed
 * other than Tab (focus traversal) and Enter / Space (re-open picker).
 *
 * Implementation notes:
 *  - We CANNOT use readOnly: Chrome hides the calendar-picker-indicator and
 *    showPicker() throws InvalidStateError on a readOnly input.
 *  - Instead: capture the mousedown BEFORE the input handles it, preventDefault
 *    so the input doesn't focus a date segment, and call showPicker() ourselves.
 *  - All keypresses get preventDefault'd (except Tab) so users can't type
 *    digits into the segments after tabbing in.
 *  - On touch devices this interception is SKIPPED: preventDefault on the tap
 *    suppresses iOS's native date picker, and showPicker()/focus() don't open
 *    it there — so tapping would do nothing. Letting the native <input type=
 *    date> handle the tap opens the iOS wheel as expected.
 */
export default function DatePicker({ date, onChange }) {
  const inputRef = useRef(null);
  const isMobile = useIsMobile();

  const openPicker = () => {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === "function") {
      try {
        el.showPicker();
        return;
      } catch {
        // Safari prior to 16 throws here — fall through to focus.
      }
    }
    el.focus();
  };

  return (
    <div className="date-picker">
      <input
        ref={inputRef}
        type="date"
        value={date || ""}
        onChange={e => onChange(e.target.value)}
        onMouseDown={isMobile ? undefined : e => {
          // Intercept before the input's native segment-select kicks in.
          e.preventDefault();
          openPicker();
        }}
        onKeyDown={isMobile ? undefined : e => {
          if (e.key === "Tab") return;
          e.preventDefault();
          if (e.key === "Enter" || e.key === " ") openPicker();
        }}
        onPaste={e => e.preventDefault()}
      />
    </div>
  );
}
