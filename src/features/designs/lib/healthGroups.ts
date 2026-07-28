// Grouping for the graph-health worklist (#3886) — pure, React-free, so it lives in the feature's lib/.
import { HEALTH_SEVERITY, type HealthCategory, type HealthFinding } from "./graphHealth";

/** One category's findings. */
export interface HealthGroup {
  category: HealthCategory;
  findings: HealthFinding[];
}

/** Group `findings` by category, ordered by severity (desc) then category name — the same rule
 *  `analyzeGraphHealth` sorts its flat list by, so the panel never disagrees with `bsc ui doctor` about
 *  what is most urgent.
 *
 *  Grouped rather than flat because the useful unit of work is "the 18 untested nodes", not finding #47 —
 *  eighty findings in one column is a wall. */
export function groupFindings(findings: HealthFinding[]): HealthGroup[] {
  const by = new Map<HealthCategory, HealthFinding[]>();
  for (const f of findings) {
    const list = by.get(f.category);
    if (list) list.push(f);
    else by.set(f.category, [f]);
  }
  return [...by.entries()]
    .map(([category, fs]) => ({ category, findings: fs }))
    .sort((a, b) => HEALTH_SEVERITY[b.category] - HEALTH_SEVERITY[a.category] || a.category.localeCompare(b.category));
}
