// Refactor units (#626 slice d1) — turn CONFIRMED dead-code findings into small,
// independent, reversible work items the fleet executes (slice d2). Each unit owns a
// disjoint set of files so workers run in parallel worktrees without conflict — the
// same non-overlapping-globs model the existing streams use.
//
// Grouping: all unused deps batch into ONE safe unit (a single manifest edit); code
// findings group by file into one risky unit each (touching a public-ish surface).
// Pure; ids are deterministic (stable across re-generation).

import { type VerifiedFinding } from "./deadcodeVerify";

export type RefactorTier = "safe" | "risky";

export interface RefactorUnit {
  /** Deterministic id: "deps" for the dependency batch, else the owned file path. */
  id: string;
  title: string;
  /** File globs this unit may touch (disjoint across units → parallel-safe). */
  owns: string[];
  tier: RefactorTier;
  findings: VerifiedFinding[];
  acceptance: string;
}

const ACCEPTANCE =
  "Tests pass, the listed items no longer appear in a re-scan, and the project still builds.";

/** Confirmed findings → refactor units. Only `confirmed` findings become work; uncertain
 *  / false-positive ones are left out (a human reviews those separately). */
export function generateRefactorUnits(verified: VerifiedFinding[]): RefactorUnit[] {
  const confirmed = verified.filter((v) => v.verdict === "confirmed");
  const units: RefactorUnit[] = [];

  // 1) all unused dependencies → one safe unit (single manifest edit, low risk).
  const deps = confirmed.filter((v) => v.kind === "unused-dep");
  if (deps.length > 0) {
    units.push({
      id: "deps",
      title: `Remove ${deps.length} unused ${deps.length === 1 ? "dependency" : "dependencies"}`,
      owns: [...new Set(deps.map((d) => d.path))],
      tier: "safe",
      findings: deps,
      acceptance: ACCEPTANCE,
    });
  }

  // 2) code findings → one risky unit per file (touches a public-ish surface; reviewed).
  const byFile = new Map<string, VerifiedFinding[]>();
  for (const f of confirmed.filter((v) => v.kind !== "unused-dep")) {
    const list = byFile.get(f.path) ?? [];
    list.push(f);
    byFile.set(f.path, list);
  }
  for (const [path, fs] of byFile) {
    units.push({
      id: path,
      title: `Remove ${fs.length} dead ${fs.length === 1 ? "item" : "items"} in ${path}`,
      owns: [path],
      tier: "risky",
      findings: fs,
      acceptance: ACCEPTANCE,
    });
  }

  return units;
}
