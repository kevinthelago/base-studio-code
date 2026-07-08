// The design-generator bridge (#2658, epic #2606) — the frontend calls the SAME deterministic palette
// generator (`bsc ui generate`, crates/bsc-ui, #2636) the designer + agents use, over the generic `bsc`
// bridge. When a downloaded blueprint's reconcile (#2646) leaves categories the contract doesn't define,
// this fills each with a coherent colour so the shared blueprint brings its look with NO holes.
//
// ⭐ FALL LOUDLY (a maintainer VALUE): the generator is the no-holes guarantee, so an UNREACHABLE
// generator must NOT silently degrade to a hole — this THROWS, and the confirm-list surfaces the failure
// (an error banner) instead of registering a partial/empty contribution. Silent failure is the enemy.
import { bsc } from "@/shared/lib/core/bsc";
import { KNOWN_GRAPH_CATEGORIES } from "@/shared/ui/kit";

/** The brand-accent seed hue the contract's categorical palette was generated from (bsc-ui S3, #2636):
 *  the known category colours sit evenly spaced from here, so we seed the generator with those hues to
 *  keep NEW categories visually distinct from the contract's existing ones. */
const SEED_HUE = 70;

/** Reconstruct the hues the contract's existing categories occupy — evenly spaced from the seed, the
 *  same layout `bsc ui generate categorical` produced them with (#2636). Feeding these as the "already
 *  used" set steers each new hue into an empty gap rather than colliding with a built-in category. */
function knownCategoryHues(): number[] {
  const n = KNOWN_GRAPH_CATEGORIES.size || 1;
  return Array.from({ length: n }, (_, i) => (SEED_HUE + (i * 360) / n) % 360);
}

/**
 * Generate a distinct colour for each `missing` category via the deterministic generator (#2636),
 * placing each new hue in the LARGEST circular gap among the hues already in use — the "no-holes"
 * primitive (`bsc ui generate next`) — seeded with the contract's existing category hues so new
 * categories don't collide with the built-ins, and with each freshly-placed hue so they don't collide
 * with each other. Returns `{ category → colour }` in `missing` order.
 *
 * @throws if the generator is unreachable or returns an unexpected shape — falls LOUDLY so the caller
 *   surfaces it rather than shipping a silent hole.
 */
export async function generateCategoryColors(missing: string[]): Promise<Record<string, string>> {
  const used = knownCategoryHues();
  const out: Record<string, string> = {};
  for (const cat of missing) {
    const raw = (await bsc(null, ["ui", "generate", "next", "--existing", used.join(",")])).trim();
    const parsed = JSON.parse(raw) as { hue?: number; color?: string };
    if (typeof parsed.hue !== "number" || typeof parsed.color !== "string" || !parsed.color) {
      throw new Error(`generator returned an unexpected shape for “${cat}”: ${raw.slice(0, 120)}`);
    }
    used.push(parsed.hue);
    out[cat] = parsed.color;
  }
  return out;
}
