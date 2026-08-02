# Pitcherlist Design System

The complete visual language for the Pitcher Dashboard — a dark-theme, data-dense baseball analytics tool built for scouts, analysts, and fantasy managers.

---

## 1. Visual Theme & Atmosphere

**Mood:** Dark command center. Nighttime broadcast booth meets Bloomberg terminal.

**Density:** High — tables, charts, and stat grids dominate every view. Whitespace is intentional but minimal; the UI is built for people who want _more_ data, not less.

**Philosophy:**
- Data is the design. Typography and color serve readability, not decoration.
- Glow over shadow. Accent elements emit soft neon light rather than casting dark shadows.
- Every color has a job. If it's colored, it means something — pitch type, performance tier, or result outcome.
- The UI should feel like a tool you _use_, not a page you _read_.

---

## 2. Color Palette & Roles

### Core Surfaces

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#21243A` | Page background — deepest layer |
| `--surface` | `#262940` | Cards, panels, primary containers |
| `--surface2` | `#2E3150` | Nested cards, table headers, metric cards |
| `--border` | `#363A54` | All borders, dividers, separators |
| `--row-border` | `rgba(54, 58, 84, 0.55)` | Row/cell bottom borders |
| `--row-border-light` | `rgba(64, 68, 100, 0.55)` | Lighter row borders (metrics card, table card) |
| `--hover-tint` | `rgba(85, 232, 255, 0.04)` | Row/card hover highlight |
| `--accent-glow` | `rgba(85, 232, 255, 0.12)` | Focus rings, active state glow |

### Text Hierarchy

| Token | Hex | Usage |
|---|---|---|
| `--text-bright` | `#F0F1F5` | Primary values, player names, bold data |
| `--text` | `#E0E2EC` | Body text, table cells, default content |
| `--text-muted` | `#C0C4D8` | Secondary info, descriptions |
| `--text-dim` | `#8A8EB0` | Tertiary info, timestamps, italic metadata |
| `--meta` | `#C8CAD4` | Player card metadata (team, hand, date) |

### Accent & Brand

| Token | Hex | Usage |
|---|---|---|
| `--accent` | `#55e8ff` | Primary accent — links, active states, table headers, pitcher names |
| `--accent-soft` | `#70d4f0` | Softer links (game links, underlines) |
| `--accent-hover` | `#8cf0ff` | Hover state for accent elements |
| `--label` | `#ffc277` | Section headers ("Box Score", "Pitch Type Metrics"), active tabs |
| `--label-bright` | `#FFC46A` | App title gradient end, bright label variant |
| `--name` | `#55e8ff` | Search result names (same as accent) |
| `--runs` | `#55e8ff` | Runs scored display (same as accent) |

### Special-Purpose Colors (hardcoded, not CSS variables)

| Hex | Usage |
|---|---|
| `#1A1C30` | Dark text on accent backgrounds (confirm button text) |
| `#3d427b` | Dropdown/select backgrounds (5 occurrences) |
| `#4A4E68` | Checkbox unchecked border |
| `#2e3150` | Box score cell background (hardcoded to match `--surface2`) |

### Pitch Type Colors

| Pitch | Hex | Swatch |
|---|---|---|
| Four-Seamer | `#FF839B` | Warm pink |
| Sinker | `#ffc277` | Amber gold |
| Cutter | `#C59C9C` | Dusty rose |
| Slider | `#CE66FF` | Purple |
| Sweeper | `#FFAAF7` | Hot pink |
| Curveball | `#2A98FF` | Bright blue |
| Changeup | `#6DE95D` | Lime green |
| Splitter | `#83D6FF` | Sky blue |
| Knuckleball | `#A0A0A0` | Grey |
| Eephus | `#A0A0A0` | Grey (same as Knuckleball) |
| Screwball | `#90C890` | Sage green |
| Forkball | `#78E0AE` | Teal |

### Tooltip Result Colors (from `getTooltipResult`)

Used in pitch tooltips across StrikeZonePlot, VelocityTrend, PlayByPlayModal, and PitcherCard.

| Result | Hex | Visual |
|---|---|---|
| Strikeout | `#65FF9C` | Bright green |
| Called Strike / Whiff (mid-AB) | `#65FF9C` | Bright green |
| Walk / HBP | `#ffc277` | Orange |
| Ball (mid-AB) | `#ffc277` | Orange |
| Home Run | `#FF5EDC` | Hot pink |
| Single / Double / Triple | `#feffa3` | Pale yellow |
| Outs (trajectory-based) | `#65BAFF` | Light blue |
| Foul (mid-AB) | `#AAB9FF` | Lavender |
| Sac Fly / Sac Bunt | `#AAB9FF` | Lavender |

### Table Cell Result Colors (from `RESULT_COLORS`)

Used for coloring PA outcome text in PitcherResultsTable and other table views.

| Result | Hex | Visual |
|---|---|---|
| Strikeout | `#ffc680` | Warm orange |
| Home Run | `#ffa3a3` | Soft red |
| Walk / HBP | `#ffa3a3` | Soft red |
| Hit (1B/2B/3B) | `#ffa3a3` | Soft red |
| Outs (field_out, etc.) | `#55e8ff` | Bright cyan |

### Strikezone Result-Mode Colors (from `PITCH_DESC_COLORS`)

Base dot colors for pitch descriptions in strikezone result mode.

| Description | Hex | Visual |
|---|---|---|
| Called Strike | `#ffc277` | Amber |
| Swinging Strike | `#EF4444` | Red |
| Ball | `#4ADE80` | Green |
| Foul | `#ffc277` | Yellow |
| Hit Into Play | `#60A5FA` | Blue |
| Hit By Pitch | `#A78BFA` | Purple |
| Pitchout | `#4ADE80` | Green (same as Ball) |
| Missed Bunt | `#EF4444` | Red (same as Swinging Strike) |

### Strikezone In-Play Event Colors (from `getSZResultColor`)

When strikezone is in result mode, in-play pitches use event-specific colors that differ from the base `PITCH_DESC_COLORS`:

| Event | Hex | Visual |
|---|---|---|
| Home Run | `#ffc277` | Gold |
| Triple | `#FF6B6B` | Coral red |
| Single | `#60A5FA` | Blue |
| Double | `#A78BFA` | Purple |
| In-Play Outs | `rgba(255,255,255,0.5)` | Semi-transparent white |
| Default fallback | `#888` | Grey |

### Batted Ball Colors (from `BATTED_BALL_COLORS`)

Used in tooltips for batted ball classification tags.

| Classification | Hex | Visual |
|---|---|---|
| Barrel | `#ffa3a3` | Soft red |
| Solid | `#ffc277` | Amber |
| Burner | `#ffc277` | Amber |
| Flare | `#65ff9c` | Bright green |
| Topped | `#65ff9c` | Bright green |
| Under | `#65ff9c` | Bright green |
| Poor | `#65ff9c` | Bright green |

### BIP Quality Colors (from `BIP_QUALITY_COLORS`)

| Quality | Hex | Visual |
|---|---|---|
| Hard BIP | `#ffc277` | Amber (Barrel, Solid, Burner) |
| Weak BIP | `#65ff9c` | Bright green (Flare, Topped, Under, Poor) |

### Performance Tier Colors

| Tier | Hex | Usage |
|---|---|---|
| Elite | `#FF5A5A` border / `#FF839B` text | Cell highlight for elite metrics (IVB, Extension) |
| Poor | `rgba(77, 185, 251, 0.55)` border / `rgba(140, 200, 255, 0.85)` text | Cell highlight for below-average metrics |
| Delta Up | `#FF839B` | Metric increased vs season average — displayed as `(+1.2)` |
| Delta Down | `#55e8ff` | Metric decreased vs season average — displayed as `(-0.8)` |
| Delta Neutral | `#9ba0c4` | No meaningful change — displayed as `(+0.1)` |
| Delta New | `#4ade80` | New pitch type (not in season averages) — displayed as `(NEW)` |

### Offense Tier Colors (Schedule/Matchup)

| Tier | Hex | Meaning |
|---|---|---|
| Top | `#ff8282` | Elite offense — bad matchup for pitchers |
| Solid | `#ffd2b8` | Above-average offense |
| Average | `#d3b3ab` | League-average offense |
| Weak | `#9ed1f5` | Below-average offense |
| Poor | `#6de95d` | Bad offense — great matchup for pitchers |

---

## 3. Typography Rules

### Font Families

| Role | Family | Source |
|---|---|---|
| UI / Headers | `'DM Sans', sans-serif` | Google Fonts — body, buttons, labels, section titles |
| Data / Tables | `'Work Sans', sans-serif` (`--font-data`) | Google Fonts — all table cells, stat values, dropdowns |
| Scoreboard | System monospace (`SF Mono`, `Fira Code`) | Inning-by-inning linescore only |

### Size Hierarchy

| Element | Size | Weight | Additional |
|---|---|---|---|
| App title | 26px | 800 | Gradient text (`#FFC46A` → `#ffc277`), `letter-spacing: -0.02em` |
| Pitcher name (card) | 28px | 800 | `--accent` color |
| Player name (page) | 28px | 800 | `--accent` color |
| Section labels | 16px | 700 | `--label` color, `text-shadow: 0 0 16px rgba(251, 158, 42, 0.15)` |
| Page title | 20px | 700 | `--text-bright` |
| PBP batter name (modal) | 18px | 700 | `--text` |
| PBP batter name (card inline) | 16px | 700 | `--text` |
| Card meta | 15px | 500 | `--meta` |
| Body base | 19px | 400 | `--text` (global body font-size) |
| Table header (th) | 12px | 600 | `--accent`, `uppercase`, `letter-spacing: 0.04em` |
| Table cells (td) | 14px | 400 | `--text`, `font-family: var(--font-data)` |
| Button text | 13-14px | 500-600 | Varies by button type |
| Small labels / badges | 10-12px | 500-700 | Uppercase, letter-spacing |
| Tooltip text | 12-13px | 400-700 | Mixed weights for hierarchy |

### Numeric Display

All tables use `font-variant-numeric: tabular-nums` for aligned columns. Delta values use `font-size: 11px` inline, wrapped in parentheses: `(+1.2)`, `(-0.8)`, or `(NEW)` for new pitch types. Usage deltas are rounded integers with `%`: `(+3%)`.

---

## 4. Component Stylings

### Buttons

**View Button (`.view-btn`):**
- Default: `bg: --surface`, `border: 1px solid --border`, `color: --text`, `radius: 6px`, `padding: 7px 16px`
- Hover: `color: --text-bright`, `border-color: --accent`, `bg: --hover-tint`
- Active: `bg: linear-gradient(135deg, rgba(85,232,255,0.18), rgba(85,232,255,0.06))`, `border-color: --accent`, `color: --accent`, `weight: 600`, `box-shadow: 0 0 10px --accent-glow`

**Game Tab (`.game-tab`):**
- Default: `min-width: 120px`, `height: 32px`, same surface/border pattern
- Active: Same gradient as view-btn active + `box-shadow: 0 0 12px --accent-glow`
- No Data: `opacity: 0.4`, `border-style: dashed`, no hover effect
- Not Started: `opacity: 0.55`, `cursor: not-allowed`, `border-style: dashed`

**Navigation Link (`.nav-link`):**
- Default: `bg: none`, `border: 1px solid --border`, `color: --text-muted`
- Hover: `color: --accent`, `border-color: --accent`
- Active: Same + `bg: --accent-glow`

**Back Button (`.back-btn`):** Same as view-btn default, hover adds accent glow.

**Confirm Button (`.reclass-btn-confirm`):** `bg: --accent`, `color: #1A1C30` (dark on bright). Hover: `brightness(1.1)`. Disabled: `opacity: 0.4`.

### Cards

**Main Card (`.card`):** `bg: --surface`, `border: 1px solid --border`, `radius: 10px`, `padding: 28px`, `box-shadow: 0 4px 24px rgba(0,0,0,0.2)`.

**Metrics Card (`.metrics-card`):** `bg: --surface2`, `radius: 10px`, `padding: 12px 14px`, `border: 1px solid --border`. Nested inside the main card.

**Viz Card (`.viz-card`):** `bg: --surface2`, `radius: 10px`, `padding: 10px 12px`, `border: 1px solid --border`. Slightly tighter padding than metrics card (12px 14px). Contains canvas-rendered charts (strikezone, movement plot).

**Table Card (`.table-card`):** `bg: --surface`, `border: 1px solid --border`, `radius: 10px`, `display: table`, centered with `margin: 0 auto`.

### Tables

**Header row:** `bg: --surface2`, `color: --accent`, `font-size: 12px`, `weight: 600`, `uppercase`, `letter-spacing: 0.04em`, `border-bottom: 2px solid --border`.

**Body rows:** `border-bottom: 1px solid --row-border`. Even rows: `bg: rgba(255,255,255,0.012)`. Hover: `bg: --hover-tint`.

**Cells:** `padding: 7px 10px`, `font-family: --font-data`, `white-space: nowrap`.

**Column dividers:** `border-right: 2px solid rgba(255,255,255,0.18)` on logical grouping boundaries.

**Totals row (`.pp-total-row`):** `bg: #363957`, `border-top: 2px solid --border`, label cell gets `weight: 600`.

**Sort indicator:** Active column header gets `border-bottom: 2px solid --accent`.

### Inputs

**Date picker:** `bg: --surface`, `border: 1px solid --border`, `radius: 6px`, `color: --text-bright`, `padding: 7px 14px`. Focus: `border-color: --accent`, `box-shadow: 0 0 8px --accent-glow`.

**Search input:** Same pattern. `width: 180px` default, expands to `240px` on focus.

**Select/Dropdown:** `bg: #3d427b`, `color: --text`, `border: 1px solid transparent`, `radius: 6px`. Custom SVG arrow indicator. Hover/focus: `border-color: --accent`.

**Checkbox:** Custom `appearance: none`, `16x16px`, `border: 1px solid #4A4E68`, `radius: 4px`. Checked: `bg: rgba(85,232,255,0.25)`, `border-color: --accent`, checkmark in accent color.

### Pitch Type Pills

`border: 1.5px solid currentColor`, `radius: 6px`, `padding: 5px 12px`, `font-size: 13px`, `weight: 600`. Default `opacity: 0.5`, hover `0.75`, active `1.0` with `border-color: transparent` and subtle shadow.

### Tooltips

**Pitch tooltip (`.pitch-tooltip`):** `bg: rgba(30,32,53,0.96)`, `border: 1px solid --border`, `radius: 10px`, `box-shadow: 0 6px 20px rgba(0,0,0,0.45)`. Uses `position: fixed` with viewport clamping to prevent overflow. `animation: tooltipFadeIn 0.12s ease-out`.

**Pitch tooltip field structure (top to bottom):**
1. **Row 1 — Header:** Pitch type (colored by `PITCH_COLORS`) + speed in mph (left). Result label colored by `getTooltipResult` colors (right).
2. **Row 2 — BIP only:** Exit velocity + launch angle (left). Batted ball classification tag (right, colored by `BATTED_BALL_COLORS`).
3. **Row 3 — Body (flex: text left, mini strikezone SVG right):**
   - `vs {batter_name}` with hand indicator. Strikeout sub-label ("Called Strike" / "Swinging Strike") right-aligned on same line.
   - Inning (Top/Bot + ordinal) + base runners.
   - Outs + count (balls-strikes).
   - Movement: `iVB {val}" · iHB {val}" · Ext {val}ft`.
4. **Mini strikezone SVG** (65x103px) aligned to bottom-right of body, showing zone box, grid, home plate, batter handedness labels, and pitch location dot.

**Tooltip result colors** come from `getTooltipResult()` in `pitchFilters.js` — NOT from `RESULT_COLORS` (which colors table cells) or `PITCH_DESC_COLORS` (which colors strikezone dots).

**Scoreboard tooltip (`.sb-tooltip`):** Same surface treatment. `min-width: 200px`, `max-width: 340px`.

### Modals

**Play-by-play modal:** `backdrop: rgba(0,0,0,0.65)` + `backdrop-filter: blur(4px)`. Panel: `bg: --surface`, `border: 1px solid --border`, `radius: 10px`, `max-width: 1050px`, `box-shadow: 0 16px 48px rgba(0,0,0,0.5)`. Slide-in animation.

**Reclassify modal:** Same backdrop. Panel: `min-width: 340px`, `max-width: 420px`. Confirmation button uses accent-on-dark pattern.

### Toast Notifications

`position: fixed`, `top: 20px`, `right: 20px`. Success: `bg: #1a3a2a`, `color: #4ade80`, `border: 1px solid #2d5a3d`. Error: `bg: #3a1a1a`, `color: #f87171`, `border: 1px solid #5a2d2d`. Slide-in from right.

---

## 5. Layout Principles

### Spacing Scale

| Token | Value | Usage |
|---|---|---|
| Micro | 2-4px | Gap between stacked labels, inner padding |
| Small | 6-8px | Button gaps, pill gaps, row padding |
| Medium | 10-14px | Section gaps, card internal padding |
| Large | 16-24px | Card padding (28px), section margins |
| XL | 32px | App outer padding |

### Content Width

`--content-width: 1130px` — header, game tabs, and page content. The app container itself is `max-width: 1600px`. Pitcher cards and tables use `display: table` + `margin: 0 auto` for natural width centering.

### Grid Strategy

No CSS Grid for layout. Flexbox everywhere:
- **Header:** `flex` row, `gap: 14px`, `flex-wrap: wrap`
- **Controls:** `flex` row, centered, `gap: 8px`
- **Card visuals:** `flex` row, `gap: 16px`, `flex-wrap: nowrap`
- **PBP modal:** `flex` split — left panel (PA list) + right panel (strikezone)

### Whitespace Philosophy

Dense by default. Breathing room comes from:
- Card padding (28px) as the primary spacer
- Section margins (24px `margin-bottom`) between card sections
- Table cell padding (7px 10px) as the micro-level spacer
- No decorative whitespace — every gap serves a structural purpose

---

## 6. Depth & Elevation

### Surface Stack (bottom to top)

| Layer | Surface | Example |
|---|---|---|
| 0 | `--bg` (#21243A) | Page background |
| 1 | `--surface` (#262940) | Cards, panels, table cards |
| 2 | `--surface2` (#2E3150) | Table headers, metric cards, nested containers |
| 3 | `#363957` | Totals row, emphasized rows |
| 4 | `#3d427b` | Dropdowns, select backgrounds |

### Shadow System

Shadows are minimal. Glow > shadow:
- **Cards:** `0 4px 24px rgba(0,0,0,0.2)` — subtle float
- **Dropdowns:** `0 8px 24px rgba(0,0,0,0.4)` — elevated menus
- **Modals:** `0 16px 48px rgba(0,0,0,0.5)` — full overlay
- **Active states:** `0 0 10px rgba(85,232,255,0.12)` — neon glow (accent-glow)
- **Sticky columns (mobile):** `2px 0 4px rgba(0,0,0,0.18)` — horizontal shadow for scroll indication

### Focus States

All interactive elements: `border-color: --accent` + `box-shadow: 0 0 8px --accent-glow`. No outline — border shift only.

---

## 7. Do's and Don'ts

### Do

- Use `--accent` (#55e8ff) for interactive elements and data headers
- Use `--label` (#ffc277) for section titles only — never for data
- Apply `font-variant-numeric: tabular-nums` on all numeric data
- Use `uppercase` + `letter-spacing: 0.04em` for table headers and small labels
- Keep all text `white-space: nowrap` in table cells
- Use the glow pattern (`box-shadow: 0 0 Xpx --accent-glow`) for active/focus states
- Use `font-family: var(--font-data)` (Work Sans) for all numbers and table content
- Apply pitch type colors from `PITCH_COLORS` — never invent new ones
- Use `opacity` for disabled/inactive states (0.4 for disabled, 0.55 for not-started)
- Match the surface hierarchy: bg → surface → surface2 → dropdown

### Don't

- Don't use pure white (`#FFFFFF`) — brightest text is `#F0F1F5`
- Don't use pure black (`#000000`) — darkest surface is `#21243A`
- Don't add borders to canvas elements — canvases are borderless with `border-radius: 6px`
- Don't use traditional box-shadow for cards — use the glow pattern instead
- Don't mix font families within a single table
- Don't use color alone to convey meaning — pair with position, weight, or shape
- Don't add decorative elements (icons, illustrations, gradients on surfaces)
- Don't use rounded corners larger than 10px — `--radius: 10px` is the max
- Don't center-align text labels — only center numeric data in tables
- Don't use `transform: translate` for tooltips — use `position: fixed` with viewport clamping

---

## 8. Responsive Behavior

### Breakpoints

| Breakpoint | Target |
|---|---|
| `> 768px` | Desktop — full layout |
| `<= 768px` | Mobile — stacked, scrollable |

### Mobile Adaptations

**Layout:**
- App padding: `12px 8px` (from 24px 32px)
- Cards: `display: block`, `width: 100%`, `padding: 14px 10px`
- Card top: stacks vertically (`flex-direction: column`)

**Typography:**
- Body: 16px (from 19px)
- App title: 20px (from 26px)
- Player name: 22px (from 28px)
- Table headers: 10px (from 12px)
- Table cells: 12px (from 14px)

**Tables:**
- Horizontal scroll with `-webkit-overflow-scrolling: touch`
- Sticky first column(s): `position: sticky`, `left: 0`, `z-index: 3-5`, `box-shadow: 2px 0 4px rgba(0,0,0,0.18)`
- Max-height constraints (`60-70vh`) with overflow scroll

**Navigation:**
- Sub-nav tabs replaced by native `<select>` dropdown (`.metrics-subnav-mobile`)
- Search input: 120px default, expands to 100% on focus
- Game tabs: smaller min-width (90px), smaller font (11px)

**Visuals:**
- Strikezone pair: stacks vertically
- All viz cards: `display: block`, natural width
- PBP modal: full width (98%), content stacks vertically

**Tooltips:**
- On mobile: `position: fixed`, docked to bottom (`bottom: 12px`), full-width with close button
- `pointer-events: auto` on mobile (tappable to dismiss)

**Touch targets:**
- Buttons minimum ~28px height on mobile
- Game tabs: 28px height, 90px min-width

### Collapsing Strategy

1. Flex wrapping first (header, controls, game tabs)
2. Horizontal scroll second (tables, scoreboards)
3. Vertical stacking third (card sections, viz pairs)
4. Dropdowns replace tab bars last resort (metrics subnav)

---

## 9. Agent Prompt Guide

### Quick Color Reference

```
Background:    #21243A
Surface:       #262940
Surface2:      #2E3150
Border:        #363A54
Accent:        #55e8ff (cyan glow)
Label:         #ffc277 (warm orange)
Text:          #E0E2EC
Text Bright:   #F0F1F5
Text Dim:      #8A8EB0
```

### Ready-to-Use Prompts

**"Add a new card section"**
```
Use bg: #2E3150, border: 1px solid #363A54, border-radius: 10px, padding: 12px 14px.
Section label: 16px, weight 700, color #ffc277 with text-shadow: 0 0 16px rgba(251,158,42,0.15).
```

**"Add a new button"**
```
Background: #262940, border: 1px solid #363A54, border-radius: 6px, padding: 7px 16px.
Font: inherit, 14px, weight 500, color #E0E2EC.
Hover: border-color #55e8ff, background rgba(85,232,255,0.04).
Active: background linear-gradient(135deg, rgba(85,232,255,0.18), rgba(85,232,255,0.06)),
        border-color #55e8ff, color #55e8ff, weight 600, box-shadow 0 0 10px rgba(85,232,255,0.12).
```

**"Add a new table"**
```
Font: 'Work Sans', 14px, tabular-nums. Header: 12px, weight 600, #55e8ff, uppercase, letter-spacing 0.04em.
Header bg: #2E3150, border-bottom: 2px solid #363A54.
Rows: border-bottom 1px solid rgba(54,58,84,0.55). Hover: rgba(85,232,255,0.04).
Cells: padding 7px 10px, color #E0E2EC, white-space nowrap.
```

**"Add a new dropdown"**
```
Background: #3d427b, color #E0E2EC, border: 1px solid transparent, border-radius: 6px.
Padding: 5px 12px, font-size 12px. Custom SVG arrow (see .sz-mode-select in CSS).
Hover: border-color #55e8ff. Focus: border-color #55e8ff, box-shadow 0 0 0 2px rgba(85,232,255,0.15).
Menu: bg #3d427b, border 1px solid rgba(255,255,255,0.1), border-radius 6px,
      box-shadow 0 8px 24px rgba(0,0,0,0.45).
```

**"Add a new modal"**
```
Backdrop: rgba(0,0,0,0.65), backdrop-filter: blur(4px).
Panel: bg #262940, border 1px solid #363A54, border-radius 10px,
       box-shadow 0 16px 48px rgba(0,0,0,0.5).
Header: flex row, padding 16px 18px, border-bottom 1px solid #363A54.
Title: 18-20px, weight 700, color #F0F1F5.
Animation: slide up 0.2s ease-out.
```

**"Style a tooltip"**
```
Background: rgba(30,32,53,0.96), border: 1px solid #363A54, border-radius: 10px.
Padding: 8px 10px, box-shadow: 0 6px 20px rgba(0,0,0,0.45).
Use position: fixed with viewport clamping. Animation: fadeIn 0.12s ease-out.
pointer-events: none (except mobile).
```
