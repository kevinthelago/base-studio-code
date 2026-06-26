import { describe, it, expect, vi } from "vitest";
import { dispatchAutomation, type DispatchDeps } from "./dispatch";
import type { Automation, AutomationRun } from "./scheduler";

function auto(over: Partial<Automation> = {}): Automation {
  return {
    id: "a1", name: "Nightly", armed: true,
    when: { kind: "cron", expr: "0 2 * * *" },
    targetTab: "build", targetPaneIdx: 0,
    action: "command", command: "npm test",
    lastRunAt: null, nextRunAt: null, runs: [],
    ...over,
  };
}

function deps(over: Partial<DispatchDeps> = {}): DispatchDeps {
  return {
    tabs: [{ name: "build", layout: "2×2" }],
    disabledPanes: {},
    write: vi.fn().mockResolvedValue(undefined),
    recordRun: vi.fn(),
    now: () => 1000,
    ...over,
  };
}

describe("dispatchAutomation (#937)", () => {
  it("writes a command into the resolved pane and records an ok run", async () => {
    const d = deps();
    await dispatchAutomation(auto(), d);
    expect(d.write).toHaveBeenCalledWith("t0p0", "npm test\r");
    expect(d.recordRun).toHaveBeenCalledWith("a1", expect.objectContaining({ at: 1000, status: "ok" }));
  });

  it("skips (no write) when the target pane isn't open", async () => {
    const d = deps({ tabs: [] });
    await dispatchAutomation(auto(), d);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.recordRun).toHaveBeenCalledWith("a1", expect.objectContaining({ status: "skipped" }));
  });

  it("fails (no write) on an empty command", async () => {
    const d = deps();
    await dispatchAutomation(auto({ command: "   " }), d);
    expect(d.write).not.toHaveBeenCalled();
    expect(d.recordRun).toHaveBeenCalledWith("a1", expect.objectContaining({ status: "fail", note: "empty command" }));
  });

  it("records a failed run (never throws) when the write rejects", async () => {
    let recorded: AutomationRun | undefined;
    const d = deps({
      write: vi.fn().mockRejectedValue(new Error("pty gone")),
      recordRun: (_id: string, run: AutomationRun) => { recorded = run; },
    });
    await dispatchAutomation(auto(), d);
    expect(recorded?.status).toBe("fail");
    expect(recorded?.note).toContain("pty gone");
  });
});
