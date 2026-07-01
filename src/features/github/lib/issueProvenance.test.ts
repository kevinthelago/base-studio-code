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

  it("the restrictToBscIssues setting is ON by default and toggles", () => {
    expect(useAppStore.getState().restrictToBscIssues).toBe(true); // secure by default
    useAppStore.getState().setRestrictToBscIssues(false);
    expect(useAppStore.getState().restrictToBscIssues).toBe(false);
    useAppStore.getState().setRestrictToBscIssues(true);
  });

  it("triageStartProject seeds the restricted prompt by default (#738)", () => {
    useAppStore.setState({ bscBaseDir: "/base", restrictToBscIssues: true });
    useAppStore.getState().triageStartProject("Proj", ["acme/web"], "k");
    const texts = Object.values(useAppStore.getState().paneStartupPromptText);
    expect(texts.some((t) => typeof t === "string" && t.includes(BSC_ISSUE_LABEL))).toBe(true);
  });
});
