// The GPU graph renderer against a REAL WebGL2 context (`gpu-graph-slice-1-renderer-core`).
//
// WHAT THIS CAN AND CANNOT PROVE, stated up front because getting that wrong is this repo's recurring
// failure. It proves the DETERMINISTIC claims: the programs link, a million-node draw issues no GL error,
// picking agrees with drawing, and selection touches exactly one byte. It does NOT assert a frame budget,
// because headless Chromium resolves WebGL to SwiftShader — a SOFTWARE rasterizer. An fps assertion here
// would measure SwiftShader on whatever machine ran it, and would then either fail for a reason unrelated
// to the code or pass while proving nothing about the GPU.
//
// The performance claim is measured where it actually matters — the app's own WebKitGTK webview on the
// target hardware, via the remote inspector — and recorded on `epic-graphs-render-on-the-gpu`:
//
//     1M small quads (nodes)   1.55 ms/frame   645 fps    11 MB VRAM
//     5M wide quads (edges)   13.2  ms/frame    76 fps    57 MB
//    10M wide quads           22.2  ms/frame    45 fps   114 MB
//
// SERIAL, WITH ONE SHARED GRAPH. Building a million nodes and two million edges under SwiftShader costs
// tens of seconds, and doing it per test blew the default timeout on two of five. The graph is immutable
// across the read-only assertions, and the two mutating tests (`select`, `move`) touch one instance each
// and reset the counters first, so sharing costs nothing in isolation and removes four rebuilds.
import { test, expect, type Page } from "@playwright/test";

const HARNESS = "/e2e/harness/gl-graph-harness.html";
// A million nodes and two million edges — the epic's target, not a comfortable sample size.
const NODES = 1_000_000;
const EDGES = 2_000_000;

test.describe.configure({ mode: "serial" });
// TRACING OFF for this file. The trace fixture serialises the page on setup, and a page holding a
// million-node WebGL state takes longer to snapshot than the fixture's own 30 s budget — which failed as
// "Fixture 'trace recording' timeout" and reads exactly like a product bug when it is a harness cost.
// Nothing here needs a trace: every assertion is a counter read, not a visual.
test.use({ trace: "off" });

let page: Page;
let made: { ok: boolean; renderer: string; nodeCount: number; edgeCount: number };
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  // Generous: this is the software-rasterizer upload of 1M nodes + 2M edges, once for the whole file.
  test.setTimeout(240_000);
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__glGraphHarness);
  made = await page.evaluate(([n, e]) => window.__glGraphHarness!.create(n, e), [NODES, EDGES]);
});

test.afterAll(async () => { await page?.close(); });

test("constructs and uploads a million nodes and two million edges", async () => {
  expect(made.ok, `renderer failed to construct on "${made.renderer}"`).toBe(true);
  expect(made.nodeCount).toBe(NODES);
  expect(made.edgeCount).toBe(EDGES);
  expect(pageErrors).toEqual([]);
});

test("draws without a GL error", async () => {
  test.setTimeout(240_000);
  const perFrame = await page.evaluate(() => window.__glGraphHarness!.draw(3));
  // 0 is GL_NO_ERROR. Anything else means the draw was REJECTED — the most likely way a shader or
  // attribute-layout mistake reaches production looking fine, because a rejected draw is simply invisible.
  expect(await page.evaluate(() => window.__glGraphHarness!.glError())).toBe(0);
  const software = await page.evaluate(() => window.__glGraphHarness!.isSoftware());
  // Reported, never asserted — see the header. And the TIMING IS SUPPRESSED under a software rasterizer:
  // SwiftShader defers until the buffer is read, so `finish()` returns immediately and the measurement
  // came back as "0.0ms" for a draw that visibly took minutes. A number that wrong is worse than none —
  // someone would eventually quote it.
  console.log(
    software
      ? `  renderer=${made.renderer} — SOFTWARE, frame timing not meaningful here (see the header for the measured numbers)`
      : `  renderer=${made.renderer} frame=${perFrame.toFixed(2)}ms`,
  );
});

test("the whole graph is TWO draw calls per frame, whatever the node count", async () => {
  test.setTimeout(240_000);
  await page.evaluate(() => window.__glGraphHarness!.resetCounters());
  await page.evaluate(() => window.__glGraphHarness!.draw(1));
  const c = await page.evaluate(() => window.__glGraphHarness!.counters());
  // `draw(1)` warms up with 3 frames then times 1: 4 frames × 2 calls. The number that matters is that it
  // is CONSTANT — no per-node and no per-batch call, at any graph size.
  expect(c.drawInstanced).toBe(8);
  // And nothing is re-uploaded to draw a frame. A renderer that rebuilt a buffer per frame would be O(N)
  // per frame with extra steps, which is the shape being replaced.
  expect(c.bufferData).toBe(0);
  expect(c.bufferSubData).toBe(0);
});

test("picking agrees with drawing at a million nodes", async () => {
  // Spread across the whole index, including the first and last node: an off-by-one in the position
  // texture's row addressing shows up at the ends, not in the middle.
  for (const i of [0, 1, 2047, 2048, 500_000, 999_999]) {
    const got = await page.evaluate((n) => window.__glGraphHarness!.pickCenterOfNode(n), i);
    expect(got, `pick at the centre of node ${i}`).toBe(i);
  }
});

test("selecting a node writes ONE byte — the fix for the 371 ms click", async () => {
  await page.evaluate(() => window.__glGraphHarness!.resetCounters());
  await page.evaluate(() => window.__glGraphHarness!.select(123_456));
  const c = await page.evaluate(() => window.__glGraphHarness!.counters());
  // The measured DOM graph re-rendered on selection, which is why one click cost 371-506 ms at 402 nodes.
  // Here it is one `bufferSubData` of one byte, at a million. If this ever becomes a whole-buffer upload
  // it is still "correct" and silently O(N) again — which is why the BYTE COUNT is asserted, not just the
  // call count.
  expect(c.bufferSubData).toBe(1);
  expect(c.bufferSubDataBytes).toBe(1);
  expect(c.bufferData).toBe(0);
  expect(c.texImage2D).toBe(0);
});

test("moving a node writes ONE texel, not the whole position texture", async () => {
  await page.evaluate(() => window.__glGraphHarness!.resetCounters());
  await page.evaluate(() => window.__glGraphHarness!.move(2048, 12, 34));
  const c = await page.evaluate(() => window.__glGraphHarness!.counters());
  // Positions live in a texture precisely so an edge never stores its endpoints: moving one node is O(1)
  // instead of O(E). A `texImage2D` here would mean the whole 1M-node texture was re-uploaded.
  expect(c.texSubImage2D).toBe(1);
  expect(c.texImage2D).toBe(0);
  expect(c.bufferData).toBe(0);
});
