// Derived KPIs computed from the live skills list (the Skills screen's header tiles).

import type { SkillDef } from "./skillsModel";

// ── derived KPIs (from the live list) ──────────────────────────────────────────

export interface DerivedSkillKpis {
  total: number;
  pinned: number;
  /** sum of per-skill invocations (display telemetry). */
  invWeek: number;
  /** invocation-weighted success rate (0 when there are no invocations). */
  avgSuccess: number;
}

export function deriveSkillKpis(skills: SkillDef[]): DerivedSkillKpis {
  const totalInv = skills.reduce((a, s) => a + s.invocations, 0);
  const avgSuccess = totalInv > 0
    ? Math.round(skills.reduce((a, s) => a + s.success * s.invocations, 0) / totalInv)
    : 0;
  return {
    total: skills.length,
    pinned: skills.filter(s => s.pinned).length,
    invWeek: totalInv,
    avgSuccess,
  };
}
