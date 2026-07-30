// Curated demo world (#2282, follow-up to #2272) — ONE coherent, internally-consistent app-state
// snapshot that makes every workspace look ALIVE and tells a single story. It is authored over the
// `DEMOABLE_KEYS` shape (the security allowlist), so it can be loaded locally via `loadDemoState`
// OR published verbatim as the official public demo gist and offered from the empty states.
//
// THE STORY — "Northwind", a ~14-service e-commerce microservices platform being built and operated
// by an AI agent org. The SAME names cross-reference across every workspace:
//   • Glance    — the 14 projects (reusing the SAMPLE_GRAPH spine, #2272) as a NETWORK: infra at the
//                 base (auth-core, events-bus), services + data in the middle (billing/ledger/…), the
//                 clients on top (web/mobile/admin), wired by api/data/events edges — INCLUDING the
//                 reporting⇄analytics dependency CYCLE the map flags as a coordination hazard.
//   • Fleets    — three projects carry a live agent fleet (billing-svc, payments-gw, user-api); every
//                 worker stream launches AS one of the demo PERSONAS below.
//   • Libraries — the personas reference the demo SKILLS; the ORG places those personas and wires them
//                 with relationships; the demo BLUEPRINT attaches the same skills; the AUTOMATIONS act
//                 on the same projects. Nothing dangles: every id points at something in this world.
//
// The FIXTURE CONTENT (project meta, skills, personas, org, blueprint meta, fleets, automations) is
// externalized to `@data/demo/*.json` (#2419, epic #2027 tail); this module is the thin ASSEMBLER that
// owns the types and fills the runtime/default fields. The demo seeds are plain embedded imports, NOT
// config-dir-overlaid — the snapshot must stay byte-deterministic (stable across builds → stable gist
// bytes), so an edited config-dir copy never leaks into the published demo.
//
// Pure (no React/Tauri/store access) so it's unit-testable and the round-trip test can assert the
// snapshot is DEMOABLE_KEYS-only. Loading MERGES onto the built-in libraries (personas/orgs/skills/
// blueprints) rather than replacing them (mergeSnapshotInto, #2288).

import projectMetaData from "@data/demo/project-meta.json";
import skillsData from "@data/demo/skills.json";
import personasData from "@data/demo/personas.json";
import orgData from "@data/demo/org.json";
import blueprintData from "@data/demo/blueprint.json";
import fleetsData from "@data/demo/fleets.json";
import automationsData from "@data/demo/automations.json";
import { SAMPLE_GRAPH, type GRole, type GHealth, type GActivity } from "@/features/glance";
import { projectLinkId, type ProjectLink } from "@/features/glance/lib/projectLinks";
import type { Persona } from "@/features/personas/lib/persona";
import type { Team } from "@/features/teams/lib/team";
import type { SkillDef } from "@/features/skills/lib/skillsModel";
import type { SkillGroup } from "@/features/skills/lib/skillGroups";
import { makeBlueprints, DEFAULT_BLUEPRINT_ID, type Blueprint } from "@/features/planner/stages/blueprints";
import type { FleetPlan, AgentStream } from "@/features/planner/fleet/planFleet";
import type { Schedule, Command } from "@/shared/data/mock";
import type { Automation } from "@/features/automations/lib/scheduler";
import type { AppStateSnapshot } from "./appState";

/**
 * The gist the empty states offer as the official one-click demo. EMPTY by default — the local
 * {@link demoSnapshot} is the functional path (no auth needed). Publishing the gist is a MAINTAINER
 * manual step: run `saveDemoToGist` (Settings → Demo app-state → "Save current state…") from an
 * account with the `gist` scope AFTER loading the bundled demo, make it PUBLIC, then paste the
 * resulting `https://gist.github.com/<user>/<id>` URL here so the remote "Load demo" resolves it.
 * TODO(maintainer): bake the published demo-gist URL here.
 */
export const DEMO_GIST_URL = "" as const;

/** A fixed timestamp so the snapshot is deterministic (stable across builds → stable gist bytes). */
const DEMO_EPOCH = Date.UTC(2026, 0, 15); // 2026-01-15

// ── Projects — the Glance spine ──────────────────────────────────────────────────────────────────
// Display name + one-line pitch for each SAMPLE_GRAPH node (`@data/demo/project-meta.json`).
// role/health/activity come straight from the sample graph so the loaded Glance network matches the
// packaged sample exactly (the cycle hazard + the curated warning/error nodes included).
const PROJECT_META: Record<string, { title: string; pitch: string }> = projectMetaData;

type DemoProject = { title: string; pitch: string; createdAt: number; role?: GRole; health?: GHealth; activity?: GActivity; reason?: string };

/** The 14 demo projects, keyed by the SAMPLE_GRAPH node id (also the Glance node id + fleet/plan key). */
function demoProjects(): Record<string, DemoProject> {
  const out: Record<string, DemoProject> = {};
  for (const n of SAMPLE_GRAPH.rawNodes) {
    const meta = PROJECT_META[n.id] ?? { title: n.id, pitch: "" };
    out[n.id] = { title: meta.title, pitch: meta.pitch, createdAt: DEMO_EPOCH, role: n.role, health: n.health, activity: n.activity, reason: n.reason };
  }
  return out;
}

/** The Glance edges — the SAMPLE_GRAPH topology (incl. the reporting⇄analytics cycle) as user-drawn links. */
function demoLinks(): ProjectLink[] {
  return SAMPLE_GRAPH.rawEdges.map((e) => ({ id: projectLinkId(e.from, e.to, e.kind), from: e.from, to: e.to, kind: e.kind }));
}

// JSON module imports are shared singletons — clone at every seed boundary so each demoSnapshot()
// call mints fresh objects (the pre-#2419 behavior) and a later store mutation can't pollute the seed.
const clone = <T,>(v: T): T => structuredClone(v);

// ── Skills — the platform playbook (`@data/demo/skills.json`) ────────────────────────────────────
// The JSON carries the authored fields; the assembler fills the library defaults (team source,
// global + enabled + pinned) and the zeroed display-only telemetry.
function demoSkills(): SkillDef[] {
  return clone(skillsData.skills).map((s) => ({
    ...s,
    kind: s.kind as SkillDef["kind"],
    profiles: s.profiles as SkillDef["profiles"],
    source: "team" as const,
    projects: [], enabled: true, pinned: true,
    invocations: 0, success: 0, avgTokensK: 0, trend: [],
  }));
}

function demoSkillGroups(): SkillGroup[] {
  return clone(skillsData.groups);
}

// ── Personas — the agent identities the fleet launches as (`@data/demo/personas.json`) ───────────
function demoPersonas(): Persona[] {
  return clone(personasData) as Persona[];
}

// ── Team — the persona-relationship graph (`@data/demo/org.json`) ─────────────────────────────────
function demoOrg(): Team {
  return clone(orgData) as Team;
}

// ── Blueprint — the reusable template that seeds the platform's projects ─────────────────────────
const DEMO_BLUEPRINT_ID = blueprintData.id;

/** Clone the default built-in blueprint into the demo one (id/name/desc/skills overridden from
 *  `@data/demo/blueprint.json`) so the full, valid stage set rides along without hand-authoring it.
 *  Attaches the demo skills so the blueprint cross-references the same playbook the personas use. */
function demoBlueprint(): Blueprint {
  const builtins = makeBlueprints();
  const base = builtins.find((b) => b.id === DEFAULT_BLUEPRINT_ID) ?? builtins[0];
  return {
    ...base,
    id: DEMO_BLUEPRINT_ID,
    name: blueprintData.name,
    desc: blueprintData.desc,
    origin: "local",
    skills: skillsData.skills.map((s) => s.id),
    uses: blueprintData.uses,
    updatedAt: new Date(DEMO_EPOCH).toISOString(),
    gist: undefined,
  };
}

// ── Fleets — the live agent streams per project (`@data/demo/fleets.json`) ───────────────────────
// The JSON carries the planned streams; the assembler adds the shared fleet posture (an event-driven
// director over a director topology).
function demoFleets(): Record<string, FleetPlan> {
  const out: Record<string, FleetPlan> = {};
  for (const [key, f] of Object.entries(fleetsData)) {
    out[key] = {
      recommended: f.recommended,
      reasoning: f.reasoning,
      streams: clone(f.streams) as AgentStream[],
      director: { enabled: true, drive: "event" },
      topology: "director",
    };
  }
  return out;
}

// ── Automations — schedules · commands · cron rules (`@data/demo/automations.json`) ──────────────
function demoSchedules(): Schedule[] {
  return clone(automationsData.schedules) as Schedule[];
}

function demoCommands(): Command[] {
  return clone(automationsData.commands) as Command[];
}

/** The JSON carries the authored rule; the assembler zeroes the runtime state (never-yet-run). */
function demoAutomations(): Automation[] {
  return clone(automationsData.automations).map((a) => ({
    ...a,
    when: a.when as Automation["when"],
    action: a.action as Automation["action"],
    lastRunAt: null,
    nextRunAt: null,
    runs: [],
  }));
}

/**
 * Build the curated demo snapshot — a valid {@link AppStateSnapshot} over `DEMOABLE_KEYS`, internally
 * consistent (personas ↔ skills ↔ org ↔ fleets ↔ blueprint ↔ projects all cross-reference the same
 * names). Pass to `loadDemoState` to overlay it, or publish via `saveDemoToGist`.
 */
export function demoSnapshot(): AppStateSnapshot {
  const projects = demoProjects();
  const projectBlueprintId: Record<string, string> = {};
  for (const key of Object.keys(projects)) projectBlueprintId[key] = DEMO_BLUEPRINT_ID;

  const org = demoOrg();
  return {
    // Glance — the project network. Every demo project is TRIAGED (#2541) so the curated network
    // renders (the drafted→triaged gate would otherwise hide un-worked projects).
    localDraftProjects: projects,
    triagedProjects: Object.fromEntries(Object.keys(projects).map((k) => [k, DEMO_EPOCH])),
    projectLinks: demoLinks(),
    achievements: { "super-user": DEMO_EPOCH },

    // Libraries
    skills: demoSkills(),
    skillGroups: demoSkillGroups(),
    personas: demoPersonas(),
    teams: [org],
    teamsZoom: { [org.id]: 1 },
    blueprints: [demoBlueprint()],
    activeBlueprintId: DEMO_BLUEPRINT_ID,

    // Per-project plan / fleet
    planFleet: demoFleets(),
    projectBlueprintId,

    // Automations
    schedules: demoSchedules(),
    commands: demoCommands(),
    automations: demoAutomations(),
  };
}
