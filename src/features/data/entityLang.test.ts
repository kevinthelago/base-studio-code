// The Data graph's axis (`define-the-axis-for-teams-data-and-sounds`) — the LANGUAGE an entity lives in.
//
// Derived from `src` rather than stored: the language is already implied by where the entity is
// defined, and a second stored copy is one more thing that can go stale. What matters is that the
// derivation never DROPS an entity — an entity with no tab is invisible in the UI, and nothing errors
// to say so.
import { describe, it, expect } from "vitest";
import { entityLang, type DataEntity } from "@/features/data/DataGraphPage";

const e = (src?: string): DataEntity => ({ id: "x", name: "X", ...(src ? { src } : {}) });

describe("entityLang", () => {
  it("reads the language off the source path", () => {
    expect(entityLang(e("src/store/index.ts"))).toBe("typescript");
    expect(entityLang(e("src/app/App.tsx"))).toBe("typescript");
    expect(entityLang(e("crates/plandb/src/issues.rs"))).toBe("rust");
  });

  it("never drops an entity — an unknown or missing src is 'other', not nothing", () => {
    // The failure this prevents is silent: an entity mapped to no language would appear under no tab,
    // and a data graph that quietly omits a record is worse than one that shows it in a catch-all.
    expect(entityLang(e())).toBe("other");
    expect(entityLang(e("schema.sql"))).toBe("other");
    expect(entityLang(e("Cargo.toml"))).toBe("other");
    expect(entityLang({ id: "y", name: "Y", src: "" })).toBe("other");
  });

  it("is case-insensitive about the suffix", () => {
    // A path from a case-preserving filesystem must not land in `other` on a technicality.
    expect(entityLang(e("SRC/Store/Index.TS"))).toBe("typescript");
    expect(entityLang(e("crates/Foo/SRC/Lib.RS"))).toBe("rust");
  });

  it("classifies a cross-boundary PAIR into two languages, which is the point of the lens", () => {
    // `store-plan` is the TypeScript view of the same data plan.db holds in Rust. They are two ends of
    // ONE boundary, so they land on different tabs — and the tab must scope what is listed without
    // implying the two sides are unrelated. If this ever collapsed them into one language the gap that
    // makes the Rust side worth adding would stop being visible.
    expect(entityLang(e("src/store/types/plan.ts"))).toBe("typescript");
    expect(entityLang(e("crates/plandb/src/lib.rs"))).toBe("rust");
  });
});
