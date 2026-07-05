import type { ConsoleProvider, ProviderLaunchConfig } from "../types";
import type { FirstRunInstall } from "./claudeInstall";
import { aiderModelArg } from "@/shared/lib/core/llmConfig";

// Aider — a first-class console provider (#1172). Unlike Claude Code / bsc-agent (which bake the
// prompt and read config from the backend harness), Aider is a plain CLI launched via its own
// init command, so ALL of its configuration — model, task, fleet-safe git, worker context — is
// composed into the launch command here (the matching API-key env comes from `aiderEnv`, wired in
// sessionLaunch.buildAgentEnv).

/** Aider is a Python CLI installed from PyPI (`pip install aider-chat`) — not bundled (like `gh`) and
 *  not an npm package (like Claude Code). We DETECT it and, on first run, guide/offer the pip install
 *  rather than shipping it. The descriptor is provider-agnostic (a free-form `command`), so the pip
 *  invocation reuses the same {@link FirstRunInstall} shape the Claude CLI first-run flow consumes. */
export const aiderFirstRunInstall: FirstRunInstall = {
  pkg: "aider-chat",
  command: "python -m pip install aider-chat",
  docsUrl: "https://aider.chat/docs/install.html",
};

/** POSIX single-quote a shell argument (wrap in '…', escaping embedded quotes). Newlines survive
 *  inside single quotes, so a multi-line kickoff passes through `--message` intact. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build Aider's launch command from the pane's resolved config (#1172) — first-class parity with the
 * sibling providers:
 *  - **LLM config** → `--model <aiderModelArg>` (the matching API-key env is injected separately by
 *    `aiderEnv`). When no `llm` is supplied, a bare `model` string is honored; with neither, Aider
 *    falls back to its own default.
 *  - **Fleet-safe git** → ALWAYS `--no-auto-commits --no-dirty-commits`. Aider auto-commits after
 *    every successful edit (and commits pre-existing dirty changes) by default, which fights the
 *    fleet's worktree/branch flow — the worker opens a PR, the director merges (#1948). Disabling
 *    both keeps commits/PRs owned by the app's per-agent flow (#297). Aider never auto-pushes, so no
 *    push flag is needed; the fleet's push policy stays the sole authority over `git push`.
 *  - **Worker context** → `--read <file>` loads the plan scope read-only (Aider does no ancestor-
 *    `CLAUDE.md` walk, so a worker's `CLAUDE.local.md` must be handed to it explicitly).
 *  - **Task delivery** → `--message <prompt>` submits the kickoff, the analogue of Claude's baked
 *    initial message. NOTE: `--message` is one-shot — Aider processes the reply then exits — the
 *    closest flag Aider offers for delivering a startup task.
 */
export function buildAiderCommand(config?: ProviderLaunchConfig): string {
  // Fleet-safe git by DEFAULT — every Aider session (manual or fleet) starts with auto-commit off so
  // it never makes a surprise commit on the pane's branch.
  const parts = ["aider", "--no-auto-commits", "--no-dirty-commits"];
  const model = config?.llm ? aiderModelArg(config.llm) : config?.model;
  if (model && model.trim()) parts.push("--model", shQuote(model));
  for (const f of config?.readFiles ?? []) parts.push("--read", shQuote(f));
  const prompt = config?.startupPrompt;
  if (prompt && prompt.trim()) parts.push("--message", shQuote(prompt));
  return parts.join(" ");
}

export const aiderProvider: ConsoleProvider = {
  id: "aider",
  displayName: "Aider",
  buildLaunchCmd: buildAiderCommand,
  prereqProbe: "which aider",
  firstRunInstall: aiderFirstRunInstall,
  // Surfaced in the pane menu (#1172): Aider has no Claude-Code-style permission gate and no MCP, so
  // the role gate / write-scope hooks and MCP assignment don't apply, and it emits none of the OSC
  // status / transcript signals the app uses for run-idle + cost accounting.
  limitations: [
    "No permission gate — the role gate & write-scope hooks don't apply.",
    "No MCP support.",
    "Limited status/cost telemetry (no run/idle or token signals).",
  ],
};
