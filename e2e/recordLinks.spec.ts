// recordLinks.spec.ts — EVERY packaged record link-verifies in real Chromium.
//
// `graphPages.spec.ts` asks the strong question of the ~12 pages: do they compile, link and export a
// component? This asks the weaker question of ALL ~383 records: does it compile, and does every
// specifier it requires resolve to a record or a registered module?
//
// The gap it closes is records NO page reaches. A page sweep only sees what a page composes, so a
// record nothing currently mounts can carry an import that resolves to nothing and stay green until the
// day something mounts it — at which point the loader throws its named error and the user gets a
// fallback. That is the silent-degradation class #3892/#3895 spent two issues undoing.
//
// It uses the RUNTIME's own mechanism (compile, then read the emitted `require()` calls) rather than a
// source regex. `platformBoundary.test.ts` asks the same question textually and stays useful in the
// default gate, where esbuild cannot run — but a regex is a guess about what the runtime will require,
// and #4188/#4224 were both cases of that guess being wrong in the permissive direction.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";

/**
 * Records whose imports resolve to NOTHING — **EMPTY, and it stays empty.**
 *
 * It held 14 entries: six specifiers registered nowhere (`KeyValueList`, `LabelChip`, `TracePlayer`,
 * `SessionFailure`, `SessionReadinessBanner`, `@tauri-apps/api/app`, `IssueCard`) plus
 * `@/components/teams-agent-face`, which named a record that did not exist. `record-link-debt` registered
 * the six and authored the record, so every entry came out.
 *
 * The ratchet below is what makes this list one-way, and it is the point: an exclusion list that can grow
 * silently is how a guard stops guarding — the reasoning `graphParity`'s KNOWN_STALE carried before it
 * was retired (see `src/app/runtime/shadowPages.ts`). A new
 * unresolved record fails the check above rather than landing here.
 */
const KNOWN_UNRESOLVED = new Set<string>([]);

// ~383 records each compiled with esbuild-wasm; the compile cache collapses shared subtrees but the
// first pass is genuinely long.
test.setTimeout(180_000);

test("every packaged record compiles, and every specifier it requires resolves", async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);
  const results = await page.evaluate(() => window.__graphPagesHarness!.verifyAll());

  // Non-vacuity: a glob that stopped matching would make an empty sweep look like a clean one.
  expect(results.length, "the packaged-record glob still resolves").toBeGreaterThanOrEqual(200);

  // A record that does not COMPILE is never acceptable — there is no known-broken list for this.
  const broken = results.filter((r) => r.compileError);
  expect(broken, `records that do not compile:\n${broken.map((r) => `  ${r.id} → ${r.compileError}`).join("\n")}`)
    .toEqual([]);

  const unresolved = results.filter((r) => !r.ok).map((r) => r.id);
  const fresh = unresolved.filter((id) => !KNOWN_UNRESOLVED.has(id));
  const detail = results.filter((r) => fresh.includes(r.id)).map((r) => `  ${r.id} → ${(r.unresolved ?? []).join(", ")}`);
  expect(fresh, `NEW records with imports that resolve to nothing:\n${detail.join("\n")}`).toEqual([]);

  // THE RATCHET. An entry that has been fixed must come out of the list, which puts it back under the
  // real check above. Without this, the exclusion list is a place for failures to go and stay.
  const fixed = [...KNOWN_UNRESOLVED].filter((id) => !unresolved.includes(id));
  expect(fixed, `these are fixed — drop them from KNOWN_UNRESOLVED: ${fixed.join(", ")}`).toEqual([]);
});
