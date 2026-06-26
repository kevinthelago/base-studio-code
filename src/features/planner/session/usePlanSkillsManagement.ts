// usePlanSkillsManagement (#1474) — the planner's session skill-group + live skills refresh,
// extracted verbatim from Planning.tsx. Side-effect only (no state, no return).

import { useEffect } from "react";
import { useAppStore } from "@/store";
import { usePoll } from "@/shared/hooks/usePoll";

export function usePlanSkillsManagement(sessionGroupId: string, projectTitle: string): void {
  const ensureSessionGroup = useAppStore(s => s.ensureSessionGroup);
  const refreshSkills = useAppStore(s => s.refreshSkills);
  // Whether the per-project session group exists YET. It's created lazily by
  // `bsc-skill add --group "$BSC_SESSION_SKILL_GROUP"` the first time the planner authors a skill —
  // NOT on planner open, so a project that authors none never leaves an empty group behind (#1616).
  const groupExists = useAppStore(s => s.skillGroups.some(g => g.id === sessionGroupId));

  // Adopt the session group ONCE IT EXISTS (#1419/#1616): never pre-create it. When the planner authors
  // its first skill, bsc-skill creates the group (placeholder name = its id); the refresh poll below
  // surfaces it here, and we rename the placeholder to the project name — and again if the title later
  // changes — without clobbering members. Persistent: reopening the planner keeps collecting into it.
  useEffect(() => {
    if (groupExists && sessionGroupId && projectTitle) ensureSessionGroup(sessionGroupId, projectTitle);
  }, [groupExists, sessionGroupId, projectTitle, ensureSessionGroup]);

  // Re-read the global skills.db while planning so skills the planner authors with `bsc-skill add`
  // (and their session-group membership) surface live in the pane — the skills.json file-poll that
  // used to do this was retired (#1417/#1419). Cheap (no push-back); 2.5s ≈ the section-poll cadence.
  usePoll(() => { void refreshSkills(); }, 2500, [refreshSkills]);
}
