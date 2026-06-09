// Verify-removal gate (#626 slice d1) — the re-scan half of the merge gate. After a
// worker removes a unit's dead code, re-run the scanners on the worktree; the unit's
// targeted findings must no longer appear, or the removal didn't actually happen (or was
// reverted). The tests/build half runs in the worker's session (slice d2). Pure core +
// a thin re-scan dispatch reusing slice a's scanner.

import { scanDeadCode, DEAD_CODE_SCANNERS, type DeadCodeFinding } from "./deadcode";
import { type VerifiedFinding } from "./deadcodeVerify";
import { type RefactorUnit } from "./refactorUnits";

/** Stable identity of a finding for matching across scans. */
export function findingKey(f: { kind: string; path: string; symbol?: string }): string {
  return `${f.kind}|${f.path}|${f.symbol ?? ""}`;
}

export interface RemovalCheck { ok: boolean; remaining: VerifiedFinding[] }

/** Pure: are this unit's findings absent from a post-removal scan? `remaining` = the ones
 *  still present (the removal is incomplete until it's empty). */
export function removalVerified(unit: RefactorUnit, postScan: DeadCodeFinding[]): RemovalCheck {
  const present = new Set(postScan.map(findingKey));
  const remaining = unit.findings.filter((f) => present.has(findingKey(f)));
  return { ok: remaining.length === 0, remaining };
}

export interface RescanResult extends RemovalCheck { errors: string[] }

/** Re-scan a repo path and check the unit's removal. Never throws. */
export async function rescanForRemoval(args: { repoPath: string; unit: RefactorUnit; stack?: "js" | "rust" }): Promise<RescanResult> {
  const scanners = DEAD_CODE_SCANNERS.filter((s) => !args.stack || s.stack === args.stack);
  const post: DeadCodeFinding[] = [];
  const errors: string[] = [];
  for (const s of scanners) {
    const r = await scanDeadCode({ repoPath: args.repoPath, tool: s.tool });
    if (r.ran) post.push(...r.findings);
    else if (r.error) errors.push(`${s.tool}: ${r.error}`);
  }
  return { ...removalVerified(args.unit, post), errors };
}
