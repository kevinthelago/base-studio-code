# Claude Design kickoff — Projects page: project states + blueprints

Paste this whole brief into a Claude Design session. It is self-contained: goal, the screen,
every card state with its real data + meaning, the design-system constraints, and what to produce.

---

## Goal

Redesign the **Projects page** of base-studio-code so a project's lifecycle state reads at a
glance, and so **blueprint-authoring projects are clearly separated** from normal software
projects. Today everything is one flat-ish list; we want a clean, scannable, grouped layout with a
distinct visual identity per state.

## Product context (so the states make sense)

**base-studio-code** is a desktop host (Tauri + React, dark theme) for running many AI coding
agents in parallel. The flow:

1. You **plan** a project in a dedicated planner session (a chat that fills in a structured plan).
2. You **publish** it to GitHub — this creates repos + a **GitHub Projects v2 board** + one
   milestone per phase + one issue per planned unit.
3. A **fleet** of agents builds the issues; the board's items close as work lands.
4. When the board is closed, the project is **shipped**.

Separately, a **blueprint** is a reusable planning *template*. A **blueprint-authoring project** is
a special project whose deliverable is a blueprint itself — you design the blueprint in the planner
and **publish it as a GitHub gist**. It has **no repos, no fleet, no issues, no board**.

So a project's state is derived almost entirely from its GitHub board (or, for blueprints, from the
gist). The page must make these distinct states obvious.

## The screen

A single scrollable page, `Projects`, titled with a count and a search/sort header. Below it,
projects are shown as **rows/cards grouped into labeled sections**. There's a "New project" entry
and a per-row overflow menu (open the board, delete).

## The states to design (5 card types, grouped into 3 sections)

### Section A — Drafts (not yet on GitHub)

**1. Unpublished draft.** A project that's been started/planned locally but never published to
GitHub — it has no board yet. The user is still shaping the plan.
- Shows: title, a short pitch/description, a **"draft"** tag, when it was created/updated, and a
  delete control. No issue counts, no progress, no repos (none linked yet, or linked but not
  pushed).
- Mood: in-progress, neutral/amber. The lightest-weight card.

### Section B — Projects (published to GitHub), grouped by lifecycle

These all have a GitHub board. State is derived from the board:

**2. Drafting** — *published the board, but it has 0 items yet* (plan published, issues not cut /
"plan in progress").
- Dot/accent: **amber** (`--accent`). Tag reads "drafting"; sub-label "plan in progress".
- Shows: `#<board number>`, title, repo chips (first 2, then "+N"), description, last-updated time,
  and a **live fleet pill** when agents are running ("N agents running · M paused"). No progress
  bar yet (nothing to close).

**3. Active** — *board has ≥ 1 item and isn't closed* (work underway).
- Dot/accent: **green** (`--success`). Tag "active".
- Shows everything Drafting shows **plus a progress bar** = fraction of board items closed
  (e.g. "40%"), an **open-count** ("12 open"), and the fleet pill is the focal point when live.
  This is the busiest, most "alive" card — the one users watch.

**4. Shipped** — *board is closed* (done).
- Dot/accent: **dim/muted** (`--fg-dim`). Tag "shipped".
- Shows: title, repos, a **100% / complete** progress treatment, last-updated. Calm, finished,
  de-emphasized (it's history). Could be collapsed/condensed by default.

### Section C — Blueprints (authoring projects)

**5. Blueprint project.** A project whose deliverable is a reusable blueprint published as a gist —
no repos, no fleet, no board.
- Distinct visual identity from the GitHub projects (it's a *template*, not an app). Use the
  **author/template** motif (an accent hue per blueprint, an icon/initial).
- Shows: blueprint **name**, one-line **pitch**, the **stage count** (how many planning stages the
  blueprint defines), its **lifecycle category** (greenfield / transform / harden / maintain /
  data), and its **publish/visibility state**:
  - *draft* — not yet published (still designing it),
  - *private gist* — published, shareable by link (show the gist link),
  - *public gist* — published publicly.
- No progress bar / open count / fleet pill (none apply).

## The data each card actually has

Use these fields; don't invent others.

| Field | Applies to | Notes |
|---|---|---|
| title / name | all | project title or blueprint name |
| description / pitch | all | one line |
| board number (`#N`) | drafting, active, shipped | GitHub Projects v2 number |
| status | drafting, active, shipped | derived: closed→shipped, 0 items→drafting, else active |
| repos | published projects | `owner/name`; show short names, first 2 + "+N" |
| progress % | active (and shipped=100%) | closed items / total items |
| open count | active | open items |
| fleet pill | drafting, active | "N agents running · M paused" — live, pulsing dot, only when > 0 |
| updated time | all | relative ("3h ago", "2d ago") |
| stage count | blueprint | number of planning stages in the blueprint |
| category | blueprint | greenfield / transform / harden / maintain / data |
| visibility | blueprint | draft / private gist / public gist (+ gist URL when published) |
| accent hue | blueprint | a per-blueprint oklch hue for its icon |

## Interactions

- **Whole card click** → opens the project's planner (or, for a published project, you may surface
  "open board" vs "open planner").
- **Overflow menu (⋯)** → for published projects: open GitHub board, delete; for drafts/blueprints:
  delete (and for blueprints, open/edit).
- **Live updates** — the fleet pill animates while agents run; design a subtle "live" treatment.
- **Search + sort** in the header (by recency / name). Section headers show a count.
- **Empty states** per section (e.g. "No blueprints yet — create one from the Blueprints tab").

## Design-system constraints (match the app exactly)

Dark desktop UI. Use the existing CSS custom-property tokens — **do not introduce new colors**:

- Surfaces: `--bg-canvas`, `--bg-panel`, `--bg-elev`, `--bg-elev2`
- Text: `--fg`, `--fg-muted`, `--fg-dim`
- Accents: `--accent` (amber, the brand accent), `--success` (green), `--danger` (red),
  `--info` (blue) — used sparingly for state.
- Lines: `--border`, `--border-soft`
- Radius: `--r-md`
- Fonts: **Inter** for UI text (`--sans`); **JetBrains Mono** for metadata, counts, ids, tags
  (`--mono`). Numbers/ids/tags are almost always mono and small (9–11px).

Existing visual idioms to stay consistent with: a small round **status dot** colored by state; a
left **accent border** on hover; pill-shaped **tags** (mono, ~9.5px); a thin **progress bar**;
generous vertical rhythm; restrained color (mostly greyscale, accent only for state/live signals).

## What to produce

1. The full **Projects page** layout: header (title + count + search/sort + "New project"), then
   the three sections — **Drafts**, **Projects** (with the active / drafting / shipped lifecycle
   groups), and **Blueprints** — each with a labeled, counted section header.
2. Each of the **5 card states** designed individually (unpublished draft · drafting · active ·
   shipped · blueprint), showing exactly the data listed above.
3. The **live fleet pill** treatment.
4. **Empty states** for each section.
5. Keep blueprints visually distinct from GitHub projects — a template, not an app.

Deliver as the prototype's JSX/CSS using the token vocabulary above (no hard-coded colors).
