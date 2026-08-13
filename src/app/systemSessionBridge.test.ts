import { describe, it, expect, vi } from "vitest";
import { applyLifecycle, type LifecycleRequest, type LifecycleDeps } from "./systemSessionBridge";
import { STUDIO_SESSIONS } from "@/features/studio-sessions";

/** A request with the shape Rust emits. */
function req(over: Partial<LifecycleRequest> = {}): LifecycleRequest {
  return {
    id: "r1",
    sessionId: "designer",
    paneId: STUDIO_SESSIONS.designer.paneId,
    action: "start",
    ptyLive: false,
    ...over,
  };
}

function deps(over: Partial<LifecycleDeps> = {}): LifecycleDeps & {
  openStudio: ReturnType<typeof vi.fn>;
  closeStudio: ReturnType<typeof vi.fn>;
  killPane: ReturnType<typeof vi.fn>;
} {
  return {
    wantedStudios: [],
    openStudio: vi.fn(),
    closeStudio: vi.fn(),
    killPane: vi.fn(async () => {}),
    ...over,
  } as never;
}

describe("applyLifecycle — start", () => {
  it("starts a session that is not running", async () => {
    const d = deps();
    const ack = await applyLifecycle(req(), d);
    expect(ack.outcome).toBe("started");
    expect(d.openStudio).toHaveBeenCalledWith("designer");
  });

  it("reports a no-op rather than a fresh start when the studio is already mounted", async () => {
    // The #4025 shape: a caller told "started" waits on a session it did not create. A singleton pane
    // cannot host two sessions, so the honest answer is that nothing was needed.
    const d = deps({ wantedStudios: ["designer"] });
    const ack = await applyLifecycle(req(), d);
    expect(ack.outcome).toBe("already-running");
    expect(d.openStudio).not.toHaveBeenCalled();
  });

  it("counts a stray PTY as running even when nothing is mounted", async () => {
    // `TerminalView`'s unmount leaves the backend session alive on purpose, so a PTY can outlive its
    // mount. Deciding on `wantedStudios` alone would report a start that only re-mounted.
    const d = deps({ wantedStudios: [], ptyLive: true } as never);
    const ack = await applyLifecycle(req({ ptyLive: true }), d);
    expect(ack.outcome).toBe("already-running");
    expect(d.openStudio).not.toHaveBeenCalled();
  });

  it("never kills anything on the start path", async () => {
    const d = deps();
    await applyLifecycle(req(), d);
    expect(d.killPane).not.toHaveBeenCalled();
  });
});

describe("applyLifecycle — stop", () => {
  it("stops a running session and reports the change", async () => {
    const d = deps({ wantedStudios: ["designer"] });
    const ack = await applyLifecycle(req({ action: "stop" }), d);
    expect(ack.outcome).toBe("stopped");
    expect(d.killPane).toHaveBeenCalledWith(STUDIO_SESSIONS.designer.paneId);
    expect(d.closeStudio).toHaveBeenCalledWith("designer");
  });

  it("reclaims a stray PTY and reports it as stopped, not as a no-op", async () => {
    // The case that makes the OR load-bearing: nothing mounted, a process still alive. Reporting
    // "not-running" here would tell the caller there was nothing to reclaim while a `claude` was up.
    const d = deps({ wantedStudios: [] });
    const ack = await applyLifecycle(req({ action: "stop", ptyLive: true }), d);
    expect(ack.outcome).toBe("stopped");
    expect(d.killPane).toHaveBeenCalled();
  });

  it("reports not-running when there is neither a mount nor a PTY", async () => {
    const d = deps();
    const ack = await applyLifecycle(req({ action: "stop" }), d);
    expect(ack.outcome).toBe("not-running");
  });

  it("does not fail the stop when the kill throws", async () => {
    // The common reason a kill fails is that there was nothing to kill. Aborting the stop for that
    // would leave the studio mounted after the caller was told to expect otherwise.
    const d = deps({ wantedStudios: ["designer"], killPane: vi.fn(async () => { throw new Error("no session"); }) } as never);
    const ack = await applyLifecycle(req({ action: "stop" }), d);
    expect(ack.outcome).toBe("stopped");
    expect(ack.error).toBeUndefined();
    expect(d.closeStudio).toHaveBeenCalled();
  });
});

describe("applyLifecycle — the closed set", () => {
  it.each(["studio-code:director", "director", "worker", "", "Designer", "design-studio:designer"])(
    "refuses %o rather than acting on it",
    async (sessionId) => {
      const d = deps();
      const ack = await applyLifecycle(req({ sessionId, action: "stop" }), d);
      expect(ack.error).toBeTruthy();
      expect(ack.outcome).toBeUndefined();
      expect(d.openStudio).not.toHaveBeenCalled();
      expect(d.closeStudio).not.toHaveBeenCalled();
      expect(d.killPane).not.toHaveBeenCalled();
    },
  );

  it("accepts every id in the app's own registry", async () => {
    for (const def of Object.values(STUDIO_SESSIONS)) {
      const ack = await applyLifecycle(req({ sessionId: def.id, paneId: def.paneId }), deps());
      expect(ack.error, `${def.id} must resolve`).toBeUndefined();
      expect(ack.outcome).toBe("started");
    }
  });

  it("always echoes the request id back, so the Rust waiter is never stranded", async () => {
    for (const sessionId of ["designer", "nonsense"]) {
      const ack = await applyLifecycle(req({ id: "corr-7", sessionId }), deps());
      expect(ack.id).toBe("corr-7");
    }
  });
});
