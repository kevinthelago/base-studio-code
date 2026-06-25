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
    // Sanity: it stays short (a lane, not a spec). The commons-ownership note (#851) is part of
    // the lane, so the budget accommodates it while still being far shy of the full plan.
    expect(md.length).toBeLessThan(1700);
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

  it("tells the worker the commons are the director's and to request changes (#851)", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("Repo-root commons are the director's, not yours");
    expect(md).toContain("`bsc-ask`");
  });

  it("surfaces the commons-landed gate as a note, NOT as a peer contract dependency (#851)", () => {
    const md = buildWorkerScope(stream({ dependsOn: ["api", "commons"] }));
    // The contracts line lists real seams only — the commons sentinel is filtered out of it.
    expect(md).toMatch(/build against the contracts of:\*\* api\b/i);
    expect(md).not.toMatch(/contracts of:\*\* [^\n]*commons/i);
    // …and the commons note acknowledges it's already scaffolded.
    expect(md).toContain("already scaffolded on develop");
  });
});
