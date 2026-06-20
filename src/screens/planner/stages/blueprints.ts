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

// The blueprint-stage "pipeline" abstraction was removed in #897 Phase 4c: there was no
// production trigger engine, and the three surviving behaviors — render-preview, grade-plan,
// lint-plan — run by direct dispatch from their own modules. Capability now attaches to a
// blueprint as skills (#636) + MCP servers (#897); app-actions are the section `output`
// disposition + handlePublish.

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
  /** Attached MCP servers (#897) — server NAMES (the portable ref, matching the catalog +
   *  `<mcp_assign>`), scoped to the project at launch so the planner/fleet can call them.
   *  Kept SEPARATE from `skills`: MCP servers are tools (research/analysis/grading), skills are
   *  knowledge. Reference-by-name; an unresolved name surfaces a warning in the editor. */
  mcp?: string[];
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
      // lint-as-gate (#897 Phase 4b): no deliberate fill-in marker (TODO/FIXME/...) left behind (#918).
      { signal: "hasPlanGaps", target: false, weight: 0, label: "resolve TODO/FIXME markers in the written sections" },
    ] },
    blurb: "Discovery — goal, scope, stack, architecture (+ applicable dimensions).",
    prompt:
`Walk the discovery checklist one topic at a time, using the canonical key as each
file's stem. The gate REQUIRES these four written and confirmed: goal, scope, stack,
architecture. Cover other dimensions ONLY where they genuinely apply (canonical keys:
users, ux, schema, api, auth, security, testing, …) and record the rest in _skipped.md.
Each file you create is a gate item the user confirms — don't create tangential files.
Finish each section fully — do NOT leave TODO / TBD / FIXME / XXX / TKTK markers in a written
section; the gate blocks on them. (Ordinary prose like "..." or the word "placeholder" is fine.)

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
  // Deploy (#919): how each service SHIPS — defined right after Repos so the rest of the plan is
  // shaped knowing the deployment target. Its config is captured in the Deploy pane and lands as
  // deployment issues owned by a `deploy` stream at publish.
  deploy: {
    name: "Deploy", glyph: "⎈", gate: "target, envs, pipeline, secrets & release defined", deps: ["repos"],
    gateRule: { require: [{ signal: "deploymentDefined", target: true, label: "define target, environments, pipeline, secrets & release" }] },
    output: "issues",
    blurb: "How each service ships — target, environments, pipeline, secrets, release & health.",
    prompt:
`Define how this project SHIPS, per service (one per linked repo): the deploy TARGET (hosting
platform + workload — static / serverless / container / long-running), the ENVIRONMENT ladder
(dev → staging → prod, each mapped to a branch), the CI/CD PIPELINE (build → test → deploy, with
the gating stage), CONFIG + SECRETS per environment (names only — values live in the host vault),
the RELEASE strategy (recreate / rolling / blue-green / canary) + rollback policy, and HEALTH
checks / observability. Propose sensible defaults from the stack, then interrogate the user and
let them set the targets in the Deploy pane. These become deployment ISSUES owned by a \`deploy\`
stream at publish.

Gate: a target per service, ≥2 environments, a staged pipeline, secrets wired for every env, and
a release strategy chosen.`,
  },
  ui: {
    // UI runs AFTER Features (#825) so the screens are designed for the defined capabilities —
    // and so the stage can author a kickoff the user hands to Claude Design.
    name: "UI", glyph: "▣", gate: "design routed", deps: ["context", "features"],
    // applies only when the project needs a UI; complete when the design is routed to the
    // project (drop + Route) OR every screen preview is approved — `uiDone` combines both (#837).
    appliesWhen: { signal: "requiresUi", target: true },
    gateRule: { require: [{ signal: "uiDone", target: true, label: "route the design to the project" }] },
    blurb: "Screens, states, and primary flows — designed from the features.",
    prompt:
`With the features defined, design the UI that delivers them. Walk the features and, for each
screen a feature needs, capture its purpose, key states, and the components it needs from the
design system. Produce ui.md plus a screen inventory the Render preview pipeline can visualize.

Then author a **Claude Design kickoff** at \`prompts/ui-kickoff.md\` — a self-contained brief the
user can paste into a Claude Design session: the product goal, the feature → screen map, each
screen's states and flows, and the design-system constraints. This is the handoff that turns the
plan's features into visual designs.

Gate: every primary flow has its screens and states defined.`,
  },
  // Features (#…): the INTERACTIVE heart — define the user-facing capabilities, one at a time.
  // Each feature is a fleet stream. Claude proposes the COMPLETE set a production-grade solution
  // needs (#850 — not a truncated "starter" cut); the user curates + phases it, then drills into
  // each. Integration seams are NOT defined here — the Plan stage owns them.
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
Each capability becomes its own fleet stream. Propose the COMPLETE set a production-grade solution
to the goal needs — not a minimal cut — then let the user curate and phase it, and take each in turn.`,
    substeps: [
      { key: "propose", label: "Propose the feature set", gate: "the feature list is confirmed", prompt:
`From the goal, scope, and what you've discussed, propose the COMPLETE set of user-facing
capabilities a production-grade solution to this goal needs — aim for the best, most complete
product, not a minimal first-pass cut. (Completeness is about capabilities, not
phasing — the user sequences them into phases next; don't pre-trim to a phase-1 slice.) Write them
to features.json: a JSON array of \`{"slug","name"}\` objects (e.g.
\`{"slug":"invite-teammates","name":"Invite teammates"}\`). They appear in the Features board for the
user to curate — add, remove, merge, rename. Confirm the SET with the user before drilling into any
single feature.` },
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
      // lint-as-gate (#897 Phase 4b): no deliberate fill-in marker (TODO/FIXME/...) left behind (#918).
      { signal: "hasPlanGaps", target: false, weight: 0, label: "resolve TODO/FIXME markers in the written sections" },
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
of it as final. Leave no TODO / TBD / FIXME / XXX / TKTK markers in the written plan — the gate
blocks on them.

Also record the AGENT RELATIONSHIPS in fleet.json so the Structure pane renders them: each cross-
stream artifact a stream produces and others consume (\`artifacts\`: [{ "id", "name", "kind":
"schema"|"contract"|"types"|"tokens"|"fixture"|"other", "producer": <streamId>, "consumers":
[<streamId>], "status": "pending"|"ready" }]), and the typed \`edges\`: [{ "id", "from", "to",
"kind": "handoff"|"blocking"|"sequence"|"review"|"notify"|"mutex"|"shared", "artifact": <artifactId>,
"hardness": "blocking"|"soft"|"notify", "via": "director"|"direct", "note" }]. A handoff edge with an
artifact becomes the \`contract:<id>\` coordination latch the consumer blocks on. Keep the ordering
edges (handoff/blocking/sequence/review) ACYCLIC — a cycle is a deadlock and blocks the gate.

Gate: phases approved, every feature decomposed into agent-ready issues, and the relationship graph
has no dependency cycle.`,
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

Choose the coordination TOPOLOGY in fleet.json (\`topology\`): "director" (hub-and-spoke — every
relationship routes through the director), "peer" (mesh — agents hand off directly), or "hybrid"
(per-edge, using each edge's \`via\`). Set the director \`drive\` when one is enabled. The user can
flip this in the Permissions pane and the Structure relationship graph re-routes live.

Gate: every stream has a scoped profile and a role.`,
  },
  mcp: {
    name: "MCP Servers", glyph: "⊕", gate: "tools connected", deps: ["structure"],
    optional: true,
    blurb: "External tools + data the fleet's agents can call.",
    prompt:
`Connect the external tools and data sources the fleet's agents need via MCP servers.
Assign one with <mcp_assign name="…" />: a first-party server (Compliance, Complexity
Analyzer, Dependency Graph) downloads automatically — the user builds it once in the MCP
panel and it's scoped to every session this plan launches (the director AND every worker).
Assign only the servers the agents actually need.

Gate: the project's agents have the MCP servers they need (optional).`,
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
  // ── Blueprint-authoring lifecycle (#923) ───────────────────────────────────
  // The planner DESIGNS a reusable blueprint (the deliverable) and publishes it to a gist — no
  // code, so no fleet/triage. The evolving blueprint accumulates via the <blueprint> tag; these
  // stages' gates read signals derived from it (bpName / bpStageCount / bpValid in Planning.tsx).
  purpose: {
    name: "Purpose", glyph: "◆", gate: "identity-check", deps: [],
    gateRule: { require: [
      { signal: "bpName", target: true, weight: 0, label: "set a name, a one-line pitch, and at least one catalog tag" },
    ] },
    blurb: "Define what this blueprint is for, who it serves, and how it appears in the catalog.",
    prompt:
`You are designing a NEW, reusable BLUEPRINT — a planning template others seed projects from (NOT a
software project). Establish its PURPOSE: the lifecycle category (greenfield = create from a pitch,
transform = restructure existing repos, harden, maintain, data), the kind of project it should seed,
and its name + one-line description. Propose, interrogate with the user, then record it by emitting a
<blueprint> tag (see "App integration tags") carrying at least id, name, desc, category, mode.

Gate: the blueprint has a name and a lifecycle category.`,
  },
  bp_stages: {
    name: "Stages", glyph: "❑", gate: "flow-check", deps: ["purpose"],
    gateRule: { require: [
      { signal: "bpStagesReady", target: true, label: "compose ≥2 stages, each with a prompt module" },
    ] },
    blurb: "Compose the stage flow — order, dependencies, and the prompt module each stage runs.",
    prompt:
`Design the STAGES the authored blueprint will drive, one at a time (propose → interrogate → record).
For each stage define: a short key + name, its intent (blurb), the discovery PROMPT the planner runs
when that stage is active, its order + dependencies on earlier stages, and whether it's optional.
Give each a simple completion gate — default to "the planner confirms this stage is done" unless a
concrete signal is obvious. Re-emit the FULL <blueprint> tag (with the growing sections array) as the
stage set firms up.

Gate: at least one stage is designed, each confirmed with the user.`,
  },
  bp_capabilities: {
    name: "Capabilities", glyph: "✦", gate: "skills + MCP wired", deps: ["bp_stages"], optional: true,
    blurb: "Wire each stage's output disposition, attached skills/knowledge, and MCP servers.",
    prompt:
`OPTIONAL. Decide the reusable SKILLS / knowledge and MCP servers this blueprint should attach so every
project seeded from it inherits them. Attach them blueprint-wide or to a specific stage and fold them
into the <blueprint> tag (a section's skills/mcp arrays, or the blueprint-level skills/mcp). Skip this
stage if the blueprint needs no bundled capabilities.

Gate: the applicable skills + MCP servers are attached (optional).`,
  },
  bp_review: {
    name: "Review & publish", glyph: "⎙", gate: "lint", deps: ["bp_stages"],
    gateRule: { require: [
      { signal: "bpValid", target: true, label: "all validation checks pass" },
    ] },
    blurb: "Validate the blueprint, choose its visibility, and publish it to the catalog.",
    prompt:
`Review the assembled blueprint with the user: purpose, every stage (intent, prompt, gate, deps,
optional), and attached capabilities. Emit the FINAL, complete <blueprint> tag. When the user
approves, THEY publish it to a gist from the footer — you do not publish it yourself.

Gate: the assembled blueprint is complete and valid.`,
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
  // Informational (no gateRule) — the planner's findings + review drive it.
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

  // Greenfield source section — distinct from the standalone `dataSource` used in the
  // data-migration blueprint. This appears in the Default blueprint as an OPTIONAL,
  // skippable step (#676) for projects that have a migration component alongside new
  // features. The source-experience stream writes datamodel.json; this section reads its
  // signals (`modelInferred`, `schemaRefined`) for the gate.
  source: {
    name: "Source", glyph: "⇲", gate: "model inferred + schema confirmed", deps: ["context", "repos"],
    optional: true,
    blurb: "Migration source — inventory it, infer the data model, confirm the schema.",
    gateRule: { require: [
      { signal: "modelInferred", target: true, label: "data model inferred from source" },
      { signal: "schemaRefined", target: true, label: "schema reviewed and confirmed" },
    ] },
    prompt:
`Identify the migration source (database, SaaS export, or API) and inventory what exists
there: its objects/tables, their schemas, and a small representative sample of rows.
Then propose the canonical data model this project will load into — entities, fields with
types, and the identity key (the fields that decide when two records describe the same
real-world thing). Write the model to datamodel.json and set modelInferred to true.
Walk the proposed schema with the user and refine it; when confirmed, set schemaRefined
to true.

Gate: datamodel.json present with modelInferred and schemaRefined both true.`,
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
complete mapping spec; nothing is left ambiguous for the load stage.

Write \`dataMap.json\`: { "mapped": [{ "from": "Source.field", "to": "Entity.field", "auto":
true|false, "note" }], "droppedSource": [{ "field", "why" }], "unmappedModel": [{ "field", "why" }] }.
The Mapping pane renders the bindings, the dropped source fields, and the net-new model fields.`,
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
user before checking legitimacy.

Write \`collectTargets.json\`: { "sources": [{ "id", "mode": "scrape"|"fetch", "label", "loc",
"type", "feeds": [entity names], "scope": { "start", "pattern", "bound" } }], "dataModel": {
"name", "entities": [{ "name", "fields": [field names] }] } }. The Targets pane renders it.`,
  },
  sourceLicensing: {
    name: "Source legitimacy", glyph: "⚖", gate: "every source cleared for use", deps: ["collectTargets"],
    blurb: "ToS / robots / license clearance — blocks acquisition.",
    prompt:
`Before acquiring anything, clear each source for the intended use: site Terms of Service and
robots.txt for scraping, and the license for any dataset (can it be used commercially? does it
require attribution?). Record a per-source verdict — cleared / restricted / blocked — with the
reason. A source that isn't cleared must NOT be acquired. Surface anything ambiguous to the user.

Write \`sourceLicensing.json\`: { "sources": [{ "id", "mode", "label", "loc" }], "clearance": {
"<id>": { "status": "cleared"|"needs review"|"blocked", "reason", "robots": { "delay", "rules":
[{ "path", "allow": true|false }] }, "terms": { "kind", "text", "attribution", "license" } } },
"intendedUse" }. The Source-legitimacy pane renders it; a "blocked" source hard-stops Acquire.`,
  },
  dataAcquire: {
    name: "Acquire", glyph: "⤓", gate: "raw artifacts captured", deps: ["sourceLicensing"],
    blurb: "Scrape (rate-limited, robots-aware) or fetch the raw data.",
    prompt:
`Design the acquisition for each cleared source. SCRAPE mode: a crawl that respects robots.txt and
rate limits, with retry/backoff, capturing raw HTML/responses. FETCH mode: download the file or
page the API, capturing the raw artifacts. Record provenance for every artifact (source, when,
under which license) — this seeds the lineage the load stage records.

Write \`dataAcquire.json\`: { "sources": [{ "id", "mode": "scrape"|"fetch", "label", "status":
"ready"|"running"|"not run", "estimate", "captured", scrape→ "crawl": { "start": [urls], "depth",
"include", "exclude" }, "rate": { "rps", "concurrency", "delay" }, "options": { "jsRender" }, fetch→
"endpoint", "auth", "paging": { "kind", "pageSize" }, "format", "schedule" }] }. The Acquire pane
renders it (and a live progress bar from an optional per-source "run": { "note", "done", "total" }).`,
  },
  dataExtract: {
    name: "Extract", glyph: "⛏", gate: "structured rows produced", deps: ["dataAcquire"],
    blurb: "Parse raw artifacts into structured rows.",
    prompt:
`Turn the raw artifacts into structured rows: parse HTML/DOM, or ingest the fetched CSV/JSON/Parquet.
Define the parse rules and the row shape produced, keeping each row tied to its provenance. The
output is structured-but-uncleaned rows for the shared cleaning stage.

Write \`dataExtract.json\`: { "sources": [{ "id", "mode", "label", "kind": "HTML"|"JSON", "artifact",
"rules": [{ "sel", "field": "Entity.field", "entity", "ref", "ok": true|false }] }], "gaps": {
"unmappedModel": [{ "field", "why" }], "unmappedSource": [{ "sel", "why" }] }, "sample": { "cols":
[..], "rows": [{..}] }, "coverage": { "parsed", "total", "pct", "gaps": [{ "field", "why" }] } }.
The Extract pane renders the rules, gaps, a sample preview, and coverage.`,
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
bar higher for collection.

Write \`dataClean.json\`: { "qualityBar": <percent>, "rules": [{ "field", "rule", "kind":
"coerce"|"standardize"|"validate", "note" }], "validationPct": <percent>, "quarantine": { "count",
"policy" } }. The Cleaning pane renders the bar, the rules by kind, and the quarantine policy.`,
  },
  dataLoad: {
    name: "Load & reconcile", glyph: "⤧", gate: "load verified + lineage complete", deps: ["dataClean"],
    blurb: "Director merges into the Data Model by identity key, with lineage.",
    prompt:
`Plan the load + reconciliation the DIRECTOR runs. When several sources feed the same entity,
records are MERGED by the entity's identity key; conflicts resolve by a declared source-PRECEDENCE
rule (state it). Every loaded value records LINEAGE — which source, when, under what license — so
the result is auditable. Define the verification that confirms the load matched expectations before
it's treated as done.

Write \`dataLoad.json\`: { "total", "entities", "lineage": <pct>, "validation": <pct>, "conflicts",
"precedence": [source ids, highest first], "per": [{ "entity", "rows", "nulls", "valid", "src":
[ids], "merged", "conflict", "note" }], "artifacts": [{ "name", "detail", "glyph" }], "issues":
[{ "t", "tag" }] }. The Load pane renders the headline totals, per-entity merge, artifacts & issues.`,
  },
};

export interface BlueprintSection extends SectionDef {
  uid: string;
  key: string;
  enabled: boolean;
  expanded: boolean;
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
  /** The upstream gist's `updated_at` recorded at import/sync. Compared against the gist's CURRENT
   *  `updated_at` on the import-from-gist page to detect an available update (#955). */
  updatedAt?: string;
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
  /** Blueprint-wide attached MCP servers (#897) — applied across every stage, in addition to
   *  each section's own `mcp`. Server NAMES (the portable ref). */
  mcp?: string[];
  /** Lifecycle intent (#645). Absent ⇒ greenfield (the create-a-project default). */
  category?: BlueprintCategory;
  /** Create (from a pitch) vs operate (against existing repos). Absent ⇒ create. */
  mode?: BlueprintMode;
  /** Authoring metadata (#923, blueprint-author design): a one-line catalog pitch, the audience it
   *  serves, and the publish visibility. `tags` doubles as the design's "best for" catalog tags. */
  pitch?: string;
  audience?: string;
  visibility?: "local" | "private-gist" | "catalog";
  /** Deliverable / output lifecycle (#923). Absent ⇒ the normal software deliverable: the planner
   *  publishes repos + a project board + milestones + issues, then a fleet builds them. `"blueprint"`
   *  marks an AUTHORING lifecycle — the planner designs a reusable blueprint and "publish" ships it
   *  to a gist; there is no code, so no fleet and no triage (see `isAuthoringBlueprint`). */
  deliverable?: "blueprint";
}

/** The built-in blueprint-author lifecycle's id (#923). */
export const AUTHORING_BLUEPRINT_ID = "blueprint-author";

/** Whether a blueprint's deliverable is a blueprint itself (#923) — the authoring lifecycle:
 *  publish → gist, and no fleet / triage. */
export function isAuthoringBlueprint(bp: Blueprint | undefined): boolean {
  return bp?.deliverable === "blueprint";
}

/** The lifecycle categories a GREENFIELD project may switch INTO (#923) — the natural progression
 *  once it's been built: restructure (transform), secure in place (harden), or move into ongoing
 *  maintenance (maintain). */
export const GREENFIELD_SWITCH_TARGETS: BlueprintCategory[] = ["transform", "harden", "maintain"];

/** Whether a project bound to this blueprint may switch to a different one AT ALL (#923) — only a
 *  GREENFIELD project can (it can move on to a transform/harden lifecycle once built). Every other
 *  lifecycle — transform, harden, maintain, data, and the locked blueprint-author — stays put.
 *  Drives whether a "switch blueprint" affordance is offered. */
export function canChangeBlueprint(bp: Blueprint | undefined): boolean {
  return !!bp && !isAuthoringBlueprint(bp) && blueprintCategory(bp) === "greenfield";
}

/** Whether a project currently on `from` may switch to a `to` blueprint (#923). Only greenfield →
 *  transform | harden | maintain is allowed; everything else (other origins, other targets, anything
 *  touching the locked blueprint-author lifecycle) is refused. This is the authoritative switch gate. */
export function canSwitchBlueprint(from: Blueprint | undefined, to: Blueprint | undefined): boolean {
  if (!from || !to) return false;
  if (isAuthoringBlueprint(from) || isAuthoringBlueprint(to)) return false;
  return blueprintCategory(from) === "greenfield" && GREENFIELD_SWITCH_TARGETS.includes(blueprintCategory(to));
}

/** The gate signals the blueprint-authoring stages read, derived from the in-progress blueprint the
 *  planner is designing (#923, gates per the blueprint-author design):
 *  - `bpName` — Purpose gate: name + pitch + ≥1 catalog tag.
 *  - `bpStageCount` — how many stages (display).
 *  - `bpStagesReady` — Stages gate: ≥2 stages, each with a prompt module written.
 *  - `bpValid` — Review gate: every publish check passes (identity + stages + prompts).
 *  Pure; mirrors the design's validation without importing the editor. */
export function authoringSignals(bp: Blueprint | undefined): Record<string, number | boolean> {
  const sections = bp?.sections ?? [];
  const hasName = !!bp?.name?.trim();
  const hasPitch = !!bp?.pitch?.trim();
  const hasTag = (bp?.tags?.length ?? 0) > 0;
  const enoughStages = sections.length >= 2;
  const everyPrompt = sections.length > 0 && sections.every((s) => !!s.prompt?.trim());
  return {
    bpName: hasName && hasPitch && hasTag,
    bpStageCount: sections.length,
    bpStagesReady: enoughStages && everyPrompt,
    bpValid: hasName && hasPitch && hasTag && enoughStages && everyPrompt,
  };
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
  { enabled = true, expanded = false, optional }:
    { enabled?: boolean; expanded?: boolean; optional?: boolean } = {},
): BlueprintSection {
  const def = SECTION_DEFS[key];
  return {
    uid: uid("sec"), key, ...def, enabled, expanded,
    // explicit `optional` overrides the def's; otherwise inherit it
    optional: optional ?? def.optional,
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
  // Drop persisted built-ins that no longer exist in code (removed templates), refresh the rest by
  // id, and leave user-created / forked / imported blueprints untouched (#923 cleanup).
  const merged = persisted
    .filter((b) => b.origin !== "built-in" || byId.has(b.id))
    .map((b) => (b.origin === "built-in" && byId.has(b.id) ? byId.get(b.id)! : b));
  for (const b of fresh) if (!merged.some((x) => x.id === b.id)) merged.push(b);
  return merged;
}

export function makeBlueprints(): Blueprint[] {
  return [
    {
      id: "default", name: "Default", desc: "Balanced starting point", origin: "built-in", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"),
        mkSection("repos"),
        // Deploy right after repos (#919): decide how each service ships before shaping the rest.
        mkSection("deploy"),
        // Optional migration source step (#pp-section): skippable for projects with no migration
        // component; never blocks the rest of the plan. Signals read from datamodel.json.
        mkSection("source",      { optional: true }),
        // Features before UI (#825): design the screens from the defined capabilities + author the Claude Design kickoff.
        mkSection("features"),
        mkSection("ui",          { optional: true }),
        mkSection("structure"),
        mkSection("permissions"),
        mkSection("mcp",         { optional: true }),
        mkSection("automations", { optional: true }),
        mkSection("skills",      { optional: true }),
      ],
    },
    {
      id: "mcp-server", name: "MCP server", desc: "Headless Model Context Protocol server — tools/resources, no UI",
      origin: "built-in", icon: "⚇", category: "greenfield", mode: "create",
      sections: [
        mkSection("context"), mkSection("repos"),
        // No UI stage: an MCP server is headless (tools/resources over stdio/HTTP), so the plan
        // goes straight from features to structure (#825).
        mkSection("features"),
        mkSection("structure"),
        mkSection("testing"), mkSection("permissions"),
        mkSection("automations"), mkSection("skills"),
      ],
    },
    {
      id: "refactor", name: "Refactor & Cleanup", desc: "Clean up an existing codebase — find dead/legacy code & refactor",
      origin: "built-in", icon: "♻", h: 25, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos"),
        mkSection("cleanup"),
        mkSection("testing"),
        // No `structure` stage: a refactor pass tracks work as cleanup/refactor units that
        // drive the fleet directly — it doesn't need a GitHub issues.json (#666).
        mkSection("permissions"),
      ],
    },
    // ── transform blueprints (#645 slice 2): operate on existing repos ──
    {
      id: "split-services", name: "Split into microservices", desc: "Carve a monolith into services along its seams",
      origin: "built-in", icon: "⧉", h: 230, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos"),
        mkSection("boundaries"),
        mkSection("extraction"),
        mkSection("structure"),
        mkSection("permissions"),
      ],
    },
    {
      id: "combine-services", name: "Combine microservices", desc: "Merge services back into fewer (or a monolith)",
      origin: "built-in", icon: "⧈", h: 260, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos"),
        mkSection("consolidation"),
        mkSection("testing"),
        mkSection("structure"),
        mkSection("permissions"),
      ],
    },
    {
      id: "migrate", name: "Migrate stack", desc: "Move framework / language / protocol with an incremental cutover",
      origin: "built-in", icon: "⇄", h: 195, category: "transform", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos"),
        mkSection("migration"),
        mkSection("testing"),
        mkSection("structure"),
        mkSection("permissions"),
      ],
    },
    {
      id: "harden", name: "Harden security", desc: "Threat-model, audit, and fix security gaps in place",
      origin: "built-in", icon: "⛨", h: 25, category: "harden", mode: "operate",
      sections: [
        mkSection("context"),
        mkSection("repos"),
        mkSection("hardening"),
        mkSection("testing"),
        mkSection("structure"),
        mkSection("permissions"),
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
    // ── meta: author a reusable blueprint, publish to a gist (#923) ──
    {
      id: AUTHORING_BLUEPRINT_ID, name: "Blueprint Author",
      desc: "Design a reusable blueprint and publish it to a gist",
      origin: "built-in", icon: "⎙", h: 160, category: "greenfield", mode: "create",
      deliverable: "blueprint",
      sections: [
        mkSection("purpose"),
        mkSection("bp_stages"),
        mkSection("bp_capabilities", { optional: true }),
        mkSection("bp_review"),
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
  return sections.map((s) => ({ ...s, uid: uid("sec") }));
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

/** The signal that marks an OPTIONAL section the user deliberately SKIPPED (#921). A skipped
 *  section counts as resolved — the flow advances past it and it never blocks completion — but
 *  it renders distinctly ("skipped", not "complete"). */
export const skippedSignal = (key: string) => `skipped:${key}`;

/** Whether a section is done/resolved. A user-SKIPPED section (#921) is resolved regardless of
 *  its gate. Otherwise: a section WITH a declarative gate uses {@link evalGate}; a gateless
 *  ("informational") section is done only when confirmed (a `confirmed:<key>` signal), so a
 *  fresh/cleared plan shows it as in-progress rather than ✓ (#664). */
export function sectionDone(section: BlueprintSection, signals: PlanSignals): { done: boolean; fraction: number } {
  if (signals[skippedSignal(section.key)] === true) return { done: true, fraction: 1 };
  if (section.gateRule) return evalGate(section.gateRule, signals);
  const ok = signals[confirmedSignal(section.key)] === true;
  return { done: ok, fraction: ok ? 1 : 0 };
}

/** Whether a section was resolved by a deliberate user SKIP (vs genuinely completed) — drives the
 *  distinct "skipped" rendering. (#921) */
export function sectionSkipped(section: BlueprintSection, signals: PlanSignals): boolean {
  return signals[skippedSignal(section.key)] === true;
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

/** Whether every enabled, applicable section is resolved — the triage readiness gate. An OPTIONAL
 *  section must be DECIDED (completed or user-skipped) just like a required one; a user-skip marks
 *  it done (#921). This is what lets the user, not the app, decide whether to skip an optional
 *  stage — the plan isn't "complete" until each enabled optional stage has been addressed. */
export function planSectionsComplete(sections: BlueprintSection[], signals: PlanSignals): boolean {
  return enabledSections(sections).every((s) => {
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
  // The flow STOPS on an optional stage too, so the USER decides whether to do or skip it (#921) —
  // a skipped optional section is `sectionDone` ⇒ not "in-progress", so the frontier advances past
  // it. Optional sections bypass `appliesWhen` (always shown), matching `sectionStatus`.
  const applicable = enabledSections(sections).filter((s) => s.optional || gateApplies(s.appliesWhen, signals));
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
