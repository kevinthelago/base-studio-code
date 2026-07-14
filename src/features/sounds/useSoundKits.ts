// useSoundKits (#3080) — the Sounds tab's kit source, seed-first: renders the packaged built-ins
// immediately, then hydrates from the durable `bsc-sound` store and seeds any built-in the store is
// missing (first run). Mirrors the Algorithms knowledge-graph hydration (`useKnowledgeGraph`, #2856):
// a hook, not a store slice, since the library is read-mostly here (authoring lands in Phase 4).
import { useEffect, useState } from "react";
import type { SoundKit } from "./lib/soundDescriptor";
import { BUILTIN_KITS, mergeKits } from "./lib/soundKits";
import { loadKits, pushKit } from "./lib/soundBridge";

export function useSoundKits(): SoundKit[] {
  const [kits, setKits] = useState<SoundKit[]>(BUILTIN_KITS);
  useEffect(() => {
    let cancelled = false;
    void loadKits().then((rows) => {
      const { kits: merged, toSeed } = mergeKits(rows);
      // Push any built-in the store doesn't have yet, so `bsc sound get <id>` works from a session too.
      toSeed.forEach((k) => { void pushKit(k).catch(() => {}); });
      if (!cancelled && merged.length) setKits(merged);
    });
    return () => { cancelled = true; };
  }, []);
  return kits;
}
