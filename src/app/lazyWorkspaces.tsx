import { lazy } from "react";

// Lazy-loaded screens (#perf): only the Console is needed at boot. Each other screen's chunk
// loads on first navigation, keeping the heavy module graph (esp. the planner) off the cold
// startup path — both the dev transform and the production bundle. Shared by the shell's screen
// switcher and the detached-window renderer.
export const GitHubWorkspace      = lazy(() => import("@/features/github").then((m) => ({ default: m.GitHubWorkspace })));
export const AutomationsWorkspace = lazy(() => import("@/features/automations").then((m) => ({ default: m.AutomationsWorkspace })));
export const McpWorkspace         = lazy(() => import("@/features/mcp").then((m) => ({ default: m.McpWorkspace })));
export const SettingsWorkspace    = lazy(() => import("@/features/settings").then((m) => ({ default: m.SettingsWorkspace })));
export const ProjectsWorkspace    = lazy(() => import("@/features/planner").then((m) => ({ default: m.ProjectsWorkspace })));
export const SkillsWorkspace      = lazy(() => import("@/features/skills").then((m) => ({ default: m.SkillsWorkspace })));
export const AgentsWorkspace      = lazy(() => import("@/features/agents").then((m) => ({ default: m.AgentsWorkspace })));

/** Lightweight placeholder shown while a lazy screen's chunk loads. */
export function WorkspaceFallback() {
  return (
    <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
      loading…
    </div>
  );
}
