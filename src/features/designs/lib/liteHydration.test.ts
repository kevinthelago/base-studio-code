// #4072 — the Studio's two-phase hydration. The Design Studio page blocked up to 8040ms on
// `bsc ui list --full` (1.72 MB over 321 components, 77.6% of it `srcText` no node reads). Phase 1
// now paints from `bsc ui list --graph` (33 KB); phase 2 fetches the full records in the background.
//
// A LITE record's empty `srcText` is a DEFAULT, not a value, and these lock the places that
// distinction is load-bearing — each of which silently does the wrong thing without it.
import { describe, it, expect } from "vitest";
import { scannableComponents } from "./componentScan";
import { projectComponent } from "./componentBridge";
import type { KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

// Same fixture shape as componentScan.test.ts: the artifact supplies the built-in's source by `src`.
const base: ComponentRecord = {
  id: "card", name: "Card", kitId: "react-ui", role: "primitive", version: "1.0.0", used: 0,
  tags: [], variants: ["default"], composes: [], props: [], whenUse: [], whenNot: [],
  src: "shared/ui/data/Card.tsx", srcText: "",
};

const ARTIFACT: KitArtifact = {
  components: [
    { id: "card", src: "shared/ui/data/Card.tsx", source: "export function Card() { return null; }" },
  ],
  runtime: {},
};

describe("lite records are never mistaken for source-less ones (#4072)", () => {
  it("scans a normal record — the baseline proving this fixture is buildable", () => {
    expect(scannableComponents([base], ARTIFACT).map((s) => s.id)).toEqual(["card"]);
  });

  it("SKIPS the same record once it is lite", () => {
    // Identical in every other respect, so `lite` is provably the reason. Without the skip, a lite
    // record's empty `srcText` reads as "not buildable" and the component is either dropped from the
    // scan or badged broken — and that verdict is cached under its signature.
    expect(scannableComponents([{ ...base, lite: true }], ARTIFACT)).toEqual([]);
  });

  it("does not poison the sweep — a lite record's siblings still scan", () => {
    const sibling: ComponentRecord = { ...base, id: "card2", name: "Card2" };
    const artifact: KitArtifact = {
      components: [
        ...ARTIFACT.components,
        { id: "card2", src: "shared/ui/data/Card.tsx", source: "export function Card2() { return null; }" },
      ],
      runtime: {},
    };
    const out = scannableComponents([{ ...base, lite: true }, sibling], artifact);
    expect(out.map((s) => s.id)).toEqual(["card2"]);
  });

  it("projectComponent leaves `lite` unset for a normal record", () => {
    // Only the graph loader stamps it; a full record must never carry it, or the preview would wait
    // forever for a second read that is never coming.
    expect(projectComponent({ id: "x", name: "X", kitId: "k" }).lite).toBeUndefined();
  });
});
