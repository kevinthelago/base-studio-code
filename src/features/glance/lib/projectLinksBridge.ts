// The frontend ↔ project-links bridge (#2253) — the Glance L1 relationships are a GLOBAL store reached
// through `bsc project link …` (the same CLI an agent uses to learn what its project consumes). The
// Zustand `projectLinks` slice is a write-through cache: `loadProjectLinks` hydrates it on boot, and each
// add/remove pushes through here. Project links are global (no project key), so every call passes null.
import { bsc, bscRun } from "@/shared/lib/core/bsc";
import type { ProjectLink } from "./projectLinks";

const KINDS = ["api", "data", "events"];

/**
 * Load every project link via `bsc project link list --json`. Returns `null` when the bridge is
 * unreachable (no Tauri host / old binary) so the caller keeps its persisted cache rather than blanking
 * it. NOT `bscJson` — its degrade-to-`[]` would clobber the cache on a transient failure.
 */
export async function loadProjectLinks(): Promise<ProjectLink[] | null> {
  try {
    const out = await bsc(null, ["project", "link", "list", "--json"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<ProjectLink>[];
    return (rows ?? []).filter(
      (l): l is ProjectLink =>
        typeof l.id === "string" && !!l.id && !!l.from && !!l.to && typeof l.kind === "string" && KINDS.includes(l.kind),
    );
  } catch {
    return null;
  }
}

/** Write-through an add (`bsc project link add`). Fire-and-forget; never throws (degrades to cache-only
 *  when the bridge/binary is absent). The store computes the id itself, so the printed id is unused. */
export async function pushProjectLink(from: string, to: string, kind: string): Promise<void> {
  try { await bscRun(null, ["project", "link", "add", from, to, kind]); } catch { /* bridge absent — cache-only */ }
}

/** Write-through a removal (`bsc project link remove <id>`). Never throws (see {@link pushProjectLink}). */
export async function dropProjectLink(id: string): Promise<void> {
  try { await bscRun(null, ["project", "link", "remove", id]); } catch { /* bridge absent — cache-only */ }
}
