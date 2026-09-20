// algorithmsGraph.spec.ts — the Algorithms graph at the size of the live store, in real Chromium
// (`the-algorithms-graph-drills-by-crate`).
//
// It asserts the page opens on GROUPS rather than on every implementation, that entering a group draws its own
// implementations with a stub for every edge that leaves it, and that Back returns — then prints what each
// layer cost as one `ALGORITHMS_GRAPH {…}` line.
//
// The graph is SYNTHETIC by default, at the live store's scale and shape (~2,400 Rust implementations over 87
// crates, every `composes` edge inside a crate, crate links only via `crateDeps`), so the spec needs no
// machine's store. To draw the REAL one:
//
//     bsc algorithms impl list > /var/tmp/impls.json
//     ALGORITHMS_GRAPH_JSON=/var/tmp/impls.json npx playwright test e2e/algorithmsGraph.spec.ts
//
// ⚠️ Chromium is not WebKitGTK: the numbers are the APP's work, not the shipping renderer's speed.
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

const HARNESS = "/e2e/harness/algorithms-graph-harness.html";
/** Crates, sized like the live store: one large (src-tauri), a few mid, a long tail. */
const CRATES = [
  ["src-tauri", 363], ["bsc-graph", 181], ["bsc-fin", 150], ["bsc-ui", 130], ["plandb", 123],
  ...Array.from({ length: 24 }, (_, i) => [`bsc-lib-${i}`, 30 - (i % 7)] as const),
];

/** A store-shaped kit: composes never leaves a crate; crates are linked only by crateDeps. */
function syntheticImpls() {
  const impls: Record<string, unknown>[] = [];
  CRATES.forEach(([crate, n], ci) => {
    const dep = CRATES[(ci + 1) % CRATES.length][0] as string;
    for (let i = 0; i < (n as number); i++) {
      const id = `${crate}--m${i}.rs`;
      // A FEW EDGES CROSS A CRATE on purpose. The live store has none (measured: 3,481 composes, 0 across),
      // but a drilled layer must still show what LEAVES it, and a fixture with no crossings proves nothing
      // about the stubs — the first run of this spec reported 0 stubs and asserted nothing.
      const crossing = crate === "bsc-graph" && i === 5 ? ["bsc-fin--m2.rs"] : crate === "bsc-fin" && i === 3 ? ["bsc-graph--m1.rs"] : [];
      impls.push({
        id,
        tech: "rust",
        role: i === 0 ? "primitive" : "algorithm",
        name: `${crate}_m${i}`,
        composes: [...(i > 1 ? [`${crate}--m${i - 1}.rs`] : []), ...crossing],
        crateDeps: i === 0 ? [dep.replace(/-/g, "_")] : [],
        src: crate === "src-tauri" ? `src-tauri/src/sub${i % 12}/m${i}.rs` : `crates/${crate}/src/m${i}.rs`,
        folder: crate === "src-tauri" ? `src-tauri/src/sub${i % 12}` : `crates/${crate}/src`,
      });
    }
  });
  return impls;
}

test("the Algorithms graph opens on crates, drills into one, and says what each layer cost", async ({ page }, info) => {
  test.setTimeout(180_000);
  const implementations = process.env.ALGORITHMS_GRAPH_JSON
    ? JSON.parse(readFileSync(process.env.ALGORITHMS_GRAPH_JSON, "utf8"))
    : syntheticImpls();
  const rust = (implementations as { tech?: string }[]).filter((im) => im.tech === "rust").length;

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__algorithmsGraphHarness, undefined, { timeout: 120_000 });

  const first = await page.evaluate((doc) => window.__algorithmsGraphHarness!.mount(doc), { implementations });
  const top = await page.evaluate(() => window.__algorithmsGraphHarness!.openTech("Rust"));
  // LOG BEFORE ASSERTING. The first run of this spec failed on `top.ok` and printed nothing, because the
  // line that says WHY sat below the assertion — so the harness's own error never reached the report.
  console.log(`ALGORITHMS_GRAPH ${JSON.stringify({ source: process.env.ALGORITHMS_GRAPH_JSON ? "live" : "synthetic", rustImpls: rust, mount: first, top })}`);
  expect(first, "error" in first ? first.error : "").toHaveProperty("ok", true);
  if (!first.ok) return;
  expect(top, "error" in top ? top.error : "").toHaveProperty("ok", true);
  if (!top.ok) return;
  await page.screenshot({ path: info.outputPath("algorithms-groups.png") });

  // THE POINT OF THE SLICE: the top layer is groups, and it is a small fraction of the kit.
  expect(top.groups, "the top layer draws groups").toBeGreaterThan(5);
  expect(top.impls, "and no implementation cards at all").toBe(0);
  expect(top.groups).toBeLessThan(200);
  expect(top.groups * 6).toBeLessThan(rust);

  // Entering a crate draws ITS implementations, and what leaves the crate stays visible as stubs.
  const drilled = await page.evaluate(() => window.__algorithmsGraphHarness!.enter("bsc-graph"));
  expect(drilled, "error" in drilled ? drilled.error : "").toHaveProperty("ok", true);
  if (!drilled.ok) return;
  console.log(`ALGORITHMS_GRAPH_DRILLED ${JSON.stringify(drilled)}`);
  await page.screenshot({ path: info.outputPath("algorithms-drilled.png") });
  expect(drilled.impls, "the crate's own implementations").toBeGreaterThan(0);
  expect(drilled.groups, "no group cards inside a crate").toBe(0);
  expect(drilled.impls).toBeLessThan(rust / 2);
  // NOTHING IS HIDDEN: the edges that leave this crate — one out to bsc-fin, one in from it — are stubs.
  expect(drilled.stubs, "a stub per group the members reach or are reached by").toBeGreaterThan(0);
  expect(drilled.summary, "the crumb names the drilled crate").toContain("bsc-graph");

  // Back returns to the crates.
  const out = await page.evaluate(() => window.__algorithmsGraphHarness!.back());
  expect(out).toHaveProperty("ok", true);
  if (!out.ok) return;
  expect(out.groups, "Back returns to the group layer").toBe(top.groups);
  expect(out.impls).toBe(0);
});
