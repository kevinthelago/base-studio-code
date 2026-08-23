// fleetStartBridge (`headless-fleet-launch-a-director-cannot-start-its-own-fleet`) — decide what a
// `bsc fleet start` request does to the store.
//
// Pure on purpose: the DECISION is testable without Tauri or a rendered app, and the listener stays a
// thin adapter — the same split `fleetDirectorBridge` and `fleetWakeBridge` use.
//
// WHY IT BUILDS A FleetPlan AND CALLS fleetStartProject
// Exactly the reason the director bridge does: a fleet is not a set of panes, it is cwds, kickoff
// docs, roles, profiles, flows, models, skills and drives on pane ids the rest of the app already
// knows how to find. All of that lives in `fleetStartProject`, which every UI launch exercises.
// Reimplementing any of it here would be a second launch path that drifts from the first — the
// "superseded but never removed" duplication this codebase has paid for more than once. So this
// constructs the FleetPlan from what Rust resolved and hands it to the path that already works.
//
// WHAT RUST HAS ALREADY SETTLED before this runs: the project exists, the fleet has something to
// launch, no fleet is already live (or --force was passed), the hub is materialized, and EVERY
// worker's worktree has been created. The launch is all that is left — which is why a failure here
// is reported rather than retried.

import type { FleetPlan, AgentStream } from "@/features/planner/fleet/planFleet";

/**
 * One stream as Rust resolved it: **the plan's whole row**, plus the worktree already created for it.
 *
 * Deliberately `AgentStream & { worktree }` rather than a reduced `{id, repo}`. A stream carries its
 * name, owns, issues, dependsOn, flow, profile, persona, model and kickoff — that IS the plan, and
 * rebuilding a thinner version here would give a CLI launch a poorer fleet than a UI launch while
 * looking identical from the outside.
 */
export type StartStream = AgentStream & { worktree?: string };

/** The request as it arrives from Rust (`bsc://fleet-start`). */
export interface StartRequest {
  /** Correlates the ack. */
  id: string;
  projectKey: string;
  /** Whether to include a director at the hub. */
  director: boolean;
  streams: StartStream[];
  /** The absolute hub path, resolved in Rust (#905) so the launch never depends on the
   *  async-loaded `bscBaseDir` mirror — an empty one drops every session at the user root. */
  hubPath: string;
}

/** What we send back via `fleet_start_ack`. */
export interface StartAck {
  id: string;
  error?: string;
  launched: boolean;
}

export interface StartDeps {
  /** The real `fleetStartProject`. */
  fleetStartProject: (
    projectName: string,
    fleet: FleetPlan,
    projectKey: string,
    paths?: { hubPath?: string; worktreePaths?: Record<string, string> },
  ) => unknown;
}

/**
 * The FleetPlan for a resolved start request.
 *
 * `recommended` is the real worker count rather than a planner's advisory number: this launch is
 * exactly these streams, and a different figure on the tab would name workers no session backs.
 *
 * The streams pass through as the plan wrote them; only the launch-time `worktree` is stripped, since
 * it travels separately in `paths.worktreePaths` (which is the argument `fleetStartProject` reads).
 * The arrays are defaulted rather than assumed: a hand-written plan row can legitimately omit them,
 * and `fleetStartProject` indexes into all three.
 */
export function startPlan(req: StartRequest): FleetPlan {
  const streams: AgentStream[] = (req.streams ?? []).map(({ worktree: _worktree, ...s }) => ({
    ...s,
    name: s.name || s.id,
    owns: s.owns ?? [],
    issues: s.issues ?? [],
    dependsOn: s.dependsOn ?? [],
  }));
  return {
    recommended: streams.length,
    reasoning: `Fleet launched from the command line (bsc fleet start ${req.projectKey}).`,
    streams,
    director: { enabled: req.director },
  };
}

/** The worktree each stream already has, keyed by stream id — passed through so every pane's cwd is
 *  the absolute path Rust just created, never a re-derived guess. */
export function worktreePaths(req: StartRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of req.streams ?? []) {
    if (s.worktree) out[s.id] = s.worktree;
  }
  return out;
}

/**
 * Apply one fleet-start request. Never throws — every path produces an ack, because silence would
 * strand the Rust waiter until its timeout and surface as "the frontend did not launch the fleet",
 * sending someone to debug the wrong thing.
 */
export function applyFleetStart(req: StartRequest, deps: StartDeps): StartAck {
  const { id } = req;
  const projectKey = (req.projectKey ?? "").trim();
  if (!projectKey) return { id, error: "fleet start: no project key", launched: false };
  // Rust refuses this case before emitting, so reaching it means the two sides disagree — worth an
  // error rather than launching an empty tab.
  if (!req.director && (req.streams ?? []).length === 0) {
    return { id, error: `fleet start: nothing to launch for '${projectKey}'`, launched: false };
  }

  try {
    // The project's key doubles as its display name: `fleetStartProject` uses the first argument only
    // to NAME the tab (`<name> · build`), and the key is what the caller asked for.
    deps.fleetStartProject(projectKey, startPlan(req), projectKey, {
      hubPath: req.hubPath || undefined,
      worktreePaths: worktreePaths(req),
    });
    return { id, launched: true };
  } catch (err) {
    return {
      id,
      error: `fleet start: the launch threw: ${err instanceof Error ? err.message : String(err)}`,
      launched: false,
    };
  }
}
