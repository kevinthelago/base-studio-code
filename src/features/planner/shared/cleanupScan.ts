// Cleanup scan dispatch (#626 slice c) — ties the dead-code feature together: run the
// stack's scanners on a repo, verify each candidate, project the result into a "Cleanup"
// GradeResult, and persist it so the report card renders it on the cleanup stage.
//
// Verification needs a model: with an API key the candidates are agent-judged; without
// one they stay "uncertain" (never auto-confirmed) so nothing is wrongly marked removable.

import { useAppStore } from "@/store";
import { oneShotComplete } from "@/shared/lib/core/claudeComplete";
import { type LlmConfig, hasLlmKey } from "@/shared/lib/core/llmConfig";
import { scanDeadCode, DEAD_CODE_SCANNERS, type DeadCodeFinding } from "@/shared/lib/cleanup/deadcode";
import { verifyFindings, findingsToGrade, type VerifiedFinding } from "@/shared/lib/cleanup/deadcodeVerify";
import { type GradeResult } from "../grading/grading";

export interface CleanupScanArgs {
  projectKey: string;
  sectionKey: string;
  /** Absolute path to the repo to scan. */
  repoPath: string;
  /** Limit scanners to a stack ("js" | "rust"); omit to run all. */
  stack?: "js" | "rust";
  /** Active LLM config — when it can make a call, candidates are verified; otherwise left uncertain. */
  llm?: LlmConfig;
}

export interface CleanupScanOutcome { grade: GradeResult; scanned: number; errors: string[] }

/** Scan → verify → grade → persist. Returns the grade + a count + any scanner errors. */
export async function runCleanupScan({ projectKey, sectionKey, repoPath, stack, llm }: CleanupScanArgs): Promise<CleanupScanOutcome> {
  const scanners = DEAD_CODE_SCANNERS.filter((s) => !stack || s.stack === stack);
  const candidates: DeadCodeFinding[] = [];
  const errors: string[] = [];
  for (const s of scanners) {
    const r = await scanDeadCode({ repoPath, tool: s.tool });
    if (r.ran) candidates.push(...r.findings);
    else if (r.error) errors.push(`${s.tool}: ${r.error}`);
  }
  const verified: VerifiedFinding[] = llm && hasLlmKey(llm)
    ? await verifyFindings(candidates, (p) => oneShotComplete(llm, p.system, p.user))
    : candidates.map((f) => ({ ...f, verdict: "uncertain", reason: "not verified (no API key)" }));
  const grade = findingsToGrade(verified, sectionKey);
  useAppStore.getState().setSectionGrade(projectKey, sectionKey, grade);
  return { grade, scanned: candidates.length, errors };
}
