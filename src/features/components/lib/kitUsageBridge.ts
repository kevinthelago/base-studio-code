// The frontend ↔ kit-usage consumer-index bridge (#2277). Which projects use which kit — the GLOBAL
// edge store the change-propagation fan-out reads, reached (from the UI AND a live session's shell)
// through the SAME `bsc component usage …` CLI over the generic `bsc` bridge (#2114). Global → every
// call passes `null` as the projectKey. The Zustand `kitUsage` slice is a write-through cache over it.
import { bsc, bscRun } from "@/shared/lib/core/bsc";
import type { KitConsumer } from "./propagation";

/**
 * Load every consumer edge via `bsc component usage list --json`. Returns `null` when the bridge is
 * unreachable (no Tauri host / an old binary) so the caller keeps its persisted cache rather than
 * blanking it. NOT `bscJson` — its degrade-to-`[]` would clobber the cache on a transient failure.
 */
export async function loadKitUsage(): Promise<KitConsumer[] | null> {
  try {
    const out = await bsc(null, ["component", "usage", "list", "--json"]);
    const rows = JSON.parse(out.trim() || "[]") as { projectKey?: string; kitId?: string }[];
    return (rows ?? [])
      .filter((u): u is { projectKey: string; kitId: string } => !!u.projectKey && !!u.kitId)
      .map((u) => ({ projectKey: u.projectKey, kitId: u.kitId }));
  } catch {
    return null;
  }
}

/** Write-through an edge add (`bsc component usage add`). Fire-and-forget; never throws (degrades to
 *  cache-only when the bridge/binary is absent). */
export async function pushKitUsage(projectKey: string, kitId: string): Promise<void> {
  try { await bscRun(null, ["component", "usage", "add", projectKey, kitId]); } catch { /* bridge absent — cache-only */ }
}

/** Write-through an edge removal (`bsc component usage remove <id>`). Never throws. */
export async function dropKitUsage(id: string): Promise<void> {
  try { await bscRun(null, ["component", "usage", "remove", id]); } catch { /* bridge absent — cache-only */ }
}
