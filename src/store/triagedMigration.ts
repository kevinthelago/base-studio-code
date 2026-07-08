// One-time triaged grandfather (#2548) — the pure backfill behind the persist migration.
//
// The Glance triaged filter (#2541) is FORWARD-LOOKING: `triagedProjects` is only stamped when a
// triage/fleet launches after the feature shipped. So on upgrade, every project worked BEFORE the
// filter has no marker and vanishes from Glance ("No project network yet"). This backfills the marker
// once, from the projects clearly already worked:
//   • every published GitHub project — its plan key is `projectSlug(board title)` (#2409), the same key
//     the Glance node + drill resolve against, and
//   • every project with a planned fleet (`planFleet` keys carrying streams).
//
// A fresh install has no persisted state, so the migration never runs for it — the strict rule holds
// (a genuinely new draft/published project stays hidden until it's actually triaged).
import { projectSlug } from "@/shared/lib/core/projectPaths";

/** The `githubState.records` fields the backfill reads (#2446 minimal record). */
interface RecordLite { title?: string }
/** The `planFleet` value fields the backfill reads. */
interface FleetLite { streams?: unknown[] }

/**
 * Compute the grandfathered `triagedProjects` map (plan key → `now`) from a persisted state's published
 * board + planned fleets. Pure + deterministic (caller passes `now`).
 */
export function grandfatherTriaged(
  records: RecordLite[] | undefined,
  planFleet: Record<string, FleetLite | undefined> | undefined,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records ?? []) if (r?.title) out[projectSlug(r.title)] = now;
  for (const [key, fleet] of Object.entries(planFleet ?? {})) {
    if ((fleet?.streams?.length ?? 0) > 0) out[key] = now;
  }
  return out;
}

/**
 * Grandfather LOCAL published hubs into the triaged set (#2548 follow-up). The persist migration reads the
 * PERSISTED `githubState.records` + `planFleet`, but both are empty when the user is logged out or after a
 * state reset — so an existing user's on-disk published projects still vanished from Glance. The on-disk
 * published inventory (`list_local_projects`) is the RELIABLE "already worked" set. Stamp each local
 * published hub key not already marked, preserving existing timestamps. Keyed by the hub FOLDER key —
 * exactly the key the Glance node + `filterTriaged` resolve against. Pure + deterministic.
 */
export function grandfatherLocalPublished(
  localPublishedKeys: string[],
  existing: Record<string, number>,
  now: number,
): Record<string, number> {
  const out = { ...existing };
  for (const key of localPublishedKeys) if (key && out[key] === undefined) out[key] = now;
  return out;
}
