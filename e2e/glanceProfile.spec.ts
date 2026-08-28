// glanceProfile.spec.ts — PROFILE Glance in Chromium, because WebKit will not let us.
//
// ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
// The app ships on WebKitGTK, whose renderer grew 200-540 MB/min and was killed by WebKit at 16 GB.
// Every instrument that would say WHAT grew is missing there: the remote inspector speaks a
// proprietary framed protocol with no installed client, `performance.memory` is Chromium-only so
// `readHeap()` returns null, and `measureUserAgentSpecificMemory` is unimplemented. Process-level RSS
// and per-thread CPU were argued three ways and settled nothing.
//
// The repo already mounts the real `glancepage` record in real Chromium (`graphPagesHarness`), and
// Chromium hands over exactly the missing instruments through the DevTools protocol:
//   • `Performance.getMetrics` — JSEventListeners, Nodes, JSHeapUsedSize, RecalcStyleCount…
//   • `HeapProfiler` sampling — allocation BY CALL STACK, which names the code doing it.
//
// ── READ THE RESULT CORRECTLY ───────────────────────────────────────────────────────────────────
// ⚠️ THIS IS NOT THE SHIPPING RENDERER. Chromium is not WebKitGTK. A leak in WebKit's own engine
// internals will NOT reproduce here, so a clean run is evidence about the APP and never about the
// renderer that actually dies. What does carry over is anything application-level — accumulating
// listeners, retained JS graphs, a runaway render loop — and the render-rate bug
// (`glance-render-rate-accelerates-until-a-remount-clears-it`) is squarely in that class.
//
// A second gap: the harness mounts against PACKAGED SEED data, not a live 32-stream fleet. A
// population that only grows with real fleet traffic will not grow here.
//
// ── RUNNING IT ──────────────────────────────────────────────────────────────────────────────────
//     npm run test:e2e -- glanceProfile            # ~2.5 min
//     PROFILE_SECONDS=600 npm run test:e2e -- glanceProfile
//
// If Vite dies at startup with `ENOSPC: System limit for number of file watchers reached`, the box is
// out of inotify watches (see `the-box-is-out-of-inotify-watches`) — prefix with
// `CHOKIDAR_USEPOLLING=1`. That is the environment, not this spec.
import { test, expect } from "@playwright/test";
import type { CDPSession } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";

/** How long to hold Glance mounted while sampling. Long by default: the bug it hunts took MINUTES to
 *  ramp (2 → 251 renders per 30s over ~4 minutes), so a short window reports a flat line and calls the
 *  page innocent. */
const PROFILE_SECONDS = Number(process.env.PROFILE_SECONDS ?? 150);
/** Sampling cadence. Fine enough to see a ramp, coarse enough that the sampling is not the workload. */
const SAMPLE_EVERY_MS = 10_000;

/** The metrics worth a column. `Performance.getMetrics` returns ~40; these are the ones that separate
 *  the live hypotheses — listeners and nodes for accumulation, heap for retention, style/layout counts
 *  for a render loop. */
const WATCHED = ["JSEventListeners", "Nodes", "JSHeapUsedSize", "RecalcStyleCount", "LayoutCount"] as const;

/** What an IDLE mounted page may add per minute. Not zero: a page can legitimately register a listener
 *  or two as late data arrives, and a zero budget would flake. Far below the measured 53/min. */
const LISTENER_GROWTH_BUDGET_PER_MIN = 5;

type Metrics = Record<string, number>;

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: rows } = await cdp.send("Performance.getMetrics");
  const out: Metrics = {};
  for (const m of rows) out[m.name] = m.value;
  return out;
}

/** Mount ONE page and leave it mounted — `renderPage`, not `mountAll`, because the question is what
 *  happens over time to a page that stays up. */
async function mountGlance(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);
  const res = await page.evaluate(() => window.__graphPagesHarness!.renderPage("glancepage"));
  expect(res, `glancepage did not mount: ${"error" in res ? res.error : ""}`).toHaveProperty("ok", true);
}

test("Glance's populations while it sits mounted — listeners, nodes, heap", async ({ page, context }) => {
  test.setTimeout((PROFILE_SECONDS + 90) * 1000);
  // KNOWN FAILING, on purpose — this is the guard for
  // `glance-render-rate-accelerates-until-a-remount-clears-it`, which is open. Measured 2026-08-28 in
  // this harness: 184 → 344 listeners over 180s, a dead-linear ~53/min on a page nobody is touching,
  // with Nodes pinned at 466 throughout.
  //
  // `test.fail()` rather than a skip, so the spec still RUNS and still prints the table — and so that
  // fixing the bug turns this red as an "unexpected pass", which tells whoever fixed it to delete this
  // marker. A skipped test would just rot.
  test.fail();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  await mountGlance(page);

  const rows: Array<{ t: number } & Metrics> = [];
  const t0 = Date.now();
  for (let elapsed = 0; elapsed <= PROFILE_SECONDS * 1000; elapsed += SAMPLE_EVERY_MS) {
    rows.push({ t: Math.round((Date.now() - t0) / 1000), ...(await metrics(cdp)) });
    if (elapsed < PROFILE_SECONDS * 1000) await page.waitForTimeout(SAMPLE_EVERY_MS);
  }

  // The report IS the deliverable — a growing column names the leaking population, which is the whole
  // method that has worked so far (DOM and injected styles were both eliminated by counting).
  const head = ["t(s)", ...WATCHED].map((h) => h.padStart(18)).join("");
  const body = rows
    .map((r) => [String(r.t), ...WATCHED.map((k) => (k === "JSHeapUsedSize" ? (r[k] / 1048576).toFixed(1) + "MB" : String(r[k] ?? "-")))]
      .map((c) => c.padStart(18)).join(""))
    .join("\n");
  console.log(`\nGlance, mounted for ${PROFILE_SECONDS}s in CHROMIUM (not WebKit — see this file's header):\n${head}\n${body}\n`);

  const first = rows[0], last = rows[rows.length - 1];
  for (const k of WATCHED) {
    const d = (last[k] ?? 0) - (first[k] ?? 0);
    const pct = first[k] ? (100 * d) / first[k] : 0;
    console.log(`  ${k.padEnd(18)} ${String(first[k] ?? "-").padStart(12)} → ${String(last[k] ?? "-").padStart(12)}   ${d >= 0 ? "+" : ""}${d.toFixed(0)} (${pct.toFixed(0)}%)`);
  }

  // THE ASSERTION, and it is deliberately about LISTENERS. A page that is merely idle does not acquire
  // event listeners, so growth here is the accumulation signature directly — one upstream event fanning
  // out to N subscribers with N climbing. Nodes and heap are reported but NOT asserted: a mounted page
  // legitimately allocates and legitimately renders more DOM as data arrives, so an assertion on them
  // would fail for correct behaviour.
  //
  // A RATE, not a ratio. The first version allowed a doubling, which quietly makes the threshold depend
  // on how long you run: the measured leak (184 → 344 in 180s) passed a doubling test at 180s and would
  // have failed it at 200s, so the same bug looked present or absent depending on PROFILE_SECONDS. A
  // per-minute rate is the honest invariant — an idle page should acquire ~none.
  const l0 = first.JSEventListeners ?? 0;
  const l1 = last.JSEventListeners ?? 0;
  const perMin = ((l1 - l0) / PROFILE_SECONDS) * 60;
  console.log(`  → JSEventListeners growth: ${perMin.toFixed(1)}/min`);
  expect(l0, "the page registered no listeners at all — the harness probably did not really mount it").toBeGreaterThan(0);
  expect(
    perMin,
    `JSEventListeners grew ${l0} → ${l1} (${perMin.toFixed(1)}/min) over ${PROFILE_SECONDS}s while Glance just sat there`,
  ).toBeLessThan(LISTENER_GROWTH_BUDGET_PER_MIN);
});

test("where Glance's allocation goes — the top allocating call stacks", async ({ page, context }) => {
  test.setTimeout((PROFILE_SECONDS + 90) * 1000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await mountGlance(page);

  // Sampling, not a snapshot: a snapshot says what is RETAINED, this says what ALLOCATES and from where.
  // For a problem measured in hundreds of MB per minute, the call stack is the answer and retention is
  // a second question.
  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
  await page.waitForTimeout(PROFILE_SECONDS * 1000);
  const { profile } = await cdp.send("HeapProfiler.stopSampling");

  // Fold the sample tree into self-size per call frame. `selfSize` is what a frame allocated itself, so
  // summing it per frame ranks the ALLOCATORS rather than their callers.
  const bySite = new Map<string, number>();
  const walk = (node: { callFrame: { functionName: string; url: string; lineNumber: number }; selfSize: number; children?: unknown[] }): void => {
    const f = node.callFrame;
    const name = `${f.functionName || "(anonymous)"} — ${String(f.url).split("/").pop()}:${f.lineNumber + 1}`;
    if (node.selfSize > 0) bySite.set(name, (bySite.get(name) ?? 0) + node.selfSize);
    for (const c of (node.children ?? []) as typeof node[]) walk(c);
  };
  walk(profile.head as Parameters<typeof walk>[0]);

  const ranked = [...bySite.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  const total = [...bySite.values()].reduce((a, b) => a + b, 0);
  console.log(`\nAllocation over ${PROFILE_SECONDS}s — ${(total / 1048576).toFixed(1)} MB sampled, top sites (CHROMIUM, not WebKit):`);
  for (const [site, bytes] of ranked) {
    console.log(`  ${(bytes / 1048576).toFixed(2).padStart(9)} MB  ${((100 * bytes) / total).toFixed(1).padStart(5)}%  ${site}`);
  }

  // Non-vacuity only. There is no correct threshold for "how much should a mounted page allocate", and
  // inventing one would produce a test that fails on healthy code — but a profile with NOTHING in it
  // means the sampler never attached, and that must not read as a clean bill of health.
  expect(ranked.length, "the allocation profile is empty — the sampler did not attach").toBeGreaterThan(0);
});
