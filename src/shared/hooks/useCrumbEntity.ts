import { useEffect } from "react";
import { useAppStore } from "@/store";

/**
 * Report the navigated ENTITY label for a graph to the titlebar location crumb (#3041) — the thing you're
 * INSIDE the graph: the drilled project (Glance), the entered team (Teams), the active kit (Components),
 * the active language (Algorithms). `key` is the page id (`glance`/`teams`/`designs`/`algorithms`);
 * `label` is the current entity name, `""` when none (e.g. a graph overview). `locationCrumb` appends it
 * after the page name, so the crumb reads e.g. "Planner — Components — react-ui".
 *
 * The graph resolves the label itself (it has the local selection + the data), so the store just carries
 * the resolved string — App.tsx needs no per-graph knowledge. The store write is idempotent, so calling
 * this every render is cheap.
 */
export function useCrumbEntity(key: string, label: string): void {
  const setCrumbEntity = useAppStore((s) => s.setCrumbEntity);
  // Block body (not `() => setCrumbEntity(...)`) so the effect returns undefined — an implicit return of
  // the action's value would be mistaken for a cleanup fn ("destroy is not a function" on unmount).
  useEffect(() => { setCrumbEntity(key, label); }, [key, label, setCrumbEntity]);
}
