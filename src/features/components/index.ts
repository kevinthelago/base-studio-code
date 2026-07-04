// Public API of the components feature (#2269) — the proven-component library + its condensed pane.
export { ComponentLibraryPane } from "./ComponentLibraryPane";
export { createComponentsSlice, type ComponentsSlice } from "./store";
export {
  ROLE_COLOR, ROLES, matchesQuery, resolveComposes, resolveUsedBy,
  type ComponentRecord, type Kit, type PropSpec, type Role, type KitRule, type KitRuleKind,
} from "./lib/model";
export { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
// Kit lint rules → eslint preset (#2279) — the generator the planner bakes into a generated app.
export {
  deriveRules, mergeRules, kitRules, ruleMessage, toEslintRules, toEslintPreset, ESCAPE_HATCH,
  type EslintRulesConfig,
} from "./lib/rules";
