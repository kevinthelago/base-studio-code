// memoryGraph.spec.ts — the Memory graph drawn at the size of the store, in real Chromium
// (the-memory-graph-is-tested-in-a-real-browser).
//
// It asserts the page draws EVERY memory and EVERY edge the graph serves, and it prints what that cost as one
// `MEMORY_GRAPH {…}` line: time to drawn, the main-thread blocks (long tasks), and DOM size. Screenshots of the
// fitted graph and of a selection are kept in the test's output directory.
//
// The graph is SYNTHETIC by default — the store's shape at the store's scale (1,400 memories, each joined to its
// 3 nearest, clustered by subject, a few written links) — so the spec needs no machine's memory.db and ships no
// one's memories. To draw the REAL store:
//
//     bsc memory graph --json > /var/tmp/memory-graph.json
//     MEMORY_GRAPH_JSON=/var/tmp/memory-graph.json npx playwright test e2e/memoryGraph.spec.ts
//
// ⚠️ Chromium is not WebKitGTK (see memoryGraphHarness.ts): the numbers are the APP's work, not the shipping
// renderer's speed.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const HARNESS = "/e2e/harness/memory-graph-harness.html";
const KINDS = ["record", "record", "record", "record", "note", "entry", "lesson", "highlight", "topic"];

/** A store-shaped graph: `n` memories in subjects of ~40, each joined to its 3 nearest inside its subject, with a
 *  written link every few memories and one between each pair of neighbouring subjects so the whole is connected. */
function syntheticGraph(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({
    // Built as a STRING: a real memory id is epoch nanoseconds, past Number.MAX_SAFE_INTEGER, and adding to it
    // as a number collapses hundreds of neighbours onto one id (the first run of this spec did exactly that).
    id: `1788000000${String(i).padStart(9, "0")}`,
    name: i % 97 === 0 ? `subject-${i}` : "",
    title: `memory ${i} about subject ${Math.floor(i / 40)} — a line long enough to be truncated in its card`,
    kind: KINDS[i % KINDS.length],
    status: "open",
    rel: "",
    // Card centres, as `bsc memory graph --json` serves them: each subject a cloud on a grid of subjects.
    x: (Math.floor(i / 40) % 6) * 1800 + Math.cos(i) * (120 + (i % 40) * 18),
    y: Math.floor(Math.floor(i / 40) / 6) * 1800 + Math.sin(i) * (120 + (i % 40) * 18),
  }));
  const edges: { from: string; to: string; rel: string; score?: number; rank?: number }[] = [];
  const seen = new Set<string>();
  const add = (a: number, b: number, rel: string, score?: number, rank?: number) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (a === b || b >= n || seen.has(key)) return;
    seen.add(key);
    edges.push({ from: nodes[a].id, to: nodes[b].id, rel, score, rank });
  };
  for (let i = 0; i < n; i++) {
    const subject = Math.floor(i / 40);
    for (let r = 1; r <= 3; r++) {
      const j = subject * 40 + ((i - subject * 40 + r * 7) % 40);
      add(i, j, "similar", 0.5 - r * 0.08, r);
    }
    if (i % 9 === 0) add(i, i + 3, "about");
    if (i % 40 === 39) add(i, i + 1, "because");
  }
  return { roots: [], unattached: [], recordNotes: 0, topics: 0, sections: 0, neighbors: 3, nodes, edges };
}

test("the Memory graph draws a store-sized graph in Chromium, and says what it cost", async ({ page }, info) => {
  test.setTimeout(180_000);
  const graph = process.env.MEMORY_GRAPH_JSON ? JSON.parse(readFileSync(process.env.MEMORY_GRAPH_JSON, "utf8")) : syntheticGraph(1400);
  const list = (graph.nodes as { id: string; title: string; kind: string; status: string }[]).map((m) => ({
    id: m.id, text: m.title, tags: [], created_at_ms: 1, status: m.status, horizon: "now", kind: m.kind, links: [],
  }));
  const similar = (graph.edges as { rel: string }[]).filter((e) => e.rel === "similar").length;

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__memoryGraphHarness, undefined, { timeout: 120_000 });
  const r = await page.evaluate(({ graph, list }) => window.__memoryGraphHarness!.mount(graph, list), { graph, list });
  expect(r, "error" in r ? r.error : "").toHaveProperty("ok", true);
  if (!r.ok) return;

  console.log(`MEMORY_GRAPH ${JSON.stringify({ source: process.env.MEMORY_GRAPH_JSON ? "live" : "synthetic", nodes: graph.nodes.length, ...r })}`);
  // Fit frames the WHOLE store: every card's box lies inside the canvas viewport. The shared viewport's default 28%
  // floor stopped Fit at about half of an 8,000 px graph.
  const outside = await page.evaluate(() => {
    const vp = document.querySelector(".mem-graph-edges")?.closest("[class*='viewport'], [class*='canvas']")?.parentElement ?? document.body;
    const frame = vp.getBoundingClientRect();
    return [...document.querySelectorAll(".mem-node")].filter((n) => {
      const b = n.getBoundingClientRect();
      return b.right < frame.left - 1 || b.left > frame.right + 1 || b.bottom < frame.top - 1 || b.top > frame.bottom + 1;
    }).length;
  });
  expect(outside, "cards Fit left outside the canvas").toBe(0);
  await page.screenshot({ path: info.outputPath("memory-graph-fit.png") });

  expect(r.nodeCards).toBe(graph.nodes.length);
  expect(r.edges).toBe(graph.edges.length);
  expect(r.similarEdges).toBe(similar);
  expect(r.arrowheads, "a similarity edge carries no arrowhead").toBe(graph.edges.length - similar);
  // THE BUDGET. The page laid ~1,400 memories out itself and blocked the main thread for 1,218 ms; with positions
  // served by `bsc memory graph` the longest block measured 184-207 ms. 600 ms is well clear of the fix and well
  // under the bug, so a regression that moves the layout back onto the page fails here.
  expect(r.longTasksMs[0] ?? 0, `main-thread blocks ${JSON.stringify(r.longTasksMs)}`).toBeLessThan(600);
  expect(r.layoutMs, "served positions are drawn as given, not re-simulated").toBeLessThan(100);

  // Select a memory and keep what its lit neighbourhood looks like. Dispatched, not clicked: at a fitted zoom a
  // given card can sit outside the viewport, and the question is what a selection draws, not where the mouse is.
  await page.locator(".mem-node").nth(5).dispatchEvent("click");
  await expect(page.locator(".mem-inspector-selected")).toBeVisible();
  await page.screenshot({ path: info.outputPath("memory-graph-selected.png") });
});

test("a sidecar that serves no positions still gets every memory drawn (the page lays it out itself)", async ({ page }) => {
  test.setTimeout(120_000);
  const graph = syntheticGraph(300);
  for (const n of graph.nodes as Record<string, unknown>[]) {
    delete n.x;
    delete n.y;
  }
  const list = graph.nodes.map((m) => ({ id: m.id, text: m.title, tags: [], created_at_ms: 1, status: m.status, horizon: "now", kind: m.kind, links: [] }));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__memoryGraphHarness, undefined, { timeout: 120_000 });
  const r = await page.evaluate(({ graph, list }) => window.__memoryGraphHarness!.mount(graph, list), { graph, list });
  expect(r, "error" in r ? r.error : "").toHaveProperty("ok", true);
  if (!r.ok) return;
  console.log(`MEMORY_GRAPH_FALLBACK ${JSON.stringify({ nodes: graph.nodes.length, ...r })}`);
  expect(r.nodeCards).toBe(300);
  expect(r.edges).toBe(graph.edges.length);
});
