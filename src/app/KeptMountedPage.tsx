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
 * @param fallback if provided, children are wrapped in `<Suspense>` (for a lazily-imported page).
 * @param style  merged over the flex-column box defaults (e.g. `{ flexDirection: "row" }`).
 */
export function KeptMountedPage({
  active,
  gate = true,
  fallback,
  style,
  children,
}: {
  active: boolean;
  gate?: boolean;
  fallback?: ReactNode;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const everShown = useRef(false);
  if (active && gate) everShown.current = true;
  // Not yet shown, or the single-owner gate has dropped → render nothing (and release the PTY).
  if (!everShown.current || !gate) return null;

  const body = fallback !== undefined ? <Suspense fallback={fallback}>{children}</Suspense> : children;
  return (
    <Box style={{ display: active ? "flex" : "none", flex: 1, flexDirection: "column", minHeight: 0, ...style }}>
      {body}
    </Box>
  );
}
