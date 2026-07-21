// The design-generator bridge (#2658, epic #2606) — the frontend calls the SAME deterministic palette
// generator (`bsc ui generate`, crates/bsc-ui, #2636) the designer + agents use, over the generic `bsc`
// bridge. When a downloaded blueprint's reconcile (#2646) leaves categories the contract doesn't define,
// this fills each with a coherent colour so the shared blueprint brings its look with NO holes.
//
// ⭐ FALL LOUDLY (a maintainer VALUE): the generator is the no-holes guarantee, so an UNREACHABLE
// generator must NOT silently degrade to a hole — this THROWS, and the confirm-list surfaces the failure
// (an error banner) instead of registering a partial/empty contribution. Silent failure is the enemy.
import { bsc } from "@/shared/lib/core/bsc";
import DESCRIPTOR from "@data/ui/style-descriptor.json";
import { hueOfColor } from "./colorHue";

interface DomainDescriptor {
  domain?: { group: string; tokens?: { value?: string }[] }[];
}

/** The hues the contract's existing graph-category colours ACTUALLY occupy — parsed from their real
 *  values in the style descriptor (#2663), not reconstructed from an assumed even-spacing layout the
 *  contract never used (the built-ins are hand-authored hex at unrelated OKLCH hues). Feeding these real
 *  hues as the generator's "already used" set is what keeps a new category visually distinct from the
 *  built-ins. Computed once; a value that doesn't parse is skipped. */
const KNOWN_CATEGORY_HUES: number[] = (() => {
  const d = DESCRIPTOR as DomainDescriptor;
  const group = (d.domain ?? []).find((g) => g.group === "graph-category");
  return (group?.tokens ?? [])
    .map((t) => (t.value ? hueOfColor(t.value) : null))
    .filter((h): h is number => h != null);
})();

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
  const used = [...KNOWN_CATEGORY_HUES];
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
