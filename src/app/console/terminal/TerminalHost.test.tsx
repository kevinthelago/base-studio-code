import { describe, it, expect, beforeEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { TerminalHost, ownerClaim, claimIsOnScreen, type SlotTerminalProps } from "./TerminalHost";
import { TerminalSlot } from "@/app/console/terminal/TerminalSlot";

// #2378 guardrail: there is exactly ONE <TerminalView> per paneId (one xterm, one PTY listener), owned by
// the host and RE-PARENTED between slots — never a second mount, never a remount on hand-off. xterm can't
// init in jsdom, so stub TerminalView with a probe that records every mount/unmount (keyed by paneId) and
// echoes its props; a stable mount count across a surface hand-off is proof the PTY is never torn down.
const rec = vi.hoisted(() => ({ mounts: [] as string[], unmounts: [] as string[] }));
vi.mock("@/app/console/panes/views/TerminalView", async () => {
  const { useEffect } = await import("react");
  return {
    TerminalView: ({ paneId, visible, initialCwd, startupPrompt }: { paneId: string; visible?: boolean; initialCwd?: string; startupPrompt?: string }) => {
      useEffect(() => {
        rec.mounts.push(paneId);
        return () => { rec.unmounts.push(paneId); };
      }, [paneId]);
      return (
        <div
          data-testid="tv"
          data-pane={paneId}
          data-visible={String(!!visible)}
          data-cwd={initialCwd ?? ""}
          data-prompt={startupPrompt ?? ""}
        />
      );
    },
  };
});

beforeEach(() => { rec.mounts.length = 0; rec.unmounts.length = 0; });

/** Console cell (primary) + optionally the Glance dock (viewer), both claiming the same agent's terminal. */
function Harness({ showDock, cellVisible = true }: { showDock: boolean; cellVisible?: boolean }) {
  return (
    <TerminalHost>
      <div data-testid="console-cell">
        <TerminalSlot paneId="proj:api" primary visible={cellVisible} initialCwd="/repo" />
      </div>
      {showDock && (
        <div data-testid="glance-dock">
          <TerminalSlot paneId="proj:api" visible />
        </div>
      )}
    </TerminalHost>
  );
}

describe("TerminalHost (#2378)", () => {
  it("mounts exactly one TerminalView for a paneId even with two slots claiming it", () => {
    const { getAllByTestId } = render(<Harness showDock />);
    // One primary + one viewer slot → still a single terminal.
    expect(getAllByTestId("tv")).toHaveLength(1);
    expect(rec.mounts).toEqual(["proj:api"]);
  });

  it("re-parents the SAME terminal node into whichever slot owns it — no remount on hand-off", () => {
    const { getByTestId, rerender } = render(<Harness showDock={false} />);
    const tv = getByTestId("tv");
    // Only the console cell claims it → the terminal lives inside the console cell.
    expect(tv.closest("[data-testid='console-cell']")).toBeTruthy();
    expect(tv.closest("[data-testid='glance-dock']")).toBeFalsy();

    // Open the dock: the dock becomes the owner and the terminal moves into it…
    rerender(<Harness showDock />);
    expect(getByTestId("tv")).toBe(tv);                                   // same DOM node — moved, not recreated
    expect(tv.closest("[data-testid='glance-dock']")).toBeTruthy();
    expect(tv.closest("[data-testid='console-cell']")).toBeFalsy();

    // …close the dock: ownership falls back to the console cell, terminal returns there.
    rerender(<Harness showDock={false} />);
    expect(getByTestId("tv")).toBe(tv);
    expect(tv.closest("[data-testid='console-cell']")).toBeTruthy();

    // Across the whole hand-off the terminal mounted once and never unmounted — the PTY survived.
    expect(rec.mounts).toEqual(["proj:api"]);
    expect(rec.unmounts).toEqual([]);
  });

  it("sources launch props from the primary but visibility from the current owner", () => {
    // Console cell is hidden (a background view) while the dock owns + shows the terminal.
    const { getByTestId } = render(<Harness showDock cellVisible={false} />);
    const tv = getByTestId("tv");
    expect(tv.getAttribute("data-cwd")).toBe("/repo");      // primary (console) supplies initialCwd
    expect(tv.getAttribute("data-visible")).toBe("true");   // owner (dock) supplies visibility
  });

  it("tears the terminal down only when its LAST slot unmounts (parks otherwise)", () => {
    const { queryByTestId, rerender } = render(<Harness showDock />);
    // Dropping the dock leaves the console claim → terminal stays alive.
    rerender(<Harness showDock={false} />);
    expect(queryByTestId("tv")).toBeTruthy();
    expect(rec.unmounts).toEqual([]);

    // Dropping the console cell too (no slots left) → the terminal finally unmounts.
    rerender(
      <TerminalHost>
        <div data-testid="empty" />
      </TerminalHost>,
    );
    expect(queryByTestId("tv")).toBeFalsy();
    expect(rec.unmounts).toEqual(["proj:api"]);
  });
});

// #3357: the app-owned session mounts (DebugSessionMount / StudioSessionMount) are off-screen HOLDING
// claims that exist only to keep the PTY alive. Their cwd resolves ASYNC, so they can register AFTER a
// visible dock — under plain "last claim wins" that would silently park a terminal the user is looking at
// off-screen. `parked` makes such a claim own the terminal only when it is the last one standing.
describe("TerminalHost parked holding claims (#3357)", () => {
  /** A studio: a visible page dock plus the off-screen holding mount, in either registration order.
   *  `dockOpen` closes the dock while KEEPING the holding mount's element identity (same key), which is
   *  the real app's shape — `StudioSessionHosts` stays mounted in App.tsx for the session's whole life
   *  while the page dock and the Glance morph come and go. Re-rendering a differently-shaped tree here
   *  would unmount/remount the holding div, briefly dropping the pane to ZERO claims and making the host
   *  tear the terminal down — which would test React's reconciler, not the parked-ownership rule. */
  function StudioHarness({ mountFirst, dockOpen = true }: { mountFirst: boolean; dockOpen?: boolean }) {
    const mount = <div key="m" data-testid="holding"><TerminalSlot paneId="design-studio:designer-react" primary parked visible={false} initialCwd="/design" /></div>;
    const dock = <div key="d" data-testid="page-dock"><TerminalSlot paneId="design-studio:designer-react" visible /></div>;
    const both = mountFirst ? [mount, dock] : [dock, mount];
    return <TerminalHost>{dockOpen ? both : [mount]}</TerminalHost>;
  }

  it("never takes ownership from a visible surface, whichever registered first", () => {
    for (const mountFirst of [true, false]) {
      const { getByTestId, unmount } = render(<StudioHarness mountFirst={mountFirst} />);
      const tv = getByTestId("tv");
      expect(tv.closest("[data-testid='page-dock']")).toBeTruthy();
      expect(tv.getAttribute("data-visible")).toBe("true");   // the dock's visibility, not the mount's
      expect(tv.getAttribute("data-cwd")).toBe("/design");    // launch props still come from the primary
      unmount();
    }
  });

  // #3427 regression. The page dock calls `openStudio` and renders its viewer slot in the SAME commit,
  // while the holding mount only appears once an async `setup_*_workspace` invoke resolves — so the dock
  // ALWAYS claimed first. With no primary to source from, the host fell back to the owner's (empty) launch
  // props and TerminalView launched with cwd/initCmd undefined. That is a one-shot launch, so the primary
  // arriving a tick later never repaired it: `pty_create` ran with `cwd=<none>`, the session inherited the
  // app's own working directory instead of the studio workspace, and `ensure_session_settings` was skipped
  // entirely — a permission-less session with no role gate.
  it("does NOT launch an app-owned session before its holding mount claims it (#3427)", () => {
    // ONE tree whose only change is the mount appearing — the real sequence, since `StudioSessionHosts`
    // renders alongside the page for the session's whole life and the mount's own slot is what arrives late.
    const Opening = ({ mounted }: { mounted: boolean }) => (
      <TerminalHost>
        <div key="d" data-testid="page-dock"><TerminalSlot paneId="design-studio:designer-react" visible /></div>
        {mounted && <div key="m" data-testid="holding"><TerminalSlot paneId="design-studio:designer-react" primary parked visible={false} initialCwd="/design" /></div>}
      </TerminalHost>
    );
    // First commit: the dock has claimed, the mount's async setup has not resolved. No terminal yet —
    // crucially NOT one launched with an empty cwd.
    const { queryByTestId, rerender } = render(<Opening mounted={false} />);
    expect(queryByTestId("tv")).toBeFalsy();
    expect(rec.mounts).toEqual([]);

    // The mount resolves its workspace dir and registers: NOW the session launches, with its real cwd,
    // into the dock the user is already looking at.
    rerender(<Opening mounted />);
    expect(rec.mounts).toEqual(["design-studio:designer-react"]);
    const tv = queryByTestId("tv")!;
    expect(tv.getAttribute("data-cwd")).toBe("/design");
    expect(tv.closest("[data-testid='page-dock']")).toBeTruthy();
  });

  it("still launches a FLEET pane from a viewer-only claim — the gate is app-owned ids only (#3427)", () => {
    // A fleet pane's primary is its console grid cell, which legitimately may never mount while Glance
    // shows the terminal. Gating it would hide a working session, so the gate must not reach it.
    render(
      <TerminalHost>
        <div data-testid="glance-dock"><TerminalSlot paneId="proj:api" visible /></div>
      </TerminalHost>,
    );
    expect(rec.mounts).toEqual(["proj:api"]);
  });

  /// A DEBUG-studio session is per-REQUEST, so its pane id is not in the exact-match
  /// `STUDIO_SESSION_PANE_IDS` the #3427 gate reads — and the mount the gate's comment named as the
  /// guarantee (`DebugSessionMount`) no longer exists. The gate silently stopped covering the sessions
  /// that replaced it, and the failure is the one #3427 exists to prevent: reproduced before this fix,
  /// the launch went out with cwd `""` and initCmd `""` — which also skips `ensure_session_settings`,
  /// so the session runs with no role gate at all.
  it("does NOT launch a per-request DEBUG session before its mount claims it", () => {
    const Opening = ({ mounted }: { mounted: boolean }) => (
      <TerminalHost>
        <div key="v" data-testid="viewer"><TerminalSlot paneId="debug-studio:req-7" visible /></div>
        {mounted && (
          <div key="m" data-testid="holding">
            <TerminalSlot paneId="debug-studio:req-7" primary parked visible={false} initialCwd="/repo" initCmd="claude" startupPrompt="YOUR REQUEST IS #7." />
          </div>
        )}
      </TerminalHost>
    );
    const { queryByTestId, rerender } = render(<Opening mounted={false} />);
    expect(queryByTestId("tv"), "launched before its mount claimed it").toBeFalsy();

    rerender(<Opening mounted />);
    expect(rec.mounts).toEqual(["debug-studio:req-7"]);
    expect(queryByTestId("tv")!.getAttribute("data-cwd")).toBe("/repo");
  });

  /// The launch PROMPT travels with the other launch props, from the primary claim.
  ///
  /// It used to reach `TerminalView` only through the store, read once inside a one-shot launch effect —
  /// so a surface whose write landed after that read lost it silently, and a session with no prompt is
  /// indistinguishable from one that has finished its work. Measured on the running app before this fix:
  /// 58 of 58 debug launches carried the props and NOT ONE carried the prompt.
  it("sources the startup prompt from the primary claim, like the other launch props", () => {
    render(
      <TerminalHost>
        <div data-testid="viewer"><TerminalSlot paneId="debug-studio:req-9" visible /></div>
        <div data-testid="holding">
          <TerminalSlot paneId="debug-studio:req-9" primary parked visible={false} initialCwd="/repo" initCmd="claude" startupPrompt="YOUR REQUEST IS #9." />
        </div>
      </TerminalHost>,
    );
    expect(document.querySelector("[data-testid='tv']")!.getAttribute("data-prompt")).toBe("YOUR REQUEST IS #9.");
  });

  it("owns the terminal (parked, off-screen) once it is the last claim standing", () => {
    const { getByTestId, rerender } = render(<StudioHarness mountFirst />);
    const tv = getByTestId("tv");
    rerender(<StudioHarness mountFirst dockOpen={false} />);
    // The dock closed (page switch / morph close): the SAME terminal parks in the holding mount — not
    // torn down, which is what keeps the session warm for the Glance morph.
    expect(getByTestId("tv")).toBe(tv);
    expect(tv.closest("[data-testid='holding']")).toBeTruthy();
    expect(tv.getAttribute("data-visible")).toBe("false"); // parked ⇒ the mount's visibility now applies
    expect(rec.unmounts).toEqual([]);
  });
});

/** A claim in registration order — the shape `ownerClaim` reads. */
const claim = (slotId: string, p: Partial<SlotTerminalProps>) => ({
  slotId,
  propsRef: { current: { visible: false, ...p } as SlotTerminalProps },
});

describe("ownerClaim — a hidden surface must not steal a visible one's terminal", () => {
  it("gives the terminal to the only visible claim", () => {
    expect(ownerClaim([claim("console", { visible: false }), claim("morph", { visible: true })])?.slotId)
      .toBe("morph");
  });

  // THE BUG. A console card remount re-registers its slot at the END of the claim list, and under
  // plain last-wins that HIDDEN cell became the owner — the terminal was re-parented into a background
  // tab and the Glance morph the user was looking at was left an empty div. Nothing had to change on
  // screen for it to happen, which is why it read as "terminals randomly go blank"; a `runId` bump
  // remounts every card in a tab at once, blanking every open morph together.
  it("does NOT let a hidden claim registered LAST steal from a visible one", () => {
    expect(ownerClaim([claim("morph", { visible: true }), claim("console", { visible: false })])?.slotId)
      .toBe("morph");
  });

  it("still prefers the LAST visible claim when more than one is visible", () => {
    expect(ownerClaim([claim("a", { visible: true }), claim("b", { visible: true })])?.slotId).toBe("b");
  });

  it("falls back to the last non-parked claim when nothing is visible", () => {
    expect(ownerClaim([claim("a", { visible: false }), claim("b", { visible: false })])?.slotId).toBe("b");
  });

  // The pre-existing #3357 exception, which must survive: a parked holding mount keeps the PTY alive
  // and must never take ownership from a real surface — visible or not.
  it("never hands ownership to a parked holding claim while a real claim exists", () => {
    const parked = claim("parked", { visible: false, parked: true });
    expect(ownerClaim([claim("cell", { visible: false }), parked])?.slotId).toBe("cell");
    expect(ownerClaim([claim("morph", { visible: true }), parked])?.slotId).toBe("morph");
  });

  it("a parked claim owns it only when it is all that is left", () => {
    expect(ownerClaim([claim("parked", { visible: false, parked: true })])?.slotId).toBe("parked");
  });

  // ── The premise the last fix rested on, which was FALSE ─────────────────────────────────────────
  //
  // That fix closed with: "Ties are impossible in practice — the console grid and the Glance canvas
  // are different Workspaces, so at most one is on screen." `App.tsx` keeps the console mounted across
  // every navigation (`display: activeWorkspace === "console" ? "flex" : "none"`) precisely so xterm
  // survives, while Glance is conditionally rendered. So on Glance BOTH are mounted and BOTH claim
  // `visible: true` — a console cell's `visible={view === "console" && !hidden}` says nothing about
  // its Workspace being off screen; `hidden` only ever meant "another pane is fullscreen, or another
  // tab is active".
  //
  // So the tie the doc called impossible is the NORMAL state, last-wins picked the console cell again,
  // and the wake blanked the morph exactly as before. Reported twice.
  const onScreen = (ids: string[]) => (c: { slotId: string }) => ids.includes(c.slotId);

  it("does not let an OFF-SCREEN console cell steal from the visible morph, though both claim visible", () => {
    // Both visible; only the morph is actually rendered. The console cell registers LAST, which is
    // what a `runId` bump from `bsc fleet wake` does to every card in the tab at once.
    const claims = [claim("morph", { visible: true }), claim("console", { visible: true })];
    expect(ownerClaim(claims, onScreen(["morph"]))?.slotId).toBe("morph");
  });

  it("still prefers the last ON-SCREEN claim when several are genuinely rendered", () => {
    const claims = [claim("a", { visible: true }), claim("b", { visible: true })];
    expect(ownerClaim(claims, onScreen(["a", "b"]))?.slotId).toBe("b");
  });

  it("degrades to the previous rule when NOTHING passes the on-screen test", () => {
    // Mid-transition, a layout not yet computed, or a host with no document. Losing the terminal
    // entirely would be worse than the bug being fixed, so tier 2 is the old answer, unchanged.
    const claims = [claim("a", { visible: false }), claim("morph", { visible: true })];
    expect(ownerClaim(claims, onScreen([]))?.slotId).toBe("morph");
  });

  it("keeps the parked exception ahead of the on-screen test", () => {
    // A parked holding mount is off-screen BY DESIGN and must never own while a real surface exists —
    // the new tier must not accidentally promote it just because nothing else is rendered.
    const parked = claim("parked", { visible: true, parked: true });
    expect(ownerClaim([claim("morph", { visible: true }), parked], onScreen(["parked"]))?.slotId)
      .toBe("morph");
  });

  it("with no predicate, behaves exactly as it did before", () => {
    // The default answers "on screen" for everything, so a caller that cannot tell — and every
    // existing test above — gets byte-identical behaviour.
    const claims = [claim("morph", { visible: true }), claim("console", { visible: true })];
    expect(ownerClaim(claims)?.slotId).toBe("console");
  });

  it("parked beats visible — a visible holding mount is still a holding mount", () => {
    expect(ownerClaim([claim("parked", { visible: true, parked: true }), claim("cell", { visible: false })])?.slotId)
      .toBe("cell");
  });

  it("no claims ⇒ no owner", () => {
    expect(ownerClaim([])).toBeUndefined();
  });
});

describe("claimIsOnScreen", () => {
  it("treats a claim with no element as on screen rather than excluding it", () => {
    // Unknown must not outrank a claim we positively know is visible, and must not be dropped either.
    expect(claimIsOnScreen({})).toBe(true);
  });

  // jsdom has no layout — offsetParent is null and getClientRects() is empty for EVERYTHING — which
  // is exactly the "cannot tell" case the ladder degrades through. So these pin the PREDICATE against
  // hand-built shapes rather than against a rendered DOM, which jsdom could not answer for.
  const asEl = (offsetParent: unknown, rects: number) =>
    ({ offsetParent, getClientRects: () => ({ length: rects }) }) as unknown as HTMLElement;

  it("reads offsetParent — null means a display:none subtree or a detached node", () => {
    expect(claimIsOnScreen({ el: asEl(null, 0) })).toBe(false);
    expect(claimIsOnScreen({ el: asEl({}, 0) })).toBe(true);
  });

  it("falls back to client rects, so a position:fixed slot is not mistaken for hidden", () => {
    // A fixed-positioned element reports offsetParent === null while fully visible. Without this
    // fallback such a slot would silently lose every ownership contest to an off-screen console cell.
    expect(claimIsOnScreen({ el: asEl(null, 1) })).toBe(true);
  });

  it("survives an element without getClientRects rather than throwing on the ownership path", () => {
    expect(claimIsOnScreen({ el: { offsetParent: null } as unknown as HTMLElement })).toBe(false);
  });

  it("parked beats visible — a visible holding mount is still a holding mount", () => {
    expect(ownerClaim([claim("parked", { visible: true, parked: true }), claim("cell", { visible: false })])?.slotId)
      .toBe("cell");
  });

  it("no claims ⇒ no owner", () => {
    expect(ownerClaim([])).toBeUndefined();
  });
});
