# Claude Design kickoff — Source pane model + process visualizations

Paste this whole brief into a Claude Design session. Deliverable: functionless React **JSX skeletons** (Babel-standalone style, no real logic) for three visualizations of a scanned source, plus the view toggle and states, using the exact design tokens below — so they drop into base-studio-code's **Source** stage pane with minimal rewiring. Companion briefs: `docs/migration-source-pane-kickoff.md` and `docs/migration-source-credentials-pane-kickoff.md`.

---

## 1. What you're designing

Three ways to *see* what a migration source scan discovered, inside base-studio-code's planner **Source** pane. After a source is connected read-only and scanned, the app infers a canonical **Data Model** (entities + fields + relationships) and captures the system's **behaviors** (automations, business processes, derived logic). Today the pane shows this flat — a name+count grid and a row of behavior chips. You're designing the visual layer:

1. **Relationship graph** — the marquee: the inferred Data Model as a node-and-edge diagram (entities, their fields with types, and the `ref` relationships between them). "Here's the schema your new app is built from," made legible.
2. **Simpler list** — the same model as a dense, scannable list (entity → fields). The fast, low-noise default for large models.
3. **Process view (BPM)** — for systems whose value is *process* (Pipefy, monday.com, Salesforce approval processes, ServiceNow flows): visualize the captured **business processes** as step flows and the **automations** as small trigger→condition→action diagrams.

A **view toggle** (Graph · List · Process) switches between them. All three render the *same* scanned data, three ways.

## 2. Product context (so it fits)

- **base-studio-code** is a desktop app (Tauri + React, dark-first) for running many Claude coding agents in parallel. The planner builds a plan **one stage at a time** in a **focused right pane** with a fixed vocabulary you should match lightly (a **stepper** with status dots, a **stage header** + **gate pill**, a scrolling body `.pp-scroll`, a **footer advance bar**). You're designing the **body** of the Source stage's "scanned result" section; show the chrome lightly for context.
- This is **read-only** inspection of a source (#782) — these views *display* the inferred model + behaviors; they don't author. (A separate model editor exists for refinement.)
- **Multi-source is normal** — entities/processes can come from 2–4 sources feeding one model; show per-source provenance (a small source badge / color).
- Keep it **dense and technical but calm** — an inspection surface, not marketing. Pulse/animation only for genuinely-live status (a scan in progress).

## 3. The data shapes (design against these exactly)

**Data Model** (the graph + list render this):

```ts
type FieldType = "string" | "number" | "bool" | "date" | "money" | "ref" | "enum";
interface Field {
  key: string; label?: string; type: FieldType;
  required?: boolean;
  ref?: string;          // target entity key when type === "ref" (a relationship edge)
  enumValues?: string[]; // when type === "enum"
}
interface Entity {
  key: string; label?: string;
  fields: Field[];
  identity: string[];    // field keys forming the merge/identity key
  // (display extras the pane has on hand)
  recordCount?: number;  // discovered row count
  source?: string;       // which connector it came from (multi-source)
}
interface DataModel { id: string; name: string; version: number; entities: Entity[] }
```

**Behaviors** (the process view renders these — vendor-neutral `PlatformScan`):

```ts
type AutomationKind = "validation" | "workflow" | "flow" | "processBuilder" | "recurring" | "other";
interface Automation { source: string; kind: AutomationKind; name: string; object: string; active: boolean; trigger: string; condition: string; actions: string[] }
interface BusinessProcess { source: string; name: string; object: string; active: boolean; steps: string[] } // ordered stage labels
type DerivedKind = "formula" | "code";
interface DerivedLogic { source: string; kind: DerivedKind; name: string; object?: string; expression: string }
interface PlatformScan { automations: Automation[]; businessProcesses: BusinessProcess[]; derivedLogic: DerivedLogic[] }
```

## 4. View A — Relationship graph (the marquee)

A node-and-edge diagram of the Data Model.

- **Entity nodes** — a card per entity: the entity label + `key` (mono), its `recordCount` (e.g. `12,431`), and its **field list**. Each field row: field key (mono) · a **type chip** (string/number/money/date/bool/**enum**/**ref**) · a `required` dot · an **identity** marker (🔑) on identity fields. `enum` fields can reveal their values; `ref` fields name their target.
- **Relationship edges** — for every `ref` field, draw a directed edge from the entity to its target entity (e.g. `Contact.account → Account`), labelled with the field. Identity/merge keys visually distinct. Use **SVG paths or styled connectors**; a believable static layout is fine (no real graph-layout engine — position the nodes by hand so it reads well).
- **Provenance / "why" chips** (optional, calm) — where a field was inferred: `← Account.Type (picklist)`, `lookup → Account`, `92% populated`.
- **Affordances** (functionless): pan/zoom hint, a "fit" button, a legend (type-chip key). Multi-source: tint a node's header by `source` + a small source badge.
- **States:** empty (nothing scanned), few entities (2–4, roomy), many entities (8+, scroll/clustered).

## 5. View B — Simpler list

The same model, dense and scannable — the default for large schemas or when the graph is too busy.

- Entities as **collapsible rows**; an entity header shows label · `key` · `recordCount` · field-count · source badge.
- Expanded: a tight field table — `key` · **type chip** · `required` · `identity` 🔑 · `ref → Target` link. Mono for keys/types.
- A one-line summary per entity when collapsed (e.g. `8 fields · id, name, account→Account`).
- This view is calm and information-first — no diagram, no edges, just the schema as text.

## 6. View C — Process view (BPM)

For sources whose value is process/automation. Three sections:

1. **Business processes** — each `BusinessProcess` as a **left-to-right (or vertical) stage flow**: its `steps[]` as a sequence of stage chips connected by arrows (`Submitted → Manager review → Finance → Approved`), with the `object` it acts on and an active/inactive state. The marquee of this view — make the flow read clearly.
2. **Automations** — grouped by `kind` (Validation · Workflow · Flow · Process Builder · Recurring). Each automation as a compact **trigger → condition → actions** mini-flow: *when* `trigger` · *if* `condition` · *do* `actions[]`. A `kind` chip and active state per automation. (Process Builder is legacy — mark it so it reads as "migrate this.")
3. **Derived logic** — `formula`/`code` units as a compact list: name · object · the `expression` in mono (truncated/expandable).
- A framing line: **"these become your app's rules, workflows, and logic"** — this view is the "behaviors are migratable" payoff.
- Multi-source: source badge per item. States: empty (no behaviors captured for this source), populated, many (scroll/group).

## 7. The view toggle + placement

- A **segmented control** (the app's `Seg` pattern) — `Graph · List · Process` — at the top of the scanned-result section.
- Sensible default: **List** for a large model, **Graph** for a small one, **Process** when the source is BPM-heavy (more processes/automations than entities) — but all selectable.
- Above the toggle, keep the existing **downstream-impact recap** ("Seeds N entities · M fields into features + structure · K behaviors carried over") as the header.

## 8. Design system — match these EXACTLY

Dark is primary. Tokens (CSS custom properties — use them, don't hardcode hex):

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

Conventions (match so it's indistinguishable from the rest of the app):
- **Type:** titles/labels in `--sans`; all keys, types, field names, expressions, counts, "code-ish" text in `--mono`. Section headers small (10px) mono, uppercase, `letter-spacing:.08em`, `--fg-dim`.
- **Cards / nodes:** `background:var(--bg-panel)`, `1px solid var(--border-soft)`, `border-radius:var(--r-lg)`. Nested rows on `--bg-elev` / `--bg-elev2`.
- **Type chips** (one per `FieldType`): a consistent mono chip; **`ref`** and **`enum`** are the visually distinctive ones (`ref` points to an entity → `--info`; `enum` carries values → `--violet`). money/date/number/bool/string calmer.
- **Pills/tags:** `border-radius:99px`, mono ~9.5px, tinted via `color-mix(in oklch, <hue>, transparent 88–90%)` bg + `…transparent 70–78%` border. `--violet` = the Data Model / entities; `--info` = relationships/refs; `--success` = active/identity-ok; `--accent` = inferred/attention; `--danger` = blocking/inactive; `--fg-dim` = inert.
- **Identity key:** a 🔑 marker (or `--success` pill) on identity fields.
- **Edges (graph):** SVG `path`/`line` in `--border` / `--info`, arrowheads for direction, the field label on the edge in mono.
- **Process flow:** stage chips on `--bg-elev2` connected by `→` in `--fg-dim`; active stages `--accent`/`--success`, the trigger→condition→action mini-flow in mono.
- **Segmented toggle:** the `Seg` pattern — a bordered row, active segment on `--bg-elev2` + `--fg`, others transparent + `--fg-dim`.
- No drop shadows except menus/modals. Pulse/animation only for a live scan.
- Fonts via Google Fonts: `Inter` (400–700) + `JetBrains Mono` (400–600).

## 9. Sample data (use realistic data so it reads true)

**Schema (graph + list)** — "CRM Core", from a Salesforce + Quickbase migration:
- `Account` (identity `domain`; 12,431 records) — `domain` string 🔑, `name` string, `industry` enum {Tech, Finance, Health}, `annual_revenue` money.
- `Contact` (identity `email`; 28,902) — `email` string 🔑, `full_name` string, `account` **ref → Account**.
- `Opportunity` (6,210) — `id` string 🔑, `amount` money, `stage` enum, `account` **ref → Account**.
- `Project` (1,884; source: Quickbase) — `id` string 🔑, `health` enum {Green, Yellow, Red}, `account` **ref → Account**, `contract_value` money. (3 ref edges into Account.)

**Behaviors (process view):**
- **Business process** "Discount Approval" (object Opportunity, active) — steps `Submitted → Manager review → Finance review → Approved`.
- **Automations:** `validation` "Account must have Type" (when onSave · if `ISBLANK(Type)` · do reject); `flow` "Auto Assign Owner" (object Lead); `processBuilder` "Notify on big deal" (legacy ⚠); `recurring` "Monthly retainer invoice" (QuickBooks).
- **Derived logic:** `formula` `Project.spend_pct` = `[Spent]/[Budget]*100`; `code` `OpportunityTrigger` (Apex, object Opportunity).
- Show a **multi-source** state: Account/Contact/Opportunity from Salesforce, Project from Quickbase, each badged.

## 10. Deliverable

Functionless React JSX skeleton(s) (one file is fine; the three views + the toggle + the states stacked or via a `view`/`state` prop) using the tokens above:
- **View A** relationship graph (SVG/CSS nodes + edges, hand-positioned),
- **View B** simpler list,
- **View C** process view (business-process flows + automation mini-flows + derived-logic list),
- the **Graph · List · Process** segmented toggle + the downstream-impact recap header,
- empty / few / many / multi-source states.

No real logic, no graph-layout engine, no data fetching — just the structure, styling, and the sample data, the way the rest of `design/` is built.
