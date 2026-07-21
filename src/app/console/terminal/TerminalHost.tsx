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
import { isStudioSessionPaneId } from "@/shared/lib/session/systemSessions";

/** The terminal props a slot supplies to the shared <TerminalView>. The console cell is the `primary`
 *  (it owns the launch/data props); the Glance dock is a viewer that supplies only visibility/focus. */
export interface SlotTerminalProps {
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  initCmd?: string;
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
  /** The CSS scale this slot is rendered UNDER (the graph zoom for a Glance morph, #3524). Default 1.
   *  When ≠1 the host counter-scales the terminal container by 1/scale so xterm's mouse math sees a net
   *  scale of 1 (a CSS `transform: scale()` breaks xterm's cell coordinate mapping — the hit cell comes
   *  out off by the scale factor), and TerminalView bumps the font by `scale` so the text still grows
   *  with zoom. Net: the terminal looks scaled but clicks land on the right cell. */
  scale?: number;
}

/** The claim that visually HOSTS the terminal: the last non-parked claim, else the last claim (every
 *  remaining claim is a parked holding mount). Pure — exported for the unit test. */
export function ownerClaim<T extends { propsRef: { readonly current: SlotTerminalProps } }>(claims: readonly T[]): T | undefined {
  for (let i = claims.length - 1; i >= 0; i--) if (!claims[i].propsRef.current.parked) return claims[i];
  return claims[claims.length - 1];
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

  /**
   * Counter-scale a re-parented terminal container to cancel the CSS `transform: scale(s)` its owner
   * slot renders under (#3524 — a Glance morph is a world-layer child, so it scales with the graph
   * zoom). xterm computes mouse cell coordinates from `getBoundingClientRect()` (which reflects the
   * scaled size) against its own UNSCALED cell metrics, so under a scaled ancestor the hit cell is off
   * by the scale factor. Scaling the container by `1/s` makes the NET CSS scale on the terminal 1, so
   * the mouse maps correctly; TerminalView bumps the font by `s`, so the text still grows with zoom.
   *
   * The container is sized to `s×` the slot and pinned top-left, so after the `1/s` scale it fills the
   * slot exactly. At `s === 1` (the console grid — the common case) every override is cleared, so the
   * shared console terminal is byte-for-byte untouched.
   */
  const applyScaleCounter = (container: HTMLDivElement, s: number) => {
    if (s === 1) {
      container.style.transform = "";
      container.style.transformOrigin = "";
      container.style.width = "";
      container.style.height = "";
      container.style.position = "";
      return;
    }
    const pct = `${s * 100}%`;
    container.style.transform = `scale(${1 / s})`;
    container.style.transformOrigin = "0 0";
    container.style.position = "absolute";
    container.style.top = "0";
    container.style.left = "0";
    container.style.width = pct;
    container.style.height = pct;
  };

  // After every render: park a just-created container in the holding node, re-parent each pane's container
  // into its current owner slot, and drop containers whose pane no longer has any claim (its <TerminalView>
  // stopped rendering, so the xterm was disposed — remove the emptied node).
  useEffect(() => {
    const map = registryRef.current;
    const containers = containersRef.current;
    for (const [paneId, container] of containers) {
      const claims = map.get(paneId);
      const owner = claims && ownerClaim(claims);
      if (owner?.el) {
        if (container.parentElement !== owner.el) owner.el.appendChild(container);
        applyScaleCounter(container, owner.propsRef.current.scale ?? 1);
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
        const owner = ownerClaim(claims)!;
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
        if (!primaryClaim && isStudioSessionPaneId(paneId) && !containersRef.current.has(paneId)) return null;
        const primary = primaryClaim ?? owner;
        const op = owner.propsRef.current;
        const pp = primary.propsRef.current;
        return createPortal(
          <TerminalView
            paneId={paneId}
            visible={op.visible}
            focused={op.focused}
            scale={op.scale ?? 1}
            initialCwd={pp.initialCwd}
            initCmd={pp.initCmd}
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
