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
// Pure (no React/Tauri/store access) so it's unit-testable and the round-trip test can assert the
// snapshot is DEMOABLE_KEYS-only. Loading MERGES onto the built-in libraries (personas/orgs/skills/
// blueprints) rather than replacing them (mergeSnapshotInto, #2288).

import { SAMPLE_GRAPH, type GRole, type GStatus } from "@/features/glance";
import { projectLinkId, type ProjectLink } from "@/features/glance/lib/projectLinks";
import type { Persona } from "@/features/personas/lib/persona";
import type { Org } from "@/features/org/lib/org";
import type { SkillDef } from "@/features/skills/lib/skillsModel";
import type { SkillGroup } from "@/features/skills/lib/skillGroups";
import { makeBlueprints, type Blueprint } from "@/features/planner/stages/blueprints";
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
// Display name + one-line pitch for each SAMPLE_GRAPH node. role/status come straight from the sample
// graph so the loaded Glance network matches the packaged sample exactly (the cycle hazard included).
const PROJECT_META: Record<string, { title: string; pitch: string }> = {
  "auth-core":     { title: "Auth Core",       pitch: "OIDC identity provider + token minting. Every service trusts it." },
  "events-bus":    { title: "Events Bus",      pitch: "The platform event backbone — durable pub/sub the whole fleet emits to." },
  "identity-svc":  { title: "Identity Service", pitch: "User profiles, sessions, and org membership on top of Auth Core." },
  "ledger":        { title: "Ledger",          pitch: "Append-only double-entry ledger — the money source of truth." },
  "notifications": { title: "Notifications",   pitch: "Email/SMS/push fan-out driven off the events bus." },
  "analytics":     { title: "Analytics",       pitch: "Streaming rollups + warehouse loads for product metrics." },
  "user-api":      { title: "User API",        pitch: "The public BFF the web + mobile clients call." },
  "billing-svc":   { title: "Billing Service", pitch: "Subscriptions, invoices, and dunning over the Ledger." },
  "reporting":     { title: "Reporting",       pitch: "Finance + ops reports composed from ledger and analytics." },
  "search-svc":    { title: "Search Service",  pitch: "Catalog + user search index, refreshed from the events bus." },
  "payments-gw":   { title: "Payments Gateway", pitch: "PSP integration — idempotent charge/refund/capture flows." },
  "mobile-app":    { title: "Mobile App",      pitch: "React Native storefront + account management." },
  "admin-console": { title: "Admin Console",   pitch: "Internal back-office — accounts, billing, and reporting." },
  "web-app":       { title: "Web App",         pitch: "The customer-facing storefront SPA." },
};

type DemoProject = { title: string; pitch: string; createdAt: number; role?: GRole; status?: GStatus };

/** The 14 demo projects, keyed by the SAMPLE_GRAPH node id (also the Glance node id + fleet/plan key). */
function demoProjects(): Record<string, DemoProject> {
  const out: Record<string, DemoProject> = {};
  for (const n of SAMPLE_GRAPH.rawNodes) {
    const meta = PROJECT_META[n.id] ?? { title: n.id, pitch: "" };
    out[n.id] = { title: meta.title, pitch: meta.pitch, createdAt: DEMO_EPOCH, role: n.role, status: n.status };
  }
  return out;
}

/** The Glance edges — the SAMPLE_GRAPH topology (incl. the reporting⇄analytics cycle) as user-drawn links. */
function demoLinks(): ProjectLink[] {
  return SAMPLE_GRAPH.rawEdges.map((e) => ({ id: projectLinkId(e.from, e.to, e.kind), from: e.from, to: e.to, kind: e.kind }));
}

// ── Skills — the platform playbook ───────────────────────────────────────────────────────────────
const DEMO_SKILL_IDS = [
  "demo-idempotent-retries", "demo-double-entry", "demo-openapi-first", "demo-threat-model", "demo-adr-writing",
] as const;

const mkSkill = (
  id: string, name: string, kind: SkillDef["kind"], desc: string, prompt: string,
  tools: string[], profiles: SkillDef["profiles"],
): SkillDef => ({
  id, name, kind, source: "team", desc, prompt, tools, profiles,
  projects: [], enabled: true, pinned: true,
  invocations: 0, success: 0, avgTokensK: 0, trend: [],
});

function demoSkills(): SkillDef[] {
  return [
    mkSkill("demo-idempotent-retries", "Idempotent payment retries", "workflow",
      "Charge/refund flows that are safe to retry — dedupe keys + at-most-once effects.",
      "Every mutating PSP call carries an idempotency key derived from the order id. On retry, look up the prior result before re-issuing. Never double-charge.",
      ["Bash", "Read"], ["build"]),
    mkSkill("demo-double-entry", "Double-entry ledger invariants", "review",
      "Assert the ledger stays balanced: every posting has an equal-and-opposite entry.",
      "For any ledger change, verify debits == credits per transaction and that account balances reconcile. Reject a migration that breaks the invariant.",
      ["Read", "Grep"], ["build", "review"]),
    mkSkill("demo-openapi-first", "OpenAPI contract-first", "scaffold",
      "Design the API from the OpenAPI spec, then generate types + a mock server.",
      "Author the OpenAPI 3.1 document first. Generate client/server types from it. The spec is the contract other streams build against in parallel.",
      ["Bash", "Write"], ["build"]),
    mkSkill("demo-threat-model", "STRIDE threat modeling", "review",
      "Walk a change through STRIDE and note mitigations before it lands.",
      "For the touched surface, enumerate Spoofing/Tampering/Repudiation/Information-disclosure/DoS/Elevation risks and the concrete mitigation for each.",
      ["Read"], ["review"]),
    mkSkill("demo-adr-writing", "Architecture decision records", "docs",
      "Capture each significant decision as a short ADR (context · decision · consequences).",
      "When a design choice is made, write docs/adr/NNNN-title.md: the context, the decision, the alternatives weighed, and the consequences.",
      ["Write"], ["docs"]),
  ];
}

function demoSkillGroups(): SkillGroup[] {
  return [
    { id: "demo-commerce-playbook", name: "Commerce platform playbook", hue: "var(--accent)", skillIds: [...DEMO_SKILL_IDS] },
  ];
}

// ── Personas — the agent identities the fleet launches as ────────────────────────────────────────
const DEMO_PERSONA = {
  payments:  "demo-payments-eng",
  ledger:    "demo-ledger-architect",
  security:  "demo-security-reviewer",
  docs:      "demo-docs-scribe",
  director:  "demo-fleet-director",
} as const;

function demoPersonas(): Persona[] {
  return [
    { id: DEMO_PERSONA.director, name: "Northwind Director", blurb: "Coordinates the platform fleet — reviews and merges PRs, keeps the board current.",
      role: "director", startPrompt: "You orchestrate the Northwind fleet. Own contracts + integration; never write feature code.",
      skills: [], responsibilities: ["Integrate streams", "Own the project board", "Resolve cross-service contracts"] },
    { id: DEMO_PERSONA.payments, name: "Payments Engineer", blurb: "Builds idempotent charge/refund flows across the gateway and billing.",
      role: "worker", startPrompt: "Implement payment flows. Every mutating PSP call is idempotent; contract-first against the OpenAPI spec.",
      skills: ["demo-idempotent-retries", "demo-openapi-first"], model: "claude-sonnet-4-6" },
    { id: DEMO_PERSONA.ledger, name: "Ledger Architect", blurb: "Guards the double-entry ledger invariants and its migrations.",
      role: "worker", startPrompt: "Own the ledger. Preserve double-entry invariants on every change; reject anything that unbalances an account.",
      skills: ["demo-double-entry"] },
    { id: DEMO_PERSONA.security, name: "Security Reviewer", blurb: "Threat-models each landing before it merges. Read-only.",
      role: "reviewer", startPrompt: "Independently review each landing with STRIDE. Note risks + mitigations; do not write code.",
      skills: ["demo-threat-model"] },
    { id: DEMO_PERSONA.docs, name: "Docs Scribe", blurb: "Reconciles ADRs and architecture docs after a change lands.",
      role: "documentor", startPrompt: "After a change lands, reconcile the prose docs and capture an ADR. Prose only — never touch code.",
      skills: ["demo-adr-writing"] },
  ];
}

// ── Org — the persona-relationship graph ─────────────────────────────────────────────────────────
function demoOrg(): Org {
  return {
    id: "demo-northwind-fleet",
    name: "Northwind fleet",
    blurb: "The agent org that builds and operates the Northwind platform.",
    positions: [
      { nodeId: "director", kind: "agent",    personaId: DEMO_PERSONA.director, x: 480, y: 90 },
      { nodeId: "payments", kind: "agent",    personaId: DEMO_PERSONA.payments, x: 250, y: 300 },
      { nodeId: "ledger",   kind: "agent",    personaId: DEMO_PERSONA.ledger,   x: 480, y: 300 },
      { nodeId: "security", kind: "agent",    personaId: DEMO_PERSONA.security, x: 710, y: 300 },
      { nodeId: "docs",     kind: "agent",    personaId: DEMO_PERSONA.docs,     x: 710, y: 470 },
      { nodeId: "commons",  kind: "resource", label: "Shared contracts",        x: 250, y: 470 },
      { nodeId: "github",   kind: "external", label: "GitHub",                  x: 480, y: 470 },
    ],
    relationships: [
      { id: "r-dir-pay",  archetype: "manages",  from: "director", to: "payments" },
      { id: "r-dir-led",  archetype: "manages",  from: "director", to: "ledger" },
      { id: "r-dir-doc",  archetype: "manages",  from: "director", to: "docs" },
      { id: "r-sec-pay",  archetype: "oversees", from: "security", to: "payments" },
      { id: "r-sec-led",  archetype: "oversees", from: "security", to: "ledger" },
      { id: "r-pay-led",  archetype: "consults", from: "payments", to: "ledger" },
      { id: "r-doc-com",  archetype: "stewards", from: "docs",     to: "commons" },
      { id: "r-dir-gh",   archetype: "stewards", from: "director", to: "github" },
    ],
  };
}

// ── Blueprint — the reusable template that seeds the platform's projects ─────────────────────────
const DEMO_BLUEPRINT_ID = "demo-microservices-platform";

/** Clone a built-in greenfield blueprint into the demo one (id/name/desc/skills overridden) so the
 *  full, valid stage set rides along without hand-authoring it. Attaches the demo skills so the
 *  blueprint cross-references the same playbook the personas use. */
function demoBlueprint(): Blueprint {
  const builtins = makeBlueprints();
  const base = builtins.find((b) => (b.category ?? "greenfield") === "greenfield") ?? builtins[0];
  return {
    ...base,
    id: DEMO_BLUEPRINT_ID,
    name: "Northwind microservices",
    desc: "The lifecycle blueprint that seeds each Northwind service — discovery → structure → fleet, with the commerce playbook attached.",
    origin: "local",
    category: "greenfield",
    skills: [...DEMO_SKILL_IDS],
    uses: 14,
    updatedAt: new Date(DEMO_EPOCH).toISOString(),
    gist: undefined,
  };
}

// ── Fleets — the live agent streams per project ──────────────────────────────────────────────────
const mkStream = (
  id: string, name: string, repo: string, persona: string, owns: string[], issues: string[], dependsOn: string[] = [],
): AgentStream => ({ id, name, repo, owns, issues, dependsOn, persona });

const mkFleet = (recommended: number, reasoning: string, streams: AgentStream[]): FleetPlan => ({
  recommended, reasoning, streams,
  director: { enabled: true, drive: "event" },
  topology: "director",
});

function demoFleets(): Record<string, FleetPlan> {
  return {
    "billing-svc": mkFleet(2,
      "Billing splits cleanly into the ledger boundary and the subscription/invoice API — two non-overlapping streams.",
      [
        mkStream("ledger", "Ledger", "northwind/billing-svc", DEMO_PERSONA.ledger, ["ledger/**", "migrations/**"], ["#12", "#14"]),
        mkStream("billing-api", "Billing API", "northwind/billing-svc", DEMO_PERSONA.payments, ["api/**", "invoices/**"], ["#13", "#15"], ["ledger"]),
      ]),
    "payments-gw": mkFleet(2,
      "The PSP integration is built by the payments engineer and independently threat-modeled by the reviewer.",
      [
        mkStream("gateway", "Gateway", "northwind/payments-gw", DEMO_PERSONA.payments, ["gateway/**", "psp/**"], ["#21", "#22"]),
        mkStream("security-review", "Security review", "northwind/payments-gw", DEMO_PERSONA.security, ["docs/security/**"], ["#23"], ["gateway"]),
      ]),
    "user-api": mkFleet(2,
      "The public BFF is contract-first: the API stream lands the OpenAPI spec, the docs stream reconciles ADRs behind it.",
      [
        mkStream("api", "API", "northwind/user-api", DEMO_PERSONA.payments, ["src/**", "openapi/**"], ["#31", "#32"]),
        mkStream("docs", "Docs", "northwind/user-api", DEMO_PERSONA.docs, ["docs/**"], ["#33"], ["api"]),
      ]),
  };
}

// ── Automations — schedules · commands · cron rules over the same projects ───────────────────────
function demoSchedules(): Schedule[] {
  return [
    { id: "S-01", name: "Nightly ledger reconciliation", on: true, when: "every day · 02:00",
      target: "billing-svc · build", action: "command", detail: "reconcile-ledger", lastRun: "02:00", nextRun: "tomorrow 02:00" },
    { id: "S-02", name: "Refresh search index", on: true, when: "every 6h",
      target: "search-svc · build", action: "command", detail: "reindex-catalog", lastRun: "6h ago", nextRun: "in 6h" },
  ];
}

function demoCommands(): Command[] {
  return [
    { id: "C-01", name: "reconcile-ledger", cmd: "bsc plan run reconcile --project billing-svc", used: 42, tags: ["ledger", "finance"] },
    { id: "C-02", name: "replay-payments", cmd: "bsc plan run replay --project payments-gw --since 24h", used: 7, tags: ["payments"] },
    { id: "C-03", name: "regen-openapi", cmd: "npm run gen:openapi", kind: "claude", used: 19, tags: ["user-api", "contract"] },
  ];
}

function demoAutomations(): Automation[] {
  return [
    { id: "A-01", name: "PR triage · payments-gw", armed: true, when: { kind: "cron", expr: "0 9 * * 1-5" },
      targetTab: "payments-gw · build", targetPaneIdx: 0, action: "command",
      command: "gh pr list --repo northwind/payments-gw", lastRunAt: null, nextRunAt: null, runs: [] },
    { id: "A-02", name: "Nightly ledger check", armed: true, when: { kind: "simple", every: "day", at: "02:30" },
      targetTab: "billing-svc · build", targetPaneIdx: 0, action: "command",
      command: "reconcile-ledger", lastRunAt: null, nextRunAt: null, runs: [] },
  ];
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

  return {
    // Glance — the project network
    localDraftProjects: projects,
    projectLinks: demoLinks(),
    achievements: { "super-user": DEMO_EPOCH },

    // Libraries
    skills: demoSkills(),
    skillGroups: demoSkillGroups(),
    personas: demoPersonas(),
    orgs: [demoOrg()],
    orgZoom: { "demo-northwind-fleet": 1 },
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
