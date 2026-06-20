# Claude Design kickoff — Data Collection planner panes (Targets · Source legitimacy · Acquire · Extract)

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for **four** planner panes and their states, using the exact design tokens below, so they drop into base-studio-code with minimal rewiring.

---

## 1. What you're designing

Four new **planner panes** for base-studio-code's **Data Collection blueprint** — the lifecycle for acquiring **net-new external data** (web scraping or dataset/API fetch) into a canonical **Data Model**. The blueprint's stages are `context → collectTargets → dataModel → sourceLicensing → dataAcquire → dataExtract → dataClean → dataLoad`. Several already have panes; the **clean → load back half is shared with the migration blueprint and already built** (reconcile + quality gate + lineage). **You're designing the four acquisition-specific stages that don't have a pane yet:**

1. **Targets** (`collectTargets`) — declare the external sources and bind the Data Model they feed.
2. **Source legitimacy** (`sourceLicensing`) — ToS / robots.txt / license clearance per source. **This is a hard gate that blocks acquisition** — compliance, not a nicety.
3. **Acquire** (`dataAcquire`) — **scrape** (rate-limited, robots-aware crawl) or **fetch** (download a file / pull an API) the raw artifacts.
4. **Extract** (`dataExtract`) — parse the raw artifacts (HTML / JSON / CSV / Parquet) into structured rows mapped to the Data Model.

They are **siblings to the existing stage panes** (Context, Repos, the migration Source pane) — same chrome, same gate/footer vocabulary — but their own surfaces. The throughline: **acquire external data *legitimately* and turn it into clean, structured rows** for the shared clean→load back half.

## 2. Product context (so the design fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many Claude coding agents in parallel. Its flagship feature is the **project planner**: a plan is built **one stage at a time**, and a fleet of agents then executes it.
- The planning page is a **split**: a live Claude terminal session on the left, and a **focused pane** on the right that shows **one stage at a time**. The focused pane has a fixed vocabulary you must match:
  - a **stepper** (the stages, with status dots),
  - a **stage header** (title + a **gate pill** — "met" vs "N/M needed"),
  - a **scrolling body** (`.pp-scroll`, padding `14px 16px 18px`),
  - a **footer advance bar** (`← back` · `phase X of Y` · a primary **approve & continue →** action).
- You're designing the **bodies** of these four stages; the stepper/header/footer already exist (show them lightly for context, the focus is the bodies).
- **Multi-source is the norm** — a collection project usually pulls from several sources at once (a few sites + an API + a dataset), all feeding one Data Model. Every pane should read comfortably with **2–4 sources**.
- **The data is external and schema-less** — unlike migration (which infers a schema from an existing system), collection acquires raw data and *maps it into* a Data Model the user has bound. So these panes reference a **bound target Data Model** and the **sources**, not an existing codebase.

## 3. Pane A — Targets (`collectTargets`)

**Goal:** declare *what* to collect and *where it lands*. Sections:

1. **Sources** — a list of external sources. For each: a URL / endpoint / dataset locator, a **source type** (website / page-set · REST API · file or dataset · feed), and a label. Add / remove sources. Each source carries an inferred **acquisition mode** chip — **scrape** (a website) vs **fetch** (an API / file / dataset) — foreshadowing the Acquire stage.
2. **Scope per source** — what subset to collect: URL patterns / start pages, a query or date range, a record cap. Keeps the crawl/fetch bounded.
3. **Target Data Model** — bind the canonical **Data Model** these sources feed (choose an existing one or create it). Show its entities so the user sees what the collected rows will populate.
4. **Readiness summary** — sources declared + a Data Model bound (drives the gate), plus a one-liner on what's next: *"N sources (M scrape · K fetch) → the `Events` Data Model."*

**Gate:** ≥1 source declared and a Data Model bound.

## 4. Pane B — Source legitimacy (`sourceLicensing`)

**Goal:** clear every source for the intended use **before any data is acquired**. This is the compliance gate — make it feel authoritative, not decorative. Sections:

1. **Per-source clearance** — for each source a clearance row with a status: **cleared · needs review · blocked**. Blocked/needs-review sources are visually prominent (`--danger` / `--accent`) — they must be resolved (narrow scope or drop the source) before the stage can pass.
2. **robots.txt** — the fetched `robots.txt` for a scrape source, showing which paths are **allowed vs disallowed** for our crawl, and the crawl-delay it requests. Disallowed target paths block the source.
3. **Terms & license** — the site's ToS / the dataset's license (e.g. `CC-BY`, `proprietary`, `ToS: non-commercial`), with any **attribution** requirement surfaced. For an API: the API terms / rate policy.
4. **Intended use** — a short declaration of what the project will do with the data (the thing ToS compliance hinges on) — e.g. "internal analytics, non-redistributed."
5. **Readiness summary** — every source **cleared or dropped** (drives the gate). A blocked source listed here is a hard stop.

**Gate (the licensing gate):** every declared source is cleared for the intended use — **blocks Acquire** until then.

## 5. Pane C — Acquire (`dataAcquire`)

**Goal:** configure and preview the raw-data capture per source, in **scrape** or **fetch** mode. Sections:

1. **Per-source acquisition** — a card per source, switched by its mode:
   - **Scrape** (websites): crawl scope (start URLs, depth, include/exclude URL patterns), a **rate limit** (requests/sec, concurrency, politeness delay), a **robots-respect** toggle (on, tied to the clearance), pagination handling, and a JS-render toggle.
   - **Fetch** (API / file / dataset): the endpoint/URL, **auth** (token / API-key — *names only*, never values), pagination / cursoring, response format, and one-shot vs scheduled.
2. **Guardrails** — rate-limit + robots compliance shown as visibly enforced (carry the `--success` "robots-respected" / rate badges) — the link back to the licensing clearance.
3. **Capture preview / run** — what will be captured: estimated pages / records, and the **raw artifacts** (HTML / JSON / files) staged to a working area. A genuinely **live** state when a crawl/fetch is running (progress, pages fetched, errors) — pulse here.
4. **Readiness summary** — raw artifacts captured for every source (drives the gate).

**Gate:** raw artifacts captured for each source.

## 6. Pane D — Extract (`dataExtract`)

**Goal:** turn the raw artifacts into structured rows mapped to the Data Model. Sections:

1. **Per-source extraction rules:**
   - **HTML** (scrape): a **selector → field** table (CSS/XPath for each field), with list-page vs detail-page handling.
   - **JSON / CSV / Parquet** (fetch): a **path/column → field** mapping (JSONPath or column name → Data Model field).
2. **Field mapping** — each extracted element maps to a **Data Model entity field** (source element → model field); unmapped model fields and unmapped source elements are surfaced as gaps.
3. **Sample extraction preview** — run the rules against one sampled artifact and show the **structured rows produced** (a preview table) plus extraction misses/errors. This is the marquee element — the "did my selectors work" moment.
4. **Coverage** — % of artifacts that parse cleanly, and which fields are reliably populated.
5. **Readiness summary** — structured rows produced for every source (drives the gate); a one-liner that this feeds the shared **Clean → Load** back half (quality gate + reconcile + lineage).

**Gate:** structured rows produced for every source.

## 7. States to design (for all four panes)

1. **Empty / unstarted** — nothing declared. Friendly empty state; the planner offers a **proposed starting point** (Targets: "Add the first source"; Acquire: "React + a sitemap detected → scrape at 1 req/s").
2. **Partially defined** — some sources/sections done, others not. The readiness summary lists exactly what's missing; the footer's **approve & continue** is disabled with a "still needed: …" reason. For **Source legitimacy**, a blocked source shows the gate as hard-blocked with the reason.
3. **Defined (gate met)** — all required pieces present; readiness summary green; approve enabled; the downstream hand-off line populated.
4. **Live (Acquire only)** — a crawl/fetch in progress: per-source progress, pages/records captured, errors. Use pulse/animation here (genuinely live).
5. **Multi-source** — 2–4 sources each with their own config/status (stacked cards or per-source tabs), with the bound Data Model shared above.

Also show the **stage in the stepper** in two states for context: *active/in-progress* and *complete*.

## 8. Design system — match these EXACTLY

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
- **Type:** titles/labels in `--sans`; all metadata, counts, URLs, selectors, field keys, and "code-ish" text in `--mono`. Section headers are small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards:** `background:var(--bg-panel)`, `border:1px solid var(--border-soft)`, `border-radius:var(--r-lg)`, ~`13–16px` padding. Nested rows on `--bg-elev` / `--bg-elev2`.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` background + `…transparent 70–78%` border. Use `--success` for "cleared / allowed / captured", `--accent` for "needs review / attention / proposed", `--info` for neutral/links, `--violet` for the Data Model / entities, `--danger` for "blocked / disallowed / gap", `--fg-dim` for inert.
- **Mode chips** — a consistent **`scrape`** vs **`fetch`** chip on each source, used across all four panes so a source reads the same everywhere.
- **Clearance status** (Source legitimacy): `cleared` (success) · `needs review` (accent) · `blocked` (danger) — the blocked state must visibly hold the gate.
- **robots allowed/disallowed**: per-path pills (`allowed` success / `disallowed` danger).
- **Selector → field rows** (Extract): a two-column mono mapping — selector/path on the left, the Data Model field (with a `--violet` entity chip) on the right; an unmapped field shows a `--danger` gap pill. Include a **sample preview table** of extracted rows.
- **Rate-limit / live progress** (Acquire): calm numeric badges (`1 req/s` · `depth 2` · `robots ✓`); a live run uses a subtle progress indicator + pulse.
- **Gate pill** in the header: "✓ cleared / captured / extracted" (success) vs "2/4 needed" (accent); Source-legitimacy shows a hard "blocked" (danger) when a source isn't cleared.
- **Footer advance bar:** `← back` · `phase X of Y` (mono, `--fg-dim`) · primary **approve & continue →** (accent fill, dark text; disabled = dim with a "still needed: …" tooltip).
- Keep it **dense and technical** but calm — config/inspection surfaces, not marketing. No drop shadows except menus/modals. Pulse/animation only for genuinely-live status (the Acquire crawl).
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 9. Data shape (use realistic sample data)

Design against one believable collection project so all four panes share context:

- **Project:** "Build a directory of tech-conference talks" → a `Talks` Data Model (entities `Talk`, `Speaker`, `Session`).
- **Targets:** two sources — `https://confsite.com/2024/sessions` (**scrape**, website) and `https://api.confsite.com/v1/speakers` (**fetch**, REST API). Scope: 2024 sessions only; speakers paginated.
- **Source legitimacy:** confsite robots.txt **allows** `/2024/sessions` (crawl-delay 1s) but **disallows** `/admin`; ToS permits non-commercial use with attribution → **cleared**. The speakers API is `CC-BY` → **cleared**. (Show a third source in one state that's **blocked** — robots disallows the target path — to exercise the gate.)
- **Acquire:** scrape sessions at **1 req/s, depth 2, robots ✓**, ~180 session pages; fetch speakers via cursor pagination (~140 records). Live state: "scraping… 96 / ~180 pages."
- **Extract:** HTML selectors `.session-card .title` → `Talk.title`, `.session-card .speaker` → `Talk.speaker` (ref → `Speaker`), `time[datetime]` → `Session.startsAt`; JSON `$.speakers[].name` → `Speaker.name`. Sample preview: 5 extracted `Talk` rows; coverage "172/180 pages parsed · 1 field gap (`Talk.track`)".
- Show the gate as **"3/4 — needs: Extract field mapping"** in one state and fully green in another.

## 10. Deliverable

Functionless React JSX skeleton(s) (one file is fine; the four pane bodies + their empty / partial / defined / live / multi-source states stacked or via a `state` prop) using the tokens above — **Targets**, **Source legitimacy**, **Acquire**, **Extract** — plus the stepper/header/footer shown lightly for context. No real logic, no data fetching — just the structure, styling, and sample data, the way the rest of `design/` is built.
