// Why is the Components graph crisp on the first visit and slow on the second?
// (`the-components-graph-is-slow-on-every-visit-after-the-first`)
//
// THE SECOND VISIT IS NOT A MOUNT. A workspace renders through `KeptMountedPage`, which mounts on first
// activation and thereafter toggles `display` rather than unmounting — deliberately, so a docked PTY
// session survives a tab switch. So timing a second mount would measure an operation the app never
// performs. This times the one it does: mount → hide → wait → show.
//
// THE HIDDEN WINDOW IS THE MEASUREMENT. React commits to a hidden tree; only paint is skipped. That
// splits the candidate explanations cleanly:
//
//   hiddenCommits ≈ 0  → the un-hide is style/layout/paint of a static tree. The cost is the tree's
//                        SIZE, and it would be the same however long you were away.
//   hiddenCommits > 0  → the page is doing work nobody can see, and the un-hide pays for all of it at
//                        once. The cost then grows with time away — which is the shape of the sibling
//                        bug `glance-render-rate-accelerates-until-a-remount-clears-it`, and would make
//                        the two one story rather than two.
//
// READ THE NUMBERS AS COMPARISONS, NEVER AS BUDGETS. Headless Chromium resolves WebGL to SwiftShader and
// is not the WebKitGTK the app ships on, so no absolute figure here transfers. What transfers is the
// RATIO between a mount and an un-hide of the same tree in the same run, and whether a hidden tree
// commits at all — both of which are properties of the app's own code.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";
/** The Components workspace. Its record id is `guidecard` — the id and the module disagree, but
 *  `provides: "@/features/designs/DesignsWorkbench"` is what the app resolves, so that is the truth. */
const COMPONENTS = "guidecard";
/** Glance, for contrast: the graph whose render rate is separately known to climb while mounted. */
const GLANCE = "glancepage";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off" });

interface VisitProfile {
  recordId: string; error?: string;
  mountMs: number; unhideMs: number; nodesHidden: number;
  hiddenCommits: number; hiddenCommitMs: number;
  unhideCommits: number; unhideCommitMs: number;
  nodes: number;
}

const run = (page: import("@playwright/test").Page, id: string, hiddenMs: number) =>
  page.evaluate(
    ([recordId, ms]) => window.__graphPagesHarness!.visitProfile(recordId as string, ms as number),
    [id, hiddenMs] as const,
  ) as Promise<VisitProfile>;

test("a hidden Components graph is measured for the work it does while nobody is looking", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);

  const short = await run(page, COMPONENTS, 2_000);
  const long = await run(page, COMPONENTS, 8_000);

  // eslint-disable-next-line no-console -- the report IS the deliverable; this spec exists to be read
  console.log(
    `\nComponents (${COMPONENTS}) — ${short.nodes} elements\n` +
      `  away 2s : mount ${short.mountMs.toFixed(1)}ms · un-hide ${short.unhideMs.toFixed(1)}ms · ` +
      `elements shown ${short.nodes} → hidden ${short.nodesHidden} · ` +
      `hidden ${short.hiddenCommits} commits / ${short.hiddenCommitMs.toFixed(1)}ms · ` +
      `un-hide ${short.unhideCommits} commits / ${short.unhideCommitMs.toFixed(1)}ms\n` +
      `  away 8s : mount ${long.mountMs.toFixed(1)}ms · un-hide ${long.unhideMs.toFixed(1)}ms · ` +
      `elements shown ${long.nodes} → hidden ${long.nodesHidden} · ` +
      `hidden ${long.hiddenCommits} commits / ${long.hiddenCommitMs.toFixed(1)}ms · ` +
      `un-hide ${long.unhideCommits} commits / ${long.unhideCommitMs.toFixed(1)}ms\n` +
      (short.error || long.error ? `  ERROR: ${short.error ?? long.error}\n` : ""),
  );

  expect(short.error, "the page must mount before anything about it can be measured").toBeUndefined();
  expect(long.error).toBeUndefined();
  // Not a budget — an existence check, so a harness that silently measured nothing cannot report zeros
  // as a clean result. That failure mode is exactly how a measurement invents a finding.
  expect(short.nodes, "a page that rendered nothing has no cost to attribute").toBeGreaterThan(10);
});

test("Glance, for contrast — the graph already known to accelerate while mounted", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);

  const p = await run(page, GLANCE, 8_000);
  // eslint-disable-next-line no-console -- see above
  console.log(
    `\nGlance (${GLANCE}) — ${p.nodes} elements\n` +
      `  away 8s : mount ${p.mountMs.toFixed(1)}ms · un-hide ${p.unhideMs.toFixed(1)}ms · ` +
      `elements shown ${p.nodes} → hidden ${p.nodesHidden} · ` +
      `hidden ${p.hiddenCommits} commits / ${p.hiddenCommitMs.toFixed(1)}ms · ` +
      `un-hide ${p.unhideCommits} commits / ${p.unhideCommitMs.toFixed(1)}ms\n` +
      (p.error ? `  ERROR: ${p.error}\n` : ""),
  );
  expect(p.error).toBeUndefined();
});
