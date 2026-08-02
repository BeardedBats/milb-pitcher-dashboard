# Baseball Dashboard — Overview

> **Purpose of this doc:** High-level identity of the project. Read first. Tells Claude what this app is, who owns it, what's built, and how it fits the PitcherList ecosystem.

## What it is

A **staff-facing** pitcher analytics dashboard with live Baseball Savant data, built in the Savant Dashboard aesthetic. Nick's personal analytics tool for reviewing MLB pitcher performance day-to-day. Hitter dashboard does **not** exist yet.

This is NOT the PL Pro Dashboard (the subscriber product). Eventually this dashboard will feed INTO the PL Pro Dashboard as one of its internal apps.

## Owner

**Nick Pollack**, CEO of PitcherList (pitcherlist.com)

## Current state

| Area | Status |
|---|---|
| Pitcher stats dashboard | Functional, live |
| Live Savant data (iVB, HAVAA, arm angle) | Working (WebSocket push via `/gf` endpoint) |
| Pitch reclassification | Working (Redis + JSON fallback) |
| Hitter dashboard | Not built |
| PitcherList API integration (PLV, Process+, etc.) | Planned — waiting on dev access |
| Pitcher Video Viewer merge | Planned — will become one codebase |
| Admin login for PL staff | Planned |

## Ecosystem context

This dashboard is **Project 1** in the PitcherList ecosystem. It:

- **Depends on:** PitcherList API (from devs), Pitcher Video Viewer (merging in)
- **Feeds into:** PL Pro Dashboard (as an internal app)
- **Related:** pl-pro-figma-plugin (design tokens)

## Repository

- GitHub: `BeardedBats/Pitcher-Dashboard`
- Local path: `C:\Users\Nick\Desktop\Claude Projects\baseball-dashboard\`
- Branch: `main`
- Auto-deploy: Vercel deploys on push to `origin/main`

## Key terminology

- **PLV, Process+, PL Ranks, ICR** → proprietary data metrics (will integrate later)
- **SWATCH, HIPSTER** → branded content labels (NOT metrics — don't treat as data)
- **CSW** → Called Strikes + Whiffs (PitcherList invented this — widely adopted across baseball analytics)
- **HAVAA** → Height Adjusted Vertical Approach Angle
- **PAR%** → strikeouts on a pitch ÷ pitches of that type in 2-strike counts

## Brand/design aesthetic

Dark navy base (`#21243A`), cyan accent (`#55e8ff`), amber labels (`#ffc277`). DM Sans for UI, Work Sans for data tables. Evolving toward a Savant-base-plus-neon-glass-mesh look. Hates rigid/jagged/"AI-slop" — wants smooth, premium, clean.

See [06-DESIGN-SYSTEM.md](06-DESIGN-SYSTEM.md) for tokens.

## Build & run

```bash
# Frontend build (use 180s timeout — CRA is slow)
cd frontend && npx react-scripts build

# Backend syntax check
cd backend && python -c "import app"

# Dev: BROWSER=none set in frontend/.env to prevent double browser windows
# Frontend dev port: 3847
```

## When to read which doc

| Need | Doc |
|---|---|
| Add a new API endpoint | [02-BACKEND-API.md](02-BACKEND-API.md) |
| Understand caching / Redis keys | [03-BACKEND-INTERNALS.md](03-BACKEND-INTERNALS.md) |
| Add/modify a React component | [04-FRONTEND.md](04-FRONTEND.md) |
| Wire up new data shape | [05-DATA-SCHEMAS.md](05-DATA-SCHEMAS.md) |
| Style something | [06-DESIGN-SYSTEM.md](06-DESIGN-SYSTEM.md) |
| Handle a tricky edge case (tooltips, classification, dates) | [07-BUSINESS-LOGIC.md](07-BUSINESS-LOGIC.md) |
| Deploy / set up scheduler / infra | [01-ARCHITECTURE.md](01-ARCHITECTURE.md) |
