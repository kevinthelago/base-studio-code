import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { WIDGETS, widgetById } from "./widgets";

// The catalogue exists twice — here and in `bsc_widget::WIDGETS` — because the CLI
// must know the set without a running app, and the frontend must dispatch on it
// literally. Two copies drift; these tests are what stop that being silent.

// Paths are resolved from the repo root (vitest's cwd) rather than from
// import.meta.url: this file runs under jsdom, where import.meta.url is not a
// file: URL and readFileSync refuses it.
//
// AND THE RUST SIDE IS A RECORD, not a file. `crates/bsc-widget/src/lib.rs` no
// longer exists (`the-crate-root-implementations-move-into-the-graph`): the crate
// root is a record in the committed store, which is what
// `crates/graph-materialize/build.rs` materializes for the compiler. So this still
// reads the OTHER SIDE'S OWN SOURCE — it reads it from where that source now lives.
// Same pattern as `recordResolvers.test.ts`, keyed on `src` because that is the path
// this test used to open and is what says "the same module".
const rustSrc = ((): string => {
  const store = JSON.parse(readFileSync("graph/algorithms.json", "utf8")) as {
    implementations?: { src?: string; code?: string }[];
  };
  const rec = (store.implementations ?? []).find((i) => i.src === "crates/bsc-widget/src/lib.rs");
  // NON-VACUITY: a store that parsed to nothing, or a record whose `src` moved, must fail LOUDLY
  // here rather than as an empty catalogue that reads like the ids were deleted.
  if (!rec?.code) throw new Error("no record in graph/algorithms.json has src crates/bsc-widget/src/lib.rs");
  return rec.code;
})();

/** Ids declared in the Rust catalogue, read from its source. */
function rustWidgetIds(): string[] {
  // Bounded to the const DECLARATION, not to the end of file: the tests below
  // it mention the same ids, and scanning past the closing bracket counted
  // every one of them twice.
  const start = rustSrc.indexOf("pub const WIDGETS");
  const end = rustSrc.indexOf("];", start);
  if (start < 0 || end < 0) throw new Error("could not locate the Rust WIDGETS declaration");
  const block = rustSrc.slice(start, end);
  const ids = [...block.matchAll(/id:\s*"([a-z0-9-]+)"/g)].map((m) => m[1]);
  return ids.sort();
}

describe("the widget catalogue", () => {
  it("agrees with the Rust catalogue — neither side can gain a widget alone", () => {
    const rust = rustWidgetIds();
    // A scanner that stopped matching would report an empty set, which would
    // then "agree" with an empty frontend list and prove nothing.
    expect(rust.length, "read no widget ids out of the Rust source").toBeGreaterThan(0);
    expect(WIDGETS.map((w) => w.id).sort()).toEqual(rust);
  });

  it("every node is uniquely identified", () => {
    const ids = WIDGETS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every node declares a title and a stream", () => {
    for (const w of WIDGETS) {
      expect(w.title.length, w.id).toBeGreaterThan(0);
      expect(["lan_spectrum", "none"]).toContain(w.stream);
    }
  });

  it("an unknown id resolves to null rather than a default", () => {
    // Opening 'some widget' because the requested one was unknown is worse than
    // refusing: the caller would believe they got what they asked for.
    for (const bad of ["", "Spectrum", "../etc/passwd", "spectrum "]) {
      expect(widgetById(bad), bad).toBeNull();
    }
    expect(widgetById("spectrum")).not.toBeNull();
  });
});

describe("the detached dispatch", () => {
  const detached = readFileSync("src/app/DetachedWindow.tsx", "utf8");

  it("routes every widget by a LITERAL case, never a lookup", () => {
    // The property that makes a CLI-supplied id safe. A lookup here would hand
    // user-controlled input the choice of what mounts.
    for (const w of WIDGETS) {
      expect(detached, `no literal case for ${w.id}`).toContain(`case "${w.id}":`);
    }
  });

  it("has no dynamic component lookup in the widget switch", () => {
    const block = detached.slice(detached.indexOf('case "widget":'));
    expect(block.slice(0, 600)).not.toMatch(/\[\s*section\s*\]/);
  });
});
