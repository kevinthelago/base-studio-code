// arrayMove -- pure, feature/app-agnostic array reordering helper.
//
// Lives in shared/ so both the console tab-reorder machinery (app/console) and
// the per-page tab model (shared/hooks/usePageTabs) can reuse it without shared/
// reaching into app/ (#1703).

/** Move the element at `from` to `to` in a new array (no mutation). Out-of-range
 *  or no-op moves return a shallow copy unchanged. */
export function moveInArray<T>(arr: T[], from: number, to: number): T[] {
  const out = arr.slice();
  if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
  const [m] = out.splice(from, 1);
  out.splice(to, 0, m);
  return out;
}
