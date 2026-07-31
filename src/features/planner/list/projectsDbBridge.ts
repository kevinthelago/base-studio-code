// The Projects page ↔ `bsc project db` bridge (#2995) — drafts get a durable home in the projects DB,
// reached through the generic `bsc` bridge, so a draft survives a restart even when the fragile
// `localDraftProjects` cache misses. Mirrors projectLinksBridge/graphBridge discipline: `listDbProjects`
// returns `null` when the bridge is unreachable (the web shell, the tests, or an OLD bundled `bsc`
// without the `project db` verb) so the page keeps its persisted cache rather than blanking it, and
// every read is shape-gated before it's trusted. The write helpers are fire-and-forget (they degrade
// to cache-only when the bridge/binary is absent) — this is a strictly ADDITIVE, dual-write layer over
// the existing store draft map, never a replacement for it.
import { bscJson, bscWrite, bscRun } from "@/shared/lib/core/bsc";

/** A row of the durable projects DB (`bsc project db list`). `blueprint`/`category` may be null;
 *  `state` ∈ `drafted|planning|published|created`. */
export interface DbProject {
  key: string;
  title: string;
  pitch: string;
  blueprint: string | null;
  category: string | null;
  state: string;
  createdAt: number;
  updatedAt: number;
  /** When the project was TRIAGED (epoch ms), `null` if never, ABSENT on a pre-#4088 binary (#4088).
   *  Gates the Glance network — `projects.db` is the source; the store keeps an in-memory cache
   *  hydrated from here. Optional so an older sidecar's payload still shape-gates cleanly. */
  triagedAt?: number | null;
}

/** Shape-gate ONE raw list row into a {@link DbProject}, or `null` to drop it. `key` + `state` are the
 *  load-bearing identity/lifecycle fields (a row missing either is garbage); the rest are coerced with
 *  safe defaults so a partial payload can't crash the caller. */
function toDbProject(raw: unknown): DbProject | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.key !== "string" || !o.key) return null;
  if (typeof o.state !== "string" || !o.state) return null;
  return {
    key: o.key,
    title: typeof o.title === "string" ? o.title : "",
    pitch: typeof o.pitch === "string" ? o.pitch : "",
    blueprint: typeof o.blueprint === "string" ? o.blueprint : null,
    category: typeof o.category === "string" ? o.category : null,
    state: o.state,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : 0,
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : 0,
    // Absent on a pre-#4088 binary — `null` reads as "not triaged", which is the safe default: it
    // hides an unknown project from Glance rather than inventing a triage that never happened.
    triagedAt: typeof o.triagedAt === "number" ? o.triagedAt : null,
  };
}

/**
 * Read every row via `bsc project db list --json`. Returns `null` on ANY failure — an unreachable
 * bridge, an old `bsc` without the verb, non-JSON output, or a payload that isn't an array — so a
 * degraded environment keeps rendering the persisted draft cache rather than blanking it. Each row is
 * shape-gated; unrecognizable rows are silently dropped.
 */
export async function listDbProjects(): Promise<DbProject[] | null> {
  try {
    const rows = await bscJson<unknown>(null, ["project", "db", "list", "--json"], null);
    if (!Array.isArray(rows)) return null;
    return rows.map(toDbProject).filter((r): r is DbProject => r !== null);
  } catch {
    return null;
  }
}

/**
 * Upsert a draft into the projects DB (`bsc project db add`, one JSON object on stdin). Idempotent by
 * key (an existing key is updated), fire-and-forget, and degrades silently when the bridge/binary is
 * absent — the caller has already written the store draft map, so this is the durable mirror.
 */
export async function addDbProject(p: {
  key: string;
  title: string;
  pitch?: string;
  blueprint?: string | null;
  category?: string | null;
  state?: string;
}): Promise<void> {
  await bscWrite(null, ["project", "db", "add"], p);
}

/** Remove a draft from the projects DB (`bsc project db remove <key>`). Fire-and-forget; degrades
 *  silently (the store draft map is cleared separately by the caller). */
export async function removeDbProject(key: string): Promise<void> {
  await bscRun(null, ["project", "db", "remove", key]);
}

/** Advance a DB row's lifecycle state (`bsc project db state <key> <state>`). Fire-and-forget;
 *  degrades silently. (Provided for completeness; the Phase-1 draft flow uses add/remove.) */
export async function setDbProjectState(key: string, state: string): Promise<void> {
  await bscRun(null, ["project", "db", "state", key, state]);
}

/** Stamp a project TRIAGED in the durable store (#4088) — `bsc project triaged set`. Idempotent: an
 *  already-triaged project keeps its first timestamp. Fire-and-forget; degrades silently when the
 *  bridge or an older binary can't serve it, exactly like the other writers here. */
export async function setDbTriaged(key: string): Promise<void> {
  if (!key) return;
  try {
    await bscRun(null, ["project", "triaged", "set", key]);
  } catch {
    /* bridge unreachable — the in-memory marker still gates this session */
  }
}
