// The frontend ↔ network store bridge. A NETWORK is a domain: the set of projects that share one
// concern, drawn as one Glance tab, and the owner of exactly one architect session. The desktop and
// every live session share ONE global store (`~/.base-studio-code/networks.db`), reached here — and
// from a session's own shell — through the same `bsc network …` CLI over the generic `bsc` bridge
// (#2114). Networks are GLOBAL (no project key), so every call passes `null`. Mirrors orgBridge.ts
// exactly; the store slice is a write-through cache over this.
//
// Which PROJECTS are in a network is deliberately not here: that is the `network` column on each
// project row (`bsc project network set`), so a network never carries a member list to keep in sync.
import { bsc, bscRun, bscWrite } from "@/shared/lib/core/bsc";

/** One network, exactly as the `bsc network` store holds it. */
export interface Network {
  /** `network-<slug>`, minted at creation and FROZEN — the architect's pane id and workspace dir are
   *  derived from it, so a changed id strands a running session. Rename the `name`. */
  id: string;
  /** What the Glance tab shows. Display-only; safe to change. */
  name: string;
  /** The architect persona id, or absent for the default architect. */
  architect?: string;
  /** Tab order. */
  position: number;
}

/**
 * Load every network via `bsc network list --full`. Returns `null` when the bridge is unreachable (no
 * Tauri host — tests, the web shell, or an older bundled binary) so the caller can tell "no networks"
 * from "could not ask", and leave what it has rather than blanking the tab strip.
 *
 * NOT `bscJson`: its degrade-to-fallback returns an empty array, which is indistinguishable from a
 * store that genuinely holds nothing — and here that difference is a UI with no tabs.
 */
export async function loadNetworks(): Promise<Network[] | null> {
  try {
    const out = await bsc(null, ["network", "list", "--full"]);
    const rows = JSON.parse(out.trim() || "[]") as Partial<Network>[];
    return (rows ?? [])
      .filter((n): n is Network => typeof n.id === "string" && !!n.id)
      .map((n, i) => ({
        id: n.id,
        name: n.name?.trim() || n.id,
        architect: n.architect || undefined,
        // A missing position sorts to where it was read rather than to 0, so a hand-written row does
        // not silently jump to the front of the strip.
        position: typeof n.position === "number" ? n.position : i,
      }))
      .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  } catch {
    return null;
  }
}

/** Write-through an upsert (`bsc network set` reads the JSON on stdin). Fire-and-forget; never throws,
 *  so an older bundled `bsc` without the `network` subcommand degrades to cache-only silently. */
export async function pushNetwork(network: Network): Promise<void> {
  try { await bscWrite(null, ["network", "set"], network); } catch { /* store unreachable — cache-only */ }
}

/** Write-through a removal (`bsc network remove <id>`). Never throws (see {@link pushNetwork}). */
export async function dropNetwork(id: string): Promise<void> {
  try { await bscRun(null, ["network", "remove", id]); } catch { /* store unreachable — cache-only */ }
}

/**
 * Every project's network, as `bsc project network list --json` reports it — the answer to "is this
 * network empty?", which the network store itself cannot give.
 *
 * Returns `[]` on any failure. Unlike {@link loadNetworks} the ambiguity is harmless here: the one
 * caller uses it to REFUSE a delete, and failing open (allowing it) would be worse than failing closed
 * only when the store is genuinely reachable and genuinely empty.
 */
export async function projectsByNetwork(): Promise<{ key: string; network: string | null }[]> {
  try {
    const out = await bsc(null, ["project", "network", "list", "--json"]);
    const rows = JSON.parse(out.trim() || "[]") as { key?: string; network?: string | null }[];
    return (rows ?? [])
      .filter((r): r is { key: string; network: string | null } => typeof r.key === "string")
      .map((r) => ({ key: r.key, network: r.network ?? null }));
  } catch {
    return [];
  }
}

/** `network-<slug>` from a display name — the id minting rule, mirroring `mintOrgId`.
 *
 *  Auto-disambiguating (`network-foo`, `network-foo-2`, …) rather than refusing a collision: that is
 *  the convention every in-app library uses. The `projectSlug`-plus-collision-modal discipline exists
 *  only where an id names an on-disk hub recovered by DERIVATION, and a network is a row.
 *
 *  The character class is narrower than a display name allows on purpose — the id becomes a pane key
 *  (`network-<slug>:architect`) and a directory name, and `bsc_session::network_architect_slug`
 *  refuses anything outside `[a-z0-9-]`. A name that slugs to nothing falls back to `network`. */
export function mintNetworkId(existing: { id: string }[], name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const base = `network-${slug || "network"}`;
  if (!existing.some((n) => n.id === base)) return base;
  let n = 2;
  while (existing.some((x) => x.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
