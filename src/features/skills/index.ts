// Skills feature — public API (#1309). The app imports UI from here; cross-feature consumers that
// only need the pure domain (types + resolvers) import `@/features/skills/lib/skills` directly to
// avoid pulling React into non-UI modules.
export { SkillsScreen } from "./SkillsScreen";
export { SkillsStatus } from "./SkillsStatus";
export { SessionSkillsModal, type SessionSkillsModalProps } from "./SessionSkillsModal";
