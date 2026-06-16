// Dead-code candidate verification (#626 slice b). Static scanners surface CANDIDATES;
// before anything is removed an agent judges each one — genuinely dead, or a false
// positive (dynamically referenced, public API, used in tests/config, re-exported).
// Verified results project into a GradeResult so they render in the report card.
//
// Pure given an injected `complete`; with no model available the safe default is
// "uncertain" — never auto-confirm a removal without verification.

import { letterFromScore } from "./planGrade";
import { type DeadCodeFinding, type DeadCodeKind } from "./deadcode";
import { type GradeResult, type GradeDimension, type GradeFinding } from "../screens/projects/grading";

export type Verdict = "confirmed" | "false-positive" | "uncertain";
export interface VerifiedFinding extends DeadCodeFinding { verdict: Verdict; reason: string }

export type Complete = (p: { system: string; user: string }) => Promise<string>;

const VERDICTS: Verdict[] = ["confirmed", "false-positive", "uncertain"];
const asVerdict = (v: unknown): Verdict => (VERDICTS.includes(v as Verdict) ? (v as Verdict) : "uncertain");

/**
 * Ask the model to judge each candidate. Returns one VerifiedFinding per input (order
 * preserved); anything it doesn't clearly rule on stays "uncertain". On no findings →
 * []. On a parse failure → all "uncertain" (safe: nothing auto-confirmed).
 */
export async function verifyFindings(findings: DeadCodeFinding[], complete: Complete): Promise<VerifiedFinding[]> {
  if (findings.length === 0) return [];
  const list = findings.map((f, i) => `${i}. [${f.kind}] ${f.symbol ?? f.path} in ${f.path} — ${f.detail}`).join("\n");
  let verdicts: { verdict?: string; reason?: string }[] = [];
  try {
    const raw = await complete({
      system:
        "You are a code-refactoring reviewer. For each candidate unused-code finding, decide if it is genuinely " +
        "dead, or a false positive (dynamically referenced, part of the public API, used only in tests/config, or " +
        "re-exported). Respond with ONLY a JSON array, one object per finding IN ORDER: " +
        '{"verdict":"confirmed"|"false-positive"|"uncertain","reason":string}.',
      user: list,
    });
    const m = raw.match(/\[[\s\S]*\]/);
    if (m) verdicts = JSON.parse(m[0]);
  } catch { /* leave verdicts empty → all uncertain */ }
  return findings.map((f, i) => {
    const v = Array.isArray(verdicts) ? verdicts[i] : undefined;
    return { ...f, verdict: asVerdict(v?.verdict), reason: typeof v?.reason === "string" ? v.reason : "" };
  });
}

const KIND_LABEL: Record<DeadCodeKind, string> = {
  "unused-dep": "Unused dependencies",
  "unused-export": "Unused exports",
  "unused-file": "Orphan files",
  unreachable: "Unreachable code",
};

/**
 * Project verified findings into a GradeResult ("Cleanup" grader) so the report card
 * renders them: a per-kind dimension (100 when nothing confirmed of that kind) and a
 * finding per non-false-positive item (confirmed = actionable, uncertain = review).
 */
export function findingsToGrade(verified: VerifiedFinding[], sectionKey: string): GradeResult {
  const kinds = [...new Set(verified.map((v) => v.kind))];
  const dimensions: GradeDimension[] = kinds.map((k) => {
    const inKind = verified.filter((v) => v.kind === k);
    const confirmed = inKind.filter((v) => v.verdict === "confirmed").length;
    // Uncertain candidates couldn't be verified (e.g. no API key) — they're review debt, so
    // they ding the score lightly rather than reading as a clean A (#688). Confirmed dead
    // code is heavier. Empty (scan ran, nothing found) stays 100.
    const uncertain = inKind.filter((v) => v.verdict === "uncertain").length;
    const score = Math.max(0, 100 - confirmed * 15 - uncertain * 5);
    const note = uncertain ? `${confirmed} confirmed · ${uncertain} to review` : `${confirmed} confirmed`;
    return { id: k, label: KIND_LABEL[k], score, note };
  });
  const score = dimensions.length ? Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length) : 100;
  const findings: GradeFinding[] = verified
    .filter((v) => v.verdict !== "false-positive")
    .map((v) => ({
      severity: v.verdict === "confirmed" ? "warn" : "info",
      message: `${v.symbol ? `${v.symbol} (${v.path})` : v.path} — ${v.kind}`,
      fix: v.verdict === "confirmed" ? "safe to remove" : v.reason || "review — may be referenced dynamically",
    }));
  return { graderId: "cleanup", graderLabel: "Cleanup", sectionKey, score, letter: letterFromScore(score / 100), dimensions, findings };
}
