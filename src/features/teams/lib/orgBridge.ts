// The frontend ↔ teams store bridge (#2193, verb renamed org → teams in #2700). The desktop Team
// designer and every live console session + the planner share ONE global store
// (`~/.base-studio-code/orgs/<id>.json` — the on-disk dir keeps its `orgs/` name so existing data is
// not orphaned), reached here — and from a session's own shell — through the SAME `bsc teams …` CLI
// (with `bsc org` still a deprecated alias), over the generic `bsc` bridge (#2114). Teams are GLOBAL
// (no project key) so every call passes `null` as the projectKey. This is the only place the teams
// feature touches Tauri, so the pure model in `team.ts` stays React/Tauri-free. Mirrors
// personaBridge.ts exactly; the store is a write-through cache over this.
import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";
import type { Team } from "./team";

/**
 * Load every org from the store via `bsc org list --full`. Returns `null` when the bridge is
 * unreachable (no Tauri host — tests, the web shell, or an old binary) so the caller keeps its seeded
 * in-memory built-ins rather than blanking the library. NOT `bscJson` (its degrade-to-fallback would
 * return an empty array, which would then blank the seeded set).
 */
export async function loadOrgs(): Promise<Team[] | null> {
  try {
    const out = await bsc(null, ["teams", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<Team>[];
    // Defensive: keep only well-formed rows (id present), defaulting the rest so an odd file never
    // crashes hydration.
    return (rows ?? [])
      .filter((o): o is Team => typeof o.id === "string" && !!o.id)
      .map((o) => ({
        id: o.id, name: o.name ?? "Untitled", blurb: o.blurb ?? "",
        positions: o.positions ?? [], relationships: o.relationships ?? [], builtin: o.builtin,
      }));
  } catch {
    return null;
  }
}

/** Write-through a team upsert (`bsc teams set` reads the JSON on stdin). Fire-and-forget; never throws,
 *  so an old bundled `bsc` without the `teams` subcommand degrades to store-only silently. */
export async function pushOrg(org: Team): Promise<void> {
  try { await bscWrite(null, ["teams", "set"], org); } catch { /* store unreachable — cache-only */ }
}

/** Write-through a team removal (`bsc teams remove <id>`). Never throws (see {@link pushOrg}). */
export async function dropOrg(id: string): Promise<void> {
  try { await bscRun(null, ["teams", "remove", id]); } catch { /* store unreachable — cache-only */ }
}
