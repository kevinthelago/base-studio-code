// Blueprint model TYPES (#513/#514, split out #2148): the pure type surface behind the
// Blueprints page — the substeps, the section/stage defs, the Blueprint shape, and the
// status result types. No runtime data or logic; the built-in library lives in
// blueprintBuiltins.ts and the pure helpers in blueprintStages.ts (both re-exported by
// the ./blueprints barrel).

import { type ClassificationSignals } from "./classification";
import { type StageGate, type Requirement } from "./stageGate";
import { type AgentFlow } from "../fleet/agentFlow";
// Type-only cross-feature import (allowed by the #1545 boundary): the blueprint team (#2450)
// reuses the org feature's graph shape rather than redeclaring it.
import type { Position, Relationship } from "@/features/org";

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

// ── Dynamic-blueprint additions (#1854 Phase a) ──────────────────────────────
// The first slice of the dynamic-blueprints epic: a stage can adapt its prompt to the DRIVING
// MODEL and can carry ARCHETYPE SEED CONTENT. Both are optional and additive — a stage without
// them behaves exactly as before (its single `prompt`, no seed).

/** A model CAPABILITY tier — the axis model-variant prompts key on (#1854 Phase a). Deliberately
 *  keyed by *capability*, not by a vendor model id, because blueprints are WAN-distributable and
 *  must not couple to a specific model/provider (they run on any {@link LlmProvider} via the
 *  bsc-agent "run on any model" track, #1078):
 *   - `frontier` — top frontier models (Claude Opus/Sonnet, GPT-4-class). The default open-ended
 *     prompt (the base `prompt`) is already written for this tier, so an explicit variant is only
 *     needed to override it.
 *   - `standard` — mid-capability hosted models (Haiku-class, smaller hosted models).
 *   - `local`    — weak local models. The headline payoff: a tight, schema-shaped, more-explicit
 *     directive prompt that lets a weak model plan reliably.
 *  A tier with no variant defined falls back to the base `prompt` (see {@link resolveStagePrompt}). */
export type ModelCapabilityTier = "frontier" | "standard" | "local";

/** Archetype seed content for a stage (#1854 Phase a) — starter content the stage can offer when it
 *  opens (e.g. a "twitter clone" archetype → a starter feature set for the Features stage). Additive:
 *  a stage with no `seed` behaves as today. Seeds; the planner + user still shape the final artifact. */
export interface StageSeed {
  /** The archetype this seed represents (a descriptive slug, e.g. "twitter-clone"). */
  archetype?: string;
  /** The starter content, as markdown — offered as an injectable option when the stage is active. */
  content: string;
}

// ── Sections (the canonical planning stages) ─────────────────────────────────

/** One discovery-checklist dimension. The editor-presentation fields (`icon`/`hue`/`blurb`)
 *  are present only for the dimensions that double as add-stage palette kinds (#1603); plain
 *  checklist dimensions carry just `key` + `title`. */
export interface DimensionMeta {
  key: string;
  title: string;
  /** Material/Lucide icon name (the editor `<Ic>` glyph). */
  icon?: string;
  /** Accent hue (oklch) for the palette card. */
  hue?: number;
  blurb?: string;
}

export interface SectionDef {
  name: string;
  /** Unicode symbol rendered as text in the focused-pane stepper (`focusedPlan.ts`). */
  glyph: string;
  /** Material/Lucide icon name for the editor/bar `<Ic>` component (#1603 — the editor
   *  presentation metadata, single-sourced here from the stage's own JSON). */
  icon: string;
  /** Accent hue (oklch) for the stage's editor/palette card (#1603). */
  hue: number;
  /** Human-readable gate description, shown in the editor and the readiness feedback. */
  gate: string;
  deps: string[];
  blurb: string;
  prompt: string;
  /** Model-variant prompts (#1854 Phase a) — per {@link ModelCapabilityTier} overrides of `prompt`,
   *  so a stage adapts its instructions to the DRIVING model (a tight, schema-shaped prompt for a
   *  weak `local` model alongside the open-ended default). Absent tier ⇒ the base `prompt` is used
   *  (resolved via {@link resolveStagePrompt}); the whole field absent ⇒ today's single-prompt
   *  behavior. Reference-by-tier; unknown tiers are simply ignored. */
  promptVariants?: Partial<Record<ModelCapabilityTier, string>>;
  /** Archetype seed content (#1854 Phase a) — starter content this stage offers when active (e.g. a
   *  starter feature set for a known archetype). Absent ⇒ no seed (today's behavior). */
  seed?: StageSeed;
  /** UI stage only (#604): the self-contained instruction the file-intake "Route" action injects
   *  into the planner to read the staged design files and route each to the right repo. Carried as
   *  stage DATA (like `prompt`) so it isn't hardcoded in the frontend. Absent ⇒ no route prompt. */
  routePrompt?: string;
  /** Declarative completion gate (#…) — the DATA that decides this section's
   *  done-ness. Carried on every section instance so a section is fully serializable
   *  and distributable; the app evaluates it via {@link evalGate}. Absent ⇒ the
   *  section is informational (vacuously complete). */
  gateRule?: StageGate;
  /** Optional applicability rule (e.g. UI only when the project needs a UI). Absent ⇒
   *  the section always applies. */
  appliesWhen?: Requirement;
  /** An OPTIONAL section is shown but never required: it doesn't block plan completion or
   *  downstream dependents, and it's off the critical path (currentStage skips it) — the
   *  user can fill it or skip it (#676). */
  optional?: boolean;
  /** Context stage only (#1019): the baseline REQUIRED topics this section seeds into the project's
   *  dynamic context manifest (plan.db) when first adopted. The planner then adjusts the set with
   *  `bsc-plan context require/unrequire`. Absent ⇒ the universal {@link DISCOVERY_BASELINE}. */
  requires?: string[];
  /** Discovery stage only (#1603): the checklist dimensions, carried as data so the editor's
   *  add-stage palette + the dimension vocabulary (`KNOWN_DIMENSIONS`) single-source from here. */
  dimensions?: DimensionMeta[];
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
  /** The planner-facing directive prose (#1462) — the single source of truth, shared byte-for-byte
   *  with the Rust `stage_directive`, read from this stage's `prompts/stages/<id>.json`. Only the
   *  duplicated stages carry one; stages without it use the generic Rust fallback. */
  directive?: string;
  /** Reserved (populated by #1395) — the classification signals that gate this stage's applicability,
   *  and its ordering tier. Typed now so #1395 fills them without re-churning files; unset today. */
  signals?: ClassificationSignals;
  phase?: "discover" | "decide" | "generate";
}

export interface BlueprintStage extends SectionDef {
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
export type BlueprintCategory = "greenfield" | "transform" | "harden" | "maintain" | "data" | "script";

/** Whether a blueprint starts from a pitch (create) or runs against existing repos
 *  (operate) — selects the planner intro at launch. */
export type BlueprintMode = "create" | "operate";

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

/** Fleet POLICY a blueprint declares (#1854 Phase b) — the default per-stream {@link AgentProfile}
 *  and {@link AgentFlow} the planner instantiates when it generates this project type's fleet. A
 *  COMPOSED typed sub-model (epic discipline #1: not N flat top-level fields), carrying only the
 *  *recipe/policy* — the DEFAULTS — while the concrete per-stream config stays planner-GENERATED
 *  per-project (discipline #2: static template vs generation policy). Resolution precedence is
 *  stream-declared → this policy → the hard launch-time default (see `resolveStreamProfile` /
 *  `resolveStreamFlow` in `../fleet/fleetPolicy`). Both fields optional ⇒ when unset, today's
 *  launch-time defaults apply, byte-for-byte.
 *
 *  Trust boundary (discipline #3): a blueprint only *seeds* the launch default here — the role
 *  gate (#219) still caps the session. The request-vs-cap permission POSTURE is Phase (c), out of
 *  scope for this sub-model. */
export interface FleetPolicy {
  /** Default {@link AgentProfile} id for a WORKER stream that doesn't pin its own `profile` (#289).
   *  A reference-by-id; an unknown id just falls through to the role default at launch. Applies to
   *  worker streams only — never the director, which keeps its role's read-only review profile. */
  profile?: string;
  /** Default {@link AgentFlow} (autonomy + push + trigger + gate) for a stream that doesn't declare
   *  its own `flow` (#297). Absent ⇒ the launch path applies {@link DEFAULT_FLOW}. */
  flow?: AgentFlow;
}

/** The TEAM a blueprint carries (#2450) — an embedded org configuration: positions (personas
 *  referenced by id — personas stay a global library) wired by relationships, with the canvas
 *  layout coords on each position. The same graph shape the `bsc org` store holds, MINUS the
 *  library identity fields (`id`/`name`/`blurb`/`builtin`) — the blueprint itself is the identity.
 *
 *  FORK-ON-ATTACH: authoring starts by DEEP-COPYING a library org (or blank) into
 *  `blueprint.team` (see `forkTeamFromOrg`); the `bsc org` store remains the archetype library.
 *  Editing a blueprint's team never mutates the library org and vice versa — reproducibility of
 *  the blueprint artifact wins. Persisted inside the blueprint's JSON (the `bsc blueprint` store
 *  is verbatim JSON), so export/import carries it automatically. Optional — a blueprint without
 *  `team` behaves exactly as before; plan-time consumption (seeding fleet streams from the team)
 *  is a deliberate follow-up, not this field's contract. */
export interface BlueprintTeam {
  positions: Position[];
  relationships: Relationship[];
}

/** The UI KIT a blueprint pins (#2465) — a LOCKFILE entry, deliberately the opposite of `team`:
 *  the kit is REFERENCED, never embedded, because kits are immutable versioned artifacts shared
 *  across blueprints (one copy in the global store, `~/.base-studio-code/kits/<id>/<version>/`,
 *  no matter how many blueprints pin it). Exact pins only — no version ranges (reproducibility).
 *
 *  `hash` is the sha256 (lowercase hex) of the kit artifact's bytes, verified BEFORE a fetched
 *  kit is accepted into the store (resolve flow, `uiKitPin.ts`); `source` is the typed-gist URL
 *  to fetch from when `id@version` isn't in the local store yet. A new blueprint default-pins the
 *  packaged `bsc/react-ui` kit ({@link Blueprint.uiKit} set in `addBlueprint`); a blueprint
 *  without a pin behaves exactly as before. */
export interface BlueprintUiKit {
  /** Publisher-scoped kit id (e.g. `"bsc/react-ui"`). */
  id: string;
  /** Exact semver of the pinned artifact (immutable once published). */
  version: string;
  /** sha256 (lowercase hex) of the artifact bytes. */
  hash: string;
  /** Typed-gist URL to fetch from when the id@version is missing locally. */
  source?: string;
  /** The kit THEME paired with the pin (#2489) — a `bsc ui theme` id. Absent ⇒ `"default"`. An ID,
   *  never the vars: the theme resolves through `bsc ui theme get` at EMISSION time
   *  (`bsc ui emit-css --theme <id>` → the generated app's tokens.css + theme.css), so
   *  designer-authored themes apply the moment they exist. This is the blueprint-level default;
   *  the planned application's actual pair is recorded per project in plan.db (`bsc plan ui`). */
  themeId?: string;
}

export interface Blueprint {
  id: string;
  name: string;
  desc: string;
  sections: BlueprintStage[];
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
  /** The component KIT (#2277) an app seeded from this blueprint is built on — a `bsc ui` kit id
   *  (e.g. `"react-ui"`). Recording it makes every project seeded here a CONSUMER of that kit, so a kit
   *  change fans out to it (the `kit_usage` consumer index self-fills at planning). Absent ⇒ the blueprint
   *  isn't tied to a shared kit (an authoring blueprint, or one that operates on a repo's own UI). */
  kit?: string;
  /** Fleet policy (#1854 Phase b) — the DEFAULT per-stream profile + flow the planner instantiates
   *  when it generates this project type's fleet. A composed sub-model; see {@link FleetPolicy}.
   *  Absent ⇒ today's launch-time defaults apply (byte-identical). */
  fleetPolicy?: FleetPolicy;
  /** The blueprint's own TEAM (#2450) — an embedded org configuration forked from the org library
   *  (or authored blank). A composed sub-model; see {@link BlueprintTeam}. Absent ⇒ no team
   *  authored (today's behavior, byte-identical everywhere). */
  team?: BlueprintTeam;
  /** The UI kit this blueprint pins (#2465) — a lockfile entry referencing an immutable
   *  `id@version` artifact in the global kit store; see {@link BlueprintUiKit}. Absent ⇒ no pin
   *  (existing blueprints are unaffected); a NEW blueprint default-pins the packaged kit. */
  uiKit?: BlueprintUiKit;
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

/** The JSON shape of a built-in blueprint definition (stages/blueprints/*.json): blueprint
 *  metadata + an ordered list of section KEYS (chaining to stages/sections/*.json). The keys
 *  resolve to full section instances via mkStage at load — no blueprint data lives in TS. */
export interface BlueprintDef extends Omit<Blueprint, "sections"> {
  /** Display order within the built-in library. */
  order?: number;
  /** Ordered section refs: a key into STAGE_DEFS + an optional per-blueprint `optional` flag. */
  sections: { key: string; optional?: boolean }[];
}

export interface SectionStatus { locked: boolean; unmet: string[]; satisfied: boolean }

/** Render status of a blueprint section. `na` = not applicable to this project. */
export type StageRenderStatus = "locked" | "in-progress" | "complete" | "na";

/** A blueprint section that isn't satisfied yet — what the user still has to finish. */
export interface IncompleteStage {
  key: string;
  /** The section's display name, straight from the blueprint. */
  name: string;
  /** The section's own gate description (`gate`) — the human "what's left". */
  reason: string;
  /** Locked behind an unfinished dependency vs. simply in progress. */
  status: "locked" | "in-progress";
}
