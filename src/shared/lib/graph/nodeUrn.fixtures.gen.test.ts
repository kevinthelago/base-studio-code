// The node-URN grammar, captured from the LIVE TypeScript so the Rust port can be proved equal.
//
// The grammar is load-bearing for cross-graph resolution: `@bsc/algorithms/fibonacci` is kit-less, so
// a React component resolves a TypeScript implementation across BOTH pillar and technology. The graph
// STORE is Rust's — `bsc graph impl get`, `bsc ui get` — but the grammar that says what a URN IS lived
// only in the renderer, so the backend could hold every record and still not parse a reference to one.
//
// A grammar is defined as much by what it REFUSES as by what it accepts, so the rejections carry the
// same weight here as the accepts.
//
//     UPDATE_FIXTURES=1 npx vitest run src/shared/lib/graph/nodeUrn.fixtures.gen.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  NODE_GRAPHS,
  LIBRARY_ROOT,
  LIBRARY_SEGMENT,
  isNodeGraph,
  formatNodeUrn,
  parseNodeUrn,
  isNodeUrn,
  isLibrarySpec,
  parseLibrarySpec,
  urnToImportSpec,
} from "@/shared/lib/graph/nodeUrn";

const FIXTURE = join(process.cwd(), "src/shared/lib/graph/nodeUrn.fixtures.json");

/** Strings put through every parser. Accepts and rejections, each labelled with what it pins. */
const SUBJECTS: Array<[string, string]> = [
  ["a plain urn", "algo:rust/fibonacci"],
  ["the ui graph", "ui:react/Button"],
  ["the sound graph", "sound:kit/click"],
  ["a kit with a slash — LAST slash splits", "algo:rust/nested/fibonacci"],
  ["a deep kit", "ui:react/a/b/c/Thing"],
  ["unknown graph is refused", "nope:rust/fibonacci"],
  ["empty graph is refused", ":rust/fibonacci"],
  ["no colon is refused", "algo/rust/fibonacci"],
  ["colon at index 0 is refused", ":algo:rust/x"],
  ["no slash is refused", "algo:rustfibonacci"],
  ["slash at index 0 of the rest is refused", "algo:/fibonacci"],
  ["empty id is refused", "algo:rust/"],
  ["empty string is refused", ""],
  ["a bare graph name is refused", "algo"],
  ["a library spec is not a urn", "@bsc/algorithms/fibonacci"],
  ["ui library spec", "@bsc/ui/Button"],
  ["sounds library spec", "@bsc/sounds/click"],
  ["a library spec with a nested name", "@bsc/algorithms/a/b"],
  ["unknown segment is refused", "@bsc/nope/fibonacci"],
  ["library root alone is refused", "@bsc/"],
  ["library root with no name is refused", "@bsc/algorithms/"],
  ["a near-miss root is not a library spec", "@bscx/algorithms/fibonacci"],
  ["an ordinary npm package is not a library spec", "react"],
  ["a scoped npm package is not a library spec", "@scope/pkg"],
];

/** Triples put through the formatter, including the rejected ones. */
const FORMATS: Array<[string, string, string, string]> = [
  ["ordinary", "algo", "rust", "fibonacci"],
  ["ui", "ui", "react", "Button"],
  ["unknown graph is refused", "nope", "rust", "x"],
  ["empty kit is refused", "algo", "", "x"],
  ["empty id is refused", "algo", "rust", ""],
];

function build() {
  return {
    note: "GENERATED from the live TypeScript — see nodeUrn.fixtures.gen.test.ts",
    graphs: NODE_GRAPHS,
    libraryRoot: LIBRARY_ROOT,
    librarySegment: LIBRARY_SEGMENT,
    graphPredicate: ["algo", "ui", "sound", "nope", "", "ALGO"].map((g) => ({
      value: g,
      isNodeGraph: isNodeGraph(g as never),
    })),
    formats: FORMATS.map(([why, graph, kit, id]) => ({
      why, graph, kit, id,
      formatted: formatNodeUrn(graph as never, kit, id),
    })),
    subjects: SUBJECTS.map(([why, s]) => ({
      why,
      subject: s,
      parseNodeUrn: parseNodeUrn(s),
      isNodeUrn: isNodeUrn(s),
      isLibrarySpec: isLibrarySpec(s),
      parseLibrarySpec: parseLibrarySpec(s),
      urnToImportSpec: urnToImportSpec(s),
    })),
  };
}

describe("the node-URN grammar is captured for Rust to match", () => {
  it("matches the committed fixture (UPDATE_FIXTURES=1 to regenerate)", () => {
    const text = JSON.stringify(build(), null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES === "1") writeFileSync(FIXTURE, text);
    expect(existsSync(FIXTURE), `${FIXTURE} is missing — run with UPDATE_FIXTURES=1`).toBe(true);
    expect(readFileSync(FIXTURE, "utf8")).toBe(text);
  });

  it("records as many REJECTIONS as accepts — a grammar is defined by what it refuses", () => {
    const s = build().subjects;
    expect(s.filter((x) => x.parseNodeUrn === null).length).toBeGreaterThanOrEqual(8);
    expect(s.filter((x) => x.parseNodeUrn !== null).length).toBeGreaterThanOrEqual(5);
    expect(s.some((x) => x.parseLibrarySpec !== null)).toBe(true);
  });
});
