// Canonical, model-checked INPUTS for every store_state payload builder (#3761 / D2 of
// Mobile-Studio-Code#246). Each building block below `satisfies` its REAL domain model, so a rename
// or shape change in ProjectLite / AgentProfile / AuditRecord / … is a COMPILE ERROR right here —
// which forces a regeneration of storePayloads.fixtures.json, which fails mobile's parity harness.
// That compile-error tripwire is the single highest-value part of the harness; it earns its keep
// even if the JSON fixture never ships.
//
// Small on purpose: 2–3 rows per collection. Values are deliberately NON-DEGENERATE — no field
// equals a mobile selector's fallback (no `idle` health, real ISO-8601 audit timestamps, non-default
// enums), so mobile's smoke layer can distinguish "read the field correctly" from "fell back". Cap
// behaviour (SECURITY_AUDIT_CAP / AUTOMATION_RUNS_CAP) is asserted with inflated inputs in
// storeProjections.test.ts — never inflate these fixtures to prove a cap.
//
// INVARIANT (#3922): every entry below must also carry every OPTIONAL field its builder passes
// through — not just the fields required to satisfy the type — and use real closed-vocabulary
// values (e.g. an actual archetype id), never a placeholder. `satisfies` only guards required
// fields and bare-`string` vocabularies; an optional field that's always absent, or a value that
// always equals a consumer's fallback, type-checks perfectly while being invisible to the harness
// end-to-end. When a domain's optional surface can't fit non-degenerately in the main input without
// bloating it, add a `variants` entry in storePayloads.fixtures.test.ts instead (see `themes_light`).

import type { ProjectLite, GlanceFault } from "@/features/glance";
import type { ProjectLink } from "@/features/glance/lib/projectLinks";
import type { FleetPlan } from "@/features/planner/fleet/planFleet";
import type { Stage } from "@/features/planner/stages/focusedPlan";
import type { MarketConfig } from "@/features/planner/lib/marketConfig";
import type { Team } from "@/features/teams";
import type { Persona } from "@/features/personas";
import type { Blueprint } from "@/features/planner/stages/blueprintTypes";
import type { SkillDef } from "@/features/skills/lib/skillsModel";
import type { SkillGroup } from "@/features/skills/lib/skillGroups";
import type { Lesson } from "@/features/skills/lib/lessons";
import type { Kit, ComponentRecord, KitConsumer, KitLibraryRef } from "@/features/designs";
import type { KitThemeRecord } from "@/features/designs/lib/themes";
import type { Automation } from "@/features/automations/lib/scheduler";
import type { McpServer } from "@/features/mcp/lib/mcpServers";
import type { Hook } from "@/features/mcp/lib/hooks";
import type { AgentProfile, ConsoleSession, AuditDisplayRow } from "@/features/security";
import type { AlertEvent } from "./alerts";

// ── glance ─────────────────────────────────────────────────────────────────────────────────────
const fleet = {
  recommended: 2,
  reasoning: "two lanes",
  streams: [
    { id: "auth", name: "Auth", repo: "acme/api", owns: ["src/auth/**"], issues: ["#1", "#2"], dependsOn: [], persona: "backend-dev" },
    { id: "ui", name: "UI", repo: "acme/web", owns: ["src/ui/**"], issues: ["#3"], dependsOn: ["auth"], persona: "frontend-dev" },
  ],
  director: { enabled: true },
} satisfies FleetPlan;

// health is non-idle on both; `demo` is escalated to `error` by its fault below, `reporting` stays `warning`.
const glanceProjects = [
  { id: "demo", name: "Demo", role: "service", health: "healthy", activity: "building" },
  { id: "reporting", name: "Reporting", role: "data", health: "warning", activity: "review" },
] satisfies ProjectLite[];

const glanceLinks = [
  { id: "demo>reporting:api", from: "demo", to: "reporting", kind: "api" },
] satisfies ProjectLink[];

const glanceFaults = { demo: { level: "error", title: "payments timeout", count: 3 } } satisfies Record<string, GlanceFault>;

// buildGlancePayload reads only { id, role } off each persona.
const glancePersonas = [
  { id: "backend-dev", role: "worker" },
  { id: "lead", role: "director" },
] satisfies { id: string; role: string }[];

const glanceKits = [{ id: "react-ui", name: "React UI", tech: "react", stack: "React · TS", dot: "#7aa2ff" }] satisfies Kit[];
const glanceKitUsage = [{ projectKey: "demo", kitId: "react-ui" }] satisfies KitConsumer[];
const glanceLibraryRefs = [
  { kitId: "react-ui", graph: "algo", id: "dijkstra.ts", label: "dijkstra" },
] satisfies KitLibraryRef[];

// ── org ────────────────────────────────────────────────────────────────────────────────────────
// Two real archetypes between distinct nodes — `manages` (solid, single-headed) and `iterates`
// (dashed, bidirectional, cyclical) — so both edge classes render end-to-end, plus every optional
// pass-through field a naive consumer could silently drop: `Position.x`/`y`, `Relationship.bow`,
// `Team.blurb`/`builtin`, `PersonaRef.pooled` (#3922). The prior fixture's only relationship used an
// archetype id ("delegates") that isn't in the vocabulary at all and was a self-edge every consumer
// filters, so the entire relationship half of this payload rendered as zero edges everywhere.
const org = {
  id: "o1", name: "Pipeline", blurb: "auth + review pipeline", builtin: true,
  positions: [
    { nodeId: "n1", kind: "agent", personaId: "p1", x: 40, y: 60 },
    { nodeId: "n2", kind: "external", label: "Tech Lead", x: 220, y: 60 },
  ],
  relationships: [
    { id: "r1", archetype: "manages", from: "n2", to: "n1" },
    { id: "r2", archetype: "iterates", from: "n2", to: "n1", bow: 24 },
  ],
} satisfies Team;

const orgPersona = {
  id: "p1", name: "Backend dev", blurb: "APIs", role: "worker",
  startPrompt: "You own the API surface.", skills: ["s1"], model: "sonnet", pooled: true, builtin: true,
} satisfies Persona;

// ── blueprints ─────────────────────────────────────────────────────────────────────────────────
const bpTeam = { positions: [{ nodeId: "n1", kind: "agent" as const, personaId: "p1" }], relationships: [] };
const bpDefault = {
  id: "default", name: "Default", desc: "greenfield seed", sections: [],
  mode: "create", team: bpTeam,
  uiKit: { id: "bsc/react-ui", version: "1.2.0", hash: "abc123", themeId: "soft" },
  soundKit: { id: "bsc/signal", version: "1.0.0", hash: "deadbeef", source: "https://gist.github.com/a/b" },
} satisfies Blueprint;
const bpMigrate = { id: "migrate", name: "Migrate", desc: "restructure repos", sections: [] } satisfies Blueprint;

// ── skills ─────────────────────────────────────────────────────────────────────────────────────
const skill = {
  id: "s1", name: "Review checklist", kind: "review", source: "first-party", desc: "PR review",
  prompt: "Walk the diff and flag missing tests.", tools: [], profiles: [], projects: [], enabled: true, pinned: true,
  invocations: 42, success: 40, avgTokensK: 3, trend: [1, 2, 3],
} satisfies SkillDef;

const skillGroup = { id: "g1", name: "Backend", hue: "var(--accent)", skillIds: ["s1"] } satisfies SkillGroup;

const lessons = {
  project: "demo",
  pending: [{ id: "l1", mistake: "skipped a null check", cause: "rushed", rule: "guard nullable reads", provenance: "pane 1", status: "pending", seen: 2, createdAt: 1, updatedAt: 2 }] as Lesson[],
};

// ── components ─────────────────────────────────────────────────────────────────────────────────
const kit = { id: "react-ui", name: "React UI", tech: "react", stack: "React · TS", dot: "#7aa2ff" } satisfies Kit;
const component = {
  id: "c1", name: "Button", kitId: "react-ui", role: "primitive", version: "1.0.0",
  used: 12, tags: ["control"], variants: ["ghost"], composes: [],
  props: [{ name: "kind", type: "string", req: false, desc: "visual kind" }],
  whenUse: ["actions"], whenNot: ["nav"], src: "src/Button.tsx", srcText: "export const Button = () => null;",
} satisfies ComponentRecord;

// ── themes ─────────────────────────────────────────────────────────────────────────────────────
const theme = {
  id: "soft", tech: "react", label: "Soft", description: "rounder corners, softer shadows",
  vars: { "--card-radius": "14px" }, builtin: true,
} satisfies KitThemeRecord;

// ── automations ────────────────────────────────────────────────────────────────────────────────
// 2 runs — small + non-degenerate. The AUTOMATION_RUNS_CAP=10 slice is proven with an inflated
// input in storeProjections.test.ts, not here.
const automation = {
  id: "a1", name: "Nightly triage", armed: true,
  when: { kind: "simple", every: "day", at: "02:00" },
  targetTab: "build", targetPaneIdx: 0, action: "command", command: "triage",
  lastRunAt: 200, nextRunAt: 300,
  runs: [
    { at: 200, status: "ok", note: "triaged 4 issues" },
    { at: 100, status: "skipped", note: "no new issues" },
  ],
} satisfies Automation;

const hook = { id: "h1", name: "deny-floor", enabled: true, projects: [], event: "PreToolUse", command: "bsc-deny" } satisfies Hook;

// ── mcp ────────────────────────────────────────────────────────────────────────────────────────
const mcpServers = [
  { id: "m1", name: "research", enabled: true, projects: [], transport: "stdio", command: "bsc", args: "mcp research" },
  { id: "m2", name: "custom", enabled: false, projects: ["demo"], transport: "http", url: "https://mcp.acme.dev" },
] satisfies McpServer[];

// ── security ───────────────────────────────────────────────────────────────────────────────────
// An application role (rendered first) — carries the app-role-only fields (surface/session/owns) a
// plain profile lacks, plus a real `origin` chip. A plain assignable profile follows.
const appRole = {
  id: "sys_planner", name: "Project Planner", color: "#c792ea", category: "application", origin: "built-in",
  desc: "plans projects; never writes code",
  mode: "deny", commands: ["gh *"],
  tools: { read: "allow", grep: "allow", glob: "allow", edit: "deny", write: "deny", bash: "ask", web: "allow", task: "deny" },
  paths: { allow: [], deny: ["**"] },
  net: { allow: ["api.github.com"] },
  builtin: true,
  surface: "Planner", surfaceGlyph: "◆", session: "planner", owns: "the plan",
} satisfies AgentProfile;

const profile = {
  id: "pf_worker", name: "Worker", color: "#7aa2ff", category: "user", origin: "user-defined",
  desc: "builds features under review",
  mode: "ask", commands: ["cargo *"],
  tools: { read: "allow", grep: "allow", glob: "allow", edit: "ask", write: "ask", bash: "ask", web: "deny", task: "deny" },
  paths: { allow: ["src/**"], deny: [".env"] },
  net: { allow: ["api.github.com"] },
  builtin: false,
} satisfies AgentProfile;

// A live console with a real repo + allowlists (not the `—` fallback) so mobile renders "console / pane"
// and resolves the effective allowlist locally.
const secConsoles = [
  {
    id: "t0", name: "Build", repo: "acme/api", status: "running",
    projectAllow: ["npm run build"], repoAllow: ["cargo test"],
    panes: [{ id: "t0p0", agent: "worker", status: "idle", profileId: "pf_worker" }],
  },
] satisfies ConsoleSession[];

// Display rows (what buildAuditRows produces in the projector) — real ISO-8601 timestamps (not `t0`)
// so a mobile `readIsoMs` never resolves them to null; a real console name + profileId (not `—`); and
// a real desktop-computed `decision` on each (allow AND block, so neither is a fallback).
const auditRows = [
  { ts: "2026-07-25T10:15:00.000Z", console: "Build", pane: "t0p0", profileId: "pf_worker", kind: "cmd", target: "git push origin auth", decision: "allow" },
  { ts: "2026-07-25T10:16:30.000Z", console: "Build", pane: "t0p0", profileId: "pf_worker", kind: "tool", target: ".env", decision: "block" },
] satisfies AuditDisplayRow[];

// ── alerts ─────────────────────────────────────────────────────────────────────────────────────
const inbox = [
  { id: "gate-ready:demo:1721900000000", kind: "gate-ready", text: "Plan ready to publish", at: 1721900000000, paneId: "demo:director", project: "demo" },
] satisfies AlertEvent[];

// ── plan (#3760) ─────────────────────────────────────────────────────────────────────────────────
// The planner-published board domain. Its builder (buildPlanBoardPayload) lives in the PLANNER feature
// (the plan domain rides usePlannerTunnelSync, not useStoreProjector), so its inputs are planner types —
// but it's guarded like every other domain now. Non-degenerate: real stage statuses + an unmet gate
// reason, a fleet with streams, and a fully-scored market verdict (`defined` true). Deploy stays
// unconfigured — an honest mid-plan state, and a full DeployService is too deep to hand-author (its
// `defaultService` builder can't be value-imported cross-feature).
const planStages = [
  { key: "discovery", name: "Discovery", glyph: "◇", blurb: "scope the problem", gate: "sections confirmed",
    index: 0, total: 3, status: "complete", fraction: 1, unmet: [] },
  { key: "features", name: "Features", glyph: "◆", blurb: "map the build", gate: "≥1 feature mapped",
    index: 1, total: 3, status: "active", fraction: 0.5, optional: false,
    unmet: [{ label: "features defined", detail: "0 of 3 mapped" }] },
  { key: "market", name: "Market", glyph: "◈", blurb: "size the market", gate: "verdict reached",
    index: 2, total: 3, status: "upcoming", fraction: 0, optional: true, unmet: [] },
] satisfies Stage[];

const planMarket = {
  summary: "Strong niche: solo indie builders underserved by heavyweight suites.",
  scores: {
    problemSeverity: { score: 4, rationale: "manual setup burns ~a day per project", sources: ["survey-2026"] },
    problemFrequency: { score: 5, rationale: "hit on every new project", sources: ["survey-2026"] },
    reachableMarket: { score: 3, rationale: "~2M indie devs reachable on GitHub", sources: ["octoverse-2025"] },
    competitiveGap: { score: 4, rationale: "incumbents target teams, not solos", sources: ["g2-scan"] },
    timing: { score: 4, rationale: "agentic tooling just crossed the usability line", sources: ["trend-2026"] },
    moat: { score: 3, rationale: "the blueprint library compounds with use", sources: ["thesis"] },
  },
  verdict: { recommendation: "go", rationale: "severe, frequent problem in a reachable niche" },
} satisfies MarketConfig;

/**
 * The canonical input to every `build*Payload`, keyed by store_state domain. The generator
 * (`storePayloads.fixtures.test.ts`) runs the REAL builders over these — it never hand-authors JSON.
 * `plan` is now covered too (#3760): its builder lives in the planner feature (`buildPlanBoardPayload`,
 * imported by the generator via the `@/features/planner` barrel), so its input here is planner-typed.
 */
export const PROJECTION_INPUTS = {
  glance: {
    projects: glanceProjects, links: glanceLinks, faults: glanceFaults, drill: "demo" as string | null,
    fleets: { demo: fleet }, personas: glancePersonas,
    kitUsage: glanceKitUsage, kits: glanceKits, libraryRefs: glanceLibraryRefs,
  },
  org: { orgs: [org], personas: [orgPersona] },
  blueprints: { blueprints: [bpDefault, bpMigrate], activeBlueprintId: "default" },
  skills: { skills: [skill], groups: [skillGroup], lessons },
  components: { kits: [kit], components: [component], usage: [{ projectKey: "demo", kitId: "react-ui" }] },
  themes: { themes: [theme], active: "soft" },
  automations: { automations: [automation], hooks: [hook] },
  mcp: { servers: mcpServers, installedIds: ["m1"] },
  security: {
    appRoles: [appRole], profiles: [profile], consoles: secConsoles,
    paneRoles: { t0p0: "worker" }, paneProfiles: { t0p0: "pf_worker" }, auditRows,
  },
  alerts: inbox,
  plan: {
    projectId: "demo", title: "Demo", currentStage: "features", statusLabel: "in_progress",
    gateReady: true, planComplete: false,
    stages: planStages, confirmed: ["goal", "scope"], skipped: ["stack"],
    fleet, market: planMarket,
  },
};
// NOT `as const`: the builders take MUTABLE arrays, and a `readonly` PROJECTION_INPUTS would fail every
// builder call in the generator. The per-block `satisfies` above are the model tripwires; the generator's
// `build*Payload(PROJECTION_INPUTS.<d>)` call sites are a second tripwire on any builder-input change.
