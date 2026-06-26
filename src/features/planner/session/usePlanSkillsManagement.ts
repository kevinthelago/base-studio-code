// usePlanSkillsManagement (#1474) — the planner's session skill-group + live skills refresh,
// extracted verbatim from Planning.tsx. Side-effect only (no state, no return).

import { useEffect } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";

export function usePlanSkillsManagement(sessionGroupId: string, projectTitle: string): void {
  const ensureSessionGroup = useAppStore(s => s.ensureSessionGroup);
  const refreshSkills = useAppStore(s => s.refreshSkills);

  // The per-project planning session skill group (#1419): ensure it exists, named after the project
  // (renamed in place if the title changes — never clobbering members). Skills the planner authors
  // via `bsc-skill add --group "$BSC_SESSION_SKILL_GROUP"` join it; the pane highlights its members.
  // Persistent — reopening the planner keeps collecting into the same group.
  useEffect(() => {
    if (!sessionGroupId || !projectTitle) return;
    ensureSessionGroup(sessionGroupId, projectTitle);
  }, [sessionGroupId, projectTitle, ensureSessionGroup]);

  // Re-read the global skills.db while planning so skills the planner authors with `bsc-skill add`
  // (and their session-group membership) surface live in the pane — the skills.json file-poll that
  // used to do this was retired (#1417/#1419). Cheap (no push-back); 2.5s ≈ the section-poll cadence.
  usePoll(() => { void refreshSkills(); }, 2500, [refreshSkills]);
}
