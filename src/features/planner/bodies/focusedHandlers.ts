// Shared handler/types for the focused phase bodies (#1757, split from FocusedBodies.tsx).
// These are imported by BOTH the per-body components AND the FocusedPhaseBody dispatcher, so they
// live in their own React-free module to avoid a dispatcher↔body import cycle. FocusedBodies.tsx
// re-exports them for back-compat (ProjectPane imports `AuthoringWiring` from there).
import type { Flow, McpServer, ProjectPaneData } from "@/features/planner/pane/projectPaneData";
import type { ModelId } from "@/app/console/lib/models";
import type { Topology } from "@/features/planner/relationship/relationshipGraph";
import type { DirectorDrive } from "@/features/planner/fleet/directorDrive";
import type { BlueprintSkillItem } from "@/features/planner/blueprints/blueprintSkills";
import type { McpLibraryItem } from "@/features/planner/blueprints/blueprintMcp";

export type SyncState = "idle" | "running" | "done" | "error";

/** The fleet/permissions handler set (#1640). Shared by the Permissions body and the merged Streams
 *  body that embeds it, and assembled once by the dispatcher so each case spreads it instead of
 *  re-threading the handlers by name. Per-stream model + flow only — the role decides the profile. */
export interface FleetHandlers {
  onFlow?: (streamId: string, flow: Flow) => void;
  onModel?: (streamId: string, model: ModelId | undefined) => void;
  /** Set the project's coordination topology (#…). */
  onTopology?: (t: Topology) => void;
  /** Set the director's drive mode (#…) — only meaningful when the topology routes through it. */
  onDirectorDrive?: (d: DirectorDrive) => void;
}

/** The MCP-stage handler set (#1640). Assembled once by the dispatcher (mapping the on*Mcp props to
 *  the body's verb names) so the `mcp` case spreads it instead of threading four handlers by name. */
export interface McpHandlers {
  onToggle?: (id: string) => void;
  onBuild?: (s: McpServer) => void;
  onAdd?: (input: string) => void;
  onRemove?: (id: string) => void;
}

/** Authoring config (#923) threaded from Planning — the live blueprint edits flow back via onChange
 *  (kept in sync with the planner's <blueprint> tag), plus the pickable libraries + publish. */
export interface AuthoringWiring {
  onChange: (bp: NonNullable<ProjectPaneData["authoredBlueprint"]>) => void;
  skillLibrary?: BlueprintSkillItem[];
  mcpLibrary?: McpLibraryItem[];
  onPublish: () => void;
  published: boolean;
}
