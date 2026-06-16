import { describe, it, expect } from "vitest";
import { buildWorkerScope } from "./workerScope";
import type { AgentStream } from "./planSections";

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
    expect(md).toContain("**You depend on:** api");
  });

  it("is a scope, not the full plan — it points cross-cutting context at the director", () => {
    const md = buildWorkerScope(stream());
    expect(md).toContain("not the full plan");
    expect(md).toContain("defer to the director");
    // Sanity: it stays short (a lane, not a spec).
    expect(md.length).toBeLessThan(1200);
  });

  it("renders explicit placeholders for empty fields rather than leaving them blank", () => {
    const md = buildWorkerScope(stream({ owns: [], issues: [], dependsOn: [] }));
    expect(md).toContain("none assigned");
    expect(md).toContain("none yet");
    expect(md).toContain("**You depend on:** none");
  });
});
