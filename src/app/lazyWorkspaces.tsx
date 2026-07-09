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
export const SecurityWorkspace      = lazy(() => import("@/features/security").then((m) => ({ default: m.SecurityWorkspace })));
export const GlanceWorkspace      = lazy(() => import("@/features/glance").then((m) => ({ default: m.GlanceWorkspace })));
// Design Studio (#2303/#2308) is no longer a rail Workspace — it moved into the Planner Screen as the
// "design" page (lazy-loaded there, in features/planner/index.tsx), so it's not lazy-mounted here.

/** Lightweight placeholder shown while a lazy screen's chunk loads. */
export function WorkspaceFallback() {
  return (
    <Row className="mono" justify="center" style={{ flex: 1, color: "var(--fg-dim)", fontSize: 12 }}>
      loading…
    </Row>
  );
}
