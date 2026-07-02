// projectPaneRepos -- maps the linked-repo list + fleet streams into the
// ProjectPane `Repo` cards (clone state, per-stream planned branches). Extracted
// from projectPaneData (#2151); pure, no logic changes.

import type { Repo } from "./projectPane.types";
import type { BuildProjectPaneInput } from "./projectPaneInput";

export function buildRepos(input: BuildProjectPaneInput): Repo[] {
  const streams = input.fleet?.streams ?? [];
  const cloned = new Set(input.clonedNames ?? []);
  const firstIssueNum = (refs: string[]): number => {
    for (const r of refs) { const n = parseInt(String(r).replace(/^#/, ""), 10); if (Number.isFinite(n)) return n; }
    return 0;
  };
  return input.repos.map((fullName, i) => ({
    id: fullName,
    branch: "main",
    ahead: 0,
    behind: 0,
    agents: streams.filter(s => s.repo === fullName).map(s => s.id),
    primary: i === 0,
    cloned: cloned.has(fullName),
    // The planned work for this repo: one branch per stream that owns it (branch = stream
    // id; the issues it owns ride along). Pre-launch these are PLANNED branches; once the
    // fleet runs the live git state replaces them.
    branches: streams.filter(s => s.repo === fullName).map(s => ({
      n: s.id, issue: firstIssueNum(s.issues ?? []), state: "draft", ahead: 0, behind: 0,
    })),
  }));
}
