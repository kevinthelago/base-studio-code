// Store projections (#2498) — the PURE per-domain payload builders behind the generic
// `store_state` frame (#2497). Each builder maps the SAME store data the desktop pages read
// into the compact JSON a mobile page renders; the projector hook (useStoreProjector) feeds
// them live store slices and pushes the result through the domain publisher. Pure + typed —
// only `import type` crosses feature boundaries (erased at build), so this module wires no
// runtime coupling and every payload shape is unit-testable from plain fixtures.
//
// Deliberately OUT (maintainer): telemetry/analytics — skill telemetry counters, hook
// analytics, usage charts. Mobile is state + alerts, not dashboards.

import type { ProjectLite } from "@/features/glance";
import type { ProjectLink } from "@/features/glance/lib/projectLinks";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Org } from "@/features/org";
import type { Persona } from "@/features/personas";
import type { Blueprint, BlueprintTeam } from "@/features/planner/stages/blueprintTypes";
import type { SkillDef } from "@/features/skills/lib/skillsModel";
import type { SkillGroup } from "@/features/skills/lib/skillGroups";
import type { Lesson } from "@/features/skills/lib/lessons";
import type { Kit, ComponentRecord, KitConsumer } from "@/features/components";
import type { KitThemeRecord } from "@/features/components/lib/themes";
import type { Automation, AutomationRun } from "@/features/automations/lib/scheduler";
import type { McpServer } from "@/features/mcp/lib/mcpServers";
import type { Hook } from "@/features/mcp/lib/hooks";
import type { AlertEvent } from "./alerts";

// ── glance ───────────────────────────────────────────────────────────────────────
// The project network + the drilled project's fleet: the same inputs the desktop Glance
// workspace feeds `buildGlanceData` / `buildRealFleetData`. Mobile rebuilds the graph with
// the vendored shared graph core, so the payload is the MODEL, not layout.

export interface GlancePayload {
  /** Published + local-draft projects, keyed by plan key, with fault badges merged on. */
  projects: ProjectLite[];
  /** The real project→project edges (`bsc project link`). */
  links: ProjectLink[];
  /** The drilled project key (L1 fleet view), or null at the L0 network. Synced drill state. */
  drill: string | null;
  /** The drilled project's fleet plan (streams/director/edges), when loaded. */
  drillFleet: FleetPlan | null;
}

export function buildGlancePayload(input: {
  projects: ProjectLite[];
  links: ProjectLink[];
  faults: Record<string, number>;
  drill: string | null;
  drillFleet: FleetPlan | null;
}): GlancePayload {
  return {
    projects: input.projects.map((p) =>
      input.faults[p.id] ? { ...p, faults: input.faults[p.id] } : p,
    ),
    links: input.links,
    drill: input.drill,
    drillFleet: input.drill ? input.drillFleet : null,
  };
}

// ── org ──────────────────────────────────────────────────────────────────────────
// The org library (positions + relationships) plus pared persona refs — enough to render the
// org graph and resolve each agent position's persona card (start prompts stay desktop-side).

export interface PersonaRef {
  id: string;
  name: string;
  blurb: string;
  role: string;
  model?: string;
  pooled?: boolean;
  builtin?: boolean;
}

export interface OrgPayload {
  orgs: Org[];
  personas: PersonaRef[];
}

export function buildOrgPayload(input: { orgs: Org[]; personas: Persona[] }): OrgPayload {
  return {
    orgs: input.orgs,
    personas: input.personas.map((p) => ({
      id: p.id, name: p.name, blurb: p.blurb, role: p.role,
      model: p.model, pooled: p.pooled, builtin: p.builtin,
    })),
  };
}

// ── blueprints ───────────────────────────────────────────────────────────────────
// Library CARDS (metadata incl. team presence + the uiKit pin) — NOT each blueprint's full
// stage/team payload — plus the ACTIVE blueprint's embedded team graph, the one graph the
// mobile Blueprints page renders.

export interface BlueprintCard {
  id: string;
  name: string;
  desc: string;
  icon?: string;
  h?: number;
  origin?: string;
  category?: string;
  mode?: string;
  tags?: string[];
  uses?: number;
  updatedAt?: string;
  stageCount: number;
  /** The blueprint embeds a team org (#2450). */
  hasTeam: boolean;
  /** The pinned UI kit (#2465), pared to identity. */
  uiKit?: { id: string; version: string; themeId?: string };
}

export interface BlueprintsPayload {
  active: string;
  library: BlueprintCard[];
  /** The active blueprint's full team graph (positions + relationships), when it has one. */
  activeTeam: BlueprintTeam | null;
}

export function buildBlueprintsPayload(input: {
  blueprints: Blueprint[];
  activeBlueprintId: string;
}): BlueprintsPayload {
  const active = input.blueprints.find((b) => b.id === input.activeBlueprintId);
  return {
    active: input.activeBlueprintId,
    library: input.blueprints.map((b) => ({
      id: b.id, name: b.name, desc: b.desc, icon: b.icon, h: b.h,
      origin: b.origin, category: b.category, mode: b.mode, tags: b.tags,
      uses: b.uses, updatedAt: b.updatedAt,
      stageCount: b.sections.length,
      hasTeam: !!b.team && b.team.positions.length > 0,
      uiKit: b.uiKit ? { id: b.uiKit.id, version: b.uiKit.version, themeId: b.uiKit.themeId } : undefined,
    })),
    activeTeam: active?.team && active.team.positions.length > 0 ? active.team : null,
  };
}

// ── skills ───────────────────────────────────────────────────────────────────────
// The library + task groups + the active project's PENDING lessons. Telemetry counters
// (invocations/success/tokens/trend) are analytics — dropped on mobile. Prompt bodies are
// desktop-side authoring content — dropped too (cards carry the desc).

export interface SkillCard {
  id: string;
  name: string;
  kind: string;
  source: string;
  desc: string;
  projects: string[];
  enabled: boolean;
  pinned: boolean;
  packaged?: boolean;
}

export interface SkillsPayload {
  skills: SkillCard[];
  groups: SkillGroup[];
  /** The active project's pending lessons (`bsc plan lesson list --status pending`), or null
   *  when there is no active project. */
  lessons: { project: string; pending: Lesson[] } | null;
}

export function buildSkillsPayload(input: {
  skills: SkillDef[];
  groups: SkillGroup[];
  lessons: { project: string; pending: Lesson[] } | null;
}): SkillsPayload {
  return {
    skills: input.skills.map((s) => ({
      id: s.id, name: s.name, kind: s.kind, source: s.source, desc: s.desc,
      projects: s.projects, enabled: s.enabled, pinned: s.pinned, packaged: s.packaged,
    })),
    groups: input.groups,
    lessons: input.lessons,
  };
}

// ── components ───────────────────────────────────────────────────────────────────
// Kit + component SUMMARIES (identity/classification/reuse), not the source bodies —
// `srcText`/`props`/rules stay desktop-side where the Design Studio edits them.

export interface ComponentCard {
  id: string;
  name: string;
  kitId: string;
  role: string;
  version: string;
  used: number;
  tags: string[];
  variants: string[];
  composes: string[];
  builtin?: boolean;
}

export interface ComponentsPayload {
  kits: Kit[];
  components: ComponentCard[];
  /** Which project consumes which kit (the propagation consumer index). */
  usage: KitConsumer[];
}

export function buildComponentsPayload(input: {
  kits: Kit[];
  components: ComponentRecord[];
  usage: KitConsumer[];
}): ComponentsPayload {
  return {
    kits: input.kits,
    components: input.components.map((c) => ({
      id: c.id, name: c.name, kitId: c.kitId, role: c.role, version: c.version,
      used: c.used, tags: c.tags, variants: c.variants, composes: c.composes,
      builtin: c.builtin,
    })),
    usage: input.usage,
  };
}

// ── themes ───────────────────────────────────────────────────────────────────────
// The themes registry (the @data/ui/themes.json shape, hydrated into the store) + the active
// kit theme id — mobile consumes the vars as data (same look, native layout).

export interface ThemesPayload {
  themes: KitThemeRecord[];
  active: string;
}

export function buildThemesPayload(input: { themes: KitThemeRecord[]; active: string }): ThemesPayload {
  return { themes: input.themes, active: input.active };
}

// ── automations ──────────────────────────────────────────────────────────────────
// The automation list with its recent run records (embedded per automation, newest first)
// plus the hooks list. Hook-fire analytics are dropped (analytics are out on mobile).

/** Runs included per automation in the mobile payload (the store itself caps at 25). */
export const AUTOMATION_RUNS_CAP = 10;

export interface AutomationCard {
  id: string;
  name: string;
  armed: boolean;
  when: Automation["when"];
  lastRunAt: number | null;
  nextRunAt: number | null;
  runs: AutomationRun[];
}

export interface HookCard {
  id: string;
  name: string;
  enabled: boolean;
  event: string;
  matcher?: string;
  projects: string[];
}

export interface AutomationsPayload {
  automations: AutomationCard[];
  hooks: HookCard[];
}

export function buildAutomationsPayload(input: {
  automations: Automation[];
  hooks: Hook[];
}): AutomationsPayload {
  return {
    automations: input.automations.map((a) => ({
      id: a.id, name: a.name, armed: a.armed, when: a.when,
      lastRunAt: a.lastRunAt, nextRunAt: a.nextRunAt,
      runs: a.runs.slice(0, AUTOMATION_RUNS_CAP),
    })),
    hooks: input.hooks.map((h) => ({
      id: h.id, name: h.name, enabled: h.enabled, event: h.event,
      matcher: h.matcher, projects: h.projects,
    })),
  };
}

// ── mcp ──────────────────────────────────────────────────────────────────────────
// The MCP server list + which are installed (runnable config present — the same
// `resolveAllInstalledMcp` set the desktop page derives). Env vars stay desktop-side
// (they can carry secrets).

export interface McpCard {
  id: string;
  name: string;
  enabled: boolean;
  transport: string;
  projects: string[];
  url?: string;
  /** The server has a runnable config (in the installed set). */
  installed: boolean;
}

export interface McpPayload {
  servers: McpCard[];
}

export function buildMcpPayload(input: {
  servers: McpServer[];
  /** Ids of the installed set (from `resolveAllInstalledMcp`, which includes built-ins). */
  installedIds: string[];
}): McpPayload {
  const installed = new Set(input.installedIds);
  return {
    servers: input.servers.map((s) => ({
      id: s.id, name: s.name, enabled: s.enabled, transport: s.transport,
      projects: s.projects, url: s.url, installed: installed.has(s.id),
    })),
  };
}

// ── alerts ───────────────────────────────────────────────────────────────────────

export interface AlertsPayload {
  alerts: ReadonlyArray<AlertEvent>;
}

export function buildAlertsPayload(inbox: ReadonlyArray<AlertEvent>): AlertsPayload {
  return { alerts: inbox };
}
