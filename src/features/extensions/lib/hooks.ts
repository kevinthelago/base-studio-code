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
