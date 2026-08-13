// fleetDirectorBridge (#architect-creates-a-director-with-discovery) — decide what a
// `bsc fleet director new` request does to the store.
//
// Pure on purpose: the DECISION is testable without Tauri or a rendered app, and the listener stays a
// thin adapter — the same split `fleetWakeBridge` and `systemSessionBridge` use.
//
// WHY IT BUILDS A FleetPlan INSTEAD OF PLACING A PANE ITSELF
// A director is not just a pane: it is a cwd at the project hub, a `director-kickoff.md` startup doc,
// a checkpoint doc, a `director` role, a director DRIVE and a director MODE, on a pane id the rest of
// the app already knows how to find. All of that lives in `fleetStartProject`, which is exercised by
// every real fleet launch. Reimplementing the subset here would be a second launch path that drifts
// from the first — the "superseded but never removed" duplication this codebase has paid for more
// than once. So this constructs the SMALLEST honest FleetPlan (a director, no streams) and hands it
// to the path that already works.
//
// The plan is a launch input, not a stored one: nothing here writes plan.db, so a project whose real
// fleet has ten streams keeps them. Launching the full fleet later rebuilds the tab in place.

// The deep type path, matching `AppBanners` (the other shell-side fleet launcher): a cross-feature
// `import type` is allowed, and `FleetPlan` is not on the planner barrel.
import type { FleetPlan } from "@/features/planner/fleet/planFleet";

/** The request as it arrives from Rust (`bsc://fleet-director`). */
export interface DirectorRequest {
  /** Correlates the ack. */
  id: string;
  projectKey: string;
  /** `<projectKey>:director` — resolved in Rust so create/list/brief share one spelling. */
  paneId: string;
  /** The absolute hub path, resolved in Rust (#905) so the launch never depends on the
   *  async-loaded `bscBaseDir` mirror — an empty one drops the session at the user root. */
  hubPath: string;
}

/** What we send back via `fleet_director_ack`. */
export interface DirectorAck {
  id: string;
  error?: string;
  created: boolean;
}

/**
 * The store surface this needs — narrowed so the pure fn stays decoupled from the slice.
 */
export interface DirectorDeps {
  /** The real `fleetStartProject`. */
  fleetStartProject: (
    projectName: string,
    fleet: FleetPlan,
    projectKey: string,
    paths?: { hubPath?: string; worktreePaths?: Record<string, string> },
  ) => unknown;
}

/**
 * The smallest honest fleet: a director and nothing else.
 *
 * `recommended: 0` and an empty `streams` are the TRUTH here, not placeholders — this launch is not a
 * fleet, and claiming a worker count would put a number on the tab that no session backs. `reasoning`
 * is carried because it is what a later reader sees when asking why this tab has one pane.
 */
export function directorOnlyPlan(): FleetPlan {
  return {
    recommended: 0,
    reasoning:
      "Director created on its own by the architect (bsc fleet director new) — no worker streams " +
      "were launched with it.",
    streams: [],
    director: { enabled: true },
  };
}

/**
 * Apply one director-create request. Never throws — every path produces an ack, because silence would
 * strand the Rust waiter until its timeout and surface as "the frontend did not create the director",
 * sending someone to debug the wrong thing.
 *
 * Rust has already settled everything checkable before this runs: the project exists, no director is
 * live, and the kickoff is on disk. What is left is the launch.
 */
export function applyDirectorNew(req: DirectorRequest, deps: DirectorDeps): DirectorAck {
  const { id } = req;
  const projectKey = (req.projectKey ?? "").trim();
  if (!projectKey) return { id, error: "fleet director: no project key", created: false };

  try {
    // The project's own key doubles as its display name here. `fleetStartProject` uses the first
    // argument only to NAME the tab (`<name> · build`), and the key is what the architect asked for —
    // a prettier title would have to come from a store read this pure function deliberately avoids.
    deps.fleetStartProject(projectKey, directorOnlyPlan(), projectKey, { hubPath: req.hubPath || undefined });
    return { id, created: true };
  } catch (err) {
    return {
      id,
      error: `fleet director: the launch threw: ${err instanceof Error ? err.message : String(err)}`,
      created: false,
    };
  }
}
