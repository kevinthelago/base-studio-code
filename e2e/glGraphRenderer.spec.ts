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
// TIMEOUTS ARE 600 s, NOT A GUESS. Drawing 1M nodes + 2M edges under SwiftShader takes MINUTES: measured
// at 2.3, 3.3 and 3.6 minutes across runs, and 4.0 when a full `cargo`/`vitest` gate was competing for
// the CPU — which is where the old 240 s budget failed. The work is inherently slow here (see the header
// on software rasterization), so the budget has to cover the loaded case or the suite reports machine
// load as a product failure. Do NOT read a timeout at this scale as a regression without checking what
// else was running.
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
  test.setTimeout(600_000);
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
  test.setTimeout(600_000);
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
  test.setTimeout(600_000);
  // Asserted, not assumed: this runs before any label is set, so the label pass contributes nothing.
  // Without this line the "8" below would quietly become a statement about test ORDER — and a later
  // reordering would change what the test means without changing what it says.
  expect(await page.evaluate(() => window.__glGraphHarness!.glyphCount()), "no labels are set yet").toBe(0);
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
  // The only test here that was left on Playwright's default 30 s, while its seven siblings raise it.
  // The assertions take ~30 ms; the budget is for the SHARED page, which holds a million-node GL state
  // under a software rasterizer and is minutes deep into a serial file. It timed out once on a loaded
  // machine and passed at 30 ms on the next two runs — a flake with no signal in it, and a red test
  // that means nothing is worse than a slow one.
  test.setTimeout(600_000);
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

test("builds a distance-field atlas from a real font, once", async () => {
  test.setTimeout(600_000);
  const a = await page.evaluate(() => window.__glGraphHarness!.buildAtlas());
  expect(a.ok, "the atlas needs a real 2D context — jsdom has no text rasterization, which is why this is here").toBe(true);
  expect(a.glyphs).toBe(95); // printable ASCII
  expect(a.width).toBeGreaterThan(0);
  expect(a.height).toBeGreaterThan(0);
  console.log(`  atlas ${a.width}x${a.height}, ${a.glyphs} glyphs, built in ${a.ms.toFixed(0)}ms`);
});

test("the LOD gate bounds glyphs by SCREEN AREA, not by graph size", async () => {
  test.setTimeout(600_000);
  await page.evaluate(() => window.__glGraphHarness!.labelEveryNode());

  // Zoomed out over a million labelled nodes. Ungated this is ~12M glyph quads — over the frame budget
  // (10M wide quads measured at 22.2 ms) and illegible, which is the more important half. The gate must
  // emit NOTHING here.
  await page.evaluate(() => window.__glGraphHarness!.setScale(0.02));
  await page.evaluate(() => window.__glGraphHarness!.draw(1));
  const zoomedOut = await page.evaluate(() => window.__glGraphHarness!.glyphCount());
  expect(zoomedOut, "a million labels at overview zoom must cost zero glyphs").toBe(0);

  // Zoomed in far enough to read. Now labels appear — but only for what is on screen, so the count is
  // bounded by the viewport and stays orders of magnitude below the node count.
  await page.evaluate(() => window.__glGraphHarness!.setScale(2));
  await page.evaluate(() => window.__glGraphHarness!.draw(1));
  const zoomedIn = await page.evaluate(() => window.__glGraphHarness!.glyphCount());
  expect(zoomedIn, "zoomed in, some labels are legible and must render").toBeGreaterThan(0);
  expect(zoomedIn, "…but bounded by screen area, not by the million nodes behind it").toBeLessThan(20_000);
  console.log(`  glyphs: ${zoomedOut} at 0.02x, ${zoomedIn} at 2x, over 1,000,000 labelled nodes`);
});

test("every visible label is ONE instanced draw call", async () => {
  test.setTimeout(600_000);
  await page.evaluate(() => window.__glGraphHarness!.setScale(2));
  await page.evaluate(() => window.__glGraphHarness!.resetCounters());
  await page.evaluate(() => window.__glGraphHarness!.draw(1));
  const c = await page.evaluate(() => window.__glGraphHarness!.counters());
  const glyphs = await page.evaluate(() => window.__glGraphHarness!.glyphCount());
  expect(glyphs).toBeGreaterThan(0);
  // `draw(1)` runs 4 frames (3 warm-up + 1 timed). Nodes + edges + labels = 3 calls per frame, so 12 —
  // a CONSTANT, whatever the glyph count. A per-label or per-node draw would scale with `glyphs`.
  expect(c.drawInstanced).toBe(12);
  // The atlas is uploaded ONCE, at setAtlas — never per frame.
  expect(c.texImage2D).toBe(0);
  // Two `bufferSubData` per frame (rects + uvs), so 8 across 4 frames — not one per label.
  expect(c.bufferSubData).toBe(8);
});

test("the LOD pyramid bounds the DRAWN instance count as you zoom out", async () => {
  test.setTimeout(600_000);
  const lod = await page.evaluate(() => window.__glGraphHarness!.attachLod());
  expect(lod.levels, "a million nodes must produce a real pyramid, not one level").toBeGreaterThan(3);
  // Geometric collapse — each level a fraction of the one below.
  for (let i = 1; i < lod.populations.length; i++) {
    expect(lod.populations[i], `level ${i}`).toBeLessThan(lod.populations[i - 1]);
  }
  console.log(`  pyramid: ${lod.levels} levels ${JSON.stringify(lod.populations)} built in ${lod.buildMs.toFixed(0)}ms`);

  // Zoomed IN: level 0, the nodes themselves — the pyramid must be transparent at close range.
  const near = await page.evaluate(() => window.__glGraphHarness!.drawnAt(4));
  expect(near.level).toBe(0);
  expect(near.instances).toBe(NODES);

  // Zoomed OUT: a coarser level, and DRAMATICALLY fewer instances. This is the whole epic in one
  // assertion — the frame stops paying for nodes it cannot resolve.
  const far = await page.evaluate(() => window.__glGraphHarness!.drawnAt(0.01));
  expect(far.level).toBeGreaterThan(0);
  expect(far.instances).toBeLessThan(NODES / 10);
  console.log(`  drawn: ${near.instances} at 4x (level ${near.level}) -> ${far.instances} at 0.01x (level ${far.level})`);

  // Monotonic: zooming further out never draws MORE.
  let prev = Infinity;
  for (const s of [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01]) {
    const r = await page.evaluate((sc) => window.__glGraphHarness!.drawnAt(sc), s);
    expect(r.instances, `scale ${s}`).toBeLessThanOrEqual(prev);
    prev = r.instances;
  }
  expect(await page.evaluate(() => window.__glGraphHarness!.glError())).toBe(0);
  await page.evaluate(() => window.__glGraphHarness!.detachLod());
});

test("a node is drawn at its OWN width and height, not as a square", async () => {
  // THE GAP THAT LET THE SQUARE-NODE REGRESSION SHIP. Slice 5 was verified by counting lit pixels
  // (25,128, 14.1% of the canvas) and by confirming picking "agreed with drawing" — both of which are
  // true when every 172x58 card is drawn 172x172, because the pick radius was wrong in the same
  // direction. Nothing measured SHAPE. This does.
  test.setTimeout(600_000);
  const got = await page.evaluate(() => window.__glGraphHarness!.drawnExtentOf(4242));
  expect(typeof got, `expected a measurement, got: ${JSON.stringify(got)}`).not.toBe("string");
  const { w, h, ratio } = got as { w: number; h: number; ratio: number };
  // The harness draws 172 x 58 at scale 1. Allow a couple of px for the SDF's antialiased edge.
  expect(w, `drawn width ${w}`).toBeGreaterThan(168);
  expect(w).toBeLessThan(178);
  expect(h, `drawn height ${h} — a square would be ~172 here, which is the bug`).toBeGreaterThan(54);
  expect(h).toBeLessThan(64);
  // Stated as the aspect too, because that is the number a reader can check against 172/58 = 2.97.
  expect(ratio, `aspect ${ratio}, expected ~2.97`).toBeGreaterThan(2.6);
  expect(ratio).toBeLessThan(3.3);
  console.log(`  node drawn ${w}x${h} px (aspect ${ratio}) — cards are 172x58, a square would read 1.0`);
});

test("a node is drawn as a CARD — surface fill, border, and a role dot in the corner", async () => {
  // The previous shape test proved the node's EXTENT. This proves its CONTENT, which is the half that
  // made the maintainer call the graph ugly: the whole card was filled with the role colour and the
  // label floated underneath, instead of a surface card with an 8px dot.
  test.setTimeout(600_000);
  const s = await page.evaluate(() => window.__glGraphHarness!.cardSample());
  expect(typeof s, `expected a sample, got ${JSON.stringify(s)}`).not.toBe("string");
  const { centre, dot, edge, distinctColours } = s as { centre: number[]; dot: number[]; edge: number[]; distinctColours: number };

  // The CENTRE is the surface, not the role colour. The harness paints a vivid role colour, so a filled
  // card would show it here — that is exactly the bug.
  const vivid = (c: number[]) => Math.max(c[0], c[1], c[2]) - Math.min(c[0], c[1], c[2]) > 60;
  expect(vivid(centre), `card centre ${JSON.stringify(centre)} should be a neutral surface, not the role colour`).toBe(false);
  // The DOT carries the role colour.
  expect(vivid(dot), `the role dot ${JSON.stringify(dot)} should carry the role colour`).toBe(true);
  // The EDGE is the border: distinct from the surface.
  const differs = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 12;
  expect(differs(edge, centre), `border ${JSON.stringify(edge)} vs surface ${JSON.stringify(centre)}`).toBe(true);
  // A solid-filled card would be ~1 colour; a card has surface + border + dot + antialiasing.
  expect(distinctColours).toBeGreaterThan(3);
  console.log(`  card: surface ${JSON.stringify(centre)} · border ${JSON.stringify(edge)} · dot ${JSON.stringify(dot)}`);
});
