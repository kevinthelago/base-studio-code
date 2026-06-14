// Blueprints (#513/#514): the model behind the Blueprints page. A blueprint is an
// ordered list of planning SECTIONS (stages) that seeds every new project. Each
// section owns its prompt module (the instructions Claude receives for that stage)
// and its PIPELINES — pluggable actions that run on the stage's output. Pure (no
// React/Tauri) so it's unit-testable and the store can seed from it directly.
//
// Mirrors design/base-studio-code-projects/Blueprints.html.

import { PLAN_STAGES, type StageConfig, type StageId } from "./planStages";
import {
  evalGate, gateApplies,
  type StageGate, type Requirement, type PlanSignals,
} from "./stageGate";

// ── ids ──────────────────────────────────────────────────────────────────────
let _id = 0;
/** Ephemeral handle for a section/pipeline instance (stable within a session). */
export const uid = (p: string) => `${p}-${++_id}`;

// ── Pipelines ────────────────────────────────────────────────────────────────
// kind: "builtin" (ships with the app) · "external" (third-party integration) ·
//       "custom" (user wires their own command/webhook).
export type PipelineKind = "builtin" | "external" | "custom";
export type PipelineTrigger = "on section enter" | "on artifact change" | "on completion" | "manual";
export const TRIGGERS: PipelineTrigger[] = ["on section enter", "on artifact change", "on completion", "manual"];

export interface PipelineDef {
  id: string;
  name: string;
  desc: string;
  /** Section keys this pipeline suits; "*" = any stage. */
  suits: string[];
  kind: PipelineKind;
}

export interface Pipeline extends PipelineDef {
  uid: string;
  trigger: PipelineTrigger;
  /** Scopes the trigger to one substep/artifact WITHIN the stage (its `key`), or a loop item
   *  (e.g. "features" → run for each feature). Absent / "*" ⇒ the whole stage (the default).
   *  This is what lets a pipeline fire "right after schema.md" or "for each feature" rather
   *  than only on stage enter/completion. */
  triggerTarget?: string;
  enabled: boolean;
  /** A gate pipeline blocks its stage from completing until it passes (#532). */
  gate?: boolean;
}

export const PIPELINE_LIB: PipelineDef[] = [
  { id: "render-preview",  name: "Render preview",      desc: "Visualize screens as a 2D / 3D walkthrough", suits: ["ui"],          kind: "builtin"  },
  { id: "file-intake",     name: "Drop files",          desc: "Drag in design or any files; the planner routes them to the right repo", suits: ["ui", "*"], kind: "builtin" },
  { id: "push-figma",      name: "Push to Figma",       desc: "Export generated frames to a Figma file",    suits: ["ui"],          kind: "external" },
  { id: "generate-issues", name: "Generate issues",     desc: "Turn phases into granular GitHub issues",    suits: ["structure"],   kind: "builtin"  },
  { id: "grade-plan",      name: "Grade plan",          desc: "Score agent-readiness and suggest fixes",    suits: ["structure"],   kind: "builtin"  },
  { id: "grade-rubric",    name: "Grade section",       desc: "Score this section against a rubric (report card)", suits: ["*"],     kind: "builtin"  },
  { id: "grade-llm",       name: "Claude review",       desc: "Ask Claude to grade this section against its rubric", suits: ["*"],   kind: "builtin"  },
  { id: "scan-dead-code",  name: "Scan dead code",      desc: "Find unused code & deps (depcheck / ts-prune / cargo-machete)", suits: ["*"], kind: "builtin" },
  { id: "sync-milestones", name: "Sync milestones",     desc: "Publish phases as GitHub milestones",        suits: ["structure"],   kind: "builtin"  },
  { id: "lint-plan",       name: "Lint plan",           desc: "Validate this stage's output for gaps",      suits: ["*"],           kind: "builtin"  },
  { id: "scope-streams",   name: "Scope streams",       desc: "Derive least-privilege agent profiles",      suits: ["permissions"], kind: "builtin"  },
  { id: "arm-schedule",    name: "Arm schedule",        desc: "Install a cron automation rule",             suits: ["automations"], kind: "builtin"  },
  { id: "sync-skills",     name: "Sync skill library",  desc: "Upsert reusable skills into the library",    suits: ["skills"],      kind: "builtin"  },
  { id: "index-repos",     name: "Clone & index repos", desc: "Clone linked repos and build a code index",  suits: ["repos"],       kind: "builtin"  },
  { id: "export-notion",   name: "Export to Notion",    desc: "Mirror this stage's doc into a Notion page", suits: ["*"],           kind: "external" },
  { id: "schema-check",    name: "Schema check",        desc: "Validate the data model for orphan relations & missing migrations", suits: ["schema"], kind: "builtin" },
  { id: "contract-test",   name: "Contract test",       desc: "Run contract tests against the declared API surface",               suits: ["api"],    kind: "builtin" },
];

// ── Substeps ─────────────────────────────────────────────────────────────────
// A discrete step WITHIN a stage. The conductor injects ONE substep's prompt at a time and
// advances when its artifact is written + confirmed — incremental, instead of front-loading
// the whole stage's instructions. A `loop` substep repeats once per dynamic item discovered
// during the stage (the feature workshop), so the conductor drives "one feature at a time".
export type SubStepLoop = "features" | "repos" | "topics";
export interface SubStep {
  /** Canonical key / artifact stem (e.g. "goal" → goal.md). For a loop, the loop's id. */
  key: string;
  label: string;
  /** Injected into the session when this substep becomes active. Plan-only — never describes
   *  publishing (the user owns that). */
  prompt: string;
  /** Human "done when…"; absent ⇒ informational (no gate of its own). */
  gate?: string;
  /** Repeat once per dynamic item (a feature, a repo). Absent ⇒ a single static substep. */
  loop?: SubStepLoop;
}

// ── Sections (the canonical planning stages) ─────────────────────────────────
export interface SectionDef {
  name: string;
  glyph: string;
  /** Human-readable gate description, shown in the editor and the readiness feedback. */
  gate: string;
  deps: string[];
  blurb: string;
  prompt: string;
  /** Declarative completion gate (#…) — the DATA that decides this section's
   *  done-ness. Carried on every section instance so a section is fully serializable
   *  and distributable; the app evaluates it via {@link evalGate}. Absent ⇒ the
   *  section is informational (vacuously complete). */
  gateRule?: StageGate;
  /** Optional applicability rule (e.g. UI only when the project needs a UI). Absent ⇒
   *  the section always applies. */
  appliesWhen?: Requirement;
  /** An OPTIONAL section is shown but never required: it doesn't block plan completion or
   *  downstream dependents, and it's off the critical path (currentSection skips it) — the
   *  user can fill it or skip it (#676). */
  optional?: boolean;
  /** Output disposition (#609) — what happens to this stage's artifact (a key into
   *  DISPOSITIONS: plan-file / issues / milestones / skill-index / knowledge / scratch).
   *  Editor metadata; the runtime doesn't read it. Absent ⇒ defaultDisposition(key). */
  output?: string;
  /** Attached skills/knowledge (#636) — library item ids (KB blocks or Skills) injected
   *  into the agent's context for this stage. Resolved at planning + fleet launch
   *  (slice b). Reference-by-id; unresolved ids surface a warning. */
  skills?: string[];
  /** Ordered substeps the conductor injects one at a time (#…). Absent ⇒ the stage is driven
   *  by a single prompt (its `prompt`). Pipeline `triggerTarget`s reference these by `key`. */
  substeps?: SubStep[];
}

export const SECTION_DEFS: Record<string, SectionDef> = {
  context: {
    name: "Context", glyph: "◆", gate: "all topics resolved", deps: [],
    // core four confirmed (must-pass, no fill) + every surfaced topic resolved.
    gateRule: { require: [
      { signal: "coreConfirmed", target: true, weight: 0, label: "confirm goal, scope, stack & architecture" },
      { signal: "topicsResolved", of: "topicsTotal", label: "resolve the discovery topics" },
    ] },
    blurb: "Discovery — goal, scope, stack, architecture (+ applicable dimensions).",
    prompt:
`Walk the discovery checklist one topic at a time, using the canonical key as each
file's stem. The gate REQUIRES these four written and confirmed: goal, scope, stack,
architecture. Cover other dimensions ONLY where they genuinely apply (canonical keys:
users, ux, schema, api, auth, security, testing, …) and record the rest in _skipped.md.
Each file you create is a gate item the user confirms — don't create tangential files.

Gate: goal/scope/stack/architecture confirmed, and every documented topic confirmed
(skipped dimensions don't count).`,
    substeps: [
      { key: "goal", label: "Goal", gate: "goal.md written and confirmed", prompt:
`Establish the goal: the single outcome this project must achieve, and who it's for. Propose
it, interrogate it with the user, then write goal.md. Stop and confirm before moving on.` },
      { key: "scope", label: "Scope", gate: "scope.md written and confirmed", prompt:
`Define what's in scope and — just as important — what's explicitly out of scope. Write
scope.md, then confirm.` },
      { key: "stack", label: "Stack", gate: "stack.md written and confirmed", prompt:
`Decide the technology stack — languages, frameworks, datastores — and the reasoning behind
each choice. Write it to the file named exactly \`stack.md\` (not "tech stack.md" or a titled
variant — the gate looks for \`stack.md\`), then confirm.` },
      { key: "architecture", label: "Architecture", gate: "architecture.md written and confirmed", prompt:
`Describe the high-level architecture: the major components and how they interact. Write
architecture.md, then confirm.` },
      { key: "dimensions", label: "Applicable dimensions", loop: "topics", prompt:
`Now cover any remaining dimension that genuinely applies — one at a time — using the canonical
key as the file stem (users, ux, schema, api, auth, security, testing, …). Record every
dimension you don't document in _skipped.md. Don't create files for tangential topics.` },
    ],
  },
  repos: {
    name: "Repos", glyph: "⑂", gate: "≥1 repo linked", deps: [],
    gateRule: { require: [{ signal: "repoCount", target: 1, label: "link at least one repository" }] },
    blurb: "Link the repositories this project spans.",
    prompt:
`Link the repositories this project spans. For each, record owner/repo, default
branch, and its role in the system. Write repos.json.

Gate: at least one repository is linked.`,
  },
  ui: {
    name: "UI", glyph: "▣", gate: "screens & flows defined", deps: ["context"],
    // applies only when the project needs a UI; complete when every screen is approved.
    appliesWhen: { signal: "requiresUi", target: true },
    gateRule: { require: [{ signal: "screensApproved", of: "screensTotal", label: "approve the screen previews" }] },
    blurb: "Screens, states, and primary flows.",
    prompt:
`Define the screens and primary flows. For each screen: its purpose, key states,
and the components it needs from the design system. Produce ui.md plus a screen
inventory the Render preview pipeline can visualize.

Gate: every primary flow has its screens and states defined.`,
  },
  // Features (#…): the INTERACTIVE heart — define the user-facing capabilities, one at a time.
  // Each feature is a fleet stream. Claude proposes a starter set; the user curates, then drills
  // into each. Integration seams are NOT defined here — the Plan stage owns them.
  features: {
    name: "Features", glyph: "◇", gate: "every feature defined", deps: ["context"],
    gateRule: { require: [
      { signal: "featuresConfirmed", target: true, weight: 0, label: "confirm the feature set" },
      { signal: "featuresDefined", target: 1, label: "define at least one feature" },
    ] },
    blurb: "The user-facing capabilities — each one a stream.",
    prompt:
`Define the app's user-facing capabilities — the things a user DOES ("invite teammates", "export
to CSV"), never infrastructure (auth, queues, storage are implementation detail under a feature).
Each capability becomes its own fleet stream. Propose a starter set, let the user curate it, then
take each one in turn.`,
    substeps: [
      { key: "propose", label: "Propose the feature set", gate: "the feature list is confirmed", prompt:
`From the goal, scope, and what you've discussed, propose a STARTER set of user-facing capabilities
— enough to get going, not exhaustive. Write them to features.json: a JSON array of
\`{"slug","name"}\` objects (e.g. \`{"slug":"invite-teammates","name":"Invite teammates"}\`). They
appear in the Features board for the user to curate — add, remove, merge, rename. Confirm the SET
with the user before drilling into any single feature.` },
      { key: "features", label: "Define each feature", loop: "features", prompt:
`Now take ONE feature at a time. For THIS feature, fill in its features.json entry before moving on:
• \`behavior\` + \`acceptance\` (a string array) — what it does, and the done-when checklist.
• \`approach\` — the concrete shape of the solution.
• \`tools\` (a string array) — the specific libraries/services/frameworks (name them).
• \`data\` — what it stores/reads and which other features it relies on.
This feature is its own fleet STREAM (its slug). Propose, then interrogate with the user; confirm
it before the next. Do NOT design the integration contracts between features here — the Plan stage
owns the seams.` },
    ],
  },
  // Plan (#…): the AUTONOMOUS synthesis — Claude turns the defined features into the GitHub
  // structure on its own, then presents it for approval. Seams live in contracts/, owned by the
  // director. (Key kept as `structure` so everything downstream stays wired.)
  structure: {
    name: "Plan", glyph: "⊞", gate: "phases + issues", deps: ["context", "repos", "features"],
    gateRule: { require: [
      { signal: "phasesConfirmed", target: true, label: "approve the roadmap" },
      { signal: "issueCount", target: 1, label: "generate agent-ready issues" },
    ] },
    blurb: "Autonomous: contracts, phases, and the sub-issue tree.",
    prompt:
`With the features defined, synthesize the plan on your own — then present it for approval.
1. Infer the SEAMS between features (where one consumes another's output) and write each as a
   contract doc under contracts/<name>.md. The DIRECTOR owns these — it authors/maintains them,
   tests the integration, and answers worker questions; workers read contracts/ as the source of
   truth and never negotiate interfaces directly.
2. Sequence the features into ordered phases (the roadmap) — write phases.json, each phase a crisp
   "done when". Contract work lands EARLY, before its consumers.
3. Generate the agent-ready issue tree — write issues.json: each FEATURE is a parent owned by its
   stream, decomposed into granular sub-issues (acceptance criteria, owned files/globs,
   dependencies, labels).
Then STOP and ask the user to APPROVE the phases + the seam/dependency graph before treating any
of it as final.

Gate: phases approved, and every feature decomposed into agent-ready issues.`,
  },
  permissions: {
    name: "Permissions", glyph: "⛉", gate: "every stream scoped", deps: ["structure"],
    gateRule: { require: [
      { signal: "fleetStreams", target: 1, label: "plan the agent fleet" },
      { signal: "profilesComplete", target: true, label: "set a profile for every stream" },
    ] },
    blurb: "Least-privilege profile per work stream.",
    prompt:
`For every work stream, derive a least-privilege profile: allowed commands,
write-path globs, network access, and a git/gh push policy. Map each to a role
(worker / director / triage). Write the per-stream permission set.

Gate: every stream has a scoped profile and a role.`,
  },
  automations: {
    name: "Automations", glyph: "⚡", gate: "≥1 automation armed", deps: ["structure"],
    gateRule: { require: [{ signal: "automationsAck", target: true, label: "review automations for this project" }] },
    blurb: "Cron rules that load context or dispatch commands.",
    prompt:
`Propose cron-triggered rules that load a knowledge block or dispatch a command
into a console pane. Record each rule's trigger, target pane, and cadence. Write
automations.md.

Gate: at least one automation is armed.`,
  },
  skills: {
    name: "Skills", glyph: "✦", gate: "skills selected", deps: [],
    gateRule: { require: [{ signal: "skillsAck", target: true, label: "assign skills to the fleet" }] },
    blurb: "Reusable skills from the global library.",
    prompt:
`Select reusable skills from the global library that apply to this project's
stack, and propose any new ones worth saving for reuse. Write skills.json.

Gate: the applicable skills are selected.`,
  },
  testing: {
    name: "Testing", glyph: "✓", gate: "coverage strategy set", deps: ["structure"],
    blurb: "Test strategy, fixtures, and CI gates.",
    prompt:
`Define the testing strategy: unit / integration / e2e split, fixtures, and the
CI gates that must pass before merge to develop. Write testing.md.

Gate: a coverage strategy and CI gates are defined.`,
  },
  // Refactor & Cleanup blueprint (#626): find unused / dead / legacy code to remove.
  // Informational (no gateRule) — the scan-dead-code pipeline + cleanup grade drive it.
  cleanup: {
    name: "Dead & legacy code", glyph: "♻", gate: "findings triaged", deps: ["repos"],
    blurb: "Unused code, dead dependencies & legacy debt to remove.",
    prompt:
`Find what to remove or modernize: unused exports/files, unused dependencies, dead
feature flags, deprecated APIs, and duplicated code. Run the scan, verify each
candidate (static tools have false positives — dynamic refs, public API, test-only
use), then list confirmed removals as refactor units with a test safety net.`,
  },
  // ── transform / harden stages (#645 slice 2): informational (no signal gate) ──
  boundaries: {
    name: "Service boundaries", glyph: "⧉", gate: "boundaries mapped", deps: ["repos"],
    blurb: "Bounded contexts and the seams to split the monolith along.",
    prompt:
`Map the codebase into bounded contexts: cohesive modules, the data each owns, and the
call/coupling seams between them. Identify the cut lines for extraction and the shared
code that must be split or duplicated. Flag chatty couplings that would become costly
network calls once separated.`,
  },
  extraction: {
    name: "Extraction plan", glyph: "⤳", gate: "extraction sequenced", deps: ["boundaries"],
    blurb: "Incremental, shippable steps to carve each service out.",
    prompt:
`Sequence the split. For each service: its API/contract, the data it owns + how to
migrate it, and the strangler steps to extract it without a big-bang cutover. Order by
dependency and risk; keep the system shippable and reversible at every step.`,
  },
  consolidation: {
    name: "Consolidation plan", glyph: "⧈", gate: "merge mapped", deps: ["repos"],
    blurb: "Merge services back together, unifying data & contracts.",
    prompt:
`Map the services to merge: overlapping responsibilities, the data stores to unify, and
the inter-service calls that become in-process. Plan the merge order, the shared schema,
and how to retire the redundant deployments/contracts without downtime.`,
  },
  migration: {
    name: "Migration plan", glyph: "⇄", gate: "from→to mapped", deps: ["repos"],
    blurb: "The from→to mapping and an incremental, reversible cutover.",
    prompt:
`Define the migration: the from→to (framework / language / protocol / datastore), an
equivalence mapping, and an incremental cutover — run old + new in parallel, migrate
slice by slice, verify, then retire the old. Call out breaking changes and the
compatibility shims that bridge them.`,
  },
  hardening: {
    name: "Security hardening", glyph: "⛨", gate: "threats triaged", deps: ["repos"],
    blurb: "Threat model, an authz/secrets/deps audit, and concrete fixes.",
    prompt:
`Threat-model the system (assets, entry points, trust boundaries), then audit: authn/authz
gaps, secret handling, input validation, dependency CVEs, and transport/storage crypto.
Rank findings by severity and produce concrete, testable fixes — not just observations.`,
  },

  // ── data-platform stages (#782/#783): acquire → model → clean → load into a canonical
  // Data Model. Informational (no signal gate yet — declarative licensing/quality gates are
  // #783) and plan/data-only: the planner designs the pipeline + writes datamodel.json, it
  // never runs the load itself. Shared stages (dataModel/dataClean/dataLoad) declare deps
  // spanning BOTH pipelines; a blueprint that omits a dep has it "treated as met" (see the
  // lock resolution below), so dataClean gates on dataMap in migration and dataExtract in
  // collection without separate defs.
  dataModel: {
    name: "Data Model", glyph: "▤", gate: "canonical schema defined", deps: ["context"],
    blurb: "The canonical schema everything maps into — entities, fields, identity keys.",
    prompt:
`Define the canonical DATA MODEL this project loads into — the single source of truth that
later powers any app built over it. For each entity: its fields (with types + which are
required), the relationships between entities, and the IDENTITY key (the fields that decide
when two records describe the same real-world thing — used later to merge across sources).
Propose it, interrogate it with the user, then write datamodel.json. This is the TARGET the
mapping/extraction stages aim at — get it right before moving data.`,
  },

  // Migration front half — a system the user controls; it already has a schema.
  dataSource: {
    name: "Source", glyph: "⇲", gate: "source reachable + inventoried", deps: ["context"],
    blurb: "Connect the system of record and inventory what's there.",
    prompt:
`Identify the source system to migrate from (database, SaaS export, API — e.g. SAP via OData,
Salesforce Bulk API, a SQL dump). Record how it's reached and an INVENTORY of its objects and
their schemas, and pull a small representative sample of rows for the mapping stage. Don't move
anything yet — this stage just establishes what exists.`,
  },
  dataMap: {
    name: "Mapping", glyph: "↦", gate: "every in-scope field mapped or dropped", deps: ["dataSource", "dataModel"],
    blurb: "Field-by-field: source object → Data Model entity.",
    prompt:
`Map the source onto the Data Model, one object at a time. For each source object, bind it to a
Data Model entity and map every field — or explicitly mark it DROPPED, with a reason. Note the
transforms each field needs (type coercion, unit/format normalization, lookups). The output is a
complete mapping spec; nothing is left ambiguous for the load stage.`,
    substeps: [
      { key: "map-objects", label: "Bind objects to entities", gate: "each source object bound to an entity", prompt:
`Bind each source object to a Data Model entity (or mark it out of scope). Confirm the set of
object→entity bindings with the user before mapping individual fields.` },
      { key: "map-fields", label: "Map the fields", gate: "every in-scope field mapped or dropped", prompt:
`Now, per bound object, map every field to a Data Model field or mark it DROPPED with a reason,
recording the transform each needs. Write the mapping spec, then confirm.` },
    ],
  },
  // NOTE: migration is strictly READ-ONLY from the source (decided #782) — there is no
  // write-back stage. base-studio-code never writes back into a system of record; it only
  // reads, maps, and loads into the canonical Data Model.

  // Collection front half — net-new external data, usually schema-less.
  collectTargets: {
    name: "Targets", glyph: "◎", gate: "sources + Data Model bound", deps: ["context"],
    blurb: "Declare the external sources and the Data Model they feed.",
    prompt:
`Declare the external data sources to collect from — websites to scrape, or datasets/APIs to fetch
(name them: the URLs, dataset identifiers, or endpoints). For each, note the mode (scrape vs fetch)
and what entities of the Data Model it's expected to populate. Confirm the target list with the
user before checking legitimacy.`,
  },
  sourceLicensing: {
    name: "Source legitimacy", glyph: "⚖", gate: "every source cleared for use", deps: ["collectTargets"],
    blurb: "ToS / robots / license clearance — blocks acquisition.",
    prompt:
`Before acquiring anything, clear each source for the intended use: site Terms of Service and
robots.txt for scraping, and the license for any dataset (can it be used commercially? does it
require attribution?). Record a per-source verdict — cleared / restricted / blocked — with the
reason. A source that isn't cleared must NOT be acquired. Surface anything ambiguous to the user.`,
  },
  dataAcquire: {
    name: "Acquire", glyph: "⤓", gate: "raw artifacts captured", deps: ["sourceLicensing"],
    blurb: "Scrape (rate-limited, robots-aware) or fetch the raw data.",
    prompt:
`Design the acquisition for each cleared source. SCRAPE mode: a crawl that respects robots.txt and
rate limits, with retry/backoff, capturing raw HTML/responses. FETCH mode: download the file or
page the API, capturing the raw artifacts. Record provenance for every artifact (source, when,
under which license) — this seeds the lineage the load stage records.`,
  },
  dataExtract: {
    name: "Extract", glyph: "⛏", gate: "structured rows produced", deps: ["dataAcquire"],
    blurb: "Parse raw artifacts into structured rows.",
    prompt:
`Turn the raw artifacts into structured rows: parse HTML/DOM, or ingest the fetched CSV/JSON/Parquet.
Define the parse rules and the row shape produced, keeping each row tied to its provenance. The
output is structured-but-uncleaned rows for the shared cleaning stage.`,
  },

  // Shared back half — both pipelines converge here.
  dataClean: {
    name: "Cleaning", glyph: "✦", gate: "rows pass the quality bar", deps: ["dataMap", "dataExtract"],
    blurb: "Coerce, standardize, validate against the Data Model's rules.",
    prompt:
`Clean the rows against the Data Model: coerce types, standardize formats (dates, currency,
addresses, casing), and validate against each field's rules. Decide the QUALITY BAR — the
confidence threshold a row must clear to be allowed into the Data Model — and how failures are
quarantined for review. External (collected) data is dirtier than a system of record, so set the
bar higher for collection.`,
  },
  dataLoad: {
    name: "Load & reconcile", glyph: "⤧", gate: "load verified + lineage complete", deps: ["dataClean"],
    blurb: "Director merges into the Data Model by identity key, with lineage.",
    prompt:
`Plan the load + reconciliation the DIRECTOR runs. When several sources feed the same entity,
records are MERGED by the entity's identity key; conflicts resolve by a declared source-PRECEDENCE
rule (state it). Every loaded value records LINEAGE — which source, when, under what license — so
the result is auditable. Define the verification that confirms the load matched expectations before
it's treated as done.`,
  },
};

export interface BlueprintSection extends SectionDef {
  uid: string;
  key: string;
  enabled: boolean;
  expanded: boolean;
  pipelines: Pipeline[];
}

/** Where a blueprint came from (#609) — drives the card's origin tag. */
export type BlueprintOrigin = "built-in" | "local" | "forked" | "imported";

/** Lifecycle intent of a blueprint (#645) — what part of a project's life it serves.
 *  Greenfield = create from a pitch; transform = restructure existing repos; harden =
 *  improve quality in place; maintain = ongoing upkeep. Drives library grouping/labels. */
export type BlueprintCategory = "greenfield" | "transform" | "harden" | "maintain" | "data";
export const BLUEPRINT_CATEGORIES: BlueprintCategory[] = ["greenfield", "transform", "harden", "maintain", "data"];

/** Whether a blueprint starts from a pitch (create) or runs against existing repos
 *  (operate) — selects the planner intro at launch. */
export type BlueprintMode = "create" | "operate";

/** Display metadata per category (label + accent hue for the badge/filter). */
export const CATEGORY_META: Record<BlueprintCategory, { label: string; h: number }> = {
  greenfield: { label: "Greenfield", h: 145 },
  transform:  { label: "Transform",  h: 230 },
  harden:     { label: "Harden",     h: 25 },
  maintain:   { label: "Maintain",   h: 70 },
  // Data-acquisition blueprints (#779) — distinct from the software-lifecycle
  // categories above. They write into a canonical Data Model rather than code.
  data:       { label: "Data",       h: 280 },
};

/** Gist link state for a blueprint (#609) — the publish/sync state-machine. Slice 5
 *  populates this; the Library card reads it for the sync badge. Absent ⇒ local-only. */
export interface BlueprintGist {
  state: "local" | "dirty" | "synced" | "forked";
  /** Whether an upstream update is available (forked blueprints). */
  behind?: boolean;
  rev?: string;
  author?: string;
  id?: string;
  url?: string;
  public?: boolean;
}

export interface Blueprint {
  id: string;
  name: string;
  desc: string;
  sections: BlueprintSection[];
  /** Display + provenance metadata (#609). All optional — the Library derives sensible
   *  fallbacks (icon from the name, hue from the id, origin "local", local-only gist). */
  icon?: string;
  /** Accent hue (oklch) for the card/editor icon. */
  h?: number;
  origin?: BlueprintOrigin;
  tags?: string[];
  gist?: BlueprintGist;
  /** How many projects this blueprint has seeded. */
  uses?: number;
  updatedAt?: string;
  /** Blueprint-wide attached skills/knowledge (#636) — applied across every stage,
   *  in addition to each section's own `skills`. Library item ids. */
  skills?: string[];
  /** Lifecycle intent (#645). Absent ⇒ greenfield (the create-a-project default). */
  category?: BlueprintCategory;
  /** Create (from a pitch) vs operate (against existing repos). Absent ⇒ create. */
  mode?: BlueprintMode;
}

/** A blueprint's category, defaulting to greenfield. */
export function blueprintCategory(bp: Blueprint): BlueprintCategory {
  return bp.category ?? "greenfield";
}

/** Filter blueprints by a free-text query (name/desc/tags) + optional category. Pure;
 *  drives the Library's search + category filter (#645). */
export function filterBlueprints(blueprints: Blueprint[], opts: { query?: string; category?: BlueprintCategory | "all" }): Blueprint[] {
  const q = (opts.query ?? "").trim().toLowerCase();
  const cat = opts.category ?? "all";
  return blueprints.filter((b) => {
    if (cat !== "all" && blueprintCategory(b) !== cat) return false;
    if (!q) return true;
    const hay = `${b.name} ${b.desc} ${(b.tags ?? []).join(" ")} ${blueprintCategory(b)}`.toLowerCase();
    return hay.includes(q);
  });
}

export const DEFAULT_BLUEPRINT_ID = "default";

/** Build a section instance from a def key + per-blueprint overrides. */
export function mkSection(
  key: string,
  { enabled = true, expanded = false, optional, pipelines = [] as [string, PipelineTrigger?, boolean?][] }:
    { enabled?: boolean; expanded?: boolean; optional?: boolean; pipelines?: [string, PipelineTrigger?, boolean?][] } = {},
): BlueprintSection {
  const def = SECTION_DEFS[key];
  return {
    uid: uid("sec"), key, ...def, enabled, expanded,
    // explicit `optional` overrides the def's; otherwise inherit it
    optional: optional ?? def.optional,
    pipelines: pipelines.map(([libId, trigger, on]) => {
      const lib = PIPELINE_LIB.find((p) => p.id === libId)!;
      return { uid: uid("pl"), ...lib, trigger: trigger ?? "on completion", enabled: on !== false };
    }),
  };
}

/** Seed blueprints — the starter library, depicting every section/pipeline state. */
/**
 * Replace persisted built-in blueprints with their current code definitions (by id) and
 * append any new built-ins, leaving user-created / forked / imported blueprints untouched.
 * Built-ins are code-owned templates, but `blueprints` is persisted — this lets improvements
 * (the optional UI stage, enabled repos, updated prompts, …) reach an already-seeded store
 * instead of being pinned to the version a user first ran (#677).
 */
export function refreshBuiltIns(persisted: Blueprint[]): Blueprint[] {
  const fresh = makeBlueprints();
  const byId = new Map(fresh.map((b) => [b.id, b]));
  const merged = persisted.map((b) => (b.origin === "built-in" && byId.has(b.id) ? byId.get(b.id)! : b));
  for (const b of fresh) if (!merged.some((x) => x.id === b.id)) merged.push(b);
  return merged;
}

export function makeBlueprints(): Blueprint[] {
  return [
    {
      id: "default", name: "Default", desc: "Balanced starting point", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("ui",          { optional: true, pipelines: [["render-preview", "on artifact change", true], ["file-intake", "manual", true], ["push-figma", "on completion", true]] }),
        mkSection("features"),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false], ["sync-milestones", "on completion", false]] }),
        mkSection("permissions", { pipelines: [] }),
        mkSection("automations", { optional: true, pipelines: [["arm-schedule", "on completion", true]] }),
        mkSection("skills",      { optional: true, pipelines: [["sync-skills", "manual", true]] }),
      ],
    },
    {
      id: "fullstack", name: "Full-stack web app", desc: "Web client + API + DB", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("repos"), mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] }),
        mkSection("features"),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("testing"), mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
        mkSection("automations"), mkSection("skills"),
      ],
    },
    {
      id: "mobile", name: "Mobile MVP", desc: "Single app, ship fast", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("ui", { pipelines: [["render-preview", "on artifact change", true]] }),
        mkSection("features"),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("permissions"), mkSection("skills"),
      ],
    },
    {
      id: "api", name: "API microservice", desc: "Headless service, no UI", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("repos"),
        mkSection("features"),
        mkSection("structure", { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false], ["sync-milestones", "on completion", true]] }),
        mkSection("testing"), mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
        mkSection("automations"),
      ],
    },
    {
      id: "refactor", name: "Refactor & Cleanup", desc: "Clean up an existing codebase — find dead/legacy code & refactor",
      origin: "built-in", icon: "♻", h: 25, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("cleanup",     { pipelines: [["scan-dead-code", "manual", false], ["grade-rubric", "on completion", false]] }),
        mkSection("testing",     { pipelines: [["lint-plan", "on completion", true]] }),
        // No `structure` stage: a refactor pass tracks work as cleanup/refactor units that
        // drive the fleet directly — it doesn't need a GitHub issues.json (#666).
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    // ── transform blueprints (#645 slice 2): operate on existing repos ──
    {
      id: "split-services", name: "Split into microservices", desc: "Carve a monolith into services along its seams",
      origin: "built-in", icon: "⧉", h: 230, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("boundaries",  { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("extraction",  { pipelines: [["contract-test", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true], ["grade-plan", "on completion", false]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    {
      id: "combine-services", name: "Combine microservices", desc: "Merge services back into fewer (or a monolith)",
      origin: "built-in", icon: "⧈", h: 260, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",         { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("consolidation", { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("testing",       { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",     { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions",   { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    {
      id: "migrate", name: "Migrate stack", desc: "Move framework / language / protocol with an incremental cutover",
      origin: "built-in", icon: "⇄", h: 195, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("migration",   { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("testing",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    {
      id: "harden", name: "Harden security", desc: "Threat-model, audit, and fix security gaps in place",
      origin: "built-in", icon: "⛨", h: 25, category: "harden", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos",       { pipelines: [["index-repos", "on section enter", true]] }),
        mkSection("hardening",   { pipelines: [["grade-rubric", "on completion", false]] }),
        mkSection("testing",     { pipelines: [["lint-plan", "on completion", true]] }),
        mkSection("structure",   { pipelines: [["generate-issues", "on completion", true]] }),
        mkSection("permissions", { pipelines: [["scope-streams", "on completion", true]] }),
      ],
    },
    // ── data blueprints (#782/#783): acquire data into a canonical Data Model ──
    {
      id: "data-migration", name: "Data migration", desc: "Move data from an existing system into a canonical Data Model",
      origin: "built-in", icon: "⇲", h: 280, category: "data", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("dataSource"),
        mkSection("dataModel"),
        mkSection("dataMap"),
        mkSection("dataClean"),
        mkSection("dataLoad"),
      ],
    },
    {
      id: "data-collection", name: "Data collection", desc: "Scrape the web or fetch datasets into a canonical Data Model",
      origin: "built-in", icon: "⇱", h: 300, category: "data", mode: "create",
      sections: [
        mkSection("context"),
        mkSection("collectTargets"),
        mkSection("dataModel"),
        mkSection("sourceLicensing"),
        mkSection("dataAcquire"),
        mkSection("dataExtract"),
        mkSection("dataClean"),
        mkSection("dataLoad"),
      ],
    },
  ];
}

export interface SectionStatus { locked: boolean; unmet: string[]; satisfied: boolean }

/**
 * Dependency / lock resolution. A section is LOCKED when it's enabled but a
 * dependency is off or itself locked. A dep this blueprint omits is treated as met.
 */
export function computeStatus(sections: BlueprintSection[]): Record<string, SectionStatus> {
  const byKey: Record<string, BlueprintSection> = Object.fromEntries(sections.map((s) => [s.key, s]));
  const memo: Record<string, boolean> = {};
  function satisfied(key: string, stack: Set<string>): boolean {
    if (key in memo) return memo[key];
    const s = byKey[key];
    if (!s) return true;
    if (!s.enabled) return (memo[key] = false);
    if (stack.has(key)) return true; // cycle guard
    stack.add(key);
    const ok = (s.deps || []).every((d) => satisfied(d, stack));
    stack.delete(key);
    return (memo[key] = ok);
  }
  const out: Record<string, SectionStatus> = {};
  for (const s of sections) {
    const present = (s.deps || []).filter((d) => byKey[d]);
    const unmet = present.filter((d) => !byKey[d].enabled || !satisfied(d, new Set()));
    out[s.key] = { locked: s.enabled && unmet.length > 0, unmet, satisfied: satisfied(s.key, new Set()) };
  }
  return out;
}

/** Move `fromUid` before/after `toUid` in a uid-keyed list (drag-reorder). */
export function reorder<T extends { uid: string }>(arr: T[], fromUid: string, toUid: string, before: boolean): T[] {
  const a = [...arr];
  const fi = a.findIndex((x) => x.uid === fromUid);
  if (fi < 0) return arr;
  const [item] = a.splice(fi, 1);
  let ti = a.findIndex((x) => x.uid === toUid);
  if (ti < 0) { a.push(item); return a; }
  if (!before) ti += 1;
  a.splice(ti, 0, item);
  return a;
}

/** Deep-copy sections with fresh uids (for duplicate). */
export function cloneSections(sections: BlueprintSection[]): BlueprintSection[] {
  return sections.map((s) => ({ ...s, uid: uid("sec"), pipelines: s.pipelines.map((p) => ({ ...p, uid: uid("pl") })) }));
}

/**
 * Derive the per-project StageConfig (enabled + order over the registry's known
 * StageIds) that the planning N-bar reads, from a blueprint's sections. Custom and
 * non-registry sections (e.g. testing) are omitted — they configure planning but
 * don't have a registry gate yet.
 */
/**
 * What to record when a project's planning opens (#647). A brand-new project (no stage
 * config) seeds from + records the active blueprint. An existing project with NO recorded
 * blueprint (planned before blueprint tracking) backfills to the default — so selecting a
 * different blueprint still triggers the reset prompt instead of silently doing nothing.
 * Otherwise the project already knows its blueprint, so nothing changes here.
 */
export function resolveProjectSeed(
  hasConfig: boolean, recordedBlueprintId: string | undefined, activeBlueprintId: string,
): { seedConfig: boolean; setBlueprintId?: string } {
  if (!hasConfig) return { seedConfig: true, setBlueprintId: activeBlueprintId };
  if (!recordedBlueprintId) return { seedConfig: false, setBlueprintId: DEFAULT_BLUEPRINT_ID };
  return { seedConfig: false };
}

export function blueprintToStageConfig(bp: Blueprint): StageConfig {
  const known = new Set<string>(PLAN_STAGES.map((s) => s.id));
  const enabled = Object.fromEntries(PLAN_STAGES.map((s) => [s.id, false])) as Record<StageId, boolean>;
  const order: StageId[] = [];
  for (const s of bp.sections) {
    if (!known.has(s.key)) continue;
    const id = s.key as StageId;
    enabled[id] = s.enabled;
    order.push(id);
  }
  return { enabled, order };
}

// ── Blueprint-driven status (#…) ──────────────────────────────────────────────
// These evaluate a blueprint's sections DIRECTLY against the published signal bag —
// no PLAN_STAGES enum, no per-stage hardcoding. Each section carries its own
// declarative gate (`gateRule`), applicability (`appliesWhen`), and `deps`, so a
// built-in section and a cloud-distributed one are evaluated by the exact same code.
// The progress bar, readiness check, current-section, and the "what's incomplete"
// feedback all read from here.

/** Render status of a blueprint section. `na` = not applicable to this project. */
export type SectionRenderStatus = "locked" | "in-progress" | "complete" | "na";

/** The signal that marks an informational (gateless) section confirmed/complete (#664). */
export const confirmedSignal = (key: string) => `confirmed:${key}`;

/** Whether a section is done. A section WITH a declarative gate uses {@link evalGate}. A
 *  gateless ("informational") section is NOT vacuously complete — it's done only when the
 *  planner confirms it (a `confirmed:<key>` signal), so a fresh/cleared plan shows it as
 *  in-progress rather than ✓ (#664). */
export function sectionDone(section: BlueprintSection, signals: PlanSignals): { done: boolean; fraction: number } {
  if (section.gateRule) return evalGate(section.gateRule, signals);
  const ok = signals[confirmedSignal(section.key)] === true;
  return { done: ok, fraction: ok ? 1 : 0 };
}

/** A dependency is satisfied when the blueprint omits it, it's disabled, it's N/A, or
 *  its own gate is complete. Mirrors the registry's dep rule, but over blueprint data. */
function depSatisfied(depKey: string, byKey: Record<string, BlueprintSection>, signals: PlanSignals): boolean {
  const dep = byKey[depKey];
  if (!dep) return true;        // this blueprint doesn't include the dep
  if (!dep.enabled) return true;
  if (dep.optional) return true;        // optional deps never block dependents (#676)
  if (!gateApplies(dep.appliesWhen, signals)) return true;
  return sectionDone(dep, signals).done;
}

/**
 * Resolve a section's render status + bar fill from blueprint data alone: its
 * applicability rule, its declarative gate, and its (included, enabled) dependencies.
 */
export function sectionStatus(
  section: BlueprintSection,
  sections: BlueprintSection[],
  signals: PlanSignals,
): { status: SectionRenderStatus; fraction: number } {
  // An optional section is always shown (it bypasses appliesWhen) — it's just never
  // required; non-optional sections still go N/A when their applicability rule fails (#676).
  if (!section.optional && !gateApplies(section.appliesWhen, signals)) return { status: "na", fraction: 0 };
  const g = sectionDone(section, signals);
  if (g.done) return { status: "complete", fraction: 1 };
  const byKey: Record<string, BlueprintSection> = Object.fromEntries(sections.map((s) => [s.key, s]));
  const locked = (section.deps || []).some((d) => !depSatisfied(d, byKey, signals));
  return { status: locked ? "locked" : "in-progress", fraction: g.fraction };
}

/** The enabled sections of a blueprint, in their declared order. */
export function enabledSections(sections: BlueprintSection[]): BlueprintSection[] {
  return sections.filter((s) => s.enabled);
}

/** Whether every enabled, applicable section is complete — the triage readiness gate. */
export function planSectionsComplete(sections: BlueprintSection[], signals: PlanSignals): boolean {
  return enabledSections(sections).every((s) => {
    if (s.optional) return true;        // optional sections never block completion (#676)
    const { status } = sectionStatus(s, sections, signals);
    return status === "complete" || status === "na";
  });
}

/**
 * The current ("reached") section: the first enabled + applicable section that is
 * in progress. When all are complete it falls back to the last enabled + applicable
 * one. Drives which pipelines' second screens render.
 */
export function currentSection(sections: BlueprintSection[], signals: PlanSignals): BlueprintSection | undefined {
  // Optional sections are off the critical path — they never become the "current" stage,
  // so an unfinished optional section (e.g. UI) doesn't stall the flow (#676).
  const applicable = enabledSections(sections).filter((s) => !s.optional && gateApplies(s.appliesWhen, signals));
  const active = applicable.find((s) => sectionStatus(s, sections, signals).status === "in-progress");
  return active ?? applicable[applicable.length - 1];
}

/** A blueprint section that isn't satisfied yet — what the user still has to finish. */
export interface IncompleteSection {
  key: string;
  /** The section's display name, straight from the blueprint. */
  name: string;
  /** The section's own gate description (`gate`) — the human "what's left". */
  reason: string;
  /** Locked behind an unfinished dependency vs. simply in progress. */
  status: "locked" | "in-progress";
}

/**
 * Every enabled section that is not yet complete, in section order, each tagged with
 * its status and the section's own gate description as the reason. Fully blueprint-
 * driven — including unknown / cloud-distributed sections — so adding or reordering a
 * section flows through here with nothing hardcoded per stage. Powers the feedback
 * shown when the user clicks a locked Triage button.
 */
export function incompleteSections(sections: BlueprintSection[], signals: PlanSignals): IncompleteSection[] {
  const out: IncompleteSection[] = [];
  for (const s of enabledSections(sections)) {
    const { status } = sectionStatus(s, sections, signals);
    if (status === "complete" || status === "na") continue;
    out.push({ key: s.key, name: s.name, reason: s.gate, status });
  }
  return out;
}
