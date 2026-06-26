// Shared presentation helpers (#1471) — feature-agnostic, pure. Used by the GitHub and
// planner summaries. Extracted to remove byte-identical copies in ProjectsSummary +
// GitHubSummary.

/**
 * A coarse "time since" label from an ISO timestamp: `5s ago` / `3m ago` / `2h ago` /
 * `4d ago` / `2mo ago`. Returns "" for an empty, non-finite, or future timestamp.
 */
export function timeAgo(iso: string): string {
  return sinceLabel(iso, " ago");
}

/** Compact variant of {@link timeAgo} without the trailing " ago": `5s` / `4d` / `2mo`. */
export function timeAgoShort(iso: string): string {
  return sinceLabel(iso, "");
}

function sinceLabel(iso: string, suffix: string): string {
  if (!iso) return "";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (!isFinite(s) || s < 0) return "";
  if (s < 60) return `${s}s${suffix}`;
  const m = Math.floor(s / 60); if (m < 60) return `${m}m${suffix}`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h${suffix}`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d${suffix}`;
  return `${Math.floor(d / 30)}mo${suffix}`;
}

/** A coarse "time since" label from epoch millis; "—" when non-positive. */
export function timeAgoMs(ms: number): string {
  return ms > 0 ? timeAgo(new Date(ms).toISOString()) : "—";
}

/** A stable oklch color hashed from a login, so the same user always renders the same hue. */
export function loginColor(login: string): string {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return `oklch(0.68 0.12 ${h % 360})`;
}

/** A deterministic hue (0–359) hashed from a string — a tile/category accent. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}
