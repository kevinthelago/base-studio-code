// useNavHistory (#…, org drill + planner page #2492) — an app-wide back/forward navigation history bound
// to the mouse's BACK (X1) and FORWARD (X2) side buttons. A "location" is the active WORKSPACE plus the
// in-workspace navigation the store already tracks: the Planner page (Projects ↔ Org), the Glance drill
// target, and the Org designer's pool drill — so back/forward step through workspace switches, planner
// page switches, and drilling in/out of a project's fleet or an org pool.
// Mounted ONCE (App.tsx). The webview's own back/forward on those buttons is suppressed so this owns them.
import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import type { Workspace } from "@/app/registry";
import { log } from "@/shared/lib/core/log";

interface NavLoc {
  workspace: Workspace;
  /** The Planner workspace's page (Projects ↔ Teams ↔ Designs ↔ Algorithms); null on every
   *  other workspace. */
  page: "projects" | "teams" | "designs" | "algorithms" | "sounds" | null;
  /** The Glance drill target; null outside Glance. */
  drill: string | null;
  /** The Org designer's pool drill; null unless the Planner's Org page is showing. */
  teamsDrill: string | null;
}
const eq = (a: NavLoc, b: NavLoc) =>
  a.workspace === b.workspace && a.page === b.page && a.drill === b.drill && a.teamsDrill === b.teamsDrill;

export function useNavHistory() {
  const workspace = useAppStore((s) => s.activeWorkspace);
  const pageMode = useAppStore((s) => s.projectsPageMode);
  const glanceDrill = useAppStore((s) => s.glanceDrill);
  const teamsDrill = useAppStore((s) => s.teamsDrill);
  const setWorkspace = useAppStore((s) => s.setWorkspace);
  const setProjectsPageMode = useAppStore((s) => s.setProjectsPageMode);
  const setGlanceDrill = useAppStore((s) => s.setGlanceDrill);
  const setTeamsDrill = useAppStore((s) => s.setTeamsDrill);

  // Each facet only matters where it is visible; elsewhere a location carries null so history doesn't
  // split on a stale value held by another workspace/page.
  const loc: NavLoc = {
    workspace,
    page: workspace === "projects" ? pageMode : null,
    drill: workspace === "glance" ? glanceDrill : null,
    teamsDrill: workspace === "projects" && pageMode === "teams" ? teamsDrill : null,
  };

  const stack = useRef<NavLoc[]>([loc]);
  const idx = useRef(0);
  // The location a back/forward is applying — so the store change it causes doesn't push a new entry.
  const pending = useRef<NavLoc | null>(null);

  // Record a new entry when the location changes by NORMAL navigation (not our own back/forward). While a
  // back/forward is in flight, skip every push until the target is reached (guards against a multi-`set`
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
  }, [loc.workspace, loc.page, loc.drill, loc.teamsDrill]);

  // Bind the mouse back/forward buttons (X1 = button 3, X2 = button 4). Refs keep the listener stable.
  useEffect(() => {
    const go = (dir: -1 | 1) => {
      const next = idx.current + dir;
      if (next < 0 || next >= stack.current.length) return;
      idx.current = next;
      const target = stack.current[next];
      pending.current = target;
      setWorkspace(target.workspace);
      if (target.page) setProjectsPageMode(target.page);
      setGlanceDrill(target.workspace === "glance" ? target.drill : null);
      setTeamsDrill(target.teamsDrill);
    };
    // #3946: CAPTURE phase. These were bubble-phase, so any `stopPropagation` between the target and
    // `window` silently swallowed the navigation — and the app has plenty of those (the Glance canvas,
    // the morph overlays, xterm). Capture runs before every one of them, so this hook sees the event
    // first no matter where the pointer is. `pointerup` is handled too: it carries the same `button`
    // values and fires for devices that route through the pointer stack rather than legacy mouse events.
    //
    // A press is LOGGED once per button whether or not it navigates. That is the whole diagnostic: if a
    // press produces no log line, the event never reached the DOM at all — Chromium can consume XBUTTON
    // as a browser-level history accelerator on Windows — and no DOM listener can ever fix it. That case
    // needs native input capture, which is a different fix, and this tells us which one we are in
    // without guessing. jsdom cannot answer it and Playwright cannot synthesize X1/X2.
    const seen = new Set<number>();
    const handled = (e: MouseEvent | PointerEvent): boolean => {
      if (e.button !== 3 && e.button !== 4) return false;
      if (!seen.has(e.button)) {
        seen.add(e.button);
        log.info(`nav: mouse button ${e.button} (${e.button === 3 ? "back" : "forward"}) reached the DOM — binding is live`);
      }
      e.preventDefault();
      return true;
    };
    const onUp = (e: MouseEvent) => { if (handled(e)) go(e.button === 3 ? -1 : 1); };
    // Suppress the webview's native history nav on the other phases so this hook owns the gesture.
    const suppress = (e: MouseEvent) => { handled(e); };
    const opts = true; // capture
    window.addEventListener("mouseup", onUp, opts);
    window.addEventListener("pointerup", onUp as EventListener, opts);
    window.addEventListener("mousedown", suppress, opts);
    window.addEventListener("pointerdown", suppress as EventListener, opts);
    window.addEventListener("auxclick", suppress, opts);
    return () => {
      window.removeEventListener("mouseup", onUp, opts);
      window.removeEventListener("pointerup", onUp as EventListener, opts);
      window.removeEventListener("mousedown", suppress, opts);
      window.removeEventListener("pointerdown", suppress as EventListener, opts);
      window.removeEventListener("auxclick", suppress, opts);
    };
  }, [setWorkspace, setProjectsPageMode, setGlanceDrill, setTeamsDrill]);
}
