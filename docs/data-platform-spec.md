# Data Platform — Spec

Status: **draft / for review** · Owner: Kevin · Created 2026-06-13

The strategic bet: data is the product. base-studio-code already orchestrates agent
fleets to *build software*; this spec repoints the same machinery to *acquire, clean,
and structure data* — so a user can build any enterprise app **and** integrate with /
migrate from any existing system. Integration is the wedge (interop first, displacement
later); the build side is the endgame. Both run over one shared substrate: a canonical
**Data Model**.

This is a design doc, not an implementation. It defines the new objects, where they slot
into the existing code, and a phased issue breakdown.

---

## 1. The three new objects

| Object | Kind | Lives next to | What it is |
|---|---|---|---|
| **Data Model** | data artifact | Knowledge Block | The canonical, versioned schema that everything maps *into* and the build side generates *over*. The single source of truth. |
| **`data-migration-blueprint`** | process template (blueprint) | existing blueprints | Move data from a system the user controls (SAP, Salesforce, a DB, exports) into a Data Model. |
| **`data-collection-blueprint`** | process template (blueprint) | existing blueprints | Acquire net-new external data — **web scrape** or **dataset fetch** (mode) — into a Data Model. |

Relationship: **a blueprint *targets* a Data Model.** The migration and collection
blueprints differ only in their *front half* (acquisition); their *back half*
(clean → entity-resolve → verify+lineage → load) is shared.

---

## 2. New blueprint category: `data`

The existing categories (`greenfield | transform | harden | maintain`,
`blueprints.ts:356`) are all *software-lifecycle* intents. Data work is acquisition, not
code work, so it gets its own category rather than being muddled into `transform`.

```ts
// blueprints.ts
export type BlueprintCategory = "greenfield" | "transform" | "harden" | "maintain" | "data";
export const BLUEPRINT_CATEGORIES = [...]; // append "data"
export const CATEGORY_META = {
  ...,
  data: { label: "Data", h: 280 }, // pick an unused hue
};
```

The Library already groups/filters/searches by category (`filterBlueprints`), so the new
category surfaces with no UI work beyond the metadata entry.

---

## 3. The Data Model (the substrate)

A first-class, versioned artifact — **sibling to the Knowledge Block, not a blueprint**.
A blueprint references a Data Model by id; the runtime resolves it.

### 3.1 Shape (proposed)

```ts
interface DataModel {
  id: string;
  name: string;            // "CRM Core", "Inventory"
  version: number;         // bumped on any schema change
  entities: Entity[];
  updatedAt: string;
}
interface Entity {
  key: string;             // "account", "contact", "opportunity"
  label: string;
  fields: Field[];
  // Cross-source reconciliation: how two records for the same real-world thing are matched.
  identity: string[];      // field keys that form the natural/merge key
}
interface Field {
  key: string;
  label: string;
  type: "string" | "number" | "bool" | "date" | "money" | "ref" | "enum";
  required?: boolean;
  ref?: string;            // for type "ref": target entity key (relationships)
  enumValues?: string[];
  validate?: string;       // declarative rule id (format/range) — the quality gate reads these
}
```

### 3.2 Responsibilities

- **Target for mapping** — every source field maps to a Data Model field (or is dropped, recorded).
- **Validation source** — `Field.validate` rules feed the quality gate (§6).
- **Identity for reconciliation** — `Entity.identity` is the merge key the director uses (§5).
- **Schema for the build side (later)** — the metadata-driven app generator reads this to emit forms/views/workflows. Out of scope for the data phase but designed for.

### 3.3 Storage

SQLite (`crates/kb`, `crates/orch`) holds app/plan state fine, but loaded *data* will
exceed it. Bridge: **DuckDB** — embeddable, columnar, fits the desktop-authoritative
model — as the per-project data store; a cloud warehouse story comes later. New crate:
`crates/data` (Data Model registry + loaded-data store + lineage table).

---

## 4. The two blueprints

Both are built-ins in category `data`. Each is an ordered set of `SECTION_DEFS` with
`substeps` the conductor injects one at a time, `gateRule`s, and `pipelines`. **Plan/data
only — never publishing.**

### 4.1 `data-migration-blueprint` (mode: `operate`)

Source = a system the user has access to; it already has a schema, so the work is mapping.
**Migration is strictly READ-ONLY from the source (decided #782)** — base-studio-code reads,
maps, and loads into the Data Model; it never writes back into a system of record. There is
no write-back stage.

| Stage | Substeps (conductor-injected) | Gate |
|---|---|---|
| **Source** | connect (read-only), inventory objects, sample rows | a reachable source + object list |
| **Data Model** | choose / create the target **Data Model** | a Data Model is bound |
| **Map** | per source object → Data Model entity: field-by-field mapping (loop) | every in-scope field mapped or explicitly dropped |
| **Clean** | type-coerce, standardize, validate | quality gate (§6) passes |
| **Reconcile + load** | director merges into the Data Model, records lineage | load verified; lineage complete |

### 4.2 `data-collection-blueprint` (mode: `create`, `sourceMode: scrape | fetch`)

Source = external, usually schema-less. Same back half as migration; only acquisition differs.

| Stage | Substeps | Gate |
|---|---|---|
| **Targets** | declare sources + bind the target **Data Model** | targets + Data Model bound |
| **Source legitimacy** | ToS / robots / license check per source | **licensing gate** (§6) — blocks acquisition |
| **Acquire** | `scrape`: crawl w/ rate-limit + robots · `fetch`: download file/API | raw artifacts captured |
| **Extract** | parse HTML/CSV/JSON/Parquet → structured rows | structured rows produced |
| **Clean** | (shared) type-coerce, standardize, validate | quality gate passes |
| **Reconcile + load** | (shared) director merge + lineage | load verified; lineage complete |

`sourceMode` mirrors the existing `mode: create | operate` pattern — one blueprint, the
mode only swaps the **Acquire** stage.

---

## 5. The director's reconciliation role (the multi-source consequence)

A single project's **one Data Model** can be fed by several blueprint runs at once —
migrate from SAP *and* scrape the web *and* fetch a dataset. The fleet already runs
parallel streams, but here they **overlap**: all writing the same entities. So merge is
first-class.

- Each source runs as a **stream** (worker) producing a per-source staged load.
- The **director** (already the fleet reconciler, `sessionRoles.ts`) owns the merge into
  the canonical Data Model: matches records by `Entity.identity`, resolves conflicts by a
  **declared source-precedence rule**, and writes **lineage** (source, timestamp, license)
  for every value.
- Lineage is non-negotiable — it's how correctness is defended *and* how an audit is survived.

This extends the director's existing "owns `contracts/`, tests integrations" role with
"owns the Data Model, reconciles loads, maintains lineage."

---

## 6. Two new gate types

Both expressible as `gateRule: StageGate` (`stageGate.ts`) over new `PlanSignals`.

- **Licensing gate** (collection only) — blocks **Acquire** until each source is cleared
  for the intended use (robots/ToS/dataset license). Compliance, not nicety.
- **Quality / trust gate** (both) — blocks **load** until cleaned rows pass a confidence
  threshold against the Data Model's `Field.validate` rules. External data is dirtier, so
  collection sets a higher bar than migration.

---

## 7. New pipelines (`PIPELINE_LIB`)

Connector-/data-oriented pipelines, alongside the existing ones:

- `extract-source` (builtin) — pull schema + sample rows from a bound source.
- `infer-schema` (builtin) — propose a Data Model from sampled/scraped data.
- `map-to-model` (builtin) — field-by-field mapping suggestions for a source object.
- `resolve-entities` (builtin) — dedup/merge candidates by `Entity.identity`.
- `check-licensing` (builtin, gate) — robots/ToS/license clearance per source.
- `load-data` (builtin) — write a verified staged load into the Data Model + lineage.

**Asymmetric edge:** connectors are *agent-generated and verified* from specs (OpenAPI,
OData — SAP speaks it — JDBC, Salesforce Bulk API), not hand-built. A connector can ship
as an **MCP server** (the Extensions/MCP work, #33, already does real MCP servers + hooks).

---

## 8. Phased issue breakdown

Each row ≈ one GitHub issue/branch. Order top-down; later rows depend on earlier.

1. **Data category** — add `"data"` to `BlueprintCategory` + `CATEGORY_META` + filter; tests. *(small, no-risk first cut)*
2. **Data Model primitive** — `DataModel`/`Entity`/`Field` types, registry store, a Library/editor surface. The substrate.
3. **`crates/data`** — DuckDB-backed per-project data store + lineage table.
4. **`data-migration-blueprint`** — sections/substeps/gates as built-in; conductor-driven.
5. **`data-collection-blueprint`** — built-in w/ `sourceMode` scrape/fetch; licensing + quality gates.
6. **Connector framework** — interface + agent-generated connector (MCP) against one real source (start with CSV/SQL/Salesforce export).
7. **Director reconciliation** — multi-source merge by `Entity.identity`, precedence rule, lineage.
8. **Build side (future)** — metadata-driven app generation over a Data Model. Separate epic.

**MVP wedge** = 1 → 2 → 4 (one source) → 7, end-to-end on a single domain (CRM
`Account/Contact/Opportunity`): one source → Data Model → verified, lineage-tracked load.

---

## 9. Decisions & open questions

**Decided:**
- **Storage = DuckDB.** Confirmed for `crates/data` (#781) — embeddable, columnar, per-project.
- **Connector packaging = MCP servers.** Connectors ship as MCP servers, reusing the
  Extensions/MCP work (#33) — sandboxable and already wired. (#784)
- **Migration is read-only.** No write-back into systems of record, ever; base-studio-code
  only reads from a source, maps, and loads into the Data Model. (#782)

- **Platform behaviors are migratable, not just data (v1.0.4, #1193).** The scan captures the
  source's *behavioral layer* in addition to its data — see §10.

**Open:**
- **Data Model authoring** — hand-built, agent-inferred from samples, or seeded from a
  library of canonical domain models (CRM/ERP/finance)? Probably all three; which first?
- **Where the Data Model lives in the nav** — under Projects (planning) or its own top-level surface as the platform grows?

---

## 10. Platform behavior capture — "automations, business processes, and data are all migratable" (v1.0.4, #1193)

A data-only scan copies *rows*. To **replace** a system you must also carry its *behavior* —
the logic that made those rows mean something. So the source scan is widened from a data
inventory into a **full platform scan**: it reads **data types AND configurations AND
behaviors**, and the planner distills them into a **Platform Behavior Summary** that becomes
part of what the generated app reproduces.

**Read-only still holds (#782).** We *read* the configuration/behavior and *reproduce* it in
the new app; we never write back into the system of record. Migration is read → summarize →
regenerate, never source mutation.

### 10.1 What a full scan captures (Salesforce as the first connector)

| Layer | Captured | Salesforce surface |
|---|---|---|
| **Data** *(have)* | objects, fields, types, picklists→enum, lookups→ref, sample rows, counts | Describe + SOQL |
| **Automations** | validation rules, workflow rules + field updates, Flows / Process Builder | Tooling API (`ValidationRule`, `WorkflowRule`, `Flow`) |
| **Business processes** | approval processes (and their steps) | Tooling API (`ProcessDefinition`) |
| **Derived logic** | formula fields, Apex triggers/classes (name + body, for summarization) | Describe (`calculatedFormula`) + Tooling (`ApexClass`/`ApexTrigger`) |
| **Structure / access** *(lighter, later)* | record types, page layouts, profiles / permission sets | Tooling / Metadata API |

### 10.2 The Platform Behavior Summary (the new artifact)

The scan produces a structured **`PlatformScan`** (a sibling output to the inferred Data Model).
The planner summarizes it in the Source pane — *"this system runs N validation rules, M Flows,
K approval processes"* — and turns each behavior into a **migratable artifact** the generated
app implements:

- **validation rule** → an app-level validation / `Field.validate` rule on the Data Model,
- **workflow rule / Flow** → a generated automation (a rule or scheduled job),
- **approval process** → a generated approval workflow,
- **formula field / Apex** → app logic (a computed field or a service function), summarized for
  the worker to re-implement against the new stack.

Nothing is auto-ported blind: every captured behavior is **surfaced with provenance** in the
right pane (which source it came from, its source formula/definition) and the user confirms what
carries over — same "see everything" posture as the inferred schema (§4 of the source-pane brief).

### 10.3 Where it slots in

- **Connector trait (`crates/data/src/connector.rs`):** gains a behavior surface alongside the
  existing data surface; CSV exposes only data, Salesforce (`salesforce.rs`) implements the full
  scan. Connectors that can't see behavior simply return an empty `PlatformScan`.
- **`source` stage:** the behavior summary renders under the inferred model in `FocusedSourceBody`;
  its gate signals extend `modelInferred`/`schemaRefined` with the behavior review.
- **Publish / fleet:** captured behaviors become **load + logic issues** for the build-time
  streams (data load *plus* the automations/processes/logic to regenerate), each with the source
  definition attached for the worker.
