import { describe, it, expect } from "vitest";
import {
  rollupChecks, isTerminalCi, ciWorkerPrompt, ciDirectorMergePrompt, ciDevelopRedPrompt, type CheckRun,
} from "./ciStatus";

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

describe("prompts", () => {
  it("worker passed prompt tells it to continue, not reopen", () => {
    const p = ciWorkerPrompt(42, "passed", []);
    expect(p).toMatch(/passed on your PR #42/);
    expect(p).toMatch(/continue with your next/i);
    expect(p).toMatch(/director will merge/i);
  });
  it("worker failed prompt names the failing checks and says fix + push", () => {
    const p = ciWorkerPrompt(42, "failed", ["test", "e2e"]);
    expect(p).toMatch(/FAILED on your PR #42/);
    expect(p).toContain("test, e2e");
    expect(p).toMatch(/fix the cause/i);
    expect(p).toMatch(/do not ask the user/i);
  });
  it("director merge prompt references the PR + branch", () => {
    const p = ciDirectorMergePrompt(42, "auth-ui");
    expect(p).toMatch(/PR #42/);
    expect(p).toContain("auth-ui");
    expect(p).toMatch(/merge/i);
  });
});

describe("ciDevelopRedPrompt (#378)", () => {
  it("names the repo, short sha, and failing checks, and tells the watchdog to revert + ping", () => {
    const p = ciDevelopRedPrompt("own/web", "abcdef1234567890", ["build", "test"]);
    expect(p).toMatch(/develop CI is RED in own\/web/);
    expect(p).toContain("abcdef1");
    expect(p).toContain("build, test");
    expect(p).toMatch(/REVERT/);
    expect(p).toMatch(/bsc-answer/);
  });
  it("falls back to a generic phrase when no failing checks are named", () => {
    const p = ciDevelopRedPrompt("own/web", "abcdef1234567890", []);
    expect(p).toMatch(/one or more checks/);
  });
});
