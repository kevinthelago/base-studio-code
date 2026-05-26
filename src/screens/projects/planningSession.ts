// Pure helpers for the planner's section-by-section discovery loop.
//
// Free of React / xterm / Tauri imports so the tag parsing and message building
// can be unit-tested in isolation and shared with Planning.tsx.

// Quote-flexible class: straight ("), and curly (“ ”) so an LLM emitting smart
// quotes doesn't silently break tag detection. Mirrors the other planner tags.
const Q = '["“”]';

const PLAN_FOCUS_RE = () => new RegExp(`<plan_focus\\s+section=${Q}(\\w+)${Q}\\s*\\/>`, "g");

/**
 * Extract the section keys from every `<plan_focus section="key" />` tag in a
 * chunk of (ANSI-stripped) terminal output, in order of appearance. Returns []
 * when none are present.
 */
export function parsePlanFocus(text: string): string[] {
  const re = PLAN_FOCUS_RE();
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[1]);
  return out;
}

/** Remove every `<plan_focus>` tag from the buffer so it never prints in the terminal. */
export function stripPlanFocus(text: string): string {
  return text.replace(PLAN_FOCUS_RE(), "");
}

/**
 * The message injected into Claude's PTY when the user confirms a section in the
 * UI. It is the "advance to the next section" signal for the discovery loop.
 */
export function buildSectionConfirmMessage(sectionTitle: string): string {
  return `[The user confirmed the "${sectionTitle}" section in the planner UI — continue to the next section.]`;
}

export interface StartupScriptTag {
  /** Repo full_name (owner/name) the script belongs to. */
  repo: string;
  /** Which session the script kicks off: a dev console or a triage pass. */
  mode: "dev" | "triage";
  /** Path the planner wrote, relative to its project dir (e.g. prompts/web-kickoff.md). */
  path: string;
}

const STARTUP_SCRIPT_RE = () =>
  new RegExp(
    `<startup_script\\s+([^>]*?)\\/>`,
    "g",
  );

/**
 * Parse every `<startup_script repo="owner/repo" mode="dev|triage" path="..." />`
 * tag the planner emits to register a per-repo starting script. Attributes may
 * use straight or curly quotes and appear in any order. Tags missing a repo or
 * path, or with an unrecognized mode, are skipped.
 */
export function parseStartupScripts(text: string): StartupScriptTag[] {
  const re = STARTUP_SCRIPT_RE();
  const out: StartupScriptTag[] = [];
  const attr = (attrs: string, k: string) =>
    new RegExp(`\\b${k}=${Q}([^\\u0022\\u201c\\u201d]*)${Q}`).exec(attrs)?.[1];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const attrs = m[1];
    const repo = attr(attrs, "repo")?.trim();
    const path = attr(attrs, "path")?.trim();
    const mode = (attr(attrs, "mode")?.trim() ?? "dev").toLowerCase();
    if (repo && path && (mode === "dev" || mode === "triage")) {
      out.push({ repo, mode, path });
    }
  }
  return out;
}

/** Remove every `<startup_script>` tag so it never prints in the terminal. */
export function stripStartupScripts(text: string): string {
  return text.replace(STARTUP_SCRIPT_RE(), "");
}

/**
 * Build the unified-store relpath for a script the planner wrote to its project
 * dir. `sanitizedKey` is the on-disk project folder (sanitize_project_key). A
 * path already rooted at `projects/` is returned untouched; otherwise it is
 * resolved under the project hub. Backslashes are normalized to posix and any
 * leading slashes stripped so the result satisfies read_document's path guards.
 */
export function scriptDocRelpath(sanitizedKey: string, path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (clean.startsWith("projects/")) return clean;
  return `projects/${sanitizedKey}/${clean}`;
}

export interface AllowCommandTag {
  /** The shell command prefix to auto-approve (e.g. "cargo", "npm run"). */
  cmd: string;
  /** Repo full_name to scope it to, or null for the whole project. */
  repo: string | null;
}

// Tolerant of an optional self-closing slash (`/>` or `>`) so a missing slash
// doesn't drop the tag silently.
const ALLOW_COMMAND_RE = () => /<allow_command\s+([^>]*?)\/?>/g;

/**
 * Parse every `<allow_command cmd="cargo" [repo="owner/repo"] />` tag the planner
 * emits to add a command to the project's (or a repo's) allowlist. Attributes may
 * use straight or curly quotes and any order; `command=` is accepted as an alias
 * for `cmd=`. Tags missing the command are skipped; a missing/blank `repo` means
 * project scope.
 */
export function parseAllowCommands(text: string): AllowCommandTag[] {
  const re = ALLOW_COMMAND_RE();
  const out: AllowCommandTag[] = [];
  const attr = (attrs: string, k: string) =>
    new RegExp(`\\b${k}=${Q}([^\\u0022\\u201c\\u201d]*)${Q}`).exec(attrs)?.[1];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const cmd = (attr(m[1], "cmd") ?? attr(m[1], "command"))?.trim();
    const repo = attr(m[1], "repo")?.trim();
    if (cmd) out.push({ cmd, repo: repo || null });
  }
  return out;
}

/** Remove every `<allow_command>` tag so it never prints in the terminal. */
export function stripAllowCommands(text: string): string {
  return text.replace(ALLOW_COMMAND_RE(), "");
}
