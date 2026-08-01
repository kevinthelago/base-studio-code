// The buildability PREDICATE (#4130) must stay exactly `componentPreviewFiles(...) !== null`.
//
// `analyzeGraphHealth` (and its Rust twin `bsc ui doctor`) decide "spec or implementation" with
// `componentBuildable`, which answers off cached indexes instead of building a preview bundle. If the two
// ever disagree the graph accuses a component the preview renders happily — the #3486/#2954 failure mode —
// so this pins them together over a library shaped like the real one, in several sibling arrangements.
import { describe, it, expect } from "vitest";
import reactUiArtifact from "@data/components/react-ui.json";
import { componentPreviewFiles, componentBuildable, type KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

const ARTIFACT = reactUiArtifact as unknown as KitArtifact;
const BUILTIN = ARTIFACT.components.find((c) => c.source)!;

const comp = (o: Partial<ComponentRecord> & Pick<ComponentRecord, "id">): ComponentRecord =>
  ({
    name: o.id, kitId: "k", role: "primitive", version: "", used: 0, tags: [], variants: ["default"],
    composes: [], props: [], whenUse: [], whenNot: [], src: "", srcText: "", ...o,
  }) as ComponentRecord;

// One record per shape the predicate has to get right.
const LIBRARY: ComponentRecord[] = [
  comp({ id: "builtin", src: BUILTIN.src }),                                     // in the artifact
  comp({ id: "spec", srcText: "import { X } from \"@/x\";\n<X …/>" }),           // usage snippet
  comp({ id: "empty" }),                                                          // nothing at all
  comp({ id: "explicit", source: "export const A = () => null;" }),              // explicit source, trusted
  // NOTE the path form: a sibling resolves by `stripExt(src)` against the `@/…` specifier, so its `src`
  // is src/-RELATIVE (`u/M.tsx`), matching the artifact keys — a store record's `src/`-prefixed path is the
  // known mismatch #3660 sidesteps by keying on the specifier.
  comp({ id: "module", src: "u/M.tsx", srcText: "export const M = () => null;" }),
  comp({ id: "sibimport", src: "src/u/S.tsx", srcText: "import { M } from \"@/u/M\";\nexport const S = () => M;" }),
  comp({ id: "badimport", src: "src/u/B.tsx", srcText: "import { Z } from \"@/nope/Z\";\nexport const B = () => Z;" }),
  comp({ id: "typeonly", src: "src/u/T.tsx", srcText: "import type { P } from \"@/nope/P\";\nexport const T = () => null;" }),
  comp({ id: "elided", src: "src/u/E.tsx", srcText: "export const E = () => { … };" }),
  comp({ id: "provider", src: "src/u/P.tsx", provides: "@/shared/ui/Prov", source: "export const P = () => null;" }),
  comp({ id: "consumer", src: "src/u/C.tsx", srcText: "import { P } from \"@/shared/ui/Prov\";\nexport const C = () => P;" }),
];

const SHAPES: Array<[string, readonly ComponentRecord[]]> = [
  ["whole library", LIBRARY],
  ["no siblings", []],
  ["single sibling", [LIBRARY[4]]],
];

describe("componentBuildable", () => {
  for (const [label, siblings] of SHAPES) {
    it(`agrees with componentPreviewFiles for every record — ${label}`, () => {
      for (const c of LIBRARY) {
        expect(componentBuildable(c, ARTIFACT, siblings), c.id).toBe(
          componentPreviewFiles(c, ARTIFACT, siblings) !== null,
        );
      }
    });
  }

  it("covers both verdicts, so the agreement above is not vacuously true", () => {
    const verdicts = LIBRARY.map((c) => componentBuildable(c, ARTIFACT, LIBRARY));
    expect(verdicts).toContain(true);
    expect(verdicts).toContain(false);
  });

  it("resolves a sibling import only when that sibling is actually present", () => {
    const s = LIBRARY.find((c) => c.id === "sibimport")!;
    expect(componentBuildable(s, ARTIFACT, LIBRARY)).toBe(true);   // `module` is there
    expect(componentBuildable(s, ARTIFACT, [s])).toBe(false);      // alone ⇒ nothing to resolve `@/u/M`
  });

  it("does not let a component resolve an import against ITSELF", () => {
    // `sibByBase` excludes the component under test; a cached whole-array index must honour that.
    const self = comp({ id: "self", src: "u/M.tsx", srcText: "import { M } from \"@/u/M\";\nexport const M2 = () => M;" });
    expect(componentBuildable(self, ARTIFACT, [self])).toBe(
      componentPreviewFiles(self, ARTIFACT, [self]) !== null,
    );
  });

  it("is stable across repeated calls with the same arrays (the identity caches are not stateful)", () => {
    const first = LIBRARY.map((c) => componentBuildable(c, ARTIFACT, LIBRARY));
    const second = LIBRARY.map((c) => componentBuildable(c, ARTIFACT, LIBRARY));
    expect(second).toEqual(first);
  });
});
