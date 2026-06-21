# Claude Design kickoff — Feature Add planner panes (Architecture fit + Test coverage)

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for **two** planner panes and their states, using the exact design tokens below, so they drop into base-studio-code with minimal rewiring.

---

## 1. What you're designing

Two new **planner panes** for base-studio-code's **"Feature Add" blueprint** — the lifecycle for adding a feature to an **existing** system. The blueprint's stages are `context → repos → architecture → structure → permissions → testing`; four of those already have panes. **You're designing the two that don't:**

1. **Architecture fit** (stage `architecture`) — design how the new feature slots into the *existing* architecture: what it touches, what it adds, and the seams/risks.
2. **Test coverage** (stage `testing`) — define the tests that prove the feature works *and* don't regress the system it lands in.

They are **siblings to the existing Context/Repos/Structure/Permissions stage panes** — same chrome, same gate/footer vocabulary — but their own surfaces. Because this is a *feature-into-an-existing-system* flow, both panes are framed around an **existing codebase** the feature plugs into, not a greenfield build.

## 2. Product context (so the design fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many Claude coding agents in parallel. Its flagship feature is the **project planner**: a plan is built **one stage at a time**, and a fleet of agents then executes it.
- The planning page is a **split**: a live Claude terminal session on the left, and a **focused pane** on the right that shows **one stage at a time**. The focused pane has a fixed vocabulary you must match:
  - a **stepper** (the stages, with status dots),
  - a **stage header** (title + a **gate pill** — "met" vs "N/M needed"),
  - a **scrolling body** (`.pp-scroll`, padding `14px 16px 18px`),
  - a **footer advance bar** (`← back` · `phase X of Y` · a primary **approve & continue →** action).
- You're designing the **bodies** of the Architecture-fit and Test-coverage stages; the stepper/header/footer already exist (show them lightly for context, the focus is the bodies).
- **The feature is known by this point.** Earlier stages captured the feature intent (Context), linked the existing repo(s) (Repos), and the planner has scanned the codebase — so both panes can reference **real existing components** and the **feature's acceptance criteria**.

## 3. Pane A — Architecture fit

**Goal:** let the user, with the planner pre-filling proposals from the existing codebase, answer **where the feature plugs into the system that's already there** — what it touches, what's net-new, and what could break — to a level an agent can then build against without re-deriving the architecture.

Sections (top to bottom), each a **card** (`--bg-panel`, `1px solid --border-soft`, `--r-lg`) with a small mono uppercase label and a subtle "✦ proposed by planner" affordance where the planner pre-filled it:

1. **Existing system map** — a compact view of the components/modules/services already in the repo(s) the planner detected (a light node list or small diagram). This is the *context the feature lands in*; the feature's touchpoints are highlighted within it.
2. **Touchpoints** *(the integration surface)* — the existing components the feature **modifies / extends / calls**, each tagged with the kind of change (extend · modify · call · read) and a one-line note. This is the marquee element — make the "what existing code this feature reaches into" legible.
3. **New pieces** — the net-new components the feature introduces: modules/services, **API endpoints/contracts**, jobs, UI surfaces. Each with a name + a one-line responsibility.
4. **Data & contracts** — new or changed **entities/fields** and **API contracts** (request/response shape, in brief). Distinguish *new* from *changed-existing* (the latter carries back-compat weight).
5. **Seams & risks** — where the feature **couples** to existing code, **back-compat / migration** concerns, and the **blast radius** (what regresses if this goes wrong). Each risk with a severity tint.
6. **Readiness summary** — a compact recap of what's **defined vs missing** (this drives the stage's gate), and a one-line statement of how this feeds the next stage: *"This architecture seeds the Work-breakdown stage with N touchpoints + M new pieces to turn into issues."*

**Gate:** touchpoints identified, new pieces specified, and no unresolved integration unknown left open.

## 4. Pane B — Test coverage

**Goal:** define the **test safety net** that proves the feature works *and* protects the existing behavior it touches — mapped tightly to the feature's acceptance criteria — so the fleet builds it test-first and the change can't silently regress the system.

Sections (top to bottom), same card styling:

1. **Acceptance → tests** — a table mapping each **acceptance criterion** (carried in from the feature) to one or more **planned tests** (name + layer). Surface any acceptance criterion with **no test yet** as a gap. This is the marquee element — every acceptance line should trace to a test.
2. **Test layers** — coverage across **unit · integration · e2e**, for both the **new pieces** and the **touchpoints** (from the Architecture-fit pane). Show counts/coverage per layer.
3. **Regression guard** *(crucial for a feature-into-existing flow)* — the tests that **protect the existing behavior** the feature touches: characterization tests on the touched surfaces, the existing suites that must stay green. Make this section visibly first-class — it's what separates "add a feature" from "build new."
4. **Coverage targets & CI gate** — the coverage threshold(s) and which test stages **gate** the pipeline (block merge/deploy) vs run informationally.
5. **Tooling** — the test frameworks / runners (proposed from the detected stack), fixtures, and any test data/mocks needed.
6. **Readiness summary** — what's **covered vs gaps** (drives the gate): "every acceptance criterion has a test, and every touched surface has regression coverage."

**Gate:** every acceptance criterion maps to ≥1 test, and each touched existing surface has regression coverage.

## 5. States to design (for BOTH panes)

1. **Empty / unstarted** — nothing captured yet. Friendly empty state; the planner offers a **proposed starting point** derived from the codebase scan (Architecture: "Detected modules: …"; Testing: "Detected test setup: Vitest + Playwright").
2. **Partially defined** — some sections done, others not. The readiness summary lists exactly what's missing; the footer's **approve & continue** is disabled with a "still needed: …" reason (matches the other stages' gate behavior).
3. **Defined (gate met)** — all required pieces present; readiness summary green; approve enabled; the downstream hand-off line populated.

Also show the **stage in the stepper** in two states for context: *active/in-progress* and *complete*.

## 6. Design system — match these EXACTLY

Dark is the primary theme. Tokens (CSS custom properties — use them, don't hardcode hex):

```css
:root{
  --bg-canvas:oklch(0.13 0.005 250); --bg-panel:oklch(0.17 0.005 250);
  --bg-elev:oklch(0.21 0.006 250);   --bg-elev2:oklch(0.26 0.006 250);
  --border:oklch(0.30 0.006 250);    --border-soft:oklch(0.24 0.006 250);
  --fg:oklch(0.94 0.004 250); --fg-muted:oklch(0.66 0.008 250); --fg-dim:oklch(0.46 0.008 250);
  --accent:oklch(0.80 0.14 70); --accent-dim:oklch(0.55 0.10 70);
  --success:oklch(0.74 0.13 145); --info:oklch(0.72 0.10 230);
  --violet:oklch(0.72 0.12 300); --danger:oklch(0.68 0.18 25);
  --mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
  --sans:"Inter",-apple-system,"Segoe UI",system-ui,sans-serif;
  --r-sm:4px; --r-md:6px; --r-lg:10px;
}
```

Conventions (the rest of the app follows these — match them so the panes are indistinguishable):
- **Type:** titles/labels in `--sans`; all metadata, counts, keys, component/file names, test names, and "code-ish" text in `--mono`. Section headers are small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards:** `background:var(--bg-panel)`, `border:1px solid var(--border-soft)`, `border-radius:var(--r-lg)`, ~`13–16px` padding. Nested rows on `--bg-elev` / `--bg-elev2`.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` background + `…transparent 70–78%` border. Use `--success` for "met/covered/passing", `--accent` for "proposed/attention", `--info` for neutral/links, `--violet` for new pieces, `--danger` for risk/gap/blocking, `--fg-dim` for inert.
- **Change-kind chips** (Architecture touchpoints): a consistent mono chip per kind — `extend` / `modify` / `call` / `read` (modify/extend carry the most weight; tint accordingly).
- **Existing-vs-new distinction:** existing components read calm/neutral; **new** pieces get the `--violet` accent so "what's being added" pops against "what's already there."
- **Acceptance→test rows** (Testing): a two-column feel — the acceptance criterion (sans) on the left, its mapped test(s) (mono, with a layer chip) on the right; an unmapped criterion shows a `--danger` "no test" gap pill.
- **Gate pill** in the header: "✓ fits / covered" (success) vs "3/5 needed" (accent).
- **Footer advance bar:** `← back` · `phase X of Y` (mono, `--fg-dim`) · primary **approve & continue →** (accent fill, dark text; disabled = dim with a "still needed: …" tooltip).
- Keep it **dense and technical** but calm — these are planning/config surfaces, not marketing. No drop shadows except menus/modals. Pulse/animation only for genuinely-live status (e.g. the codebase scan populating).
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 7. Data shape (use realistic sample data)

Design against one believable feature-add so both panes read true and share context:

- **Feature:** "Add CSV / PDF export to the Reports module" of an existing **React + Node/Express + Postgres** analytics app.
- **Architecture fit:**
  - Existing modules: `web/Reports`, `api/reports`, `api/render-pipeline`, `db` — `Reports` + `render-pipeline` highlighted as touched.
  - Touchpoints: `api/reports` (**extend** — add export route), `api/render-pipeline` (**call** — reuse for PDF), `web/Reports` (**modify** — add an Export button).
  - New pieces: `ExportService` (module), `POST /reports/:id/export` (endpoint), `report_exports` (audit table).
  - Data & contracts: new entity `report_exports{ id, report_id (ref), format enum[csv,pdf], requested_by, created_at }`; endpoint `→ { jobId, status }`.
  - Seams & risks: couples to the shared render-pipeline (medium — used by live reports too); large-report export is a perf/blast-radius risk (high).
  - Readiness: "4/5 — missing: the export endpoint's contract."
- **Test coverage:**
  - Acceptance → tests: "Exports a report as CSV with correct columns" → `export.csv.spec` (integration); "Exports as PDF matching the on-screen layout" → `export.pdf.spec` (e2e); "Large reports (>50k rows) export without timing out" → **no test yet** (gap).
  - Layers: unit (ExportService formatters), integration (the new route), e2e (the Reports Export button flow).
  - Regression guard: existing `render-pipeline.spec` must stay green; characterization test on `GET /reports/:id` (unchanged behavior).
  - Coverage target: 85% on `ExportService`; e2e export flow gates the pipeline.
  - Tooling: Vitest + Supertest (api), Playwright (e2e).
  - Readiness: "covered 2/3 acceptance · 1 gap (large-report perf)".

## 8. Deliverable

Functionless React JSX skeleton(s) (one file is fine; the two panes + their empty / partial / defined states stacked or via a `state` prop) using the tokens above — the **Architecture-fit body** and the **Test-coverage body**, plus the stepper/header/footer shown lightly for context. No real logic, no data fetching — just the structure, styling, and sample data, the way the rest of `design/` is built.
