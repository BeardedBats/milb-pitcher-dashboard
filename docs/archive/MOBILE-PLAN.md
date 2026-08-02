# Mobile Responsive Design Plan

**Breakpoint:** `768px` — all changes apply at `max-width: 768px` only. Desktop is untouched.

---

## 1. Global / App Shell (`App.jsx`, `styles.css`)

| Element | Current | Mobile Change |
|---|---|---|
| App padding | `24px 32px` | `12px 12px` |
| `--content-width` | `1130px` | `100%` |
| Max-width on `.app` | `1600px` | `100%` |

**Header row** — currently a single horizontal flex row with: title, date picker, refresh button, team dropdown, search bar.

→ **Mobile:** Stack into two rows:
- **Row 1:** App title (left) + refresh button (right)
- **Row 2:** Date picker (left) + team dropdown (center) + search icon (right, expands to full-width overlay on tap)

**Search bar** — currently `180px` inline input expanding to `240px` on focus.

→ **Mobile:** Collapse to a magnifying glass icon. On tap, expand to a full-width overlay with the search input and results dropdown filling the screen width. Dropdown `min-width: 280px` → `100%`.

---

## 2. Game Tabs (`GameTabs.jsx`)

Currently `flex-wrap: wrap` with `min-width: 120px` per tab. Already wraps on narrow screens.

→ **Mobile:** Reduce tab `min-width` to `100px` and font size from `13px` → `12px`. Reduce horizontal padding from `12px` → `8px`. No other changes needed — wrapping behavior is already good.

---

## 3. Scoreboard (`Scoreboard.jsx`)

Small inline table with team names + inning columns + R/H/E. Already compact.

→ **Mobile:** If more than 9 innings, allow horizontal scroll on the inning cells only (team names stay visible). Reduce font size from `12px` → `11px`. No structural changes needed.

---

## 4. View Toggle & Filter Controls (Main Games View)

Currently: "All Pitcher Results" / "All Pitch Data" toggle buttons + "SP Only" / "Split by Team" / "Top 400 Only" checkboxes in a horizontal flex row.

→ **Mobile:** Convert the view toggle to a single dropdown `<select>` with two options. Keep the three filter checkboxes as compact pill toggles in a single row below it. Reduce padding/font size on pills.

---

## 5. Pitcher Results Table (`PitcherResultsTable.jsx`)

**Current:** 12 columns (Pitcher, Team, Hand, Opp, IP, ER, Hits, BB, K, CSW%, Whiffs, #). Total width ~800px.

→ **Mobile:**
- **Freeze the Pitcher column** — use `position: sticky; left: 0; z-index: 2;` on the first `<td>`/`<th>` so the pitcher name stays visible during horizontal scroll.
- Truncate pitcher names beyond ~14 characters with ellipsis.
- Remove the Hand column (already visible on player page).
- Keep horizontal scroll (`overflow-x: auto`) for remaining stat columns.
- Reduce cell padding from `8px 10px` → `6px 6px`.
- Font size from `13px` → `12px`.

**Split by Team (card mode):**
- Cards currently use `display: flex; flex-wrap: wrap` in a grid. Card width is computed from column widths (~600-800px).
- → **Mobile:** Cards go full-width (one per row), with horizontal scroll inside each card. Sticky pitcher name column still applies.

---

## 6. Pitch Data Table (`PitchDataTable.jsx`)

**Current:** 17 columns (Pitcher, Team, Hand, Opp, Pitch Type, Count, Velo, Usage, Usage vs R, Usage vs L, Ext, iVB, iHB, Strike%, CS%, SwStr%, CSW%). Total width ~1100px.

→ **Mobile:**
- **Freeze Pitcher + Pitch Type columns** — both get `position: sticky` (Pitcher at `left: 0`, Pitch Type at `left: [pitcher-width]`). These are the two columns that identify what you're looking at.
- **Remove the classification change deltas** (the colored `(+2.3)` / `(-1.1)` indicators next to each stat). User requested this specifically. Only remove on mobile — desktop keeps them.
- Remove Team, Hand, and Opponent columns on mobile (redundant when viewing a single game or filtered view).
- Horizontal scroll for remaining stat columns.
- Reduce cell padding and font size as in #5.

**Pitch type filter pills** — currently flex-wrap with colored pills.

→ **Mobile:** Already wraps. Reduce pill size slightly (padding `4px 8px` → `3px 6px`, font `12px` → `11px`).

---

## 7. Pitcher Card / Box Score View (`PitcherCard.jsx`)

This is the single-game detail view with: header, box score table, season totals, metrics tabs, strikezone/movement/velocity plots, play-by-play.

### 7a. Card Container

**Current:** `display: table; margin: 0 auto; padding: 28px;` with `display: inline-block` on `.card`.

→ **Mobile:** Switch to `display: block; width: 100%; padding: 16px 12px;`. Remove `min-width` constraints. Remove `display: table` wrapper.

### 7b. Card Header

**Current:** Pitcher name + team/hand meta on left, box score table on right, in a horizontal flex row.

→ **Mobile:** Stack vertically — name/meta on top, box score below.

### 7c. Box Score Table (13 columns)

**Current:** Pitcher, IP, ER, R, Hits, BB, K | Whiffs, SwStr%, CSW%, Strike%, #, HR.

→ **Mobile:**
- Freeze the Pitcher column with sticky positioning.
- Horizontal scroll for stat columns.
- Season totals row with rate labels: keep as-is (rate labels stack vertically within cells — actually works well on mobile).

### 7d. Metrics Tabs

**Current:** Horizontal tab bar: "Pitch Type Metrics" / "Results" / "Velocity Trend" / "Play-by-Play".

→ **Mobile:** Convert to a `<select>` dropdown to prevent wrapping or overflow. Label it "View:" above the dropdown.

### 7e. Filter Controls (Game filter, LHB/RHB, Pitch Filter, Result Filter, Contact)

**Current:** Horizontal row of labeled dropdowns/selects.

→ **Mobile:** Two rows:
- **Row 1:** Game filter + LHB/RHB
- **Row 2:** Pitch Filter + Result Filter + Contact

The PitchFilterDropdown multi-column menu (`min-width: 340px`) → **Mobile:** Force single column layout, `min-width` → `calc(100vw - 24px)`, centered on screen.

### 7f. Strike Zone + Movement Plots

**Current:** Side-by-side layout: two strikezone plots (vs LHB, vs RHB) + movement plot. Each plot is 310-345px wide with hardcoded canvas dimensions.

→ **Mobile:**
- Stack all three vertically (one per row, full width).
- Scale canvas to container width: use `Math.min(containerWidth - 24, 310)` for strikezone and `Math.min(containerWidth - 24, 345)` for movement. Add a ResizeObserver or measure parent width.
- Maintain aspect ratio via proportional scaling of all coordinates.

### 7g. Pitch Tooltips (Strikezone, Movement, Velocity)

**Current:** Appear on `mousemove` (hover) over canvas, positioned via `fixed` CSS at cursor location. Contain: pitch type, speed, result, batter info, count, situation, mini strikezone SVG.

→ **Mobile:** Change from hover to **tap**:
- On `touchstart`/`click`, show tooltip pinned to top-center or bottom-center of the plot (not cursor-following — no cursor on mobile).
- Add a small "✕" close button in the tooltip corner.
- Tap anywhere else on the plot or outside to dismiss.
- Tooltip `max-width: calc(100vw - 24px)` so it never overflows the screen.
- Mini strikezone SVG inside tooltip: keep as-is (65px wide, fits).

### 7h. Play-by-Play View

**Current:** Inning segments with PA cards, each showing batter info + result + pitch sequence + mini strikezone. Max-width `1080px` for container, `683px` per segment.

→ **Mobile:**
- Full-width segments, remove max-width constraints.
- PA cards: stack info vertically instead of side-by-side.
- Pitch sequence dots: keep compact (already small).
- Expanded pitch-by-pitch table: horizontal scroll with frozen pitch-number column.

---

## 8. Player Page (`PlayerPage.jsx`)

### 8a. Page Container

**Current:** `.pp-outer-centered` with a `.card` inside. Card has `min-width: 900px`.

→ **Mobile:** Remove `min-width`. Card becomes `width: 100%; padding: 16px 12px;`.

### 8b. Spring Training Results Table (Game Log)

**Current:** 12 columns (Date, Opp, IP, ER, R, Hits, BB, K | Whiffs, CSW%, #, HR) + season totals row.

→ **Mobile:**
- Freeze Date column with sticky positioning.
- Horizontal scroll for stat columns.
- Season totals row with rate labels: keep structure (rate labels already stack well).

### 8c. Metrics Section (Pitch Type Metrics / Results / Velocity Trend / Play-by-Play)

**Current:** Horizontal tab bar + two rows of filter dropdowns.

→ **Mobile:**
- Tabs → `<select>` dropdown (same as PitcherCard).
- Filter controls: stack into rows of 2 per line instead of all inline.

### 8d. Strikezone + Movement Plots

Same treatment as PitcherCard (#7f) — stack vertically, scale to container width.

### 8e. Plot Tooltips

Same treatment as PitcherCard (#7g) — tap instead of hover.

---

## 9. Results Table (`ResultsTable.jsx`)

**Current:** 16 columns of pitch-type-level results (Pitch Type, #, Zone%, O-Swing%, Whiffs, CS, CSW%, Strike%, Fouls, BB, K, Hits, HRs, Outs, BIP, Weak%, Hard%).

→ **Mobile:**
- Freeze the Pitch Type column.
- Horizontal scroll for everything else.
- Reduce font to `11px`.

---

## 10. Velocity Trend (`VelocityTrend.jsx`, `VelocityTrendV2.jsx`)

**Current:** VelocityTrendV2 already uses `ResizeObserver` and adapts to container width. Height fixed at `340px`. Right padding `70px` for legend.

→ **Mobile:**
- Reduce height to `280px`.
- Move legend from right-side vertical to **top horizontal row** (pitch names as small colored pills, wrapping). This frees up the right padding.
- Reduce right padding from `70px` → `16px`.
- Tooltip: same tap-to-show treatment as other plots.

---

## 11. Date Picker (`DatePicker.jsx`)

**Current:** Custom date picker with left/right arrows and a date display.

→ **Mobile:** Keep as-is — already compact. Slightly reduce arrow button padding.

---

## 12. Pitch Filter Dropdown (`PitchFilterDropdown.jsx`)

**Current:** Button opens an absolute-positioned dropdown. In 2-column mode, `min-width: 340px`.

→ **Mobile:**
- Single-column layout always (no 2-column).
- Dropdown `max-width: calc(100vw - 24px)` and `max-height: 60vh` with scroll.
- Position: align to left edge of screen with small margin, not relative to button.

---

## 13. Toast / Notifications

**Current:** Fixed position bottom-center toast for refresh status.

→ **Mobile:** Keep as-is. Already responsive.

---

## Implementation Summary

### Files to Modify

| File | Changes |
|---|---|
| `styles.css` | Add `@media (max-width: 768px)` block with all responsive overrides |
| `App.jsx` | Header layout restructure, search icon toggle |
| `PitchDataTable.jsx` | Sticky columns, hide deltas on mobile, hide columns |
| `PitcherResultsTable.jsx` | Sticky pitcher column, hide hand column |
| `ResultsTable.jsx` | Sticky pitch type column |
| `PitcherCard.jsx` | Card layout, metrics tabs → dropdown, tooltip tap |
| `PlayerPage.jsx` | Remove min-width, sticky date column, tabs → dropdown |
| `StrikeZonePlot.jsx` | Container-aware sizing, tap tooltip |
| `MovementPlot.jsx` | Container-aware sizing, tap tooltip |
| `VelocityTrendV2.jsx` | Legend to top, reduced height, tap tooltip |
| `VelocityTrend.jsx` | Same as V2 |
| `PitchFilterDropdown.jsx` | Single-column on mobile, viewport clamping |
| `SearchBar.jsx` | Icon toggle → full-width overlay |
| `PlayByPlayModal.jsx` | Full-width segments, stacked PA cards |
| `constants.js` | No changes needed |

### What Does NOT Change on Desktop

Everything. All changes are wrapped in `@media (max-width: 768px)` CSS or `window.innerWidth <= 768` JS checks. The breakpoint is checked once and passed as a prop or context value — not checked on every render.

### Implementation Approach

1. Add a `useIsMobile()` hook that returns `true` when viewport ≤ 768px (with resize listener).
2. Pass `isMobile` as a prop from `App.jsx` to child components.
3. Components conditionally render mobile layouts when `isMobile` is true.
4. CSS media queries handle spacing, font sizes, and layout shifts.
5. JS logic handles: sticky columns, tooltip tap behavior, canvas scaling, dropdown conversions.
