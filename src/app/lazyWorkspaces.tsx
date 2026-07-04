import { lazy } from "react";
import { Row } from "@/shared/ui/layout/Row";

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
export const GlanceWorkspace      = lazy(() => import("@/features/glance").then((m) => ({ default: m.GlanceWorkspace })));
// Design Studio (#2303 workspace, #2308 page): the full-page component workbench — its own toolbar,
// resizable kits→components rail, Library/Graph center, and inspector. Distinct from the condensed
// `ComponentLibraryPane` (the Kickoff design) that lives in the planner's `test_ui` stage.
export const DesignWorkspace      = lazy(() => import("@/features/components").then((m) => ({ default: m.DesignStudio })));

/** Lightweight placeholder shown while a lazy screen's chunk loads. */
export function WorkspaceFallback() {
  return (
    <Row className="mono" justify="center" style={{ flex: 1, color: "var(--fg-dim)", fontSize: 12 }}>
      loading…
    </Row>
  );
}
