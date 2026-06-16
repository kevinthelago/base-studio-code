import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { runCleanupScan } from "../screens/projects/cleanupScan";
import { useAppStore } from "../store";
import { makeBlueprints } from "../screens/projects/blueprints";

// Route invoke by command: the JS scanners return one unused dep/export each; kb_chat
// (verification) confirms them.
function routeInvoke() {
  vi.mocked(invoke).mockImplementation(((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "scan_dead_code") {
      const tool = args?.tool as string;
      if (tool === "depcheck") return Promise.resolve({ tool, ran: true, stdout: JSON.stringify({ dependencies: ["lodash"] }), stderr: "", error: null });
      if (tool === "ts-prune") return Promise.resolve({ tool, ran: true, stdout: "src/a.ts:1 - Foo", stderr: "", error: null });
      return Promise.resolve({ tool, ran: false, stdout: "", stderr: "", error: "not a js scanner here" });
    }
    if (cmd === "kb_chat") {
      return Promise.resolve({ content: [{ type: "text", text: JSON.stringify([{ verdict: "confirmed", reason: "no refs" }, { verdict: "confirmed", reason: "no refs" }]) }] });
    }
    return Promise.resolve(null);
  }) as unknown as typeof invoke);
}

describe("runCleanupScan (#626 slice c)", () => {
  beforeEach(() => { vi.mocked(invoke).mockReset(); useAppStore.setState({ sectionGrades: {} }); });

  it("scans js tools, leaves candidates uncertain without an API key, persists the grade", async () => {
    routeInvoke();
    const out = await runCleanupScan({ projectKey: "p", sectionKey: "cleanup", repoPath: "/r", stack: "js" });
    expect(out.scanned).toBe(2); // lodash + Foo
    expect(out.grade.graderId).toBe("cleanup");
    // no key ⇒ candidates stay uncertain ⇒ score is dinged for review, not a clean A (#688);
    // two kinds each with one uncertain candidate → 95
    expect(out.grade.score).toBe(95);
    expect(out.grade.findings.every((f) => f.fix !== "safe to remove")).toBe(true);
    expect(useAppStore.getState().sectionGrades["p"]["cleanup"][0].graderId).toBe("cleanup");
  });

  it("with an API key, verifies + confirms candidates (lowers the score)", async () => {
    routeInvoke();
    const out = await runCleanupScan({ projectKey: "p", sectionKey: "cleanup", repoPath: "/r", stack: "js", apiKey: "sk-x" });
    expect(out.scanned).toBe(2);
    expect(out.grade.score).toBeLessThan(100);
    expect(out.grade.findings.filter((f) => f.fix === "safe to remove")).toHaveLength(2);
  });

  it("collects scanner errors without throwing", async () => {
    vi.mocked(invoke).mockResolvedValue({ tool: "depcheck", ran: false, stdout: "", stderr: "", error: "npx not found" });
    const out = await runCleanupScan({ projectKey: "p", sectionKey: "cleanup", repoPath: "/r", stack: "js" });
    expect(out.scanned).toBe(0);
    expect(out.errors.length).toBeGreaterThan(0);
  });
});

describe("Refactor blueprint (#626 slice c)", () => {
  it("is a built-in blueprint with a cleanup stage carrying the scan pipeline", () => {
    const refactor = makeBlueprints().find((b) => b.id === "refactor");
    expect(refactor).toBeTruthy();
    expect(refactor!.origin).toBe("built-in");
    const cleanup = refactor!.sections.find((s) => s.key === "cleanup");
    expect(cleanup).toBeTruthy();
    expect(cleanup!.pipelines.map((p) => p.id)).toContain("scan-dead-code");
  });
});
