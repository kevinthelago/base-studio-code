// The app's NOTICE registry (#54) — the one list the banner stack and `bsc navigate dismiss` share.
//
// Every banner in `AppBanners.tsx` hides itself through its own local `useState`, which is fine for a
// human with a mouse and unreachable for a session driving the app from a shell. A designer session hit
// this with two notices it could see in a capture and had no way to clear.
//
// The ids live HERE rather than as strings at each dismiss site so the CLI cannot drift from the UI: a
// banner renamed without updating this list fails the registry test, instead of silently becoming
// un-dismissable the next time someone reaches for it.

/** A notice the app can show, and whether clearing it would decide something on the user's behalf. */
export interface NoticeDef {
  id: string;
  /** What it tells the user — the `bsc navigate dismiss --list` line. */
  label: string;
  /**
   * Does this notice ask a QUESTION whose answer is lost if it is hidden?
   *
   * `session-recovery` asks "3 sessions found on disk that aren't open — restore or discard?". Hiding it
   * does not answer it; it removes the only place the answer could be given, and those sessions stay
   * unrestored with nothing on screen to say so. So a decision-bearing notice is never cleared by a
   * blanket dismiss and is REFUSED by name — choosing for the user is worse than leaving the banner up,
   * which is the whole reason this flag exists rather than a plain id list.
   */
  decision?: true;
}

/** Every dismissable notice, in the order `AppBanners` stacks them. */
export const NOTICES: readonly NoticeDef[] = [
  { id: "kit-changes", label: "a packaged kit changed since you last synced" },
  { id: "seed-drift", label: "rendered modules do not match their source file" },
  { id: "crash-recovery", label: "the app did not shut down cleanly" },
  { id: "interrupted-loop", label: "a designer loop was interrupted mid-run" },
  { id: "session-recovery", label: "sessions found on disk that aren't open — restore or discard?", decision: true },
  { id: "quarantine", label: "a worker was quarantined" },
  { id: "sandbox-setup", label: "the WSL sandbox is not provisioned" },
  { id: "project-complete", label: "a project finished its build" },
  { id: "path-expose", label: "`bsc` is not on your PATH" },
];

const BY_ID = new Map(NOTICES.map((n) => [n.id, n]));

/** Is `id` a notice this app knows how to show? */
export function isNotice(id: string): boolean {
  return BY_ID.has(id);
}

/** The notices a blanket `dismiss all` clears — everything that does not ask a question. */
export function blanketDismissable(): string[] {
  return NOTICES.filter((n) => !n.decision).map((n) => n.id);
}

/** Why `id` cannot be dismissed, or `null` when it can. Pure, so both the bridge and its tests use it. */
export function refuseDismissal(id: string): string | null {
  const n = BY_ID.get(id);
  if (!n) return `unknown notice '${id}' — one of: ${NOTICES.map((x) => x.id).join(", ")}`;
  if (n.decision) {
    return `'${id}' asks a question ("${n.label}") — dismissing it would not answer it, it would remove ` +
      `the only place the answer can be given. Act on it in the app instead.`;
  }
  return null;
}
