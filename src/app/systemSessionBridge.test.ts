// `bsc session start|stop` for a SYSTEM session (`system-sessions-run-projects-and-start-when-visited`).
// Before this slice the bridge knew only studio ids, so `bsc session start tutor-local` came back as the
// registry-drift error; these pin that a system session is started by making it WANTED (its host mount does
// the rest), and stopped by killing its pane and dropping it.
import { describe, it, expect, vi } from "vitest";
import { applyLifecycle, type LifecycleDeps, type LifecycleRequest } from "@/app/systemSessionBridge";

function deps(over: Partial<LifecycleDeps> = {}): LifecycleDeps {
  return {
    wantedStudios: [],
    openStudio: vi.fn(),
    closeStudio: vi.fn(),
    setPendingDirective: vi.fn(),
    killPane: vi.fn(async () => {}),
    wantedSystemSessions: [],
    openSystemSession: vi.fn(),
    closeSystemSession: vi.fn(),
    ...over,
  };
}

const req = (over: Partial<LifecycleRequest>): LifecycleRequest => ({
  id: "r1", sessionId: "tutor-local", paneId: "system-session:tutor-local", action: "start", ptyLive: false, ...over,
});

describe("applyLifecycle for a system session", () => {
  it("start makes it wanted and touches no studio", async () => {
    const d = deps();
    expect(await applyLifecycle(req({}), d)).toEqual({ id: "r1", outcome: "started" });
    expect(d.openSystemSession).toHaveBeenCalledWith("tutor-local");
    expect(d.openStudio).not.toHaveBeenCalled();
  });

  it("start on a wanted or live one is already-running and changes nothing", async () => {
    const wanted = deps({ wantedSystemSessions: ["tutor-claude"] });
    expect((await applyLifecycle(req({ sessionId: "tutor-claude", paneId: "system-session:tutor-claude" }), wanted)).outcome)
      .toBe("already-running");
    const live = deps();
    expect((await applyLifecycle(req({ ptyLive: true }), live)).outcome).toBe("already-running");
    expect(wanted.openSystemSession).not.toHaveBeenCalled();
    expect(live.openSystemSession).not.toHaveBeenCalled();
  });

  it("stop kills its pane and drops it", async () => {
    const d = deps({ wantedSystemSessions: ["tutor-local"] });
    expect(await applyLifecycle(req({ action: "stop" }), d)).toEqual({ id: "r1", outcome: "stopped" });
    expect(d.killPane).toHaveBeenCalledWith("system-session:tutor-local");
    expect(d.closeSystemSession).toHaveBeenCalledWith("tutor-local");
    expect(d.closeStudio).not.toHaveBeenCalled();
  });

  it("a session is started by its id, never by its pane id", async () => {
    const d = deps();
    const ack = await applyLifecycle(req({ sessionId: "system-session:tutor-local" }), d);
    expect(ack.error).toMatch(/not a known studio or system session/);
    expect(d.openSystemSession).not.toHaveBeenCalled();
  });
});
