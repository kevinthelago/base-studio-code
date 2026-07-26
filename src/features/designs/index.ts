// Public API of the components feature (#2269) — the proven-component library: the planner's
// project-scoped pane (#2314) and the full-page Design Studio workspace (#2308).
export { PlannerComponentsPane } from "./PlannerComponentsPane";
export { DesignsWorkbench } from "./DesignsWorkbench";
// #2658: the blueprint-download reconciliation confirm-list (generate + register missing categories).
export { DesignReconcileModal, type DesignReconcileModalProps } from "./DesignReconcileModal";
export { generateCategoryColors } from "./lib/designGenBridge";
export { createComponentsSlice, DEFAULT_OVERNIGHT_BUDGET, type ComponentsSlice, type DesignerOvernightRun } from "./store";
export {
  ROLE_COLOR, ROLES, matchesQuery, resolveComposes, resolveUsedBy,
  type ComponentRecord, type Kit, type PropSpec, type Role, type KitRule, type KitRuleKind,
  type AnalyticsEvent,
} from "./lib/model";
// The shipped analytics EMIT runtime (#3816, epic #3809 slice 3) — manifests (#3810) drive `bsc usage
// record` (#3812) by construction at the KitRenderer action seam. Host-agnostic: inject the sink.
export {
  eventNameForProp, resolveAnalyticsEmit, usageRecordArgs, makeAnalyticsEmit,
  componentAnalyticsLookup, collectingSink, consoleUsageSink,
  type ActionFire, type UsageRecord, type UsageSink, type AnalyticsLookup,
} from "./lib/analyticsEmit";
export { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
// Mounted-preview registry (#3437) — what `bsc debug frames` reports on.
export {
  registerPreviewFrame, unregisterPreviewFrame, mountedPreviewFrames, resetPreviewFrames,
  type PreviewFrameEntry,
} from "./lib/previewRegistry";
// Cross-graph library composition (#3116/#3117) + its KIT-level roll-up (#3133) — the (kit → algorithm /
// sound) `requires` pairs Glance joins against `kitUsage` to draw a project's real library dependencies.
export {
  resolveComponentLibraryRefs, resolveKitLibraryRefs,
  type LibraryComposition, type KitLibraryRef,
} from "./lib/libraryComposition";
// Kit lint rules → eslint preset (#2279) — the generator the planner bakes into a generated app.
export {
  deriveRules, mergeRules, kitRules, componentRules, ruleMessage, toEslintRules, toEslintPreset, ESCAPE_HATCH,
  type EslintRulesConfig,
} from "./lib/rules";
// Kit-change propagation (#2277) — the fan-out decision spine (classify → plan dispatch to consumers)
// + the delivery drain (plan which dispatches to fire this cycle, and the per-rail messages).
export {
  classifyChange, makeChange, changeId, kitUsageId, planPropagation, dedupeDispatches, dispatchKey,
  planKitDrain, deliveryKey, kitDispatchPrompt, DEFAULT_KIT_DRAIN,
  type KitChange, type ChangeClass, type KitConsumer, type Dispatch, type DispatchKind,
  type KitRail, type KitDelivery, type KitDrainConfig, type KitDrainPlan,
} from "./lib/propagation";
