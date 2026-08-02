// #186 asserted against the RENDERED GRAPH PAGE (#4206, epic #3604).
//
// The graph copy had no behaviour coverage. `src/app/console/panes/views/consoleCrossTabMount.
// test.tsx` guards the invariant that makes the Console migration safe — every tab's panes stay mounted
// across a switch, so xterm and its scrollback survive; switching flips `display` on the same DOM nodes
// rather than disposing them. It has been asserting that against `ConsoleWorkspace`, the bundled file,
// which the app stopped rendering at #4196. A true guard on the wrong copy.
//
// It could not simply be re-pointed: a graph record is source TEXT, and it only becomes a component after
// esbuild compiles it — which does not run in jsdom. So the guard could not move until a page could be
// rendered in a real browser. That is what this file is.
import { test, expect } from "@playwright/test";

const HARNESS = "/e2e/harness/graph-pages-harness.html";

/** Two tabs — a 2×2 and a 1×1 — so "every tab's panes are mounted" has something to be wrong about. */
const TABS_STATE = {
  tabs: [
    { name: "alpha · triage", layout: "2×2", state: "idle", runId: 0 },
    { name: "beta · build", layout: "1×1", state: "idle", runId: 0 },
  ],
  activeTabIdx: 0,
  paneMenuOpenIdx: -1,
  focusedPaneIdx: -1,
  fullscreenPaneIdx: -1,
  paneViews: [],
  paneNames: {},
  paneCwds: {},
  paneInitCmds: {},
  disabledPanes: {},
  paneStartupPromptText: {},
  paneStartupPromptDocs: {},
  paneCheckpointDocs: {},
  paneContinue: {},
  paneMcpServers: {},
  paneHooks: {},
  consoleBroadcast: false,
  autoAdvanceOnReply: true,
};

test("#186 — every tab's panes stay mounted, on the graph page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(HARNESS);
  await page.waitForFunction(() => !!window.__graphPagesHarness);

  const result = await page.evaluate(
    ([state]) =>
      window.__graphPagesHarness!.renderPage("consolepage", {
        state: state as Record<string, unknown>,
        // The real slot claims an xterm from the app-level TerminalHost, which a bare page has not got.
        // The marker keeps the same identifying props the cell passes, so the assertions below are the
        // vitest original's — it marks WHERE a terminal would be, which is all #186 is about.
        markerStubs: [{
          specifier: "@/app/console/terminal/TerminalSlot",
          exportName: "TerminalSlot",
          testIdPrefix: "term",
          idProp: "paneId",
        }],
      }),
    [TABS_STATE],
  );
  expect(result, `renderPage failed: ${"error" in result ? result.error : ""}`).toEqual({ ok: true });

  // One grid per TAB, not just the active one — the mount that keeps background terminals alive.
  await expect(page.locator(".console-grid")).toHaveCount(2);

  // Tab 0 (2×2) mounts four panes, tab 1 (1×1) mounts one — including the tab nobody is looking at.
  await expect(page.getByTestId("term-t0p0")).toBeAttached();
  await expect(page.getByTestId("term-t0p3")).toBeAttached();
  await expect(page.getByTestId("term-t1p0")).toBeAttached();

  // The active grid shows, the rest hide — display, never unmount.
  const grids = page.locator(".console-grid");
  await expect(grids.nth(0)).toHaveCSS("display", "grid");
  await expect(grids.nth(1)).toHaveCSS("display", "none");

  // …and the background tab's panes are told they are invisible, so their render pauses (#185).
  await expect(page.getByTestId("term-t1p0")).toHaveAttribute("data-visible", "false");

  expect(errors).toEqual([]);
});
