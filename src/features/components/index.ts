// Public API of the components feature (#2269) — the proven-component library + its condensed pane.
export { ComponentLibraryPane } from "./ComponentLibraryPane";
export { createComponentsSlice, type ComponentsSlice } from "./store";
export {
  ROLE_COLOR, ROLES, matchesQuery, resolveComposes, resolveUsedBy,
  type ComponentRecord, type Kit, type PropSpec, type Role,
} from "./lib/model";
export { SEED_COMPONENTS, SEED_KITS } from "./lib/seed";
