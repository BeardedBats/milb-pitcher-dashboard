# Baseball Dashboard — Design System

> **Purpose of this doc:** Every color, font, token, and visual pattern. Source of truth for styling decisions. If you're picking a hex code or font size, it should come from here. Fuller version in `design.md` at the repo root; this is the condensed reference.

---

## Visual philosophy

> Dark command center. Nighttime broadcast booth meets Bloomberg terminal.

- **Data is the design.** Typography and color serve readability, not decoration.
- **Glow over shadow.** Accent elements emit soft neon light rather than casting dark shadows.
- **Every color has a job.** If it's colored, it means something — pitch type, performance tier, or result outcome.
- **A tool you use, not a page you read.**

Aesthetic direction: Savant Dashboard base + neon/glass/mesh accents (via Landing Page). Hates rigid/jagged/"AI-slop".

---

## Surface colors

| Token | Hex | Role |
|---|---|---|
| `--bg` | `#21243A` | Page background — deepest layer |
| `--surface` | `#262940` | Cards, panels, primary containers |
| `--surface2` | `#2E3150` | Nested cards, table headers, metric cards |
| `--border` | `#363A54` | All borders, dividers |
| `--row-border` | `rgba(54, 58, 84, 0.55)` | Row/cell bottom borders |
| `--row-border-light` | `rgba(64, 68, 100, 0.55)` | Lighter row borders (metrics, table card) |
| `--hover-tint` | `rgba(85, 232, 255, 0.04)` | Row/card hover highlight |
| `--accent-glow` | `rgba(85, 232, 255, 0.12)` | Focus rings, active-state glow |

## Text hierarchy

| Token | Hex | Usage |
|---|---|---|
| `--text-bright` | `#F0F1F5` | Primary values, player names, bold data |
| `--text` | `#E0E2EC` | Body text, table cells, default content |
| `--text-muted` | `#C0C4D8` | Secondary info, descriptions |
| `--text-dim` | `#8A8EB0` | Tertiary info, timestamps, italic metadata |
| `--meta` | `#C8CAD4` | Player card metadata (team, hand, date) |

## Accent & brand

| Token | Hex | Usage |
|---|---|---|
| `--accent` | `#55e8ff` | Primary accent — links, active states, table headers, pitcher names |
| `--accent-soft` | `#70d4f0` | Softer links (game links, underlines) |
| `--accent-hover` | `#8cf0ff` | Hover state for accent elements |
| `--label` | `#ffc277` | Section headers ("Box Score", "Pitch Type Metrics"), active tabs |
| `--label-bright` | `#FFC46A` | App title gradient end, bright label variant |
| `--name` | `#55e8ff` | Search result names (same as accent) |
| `--runs` | `#55e8ff` | Runs scored display |

## Special-purpose (hardcoded, not CSS vars)

| Hex | Usage |
|---|---|
| `#1A1C30` | Dark text on accent backgrounds (confirm button) |
| `#3d427b` | Dropdown/select backgrounds |
| `#4A4E68` | Checkbox unchecked border |
| `#2e3150` | Box score cell background (matches `--surface2`) |
| `#363957` | Totals row background |

---

## Pitch type colors (`PITCH_COLORS` in constants.js)

| Pitch | Hex | Swatch feel |
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
| Eephus | `#A0A0A0` | Grey |
| Screwball | `#90C890` | Muted green |
| Forkball | `#78E0AE` | Teal (between Changeup green + Splitter blue) |

## Tooltip result colors (from `getTooltipResult`)

| Result | Hex | Why |
|---|---|---|
| Strikeout | `#65FF9C` | Bright green — success |
| Walk / HBP | `#ffc277` | Orange — neutral bad |
| Home Run | `#FF5EDC` | Hot pink — disaster |
| Single / Double / Triple | `#feffa3` | Pale yellow — contact |
| Out (all types) | `#65BAFF` | Light blue — standard out |
| Foul | `#AAB9FF` | Lavender — neutral |
| Sac Fly / Sac Bunt | `#AAB9FF` | Lavender |
| Run-scoring text (inline) | `#FF5EDC` | Pink — emphasis |

## Pitch description colors (in-zone visualization)

| Description | Hex |
|---|---|
| `called_strike` | `#ffc277` (amber) |
| `swinging_strike` / `foul_tip` | `#EF4444` (red) |
| `ball` | (outline only, no fill) |
| `hit_into_play` | per PA outcome |

## Offense tier colors

| Tier | Hex |
|---|---|
| Top | `#ff8282` |
| Solid | `#ffa04b` |
| Average | `#d3b3ab` |
| Weak | `#9ed1f5` |
| Poor | `#6de95d` |

## Cell emphasis gradients (`GRADIENTS` in constants.js)

| State | Value |
|---|---|
| `elite` | `linear-gradient(180deg, #FF3838, #FF6C6C)` |
| `poor` | `linear-gradient(180deg, rgba(77, 185, 251, 0.5), rgba(185, 228, 255, 0.5))` |

Applied via `getCellHighlight` / `getVeloEmphasis` / `getIHBEmphasis` in `formatting.js`.

---

## Typography

| Use | Font | Size / weight |
|---|---|---|
| App title | DM Sans | 26px, weight 700, accent gradient |
| Section labels ("Box Score", "Pitch Type Metrics") | DM Sans | 16px, weight 600, color `--label` (`#ffc277`), uppercase, letter-spacing 0.04em |
| Body / UI | DM Sans | 14px, weight 400 |
| Table headers | Work Sans | 12px, weight 600, uppercase, letter-spacing 0.04em, color `--accent` |
| Table cells (data) | Work Sans | 14px, weight 400, `font-variant-numeric: tabular-nums` |
| Scoreboard numbers | System monospace | Varies |

Use tabular-nums on anything numeric so columns align.

---

## Component styles

### Card

```css
background: var(--surface);      /* #262940 */
border: 1px solid var(--border); /* #363A54 */
border-radius: 10px;
padding: 28px;
box-shadow: 0 4px 24px rgba(0, 0, 0, 0.2);
```

### Metric card (nested within a card)

```css
background: var(--surface2);     /* #2E3150 */
border-radius: 10px;
padding: 12px 14px;
border: 1px solid var(--border);
```

### Table header row

```css
background: var(--surface2);
color: var(--accent);
font-size: 12px;
font-weight: 600;
text-transform: uppercase;
letter-spacing: 0.04em;
```

### Totals row (`.pp-total-row`)

Used in PitchDataTable, ResultsTable, Box Score season-totals:

```css
font-weight: 700;
background: rgba(255, 255, 255, 0.04);
border-top: 2px solid var(--border);
```

Totals rules:
- Show `—` for Velo, Usage, IVB, IHB, Ext (no sensible total)
- Show overall **hand split** percentages for `Vs R` / `Vs L`
- Show **weighted averages** for CS%, SwStr%, CSW%, Strike%
- Count column shows simple sum

### Tooltip (pitch/result tooltips)

```css
position: fixed;
background: rgba(30, 32, 53, 0.96);
border: 1px solid var(--border);
border-radius: 10px;
box-shadow: 0 6px 20px rgba(0, 0, 0, 0.45);
padding: 10px 12px;
transform: none;  /* Override CSS default translate(-50%, -100%) */
```

Viewport clamping math uses `window.innerWidth` / `window.innerHeight` to prevent edge overflow. See [07-BUSINESS-LOGIC.md](07-BUSINESS-LOGIC.md#tooltip-positioning).

### Desktop scaling note

Body zoom set to 125% on desktop; fixed-tooltip math compensates. See recent commit `fca3be8`.

---

## Iconography / dot shapes (strike zone plot)

| Result | Shape |
|---|---|
| Called strike | Filled circle |
| Ball | Outlined circle (no fill) |
| Swinging strike / Whiff | Square |
| Foul | Triangle |
| Hit into play | Star |
| HBP | Diamond |

---

## Box Score table structure

Columns in order: `Pitcher | IP | R | ER | Hits | BB | K | Whiffs | SwStr% | CSW% | Strike% | # | HR`

Class: `.card-gameline-table`. Season totals row appended at bottom with `.pp-total-row` + `.pp-total-label`.

---

## Away game prefix

Game log displays away games as `@OPP`, home games as just `OPP`. Uses `game.home` boolean on the log row.

---

## Design evolution direction

Current state: Savant Dashboard base. Moving toward:
- More neon/glow accents on key data points
- Mesh backgrounds for hero sections (not tables)
- Glass/blur panels for overlays
- Smoother shapes — less rigid borders, softer corners on callouts
- Animation reserved for interactions, never decorative

Pulls from the Landing Page aesthetic but kept restrained — this is a dense analytics tool, not a marketing page.
