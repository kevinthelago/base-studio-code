// EVERY PACKAGED APP RECORD MUST SURVIVE ITS OWN LOAD PROJECTION — `seed === load(push(seed))` (#2514).
//
// `SEED_COMPONENTS` stamps each packaged JSON with `stampSeedHash(projectComponent(raw))`. If the raw JSON
// carries a field the projection normalizes — an empty array where the projection wants it absent, a key it
// drops — then the stamped hash describes content the store will never reproduce. The record then reads as
// PRISTINE-BUT-CHANGED on every single boot: `reconcileSeed` reports `refreshed`, `hydrateComponents`
// re-pushes it, and the same write repeats forever.
//
// Nothing else notices. The app works, the record renders, and the churn is invisible unless a test happens
// to assert an empty reconcile — which is exactly how this was found: promoting two records made three
// unrelated `store.test.ts` cases fail, and the failure named `console-pane-menu` rather than the field that
// broke it. This test names the field.
import { describe, it, expect } from "vitest";
import type { ComponentRecord } from "@/features/designs/lib/model";
import { projectComponent } from "@/features/designs/lib/componentBridge";
import { seedHashOf } from "@/features/designs/lib/seedRefresh";

const raw = import.meta.glob<Partial<ComponentRecord>>("@data/components/app/**/*.json", {
  eager: true,
  import: "default",
});

describe("packaged app records round-trip through the load projection (#2514)", () => {
  const paths = Object.keys(raw).sort();

  it("has records to check", () => {
    expect(paths.length).toBeGreaterThan(20);
  });

  it("no id appears twice — the glob is FLAT, so folders do not namespace", () => {
    // `SEED_COMPONENTS` globs `app/**` and keys by `id`, so two files under different folders sharing an
    // id are two records with one identity. `reconcileSeed` then reports that id as pristine-but-changed
    // on every boot and re-pushes it, forever. The app keeps working, which is why it took three unrelated
    // `store.test.ts` failures to surface — and those named the record, not the duplication.
    const seen = new Map<string, string[]>();
    for (const p of paths) {
      const id = raw[p]?.id;
      if (!id) continue;
      seen.set(id, [...(seen.get(id) ?? []), p]);
    }
    const dupes = [...seen].filter(([, ps]) => ps.length > 1).map(([id, ps]) => `${id}: ${ps.join(" · ")}`);
    expect(dupes).toEqual([]);
  });

  it("projecting a packaged record TWICE is the same as projecting it once", () => {
    // The round-trip in the form this test can see without a store: the projection must be idempotent,
    // or the hash stamped over `project(raw)` cannot survive `project(load(...))`.
    const unstable: string[] = [];
    for (const p of paths) {
      const once = projectComponent(raw[p]);
      const twice = projectComponent({ ...once });
      if (seedHashOf(once) !== seedHashOf(twice)) {
        const a = once as unknown as Record<string, unknown>;
        const b = twice as unknown as Record<string, unknown>;
        const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
          (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
        );
        unstable.push(`${p.split("/").pop()} — differs on: ${fields.join(", ") || "(field set)"}`);
      }
    }
    expect(unstable).toEqual([]);
  });

  it("a packaged record carries only fields the projection preserves", () => {
    // A field the projection DROPS is the other half of the same bug: it is in the JSON, absent from the
    // stamped record, and every reader after that disagrees with the file about what the record is.
    const dropped: string[] = [];
    for (const p of paths) {
      const projected = projectComponent(raw[p]) as unknown as Record<string, unknown>;
      const missing = Object.keys(raw[p] as Record<string, unknown>).filter((k) => !(k in projected));
      if (missing.length) dropped.push(`${p.split("/").pop()} — ${missing.join(", ")}`);
    }
    expect(dropped).toEqual([]);
  });
});
