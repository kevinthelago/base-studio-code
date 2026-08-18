// The security feature's PUBLIC API — re-exports only, plus the stylesheet the page needs.
//
// The Agents screen itself (#236, made real in #255; tab bodies split out in #1643) is the
// `securitypage` RECORD, mounted by SecurityGraphHost — which is what `lazyWorkspaces` resolves
// the `SecurityWorkspace` symbol to, in both App.tsx and DetachedWindow. The copy that used to
// live in this file was a dead duplicate: nothing imported it. Removing it left no JSX, hence .ts.
//
// What the screen DOES is unchanged: profiles + assignments persist in the store and are ENFORCED
// at session launch via profileEnforcement → ensure_session_settings (the same gate as the role
// model); shell allowlists resolve additively (guaranteed ∪ profile ∪ project ∪ repo), gh/git are
// guaranteed, and a profile layers a base policy + per-tool tri-states + path scope. Data model +
// helpers live in ./lib; the four tab bodies in ./{Profiles,Assignments,Activity,Flow}Tab.

// The graph-hosted workspace (#3646) — App.tsx/DetachedWindow render this via the lazy SecurityWorkspace.
export { SecurityGraphHost } from "@/features/security/SecurityGraphHost";

// Re-exported for tests + back-compat: the pane-profile picker + app-session label
// helpers used to live here; they moved to ./AssignmentsTab and ./lib/appSession (#1643).
export { ProfileSelect } from "@/features/security/AssignmentsTab";
export { appSessionTag, appSessionOpenLabel, appReachNote } from "@/features/security/lib/appSession";

// #1545: public API for cross-feature consumers (planner, app/console, tunnel projector).
export { type AgentProfile, type Tier, type ToolKey, type ConsoleSession, type ConsolePane, APP_ROLES, PROFILES } from "./lib/agentProfiles";
export { resolveProfileSettings } from "@/features/security/lib/profileEnforcement";
export { parseAuditLog, type AuditRecord } from "@/features/security/lib/auditLog";
// #3754: the tunnel `security` projection derives its consoles + audit display rows the SAME way the
// desktop Security page does — one source of truth for the pane→console join and the allow/ask/block verdict.
export { deriveConsoles } from "@/features/security/lib/consoleModel";
export { buildAuditRows, type AuditDisplayRow } from "@/features/security/lib/auditRows";


// The Agents SCREEN is not here — it is the `securitypage` RECORD, mounted by `SecurityGraphHost`,
// which is what `lazyWorkspaces` resolves `SecurityWorkspace` to. Both shells already render the
// graph copy, so the duplicate that used to sit here was dead code: nothing imported it. What
// remains is the feature's public API — re-exports only, hence .ts rather than .tsx.
