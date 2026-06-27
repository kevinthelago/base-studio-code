// The generic inline-SVG icon set moved to `shared/ui/icons` (#1752) so shared components (e.g.
// BackButton) can use it without importing from features/ (the feature-first rule). Re-exported here
// so existing `@/features/planner/blueprints/blueprintIcons` imports keep resolving unchanged.
export { Ic, ICONS } from "@/shared/ui/icons";
