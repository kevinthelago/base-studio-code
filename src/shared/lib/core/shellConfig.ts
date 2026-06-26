// Console shell selection + persistence (#447).
//
// The host can launch agent sessions under a specific shell. This module owns
// the selectable shell catalog and the localStorage read/write for the user's
// choice — the I/O half split out of `diagnostics.ts` (#1711) so the verdict
// interpretation there stays pure and React/Tauri-free.
//
// Free of React/Tauri imports so it can be unit-tested and shared.

/**
 * A console shell the host can launch sessions under. `auto` defers to the
 * backend's `resolve_shell` fallback (Git Bash on Windows, login `$SHELL`
 * elsewhere); the explicit kinds force a specific shell. `powershell` and `cmd`
 * are Windows-only — the bsc-* helpers run with reduced functionality there
 * (see the backend's per-shell rc), surfaced in the selector.
 */
export type ShellKind = "auto" | "bash" | "powershell" | "cmd";

/** Selectable shells with a label and whether bsc-* helpers are fully supported. */
export const SHELL_OPTIONS: ReadonlyArray<{
  kind: ShellKind;
  label: string;
  /** False when the bsc-* helpers are degraded under this shell (#447). */
  helpersFull: boolean;
  note: string;
}> = [
  { kind: "auto",       label: "Auto (recommended)", helpersFull: true,  note: "Git Bash on Windows; login shell elsewhere." },
  { kind: "bash",       label: "Bash / Git Bash",    helpersFull: true,  note: "Full bsc-* helper support." },
  { kind: "powershell", label: "PowerShell",          helpersFull: false, note: "Windows only. bsc-* helpers run in degraded mode." },
  { kind: "cmd",        label: "Command Prompt",      helpersFull: false, note: "Windows only. bsc-* helpers run in degraded mode." },
];

/** The default shell selection when nothing is persisted. */
export const DEFAULT_SHELL: ShellKind = "auto";

const SHELL_KEY = "bsc.diagnostics.shell.v1";

/** Narrow an arbitrary string to a known `ShellKind`, falling back to `auto`. */
export function coerceShellKind(value: string | null | undefined): ShellKind {
  return SHELL_OPTIONS.some((o) => o.kind === value) ? (value as ShellKind) : DEFAULT_SHELL;
}

/**
 * Read the persisted console-shell selection. Safe to call in any environment —
 * returns the default when storage is unavailable (e.g. unit tests, SSR).
 */
export function loadShellKind(): ShellKind {
  try {
    return coerceShellKind(globalThis.localStorage?.getItem(SHELL_KEY));
  } catch {
    return DEFAULT_SHELL;
  }
}

/** Persist the console-shell selection. Best-effort; ignores storage failures. */
export function saveShellKind(kind: ShellKind): void {
  try {
    globalThis.localStorage?.setItem(SHELL_KEY, kind);
  } catch {
    /* storage unavailable — selection is also synced to the backend separately */
  }
}
