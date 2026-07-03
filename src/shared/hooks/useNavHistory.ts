// useNavHistory (#…) — an app-wide back/forward navigation history bound to the mouse's BACK (X1) and
// FORWARD (X2) side buttons. A "location" is the active WORKSPACE + the Glance drill target (both held in
// the store), so back/forward step through workspace switches and drilling in/out of a project's fleet.
// Mounted ONCE (App.tsx). The webview's own back/forward on those buttons is suppressed so this owns them.
import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import type { Workspace } from "@/app/registry";

interface NavLoc { workspace: Workspace; drill: string | null }
const eq = (a: NavLoc, b: NavLoc) => a.workspace === b.workspace && a.drill === b.drill;

export function useNavHistory() {
  const workspace = useAppStore((s) => s.activeWorkspace);
  const glanceDrill = useAppStore((s) => s.glanceDrill);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setGlanceDrill = useAppStore((s) => s.setGlanceDrill);

  // The drill only matters inside Glance; elsewhere a location's drill is null so history doesn't split
  // on a stale value carried by another workspace.
  const loc: NavLoc = { workspace, drill: workspace === "glance" ? glanceDrill : null };

  const stack = useRef<NavLoc[]>([loc]);
  const idx = useRef(0);
  // The location a back/forward is applying — so the store change it causes doesn't push a new entry.
  const pending = useRef<NavLoc | null>(null);

  // Record a new entry when the location changes by NORMAL navigation (not our own back/forward). While a
  // back/forward is in flight, skip every push until the target is reached (guards against a two-`set`
  // apply rendering an intermediate location).
  useEffect(() => {
    if (pending.current) {
      if (eq(pending.current, loc)) pending.current = null;
      return;
    }
    if (eq(stack.current[idx.current], loc)) return;
    stack.current = stack.current.slice(0, idx.current + 1);
    stack.current.push(loc);
    idx.current = stack.current.length - 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.workspace, loc.drill]);

  // Bind the mouse back/forward buttons (X1 = button 3, X2 = button 4). Refs keep the listener stable.
  useEffect(() => {
    const go = (dir: -1 | 1) => {
      const next = idx.current + dir;
      if (next < 0 || next >= stack.current.length) return;
      idx.current = next;
      const target = stack.current[next];
      pending.current = target;
      setWorkspace(target.workspace);
      setGlanceDrill(target.workspace === "glance" ? target.drill : null);
    };
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); go(-1); }
      else if (e.button === 4) { e.preventDefault(); go(1); }
    };
    // Suppress the webview's native history nav on these buttons so this hook owns them.
    const suppress = (e: MouseEvent) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("mousedown", suppress);
    window.addEventListener("auxclick", suppress);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("mousedown", suppress);
      window.removeEventListener("auxclick", suppress);
    };
  }, [setWorkspace, setGlanceDrill]);
}
