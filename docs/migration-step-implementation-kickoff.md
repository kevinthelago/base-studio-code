# Project-planner kickoff — Data Migration step in the Default blueprint (v1.0.3)

Paste this whole brief into a base-studio-code **project-planner session** (this is a *self-build* — we're planning this feature into base-studio-code itself). It encodes decisions already made, so **do not re-discover them** — drive straight to the GitHub structure (milestones + granular, agent-ready issues) and the agent fleet. Read the two reference docs first: `docs/data-platform-spec.md` and `docs/migration-source-pane-kickoff.md` (the right-pane design brief).

---

## 1. What we're building

A **data migration step inside the DEFAULT (greenfield) blueprint** of base-studio-code's project planner. When a customer is building a new system to replace an existing one (e.g. a **Salesforce CRM** with custom fields + records), this step connects **read-only** to that system, **infers a canonical Data Model from the real records and custom fields**, lets the user **review/refine** it, and uses that model to **dictate the structure of the generated application**. The actual record load runs later as a build-time fleet stream.

The standalone `data-migration` / `data-collection` blueprints stay as-is (for raw-data project types). This work is specifically about **migration-into-a-greenfield-project**, surfaced as an optional stage in the Default blueprint.

## 2. Repo & stack

- Single repo: **base-studio-code** (this one). Tauri v2 (Rust) + React 18 / TypeScript / Zustand / Vite.
- Rust data substrate: **`crates/data`** (DuckDB). Frontend planner lives in `src/screens/projects/`.
- Tests are mandatory **in the same branch** (Vitest + RTL for frontend, `#[cfg(test)]` for Rust) — see `CLAUDE.md`.

## 3. Locked architecture decisions (do NOT relitigate)

1. **Data dictates structure — "handle data first."** The source-inferred Data Model is the *starting* schema the new app is designed over.
2. **The step splits into two touches** (opposite timing constraints):
   - **`source` stage — early, BEFORE `features`/`structure`:** connect read-only → inventory objects + custom fields → sample records → **infer a canonical Data Model** → **user reviews/refines it** (rename, retype, set identity, drop cruft). Output = the project's persisted canonical Data Model artifact.
   - **`load` — late, a build-time fleet stream:** map → clean → load records into the new system, quality-gated, with **per-field lineage**.
3. **Read-only from the source, always** (#782) — never writes back into a system of record.
4. **Optional & skippable** — greenfield-from-nothing projects skip it (reuse the #921 skippable-optional-stage mechanism).
5. **Human refinement pass is required** — the inferred model is a starting point, surfaced for edit before the app is built over it.
6. **Load target = the DuckDB canonical Data Model** as a lineage-tracked staging layer; the generated app seeds from it. Load is **idempotent / re-runnable until cutover**.
7. **Connectors:** curated first-party for the top CRMs (Salesforce first) + agent-generated **MCP** connectors for the long tail (#784).
8. **Design with stages + gate signals, NOT pipelines** — the blueprint-stage "pipeline" abstraction was removed (#897). Gates are `gateRule` over `PlanSignals` (`stageGate.ts`), stages live in `PLAN_STAGES` (`planStages.ts`).
9. **The user must see everything in the right pane** — inferred model with full provenance/"why" per field; nothing magical. (See `docs/migration-source-pane-kickoff.md`.)

## 4. Reuse vs build — the survey map (critical: don't rebuild the foundation)

**ALREADY REAL & TESTED — reuse, do not reimplement:**
- `crates/data`: `schema.rs` (`DataModel`/`Entity`/`Field`/`FieldType` + validation), `store.rs` (`DataStore`, `load_csv`, `load_reconciled`, null/lineage signals), `reconcile.rs` (merge by `Entity.identity`, source-precedence, **per-field lineage**), `ddl.rs` (table + `_lineage` + `_field_lineage` DDL, type coercion), `connector.rs` (`Connector` trait + `CsvConnector`).
- Tauri commands: `src-tauri/src/data.rs` — `pick_csv_file`, `data_preview_csv`, `data_load_csv`, `data_reconcile_csvs` (tested).
- Frontend Data Model primitive: `src/screens/projects/dataModel.ts` + `DataModelsPage.tsx` (full CRUD editor, validation mirroring Rust).
- Both data blueprints already exist as section shells in `blueprints.ts` (`dataSource`/`dataModel`/`dataMap`/`dataClean`/`dataLoad` SECTION_DEFS).

**NET-NEW BUILD (where the work actually is):**
- **`infer-schema`** — derive a `DataModel` from sampled source objects + custom fields (picklist→`enum`, lookup/master-detail→`ref`, % populated→required/identity). *Entirely missing — this is the heart of the feature.*
- **Read-only source connectors beyond CSV** — Salesforce first (agent-generated MCP per #784); the `Connector` trait already defines the `objects()`/`read()` surface to implement.
- **Planner integration plumbing** — data stages are **not** in `PLAN_STAGES`, so `resolveEnabledStages()` silently drops them today. Add the `source` (+ build-time `load`) stage ids + new **gate signals** (`sourceReachable`, `modelInferred`, `schemaRefined`, `mappingComplete`, `loadVerified`) in `planStages.ts` / `stageGate.ts`.
- **Persist the derived Data Model into the project** — Data Models are currently in-memory/localStorage only; the `source` stage must write the canonical model as a plan artifact that `features`/`structure` read.
- **Wire `crates/data` into the main Tauri build** — it's a dependency but gated; enable it behind a feature flag now that there's a UI consumer.
- **The `source` stage body in the focused planner pane** — a new `FocusedSourceBody` in `ProjectPane.tsx` (switch in `FocusedPhaseBody`), per the design kickoff; plus a planner tag (à la `<deploy_config>`) in `Planning.tsx` for the planner to emit the inferred/refined model.
- **The build-time `load` stream** — wire a migration stream into `fleetStartProject` / `ensure_worktree`; expose the existing reconcile/precedence backend in the UI (currently has no UI).

## 5. Insert point in the Default blueprint

`blueprints.ts` Default (~line 716): `context → repos → deploy → features → ui? → structure → permissions → mcp? → automations? → skills?`. Insert the new **`source`** stage **after `repos`/before `features`** so its inferred model flows into `features`/`structure`. (The `load` work attaches to the build/permissions/fleet phase, not as a user-facing planning stage.)

## 6. Plan to produce

Drive the planner workflow to its outputs: the **feature workshop → granular issues (`issues.json`) → phases (`phases.json`) → fleet (`fleet.json`)**. Suggested non-overlapping streams to shape the issues around (the planner should refine these):
1. **Planner plumbing** — `source` (+`load`) stage ids in `PLAN_STAGES`, new gate signals + `gateRule`s, `resolveEnabledStages` wiring, the `source` insert in the Default blueprint. *(Unblocks everything; do first.)*
2. **`infer-schema`** — the inference routine (Rust in `crates/data` and/or planner-emitted via a new tag) + tests against realistic Salesforce-shaped samples.
3. **Read-only Salesforce connector** (MCP, #784) implementing the `Connector` surface; CSV-export path as the proven fallback.
4. **Source pane body** — `FocusedSourceBody` + the `Planning.tsx` tag scan + Data Model persistence into the plan, matching `docs/migration-source-pane-kickoff.md`.
5. **Build-time `load` stream** — fleet wiring + multi-source reconcile UI over the existing backend.

## 7. Constraints & definition of done

- Every stream's issues carry acceptance criteria, owned globs, deps, labels, milestone (per the planner's normal `PlanIssue` contract).
- Tests in the same branch for every change; `npm run lint` (0 errors), `npm run typecheck`, `npx vitest run`, and `cargo test` all green before any push.
- Branch/PR workflow per `CLAUDE.md`: `{issue}-{desc}` → PR to `develop` → `develop`→`main`; never push to `main` directly.
- Read-only is non-negotiable; lineage + a quality gate are required on load.
- **Done = a greenfield project can optionally connect read-only to a Salesforce-shaped source, see the inventory + inferred model with provenance, refine it, have `features`/`structure` build over it, and have a build-time stream load the records into the canonical Data Model with lineage — all visible in the planner's right pane.**
