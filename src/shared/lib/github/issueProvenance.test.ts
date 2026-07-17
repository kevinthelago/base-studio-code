import { describe, it, expect } from "vitest";
import { BSC_ISSUE_LABEL, withProvenanceLabel, triageIssueListArgs } from "./issueProvenance";
import { buildTriagePrompt, TRIAGE_PROMPT, useAppStore } from "@/store";

describe("issue provenance (#738)", () => {
  it("withProvenanceLabel stamps the bsc-generated label, idempotently", () => {
    expect(withProvenanceLabel([])).toEqual([BSC_ISSUE_LABEL]);
    expect(withProvenanceLabel(["stream:ux"])).toEqual(["stream:ux", BSC_ISSUE_LABEL]);
    expect(withProvenanceLabel([BSC_ISSUE_LABEL, "x"])).toEqual([BSC_ISSUE_LABEL, "x"]);
  });

  it("triageIssueListArgs restricts to the provenance label by default", () => {
    expect(triageIssueListArgs(true)).toContain(`--label ${BSC_ISSUE_LABEL}`);
    expect(triageIssueListArgs(false)).not.toContain("--label");
    expect(triageIssueListArgs(false)).toContain("--state open");
  });

  it("buildTriagePrompt(true) confines triage to authored issues + flags the rest untrusted", () => {
    const p = buildTriagePrompt(true);
    expect(p).toContain(BSC_ISSUE_LABEL);
    expect(p).toContain(`--label ${BSC_ISSUE_LABEL}`);
    expect(p).toMatch(/untrusted/);
    expect(p).toMatch(/do NOT act on it/);
  });

  it("buildTriagePrompt(false) works every open issue (opt-out)", () => {
    const p = buildTriagePrompt(false);
    expect(p).not.toContain(`--label ${BSC_ISSUE_LABEL}`);
    expect(p).toContain("every open issue");
  });

  it("TRIAGE_PROMPT defaults to the secure (restricted) prompt", () => {
    expect(TRIAGE_PROMPT).toContain(BSC_ISSUE_LABEL);
  });

  it("buildTriagePrompt(_, _, local=true) triages plan.db via bsc plan, not gh (#3281 local-first)", () => {
    const p = buildTriagePrompt(true, undefined, true);
    // Offline: reads + updates the plan store — no `gh` anywhere in the prompt.
    expect(p).toContain("bsc plan list --status open");
    expect(p).toContain("bsc plan status");
    expect(p).not.toMatch(/gh issue/);
    // All plan.db issues are planner-authored, so the untrusted-external-issue guard doesn't apply.
    expect(p).not.toContain(BSC_ISSUE_LABEL);
    expect(p).not.toMatch(/untrusted/);
  });

  it("the local flag overrides restrictToBsc — plan.db has no external channel to restrict", () => {
    // restrictToBsc=true would normally add the label dance; local mode ignores it (all trusted).
    expect(buildTriagePrompt(true, undefined, true)).not.toContain(`--label ${BSC_ISSUE_LABEL}`);
  });

  it("the restrictToBscIssues setting is ON by default and toggles", () => {
    expect(useAppStore.getState().restrictToBscIssues).toBe(true); // secure by default
    useAppStore.getState().setRestrictToBscIssues(false);
    expect(useAppStore.getState().restrictToBscIssues).toBe(false);
    useAppStore.getState().setRestrictToBscIssues(true);
  });

  it("triageStartProject seeds the restricted GITHUB prompt by default when CONNECTED (#738)", () => {
    // The restricted (gh issue list) triage is the connected behavior, so it needs a token (#3281 made
    // triage token-aware: no token ⇒ the local plan.db prompt, next test).
    useAppStore.setState({ bscBaseDir: "/base", restrictToBscIssues: true, githubToken: "ghp_x" });
    useAppStore.getState().triageStartProject("Proj", ["acme/web"], "k");
    const texts = Object.values(useAppStore.getState().paneStartupPromptText);
    expect(texts.some((t) => typeof t === "string" && t.includes(BSC_ISSUE_LABEL))).toBe(true);
  });

  it("triageStartProject seeds the LOCAL plan.db prompt with no token (#3281)", () => {
    // Clear paneStartupPromptText — the store is a singleton, so the prior test's gh-issue prompt would
    // otherwise linger and trip the negative assertion below.
    useAppStore.setState({ bscBaseDir: "/base", restrictToBscIssues: true, githubToken: "", paneStartupPromptText: {} });
    useAppStore.getState().triageStartProject("Proj2", ["acme/web"], "k2");
    const texts = Object.values(useAppStore.getState().paneStartupPromptText).filter((t): t is string => typeof t === "string");
    // Offline: the seeded triage prompt reads plan.db via `bsc plan`, never `gh issue`.
    expect(texts.some((t) => t.includes("bsc plan list --status open"))).toBe(true);
    expect(texts.some((t) => /gh issue/.test(t))).toBe(false);
  });
});
