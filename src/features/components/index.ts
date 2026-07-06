// Public API of the components feature (#2269) — the proven-component library: the planner's
// project-scoped pane (#2314) and the full-page Design Studio workspace (#2308).
export { PlannerComponentsPane } from "./PlannerComponentsPane";
export { DesignStudio } from "./DesignStudio";
export { createComponentsSlice, type ComponentsSlice } from "./store";
export {
  ROLE_COLOR, ROLES, matchesQuery, resolveComposes, resolveUsedBy,
  type ComponentRecord, type Kit, type PropSpec, type Role, type KitRule, type KitRuleKind,
} from "./lib/model";
export { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
// Kit lint rules → eslint preset (#2279) — the generator the planner bakes into a generated app.
export {
  deriveRules, mergeRules, kitRules, componentRules, ruleMessage, toEslintRules, toEslintPreset, ESCAPE_HATCH,
  type EslintRulesConfig,
} from "./lib/rules";
// Kit-change propagation (#2277) — the fan-out decision spine (classify → plan dispatch to consumers)
// + the delivery drain (plan which dispatches to fire this cycle, and the per-rail messages).
export {
  classifyChange, makeChange, changeId, kitUsageId, planPropagation, dedupeDispatches, dispatchKey,
  planKitDrain, deliveryKey, kitDispatchPrompt, kitUpdateIssue, DEFAULT_KIT_DRAIN,
  type KitChange, type ChangeClass, type KitConsumer, type Dispatch, type DispatchKind,
  type KitRail, type KitDelivery, type KitDrainConfig, type KitDrainPlan,
} from "./lib/propagation";
