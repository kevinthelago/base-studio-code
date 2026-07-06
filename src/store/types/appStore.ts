// The composed AppStore interface (#1634). It `extends` the per-feature slice interfaces
// (Skills/Mcp/Automations/Github/Tunnel — owned by their features) AND the per-domain core-state
// interfaces split out of the former monolith. Composition model is unchanged: every field still
// lives on AppStore; it is just sourced from focused per-domain modules.
//
// Where the rest lives:
//  - GitHub connection state    → GithubSlice    (@/features/github/store)
//  - Mobile tunnel state        → TunnelSlice    (@/features/tunnel/store)
//  - Automations CRUD           → AutomationsSlice (@/features/automations/store)
//  - MCP servers + hooks        → McpSlice       (@/features/mcp/store)
//  - Skills library/groups      → SkillsSlice    (@/features/skills/store)
import type { McpSlice } from "@/features/mcp/store";
import type { PersonasSlice } from "@/features/personas/store";
import type { OrgSlice } from "@/features/org/store";
import type { ComponentsSlice } from "@/features/components/store";
import type { SkillsSlice } from "@/features/skills/store";
import type { AutomationsSlice } from "@/features/automations/store";
import type { GithubSlice } from "@/features/github/store";
import type { TunnelSlice } from "@/features/tunnel/store";
import type { ConsoleState } from "./console";
import type { ShellState } from "./shell";
import type { LlmState } from "./llm";
import type { ProjectsState } from "./projects";
import type { PlanState } from "./plan";
import type { SessionState } from "./session";

export interface AppStore
  extends SkillsSlice,
    PersonasSlice,
    OrgSlice,
    ComponentsSlice,
    McpSlice,
    AutomationsSlice,
    GithubSlice,
    TunnelSlice,
    ConsoleState,
    ShellState,
    LlmState,
    ProjectsState,
    PlanState,
    SessionState {}
