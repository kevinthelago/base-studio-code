import { describe, it, expect } from "vitest";
import { buildWorkerScope } from "./workerScope";
import type { AgentStream } from "../stages/planSections";

const stream = (over: Partial<AgentStream> = {}): AgentStream => ({
  id: "auth-ui",
  name: "Auth UI",
  repo: "own/web",
  owns: ["src/auth/**", "src/login/**"],
  issues: ["#12", "#13"],
  dependsOn: ["api"],
  ...over,
});

describe("buildWorkerScope (#844)", () => {
  it("renders the stream's owned globs, issues, and dependencies", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("# Your scope — Auth UI");
    expect(md).toContain("`src/auth/**`");
    expect(md).toContain("`src/login/**`");
    expect(md).toContain("#12, #13");
    expect(md).toContain("branch `auth-ui`");
    expect(md).toContain("**You build against the contracts of:** api");
  });

  it("is a scope, not the full plan — it points cross-cutting context at the director", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("not the full plan");
    expect(md).toContain("defer to the director");
    // Sanity: it stays short (a lane, not a spec).
    expect(md.length).toBeLessThan(1400);
  });

  it("tells the worker the director closes issues — not to run gh issue close (#906)", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("director's job");
    expect(md).toContain("gh issue close");
    expect(md).toMatch(/let the director close it/i);
  });

  it("renders explicit placeholders for empty fields rather than leaving them blank", () => {
    const md = buildWorkerScope(stream({ owns: [], issues: [], dependsOn: [] }));
    expect(md).toContain("none assigned");
    expect(md).toContain("none yet");
    expect(md).toContain("**You build against the contracts of:** none");
  });

  it("appends the locked dependency manifest for the worker's repo when present (#1111)", () => {
    const md = buildWorkerScope(stream(), [
      { ecosystem: "npm", name: "zod", version: "^3.23", why: "validation" },
      { ecosystem: "cargo", name: "serde", version: "1" },
    ]);
    expect(md).toContain("## Dependencies (locked by the planner)");
    expect(md).toContain("`zod@^3.23`");
    expect(md).toContain("`serde@1`");
    expect(md).toMatch(/Do NOT add to or\s*\n?\s*edit/);
  });

  it("omits the dependency block entirely when the repo has no locked deps", () => {
    expect(buildWorkerScope(stream())).not.toContain("Dependencies (locked");
    expect(buildWorkerScope(stream(), [])).not.toContain("Dependencies (locked");
  });
});
