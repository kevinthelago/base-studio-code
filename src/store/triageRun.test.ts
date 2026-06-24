import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "./";
import { triagePaneId } from "../lib/console/paneIdentity";
import { sanitizeProjectKey } from "../lib/core/projectPaths";

// #1004: prepareTriageRun reads plan.db (last-run marker + changed-since delta), renders the resume
// lead, and stamps a fresh marker; triageStartProject leads each pane's prompt with that delta.
const mockInvoke = vi.mocked(invoke);
const issue = (ref: string, status: string) => ({
  ref, title: ref, status, acceptance: [], owns: [], dependsOn: [], labels: [],
});

describe("prepareTriageRun (#1004)", () => {
  beforeEach(() => mockInvoke.mockReset());

  it("first run (no marker) → empty lead, never queries changed-since, stamps a marker", async () => {
    mockInvoke.mockImplementation(async (cmd) => (cmd === "plan_triage_last_run" ? null : undefined));
    const deltas = await useAppStore.getState().prepareTriageRun("proj", ["o/web"]);
    expect(deltas["o/web"]).toBe("");
    expect(mockInvoke).not.toHaveBeenCalledWith("plan_issues_changed_since", expect.anything());
    expect(mockInvoke).toHaveBeenCalledWith("plan_triage_record_run", { projectKey: "proj", repo: "o/web" });
  });

  it("subsequent run → leads with the changed-issue delta and re-stamps", async () => {
    mockInvoke.mockImplementation(async (cmd) => {
      if (cmd === "plan_triage_last_run") return 1000;
      if (cmd === "plan_issues_changed_since") return [issue("F1", "complete"), issue("F2", "blocked")];
      return undefined;
    });
    const deltas = await useAppStore.getState().prepareTriageRun("proj", ["o/web"]);
    expect(deltas["o/web"]).toContain("2 issue(s) changed");
    expect(deltas["o/web"]).toContain("landed F1");
    expect(deltas["o/web"]).toContain("blocked/failed F2");
    expect(mockInvoke).toHaveBeenCalledWith("plan_issues_changed_since", { projectKey: "proj", repo: "o/web", since: 1000 });
    expect(mockInvoke).toHaveBeenCalledWith("plan_triage_record_run", { projectKey: "proj", repo: "o/web" });
  });

  it("a per-repo failure is non-fatal — the other repos still resolve", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mockInvoke.mockImplementation(async (cmd, args) => {
      if (cmd === "plan_triage_last_run") {
        if ((args as { repo: string }).repo === "o/bad") throw new Error("db locked");
        return null;
      }
      return undefined;
    });
    const deltas = await useAppStore.getState().prepareTriageRun("proj", ["o/bad", "o/good"]);
    expect(deltas["o/good"]).toBe("");
    expect(deltas["o/bad"]).toBeUndefined();
    err.mockRestore();
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
