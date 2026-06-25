import type { ConsoleProvider } from "../types";

/**
 * The model-agnostic `bsc-agent` runtime (#1078) — our own agent shell that runs on any
 * configured LLM (Anthropic/OpenAI/Gemini/local). It ships as a bundled sidecar resolved via
 * `$BSC_AGENT_BIN` (set per-session in pty_create) and is launched through the `BscAgentAdapter`
 * harness, selected by this provider's id. Not Claude — it skips the `.claude/*` setup paths and
 * instead reads its provider/model/key/permissions from `BSC_AGENT_*` env (wired in TerminalView).
 */
export const bscAgentProvider: ConsoleProvider = {
  id: "bsc-agent",
  displayName: "bsc-agent (any LLM)",
  buildLaunchCmd: () => "bsc-agent",
  isClaude: false,
};
