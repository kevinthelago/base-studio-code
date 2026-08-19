// The Skills feature's public API barrel (#1309).
//
// The `SkillsWorkspace` COMPONENT that used to live here is gone (retire-the-dead-skills-workspace-
// copy). It had been dead since #3654 — `lazyWorkspaces` resolves the symbol to `SkillsGraphHost`, so
// the record was what mounted and this was a second copy nobody rendered. #4179 is what that costs:
// two changes landed on the two copies four hours apart, neither was carried across, and the suite
// stayed green for months because the tests rendered THIS one.
//
// The barrel survives where `security`'s did not, because three records import it — `fleet-lessons`,
// `planningpage` and `teams-inspector` all reach `@/features/skills` for types and helpers.
// Re-exported feature surface — this index is the skills feature's public API barrel (#1309).
export { SkillsGraphHost } from "@/features/skills/SkillsGraphHost"; // the graph-hosted workspace (#3654)
export { SkillsStatus } from "@/features/skills/SkillsStatus";
export { SessionSkillsModal, type SessionSkillsModalProps } from "@/features/skills/SessionSkillsModal";

// #1545: public API for cross-feature consumers (planner, app/console).
export {
  type SkillDef, skillFromPayload, resolveSkills, effectiveSessionSkills,
  expandGroups, toSkillCfgs,
} from "@/features/skills/lib/skills";
export { loadPendingLessons, lessonTitle, type Lesson } from "@/features/skills/lib/lessons";
