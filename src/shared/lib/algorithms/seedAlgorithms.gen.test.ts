// The algorithms-graph seed generator + drift guard (#3465).
//
// An implementation node promises its `code` "stands alone" — that is the graph's ONE guarantee, and
// the reason a node is worth anything to a consumer vendoring it. Before this, that code was
// hand-written into `algorithms.json` and NOTHING checked it: `llm-energy.ts` (#3462) shipped with no
// test referencing it anywhere, so the guarantee was a claim. The same "declared but never actually
// rendered" failure the react-d3 kit hit, on the graph's load-bearing property.
//
// So the code lives as a REAL module under `seed/` and the JSON is generated from it. Four things
// become true that inspection cannot establish:
//
//   compiles     — `tsc` checks it with the rest of the repo
//   runs         — its sibling `.test.ts` imports and executes it
//   standalone   — asserted here: a seed module has NO imports
//   never drifts — asserted here: the JSON matches the file, byte for byte
//
// Regenerate with `UPDATE_ALGOS=1 npx vitest run seedAlgorithms.gen`.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SEED_DIR = join(process.cwd(), "src/shared/lib/algorithms");
const GRAPH_FILE = join(process.cwd(), "src-tauri/data/knowledge/algorithms.json");

/** seed module filename → the node id whose `code` it owns. */
const OWNED: Record<string, string> = {
  "llmEnergy.ts": "llm-energy.ts",
  "precedenceResolve.ts": "precedence-resolve.ts",
  "windowedTally.ts": "windowed-tally.ts",
  "streamMerge.ts": "stream-merge.ts",
  "orderByRank.ts": "order-by-rank.ts",
  "groupTotals.ts": "group-totals.ts",
};

interface Impl { id: string; code?: string }
const readGraph = (): { implementations: Impl[] } =>
  JSON.parse(readFileSync(GRAPH_FILE, "utf8")) as { implementations: Impl[] };

const readSeed = (file: string) => readFileSync(join(SEED_DIR, file), "utf8").replace(/\r\n/g, "\n").trimEnd();

describe("algorithms seed ↔ @data/knowledge/algorithms.json (#3465)", () => {
  const seedFiles = readdirSync(SEED_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("every seed module is accounted for — no orphan file, no missing node", () => {
    // An unmapped file is code that looks promoted but is not in the graph; a mapped file that is gone
    // is a node whose `code` nothing generates any more. Both are silent, so both are asserted.
    expect([...seedFiles].sort()).toEqual(Object.keys(OWNED).sort());
    const ids = new Set(readGraph().implementations.map((i) => i.id));
    for (const id of Object.values(OWNED)) expect(ids).toContain(id);
  });

  // THE property that makes a node reusable outside this app. A seed module that imports anything —
  // even another seed module — is not self-contained: whatever vendors it gets a broken module, and it
  // would be found by the consumer rather than here. Deliberately textual: it catches the mistake at
  // the moment it is made, without needing a module graph.
  it("no seed module imports anything — the standalone guarantee, enforced", () => {
    for (const file of seedFiles) {
      const src = readSeed(file);
      expect(src, `${file} must not import`).not.toMatch(/^\s*import\s/m);
      expect(src, `${file} must not require`).not.toMatch(/\brequire\s*\(/);
      expect(src, `${file} must export something`).toMatch(/^export /m);
    }
  });

  it("stays in sync with the graph (UPDATE_ALGOS=1 to regenerate)", () => {
    const graph = readGraph();
    let changed = false;
    for (const [file, id] of Object.entries(OWNED)) {
      const impl = graph.implementations.find((i) => i.id === id);
      expect(impl, `${id} is missing from the graph`).toBeDefined();
      const code = readSeed(file);
      if (process.env.UPDATE_ALGOS) {
        if (impl!.code !== code) { impl!.code = code; changed = true; }
      } else {
        expect(impl!.code, `${id}.code drifted from seed/${file} — run UPDATE_ALGOS=1`).toBe(code);
      }
    }
    if (changed) writeFileSync(GRAPH_FILE, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
  });
});
