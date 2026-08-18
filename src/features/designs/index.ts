// The shadow catalogue registers this feature's graph-platform modules by importing
// `./graphPlatform` DIRECTLY and calling its register function (see `shadowPages.ts`). This barrel
// therefore has NO import-time side effect — it is re-exports only, which is what lets it be a
// record rather than a file that must run to be correct.

// Public API of the components feature (#2269) — the proven-component library: the planner's
// project-scoped pane (#2314) and the full-page Design Studio workspace (#2308).
export { PlannerComponentsPane } from "@/features/designs/PlannerComponentsPane";
export { DesignsWorkbench } from "@/features/designs/DesignsWorkbench";
// #2658: the blueprint-download reconciliation confirm-list (generate + register missing categories).
export { DesignReconcileModal, type DesignReconcileModalProps } from "@/features/designs/DesignReconcileModal";
export { generateCategoryColors } from "@/features/designs/lib/designGenBridge";
export { createComponentsSlice, type ComponentsSlice } from "./store";
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
} from "@/features/designs/lib/analyticsEmit";
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
} from "@/features/designs/lib/libraryComposition";
// Kit lint rules → eslint preset (#2279) — the generator the planner bakes into a generated app.
export {
  deriveRules, mergeRules, kitRules, componentRules, ruleMessage, toEslintRules, toEslintPreset, ESCAPE_HATCH,
  type EslintRulesConfig,
} from "@/features/designs/lib/rules";
// Kit-change propagation (#2277) — the fan-out decision spine (classify → plan dispatch to consumers)
// + the delivery drain (plan which dispatches to fire this cycle, and the per-rail messages).
export {
  classifyChange, makeChange, changeId, kitUsageId, planPropagation, dedupeDispatches, dispatchKey,
  planKitDrain, deliveryKey, kitDispatchPrompt, DEFAULT_KIT_DRAIN,
  type KitChange, type ChangeClass, type KitConsumer, type Dispatch, type DispatchKind,
  type KitRail, type KitDelivery, type KitDrainConfig, type KitDrainPlan,
} from "@/features/designs/lib/propagation";
