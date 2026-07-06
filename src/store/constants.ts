// Console kickoff prompts sent as the first message to a launched session. Plain text only
// (no double quotes / $ / backticks) so each is safe to pass as `claude "<prompt>"`. Extracted
// from store/index.ts (store split, stage 1).
//
// The prompt PROSE is externalized to `@data/console/kickoff-prompts.json` (#2416) — editable
// without touching code + part of the exportable config bundle; the config-dir copy (#2047)
// overlays the embedded default via `overlayFile`. This module keeps only the interpolation
// (`fillTemplate` over `{{…}}` placeholders) and the assembly.

import { BSC_ISSUE_LABEL, triageIssueListArgs } from "@/shared/lib/github/issueProvenance";
import kickoffPromptsEmbedded from "@data/console/kickoff-prompts.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";
import { fillTemplate } from "@/shared/lib/core/template";

const PROMPTS = overlayFile("console/kickoff-prompts.json", kickoffPromptsEmbedded);

// Sent as the first message to each console when a project tab is opened, so the
// session starts by reading and executing the laid-out plan. Plain text only — no
// double quotes / $ / backticks — so it's safe to pass as `claude "<prompt>"`.
export const PROJECT_INIT_PROMPT = PROMPTS.projectInit;

// Sent verbatim as the first message to each triage console. Drives an issue
// triage pass over the pane's repo. Plain text only (no double quotes / $ /
// backticks) so it is safe to type into the PTY as a single line.
/**
 * Render the since-last-run delta (#1004) into a one-line lead for the triage prompt, so a re-run
 * resumes cheaply from what changed instead of re-ingesting the whole project. `changed` is the
 * plan.db `issues_changed_since(T)` result; `lastRun` is the marker (null ⇒ first triage). Empty
 * string when there's no marker (a fresh triage gets the full prompt).
 */
export function renderTriageDelta(
  changed: { ref: string; title: string; status: string }[],
  lastRun: number | null,
): string {
  if (lastRun === null) return ""; // never triaged → no delta lead; do the full pass
  if (changed.length === 0) return PROMPTS.triageDelta.noChanges;
  const by = (s: string) => changed.filter((i) => i.status === s).map((i) => i.ref);
  const groups: string[] = [];
  const landed = [...by("complete"), ...by("verified")];
  const stuck = [...by("blocked"), ...by("failed")];
  if (landed.length) groups.push(PROMPTS.triageDelta.groupLanded + landed.join(", "));
  if (stuck.length) groups.push(PROMPTS.triageDelta.groupStuck + stuck.join(", "));
  const detail = groups.length ? ` (${groups.join("; ")})` : "";
  return fillTemplate(PROMPTS.triageDelta.changed, { COUNT: String(changed.length), DETAIL: detail });
}

/**
 * The triage kickoff. When `restrictToBsc` (the secure default, #738), triage works ONLY
 * issues authored by base-studio-code (the `bsc-generated` label) and treats every other open
 * issue as untrusted — so a hand-created or injected issue isn't acted on. Off → all open issues.
 */
export function buildTriagePrompt(restrictToBsc: boolean, delta?: string): string {
  const fetch = restrictToBsc
    ? fillTemplate(PROMPTS.triage.fetchRestricted, {
        LABEL: BSC_ISSUE_LABEL,
        LIST_ARGS: triageIssueListArgs(true),
      })
    : fillTemplate(PROMPTS.triage.fetchAll, { LIST_ARGS: triageIssueListArgs(false) });
  // #1004: a non-empty delta leads the prompt so the agent resumes from what changed (token-aware).
  const resume = delta && delta.length > 0 ? delta + " " : "";
  return resume + PROMPTS.triage.lead + fetch + PROMPTS.triage.rubric;
}

/** The secure-default triage prompt (bsc-authored issues only). */
export const TRIAGE_PROMPT = buildTriagePrompt(true);
