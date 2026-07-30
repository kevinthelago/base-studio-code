// Role-scoped session capabilities (#219) — least-privilege per session type. A
// session's abilities are bounded by its ROLE, so the planner can shape the plan but
// can't mutate the repo or GitHub, and any out-of-scope action is blocked (or
// escalated to an explicit user confirmation) rather than run freely.
//
// This is the pure enforcement core (command classification + path scoping); the
// gate that USES it is the role's denied-command set plus a write-path guard on the
// write tool, applied alongside the per-agent profile (#1457). Free of React / xterm /
// Tauri imports so it's unit-testable in isolation.
//
// This file is the PUBLIC BARREL (#2151): the enforcement core was decomposed into colocated,
// concern-scoped modules, layered types/data ← rules ← derivations to avoid cycles —
//   - `roleModel.ts`   — types (SessionRole/AccessTier/RoleCapability) + the externalized
//                        role→capability data (ROLE_DEFAULTS + the write-glob / db-owned /
//                        dep-manifest lists) + core accessors (roleCapability, hasScopedWriteCarveOut).
//   - `commandGate.ts` — command classification (classifyCommand) + the role command check (checkCommand).
//   - `writeScope.ts`  — glob matching (matchGlob) + write-path/boundary scoping (canWritePath, scopeWriteGlobs).
//   - `launchRules.ts` — launch wiring: write-tool rules (roleWriteRules), whole-tool denies
//                        (roleDeniedTools), command-prefix denies (roleDeniedCommands), and the
//                        bsc-agent-native permission doc (bscAgentPerms).
// The full public API is re-exported here unchanged, so every importer keeps working.
//
// The role→capability TABLE + the write-glob / db-owned / dep-manifest lists are externalized to
// `@data/permissions/role-capabilities.json` (#2027 P1) — the single source (Rust does NOT duplicate
// it: TS computes each session's permissions here and passes them to `ensure_session_settings`).

export type { SessionRole, AccessTier, RoleCapability } from "./roleModel";
export {
  ROLE_DEFAULTS,
  PLANNER_WRITE_GLOBS,
  DOC_GLOBS,
  DB_OWNED_PLAN_FILES,
  DEP_MANIFEST_FILES,
  roleCapability,
  hasScopedWriteCarveOut,
  restrictedRoleCommands,
  mayFileToolingRequest,
  TOOLING_REQUEST_COMMAND,
  isRestrictedRole, HARVEST_ROOT_APP_REPO, HARVEST_ROOT_PROJECTS,
} from "./roleModel";

export type { CommandClass, CommandDecision } from "./commandGate";
export { classifyCommand, checkCommand } from "./commandGate";

export { matchGlob, canWritePath, scopeWriteGlobs } from "./writeScope";

export type { ToolPermissionRules, BscAgentPerms } from "./launchRules";
export {
  roleWriteRules,
  roleDeniedTools,
  roleDeniedCommands,
  bscAgentPerms,
  sessionScopes,
  editPathRule,
} from "./launchRules";
