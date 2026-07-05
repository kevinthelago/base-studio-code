import type { FirstRunInstall } from "./providers/claudeInstall";

export interface ProviderLaunchConfig {
  /** Optional model name, used by providers that accept a model arg (e.g. Ollama). */
  model?: string;
}

/**
 * A console provider defines how to launch an AI CLI inside a PTY pane.
 * Each provider is registered once in the global registry and selected per-pane.
 */
export interface ConsoleProvider {
  id: string;
  displayName: string;
  /** Build the shell command string to launch this provider. */
  buildLaunchCmd(config?: ProviderLaunchConfig): string;
  /**
   * Shell command used to check whether the binary is available, e.g. `which gemini`.
   * When set and the probe exits non-zero, the pane can surface a missing-binary warning.
   */
  prereqProbe?: string;
  /**
   * True only for the Claude provider. Controls whether session setup paths specific
   * to Claude (ensure_session_settings, github_readiness, gateClaudeLaunch, startup-prompt
   * baking) are engaged. Absent/false → bare shell launch without Claude-specific wiring.
   */
  isClaude?: boolean;
  /**
   * For a proprietary CLI we install-on-first-run rather than bundle (#1277 — Claude Code): the
   * consented `npm i -g` descriptor a first-run flow uses when `prereqProbe` reports the CLI absent.
   * Absent for bundled/self-contained providers (e.g. `bsc-agent`).
   */
  firstRunInstall?: FirstRunInstall;
}
