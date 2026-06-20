// Issue provenance (#738) — security hardening for the untrusted-issue channel.
//
// GitHub issues are an untrusted input: a hand-created or injected issue could be picked up
// by an agent (the triage session runs `gh issue list` over EVERY open issue) and acted on.
// base-studio-code marks the issues IT publishes with a distinctive label; agents that pull
// live issues restrict to that label BY DEFAULT, so an issue the app didn't author is ignored.
//
// Caveat: a label is forgeable by anyone with repo write access — this stops accidental /
// hand-created pickup and raises the bar, but is not a cryptographic guarantee. For that,
// track the issue numbers the app created (a follow-up).

/** The label base-studio-code stamps on every issue it publishes. */
export const BSC_ISSUE_LABEL = "bsc-generated";

/** GitHub label color (hex, no #) for the provenance label. */
export const BSC_ISSUE_LABEL_COLOR = "1f6feb";

/** Add the provenance label to a plan issue's labels (idempotent). */
export function withProvenanceLabel(labels: string[]): string[] {
  return labels.includes(BSC_ISSUE_LABEL) ? labels : [...labels, BSC_ISSUE_LABEL];
}

/** The `gh issue list` selector triage uses — restricted to bsc-authored issues by default. */
export function triageIssueListArgs(restrictToBsc: boolean): string {
  return restrictToBsc
    ? `--state open --label ${BSC_ISSUE_LABEL} --limit 100`
    : `--state open --limit 100`;
}
