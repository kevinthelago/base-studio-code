# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Versioning:** `1.0.0` was the first official, general-availability release. The `1.0.x`
> line is bumped conservatively — patch for fixes, minor for feature releases. The full
> release history lives in [GitHub Releases](https://github.com/kevinthelago/base-studio-code/releases).

## [Unreleased]

### Changed
- **One name-derived project key — the identity collapse (#2409, supersedes #1741)** — a project's key is now **`projectSlug(name)`, frozen at creation**: the ONE value that names the on-disk hub (`projects/<key>/`), its `plan.db`, `worktrees/<key>/…`, the session skill group, the pane ids, every app-state map key, and (1:1) the GitHub project. **Recovery is derivation, not lookup** — reopening a board project derives its hub from the title, so the alias-divergence class of bug (#347/#380/#457/#791/#874/#997/#1279/#1390/#1579, the "video game" wrong-hub recovery) cannot recur. **Deleted:** `mintProjectId` (the opaque `p-…` id), the `projectKeyAlias` map + `setProjectKeyAlias` + `resolveProjectKey`, `canonicalProjectKey`'s node-id branch (and the helper), `isKnownPublishedKey`, the `ProjectsList` alias-backfill effect, the publish-time alias write, and the board-open alias reads. **Edge cases are modals, not machinery:** creating a name whose slug already exists opens a **collision modal** (open the existing project / pick a different name — now also checking local hubs); a board project whose slug has no local hub opens the **reopen-mismatch modal** — *Link to an existing local project* performs a one-time real move onto the name key (new `relink_project_hub` command: hub + worktrees + `git worktree repair`, plus the new `rekeyProjectData` store action), or *Start fresh*. Renames stay **display-only** (the folder keeps its birth-slug). Legacy-keyed hubs are grandfathered untouched on disk; reopening one from the board offers the one-time link (its legacy hub pre-selected).

### Added
- **`bsc plan` set-time validation — malformed configs fail LOUDLY, not silently at the gate (#2395, follow-up to #2392)** — every `bsc plan` command that takes a structured JSON blob used to store it opaquely, so a malformed shape (the #2392 case: a `mode:"local"` deploy service with a stray `workload` and no `localKind`) surfaced only later as a permanently-stuck gate with no visible cause. A new `plandb::validate` module now checks each shape **before persisting** — a rejected write exits non-zero with a field-level stderr message (the field, the problem, the expected values) and **leaves the previously-stored blob untouched**. The rules mirror what the frontend gates/readers actually consume (so validation and consumption can't drift), and the deploy enums come from the same embedded `@data/deploy/taxonomy.json` the frontend loads. Validated: `deploy set` (mode-aware target rules: cloud ⇒ known `platform`; local ⇒ `localKind` + its application/library fields), `fleet set`/`stream set`/`meta set`/`session set` (a `streams` array required — an absent one silently wiped the fleet; unique non-empty `id`+`repo` per stream), `deps set` (name + npm/cargo ecosystem per dependency; registries need a url), `blueprint set` (id+name; well-formed stages), `add` (ref/title + a known status), and `feature add` (whole-batch validation, no half-written batches). Successful writes echo a **readiness one-liner** mirroring the pane (e.g. `deploy set (2 services) — 1 of 2 deploy-ready (app: missing release strategy)`); `--force`/`--no-validate` is the documented escape hatch for deliberately storing a work-in-progress blob.

## [1.0.5] — 2026-07-06

### Added
- **`documentor` session role — reconcile prose docs after refactors (#1555, extends the role gate #219)** — a least-privilege post-refactor lifecycle actor that reads a landed change and reconciles the project's PROSE documentation (the CLAUDE.md structure tree, architecture docs, README/CHANGELOG) that silently drifts when a refactor moves things. It is the first role that writes files yet must never write feature code: `git: read` / `github: read` / `code: "none"` with a **DOC_GLOBS write carve-out** (markdown + `docs/**`), reusing the director's scoped-write pattern (#851) — the one wiring change is generalizing `hasScopedWriteCarveOut` to honor it, so `roleWriteRules` / `scopeWriteGlobs` / `bscAgentPerms` / the `bsc-scope` PreToolUse hook all propagate the doc-scoped allows and hard-block every code path for free. Git posture is flow-governed like a worker (read by default; push/PR lifted by its flow, #304). The packaged **Documentor persona** now runs on this role instead of borrowing `reviewer`'s read-only floor.
- **Glance — the workspace project-network map (#2206, epic #2205)** — a new Rail workspace: every project a **node**, dependencies as **edges** (api contract / data read / event stream, hard-or-soft), with cross-project **dependency cycles** detected and surfaced as **coordination hazards** (red animated edges + a hazards panel + release-ordering warnings). Transform-based pan/zoom (drag to pan · wheel to zoom-about-cursor · fit), hover/select **focus dimming**, a searchable project sidebar, and a two-mode inspector — **project** (status · role · depends-on / depended-on-by · drill-to-agents affordance) and **contract** (consumer→provider · strength · surface · description). Nodes are the user's real projects; the topology (roles/edges/status) is clearly-marked **sample** until a real cross-project dependency model lands. First slice of the recursive **project → agent network → console** graph that will replace the console tabbedscreen; the transform viewport, layered layout, and cycle detection are pure + unit-tested and become the shared graph core the Org designer retrofits onto (later slice).
- **Org designer — interactive canvas + persona configuration (#2199)** — the Org page (#2193) becomes fully interactive and the place to configure the agents in it. **Canvas:** drag the background to **pan**, **wheel to zoom** toward the cursor, and **drag a node to reposition** it (a movement threshold separates drag from click; connect-mode suppresses drag) — all in a new `usePanZoom` hook over pure geometry. **Auto-organize:** a toolbar button runs a deterministic hierarchical **`autoLayout`** (layer by longest path from the roots, barycenter crossing reduction) to lay the graph out cleanly, then hand-tune from there. **Persistence:** node positions commit to the org on drop (already write-through + persisted) and per-org canvas **zoom** is remembered. **Configure personas here:** the persona editor was extracted from `PersonasPanel` into a shared **`PersonaEditor`** (name · role+tiers · an editable **responsibilities** list · start prompt · model · skills) and embedded in the position inspector — editing the *shared* identity, with a **"shared · used in N"** note and a **persona picker** to switch which identity a position embodies; the rail's "＋ new" adds a position. Pure geometry + `autoLayout` are unit-tested; pan/zoom/drag feel is tuned in-app.

### Added
- **Org relationships — the persona-relationship graph (#2193)** — the substrate for modelling personas as job **positions** wired by **relationships**, so a fleet's interaction topology + coordination prose become composable DATA (continuing #2185 / #2027) instead of prose hardcoded in `fleet/*-protocol.md`. A **relationship** is a directed edge with an **archetype** (Manages / Serves / Oversees / Consults / Peers / Stewards); each archetype expands into **communication forms** — the closed typed vocabulary (Directive / Escalation / Decision / Report / Request / Consult / Review / Handoff), each carrying a delivery semantic (inject / park / resume / fire-and-forget / queue / artifact / transfer), whether it bears authority, whether it blocks the caller, and its `bsc-*` transport. An **org** composes positions (agent · external actor · resource) + relationships, like a blueprint composes stages. Made a **first-class `bsc` store**: `crates/bsc-org` (file-CRUD over `~/.base-studio-code/orgs/`) + the `bsc org` CLI (`list --full`/`get`/`set`/`remove`, a thin shim over `bsc-json-store`), registered in the `bsc` dispatch + top-help + SIDECARS, with a frontend **write-through** bridge (`hydrateOrgs` on boot + push-through on every mutation) — so live sessions, the planner, and the desktop Org tab share ONE library. The vocabulary + the built-in **Default fleet** org are externalized to `src-tauri/data/org/*` (config-dir overlay + in the export/import bundle). Personas gained a **`responsibilities`** facet (the position's charter, orthogonal to skills + role).
- **Org designer canvas (#2193)** — the visual Org page on the Planner workspace, ported from a Claude Design prototype onto the shared UI kit + tokens: a **toolbar** (org switch · a relationship palette for click-to-connect · zoom/fit), a **left rail** of positions grouped by department, a **graph canvas** (curved SVG edges styled per archetype, person/resource/external node cards with capability-tier pills, a legend, fit-to-viewport zoom), and a two-mode **inspector** — a **position** (role·clearance · responsibilities · skills · the auto-derived communication surface) or a **relationship** (its archetype, changeable, + the communication forms flowing each direction). Pure geometry (`orgLayout.ts`) + view models (`orgView.ts`) are unit-tested; the reusable pieces (`TierChips`/`FormChip`/`FormLane`) are extracted onto the shared kit.

### Changed
- **Frontend review consolidation wave (#2416–#2421, PRs #2422–#2427)** — a six-issue dedup/refactor pass from a full frontend review. **AI config out of TS (#2416):** the project-kickoff + triage prompts, autopilot sim-user prompt, and persona-stream kickoff prose moved to `@data` seeds (`console/kickoff-prompts.json`, `planner/autopilot-sim.json`, `fleet/persona-kickoff.json`), with one model-default source (`console/model-defaults.json`) replacing four scattered literals; TS keeps only `{{NAME}}` interpolation via a shared `fillTemplate`. **Data externalization (#2419):** MCP catalog templates, the glance sample graph, integration destinations, the demo-snapshot fixture world (7 seeds + thin typed assembler), purpose tags/hues, `DEPT_ORDER`, and the esm.sh preview import-map → `src-tauri/data/*.json`. **UI kit (#2417/#2420):** new `TextArea`, `ModalCard`, and `RoleTierChips` primitives (+ `SectionLabel` `right` slot, `--on-accent`/`--on-success` tokens); all 8 hand-rolled textareas, ~40 field stacks, 4 modal shells, and the new-feature dot/label/empty-state/toggle/glyph holdouts swept onto shared primitives; `.ulabel`/`.empty-state`/`.pcp-switch` CSS retired. **Graph unification (#2418):** Design Studio's graph view onto `GraphCanvas` + `ZoomControls` + shared edge routing, glance onto the shared infinite grid, one shared drill animation, and a shared `orderLayers` barycenter primitive (org also moved onto `layerDag` with layer-parity tests). **Helper dedup + kit gaps (#2421):** one shared home each for `clamp`/`truncate`/`slugify`/`fmtClock`/`dayKey`/`hashString`, and `LabelChip`/`ActivityFeed`/`Pane`/telemetry charts registered in the UI-kit manifest. typecheck clean, lint 0 errors, tests in-branch throughout.
- **Externalized the built-in personas + wired the fleet protocol prose (#2185)** — the persona library was the last packaged config surface still hardcoded in frontend TS (`features/personas/lib/persona.ts`), out of step with the #2027/#2047 config-externalization every other surface (blueprints/skills/roles/stages/taxonomies) already follows. Moved the nine built-ins to one JSON file per persona under `src-tauri/data/personas/`, loaded via `import.meta.glob("@data/personas/*.json")` + `overlayGlob` — so the packaged set is now editable without a rebuild (config-dir overlay) and rides the export/import config bundle. The **worker/director** personas (previously empty placeholder prompts) now resolve their real protocol prose from the shared `@data/fleet/{worker,director}-protocol.md` (imported `?raw`, config-dir-overlaid via a new `overlayRaw`), a single source of truth shared with the fleet's `CLAUDE.local.md` — no duplication. `reconcilePersonas` gained an empty→base start-prompt fallback so an install seeded by an older app picks up the newly-wired prose, and boot hydrate converges the store on that drift.
- **Easier persona config (#2185)** — the Personas panel's "Default model" field became a pick-from-list select backed by `@data/console/models.json` (session-default + the known tiers), preserving any custom model id the persona already carries instead of asking the user to type an exact model string.

## [1.0.43] — 2026-07-02

### Changed
- **Backend refactor & consolidation sweep (#2155–#2172)** — a no-user-facing-behavior pass over the Rust backend from a review. **Shared helpers extracted:** `SessionSettingsSpec` + `SetupWorkspacesArgs` params structs replacing two 12-arg signatures (#2155); `gh_status_error` folding three duplicated GitHub non-2xx error blocks (#2156); a single `claude_project_transcripts_dir` (#2157); a `reap_with` combinator behind the three ledger reapers (#2168); `data::cli` + `skilldb` adopting the shared `read_stdin_json_one`/`print_json` (#2169/#2170); a `testutil::unique_dir` for the copied fleet test helper (#2171). **Decompositions:** `setup_workspaces_inner` into per-file builders + `render_repo_items` (#2166); `skilldb::cli::run`'s 210-line match into a thin dispatcher (#2169); `pty_create` into `resolve_session_cwd` + `build_session_init_line` (#2167); `replay_state`'s repeated snapshot into a `snap` helper (#2172). **New crate:** `bsc-json-store` — the one verbatim-JSON-per-id store + CLI scaffold behind `bsc-blueprint`/`bsc-persona` (was ~250 duplicated lines; both are now thin `CliSpec` shims, #2158). Also fixed a stale advertised-subcommand test (`persona` missing) that was reddening Rust CI on every PR. Every change is clippy-clean (`--all-targets -D warnings`) with tests in-branch.
- **UI-kit adoption sweep — tail cleanup (#2159/#2160/#2161)** — the next consistency pass over the remaining raw-HTML holdouts (the kit was already ~900 imports deep across 200 files, so this is tail cleanup, not greenfield). **#2159:** extracted a shared `SettingsPageHeader`/`SettingsSubHeader` — killing the byte-identical `<h2 className="mono">` + muted `<p>` header hand-rolled across all 6 Settings pages plus the two duplicated local `Sub` helpers — then swept styled `<h2/h3/h4/p>` onto `<Text>` and read-only mono `<pre>` blocks onto `<Code>` across settings/planner/github/tunnel/skills/mcp/automations (~37 files, lossless). **#2160:** folded the two genuinely-lossless color-mix pills (`connectorForm` ReadOnlyPill, `RelationshipInspector` Pill) onto `<Chip>`; left 6 tuned variants (radius-4/weight-600, `oklab` interpolation, dashed/transparent borders, `.role` line-height, solid fills) local, each with a documented reason. **#2161:** adopted the data + feedback primitives — `EmptyState`, `StatTile`, `FillBar`, `Card`, `StatusDot`, `Banner`/`InlineError`, and the `Button danger` prop — for their hand-rolled equivalents across planner/github/skills/settings/agents/automations (~38 files), taking each primitive's canonical look. Deliberately left: `InjectionGateBanner` (a structured 3-section panel `Banner` can't model), the planner agent `Avatar` (semantically distinct from the kit's GitHub-login `Avatar`), and every `eslint-disable`d bespoke input/button. typecheck clean, lint 0 errors throughout.

## [1.0.42] — 2026-07-02

### Added
- **Personas — the agent-identity abstraction (#2094)** — split the CRUD-able *behavioral* identity of an agent (start prompt · attached skills · default model) from its **role** (the permission floor). A **Persona** references a role, so many personas share one role (Reviewer/Juror/Documentor all sit on a read-only floor with different prompts). Surfaced on the **Planner** workspace (renamed from "Projects"; its first tab is now "Projects") as a **Personas tab** with full CRUD (name · role · start prompt · skills · model, with the referenced role's live capability tiers shown). Made a **first-class `bsc` store** like skills/blueprints — `crates/bsc-persona` (file-CRUD over `~/.base-studio-code/personas/`) + the `bsc persona` CLI (`list --full`/`get`/`set`/`remove`), with a frontend **write-through** bridge (`hydratePersonas` on boot + push-through on every mutation), so live sessions and the planner share ONE library and the planner can mint a persona the way it mints a skill. **Adopted at launch**: the console pane menu gains a persona picker (stamps role/model/start-prompt onto a pane), and a **fleet stream can launch AS a persona** — resolving its role (overriding the default worker), prompt, skills, and model at launch, so a fleet can mix a documentor/reviewer stream with plain workers (read-only personas get no write carve-out from their owns).
- **Agent-role + hook visibility (#2094)** — the Security page gains an **Agent roles** card: the live role→capability roster (git/github/code/net access tiers · write-scope · default profile · expandable denied-commands), derived from `ROLE_DEFAULTS` so it can't drift from the actual gate. The **Hooks tab** gains a `Stop` ("Session end") hook and now surfaces the always-on `bsc-*` PreToolUse security floor (`bsc-deny`/`bsc-confine`/`bsc-scope`) as read-only "system · always on" entries — so the view reflects the hooks that actually run.
- **`InlineError` primitive (#2138)** — the shared "mono danger callout" (danger-toned text on a translucent wash + hairline border); replaced ~6 hand-rolled copies across the delete-project modal / published-projects list / board query banner. Registered in the UI-kit manifest.

### Changed
- **Large-file decomposition rounds 2–4 (#2128/#2148/#2151)** — continued the standing decomposition pass, behavior-preserving (verbatim moves; barrels/public exports unchanged so no importer churn). Round 2 (components): `console/index.tsx` (486→303, `PaneAt` + placeholder states), `ClaudeConfigCard` (416→211, 6 modules), `BlueprintImportModal`, `ProjectBoard` (382→120), `BlueprintLibrary`, `WorkerDetail`. Round 3 (pure libs → barrels): `coordination.ts` (912→28), `blueprints.ts` (605→19), `dependencies.ts` (480→65). Round 4: `skills.ts` (416→22), `sessionRoles.ts` (377→48, verbatim-verified byte-for-byte on every deny/glob/command string), `projectPaneData.ts` (380→73).
- **Kit-consistency sweep (round-3 scan, #2135/#2136/#2137)** — adopted existing shared abstractions where code hand-rolled them: 12 summary cards now pass `Card`'s `title`/`hint`/`right` props (added a backward-compatible `headMb`); 5 hand-rolled `setInterval` polls converted to `usePoll`; `FlowTab` reads via the shared `readCoordState` instead of re-implementing the coord-log read.
- **UI-kit adoption sweep — planner (#2078)** — the follow-up sweep over `features/planner/**` (deferred from #2059 as the largest/riskiest surface): ~577 conversions across 48 files in `bodies`, `list`, `blueprints`, `preview`, `github`, `relationship`, `fleet`, `pane`, and `session` — Row ×221 · Stack ×117 · Text ×98 · Spacer ×49 · Card ×33 · Grid ×31 · Button ×28. Lossless throughout (also removed the local `col()`/`rowS()` flex-style helpers in `BlueprintAuthorViews`). Deliberately conservative on the big/critical files — `Planning.tsx` (6 isolated nodes) and `ProjectPane.tsx` (2) leave the measured split-panel, PTY/terminal refs, and conditional-display nodes untouched — and it skipped `ref`-carrying elements (primitives aren't `forwardRef`), local-`Card` collision files (deploy views), the SVG relationship graph, and `<span>`-based flex/spacers.
- **UI-kit adoption sweep (#2059)** — migrated ~309 hand-rolled `<div style>` / raw-class sites onto the shared primitives across 69 files in `github`, `agents`, `automations`, `settings`, `skills`, `mcp`, `tunnel`, and the `app` shell: Row ×134 · Stack ×54 · Button ×52 · Grid ×33 · Card ×15 · Spacer ×15 · Text ×6. Every conversion is lossless (exact spacing/colors preserved via prop passthrough + last-wins `style`); ambiguous cases were deliberately left — `<span>`-based flex (Row/Stack render a `<div>`), `display: cond ? "flex" : "none"` toggles, CSS-class-driven layout, and the crash-safety net + console pane system (refs/measured layout). `features/planner/**` is a deliberate follow-up.

### Added
- **`Box` primitive (#2079)** — the generic styled-container catch-all so features never write a raw `<div>`: polymorphic (`as`) with token-backed shorthands (`pad`/`bg`/`border`/`radius`/`shadow`) and full `className`/`style`/DOM passthrough (`style` wins last). Stack/Row/Grid stay for flex/grid, Text for text, Card for framed panels; Box is everything else. Added to the kit manifest + registry (#2060).
- **Design tokens: elevation, stroke, control heights (#2080)** — filled the remaining token holes so inline magic numbers have a rung to reach for (and Box's shorthands have tokens to map to): `--shadow-sm/md/lg/xl` (elevation), `--stroke`/`--stroke-soft` (the ubiquitous `1px solid var(--border[-soft])`), and `--ctl-xs/sm/md/lg` (control heights).
- **UI kit manifest (#2060)** — an introspectable registry of the shared UI kit, the foundation for the v1.0.5 buildable UI (agent-driven generation + the in-app visual editor). `shared/ui/manifest.ts` is pure, serialisable data (`manifestJson()`) — every composable primitive (Stack/Row/Spacer/Grid/Text, Button/IconButton/Checkbox/Toggle/SegmentedControl/TextField/SelectField, Card/Chip/StatTile/FillBar, Banner/EmptyState/StatusDot) with its group, import path, description, and a typed prop schema (name/type/enum values/default/required). `shared/ui/registry.tsx` is the runtime render-map (`name → component`) a renderer consumes; a `PrimitiveName` union types the registry as `Record<PrimitiveName, …>`, so the manifest and render-map stay in sync at **compile time**. A sync test guards integrity + that every `importPath` exports its named component.
- **Text primitive + type scale (#2057)** — the one *typographic* primitive, alongside the layout kit toward the v1.0.5 kit/SDK-like buildable UI. A type scale in `tokens.css` (`--fs-xxs`…`--fs-xl`, 9…18) plus `Text` under `shared/ui/typography/` with a `size`/`tone`/`mono`/`weight`/`as` prop vocabulary (`type.ts`). Named size rungs (`size="sm"`) map 1:1 to the CSS tokens; raw px stays legal (`size={10.5}`) for the off-scale half-sizes; `tone` is a semantic color enum (`dim`/`muted`/`accent`/`danger`/`success`, inherit by default) and `mono` toggles the utility class — so the ~1,100 inline `fontSize:`, ~945 inline `color:`, and 558 `className="mono"` sites convert losslessly. `CIHealthCard` converted as the adoption proof; the codebase-wide sweep is a follow-up.
- **Layout kit foundation (#2056)** — the first composable *layout* primitives, toward the v1.0.5 kit/SDK-like buildable UI. A spacing scale in `tokens.css` (`--sp-1`…`--sp-6`) plus three primitives under `shared/ui/layout/` — `Stack` (flex column), `Row` (flex row, centered by default), and `Spacer` (flexible/fixed filler) — sharing one `Space`/`Align`/`Justify` prop vocabulary (`space.ts`). Named rungs (`gap="md"`) map 1:1 to the CSS tokens, and raw px stays legal (`gap={10}`) so the ~667 hand-rolled `display:flex` divs, ~700 `gap:` usages, and ~40 `<div style={{flex:1}}/>` spacers convert losslessly. `OpenPRsCard` converted as the adoption proof; the codebase-wide sweep, `Grid`, and a kit manifest are follow-ups.
- **`Grid` layout primitive (#2058)** — the fourth layout primitive, joining `Stack`/`Row`/`Spacer` and reusing the same `space.ts` vocabulary. One primitive for the ~77 hand-rolled `<div style={{ display: "grid", … }}>` sites: `cols`/`rows` take either a number `n` (→ `repeat(n, 1fr)`, the even-split shorthand) or an explicit template string passed straight through (`"1fr auto"`, `"50px 1fr auto 50px"`); `gap` resolves a `Space` rung or raw px; `align` maps to `alignItems` (cell alignment) and `justify` to `justifyContent` (track distribution) via new shared `alignValue`/`justifyValue` helpers exported from `space.ts`; `inline` switches to `inline-grid`. Prop passthrough and a last-wins `style` override keep conversions lossless. `ReposGrid`'s `repeat(2, 1fr)` grid converted as the adoption proof.

### Removed
- **`conductor` role + pipeline/workflow engine (#2094)** — the staged build→test→review→integrate sequencer (#220) was a secondary path; the primary flow is director-dispatched parallel workers. Dropped the `conductor` role (from the gate, profiles, and `role-capabilities.json`) and deleted the engine it drove (`conductor.ts`/`workflow.ts`/`workflowDriver.ts`/`useWorkflowConductor.ts` + the `workflowRuns` store surface + the Flow tab's Workflows section), ~790 LOC. The distinct planner-conductor (step driver), render-preview stage pipelines, and the `tester`/`reviewer`/`juror` roles are unaffected.
- **Dead code (#2134)** — removed the superseded `planner/lib/planContract/` module (dir + test, ~630 LOC — its symbols were reimplemented elsewhere), the orphaned `planner/fleet/fleetLive.ts` projection, a dead `preview/index.ts` barrel, and ~11 unreferenced exports. −720 LOC net. The tunnel/CLI parity-mirror surfaces were deliberately left.

### Fixed
- **UI stage footer (#2121)** — the planner UI stage's footer is now a conditional action: it shows "route design to project" while the staged design is missing/stale (routing it syncs the app skeleton + marks the stage current) and reverts to "approve & continue" once routed; the in-pane route button was removed (routing is change-aware on triage, #2097). The **skip** control is hidden while "route design" is the primary action (offering both was contradictory).
- **Modals — Escape-to-dismiss (#2139)** — 4 hand-rolled modals (delete-project, draft-delete, new-group, the context-file viewer) now route through the shared `ModalScrim`, restoring Escape-to-dismiss they were missing.
- **Personas page height (#2094)** — the Personas page now fills the workspace height (its root `Row` was centering its columns instead of stretching).

## [1.0.41] — 2026-07-01

A consolidation **checkpoint** on the `1.0.4` line, ahead of the `1.0.5` UI release — the codebase
refactor & consolidation sweep, integrations as agent-authored connectors, a data-driven planner, and
planner/fleet hardening. (Semver note: `1.0.41` sorts *after* `1.0.5`; read it as "`1.0.4`, revision 1".)

### Changed
- **Deny-list permission model (#1916)** — sessions flip to `bypassPermissions` with a **deny-list** as the primary control plus per-session worktree filesystem confinement (`bsc-scope`): `code:none` roles hard-block every write (#1916 Step 3.5), each session runs the deny-list switch (Step 4), and the old enumerated allow-list stays available as an opt-in **posture toggle**
- **Maintenance mode (#1957)** — a worker that completes its owned issues no longer ends; it stays alive in a ready **maintenance** posture (PTY + worktree kept), and the progress-gated relaunch brings completed workers back **into** maintenance (available for the director to dispatch new/regressed lane work to) rather than skipping them
- **Unified stage vocabulary (#1958)** — one canonical token per planner stage; collapsed the base-key/fold split (`repos`→`deployment`, etc.) with grandfathering aliases for old keys
- **Blueprint set trimmed** — the packaged blueprints are now **Default**, **Complete**, and **blueprint-author**; the transform/harden/data blueprints (Refactor, Split / Combine microservices, Migrate, Harden, Data migration/collection) moved to `archive/` ahead of the agent-authored-connector direction
- **Projects on the shared TabbedScreen shell** — the Projects screen now routes its page modes (Planner / Fleet / Data Models) through `<TabbedScreen>` + `usePageTabs` like every other rail screen, instead of a hand-rolled `ProjectsPageModeStrip`. The live planning PTY still survives a mode switch (the Planner body stays CSS-mounted); tear-off + detached-section render preserved. `PROJECT_MODES` extracted to a pure `list/projectModes.ts`. With this, every tabbed rail screen is on one shell (#1876)
- **Cohesive rail-screen structure** — every rail screen's main component now lives at its feature/dir **`index.tsx`** entry, matching the planner + settings precedent. Moved `SkillsScreen`/`AutomationsScreen`/`McpScreen`/`GitHubScreen`/`AgentsScreen` up from `features/<x>/screens/<X>Screen.tsx` (folding the `index.ts` barrels in, preserving their extra re-exports) and `ConsoleScreen` → `app/console/index.tsx`. Barrel consumers (`@/features/<x>`, `@/app/console`) resolve unchanged; no behavior change (#1875)
- **Unified progression rail** — the blueprint-card gate preview (`PlanGateRow`) and the focused-pane sequenced stepper (`Stepper`) now render through one shared, presentational `ProgressionRail` (#1869). Standardized on the blueprint-card look (24px rounded-square nodes carrying the stage icon, status-colored); each caller maps its own model (blueprint sections via `stageStatus`, focused-plan `Phase`s) into rail nodes. Replaced the duplicated inline `nodeStyle` + the `.seqrail-*` CSS, and removed the long-dead `.stepper-*` block
- **Frontend dedup & shared primitives** — a code-health sweep giving copy-pasted logic one home: a `shared/lib/github/` for the GitHub display layer (avatar palette + `loginColor`/`timeAgo`/`hueFor` consolidated, the scattered `GhProject`/`GHEvent`/`GhLabel` types unified) (#1492); shared `shared/ui/` atoms (`Avatar`, `LabelChip`, and the chart `Spark`/`HBars`) (#1493); and four reusable hooks/helpers that replace hand-rolled boilerplate across the app — `usePoll` (15 polling loops migrated, #1494), `useCoordLog`/`readCoordState` (the `read_coord_log → ingestCoordLog` replay, 5 fleet hooks, #1495), `useGithubQuery` (the planner/github fetch lifecycle, 4 screens, #1496), and `safeInvoke`/`fireInvoke` for Tauri error handling (#1497)
- **Planning.tsx decomposition** — the planner session component split into focused, colocated hooks (`usePlannerTagStream`, `usePlanSectionPoll`, `usePlannerBlueprint`, `usePlanGates`, …), ~2.8k → ~2.2k LOC (#1474); a second pass extracted five more (`usePlanningTitle`, `usePlanConfirmations`, `usePlannerMessages`, `useCtxRequired`, `useSetupSignature`, #1775)
- **Shared UI primitives & a UI-consistency sweep** — consolidated scattered UI onto shared atoms in `shared/ui/`: `BackButton` (canonical left-chevron, icon + text, #1752), `IconButton` (one close glyph + hit-area, #1753), `StatusDot` (#1777), `ModalScrim` (the single centered-overlay every modal builds on, + `--scrim`/z-index tokens, #1776), promise-returning `usePromptDialog`/`useConfirmDialog` replacing native `window.prompt`/`window.confirm` (#1738), the analytics `Kpi` + `StackedDayBars` (#1740), settings `SettingsControls` (#1745), and a `Toggle` `tone` prop (#1780). `useActiveProjectGithub` + `<QueryBanner>` dedup the four GitHub board screens (#1754)
- **More large-file decomposition** — `handlePublish` extracted into a testable, React-free `publishSteps.ts` (`usePlanPublish` 688 → 358 LOC, #1749); `FocusedBodies.tsx` split into per-body files (1129 → 159 LOC, #1757)

### Fixed
- **Fleet board showed "No fleet running" during a live fleet** — `buildLiveWorkers` filtered workers through a positional `t<idx>p<idx>` pane-id parse, which can't match the #1176 identity ids (`<key>:<stream>`) that fleet/triage panes actually use, so every worker was dropped. It now resolves live workers by the open tabs' minted `paneIds`
- **Tab/section tear-off broke the new window on Windows** — #1076 added a custom `additionalBrowserArgs` (`--no-proxy-server`) to the **main window only**; on Windows WebView2 a runtime-created tear-off window then launched with *different* browser args than the main window (which share one user-data directory), so it crashed — and a Rust-built workaround that matched the args only traded the crash for a blank-white window. The fix removes that `additionalBrowserArgs` line (the `--disable-features=…` part it carried is already wry's default, so only the dev-only `--no-proxy-server` is dropped) and restores the original, known-good tear-off path: a plain `new WebviewWindow` loading the running window's absolute URL. Tear-off windows now match the main window's args and render again (#1870)
- **Console pane status & broadcast keyed off positional ids** instead of the stable `paneIdFor` id — manual and fleet/triage tab activity dots, broadcast, and clear-input now target the right PTYs (#1729)

### Added
- **Model-agnostic OS sandbox (#1988)** — an opt-in **sealed WSL2 distro** (`bsc-agent-sandbox`) that confines a session at the OS level regardless of which LLM drives it — the cage is the *environment*, not the agent runtime. A purpose-built slim rootfs (Debian + the Linux `bsc`/`bsc-agent` sidecars + a baked `/etc/wsl.conf` that disables the `/mnt/c` mount and Windows interop) is built and imported by a **provision** command (`tooling/wsl-sandbox/`); a WSL2 readiness probe + one-click install surface it in **Settings → Security**, and a **Settings → Agents** toggle launches console sessions inside the cage (`pty_create` gains an opt-in `wsl_distro` + a distro-native init line). On native Windows without WSL2 it's a safe no-op — the deny-list hooks still gate. Complements Claude Code's own Bash sandbox config (#1980), which is Claude-only; **per-agent isolation via Linux users** is queued for `1.0.5` (#1994)
- **Agent-authored connectors** — external-system integration shifts from native per-vendor code to connectors the **planner agent authors on the fly**: a `bsc data connector probe / validate / try / map` dev-loop (#1963), a **build-integration skill** auto-attached on the Source stage (#1968), the dev-loop documented in the Source-stage prompt (#1970), and self-describing **runtime OAuth** carried in the connector manifest (#1973)
- **Tests for security-critical surfaces** — unit coverage for the `sessionLaunch` env/permission builders (#1755) and a `sessionRoles` ↔ `profileGen` role-table consistency guard that fails CI on drift (#1759)

### Removed
- **Native pre-built connectors (#1976)** — the dedicated Rust connectors, `presets.rs`, native `descriptor::BUILTINS`, and `data_connector_catalog` are gone; the **manifest is the sole connector path** (`RestConnector` over an agent-authored manifest)
- **Data Models page + the data/transform blueprints** — the in-app Data Models editor and the standalone data-pipeline stage panes were removed with the blueprint archival (the canonical Data Model store + `bsc data` CLI stay); the Projects screen is now just Planner + Fleet
- **~180 lines of dead CSS** — verified-unused selectors across `projectPane`/`mcp`/`agents`/`automations`/`tokens` (the old all-sections repos pane, orphaned sub-tab strips, dead row internals)
- **Orphaned frontend modules** — `planSeamGraph`, `planEval`, and the mock `ConsoleView` (~936 LOC, no production references) (#1736); plus dead `.tag`/`.seg` CSS surfaced while auditing pills (#1793, #1794)
- **Per-stage grading** — the advisory plan-grading system (graders, `sectionGrades`, the `grading/` module) removed end to end; it gated nothing (#1459, #1473, #1468)
- **Skills Catalog tab** and the standalone allowed-commands permission scope (profiles now own command permissions) (#1466, #1457)

## [1.0.4] — 2026-06-24

The **enterprise integration & migration release** — connect read-only to an existing platform
(Salesforce first), scan its data *and* configuration *and* behavior, and turn that into a
migratable canonical model the generated app is built from.

### Added
- **Read-only platform scan** — a Salesforce platform-behavior scan (#1193) generalized onto a `Connector` trait (#1195), surfacing objects/fields and derived logic; it runs live from the Source pane against real credentials (#1194, #1197)
- **Native connector catalog** (in-process Rust, *not* MCP servers) — QuickBooks Online, monday.com, Quickbase, HubSpot, Airtable, SQL, OData, ServiceNow, NetSuite, Zoho CRM, Xero, Pipedrive, Asana, Stripe, Zendesk, Jira, Odoo, Pipefy, Linear, and a generic REST connector, plus a vendor-preset catalog for smaller systems with gap-sweep batch + nested-envelope support (#1197)
- **OAuth 2.0 + PKCE flow engine** for source connectors, wired into the live scan and the Source pane and backed by an on-device credential keychain (#1194, #1197)
- **Source pane** — a dynamic source-connection UI with scan visualizations (Graph · List · Process, #1209), entity field enrichment (`ScanObject.fields`, #1211), value-based + connector-declared field-type inference (Salesforce picklist→enum / lookup→ref; Quickbase/HubSpot/Airtable types) (#1219, #1230), and the full connector catalog surfaced in-pane (#1288)
- **Data-dictates-structure loop** — a platform scan seeds the canonical Data Model that shapes the generated app (#1205); an **Integration blueprint** for data-extraction apps (#1207); planner-authored native integrations via `bsc-plan integration`, with missing integrations surfaced and addable in-session (#1235, #1200)
- **Research MCP** — a native Research MCP crate exposed as a built-in server with source clients + automatic `.mcp.json` registration (#1196); the planner grounds skills/techniques in it (#1056)
- **Session discovery & recovery** — `parsePaneIdentity` recovers meaning from a pane id, `discover_sessions` scans the ledger + project hubs, and recovery reconciles discovered sessions against open tabs; fleet/triage panes mint stable identity ids at launch and crash recovery keys off them (#1266, #1176)
- **Plan-injection provenance gate** at the confirm boundary, with planner injection framing + a shared injection detector and net-gateable WebFetch under planner-privilege guards (#1107)
- **Live planning over the tunnel** — project the planning session's state/events/status to a paired phone and drive it remotely; arm/run automations and wake/approve from the phone (#934, #935, #937, #985, #986, #987)
- User **gate override** with a Settings toggle to advance a plan stage past its gate (#1285)
- Launch-time planner introduction kickoff (#1240); per-repo public/private visibility + per-agent model selection in the planner (#1227)
- Blueprint JSON import preview before pulling from a gist, and a persistent link to a published blueprint's gist (#1037)
- Auto-end finished workers with a durable, reviewable per-worker audit (#920); a PTY orphan reaper — spawn ledger + boot reconcile (#1049); an HTTP test service for live-scan transports (#1198)

### Changed
- Switch a project to **any** other blueprint (gated by the confirmation modal); the control is renamed "switch blueprint" (#1281)
- Session-authored skills render first + highlighted in the focused planner pane (#1056)
- Each stage's prompt is shown under its row in the blueprint preview (#1268)
- Defer the `perf.db` open + `cap_logs` off the synchronous boot path (#1047)
- Roadmap refreshed — 1.0.3 Complete, 1.0.4 Current, the UI release slated for 1.0.5 (#1283); connectors documented as native in-process Rust (not MCP servers)

### Fixed
- **Warden no longer quarantines every fleet worker on launch** — `.mcp.json` is now correctly git-excluded inside worktrees (where `.git` is a file, so the old exclude write silently failed), so it never reads as an out-of-lane edit
- **Imported gist blueprints render their stage icons** — `PlanGateRow` resolves icons through the stage→icon map by key, and the first-class stages missing from that map were added (#1290)
- Blueprint gist link works on the live card; orphaned library dupes removed; import failures surfaced instead of swallowed (#1037, #1042)
- Jumbled Claude TUI mid-session is detected and auto-nudged, and a resize-nudge fires automatically after a pane renders Claude (#1250, #1221); reverted the native console-input overlay to restore Claude's own TUI input (#1239); global hotkeys scoped to the Console page (#1218)
- Draft project title edits persist on blur/Enter (#1222); renaming a published project updates the GitHub Project board title (#1226)
- CodeQL hardening — SHA-pinned actions, least-privilege workflow permissions, origin checks, complete sanitization (#1011); bumped quinn-proto for RUSTSEC-2026-0185

## [1.0.3] — 2026-06-21

The **simplicity release** — make the platform foolproof for new users.

### Added
- New **Complete** greenfield blueprint — the thorough path (source + MCP servers, automations & skills) for when you want everything; the advanced stages moved here from Default (#1003)
- **plan.db** execution substrate — a local SQLite working store (`crates/plandb` + the `bsc-plan` CLI) tracking features, issues, and execution status; GitHub stays the durable store and recovery rehydrates the DB from it
- Features are now a **dependency graph** — the plan stage sequences them into phases, and issues are generated at GitHub-publish time straight from the DB
- Blueprint **import-from-gist** modal (browse your own published blueprint gists); user blueprints persist to a dedicated directory
- Gated-icon stage progression on blueprint cards; a drag-resizable blueprints rail

### Changed
- **Default blueprint simplified** to a foolproof greenfield path: context → repos → deploy → features → UI → structure → permissions (#1003)
- Blueprints folded into the planner page — the separate Blueprints tab was removed; selecting a blueprint sets it active, "modify in planner" edits it
- UI planning stage now hands off to **Claude Design** — the user provides the exported design files instead of the planner inventing the visuals
- Deploy platform selection is now a toggle (click again to clear)

### Removed
- The **MCP server** greenfield blueprint — the MCP-servers planning stage stays available on the Complete blueprint and others

### Fixed
- Published-project delete crash (#997); deleting a project also clears its plan.db data
- Ghost `issues.md` context card — a stale issues section no longer renders as a 0.0k context file
- Opening a project no longer silently switches its blueprint to the globally-selected one (#988)
- CI: repointed the Plan-contract job to the reorg's moved test paths, and removed an unused import that broke `develop`'s typecheck

## [1.0.2] — 2026-06-18

### Added
- **Deploy** planning stage + pane, right after Repos — define how each service ships (target/hosting per service, environment ladder, CI/CD pipeline, config + secrets, release & rollback, health); the planner emits it as a `<deploy_config>` tag and it publishes as deployment issues owned by a `deploy` stream (#919)
- Blueprint-authoring lifecycle — design a reusable blueprint in the planner and publish it to a gist; no fleet/triage (#923)
- Data blueprints — **Data migration** and **Data collection** (web scraping / dataset fetch) into a canonical Data Model
- Enterprise production-readiness dimensions baked into the planner (observability/SLOs, reliability + DR, data governance, release strategy, supply-chain integrity, …); accessibility + regulatory compliance routed to the Compliance MCP server

### Changed
- Projects tab redesigned into **Drafts / Projects / Blueprints** sections with search + recency/name sort; clicking a blueprint opens the planner
- Published projects are flagged in place with a `.published` marker instead of relocating the hub directory (#922)
- Optional planning stages are user-skippable instead of auto-skipped (#921)

### Removed
- Leftover mock/sample data from shipping screens (the `acme/payments` sample fleet, the fabricated risk register, dead KPI/plan-session samples)
- Duplicate "Approve milestones & seams" button in the planner Structure stage — the footer's "approve & continue" is now the single approve control (#949)

### Fixed
- Deploy stage gate no longer stalls on a valid `<deploy_config>` — the parser repairs JSON that the planner CLI terminal-wrapped (raw newlines injected inside string values) before parsing (#947)

## [1.0.1] — 2026-06-16

### Added
- MCP servers throughout: a planning MCP Servers stage where the planner downloads + configures servers for the fleet, version checks with one-click download/in-place update, first-party servers in the Extensions catalog, and MCP Analytics + Hook Analytics tabs fed by real `mcp.log`/`hooks.log` telemetry (#878, #876, #885, #883, #879, #865, #867)
- Data platform foundation — `crates/data` DuckDB Data Model store + connector framework, a Data Model authoring primitive/library/editor, a Tauri bridge to load CSVs, and multi-source reconciliation with per-field lineage (read-only migration) (#780, #781, #784, #785)
- Repo presentation scaffolded at publish (topics, README + badges, community files) and per-stream GitHub assignees on published issues (#848, #847)
- Rebindable keyboard shortcuts — console actions, screen-nav/zoom, and digit-range leader bindings in Settings → Keyboard (#771, #773)
- AI CLI pane provider abstraction (#564), FCM push to the paired mobile app on `user_request` (#846), and a planner-driven blueprint-authoring lifecycle plus reliability eval harness (#568, #850)

### Changed
- Rail nav reordered; **Agents → Permissions**; Extensions page reorganized into **MCP** with Hooks moved into Automations (#872, #865)
- Large `lib.rs` decomposition — extracted planner, pty, shell, github, oauth, config, githooks, tokens, docstore, and bsc helper modules; moved planner/document templates into `include_str!` markdown files (#758, #769)
- Focused planner pane filled out — full Repos/Features/Context bodies, one-click whole-stage approval, real token budgets, no mock fallbacks (#674, #809, #811, #813); UI file-drop pane stages design files into `design/` (#829)
- Planner posture defaults to the most complete, production-grade solution (#850)

### Fixed
- Linked repos no longer vanish on restart — union both project keys (#881, #833); local-project delete, serialization, and ErrorBoundary fixes (#789, #791, #793, #874)
- Planner gate/section fixes — canonical key naming, context-stage gate, why-a-gate-is-blocked messaging, optional-stage skip nav (#803, #787, #797, #805, #676)
- `ci(rust)` strip dependency debug info to fix the DuckDB link SIGBUS (#795)

### Removed
- Generic third-party MCP servers pruned from the catalog (#870)

## [1.0.0] — 2026-06-11

### Added
- **GA release.** Planning autopilot — "Automate planning with Claude" as a Settings feature, running under its own minimal agent role with scripted/random/none strategies (#682, #702)
- Per-stream profile assignment via dropdown and a minimal app-session role for the Blueprint Assistant (#681, #680)
- Opt-in per-IP relay rate-limiting via KV (#473)

### Changed
- Blueprints made data-driven — optional skills/automations/UI/repos stages on the default blueprint, sequenced progress rail (V4) with banked-ahead + distinct "skipped" states, explicit Use-button selection with active badge (#700, #698, #676, #668, #662)
- Planner brief driven by the blueprint's real stages; reset/clear starts a fresh Claude session and unlinks repos (#666, #664, #665)

### Fixed
- Grading consistency — unreviewed dead-code candidates no longer read as a clean A; one grade-color source of truth across chips and bars (#688, #686)
- Permissions gate checks the assigned profile and generates profiles in-planning (#696); numerous rail-rendering fixes (#668)
- Release workflow handoff/docs accuracy (#108)

## [0.9.71] — 2026-06-09

### Fixed
- Planning-page polish — dropped restart/preview buttons, gated pipeline screens, hid empty context, and tagged greenfield built-ins `origin=built-in` (#654, #658)
- `clear plan` also deletes the `.ui-skeleton` dir and wipes all plan state via a confirm modal (#650)

### Added
- Focused planner pane — phase model, shell components, reused section bodies, identity header, and pulsing incomplete phases in the stepper (#652)
- Switch/reset a project's plan to a different blueprint; authored the transform blueprints; lifecycle categories + create/operate mode + library search & filter (#647, #645)

## [0.9.7] — 2026-06-09

### Added
- **Blueprints page** — full library + editor: model/registries, inline-SVG icons, cards/hero/stats, stage-rail detail, catalog + gist modals, and a "Design with Claude" assistant drawer; real gist revisions for History + Sync (#609, #622, #624)
- **Skills** attached to blueprint stages — model + editor, injected into both the planner context and worker context at launch; the assistant can author + attach new ones (#636)
- **Extensions sharing** — extension envelope + blueprint CRUD, gist publish/install transport, blueprint export/import UI, and a capability-gated sandbox runtime for code pipelines (#598)
- **Pipelines** — pipeline runtime engine (registry/dispatch/run state), render-preview pipeline (esbuild-wasm → sandboxed iframe), lint-plan/file-intake pipelines, and stage gates that block until a gate pipeline passes (#529, #531, #534, #604, #532)
- **Plan grading** — grader contract + deterministic rubric grader, LLM "Claude review" rubric grader, report-card pipeline screen with per-section letter grades for issues/milestones/repos (#615, #445)
- Refactor & Cleanup blueprint — scan-dead-code, verify-removal gate, refactor-unit generator, and fleet launch of cleanup units (#626)
- Stage registry + per-project stage config, Blueprints tab, macro N-bar planning progress; General/Appearance/Keyboard settings pages; Skills page; per-screen UI approval with preview (#515, #485–#488, #495, #546)

### Changed
- Planner `CLAUDE.md` scoped to the blueprint's enabled stages; context-stale badge + restart `--continue`; feature-discovery gate (#542, #175, #490)
- Projects list reworked to plan-first; GitHub Projects board moved to the GitHub page (#499, #498); README rebranded as a CDE (#571)

### Fixed
- GitHub device-flow connection survives navigating away from Settings (#594); planner version-prefixed phase-tag matching + publish pre-flight gate (#550)

## [0.9.6] — 2026-06-04

### Added
- Per-repo feature plans, an MCP-assign planning step, and issuer coordination emitters (#177, #174, #376)
- Host-env Diagnostics view + console-shell selection, plus a backend preflight probe for missing prerequisites (#446, #447, #456)
- Relay "Test relay" `/health` probe button in Settings and an enforced absolute room TTL (#197)

### Fixed
- Planning adopts an existing GitHub board on re-sync and locks Triage until published; unified the canonical project key + title guard through shared helpers (#444, #380)
- Stable per-tab `projectKey` — fleet/triage tabs reuse by key, not name (#457)

## [0.9.5] — 2026-06-03

### Fixed
- Request the `project` scope (`read:project`) in GitHub SSO/PAT so the project board is readable (#467)

## [0.9.4] — 2026-06-03

### Added
- Unified draggable + tear-off tab system across all pages (#461, #463, #430)
- Knowledge Base UX rework + document-assignment model with fleet-runtime reliability improvements (#212)
- Per-session token + cost accounting backend (#416); planner workshop step to dissect hard problems into reusable Skills (#371)

### Fixed
- External links open via the Tauri opener plugin (#460); live GitHub progress wired into `ProjectPane` (#429)

## [0.9.3] — 2026-06-03

### Added
- GitHub OAuth Device Flow — secret-less SSO (#431)

### Fixed
- macOS release builds ad-hoc signed so the `.dmg` is produced (#440); Windows console-window flood suppressed + GitHub SSO enabled (#433)

## [0.9.2] — 2026-06-02

### Added
- Analytics suite — Fleet analytics page + shared chart primitives, Repo Pulse (repo progress/changes folded into Repositories), Fleet live worker board + GitHub-derived throughput/merge-queue/time-to-land panels (#401, #402, #412, #415)
- **Skills** reusable capability library — new rail screen with real CRUD/persistence, session injection, planner channel, and invocation telemetry (leaderboard, success, trend) (#400, #404, #406)
- Persistent achievements registry + Settings page (super-user fires once ever) (#396); live issue progression in the structure pane with persisted GitHub issue linkage (#393)

### Changed
- Projects portfolio summary moved into the GitHub screen (#421)
- Tooling: dependency bumps (rand 0.10, snow 0.10, tokio-tungstenite 0.29, windows-sys, npm group) + CI gate job for develop branch protection (#419, #425)

## [0.9.1] — 2026-06-01

### Fixed
- Self-merge + no-stop is the fleet runtime default (#382); guarded draft delete + unified project repo key (#380)

### Added
- Planning-defined integration strategy for the fleet (#378)

## [0.9.0] — 2026-06-01

### Added
- **Project planning → fleet orchestration** — the adaptive planning model (typed-node tree + shaping), feature workshop driving granular agent-ready `PlanIssue`s, the `ProjectPane` v4 right-pane (sections, GitHub Structure, persisted perms/preset/flow/pins), publish adapter that runs a `PublishOp[]` against GitHub (one issue per `PlanIssue`, milestone per phase), and draft projects with a user-pressed "Sync to GitHub" (#201, #311, #335, #226, #379)
- **The fleet** — per-agent git worktrees + multi-tab launch, a director protocol with immediate question/answer injection (bracketed-paste, restart-safe), workers that defer to the director, CI watcher that resumes a worker on completion, and per-agent flows (autonomy + push policy) generated into kickoff prose (#154, #369, #373, #297)
- **Coordination + pipelines** — lost-wakeup-safe readiness core, `bsc-blocked --on` structured events, satisfy/fail emitters, the live Coordination inbox, always-on auto-wake, and a staged conductor (pipeline state machine, event driver, Pipelines lane) with roles composed onto the capability gate (#199, #220)
- **Session security** — role-scoped session capabilities + role gate at launch, least-privilege permission profiles (persisted/assignable/enforced) with an Activity audit log via a PreToolUse hook, repo-scoped GitHub credentials, and file-tool confinement to the repo root (#219, #236, #255, #257, #158)
- **Mobile tunnel + relay** — transport-agnostic protocol contract, zero-knowledge Cloudflare relay Worker + Durable Object, desktop relay dial-out with Noise IK crypto, relay-aware pairing QR, view-only-until-granted input, and live pane metadata push while paired (#240, #241, #242, #243, #253)
- **Extensions (real)** — MCP servers + hooks wired into sessions with an empty-state catalog CTA (#33); automations scheduler engine with cron recurrence wired to the real screen (#142, #171); multi-agent planning fleets (#173)
- Real structured GitHub Actions view from workflow YAML, real per-repo git hooks, drag-resizable repo sidebar (#141, #265, #267); easter-egg Super User achievement on >10 live agents (#365)

### Changed
- Planner is plan-only — scope-guarded `CLAUDE.md`, plan-only mandate, deep feature workshop, slow one-unit-at-a-time workshop with new/existing modes, research + grounded approaches folded into issues (#318, #316, #350, #363, #371)
- Console execution surface — mount every tab's panes (CSS-hide inactive), pause `xterm.write` for hidden panes, scrollback budget by total mounted panes, persist `paneWasClaude` + auto-resume claude, cross-tab focus queue (#199 wiring)

### Fixed
- PTY process trees killed on app exit via a Windows Job Object; never silently fall back to `$HOME` when a session cwd is missing (#367); `GH_TOKEN` exported into agent shells so workers can push + open PRs (#362); rc helpers get trailing newlines so they don't glue together (#296)
- Tunnel reliability — rustls ring `CryptoProvider` install (stops relay-dial panic), bounded dial timeout, connection-lifecycle logging (#274, #272, #270)
- Tooling: CodeQL + dependency-audit workflows, per-OS Rust suite on Linux/macOS, release notes from merged PRs, path-conditional CI jobs (#198, #121, #167)

## [0.6.0] — 2026-05-27

### Added
- Extensions screen (mock): manage MCP servers (first-party + third-party) and hooks — Installed/Catalog views, Global/Project/Console scope, per-project matrix, and a config drawer (#33)
- Automations screen rebuilt (mock): Schedules list + deep editor (when/target/action/guard/history) and a filterable cross-schedule History tab; the old Commands tab folds into a schedule's action (#142)
- Resizable panes on the Knowledge Base screen — drag the document-list width and the preview height above the terminal (#43)

### Changed
- Consolidated the roadmap into a version-based `PROJECT_PLAN.md` and README roadmap (#157, #155, #151)

## [0.5.1] — 2026-05-27

### Fixed
- `bsc-checkpoint` is now reachable from agent shells, not just the interactive console
  pane. Claude's Bash tool runs commands in non-interactive `bash -c` subprocesses that
  never saw the interactive shell's functions, so triage sessions couldn't persist their
  "where we left off" checkpoint. The helper is now installed via an rc file + `BASH_ENV`
  (the hyphenated name can't be `export -f`'d), so every agent subshell can run it (#148).
- Keep the Projects summary mounted instead of derendering it; gate the app shell on store hydration to stop the initial-render flash (#144, #143)

### Added
- ETag-validated in-memory cache for `github_request` with a memory window + token-expiry handling, and a TTL cache for `github_graphql` with windowed summary queries (#135)

## [0.5.0] — 2026-05-27

### Added
- Project header rework — Plan/Triage CTAs + a triage rerun-confirm modal (#134)
- Triage sessions checkpoint their own startup script (#133)
- Cross-tab focus queue — cycling hops to the tab with the waiting console

### Changed
- Removed the repo/branch auto-detection display (#34)
- Retired legacy focus-steal so the queue governs console focus; only pass `--continue` when Claude has prior history for the cwd

## [0.4.0] — 2026-05-26

### Added
- Real iteration burn-down from the Projects V2 Iteration field

### Fixed
- Resolve Git Bash for sessions instead of WSL's `bash`

### Changed
- Adopt React 19, xterm 6, Vite 7; target dependabot at `develop` with grouped minor/patch updates

## [0.3.0] — 2026-05-26

### Added
- Projects screen with live GitHub API, planning PTY, and board navigation; a guided-dynamic planner with per-repo planning and reliable kickoff; isolated workspace directories for planning + Knowledge Base sessions; unified session storage (`projects/{project}/{repo}`) (#57)
- Triage sessions resume the repo's prior conversation (`claude --continue`)
- Console focus queue — `Ctrl+Shift+N` steps through waiting agents with auto-advance on reply and a settings toggle
- Pane maximize/minimize controls, terminal font zoom (`Ctrl++/-/0`), and chained-digit pane selection for panes 10+
- Allow-Bash + deny-dangerous session security with a Knowledge Base Commands section (#57); time-window + state filters for the Roadmap tab (#59); Claude Config settings section for managing `CLAUDE.md` and permissions

### Fixed
- Self-heal a corrupt `~/.claude.json` and stop corruption from concurrent session launches; persist console sessions across screen navigation; debounce auto-focus so sessions stop ping-ponging the cursor (#58)
- Projects list fixes — row ⋯ menu mousedown race, persisted in-app removal, and delete for web-deleted projects

## [0.2.0] — 2026-05-23

### Added
- PTY terminal in every console pane (xterm.js + portable-pty / ConPTY)
- Native directory picker (`rfd`) with folder button in pane header
- OSC 7 cwd tracking — repo/branch auto-detected from shell working directory
- `git_info` Tauri command for repo/branch/dirty-state detection
- Hotkey overhaul: Ctrl+1–9 for tab navigation, Ctrl+Shift+1–9 for pane focus/fullscreen
- Auto-focus-on-interrupt setting (Settings → Integrations)
- Pane status count in status bar now sums all tabs
- View selector collapsed to icon-only with full detail in pane menu
- Persist pane cwds and names across restarts

### Changed
- Replaced mock console chat UI with real bash PTY session
- PTY sessions survive tab switches (idempotent `pty_create`)
- Ctrl+L used on PTY reconnect instead of `\n` to repaint prompt cleanly
- Shell uses `printf` for ANSI clear instead of `clear` (works in Git Bash)

## [0.1.0] — 2026-05-22

### Added
- Initial Tauri v2 + React 18 + TypeScript scaffold
- CSS design token system (`src/styles/tokens.css`)
- Chrome: Titlebar, Rail, Tabstrip, StatusBar
- Pane system: PaneShell, ViewTabs, PaneMenu with portal rendering
- Console screen with CSS grid layout (1×1, 2×2, 3×3)
- Knowledge Store screen
- GitHub screen (connect flow, Overview, Actions, Hooks)
- Automations screen (Schedules, Commands)
- Settings screen (GitHub, Integrations)
- Zustand store with `tauri-plugin-store` persistence
- Live titlebar breadcrumb and status bar indicators
- Tab add/close with confirmation dialog
- Lucide icons throughout
