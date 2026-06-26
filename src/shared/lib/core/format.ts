// Shared presentation helpers (#1471) — feature-agnostic, pure. Used by the GitHub and
// planner summaries. Extracted to remove byte-identical copies in ProjectsSummary +
// GitHubSummary.

/** A coarse "time since" label from an ISO timestamp: `5s ago` / `3m ago` / `2h ago` / `4d ago`. */
export function timeAgo(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** A stable oklch color hashed from a login, so the same user always renders the same hue. */
export function loginColor(login: string): string {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return `oklch(0.68 0.12 ${h % 360})`;
}
