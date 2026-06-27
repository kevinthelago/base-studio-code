// The parallel-execution (fleet) plan — the agent streams, director, topology, and
// relationship graph a project's fleet describes, plus the parser that turns the
// planner-written JSON (stored in plan.db, #1805) into a typed {@link FleetPlan}.
//
// Pure (no React / xterm / Tauri) so it can be unit-tested in isolation and shared
// between the planner UI, the store, and the fleet helpers. Split out of the former
// planSections.ts (#1615), which conflated this fleet machinery with the discovery
// topic-file helpers; those now live in stages/planTopics.ts.

import type { AgentFlow } from "./agentFlow";
import { flowOrUndefined } from "./agentFlow";
import type { ModelId } from "@/app/console/lib/models";
import { type DirectorDrive, normalizeDirectorDrive, DEFAULT_DIRECTOR_DRIVE } from "./directorDrive";
import { type IntegrationStrategy, normalizeStrategy } from "../lib/integrationStrategy";
import {
  type Topology, type RelationshipArtifact, type AgentRelationship,
  type EdgeKind, type Hardness, type Via, type ArtifactKind,
} from "../relationship/relationshipGraph";

const TOPOLOGIES: Topology[] = ["director", "peer", "hybrid"];
const EDGE_KINDS: EdgeKind[] = ["handoff", "blocking", "sequence", "review", "notify", "mutex", "shared"];
const HARDNESSES: Hardness[] = ["blocking", "soft", "notify"];
const ARTIFACT_KINDS: ArtifactKind[] = ["schema", "contract", "types", "tokens", "fixture", "other"];

/** Coerce a raw fleet.json `topology` value (default "hybrid"). */
export function normalizeTopology(raw: unknown): Topology {
  return typeof raw === "string" && (TOPOLOGIES as string[]).includes(raw.trim().toLowerCase())
    ? (raw.trim().toLowerCase() as Topology) : "hybrid";
}

function parseArtifacts(raw: unknown): RelationshipArtifact[] {
  if (!Array.isArray(raw)) return [];
  const out: RelationshipArtifact[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") continue;
    const o = a as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const producer = typeof o.producer === "string" ? o.producer.trim() : "";
    if (!id || !producer) continue;
    const kind = typeof o.kind === "string" && (ARTIFACT_KINDS as string[]).includes(o.kind) ? o.kind as ArtifactKind : "other";
    out.push({
      id, producer, kind,
      name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : id,
      consumers: Array.isArray(o.consumers) ? o.consumers.filter((c): c is string => typeof c === "string") : [],
      status: o.status === "ready" ? "ready" : o.status === "pending" ? "pending" : undefined,
    });
  }
  return out;
}

function parseEdges(raw: unknown): AgentRelationship[] {
  if (!Array.isArray(raw)) return [];
  const out: AgentRelationship[] = [];
  for (const e of raw) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const from = typeof o.from === "string" ? o.from.trim() : "";
    const to = typeof o.to === "string" ? o.to.trim() : "";
    if (!from || !to) continue;
    out.push({
      id: typeof o.id === "string" && o.id.trim() ? o.id.trim() : `${from}>${to}`,
      from, to,
      kind: typeof o.kind === "string" && (EDGE_KINDS as string[]).includes(o.kind) ? o.kind as EdgeKind : "blocking",
      hardness: typeof o.hardness === "string" && (HARDNESSES as string[]).includes(o.hardness) ? o.hardness as Hardness : "blocking",
      via: o.via === "director" ? "director" : ("direct" as Via),
      artifact: typeof o.artifact === "string" && o.artifact.trim() ? o.artifact.trim() : undefined,
      note: typeof o.note === "string" && o.note.trim() ? o.note.trim() : undefined,
    });
  }
  return out;
}

/** The fleet section key. The fleet plan is DB-owned (plan.db, #1018/#1805) — surfaced by the poll
 *  under this stem (NOT a `fleet.json` file), not a rendered plan topic; parsed into the fleet store
 *  and shown in its own Fleet card. See {@link parseFleetFile}. */
export const FLEET_KEY = "fleet";

/**
 * One parallel work stream — a single Claude session with a focused role, a repo,
 * the files/globs it OWNS (its conflict boundary), the issues it owns, the streams
 * it must follow (interface-first), and the kickoff script that seeds it.
 */
export interface AgentStream {
  id: string;
  name: string;
  repo: string;
  /** Path globs this stream owns; no other stream should write inside them. */
  owns: string[];
  /** Issue refs this stream owns (e.g. `#12`). */
  issues: string[];
  /** Ids of streams that must land before this one starts. */
  dependsOn: string[];
  /** Shell commands this stream's session may auto-run without prompting (#1572) — the
   *  toolchain the planner grants it (e.g. `["cargo", "wasm-pack"]`), on top of the
   *  posture-scaled safe baseline. Seeds the generated profile's `commands`; written as
   *  `Bash(<cmd> *)` allow rules at launch. Unset/empty ⇒ baseline + mandatory only. */
  commands?: string[];
  /** Relpath of the kickoff script the fleet launch seeds this session with. */
  prompt?: string;
  /** Id of the AgentProfile this stream's session launches under (#289). */
  profile?: string;
  /** Per-agent execution flow (#297): autonomy + GitHub push policy. Unset ⇒ DEFAULT_FLOW at launch. */
  flow?: AgentFlow;
  /** Per-agent LLM model (#…) — launches this stream's session under `claude --model <tier>`.
   *  Unset ⇒ the global `defaultModel` (so the director/baseline stays on the global choice). */
  model?: ModelId;
  /** Per-stream integration-strategy override (#378). Unset ⇒ the fleet default. */
  strategy?: IntegrationStrategy;
  /** GitHub login this stream's issues are assigned to at publish (#847). A worker is an
   *  agent session, not a GitHub user, so this maps the stream to a human/collaborator
   *  login. Unset ⇒ the publishing account (viewer). The `stream:<id>` label remains the
   *  agent-ownership marker; this is the first-class GitHub assignee. */
  assignee?: string;
  /** Per-capability permission posture chosen in the project pane's agent editor.
   *  When present it overrides the profile-derived posture in the pane. */
  perm?: Record<string, "allow" | "ask" | "deny">;
  /** Permission preset name chosen in the pane (e.g. "Build"), or "custom" when a
   *  capability was hand-tuned. When present it overrides the profile-derived preset. */
  preset?: string;
  /** MCP servers (catalog names) the planner assigned to THIS worker (#1054). At fleet launch
   *  the worker gets these (case-insensitive) on top of any global servers; the planner + director
   *  always see every installed server. Unset/empty ⇒ the worker gets only global servers. */
  mcp?: string[];
  /** Skill task-group ids the planner assigned to THIS stream (#1338, parallel to {@link mcp}).
   *  At fleet launch the group ids are expanded (via the global skills.db) into this worker's
   *  skill set, on top of the project-resolved skills and any groups toggled onto the session.
   *  Unset/empty ⇒ the worker gets only its project-resolved skills. */
  groupIds?: string[];
}

/** Optional async-integrator session that coordinates the fleet from the project root. */
export interface FleetDirector { enabled: boolean; role?: string; drive?: DirectorDrive; }

/** The full parallel-execution plan for a project (persisted in plan.db, #1805). */
export interface FleetPlan {
  /** Optimal number of worker sessions to run concurrently. */
  recommended: number;
  /** Why that many — the planner's justification. */
  reasoning: string;
  streams: AgentStream[];
  director: FleetDirector;
  /** Project-default integration strategy (#378). Unset ⇒ DEFAULT_STRATEGY. */
  strategy?: IntegrationStrategy;
  /** Coordination topology (#…): director-orchestrated, peer mesh, or hybrid (per-edge). */
  topology?: Topology;
  /** Produced contracts/schemas one stream hands to others. */
  artifacts?: RelationshipArtifact[];
  /** Typed relationship edges between streams (beyond plain `dependsOn`). */
  edges?: AgentRelationship[];
}

/** An empty fleet — the default before the planner has designed one. */
export function emptyFleet(): FleetPlan {
  return { recommended: 0, reasoning: "", streams: [], director: { enabled: false, drive: DEFAULT_DIRECTOR_DRIVE } };
}

/** Coerce a JSON value into a string[]. Accepts an array (strings kept, others
 *  stringified) or a single comma-separated string; anything else → []. */
function toStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map(x => (typeof x === "string" ? x : String(x))).map(s => s.trim()).filter(Boolean);
  }
  if (typeof v === "string") {
    return v.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/** Coerce a JSON value into a non-negative integer; non-numeric → 0. */
function coerceNum(v: unknown): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Parse the FleetPlan JSON (the planner writes it to plan.db, #1805; surfaced by the poll
 * as stem {@link FLEET_KEY}) into a {@link FleetPlan}. Tolerant of partial/malformed
 * input: returns `null` only when the text is blank or not a JSON object; otherwise
 * fills sensible defaults. Streams missing `id` or `repo` are dropped; `dependsOn`
 * accepts either `dependsOn` or `depends_on`.
 */
export function parseFleetFile(raw: string): FleetPlan | null {
  if (!raw || !raw.trim()) return null;
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = obj as Record<string, unknown>;

  const streams: AgentStream[] = [];
  const rawStreams = Array.isArray(o.streams) ? o.streams : [];
  for (const s of rawStreams) {
    if (!s || typeof s !== "object") continue;
    const so = s as Record<string, unknown>;
    const id   = typeof so.id === "string" ? so.id.trim() : "";
    const repo = typeof so.repo === "string" ? so.repo.trim() : "";
    if (!id || !repo) continue;  // id + repo are the minimum a stream needs
    const prompt = typeof so.prompt === "string" && so.prompt.trim() ? so.prompt.trim() : undefined;
    // MCP servers (catalog names) the planner assigned to this worker (#1054); undefined when none
    // so the field round-trips cleanly. Carried through to fleetStartProject's per-worker resolution.
    const mcp = toStringArray(so.mcp);
    // Per-agent flow (#297) arrives in EITHER shape (#1804): NESTED as `so.flow`
    // ({autonomy,push,trigger,gate} — the canonical `bsc-plan fleet set` / fleet.json
    // form, matching the store model) OR FLAT as top-level `so.autonomy`/`so.push`/
    // `so.trigger`/`so.gate` (what the `<agent_assign>` tag attrs and legacy flat
    // fleet.json emit). Prefer a named nested object; else assemble from the flat
    // fields; else leave undefined so genuinely-unset streams still get DEFAULT_FLOW
    // at launch (we must NOT silently materialize a flow here).
    const nestedFlow = so.flow && typeof so.flow === "object" && !Array.isArray(so.flow)
      ? (so.flow as Record<string, unknown>) : null;
    const flow = flowOrUndefined(nestedFlow)
      ?? flowOrUndefined({ autonomy: so.autonomy, push: so.push, trigger: so.trigger, gate: so.gate });
    streams.push({
      id,
      name: typeof so.name === "string" && so.name.trim() ? so.name.trim() : id,
      repo,
      owns:      toStringArray(so.owns),
      issues:    toStringArray(so.issues),
      dependsOn: toStringArray(so.dependsOn ?? so.depends_on),
      commands:  ((cs) => cs.length ? cs : undefined)(toStringArray(so.commands)),
      prompt,
      mcp: mcp.length ? mcp : undefined,
      profile: typeof so.profile === "string" && so.profile.trim() ? so.profile.trim() : undefined,
      flow,
      perm: (so.perm && typeof so.perm === "object" && !Array.isArray(so.perm))
        ? (so.perm as Record<string, "allow" | "ask" | "deny">) : undefined,
      preset: typeof so.preset === "string" && so.preset.trim() ? so.preset.trim() : undefined,
      strategy: normalizeStrategy(so.strategy),
      assignee: typeof so.assignee === "string" && so.assignee.trim() ? so.assignee.trim() : undefined,
    });
  }

  const dir = (o.director && typeof o.director === "object" && !Array.isArray(o.director))
    ? (o.director as Record<string, unknown>) : {};
  const director: FleetDirector = {
    enabled: dir.enabled === true || dir.enabled === "true",
    role: typeof dir.role === "string" && dir.role.trim() ? dir.role.trim() : undefined,
    drive: normalizeDirectorDrive(dir.drive),
  };

  return {
    recommended: coerceNum(o.recommended),
    reasoning: typeof o.reasoning === "string" ? o.reasoning : "",
    streams,
    director,
    strategy: normalizeStrategy(o.strategy),
    topology: o.topology !== undefined ? normalizeTopology(o.topology) : undefined,
    artifacts: parseArtifacts(o.artifacts),
    edges: parseEdges(o.edges),
  };
}
