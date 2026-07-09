// Store projections (#2498) — the PURE per-domain payload builders behind the generic
// `store_state` frame (#2497). Each builder maps the SAME store data the desktop pages read
// into the compact JSON a mobile page renders; the projector hook (useStoreProjector) feeds
// them live store slices and pushes the result through the domain publisher. Pure + typed —
// only `import type` crosses feature boundaries (erased at build), so this module wires no
// runtime coupling and every payload shape is unit-testable from plain fixtures.
//
// Deliberately OUT (maintainer): telemetry/analytics — skill telemetry counters, hook
// analytics, usage charts. Mobile is state + alerts, not dashboards.

import type { ProjectLite, GlanceFault, GHealth } from "@/features/glance";
import type { ProjectLink } from "@/features/glance/lib/projectLinks";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Org } from "@/features/org";
import type { Persona } from "@/features/personas";
import type { Blueprint, BlueprintTeam } from "@/features/planner/stages/blueprintTypes";
import type { SkillDef } from "@/features/skills/lib/skillsModel";
import type { SkillGroup } from "@/features/skills/lib/skillGroups";
import type { Lesson } from "@/features/skills/lib/lessons";
import type { Kit, ComponentRecord, KitConsumer } from "@/features/designs";
import type { KitThemeRecord } from "@/features/designs/lib/themes";
import type { Automation, AutomationRun } from "@/features/automations/lib/scheduler";
import type { McpServer } from "@/features/mcp/lib/mcpServers";
import type { Hook } from "@/features/mcp/lib/hooks";
import type { AgentProfile, AuditRecord } from "@/features/security";
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
  /** The drilled project's fleet plan (streams/director/edges) — derived from {@link fleets}; kept
   *  for the mobile L1 view. Null at the network level or when the drilled fleet isn't loaded. */
  drillFleet: FleetPlan | null;
  /** Every project whose fleet is currently loaded, keyed by project key (#2530) — so ANY project
   *  node can drill into its agents on mobile, not only the currently-drilled one. */
  fleets: Record<string, FleetPlan>;
  /** persona id → resolved session role (#2530) — a stream carries a persona id but no role, and the
   *  glance payload has no personas, so mobile defaulted every agent node to `worker`. This map lets
   *  mobile colour each stream's node by its real role. */
  personaRoles: Record<string, string>;
}

export function buildGlancePayload(input: {
  projects: ProjectLite[];
  links: ProjectLink[];
  faults: Record<string, GlanceFault>;
  drill: string | null;
  /** All loaded fleets, keyed by project key (the projector merges the on-demand drilled fleet in). */
  fleets: Record<string, FleetPlan>;
  /** The persona library — only `id` + `role` are read (start prompts stay desktop-side). */
  personas: { id: string; role: string }[];
}): GlancePayload {
  return {
    // Mirror the desktop HEALTH overlay (#2541): a project's worst open fault escalates its health to
    // warning/error and carries the fault title as the reason (matches `applyFaultHealth`).
    projects: input.projects.map((p) => {
      const f = input.faults[p.id];
      if (!f) return p;
      const health: GHealth = f.level === "warn" ? "warning" : "error";
      return { ...p, health, reason: f.title, faults: f.count };
    }),
    links: input.links,
    drill: input.drill,
    fleets: input.fleets,
    drillFleet: input.drill ? input.fleets[input.drill] ?? null : null,
    personaRoles: Object.fromEntries(input.personas.map((p) => [p.id, p.role])),
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

// ── security (#2530) ───────────────────────────────────────────────────────────────
// The least-privilege picture the mobile Security page (#223) renders, READ-ONLY: the agent
// profiles (#289 — the permission CONFIG: base policy · command allowlist · per-tool tri-states ·
// write-path scope · network HOST allowlist), the per-pane role + profile assignments, and recent
// audit activity (bsc-audit, #257). No secrets cross — `net` is a host allowlist (not credentials),
// and audit records are `{ ts, pane, tool, target }`.

/** Recent audit records included in the security payload (the desktop log itself keeps more). */
export const SECURITY_AUDIT_CAP = 200;

export interface SecurityProfileCard {
  id: string;
  name: string;
  category: string;
  desc: string;
  /** Base policy for anything not explicitly listed (deny | ask | allow). */
  mode: string;
  commands: string[];
  /** tool → tier (read/edit/bash/… → deny|ask|allow). */
  tools: Record<string, string>;
  paths: { allow: string[]; deny: string[] };
  /** Allowed network hosts — NOT credentials. */
  net: string[];
  builtin?: boolean;
}

export interface SecurityPayload {
  profiles: SecurityProfileCard[];
  /** paneId → the SessionRole it launched under. Transient — empty before any fleet launch. */
  paneRoles: Record<string, string>;
  /** paneId → assigned agent-profile id. */
  paneProfiles: Record<string, string>;
  /** Recent audit records (bsc-audit, #257), newest first, capped at {@link SECURITY_AUDIT_CAP}. */
  audit: AuditRecord[];
}

export function buildSecurityPayload(input: {
  profiles: AgentProfile[];
  paneRoles: Record<string, string>;
  paneProfiles: Record<string, string>;
  audit: AuditRecord[];
}): SecurityPayload {
  return {
    profiles: input.profiles.map((p) => ({
      id: p.id, name: p.name, category: p.category, desc: p.desc, mode: p.mode,
      commands: p.commands,
      tools: Object.fromEntries(Object.entries(p.tools)),
      paths: { allow: p.paths.allow, deny: p.paths.deny },
      net: p.net.allow,
      builtin: p.builtin,
    })),
    paneRoles: input.paneRoles,
    paneProfiles: input.paneProfiles,
    audit: input.audit.slice(0, SECURITY_AUDIT_CAP),
  };
}

// ── alerts ───────────────────────────────────────────────────────────────────────

export interface AlertsPayload {
  alerts: ReadonlyArray<AlertEvent>;
}

export function buildAlertsPayload(inbox: ReadonlyArray<AlertEvent>): AlertsPayload {
  return { alerts: inbox };
}
