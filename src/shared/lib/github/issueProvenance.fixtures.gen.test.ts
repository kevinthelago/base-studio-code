// Issue PROVENANCE, captured from the live TypeScript so Rust can be proved to match.
//
// This is the untrusted-issue channel (#738). A triage session runs `gh issue list` over every open
// issue in a repo, so an issue nobody in this system authored can otherwise be picked up and acted
// on by an agent. base-studio-code stamps the issues it publishes with a distinctive label and
// restricts triage to that label BY DEFAULT.
//
// Caveat carried over from the source, because a port that "hardens" it would be lying: the label is
// FORGEABLE by anyone with repo write access. This stops accidental and hand-created pickup and
// raises the bar; it is not a cryptographic guarantee.
//
// ## What a port drifts on
//
//   * `withProvenanceLabel` is IDEMPOTENT and ORDER-PRESERVING — the label is appended, never
//     inserted, and never duplicated. A set-based port passes a membership check and silently
//     reorders the labels that reach the GitHub API.
//   * `triageIssueListArgs(false)` must NOT carry the label selector. Getting this backwards fails
//     OPEN: triage would read every issue in the repo, which is the exact exposure the label exists
//     to close, and every "does it return a string" test still passes.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/github/issueProvenance.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  BSC_ISSUE_LABEL,
  BSC_ISSUE_LABEL_COLOR,
  triageIssueListArgs,
  withProvenanceLabel,
} from "@/shared/lib/github/issueProvenance";

const FIXTURE = join(process.cwd(), "src/shared/lib/github/issueProvenance.fixtures.json");

/** Label lists, including the ones that separate append-if-absent from a set union. */
const LABEL_CASES: { label: string; labels: string[] }[] = [
  { label: "empty", labels: [] },
  { label: "one unrelated label", labels: ["bug"] },
  { label: "already stamped — idempotent", labels: [BSC_ISSUE_LABEL] },
  { label: "already stamped, not last — must not move or duplicate", labels: [BSC_ISSUE_LABEL, "bug"] },
  { label: "order is preserved and the stamp is APPENDED", labels: ["zeta", "alpha", "mid"] },
  { label: "a near-miss label does not count as stamped", labels: ["bsc-generated-x", "BSC-GENERATED"] },
  { label: "duplicates in the input are left alone", labels: ["bug", "bug"] },
];

describe("issueProvenance fixture", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const doc = {
      note: "GENERATED from the live TypeScript — see issueProvenance.fixtures.gen.test.ts",
      // The constants themselves are part of the contract: the label is what the published issue
      // carries AND what triage selects on, so a port that drifts on the string silently selects
      // nothing rather than failing.
      label: BSC_ISSUE_LABEL,
      labelColor: BSC_ISSUE_LABEL_COLOR,
      withProvenanceLabel: LABEL_CASES.map((c) => ({
        label: c.label,
        input: c.labels,
        // The whole ORDERED list, never a membership boolean.
        output: withProvenanceLabel(c.labels),
      })),
      triageIssueListArgs: [true, false].map((restrict) => ({
        restrictToBsc: restrict,
        args: triageIssueListArgs(restrict),
      })),
    };
    const text = `${JSON.stringify(doc, null, 2)}\n`;
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });
});
