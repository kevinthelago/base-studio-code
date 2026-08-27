// Keep the store's `bsc` command-surface catalog current
// (`a-persona-declares-its-command-surfaces`, epic `epic-command-surfaces-are-nodes`).
//
// ONE READER FOR TWO CONSUMERS. The session launch complements this catalog against each persona's
// declared surfaces to build that session's denies (`sessionDeniedCommands` → `permissions.deny` and
// `$BSC_DENY_BASH`), and the Glance drill draws its command-surface band from it. `bsc surface help`
// states outright that the role join belongs at the consumer, and three plan items already exist for
// hand-kept copies of this set drifting from what really dispatches — a second reader would be the
// next one.
//
// IT LIVES IN THE SHELL, not in a workspace. The first read of this catalog was inside
// `GlanceWorkspace`, which only mounts when Glance is open — so a session launched from the Console,
// from the fleet, or headlessly via `bsc fleet start` saw an EMPTY catalog, and an empty catalog
// denies nothing. The permission consequence of a UI-scoped poll is invisible until you look for it.
//
// The rows are stored WHOLE; the two filters over them live in `@/shared/lib/session/surfaceCatalog`
// so a feature can reach them without importing the shell.
import { usePoll } from "@/shared/hooks/usePoll";
import { bscJson } from "@/shared/lib/core/bsc";
import { useAppStore } from "@/store";
import type { SurfaceRow } from "@/shared/lib/session/surfaceCatalog";

/** How often to re-read. The catalog is a `const` compiled into the `bsc` binary, so it moves only
 *  when the binary is REPLACED — which does happen mid-session, since a rebuild re-stages the sidecar
 *  (`replaced_since` in `bsc serve` exists for exactly that). Far above how often it changes, far
 *  below how long a stale set would matter. */
const POLL_MS = 60_000;

/** Poll the catalog into the store. Mount ONCE, in the shell. */
export function useSurfaceCatalogPoll(): void {
  const setSurfaceCatalog = useAppStore((s) => s.setSurfaceCatalog);
  usePoll(async (isCancelled) => {
    const rows = await bscJson<SurfaceRow[]>(null, ["surface", "list", "--json"], []);
    if (isCancelled()) return;
    // A failed read yields `[]`, which every consumer treats as UNKNOWN and fails open on. Writing it
    // is still correct: the alternative — keeping the last good value — would let a catalog that has
    // genuinely shrunk keep denying a surface that no longer exists.
    //
    // Narrowed to {name, status} rather than stored as-is: the catalog also carries `store` and
    // `summary`, which nothing here reads, and holding them would put prose into a store that a
    // selector compares on every mutation.
    setSurfaceCatalog(
      Array.isArray(rows)
        ? rows.filter((r) => r && typeof r.name === "string").map((r) => ({ name: r.name, status: r.status }))
        : [],
    );
  }, POLL_MS);
}
