// Cleanup scan dispatch (#626 slice c) — ties the dead-code feature together: run the
// stack's scanners on a repo, verify each candidate, project the result into a "Cleanup"
// GradeResult, and persist it so the report card renders it on the cleanup stage.
//
// Verification needs a model: with an API key the candidates are agent-judged; without
// one they stay "uncertain" (never auto-confirmed) so nothing is wrongly marked removable.

import { useAppStore } from "../../store";
import { oneShotComplete } from "../../lib/claudeComplete";
import { scanDeadCode, DEAD_CODE_SCANNERS, type DeadCodeFinding } from "../../lib/deadcode";
import { verifyFindings, findingsToGrade, type VerifiedFinding } from "../../lib/deadcodeVerify";
import { type GradeResult } from "./grading/grading";

export interface CleanupScanArgs {
  projectKey: string;
  sectionKey: string;
  /** Absolute path to the repo to scan. */
  repoPath: string;
  /** Limit scanners to a stack ("js" | "rust"); omit to run all. */
  stack?: "js" | "rust";
  /** Claude API key — when present, candidates are verified; otherwise left uncertain. */
  apiKey?: string;
}

export interface CleanupScanOutcome { grade: GradeResult; scanned: number; errors: string[] }

/** Scan → verify → grade → persist. Returns the grade + a count + any scanner errors. */
export async function runCleanupScan({ projectKey, sectionKey, repoPath, stack, apiKey }: CleanupScanArgs): Promise<CleanupScanOutcome> {
  const scanners = DEAD_CODE_SCANNERS.filter((s) => !stack || s.stack === stack);
  const candidates: DeadCodeFinding[] = [];
  const errors: string[] = [];
  for (const s of scanners) {
    const r = await scanDeadCode({ repoPath, tool: s.tool });
    if (r.ran) candidates.push(...r.findings);
    else if (r.error) errors.push(`${s.tool}: ${r.error}`);
  }
  const verified: VerifiedFinding[] = apiKey
    ? await verifyFindings(candidates, (p) => oneShotComplete(apiKey, p.system, p.user))
    : candidates.map((f) => ({ ...f, verdict: "uncertain", reason: "not verified (no API key)" }));
  const grade = findingsToGrade(verified, sectionKey);
  useAppStore.getState().setSectionGrade(projectKey, sectionKey, grade);
  return { grade, scanned: candidates.length, errors };
}
