# Claude Design kickoff — Data Migration / Source pane (the "data dictates structure" step)

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for the pane and its states, using the exact design tokens below, so it drops into base-studio-code with minimal rewiring.

---

## 1. What you're designing

A new **Migration / Source** pane inside base-studio-code's **project planner**. This is the step where — *before* the new system's structure is designed — the planner connects **read-only** to the customer's **existing system** (e.g. a Salesforce CRM), inventories what's there, and **infers a canonical Data Model from the real records and custom fields**. The user then **reviews and refines** that inferred model. The whole bet of this step: **the existing data dictates the structure of the generated application.** Whatever schema is confirmed here is what `features` and `structure` design over, and what the new app is built on top of.

It is a **sibling to the existing Permissions/Structure/Deploy stage panes** — same chrome, same gate/footer vocabulary — but its own surface. The defining requirement: **the user must be able to *see everything happening*** — the connection, what was found, what the AI inferred and *why*, and exactly how it will shape the new system. Nothing about the derived schema should be invisible or magical.

## 2. Product context (so the design fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many Claude coding agents in parallel. Its flagship feature is the **project planner**: a pitch is turned into a plan **one stage at a time** — context → repos → **source (this pane)** → deploy → features → UI → structure → permissions → …
- The planning page is a **split**: a live Claude terminal session on the left, and a **focused pane** on the right that shows **one stage at a time**. The focused pane has a fixed vocabulary you must match:
  - a **stepper** (the stages, with status dots),
  - a **stage header** (title + a **gate pill** — "met" vs "N/M needed"),
  - a **scrolling body** (`.pp-scroll`, padding `14px 16px 18px`),
  - a **footer advance bar** (`← back` · `phase X of Y` · a primary **approve & continue →** action).
- This pane is the **body** of the new **Source** stage. Design the body; the stepper/header/footer already exist (show them lightly for context, but the focus is the body).
- **Crucial ordering point to convey in the design:** this stage sits **before** `features`/`structure`. The inferred model flows *downstream* into them. So the pane's payoff section is a **"this is what your app will be built from"** view, not a "done, moving on" one.
- **Read-only, always.** base-studio-code reads from the source, maps, and loads into the new system — it **never writes back** into the system of record. Make the read-only posture visible and reassuring (a badge, not fine print).
- **Two timings, one stage:** schema is **inferred now** (so it can drive design); the actual **record load** runs later as a build-time migration stream. This pane therefore shows the inferred model *live* and the load as a **preview of what will happen at build**, not a thing that's already finished.

## 3. Goal of the pane

Let the user, fast and with the planner doing the heavy lifting: **connect read-only to an existing system, see exactly what data lives there, watch a canonical Data Model get inferred from it, understand why each entity/field was inferred, refine it (drop cruft, rename, retype, set identity), and see how it will seed the new system** — to a level of confidence that they're comfortable letting the generated app be built over this schema. The planner proposes; the user confirms/edits everything.

## 4. Sections of the pane (top to bottom)

Render these as **cards** (`--bg-panel`, `1px solid --border-soft`, `--r-lg`), each with a small mono uppercase section label. A subtle "✦ inferred by planner" affordance wherever the planner derived a value (the user can accept/override). Use a clear **"read-only"** badge near the source connection.

1. **Source connection** *(per source)* — connect read-only to an existing system: a grid of source tiles — **Salesforce, HubSpot, Dynamics 365, a SQL database (Postgres/MySQL), an OData/OpenAPI endpoint (SAP speaks OData), CSV / data export upload**. Selecting one shows connection state (**not connected · connecting · sampling · connected · error**) and a prominent **READ-ONLY** badge. Support **more than one source** feeding the same model (a small "add source" affordance).
2. **Inventory** — *what was found* in the source. A list of objects/tables — `Account`, `Contact`, `Opportunity`, plus **custom objects** (e.g. `Project__c`) — each row showing field count, **record count**, and a **"custom" marker**. Expand an object to see its fields and a few **sample rows** (real-looking values). This is the evidence the inference is built from; make it browsable.
3. **Inferred Data Model** *(the marquee element)* — the canonical model **derived from the inventory**. Entities, each with fields; **every field shows its inferred `type`** (string · number · money · date · bool · **enum** · **ref**) and **its provenance + the signal that produced it**, e.g.:
   - a Salesforce **picklist → `enum`** (show the enum values),
   - a **lookup / master-detail → `ref`** to another entity (show the relationship),
   - **% of records populated → required vs optional**, and which fields form the **identity / merge key**.
   Show a small **confidence / "why"** chip per inference. This section is "data dictates structure," made legible — the reader should be able to trace every entity and field back to something real in the source.
4. **Refine the schema** — the human pass that the whole flow hinges on. Inline editing of the inferred model: **rename** entity/field, **change a type**, **set/clear identity**, **merge** two near-duplicate entities, and especially **drop cruft** — surface low-value fields explicitly (e.g. a custom field at **"2% populated — drop?"**) so dead Salesforce baggage isn't immortalized in the new system. Frame this clearly: **"this becomes the schema your new app is built over."**
5. **Field mapping** *(source → model)* — for the eventual load: each source field maps to a model field, or is **explicitly dropped (recorded)**. Auto-proposed by the planner; editable. Surface the **gaps** both ways: unmapped source fields, and new-model fields with **no source** (net-new, to be defaulted/collected). For multi-source, show which source feeds each entity and the **precedence order** when they overlap.
6. **Load preview** *(what happens at build)* — a **preview**, not a completed action: per entity, the rows that *will* load, with **per-field lineage** (which source supplies each value), a **quality/trust** signal (null rates, validation pass-rate against the model's rules), and the reconciliation result for multi-source (records merged by identity, conflicts resolved by precedence). Make it read as "here's what the migration stream will do at build time."
7. **Downstream impact — "what your app will be built from"** — the payoff recap that makes the ordering obvious: a compact statement like **"This model seeds 4 entities / 37 fields that `features` and `structure` will design over,"** plus a preview of the artifacts this produces: the **canonical Data Model** artifact, the **migration stream**, and the **load issues** generated at publish (e.g. "Generate read-only Salesforce connector (MCP)", "Backfill `Account`/`Contact`/`Opportunity` with lineage", "Quality gate: ≥98% validation pass before load"). This section also drives the **gate** (source reachable · model inferred · schema refined/confirmed · mapping resolved).

## 5. States to design

1. **Empty / no source** — nothing connected. Friendly empty state with a primary CTA to pick a source and a clear **read-only** reassurance. If the pitch mentions an existing system, the planner offers a **proposed source** ("Detected: migrating from Salesforce — connect read-only?").
2. **Connecting / sampling (live)** — connection established, inventory populating, **inference running**. This is a genuinely *live* moment — show progress (objects discovered, records sampled, model being inferred) so the user watches it happen. Use pulse/animation here (this is real live status).
3. **Inferred — awaiting review** — the model is proposed with full provenance; gate reads "review the derived schema." This is the heart of the pane: inventory + inferred model + the "why" chips, refinement controls active.
4. **Refined / gate met** — model confirmed; the **downstream-impact** card shows it feeding `features`/`structure`; the load preview + generated-artifacts list are populated; approve enabled.
5. **Multi-source** — Salesforce **+** a SQL database feeding the **same** model: show per-source provenance on fields, the precedence order, and a merged/reconciled load preview with conflict counts.
6. **No legacy system (skipped)** — a brief state showing this stage is **optional and skippable** when the project is greenfield-from-nothing (no source to infer from) — so it's clear this step only appears/matters when there's an existing system.

Also include the **stage in the stepper** in two states for context: *active/in-progress* and *complete* — and make its position **before** features/structure legible.

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

Conventions (the rest of the app follows these — match them so the pane is indistinguishable):
- **Type:** titles/labels in `--sans`; all metadata, counts, keys, field names, types, and "code-ish" text in `--mono`. Section headers are small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards:** `background:var(--bg-panel)`, `border:1px solid var(--border-soft)`, `border-radius:var(--r-lg)`, ~`13–16px` padding. Nested rows on `--bg-elev` / `--bg-elev2`.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` background + `…transparent 70–78%` border. Use `--success` for "met/ready/loaded", `--accent` for "inferred/needs review/attention", `--info` for neutral/links/refs, `--violet` for enums, `--danger` for blocking/low-quality/drop, `--fg-dim` for inert.
- **Field-type chips:** give each `FieldType` (string/number/money/date/bool/enum/ref) a consistent mono chip; `ref` and `enum` are the visually distinctive ones (refs point to an entity; enums carry values).
- **Provenance / "why" chips:** a small mono chip on inferred fields, e.g. `← Account.Type (picklist)` or `lookup → Account` or `92% populated`. These are the "see everything" payoff — make them present but calm.
- **Segmented toggles** (e.g. required/optional, source precedence): the app's `Seg` pattern — a bordered row, the active segment on `--bg-elev2` + `--fg`, others transparent + `--fg-dim`.
- **Selectable tiles** (sources): a tile grid; selected = `--accent` border + faint accent wash; hover lifts to `--bg-elev`.
- **READ-ONLY badge:** a clear, calm success/info-tinted pill near the source — reassurance, not a warning.
- **Gate pill** in the header: "✓ schema confirmed" (success, `met`) vs "review derived schema" / "2/4 needed" (accent, `unmet`).
- **Footer advance bar:** `← back` · `phase X of Y` (mono, `--fg-dim`) · primary **approve & continue →** (accent fill, dark text; disabled = dim with a "still needed: …" reason).
- Keep it **dense and technical** but calm — this is an inspection + config surface, not marketing. No drop shadows except menus/modals. Pulse/animation only for genuinely-live status (the sampling/inference moment).
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 7. Data shape (use realistic sample data)

Design against a believable Salesforce migration so it reads true:

- **Source:** Salesforce (read-only), connected.
- **Inventory:** standard objects `Account` (12,431 records), `Contact` (28,902), `Opportunity` (6,210), plus a **custom object** `Project__c` (1,884) with custom fields:
  - `Health__c` — picklist `{Green, Yellow, Red}` → inferred **`enum`**,
  - `Account__c` — lookup → inferred **`ref` → Account**,
  - `Contract_Value__c` — currency → inferred **`money`**,
  - `Legacy_Code__c` — **2% populated → "drop?"** candidate (the refinement story).
- **Inferred model "CRM Core":** entities `Account` (identity: `domain`), `Contact` (identity: `email`), `Opportunity`, `Project` — fields carrying provenance/why chips and type chips as above.
- **Load preview:** "will load 49,427 rows across 4 entities · lineage 100% · validation 98.6% pass · 1 conflict (Account.name) resolved by precedence: Salesforce > SQL export."
- **Downstream impact:** "Seeds 4 entities / 37 fields into `features` + `structure`" + the three generated artifacts (Data Model, migration stream, load issues).
- Show the readiness/gate as **"3/4 — needs: schema refined"** in one state and fully green in another.

## 8. Deliverable

Functionless React JSX skeleton(s) (one file is fine, multiple screens/states stacked or via a `state` prop) using the tokens above — the **Source stage body** plus the **empty / connecting-sampling / inferred-review / refined / multi-source / skipped** states, and the stepper/header/footer shown lightly for context (with this stage positioned **before** features/structure). No real logic, no data fetching — just the structure, styling, and sample data, the way the rest of `design/` is built.
