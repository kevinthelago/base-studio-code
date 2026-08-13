import { describe, it, expect } from "vitest";
import { rollupChecks, isTerminalCi, type CheckRun } from "./ciStatus";

const run = (name: string, status: string, conclusion: string | null = null): CheckRun => ({ name, status, conclusion });

describe("rollupChecks (#373)", () => {
  it("returns none when there are no checks", () => {
    expect(rollupChecks([])).toEqual({ state: "none", failing: [] });
  });
  it("is pending while any run is not completed", () => {
    expect(rollupChecks([run("build", "completed", "success"), run("test", "in_progress")]).state).toBe("pending");
  });
  it("passes when every completed run is success/neutral/skipped", () => {
    const r = rollupChecks([run("build", "completed", "success"), run("lint", "completed", "neutral"), run("opt", "completed", "skipped")]);
    expect(r).toEqual({ state: "passed", failing: [] });
  });
  it("fails and lists the failing checks", () => {
    const r = rollupChecks([run("build", "completed", "success"), run("test", "completed", "failure"), run("e2e", "completed", "timed_out")]);
    expect(r.state).toBe("failed");
    expect(r.failing).toEqual(["test", "e2e"]);
  });
  it("treats a null conclusion on a completed run as failing (defensive)", () => {
    expect(rollupChecks([run("x", "completed", null)]).state).toBe("failed");
  });
});

describe("isTerminalCi", () => {
  it("is true only for passed/failed", () => {
    expect(isTerminalCi("passed")).toBe(true);
    expect(isTerminalCi("failed")).toBe(true);
    expect(isTerminalCi("pending")).toBe(false);
    expect(isTerminalCi("none")).toBe(false);
  });
});

// The "prompts" and "ciDevelopRedPrompt" suites were DELETED with their subjects
// (#coord-prefix-names-the-sender). rollupChecks/isTerminalCi above are the module's surviving
// behaviour — they read GitHub check runs and say nothing to anybody.
