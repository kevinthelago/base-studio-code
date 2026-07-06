// Claude CLI install-on-first-run policy (#1277).
//
// Claude Code is Anthropic's PROPRIETARY CLI (npm `@anthropic-ai/claude-code`) — unlike `gh`
// (MIT) or the GPL PortableGit userland, we CANNOT freely repackage/redistribute it in our
// installer, and it auto-updates itself + needs the user's own auth (both of which fight a pinned
// bundled copy). So the pattern is: DETECT it, and on first run OFFER a consented `npm i -g`
// install (or guide the user) — we never ship Anthropic's bits in our bundle. `bsc-agent` stays the
// bundled agent (our Claude-independence lever, #1078).
//
// This module is the PURE policy — no React/Tauri imports — so it's unit-testable and shared. The
// actual consented-install execution (a Tauri command running the npm install, wired to a first-run
// prompt) is the deferred half of #1277; this defines exactly what that flow runs and says.

/** The npm package that provides the Claude CLI. */
export const CLAUDE_CLI_PKG = "@anthropic-ai/claude-code";

/** Official install/docs URL surfaced when we guide (rather than auto-install). */
export const CLAUDE_CLI_DOCS = "https://docs.claude.com/claude-code";

/** A consented first-run install descriptor for a CLI we install (not bundle). */
export interface FirstRunInstall {
  /** npm package that provides the CLI. */
  pkg: string;
  /** The exact command a consented first-run flow runs (global npm install). */
  command: string;
  /** Docs URL for manual guidance. */
  docsUrl: string;
}

/** The Claude CLI's first-run install descriptor. */
export const claudeFirstRunInstall: FirstRunInstall = {
  pkg: CLAUDE_CLI_PKG,
  command: `npm i -g ${CLAUDE_CLI_PKG}`,
  docsUrl: CLAUDE_CLI_DOCS,
};

/** What the first-run flow should do given detection results. */
export type ClaudeFirstRunAction =
  | { kind: "ready" } //                CLI present — nothing to do.
  | { kind: "offer-install"; command: string } // absent but npm present — offer the consented install.
  | { kind: "guide"; docsUrl: string }; //        absent and no npm — we can't install; point to docs.

/**
 * Decide the first-run action for the Claude CLI. Pure. We NEVER repackage Anthropic's CLI, so the
 * best we do is offer to install it from npm (with the user's consent) when npm is available, else
 * guide them to the official docs. `claudePresent`/`npmPresent` come from the host probe.
 */
export function claudeFirstRunAction(
  claudePresent: boolean,
  npmPresent: boolean,
): ClaudeFirstRunAction {
  if (claudePresent) return { kind: "ready" };
  if (npmPresent) return { kind: "offer-install", command: claudeFirstRunInstall.command };
  return { kind: "guide", docsUrl: claudeFirstRunInstall.docsUrl };
}
