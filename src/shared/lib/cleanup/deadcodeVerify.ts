// Dead-code candidate verification (#626 slice b). Static scanners surface CANDIDATES;
// before anything is removed an agent judges each one — genuinely dead, or a false
// positive (dynamically referenced, public API, used in tests/config, re-exported).
//
// Pure given an injected `complete`; with no model available the safe default is
// "uncertain" — never auto-confirm a removal without verification.

import { type DeadCodeFinding } from "./deadcode";

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
