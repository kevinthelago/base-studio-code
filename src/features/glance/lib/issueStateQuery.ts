// The GitHub overlay for a fleet's owned issue refs (#4102) — pure query construction + parsing.
//
// ── ONE CALL PER REPO, NOT ONE PER ISSUE ────────────────────────────────────────────────────────
// A drilled fleet owns ~60 refs. Asking GitHub for each one is 60 requests to render one graph — the
// N-per-node fan-out that has repeatedly cost this app real time (#3908/#3912/#3944/#3954), and the
// exact shape #4102 promises not to reintroduce. GraphQL takes aliased field selections, so every ref
// in a repo is resolvable in ONE query:
//
//   query { r0: repository(owner:"o", name:"n") { i3898: issue(number:3898) { number state } … } }
//
// ── WHY NOT `GET /issues?state=all` ─────────────────────────────────────────────────────────────
// It is paginated and returns PULL REQUESTS alongside issues (REST models a PR as an issue), so a
// fleet ref matching a PR number would report the wrong state. Asking for the exact numbers cannot
// make that mistake.
//
// Pure: no fetch, no store. The hook owns the lifecycle; this owns the contract.

import { normalizeRef } from "./fleetPlanProgress";

/** `owner/name`, as a fleet stream stores it. */
export interface RepoRefs {
  repo: string;
  /** Normalised issue numbers owned in this repo. */
  numbers: string[];
}

/** Group refs by their owning repo, so each repo becomes one query. Refs are normalised and
 *  de-duplicated — two streams in a repo commonly own overlapping work, and asking twice wastes the
 *  budget this batching exists to protect. Streams with no repo or no refs are skipped. */
export function groupRefsByRepo(
  streams: readonly { repo?: string; issues?: readonly string[] }[],
): RepoRefs[] {
  const byRepo = new Map<string, Set<string>>();
  for (const s of streams) {
    const repo = s.repo?.trim();
    if (!repo || !repo.includes("/")) continue;
    for (const ref of s.issues ?? []) {
      const n = normalizeRef(ref);
      // Only numeric refs are addressable as `issue(number:)`. A cross-repo ref like `owner/x#5` or a
      // free-text placeholder is dropped rather than sent as a malformed query that fails the whole
      // batch — one bad ref must not blank out every other stream's progress.
      if (!/^\d+$/.test(n)) continue;
      let set = byRepo.get(repo);
      if (!set) byRepo.set(repo, (set = new Set()));
      set.add(n);
    }
  }
  return [...byRepo].map(([repo, numbers]) => ({ repo, numbers: [...numbers].sort() }));
}

/** GraphQL aliases must match `/^[_A-Za-z][_0-9A-Za-z]*$/`, so both levels are prefixed rather than
 *  interpolated raw — an alias starting with a digit is a syntax error that fails the whole query. */
const repoAlias = (i: number) => `r${i}`;
const issueAlias = (n: string) => `i${n}`;

/**
 * Build one query covering every repo/ref pair.
 *
 * Returns `null` when there is nothing to ask — the caller must not spend a request (nor show a
 * spinner) for a fleet that owns no addressable refs.
 *
 * Owner/name are split and embedded as quoted literals. They come from the fleet plan rather than
 * user input, but they are still validated as GitHub name characters so a malformed repo string
 * cannot inject query text.
 */
export function buildIssueStateQuery(groups: readonly RepoRefs[]): string | null {
  const parts: string[] = [];
  groups.forEach((g, i) => {
    const [owner, name] = g.repo.split("/");
    if (!owner || !name || !/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) return;
    if (g.numbers.length === 0) return;
    const fields = g.numbers.map((n) => `${issueAlias(n)}: issue(number: ${n}) { number state }`).join(" ");
    parts.push(`${repoAlias(i)}: repository(owner: "${owner}", name: "${name}") { ${fields} }`);
  });
  return parts.length ? `query { ${parts.join(" ")} }` : null;
}

/** One issue as the overlay knows it. */
export interface IssueState {
  ref: string;
  closed: boolean;
}

/**
 * Parse the aliased response into `ref → closed`.
 *
 * Tolerant by construction: GitHub returns `null` for an alias whose issue does not exist (a stale
 * ref, or one belonging to a repo the token cannot see) and sends partial `data` ALONGSIDE `errors`
 * rather than failing the batch. Skipping the nulls means one dead ref costs its own state and
 * nothing else's — which matters because these refs are hand-maintained in the plan.
 */
export function parseIssueStates(data: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!data || typeof data !== "object") return out;
  for (const repo of Object.values(data as Record<string, unknown>)) {
    if (!repo || typeof repo !== "object") continue;
    for (const issue of Object.values(repo as Record<string, unknown>)) {
      if (!issue || typeof issue !== "object") continue;
      const { number, state } = issue as { number?: unknown; state?: unknown };
      if (typeof number !== "number" || typeof state !== "string") continue;
      out.set(normalizeRef(number), state.toUpperCase() === "CLOSED");
    }
  }
  return out;
}

/** The refs the overlay reports as DONE — the set `fleetPlanProgress` consumes. */
export function closedRefs(states: ReadonlyMap<string, boolean>): Set<string> {
  const out = new Set<string>();
  for (const [ref, closed] of states) if (closed) out.add(ref);
  return out;
}
