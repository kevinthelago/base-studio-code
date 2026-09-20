// `bsc resources app`'s measurement half — the app's populations, read once, printed as ONE machine-readable
// line for the CLI to parse.
//
// WHY A SEPARATE SPEC FROM `glanceProfile.spec.ts`. That one is an INVESTIGATION: it holds a page
// mounted for 150s by default, samples a curve, prints a table a human reads, and asserts a listener
// budget. This one is a READING — the smallest thing that answers "what does the app hold right now"
// so a worker can diff it across a change. Folding them together would make every `bsc resources app` pay
// two and a half minutes, and would put a CLI's output contract inside a spec whose job is to fail
// loudly on a budget.
//
// ⚠️ THE SAME LIMIT APPLIES AND IS NOT A DETAIL: this is CHROMIUM, and the app ships on WebKitGTK. An
// engine-level WebKit leak will not reproduce here. What carries over is application-level — retained
// JS, accumulating listeners, a runaway render loop. A clean number is evidence about the APP, never
// about the renderer that dies. `bsc resources app`'s own help says so too, because the person reading the
// number is usually not the person who read this file.
import { test, expect } from "@playwright/test";
import type { CDPSession } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";

/** The marker `bsc_mem::app::parse_report` matches on. Changing it breaks the CLI — the Rust side
 *  pins the same string as a const, and `bsc resources app` reports "no measurement" rather than a zero if
 *  the two ever drift, which is the failure mode worth having. */
const MARKER = "BSC_MEM_APP ";

/** How long to let the app settle before reading. Short by design — this is a reading, not a hunt.
 *  Long enough that first-mount allocation has landed and been collected. */
const SETTLE_SECONDS = Number(process.env.BSC_MEM_SECONDS ?? 20);

/** The populations that separate the hypotheses a worker actually has: heap for retention, nodes and
 *  listeners for accumulation, style/layout counts for a render loop. Same set `glanceProfile` watches,
 *  so the two reports are comparable rather than two different vocabularies for one question. */
const WATCHED = ["JSHeapUsedSize", "Nodes", "JSEventListeners", "RecalcStyleCount", "LayoutCount"] as const;

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
  // COLLECT FIRST. An uncollected heap reading measures GC timing rather than retention — the mistake
  // `glanceProfile.spec.ts`'s header records paying for, where the entire observed "growth" was
  // garbage that one `collectGarbage` gave back.
  await cdp.send("HeapProfiler.collectGarbage");
  const { metrics: rows } = await cdp.send("Performance.getMetrics");
  const out: Record<string, number> = {};
  for (const m of rows) out[m.name] = m.value;
  return out;
}

test("the app's populations, as one machine-readable reading", async ({ page, context }) => {
  test.setTimeout((SETTLE_SECONDS + 90) * 1000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);
  const res = await page.evaluate(() => window.__graphPagesHarness!.renderPage("glancepage"));
  expect(res, `the page did not mount: ${"error" in res ? res.error : ""}`).toHaveProperty("ok", true);

  await page.waitForTimeout(SETTLE_SECONDS * 1000);
  const m = await metrics(cdp);

  const reading: Record<string, number> = {};
  for (const k of WATCHED) if (typeof m[k] === "number") reading[k] = m[k];

  // A reading with no heap in it is not a reading. Failing here is deliberate: `bsc resources app` reports
  // "could not read a measurement" rather than a zero, and a spec that printed an empty object would
  // turn that honest failure into a confident 0 MB.
  expect(Object.keys(reading), "CDP returned none of the watched metrics").not.toHaveLength(0);
  expect(reading.JSHeapUsedSize, "a live page always holds some heap").toBeGreaterThan(0);

  console.log(`${MARKER}${JSON.stringify(reading)}`);
});
