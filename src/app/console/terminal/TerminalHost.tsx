// TerminalHost (#2378, epic #2372) — the app-level owner of every agent terminal. It renders exactly
// ONE <TerminalView> per paneId (hence one xterm instance + one `pty_data_<paneId>` listener), portaled
// into a stable per-pane container <div>. Surfaces don't mount their own terminal — they drop a
// <TerminalSlot paneId> placeholder, and the host RE-PARENTS the pane's container into whichever slot
// currently owns it (the console grid cell OR the Glance dock), parking it in a hidden holding node when
// no surface shows it. Because a re-parent is a plain appendChild MOVE (not a React remount), the xterm
// canvas + scrollback + PTY listener survive the hand-off untouched — so the PTY is never torn down when
// the terminal moves between surfaces.
//
// This replaces the pre-#2378 double-mount: the console cell and the Glance dock each mounted their own
// <TerminalView> for the same paneId and coordinated by hand ("only one is `visible` at a time") to keep
// two xterms from fighting over PTY sizing. One host = one terminal = no coordination hack, no doubled
// renderer memory, no doubled reconnect side-effects, and no double-counted live-agent tally.
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TerminalView } from "@/app/console/panes/views/TerminalView";
import { isStudioSessionPaneId, isFullCapabilitySession } from "@/shared/lib/session/systemSessions";

/** The terminal props a slot supplies to the shared <TerminalView>. The console cell is the `primary`
 *  (it owns the launch/data props); the Glance dock is a viewer that supplies only visibility/focus. */
export interface SlotTerminalProps {
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  initCmd?: string;
  /** The prompt to bake into the launch, when the launching surface already knows it.
   *
   *  It travels HERE, beside `initCmd`, rather than only through the store — which is where it used to
   *  live exclusively, and why a debug session could come up as a bare `claude` with nothing to do
   *  (`a-debug-session-launches-with-no-charter`). Props are re-read live at portal-render time; the
   *  store is read ONCE inside a one-shot launch effect, so any ordering that puts the mount's write
   *  after that read loses the prompt silently — and a session with no prompt looks identical to one
   *  that has simply finished. Measured on the running app: 58 of 58 debug launches carried the props
   *  and none carried the prompt.
   *
   *  `TerminalView` still falls back to `paneStartupPromptText` for the panes that seed it that way
   *  (fleet, triage, persona adopt); this is for a surface that HAS the prompt at render time. */
  startupPrompt?: string;
  onCwdChange?: (path: string) => void;
  onStatusChange?: (status: "run" | "idle") => void;
  onFocus?: () => void;
  /** True for the console grid cell — the surface that launches the session and consumes its cwd/status.
   *  The host sources launch/data props from the primary claim so a Glance-owned terminal still reports
   *  cwd/status back to the console; visibility/focus always follow the current owner. */
  primary?: boolean;
  /** True for an off-screen HOLDING claim that exists only to keep the PTY alive (the app-owned session
   *  mounts, #3326/#3357) — it must never take ownership away from a real surface. Ownership is normally
   *  "last claim wins", but a holding claim can register at an arbitrary time (its cwd resolves async), so
   *  without this it could land AFTER a visible dock and park the terminal off-screen. A parked claim owns
   *  the terminal only when it is the ONLY kind of claim left. */
  parked?: boolean;
}

/** The claim that visually HOSTS the terminal.
 *
 * Order of preference: the last VISIBLE non-parked claim · else the last non-parked claim · else the
 * last claim (every remaining one is a parked holding mount). Pure — exported for the unit tests.
 *
 * ## Why visibility outranks registration order
 *
 * This used to be "last non-parked claim wins", and that quietly made a HIDDEN surface able to steal
 * the terminal from a visible one. A console grid cell claims its pane whenever its card is mounted
 * and passes `visible={view === "console" && !hidden}` — so a cell in a background tab is a live,
 * non-parked claim that simply is not on screen. Register it after a Glance morph and the terminal was
 * re-parented into that hidden cell, leaving the morph the user was looking at with an empty div.
 *
 * Nothing had to change on screen for that to happen, which is why it read as "terminals randomly go
 * blank": ANY remount of a console card re-registers its slot at the END of the claim list. A `runId`
 * bump remounts every card in a tab at once (`key={runId-i}`), so one `bsc fleet wake` could blank
 * every open morph simultaneously — reported, and mis-attributed at the time to the morph grid's
 * anchor.
 *
 * `parked` was already an exception to last-wins for exactly this shape of bug ("a holding claim can
 * register at an arbitrary time ... without this it could land AFTER a visible dock and park the
 * terminal off-screen"). That reasoning was right and simply did not go far enough: a hidden console
 * cell is not parked, and steals just the same.
 *
 * ## `visible` is a CLAIM about the pane, not about the screen
 *
 * This used to end: "Ties are impossible in practice — the console grid and the Glance canvas are
 * different Workspaces, so at most one is on screen." THAT PREMISE IS FALSE, and the bug came back
 * through it. `App.tsx` keeps the console mounted across every navigation —
 * `display: activeWorkspace === "console" ? "flex" : "none"` — precisely so xterm survives, while
 * Glance is conditionally rendered. So on Glance BOTH are mounted, and a console cell's
 * `visible={view === "console" && !hidden}` is still `true`: `hidden` means "another pane is
 * fullscreen, or another tab is active", never "this whole Workspace is off screen".
 *
 * Two visible claims therefore coexist all the time, last-wins picks the console cell, and the wake
 * blanks the morph exactly as before — the earlier fix ruled out a hidden PANE and not a hidden
 * WORKSPACE.
 *
 * So ask the DOM instead of trusting the prop: `offsetParent === null` is exactly "inside a
 * `display:none` subtree" (or detached), which is the one thing `visible` cannot express and the one
 * thing that actually decides whether the user can see it. Injected rather than called directly so
 * this stays pure and every tier is unit-testable; the default answers "on screen" for everything, so
 * a caller that cannot tell gets byte-identical behaviour to before.
 *
 * The ladder degrades rather than failing: if NOTHING passes the on-screen test — mid-transition, a
 * layout not yet computed, a host without a document — tier 2 is the previous rule, so the terminal
 * still lands somewhere sensible instead of nowhere. */
export function ownerClaim<T extends { propsRef: { readonly current: SlotTerminalProps }; el?: HTMLElement }>(
  claims: readonly T[],
  onScreen: (claim: T) => boolean = () => true,
): T | undefined {
  // 1. The one the user can actually SEE.
  for (let i = claims.length - 1; i >= 0; i--) {
    const p = claims[i].propsRef.current;
    if (!p.parked && p.visible && onScreen(claims[i])) return claims[i];
  }
  // 2. …else the previous rule, unchanged.
  for (let i = claims.length - 1; i >= 0; i--) {
    const p = claims[i].propsRef.current;
    if (!p.parked && p.visible) return claims[i];
  }
  for (let i = claims.length - 1; i >= 0; i--) if (!claims[i].propsRef.current.parked) return claims[i];
  return claims[claims.length - 1];
}

/** Is this claim's slot actually rendered — i.e. not inside a `display:none` subtree, and attached?
 *
 *  `offsetParent` is the portable test for exactly that: it is `null` for an element in a hidden
 *  subtree or outside the document. Its one blind spot is `position: fixed`, which reports `null`
 *  while perfectly visible — so `getClientRects()` backs it up, since a hidden element has no boxes
 *  and a fixed one has boxes. Neither alone is sufficient: a laid-out-but-zero-size slot has no rects,
 *  and a fixed one has no offsetParent. Closing the gap here rather than asserting a slot is "never
 *  fixed" is deliberate — an assertion about layout made in a comment is exactly the kind of premise
 *  that quietly stopped being true and produced this bug in the first place.
 *
 *  A claim with no element cannot be tested, so it is treated as on screen: unknown must not outrank
 *  a claim we positively know is visible, and it must not be excluded either. */
export function claimIsOnScreen(claim: { el?: HTMLElement }): boolean {
  if (!claim.el) return true;
  return claim.el.offsetParent !== null || claim.el.getClientRects?.().length > 0;
}

/** Every paneId whose OWNER claim is a surface the user can actually see.
 *
 *  THIS IS THE ANSWER TO "is the user looking at this session", and it is the only place in the app
 *  that has it. The backend reaper's one unconditional protection — `if (on_screen) return false` —
 *  used to be fed a single pane id resolved from the console grid's `focusedPaneIdx`, so a studio
 *  session, a graph session and a network architect could never be it. They are not console panes and
 *  never will be. Under a ten-second idle grace that meant a session died while its terminal was on
 *  screen in front of the user.
 *
 *  Composed from the two rules the host already applies rather than re-derived: `ownerClaim` picks the
 *  surface that visually hosts the terminal, and `claimIsOnScreen` is the DOM check that a
 *  kept-mounted-but-CSS-hidden page dock does not count (`display: none` ⇒ no `offsetParent`, no
 *  client rects). A page the user navigated away from therefore stops protecting its studio, which is
 *  what makes the reaper still able to do its job.
 *
 *  A `parked` owner never counts: it is the off-screen holding mount that exists only to keep the PTY
 *  alive, so counting it would protect every wanted studio for ever and disable the reaper entirely
 *  for exactly the sessions it was built to bound. */
/** The mounted host's live claim registry, published for {@link onScreenPaneIdsNow}. Null when no
 *  <TerminalHost> is mounted — in which case nothing is on screen, which is the correct answer. */
let liveRegistry: ReadonlyMap<string, readonly Claim[]> | null = null;

/** {@link onScreenPaneIds} for the mounted host — the form `useIdleReaper` reports to the backend.
 *
 *  Empty with no host mounted, and that is not a degraded answer: with no terminal host there is no
 *  terminal on screen. The backend treats an empty report exactly as it treats a missing one — nothing
 *  is protected — so an app that has not painted yet cannot accidentally pin sessions alive. */
export function onScreenPaneIdsNow(): string[] {
  return liveRegistry ? onScreenPaneIds(liveRegistry) : [];
}

export function onScreenPaneIds<T extends { propsRef: { readonly current: SlotTerminalProps }; el?: HTMLElement }>(
  registry: ReadonlyMap<string, readonly T[]>,
): string[] {
  const out: string[] = [];
  for (const [paneId, claims] of registry) {
    if (claims.length === 0) continue;
    const owner = ownerClaim(claims, claimIsOnScreen);
    const p = owner?.propsRef.current;
    if (p && !p.parked && p.visible && claimIsOnScreen(owner)) out.push(paneId);
  }
  return out.sort();
}

/** A registered claim on a paneId's terminal. Claims are ordered by registration; the last non-`parked`
 *  claim is the current owner (see {@link ownerClaim}) — the surface that visually hosts + drives the
 *  terminal. `propsRef` is read live at portal-render
 *  time so callback-identity churn never forces a host re-render (only visible/focus changes do, via touch). */
interface Claim {
  slotId: string;
  el: HTMLElement;
  propsRef: { readonly current: SlotTerminalProps };
}

interface HostApi {
  /** Register (or re-register, StrictMode-safe) a slot's claim on a paneId. */
  register(paneId: string, slotId: string, el: HTMLElement, propsRef: { readonly current: SlotTerminalProps }): void;
  /** Drop a slot's claim; ownership falls back to the previous claimant, or the terminal parks/tears down. */
  deregister(paneId: string, slotId: string): void;
  /** Nudge the host to re-read live props (call when a claim's visible/focus changes). */
  touch(): void;
}

const TerminalHostCtx = createContext<HostApi | null>(null);

/** The host API for a <TerminalSlot>. Null when no <TerminalHost> is an ancestor — the slot then renders an
 *  inert placeholder (e.g. a component rendered in isolation in a unit test), never crashing. */
export function useTerminalHost(): HostApi | null {
  return useContext(TerminalHostCtx);
}

export function TerminalHost({ children }: { children: ReactNode }) {
  // paneId → ordered claims (last = owner). Held in a ref (the source of truth); a version counter drives
  // re-renders so we never store DOM els / live callbacks in React state.
  const registryRef = useRef<Map<string, Claim[]>>(new Map());
  // paneId → the stable container that hosts its single <TerminalView>. Created lazily during render so the
  // portal has a target immediately; the effect below parents it into the owner slot (or the holding node).
  const containersRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const holdingRef = useRef<HTMLDivElement>(null);
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  // Stable API object (identity never changes — `rerender` is stable — so a slot's register effect doesn't
  // re-run on host re-renders). Mutates the registry ref inside the callbacks (which run in effects/events,
  // never during render) then bumps the version to re-render.
  const api = useMemo<HostApi>(() => ({
    register(paneId, slotId, el, propsRef) {
      const map = registryRef.current;
      // Replace any prior claim for this slot (StrictMode remount / element swap), else append as the new owner.
      const next = (map.get(paneId) ?? []).filter((c) => c.slotId !== slotId);
      next.push({ slotId, el, propsRef });
      map.set(paneId, next);
      rerender();
    },
    deregister(paneId, slotId) {
      const map = registryRef.current;
      const claims = map.get(paneId);
      if (!claims) return;
      const next = claims.filter((c) => c.slotId !== slotId);
      if (next.length) map.set(paneId, next);
      else map.delete(paneId);
      rerender();
    },
    touch: rerender,
  }), [rerender]);

  // PUBLISH THE LIVE REGISTRY for `onScreenPaneIdsNow`. Not context, because the one consumer —
  // `useIdleReaper` — is called in `App`'s body, ABOVE this provider, and deliberately so: it is one
  // of the always-on shell hooks, and `idleReaperMounted.test.ts` pins it there because "a reaper that
  // only runs while somebody is looking at the Console is not a reaper". Module state is the honest
  // way for something above the tree to read something inside it, and this file is a FILE rather than
  // a record precisely because a registered record may not hold module state.
  useEffect(() => {
    liveRegistry = registryRef.current;
    // Only clear what WE published: under StrictMode's double-mount the second host has already
    // published its own registry by the time the first one's cleanup runs.
    return () => { if (liveRegistry === registryRef.current) liveRegistry = null; };
  }, []);

  /** The stable container for a paneId, created on first render that needs it. Kept in a ref so the same
   *  node is reused across owner changes — that node (with its xterm inside) is what gets re-parented. */
  const containerFor = (paneId: string): HTMLDivElement => {
    let c = containersRef.current.get(paneId);
    if (!c) {
      c = document.createElement("div");
      c.style.flex = "1";
      c.style.minHeight = "0";
      c.style.display = "flex";
      c.style.flexDirection = "column";
      c.dataset.terminalContainer = paneId;
      containersRef.current.set(paneId, c);
    }
    return c;
  };

  // After every render: park a just-created container in the holding node, re-parent each pane's container
  // into its current owner slot, and drop containers whose pane no longer has any claim (its <TerminalView>
  // stopped rendering, so the xterm was disposed — remove the emptied node).
  useEffect(() => {
    const map = registryRef.current;
    const containers = containersRef.current;
    for (const [paneId, container] of containers) {
      const claims = map.get(paneId);
      const owner = claims && ownerClaim(claims, claimIsOnScreen);
      if (owner?.el) {
        if (container.parentElement !== owner.el) owner.el.appendChild(container);
      } else if (map.has(paneId)) {
        // Claimed but the owner has no element yet — hold it (shouldn't happen; defensive).
        if (container.parentElement !== holdingRef.current) holdingRef.current?.appendChild(container);
      } else {
        // No claims left: the portal below stopped rendering (TerminalView unmounted) → drop the node.
        container.remove();
        containers.delete(paneId);
      }
    }
  });

  const activePaneIds = Array.from(registryRef.current.keys());

  return (
    <TerminalHostCtx.Provider value={api}>
      {children}
      {/* Holding node — parked containers live here (display:none) so their TerminalView, and thus the PTY
          + scrollback, stay alive while no surface is showing them. */}
      {/* eslint-disable-next-line no-restricted-syntax -- imperative re-parent target for parked terminals */}
      <div ref={holdingRef} style={{ display: "none" }} aria-hidden />
      {activePaneIds.map((paneId) => {
        const claims = registryRef.current.get(paneId)!;
        const owner = ownerClaim(claims, claimIsOnScreen)!;
        // Launch/data props from the primary (console) claim; visibility/focus from the current owner.
        const primaryClaim = claims.find((c) => c.propsRef.current.primary);
        // #3427 — an APP-OWNED session must not launch before its dedicated mount claims it. Its page dock
        // (`DesignerTerminal` and friends) calls `openStudio` and renders its viewer <TerminalSlot> in the
        // SAME commit, while the mount that supplies the launch props only appears after an async
        // `setup_*_workspace` invoke resolves. The viewer therefore always registered first, and with no
        // primary to source from, `TerminalView` mounted with `initialCwd`/`initCmd` UNDEFINED — a one-shot
        // launch, so the primary arriving a tick later never repaired it. `pty_create` then ran with
        // `cwd=<none>`: the shell inherited the app's own working directory instead of the studio
        // workspace, loaded none of its spec CLAUDE.md, skipped `--continue` + the persona kickoff, and
        // (because `ensure_session_settings` is skipped for an empty cwd) ran PERMISSION-LESS with no role
        // gate at all. Waiting one tick for the mount costs nothing visible and makes the launch correct.
        //
        // Scoped to the fixed app-owned ids, each of which HAS such a mount (StudioSessionMount ×4 +
        // DebugSessionMount) that is guaranteed to arrive — a fleet pane's primary is its console grid
        // cell, which may legitimately never mount while Glance shows the terminal, so gating it would
        // hide a working session. And only BEFORE the first render: once a pane has a container its
        // TerminalView stays mounted whatever the claims do, so a mount unmounting later (a tear-off, the
        // idle reaper) can never tear a live PTY down through this path.
        // `isFullCapabilitySession` rides alongside the fixed-id check because the DEBUG studio's panes
        // are per-REQUEST (`debug-studio:req-<id>`) and so are not app-owned studio panes, which is
        // an exact-match list. The comment above names `DebugSessionMount` as one of the mounts that make
        // this safe — that mount is gone, replaced by `RequestSessionsMount`, whose panes the exact-match
        // check silently stopped covering. The guarantee it relies on still holds for them: every
        // `debug-studio:` pane has exactly one owning mount and that mount is unconditional.
        //
        // Without this, a viewer claiming one of those panes first launches it with `initialCwd` and
        // `initCmd` UNDEFINED — reproduced in this file's test, and worse than it sounds: an empty cwd
        // also skips `ensure_session_settings`, so the session runs with no role gate at all.
        const awaitsItsMount = isStudioSessionPaneId(paneId) || isFullCapabilitySession(paneId);
        if (!primaryClaim && awaitsItsMount && !containersRef.current.has(paneId)) return null;
        const primary = primaryClaim ?? owner;
        const op = owner.propsRef.current;
        const pp = primary.propsRef.current;
        return createPortal(
          <TerminalView
            paneId={paneId}
            visible={op.visible}
            focused={op.focused}
            initialCwd={pp.initialCwd}
            initCmd={pp.initCmd}
            startupPrompt={pp.startupPrompt}
            onCwdChange={pp.onCwdChange}
            onStatusChange={pp.onStatusChange}
            onFocus={pp.onFocus}
          />,
          containerFor(paneId),
          paneId,
        );
      })}
    </TerminalHostCtx.Provider>
  );
}
