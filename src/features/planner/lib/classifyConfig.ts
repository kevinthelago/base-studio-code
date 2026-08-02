// Project classification (#3783/#3784) — the planner's discovery output that shapes the plan:
// which UI surface the `ui` stage renders, and which optional stages (source / mcp / skills) the
// project actually needs. Written by the planner during discovery via `bsc plan classify set`,
// polled into the store, and read by the UI-stage body + the stage-visibility signals.
//
// Every field is OPTIONAL: an unclassified project (the planner hasn't run `classify` yet) coerces
// to `{}`, and each read site applies its own non-regressing default (uiMode → "custom", the
// needs-flags → their stage's prior default). So adding classification never hides a pane that
// showed before the planner classified.

/** The two UI-stage surfaces (#3783). "custom" = the in-app designer preview (PreviewPaneShell —
 *  the navigable shell the designer commissions); "external" = the Claude-Design drop-files intake
 *  (FileIntakePane).
 *
 *  Only meaningful when {@link UiSystem} is "studio" — it says where the DESIGNS come from, not what
 *  renders them (#4115). */
export type UiMode = "custom" | "external";

/** WHO RENDERS this project's UI at runtime (#4115) — a separate axis from {@link UiMode}, because
 *  the two are orthogonal:
 *
 *  |  | designs generated in-app | designs brought by the user |
 *  |---|---|---|
 *  | **renders from our graph** | `studio` + `custom` | `studio` + `external` |
 *  | **project owns rendering** | `own` + `custom` | `own` + `external` |
 *
 *  - `studio` — our data-driven system: the component graph IS the render source, so the build/publish
 *    pipeline, the host API, and per-node analytics (#3809) all apply.
 *  - `own` — the project brings or keeps its own UI stack (Material UI, shadcn, an existing React
 *    codebase). None of the above applies to it.
 *
 *  `uiMode: "external"` is NOT this: it still means OUR pipeline ingests the user's design files and
 *  produces OUR shell. Without this axis the planner designs a graph-rendered shell for a project that
 *  will never render one, and the fleet is told to build against a contract the project does not use —
 *  the common case for an existing codebase (`lifecycle: "transform"`, already the default there). */
export type UiSystem = "studio" | "own";

/** The valid `UiSystem` tokens. Mirrored by `UI_SYSTEMS` in `crates/plandb/src/validate.rs`, which
 *  rejects an unknown token at `bsc plan classify set` — keep the two in lockstep or the planner can
 *  write a value the app cannot read. */
export const UI_SYSTEMS: UiSystem[] = ["studio", "own"];

/** The project's APPLICATION ARCHITECTURE (#3802/#3784) — what KIND of app it is, the axis the
 *  Projects list facets by AND the axis that selects which stages run (#3784). A flat taxonomy
 *  grounded in the deploy model (cloud `workload` + local `localKind`): a general application, a
 *  desktop/mobile app, a backend API, serverless functions, a static site, a CLI tool, a published
 *  library, or an MCP server. Unset ⇒ read as "application". */
export type AppType =
  | "application" | "desktop" | "mobile" | "api" | "serverless" | "static" | "cli" | "library" | "mcp-server";

/** The valid `AppType` tokens, for the coerce below + facet iteration. */
export const APP_TYPES: AppType[] = ["application", "api", "serverless", "static", "desktop", "mobile", "cli", "library", "mcp-server"];

/** The project's LIFECYCLE INTENT (#3784) — what this planning run is FOR. Discovered by the
 *  planner (existing repos to restructure ⇒ transform; from a pitch ⇒ greenfield; …) rather than
 *  chosen up front: lifecycle left the blueprint model in #3785, so discovery is its only home.
 *  Unset ⇒ read as "greenfield", the create-a-project default — see {@link lifecycleOf}, and note
 *  that DISPLAY must not apply that default (#4062).
 *
 *  `harvest` (#4062) — the project exists to EXTRACT DATA FROM SOURCES: pulling an existing system's
 *  data out, rather than restructuring code (`transform`) or keeping something running (`maintain`).
 *  The name is the app's established one for exactly this shape — `bsc ui harvest`, algorithm harvest,
 *  both "extract from what already exists". */
export type Lifecycle = "greenfield" | "transform" | "harden" | "maintain" | "harvest";

/** The valid `Lifecycle` tokens, for the coerce below. Mirrored by `LIFECYCLES` in
 *  `crates/plandb/src/validate.rs`, which rejects an unknown token at `bsc plan classify set` —
 *  keep the two in lockstep or the planner can write a value the app cannot read. */
export const LIFECYCLES: Lifecycle[] = ["greenfield", "transform", "harden", "maintain", "harvest"];

/** The app types that carry a USER INTERFACE — the ones for which the `ui` stage is meaningful.
 *  Everything else (an API, serverless functions, a CLI, a library, an MCP server) has no screens
 *  to design, so the UI stage does not apply to it (#3784). */
const UI_BEARING: AppType[] = ["application", "desktop", "mobile", "static"];

export interface ClassifyConfig {
  /** Which surface the `ui` stage renders. Unset → the body defaults to "custom". */
  uiMode?: UiMode;
  /** Who renders this project's UI at runtime (#4115). Unset → read as "studio", today's behaviour
   *  for every existing project — so adding the axis changes nothing until a planner sets it. */
  uiSystem?: UiSystem;
  /** The project's application architecture (#3802/#3784). Unset → read as "application". */
  appType?: AppType;
  /** The project's lifecycle intent (#3784). Unset → read as "greenfield". */
  lifecycle?: Lifecycle;
  /** A desk-research market assessment is worth doing → show the `market` stage (#3806). */
  needsMarket?: boolean;
  /** The project connects to an external system → show the `source` stage. */
  needsSource?: boolean;
  /** The project uses MCP servers → show the `mcps` stage. */
  needsMcp?: boolean;
  /** The project needs attached skills → show the `skills` stage. */
  needsSkills?: boolean;
  /** The project needs cron automations → show the `automations` stage. */
  needsAutomations?: boolean;
}

/** Coerce a `bsc plan classify get` blob into a typed config — a light structural check (the CLI
 *  validates hard at write). A non-object reads as null; unknown/mistyped fields are dropped, so a
 *  partial blob (e.g. only `uiMode`) coerces cleanly. */
export function coerceClassifyConfig(raw: unknown): ClassifyConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const cfg: ClassifyConfig = {};
  if (r.uiMode === "custom" || r.uiMode === "external") cfg.uiMode = r.uiMode;
  if (typeof r.uiSystem === "string" && (UI_SYSTEMS as string[]).includes(r.uiSystem)) cfg.uiSystem = r.uiSystem as UiSystem;
  if (typeof r.appType === "string" && (APP_TYPES as string[]).includes(r.appType)) cfg.appType = r.appType as AppType;
  if (typeof r.lifecycle === "string" && (LIFECYCLES as string[]).includes(r.lifecycle)) cfg.lifecycle = r.lifecycle as Lifecycle;
  if (typeof r.needsMarket === "boolean") cfg.needsMarket = r.needsMarket;
  if (typeof r.needsSource === "boolean") cfg.needsSource = r.needsSource;
  if (typeof r.needsMcp === "boolean") cfg.needsMcp = r.needsMcp;
  if (typeof r.needsSkills === "boolean") cfg.needsSkills = r.needsSkills;
  if (typeof r.needsAutomations === "boolean") cfg.needsAutomations = r.needsAutomations;
  return cfg;
}

/** The project's app type, with the unclassified default applied. */
export function appTypeOf(cfg: ClassifyConfig | undefined | null): AppType {
  return cfg?.appType ?? "application";
}

/** The project's lifecycle intent, with the unclassified default applied. */
export function lifecycleOf(cfg: ClassifyConfig | undefined | null): Lifecycle {
  return cfg?.lifecycle ?? "greenfield";
}

/** Who renders this project's UI, with the unclassified default applied (#4115).
 *
 *  Unset reads as "studio" — today's behaviour for every project that exists — so the axis is
 *  non-regressing by construction and needs no migration or backfill. */
export function uiSystemOf(cfg: ClassifyConfig | undefined | null): UiSystem {
  return cfg?.uiSystem ?? "studio";
}

/** Does this project render from OUR component graph (#4115)? The gate for everything that only
 *  applies to studio-rendered projects — kit pinning, the graph vocabulary in worker context, the
 *  build/publish pipeline, per-node analytics (#3809).
 *
 *  Deliberately a predicate rather than call sites comparing strings: the consumers land across
 *  slices 3-5, and they should all ask one question. */
export function rendersFromStudio(cfg: ClassifyConfig | undefined | null): boolean {
  return uiSystemOf(cfg) === "studio";
}

/** Does this project have screens to design? Drives whether the `ui` stage applies (#3784).
 *
 *  An UNCLASSIFIED project reads as "application" ⇒ true, so turning this on never hides a UI
 *  stage that showed before the planner classified — the same non-regressing rule every other
 *  classification read site follows. */
export function appTypeHasUi(cfg: ClassifyConfig | undefined | null): boolean {
  return UI_BEARING.includes(appTypeOf(cfg));
}

/** Project the classification into the flat gate-signal bag (#3784) — one boolean per app type
 *  (`appType:api`, `appType:mcp-server`, …) and per lifecycle (`lifecycle:transform`, …), plus the
 *  derived `hasUserInterface`.
 *
 *  Exposing the taxonomy as signals rather than a single string is what the {@link
 *  import("../stages/stageGate").PlanSignals} bag supports (numbers/booleans only) — and it lets a
 *  cloud-distributed stage key its `appliesWhen` on an app type without the app shipping code for it. */
export function classifySignals(cfg: ClassifyConfig | undefined | null): Record<string, boolean> {
  const appType = appTypeOf(cfg);
  const lifecycle = lifecycleOf(cfg);
  const uiSystem = uiSystemOf(cfg);
  const out: Record<string, boolean> = {
    hasUserInterface: appTypeHasUi(cfg),
    // #4115: exposed as a signal so a stage's `appliesWhen` can key on it — a studio-only stage
    // should not run for a project that owns its own rendering.
    rendersFromStudio: rendersFromStudio(cfg),
  };
  for (const t of APP_TYPES) out[`appType:${t}`] = t === appType;
  for (const l of LIFECYCLES) out[`lifecycle:${l}`] = l === lifecycle;
  for (const s of UI_SYSTEMS) out[`uiSystem:${s}`] = s === uiSystem;
  return out;
}
