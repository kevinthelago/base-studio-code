import { lazy } from "react";
import { Row } from "@/shared/ui/layout/Row";

// Lazy-loaded screens (#perf): only the Console is needed at boot. Each other screen's chunk
// loads on first navigation, keeping the heavy module graph (esp. the planner) off the cold
// startup path — both the dev transform and the production bundle. Shared by the shell's screen
// switcher and the detached-window renderer.
// GitHub renders FROM THE GRAPH (#3650, epic #3604) — the graph host mounts the authored `githubpage` node;
// the symbol name stays so App.tsx + DetachedWindow (which passes `pageOverride`) need no change.
export const GitHubWorkspace      = lazy(() => import("@/features/github").then((m) => ({ default: m.GitHubGraphHost })));
// Automations renders FROM THE GRAPH (#3642, epic #3604) — the graph host mounts the authored
// `automationspage` node; the symbol name stays so App.tsx + DetachedWindow (which passes `pageOverride`,
// forwarded through) need no change.
export const AutomationsWorkspace = lazy(() => import("@/features/automations").then((m) => ({ default: m.AutomationsGraphHost })));
// MCP renders FROM THE GRAPH (#3656, epic #3604) — the graph host mounts the authored `mcppage` node; the
// symbol name stays so App.tsx + DetachedWindow (which passes `pageOverride`) need no change.
export const McpWorkspace         = lazy(() => import("@/features/mcp").then((m) => ({ default: m.McpGraphHost })));
// Settings renders from the HAND-CODED pages. It was migrated to the graph in #3658, rolled back by
// preference in #3758, and the dormant graph path was DELETED in #4183 — a copy nobody renders only
// rots. If Settings returns to the graph, regenerate it from the files of that day.
export const SettingsWorkspace    = lazy(() => import("@/features/settings").then((m) => ({ default: m.SettingsWorkspace })));
export const ProjectsWorkspace    = lazy(() => import("@/features/planner").then((m) => ({ default: m.ProjectsWorkspace })));
// Skills renders FROM THE GRAPH (#3654, epic #3604) — the graph host mounts the authored `skillspage` node;
// the symbol name stays so App.tsx + DetachedWindow (which passes `pageOverride`) need no change.
export const SkillsWorkspace      = lazy(() => import("@/features/skills").then((m) => ({ default: m.SkillsGraphHost })));
// Security renders FROM THE GRAPH (#3646, epic #3604) — the graph host mounts the authored `securitypage`
// node; the symbol name stays so App.tsx + DetachedWindow (which passes `pageOverride`) need no change.
export const SecurityWorkspace      = lazy(() => import("@/features/security").then((m) => ({ default: m.SecurityGraphHost })));
export const GlanceWorkspace      = lazy(() => import("@/features/glance").then((m) => ({ default: m.GlanceWorkspace })));
// Design Studio (#2303/#2308) + the Algorithms knowledge graph (#2785) are no longer rail Workspaces —
// each moved into the Planner Screen as a page (lazy-loaded there, in features/planner/index.tsx), so
// neither is lazy-mounted here.

/** Lightweight placeholder shown while a lazy screen's chunk loads. */
export function WorkspaceFallback() {
  return (
    <Row className="mono" justify="center" style={{ flex: 1, color: "var(--fg-dim)", fontSize: 12 }}>
      loading…
    </Row>
  );
}
