import { useRef, Suspense, type ReactNode, type CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";

/**
 * Lazy-mount + kept-mounted (CSS-hidden) page idiom, extracted from the 4+ hand-rolled copies
 * across the shell (App.tsx Projects, planner index Design/Planning). A page mounts on its first
 * activation, then STAYS mounted (toggled with `display`) so its local state and live PTY survive
 * a screen/mode switch instead of being torn down.
 *
 * `gate` is the single-owner guard for tear-off pages: latch AND render are both conditioned on it,
 * so when the gate drops (e.g. the page is torn into its own window) the helper returns `null` and
 * fully unmounts — releasing the single PTY for the detached owner. Defaults to `true` (no gate).
 *
 * @param active whether this page is the currently-shown one (drives `display: flex | none`).
 * @param gate   single-owner guard; while false the page never latches and unmounts if already shown.
 * @param keepAlive mount the page (hidden) even if it was never actively shown — and, crucially, UNMOUNT
 *   it again when this drops (unless it was later shown normally). This is the on-demand reachability
 *   hook (#2940): the studio-network pump keeps a target studio session alive only while a commission is
 *   open, reusing this ONE single-owner mount (never a second PTY owner), and lets it tear down after.
 * @param fallback if provided, children are wrapped in `<Suspense>` (for a lazily-imported page).
 * @param style  merged over the flex-column box defaults (e.g. `{ flexDirection: "row" }`).
 */
export function KeptMountedPage({
  active,
  gate = true,
  keepAlive = false,
  fallback,
  style,
  children,
}: {
  active: boolean;
  gate?: boolean;
  keepAlive?: boolean;
  fallback?: ReactNode;
  style?: CSSProperties;
  children: ReactNode;
}) {
  // `everShown` latches ONLY on a real activation — so a page the user actually opened stays mounted
  // for the session (its live PTY survives a mode switch). `keepAlive` mounts without latching, so a
  // session brought up purely to fulfil a commission unmounts (releasing its PTY) when it clears.
  const everShown = useRef(false);
  if (active && gate) everShown.current = true;
  // The single-owner gate dropped, or the page is neither latched-open nor kept-alive → render nothing
  // (and release the PTY).
  if (!gate || !(everShown.current || keepAlive)) return null;

  const body = fallback !== undefined ? <Suspense fallback={fallback}>{children}</Suspense> : children;
  return (
    // minWidth/minHeight:0 keep the flex SHRINK CHAIN intact — a kept-mounted page (e.g. the Design
    // Studio's GraphCanvas) can then shrink WITH the window instead of pinning to its content's intrinsic
    // width and overflowing (which the `.screen-body` clips → the right pane vanishes, #3097). Every flex
    // ancestor from the shrinking element up to the sized ancestor needs it; don't drop these.
    <Box style={{ display: active ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0, minWidth: 0, ...style }}>
      {body}
    </Box>
  );
}
