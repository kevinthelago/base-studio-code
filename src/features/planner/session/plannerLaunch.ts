// plannerLaunch — how the PLANNER session launches under the selected LLM provider / fleet harness.
//
// The planner is plan-only (role gate #219) and, like the fleet, can run on either Claude Code or the
// model-agnostic `bsc-agent` runtime (#1078). When the effective harness is bsc-agent — because the
// user chose it, OR because the provider is local/ollama which Claude Code can't drive — the planner
// launches `bsc-agent` with the SAME context, prompt, state, and permissions a Claude planner gets:
//   • context — `bsc-agent` composes its system prompt from the planning dir's CLAUDE.md chain +
//     CLAUDE.local.md + skills (compose_system), identical to what Claude Code loads.
//   • state   — the per-session BSC_* env (plan.db / data.db / skills.db + their CLIs) is wired by
//     pty_create's wire_bsc_env for every pane regardless of harness.
//   • prompt  — the planner intro is baked as the agent's task (BscAgentAdapter.launch_command).
//   • perms   — BSC_AGENT_PERMS carries the plan-only role gate (its analogue of the claude
//     settings.json deny rules), and BSC_AGENT_MCP the planner's MCP servers.
//
// Pure + React-free so both planner launch sites (initial mount + restart) share one definition.

import { resolveLlmConfig, bscAgentEnv, effectiveHarness } from "@/shared/lib/core/llmConfig";
import { roleCapability, bscAgentPerms } from "@/shared/lib/session/sessionRoles";
import { resolveAllInstalledMcp, toBscAgentMcp, toSessionPayloads } from "@/features/mcp";
import type { AppStore } from "@/store/types";

/** The harness-dependent fields of the planner's `pty_create` call. */
export interface PlannerLaunch {
  /** Console provider id passed to pty_create — `"bsc-agent"` selects the runtime + its session
   *  file; `undefined` keeps Claude Code, the default. */
  providerId?: string;
  /** The fallback init command (used only if no startup prompt is baked). */
  initCmd: string;
  /** GH token env plus, for bsc-agent, the BSC_AGENT_* provider/model/base-url/perms/MCP vars. */
  env: Record<string, string>;
  /** Whether the intro is suppressed on a resumed session (#1240). Claude keeps the fresh-only
   *  greeting; bsc-agent (a one-shot agent loop, not a REPL) always bakes the intro as its task. */
  startupPromptFreshOnly: boolean;
  /** Request conversation resume — only meaningful for bsc-agent (its $BSC_AGENT_SESSION continuity);
   *  the backend ANDs it with "history actually exists". */
  continueSession?: boolean;
}

/**
 * Resolve how the planner session launches for the current provider + fleet harness.
 *
 * @param s      the app-store snapshot (reads `llmProvider`, `fleetHarness`, `mcpServers`)
 * @param ghEnv  the GitHub token env already resolved for the planner (`GH_TOKEN` / `GITHUB_TOKEN`)
 */
export function plannerLaunchConfig(s: AppStore, ghEnv: Record<string, string>): PlannerLaunch {
  const harness = effectiveHarness(s.llmProvider, s.fleetHarness ?? "claude");
  if (harness !== "bsc-agent") {
    return {
      providerId: undefined,
      initCmd: "claude --continue 2>/dev/null || claude",
      env: ghEnv,
      startupPromptFreshOnly: true,
    };
  }
  // The planner sees every installed MCP server (#1054); pass them to the runtime as $BSC_AGENT_MCP.
  const plannerMcp = toSessionPayloads(resolveAllInstalledMcp(s.mcpServers), []).mcp;
  const bscMcp = toBscAgentMcp(plannerMcp);
  const env: Record<string, string> = {
    ...ghEnv,
    ...bscAgentEnv(resolveLlmConfig(s)),
    // Plan-only role gate (#219) for the bsc-agent runtime: deny code writes + the mutating git/gh
    // commands the planner role forbids — the runtime's analogue of the claude settings.json denies.
    BSC_AGENT_PERMS: JSON.stringify(bscAgentPerms(roleCapability("planner"))),
  };
  if (bscMcp.length > 0) env.BSC_AGENT_MCP = JSON.stringify(bscMcp);
  return {
    providerId: "bsc-agent",
    initCmd: "bsc-agent", // fallback only; the baked intro prompt always wins
    env,
    startupPromptFreshOnly: false,
    continueSession: true,
  };
}
