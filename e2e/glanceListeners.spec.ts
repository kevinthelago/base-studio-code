// Diagnostic: enumerate the LIVE listeners from Chromium itself and diff them over time.
//
// `addEventListener` patching found nothing — zero calls in 90s while JSEventListeners climbed — so the
// growth does not go through that path. DOMDebugger.getEventListeners asks the engine what it actually
// holds, with each handler's script location, which is the question that matters.
import { test, expect } from "@playwright/test";
import type { CDPSession } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";
const SECONDS = Number(process.env.PROFILE_SECONDS ?? 90);

interface Listener { type: string; scriptId: string; lineNumber: number; columnNumber: number; useCapture: boolean }

/** Every listener the engine holds on `expr`, with its handler's script location. */
async function listenersOn(cdp: CDPSession, expr: string): Promise<Listener[]> {
  const { result } = await cdp.send("Runtime.evaluate", { expression: expr });
  if (!result.objectId) return [];
  const { listeners } = await cdp.send("DOMDebugger.getEventListeners", { objectId: result.objectId, depth: -1, pierce: true });
  return listeners as unknown as Listener[];
}

async function census(cdp: CDPSession): Promise<Record<string, Listener[]>> {
  const out: Record<string, Listener[]> = {};
  for (const target of ["window", "document", "document.documentElement", "document.getElementById('root')"]) {
    out[target] = await listenersOn(cdp, target);
  }
  return out;
}

test("name the listener leak", async ({ page, context }) => {
  test.setTimeout((SECONDS + 120) * 1000);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Performance.enable");

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);
  const res = await page.evaluate(() => window.__graphPagesHarness!.renderPage("glancepage"));
  expect(res).toHaveProperty("ok", true);

  const metric = async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    return metrics.find((m) => m.name === "JSEventListeners")?.value ?? 0;
  };
  const before = await census(cdp);
  const m0 = await metric();
  await page.waitForTimeout(SECONDS * 1000);
  const after = await census(cdp);
  const m1 = await metric();

  console.log(`\nJSEventListeners ${m0} → ${m1} over ${SECONDS}s (+${m1 - m0})\n`);
  for (const target of Object.keys(after)) {
    const b = before[target] ?? [], a = after[target] ?? [];
    console.log(`  ${target.padEnd(34)} ${String(b.length).padStart(5)} → ${String(a.length).padStart(5)}`);
    if (a.length <= b.length) continue;
    const tally = (ls: Listener[]) => {
      const m: Record<string, number> = {};
      for (const l of ls) m[`${l.type} @ script${l.scriptId}:${l.lineNumber + 1}:${l.columnNumber}`] = (m[`${l.type} @ script${l.scriptId}:${l.lineNumber + 1}:${l.columnNumber}`] ?? 0) + 1;
      return m;
    };
    const tb = tally(b), ta = tally(a);
    for (const [k, n] of Object.entries(ta).sort((x, y) => (y[1] - (tb[y[0]] ?? 0)) - (x[1] - (tb[x[0]] ?? 0))).slice(0, 6)) {
      const d = n - (tb[k] ?? 0);
      if (d > 0) console.log(`      +${String(d).padStart(4)}   ${k}`);
    }
  }
  // Resolve the winning scriptId to a URL so the site is nameable.
  const grewTargets = Object.keys(after).filter((t) => (after[t]?.length ?? 0) > (before[t]?.length ?? 0));
  if (grewTargets.length) {
    const ids = [...new Set((after[grewTargets[0]] ?? []).map((l) => l.scriptId))];
    console.log(`\n  scriptIds present on ${grewTargets[0]}: ${ids.join(", ")}`);
  }
  expect(m1).toBeGreaterThan(m0); // non-vacuity: if it did not grow there is nothing to attribute
});
