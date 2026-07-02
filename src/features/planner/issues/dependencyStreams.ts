// ── Shared-dependencies view (#1429) — the Streams pane surface ───────────────────────
// When 2+ streams build the same repo, each declares its OWN deps and they're reconciled into the
// repo's single lock. The pane shows them per repo → per stream, flags version-locked overlaps, and
// omits single-owner repos (their deps stay agent-managed — no parallel collision).

import type {
  DependencyRegistry,
  PlanDependency,
} from "@/features/planner/issues/dependencyTypes";
import {
  type DependencySourceGroup,
  groupDependenciesBySource,
} from "@/features/planner/issues/dependencySources";

/** A dep in the per-stream view + the cross-stream version-lock it participates in (#1429). */
export interface StreamDependency extends PlanDependency {
  /** Other streams on the SAME repo declaring the same package — a version-lock overlap. Empty ⇒ this
   *  stream alone declares it. Derived, not stored. */
  sharedWith: string[];
}

/** One stream's declared deps within a shared repo. */
export interface StreamDepGroup {
  stream: string;
  /** True when this stream owns no build deps (e.g. a director that just holds the reconciled lock). */
  empty: boolean;
  deps: StreamDependency[];
}

/** A repo built by 2+ streams: its per-stream declared deps (with shared overlaps derived), any
 *  unattributed repo-level deps, and the registries its deps reference. */
export interface SharedRepoDeps {
  repo: string;
  /** The streams building this repo (2+, in the order given). */
  streams: string[];
  byStream: StreamDepGroup[];
  /** Deps tagged to the repo but no stream (apply to every stream on it). */
  repoLevel: StreamDependency[];
  /** The source groups (public + private registries) the repo's deps reference. */
  registries: DependencySourceGroup[];
  /** Total declared deps across the repo. */
  total: number;
}

/**
 * Build the Streams pane's Shared-dependencies view (#1429): for every repo that 2+ streams build,
 * group its deps by the declaring stream and derive the cross-stream version-lock ("shared")
 * overlaps (same ecosystem+name declared by 2+ streams). A repo with a single owning stream is
 * OMITTED — its deps stay agent-managed. A multi-stream repo with no deps yet IS included (the
 * gate-blocking empty state). `repoStreams` maps each repo → the streams building it (from the
 * fleet, director included). Pure + deterministic (repos + streams sorted by the input order /
 * name). */
export function sharedRepoDependencies(
  deps: PlanDependency[],
  registries: Record<string, DependencyRegistry>,
  repoStreams: Record<string, string[]>,
): SharedRepoDeps[] {
  const out: SharedRepoDeps[] = [];
  for (const repo of Object.keys(repoStreams).sort()) {
    const streams = repoStreams[repo];
    if (!streams || streams.length < 2) continue; // single-owner / unbuilt repos excluded
    const repoDeps = deps.filter((d) => d.repo === repo);

    // name → set of streams that declare it (for the version-lock derivation).
    const declarers = new Map<string, Set<string>>();
    for (const d of repoDeps) {
      if (!d.stream) continue;
      const k = `${d.ecosystem}|${d.name.toLowerCase()}`;
      let s = declarers.get(k);
      if (!s) { s = new Set(); declarers.set(k, s); }
      s.add(d.stream);
    }
    const sharedFor = (d: PlanDependency): string[] => {
      const all = declarers.get(`${d.ecosystem}|${d.name.toLowerCase()}`);
      return all ? [...all].filter((x) => x !== d.stream).sort() : [];
    };

    const byStreamMap = new Map<string, StreamDependency[]>(streams.map((s) => [s, []]));
    const repoLevel: StreamDependency[] = [];
    for (const d of repoDeps) {
      const sd: StreamDependency = { ...d, sharedWith: sharedFor(d) };
      if (d.stream && byStreamMap.has(d.stream)) byStreamMap.get(d.stream)!.push(sd);
      else if (d.stream) { byStreamMap.set(d.stream, [sd]); }   // a declarer not in repoStreams — keep it
      else repoLevel.push(sd);
    }
    const byStream: StreamDepGroup[] = [...byStreamMap.keys()].map((s) => {
      const sd = byStreamMap.get(s)!;
      return { stream: s, empty: sd.length === 0, deps: sd };
    });
    out.push({
      repo, streams,
      byStream,
      repoLevel,
      registries: groupDependenciesBySource(repoDeps, registries),
      total: repoDeps.length,
    });
  }
  return out;
}

/** Repos that have 2+ streams but NO locked deps yet — the gate-blocking shared repos (#1429). The
 *  Streams dependency gate requires every multi-stream repo to have ≥1 locked dep; this lists the
 *  ones still missing. Empty ⇒ the (conditional) dependency gate is satisfied. */
export function unlockedSharedRepos(
  deps: PlanDependency[],
  repoStreams: Record<string, string[]>,
): string[] {
  return Object.keys(repoStreams)
    .filter((r) => (repoStreams[r]?.length ?? 0) >= 2 && !deps.some((d) => d.repo === r))
    .sort();
}
