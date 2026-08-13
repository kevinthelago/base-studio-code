// systemSessionBridge (#architect-starts-and-stops-system-sessions) — decide what a `bsc session
// start|stop` request does to the store.
//
// Pure on purpose: the DECISION (is it already running, what changed, what to report) is testable
// without Tauri or a rendered app, and the listener stays a thin adapter — the same split
// `fleetWakeBridge` and `navigateBridge` use.
//
// WHY THE OUTCOME IS FOUR-VALUED AND NOT A BOOLEAN
// A system session is a SINGLETON on a fixed pane id, so `start` on one that is already up changes
// nothing. Reporting that as a plain success is the #4025 shape: the caller believes it created
// something and waits on a session it did not. So the no-ops are named — `already-running` and
// `not-running` — and only `started`/`stopped` claim a change.
//
// WHY "RUNNING" IS `wanted || ptyLive` AND NOT EITHER ALONE
// `wantedStudios` is what the frontend has MOUNTED; a PTY is what is actually alive. They can
// disagree, because `TerminalView`'s unmount deliberately leaves the backend session alive so a
// tab-switch reconnects rather than respawns — so a stray PTY can outlive its mount. Deciding on
// `wanted` alone would report "not running" while a `claude` process was still up, and then `stop`
// would leave it there; deciding on `ptyLive` alone would miss a mount that has not spawned yet.
// Rust measures the PTY (the store cannot see one) and sends it along; this ORs the two.

import { isStudioId, type StudioId } from "@/features/studio-sessions";

/** The lifecycle request as it arrives from Rust (`bsc://session-lifecycle`). */
export interface LifecycleRequest {
  /** Correlates the ack. */
  id: string;
  /** The system session's id — already resolved against the closed registry, on BOTH sides. */
  sessionId: string;
  /** Its fixed, app-owned pane id. */
  paneId: string;
  action: "start" | "stop";
  /** Whether a PTY exists for `paneId`, measured in Rust just before the emit. */
  ptyLive: boolean;
}

/** What we send back via `system_session_ack`. Kebab-case matches the Rust `LifecycleOutcome`. */
export type LifecycleOutcome = "started" | "already-running" | "stopped" | "not-running";

export interface LifecycleAck {
  id: string;
  error?: string;
  outcome?: LifecycleOutcome;
}

/**
 * The store surface this needs — narrowed so the pure fn stays decoupled from the slice.
 */
export interface LifecycleDeps {
  /** The studios currently mounted/warm (`wantedStudios`). */
  wantedStudios: readonly StudioId[];
  /** `openStudio` — marks it wanted; `StudioSessionHosts` mounts its TerminalSlot. */
  openStudio: (id: StudioId) => void;
  /** `closeStudio` — drops it from the wanted list, unmounting its host claim. */
  closeStudio: (id: StudioId) => void;
  /** `pty_kill` for the pane. A no-op when there is no PTY, which is why it is safe to call
   *  unconditionally rather than probing first — Rust already owns the liveness answer. */
  killPane: (paneId: string) => Promise<void>;
}

/**
 * Apply one lifecycle request. Never throws — every path produces an ack, because silence would
 * strand the Rust waiter until its timeout and surface as "the frontend did not apply the start",
 * sending someone to debug the wrong thing.
 *
 * The id is re-narrowed to a `StudioId` here even though Rust resolved it against the same closed
 * set: this is the last point where a string becomes a store action, and `isStudioId` is what keeps
 * the two registries honest at runtime as well as at gate time (`systemSessionRegistry.test.ts`
 * pins them statically).
 */
export async function applyLifecycle(req: LifecycleRequest, deps: LifecycleDeps): Promise<LifecycleAck> {
  const { id } = req;
  const sessionId = (req.sessionId ?? "").trim();
  if (!isStudioId(sessionId)) {
    return {
      id,
      error:
        `session lifecycle: '${sessionId}' is not a known system session in this app build — ` +
        `the CLI's registry and the app's have drifted apart.`,
    };
  }
  const studio: StudioId = sessionId;
  const running = deps.wantedStudios.includes(studio) || req.ptyLive;

  if (req.action === "start") {
    if (running) return { id, outcome: "already-running" };
    // Nothing else is needed: `openStudio` is the whole start. The mount reads the studio's launch
    // inputs from `STUDIO_SESSIONS` and its stable pane id means the session RESUMES its previous
    // conversation rather than beginning blank.
    deps.openStudio(studio);
    return { id, outcome: "started" };
  }

  // STOP. The kill runs even when nothing is `wanted`, because a stray PTY that outlived its mount is
  // exactly the case a caller means to reclaim — and `pty_kill` on an absent session is a no-op. The
  // OUTCOME still reports what was true before, so "not-running" never hides a process that was
  // actually killed: `running` is the OR, so a stray PTY reads as running and reports `stopped`.
  await deps.killPane(req.paneId).catch(() => {});
  deps.closeStudio(studio);
  return { id, outcome: running ? "stopped" : "not-running" };
}
