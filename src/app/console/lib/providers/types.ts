import type { FirstRunInstall } from "./providers/claudeInstall";
import type { LlmConfig } from "@/shared/lib/core/llmConfig";

export interface ProviderLaunchConfig {
  /** Optional model name, used by providers that accept a model arg (e.g. Ollama). */
  model?: string;
  /** Resolved LLM config (provider + model + key + base URL). Providers that map it to CLI flags /
   *  env (e.g. Aider's `--model` + key env) read it; others ignore it. (#1172) */
  llm?: LlmConfig;
  /** The composed startup prompt / kickoff to deliver to the CLI at launch (e.g. Aider's
   *  `--message`). Providers whose backend harness bakes the prompt (Claude / bsc-agent) don't use
   *  this — they receive it via `pty_create`'s `startupPrompt`. (#1172) */
  startupPrompt?: string;
  /** Files to load read-only at launch (e.g. Aider's `--read` for a worker's `CLAUDE.local.md`,
   *  since Aider does no ancestor-`CLAUDE.md` walk). (#1172) */
  readFiles?: string[];
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
  /**
   * Human-readable caveats surfaced in the pane menu when this provider is selected (#1172) — e.g.
   * Aider has no permission gate, no MCP, and limited status/cost telemetry. The app's role gate /
   * MCP assignment don't apply to such a provider, so the picker FLAGS it rather than silently
   * degrading. Absent ⇒ a full-parity provider (Claude / bsc-agent) with nothing to warn about.
   */
  limitations?: string[];
}
