import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./";
import { triagePaneId } from "@/app/console/lib/paneIdentity";
import { sanitizeProjectKey } from "@/shared/lib/core/projectPaths";

// #1004: prepareTriageRun reads plan.db (last-run marker + changed-since delta), renders the resume
// lead, and stamps a fresh marker; triageStartProject leads each pane's prompt with that delta.
const mockInvoke = vi.mocked(invoke);
const issue = (ref: string, status: string) => ({
  ref, title: ref, status, acceptance: [], owns: [], dependsOn: [], labels: [],
});

describe("prepareTriageRun (#1004)", () => {
  beforeEach(() => mockInvoke.mockReset());

  // The triage markers now route through the `bsc` bridge (#2114): the reads are `bsc plan triage
  // last|changed|record`, dispatched via `invoke("bsc", { projectKey, args })` and JSON-parsed from
  // stdout by bscJson (so the mock returns a JSON STRING, "" for a void verb).
  const triageArgs = (args: unknown): string[] => (args as { args?: string[] }).args ?? [];

  it("first run (no marker) → empty lead, never queries changed-since, stamps a marker", async () => {
    mockInvoke.mockImplementation(async (_cmd, args) =>
      triageArgs(args)[2] === "last" ? JSON.stringify(null) : "");
    const deltas = await useAppStore.getState().prepareTriageRun("proj", ["o/web"]);
    expect(deltas["o/web"]).toBe("");
    expect(mockInvoke).not.toHaveBeenCalledWith("bsc", expect.objectContaining({ args: expect.arrayContaining(["changed"]) }));
    expect(mockInvoke).toHaveBeenCalledWith("bsc", { projectKey: "proj", args: ["plan", "triage", "record", "o/web"] });
  });

  it("subsequent run → leads with the changed-issue delta and re-stamps", async () => {
    mockInvoke.mockImplementation(async (_cmd, args) => {
      const a = triageArgs(args);
      if (a[2] === "last") return JSON.stringify(1000);
      if (a[2] === "changed") return JSON.stringify([issue("F1", "complete"), issue("F2", "blocked")]);
      return "";
    });
    const deltas = await useAppStore.getState().prepareTriageRun("proj", ["o/web"]);
    expect(deltas["o/web"]).toContain("2 issue(s) changed");
    expect(deltas["o/web"]).toContain("landed F1");
    expect(deltas["o/web"]).toContain("blocked/failed F2");
    expect(mockInvoke).toHaveBeenCalledWith("bsc", { projectKey: "proj", args: ["plan", "triage", "changed", "o/web", "--since", "1000"] });
    expect(mockInvoke).toHaveBeenCalledWith("bsc", { projectKey: "proj", args: ["plan", "triage", "record", "o/web"] });
  });

  it("a per-repo bsc failure degrades to the fallback (non-fatal) — the other repos still resolve", async () => {
    mockInvoke.mockImplementation(async (_cmd, args) => {
      const a = triageArgs(args);
      if (a[2] === "last") {
        // bscJson swallows a rejected read and returns its fallback (null), so a broken repo no
        // longer aborts — it renders the empty (full-prompt) lead like a first run.
        if (a[3] === "o/bad") throw new Error("db locked");
        return JSON.stringify(null);
      }
      return "";
    });
    const deltas = await useAppStore.getState().prepareTriageRun("proj", ["o/bad", "o/good"]);
    expect(deltas["o/good"]).toBe("");
    expect(deltas["o/bad"]).toBe("");
  });
});

describe("triageStartProject deltas (#1004)", () => {
  it("leads the default triage prompt with the supplied per-repo delta", () => {
    useAppStore.getState().triageStartProject("dproj", ["o/web"], "", {
      "o/web": "RESUME: since your last triage, 1 issue(s) changed.",
    });
    const st = useAppStore.getState();
    const text = st.paneStartupPromptText[triagePaneId(sanitizeProjectKey("dproj"), "o/web")];
    expect(text.startsWith("RESUME: since your last triage")).toBe(true);
    expect(text).toContain("You are triaging"); // the full prompt still follows the lead
  });
});
