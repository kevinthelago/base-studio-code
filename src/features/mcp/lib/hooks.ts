// Hook model + per-session resolution + `.claude/settings.json` payload + catalog templates.
//
// A hook is a shell command Claude Code runs on a lifecycle event (PreToolUse, PostToolUse,
// Stop, …), optionally gated by a tool matcher. Pure (no React / Tauri) so it's shared by the
// store, the Hooks view, and TerminalView. Split out of the former unified `extensions.ts`.

/** A user-configured lifecycle hook. Scoped per-hook via {@link Hook.projects}. */
export interface Hook {
  id: string;
  name: string;
  enabled: boolean;
  /** `[]` = every project (global); otherwise the project ids it applies to. */
  projects: string[];
  event: string;       // PreToolUse | PostToolUse | Stop | …
  matcher?: string;    // optional tool matcher (regex)
  command: string;     // the shell command to run
  env?: Array<[string, string]>;
}

/**
 * The enabled hooks that apply to a session in `projectId`: a hook applies when it is enabled
 * AND either global (`projects` empty) or scoped to this project. An empty `projectId`
 * (no project) yields only global hooks.
 */
export function resolveHooks(all: Hook[], projectId: string): Hook[] {
  return all.filter(
    e => e.enabled && (e.projects.length === 0 || (!!projectId && e.projects.includes(projectId))),
  );
}

// ── Backend payload ───────────────────────────────────────────────────────────

export interface HookPayload {
  event: string;
  matcher: string;
  command: string;
}

/** POSIX single-quote escape: wrap in '…', and turn any embedded ' into '\''. Robust +
 *  portable (no base64) so the wrapper command can't be broken or injected by the name/cmd. */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * A hook → its settings.json payload, or null if incomplete.
 *
 * The user's command is wrapped with `bsc-hook '<name>' '<command>'` (#867 follow-up) so each
 * fire is logged to `~/.base-studio-code/hooks.log` for the Hook Analytics tab — `bsc-hook`
 * runs the command, records the outcome (PreToolUse block/allow), and propagates the exit
 * code. Only USER hooks pass through here; the security hooks are injected backend-side and
 * are never wrapped.
 */
export function toHookPayload(e: Hook): HookPayload | null {
  if (!e.event || !e.command) return null;
  const command = `bsc-hook ${shQuote(e.name || "hook")} ${shQuote(e.command)}`;
  return { event: e.event, matcher: e.matcher ?? "", command };
}

// ── Catalog templates ─────────────────────────────────────────────────────────

const HOOK_CATALOG_TEMPLATES: Record<string, Partial<Hook>> = {
  "Block PII":   { event: "PreToolUse",  matcher: "Write|Edit", command: "" },
  "Auto-format": { event: "PostToolUse", matcher: "Write|Edit", command: "" },
  // A `Stop` hook fires when the agent finishes its turn — no tool matcher applies (it's not a
  // tool event), so it's left unset. The command is the user's to fill in (notify / snapshot / …).
  "Session end": { event: "Stop", command: "" },
};

/** A ready-to-add hook (minus id) for a catalog entry — disabled + global by default. */
export function hookFromCatalog(name: string): Omit<Hook, "id"> {
  const t = HOOK_CATALOG_TEMPLATES[name] ?? { event: "PostToolUse", matcher: "", command: "" };
  return {
    name,
    enabled: false,
    projects: [],
    event: t.event ?? "PostToolUse",
    matcher: t.matcher,
    command: t.command ?? "",
  };
}

/** A blank custom hook, ready for the add-custom form. */
export function blankHook(): Omit<Hook, "id"> {
  return { name: "", enabled: false, projects: [], event: "PostToolUse", matcher: "", command: "" };
}

// ── System hooks (the always-on floor) ──────────────────────────────────────────

/** A read-only descriptor for an always-on system hook the app injects. VIEW-only — not editable. */
export interface SystemHook {
  name: string;
  event: string;
  /** One-line description of what this hook enforces. */
  purpose: string;
}

/**
 * The always-on PreToolUse security floor (#1916/#2050) the app injects into EVERY session
 * backend-side (`console/shell_rc`). Unlike user hooks these are never wrapped by `bsc-hook`, are
 * not toggleable or removable, and fire AND block under BOTH permission postures — the default
 * allow-list AND bypass, where `permissions.deny` is ignored but PreToolUse hooks still block. They
 * are the real running floor beneath any user hook, so the Hooks view lists them (VIEW-only —
 * these describe what runs; the user can't change them here). Kept in sync with the `bsc-*` rc
 * helpers' contract (`bsc-deny`/`bsc-confine`/`bsc-scope` in `src-tauri/src/console/shell_rc`).
 */
export const SYSTEM_HOOKS: SystemHook[] = [
  { name: "bsc-deny",    event: "PreToolUse", purpose: "Dangerous-command floor + role/user command denies — blocks the mutating git/gh and destructive commands a session's role can't run." },
  { name: "bsc-confine", event: "PreToolUse", purpose: "Filesystem confinement — blocks file-tool reads/writes that leave the session's repo root or touch its own .claude config." },
  { name: "bsc-scope",   event: "PreToolUse", purpose: "Write-scope — blocks file writes outside a worker's owned globs (and denies all writes for code:none roles)." },
];
