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

/**
 * A stable 32-bit unsigned hash of a string (`h = h*31 + charCode`, truncated to
 * uint32 each step). Deterministic, so the same string always hashes the same — the
 * shared core behind the continuous-hue color helpers ({@link loginColor} + the fleet
 * board's profile color). Callers map the hash to their own space (e.g. `% 360` for a hue).
 *
 * Note: `hueFor` (per-step `% 360`) and the discrete `avatarColor` (per-step `& 0xffff`)
 * use *different* reductions and are intentionally NOT built on this — they'd produce
 * different colors.
 */
export function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable oklch color hashed from a login, so the same user always renders the same hue. */
export function loginColor(login: string): string {
  return `oklch(0.68 0.12 ${hashString(login) % 360})`;
}

/** A deterministic hue (0–359) hashed from a string — a tile/category accent. */
export function hueFor(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

/** Human-readable byte size: `0 B` / `1.5 KB` / `2.3 GB` / `1.1 TB`. */
export function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/**
 * Truncate `s` with a `…` when it exceeds `max` characters (#2421 — the one home for the
 * five hand-rolled ellipsis chains).
 *
 * `keep` is how many characters survive before the ellipsis and defaults to `max` — the
 * "hard cap" shape (`s.slice(0, max) + "…"` only when longer, e.g. an issue body preview).
 * Pass a smaller `keep` for the "display budget" shape the label sites use, where the
 * truncated form must fit the same budget as the untruncated one (e.g. `truncate(s, 20, 18)`).
 */
export function truncate(s: string, max: number, keep = max): string {
  return s.length > max ? `${s.slice(0, keep)}…` : s;
}

/**
 * Kebab-case slug: lowercase, every run of non-alphanumerics collapsed to a single `-`,
 * edge dashes stripped, optionally capped at `max` characters (#2421 — the one home for the
 * planner/source/DesignStudio copies). Returns `""` for input with no alphanumerics — callers
 * that need a fallback apply their own (`slugify(x, 40) || "source"`).
 *
 * NOT {@link sanitizeProjectKey} (../core/projectPaths.ts): that mirrors the Rust backend
 * byte-for-byte (keeps case, `_` replacement, cap 80) and must not change; this is the
 * display/id kebab-case convention.
 *
 * Note: the cap is applied AFTER edge-stripping (matching every former copy), so a capped
 * slug can still end in a `-` when the cut lands on a word boundary.
 */
export function slugify(s: string, max?: number): string {
  const slug = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return max != null ? slug.slice(0, max) : slug;
}

/** Local wall-clock `HH:MM` (or `HH:MM:SS` with `{ seconds: true }`) for an epoch-ms
 *  timestamp; `—` for null (#2421 — automations' HH:MM + MCP Analytics' HH:MM:SS unified). */
export function fmtClock(ms: number | null, opts: { seconds?: boolean } = {}): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return opts.seconds ? `${hm}:${String(d.getSeconds()).padStart(2, "0")}` : hm;
}

/** Local `YYYY-MM-DD` for an epoch-ms timestamp — the daily-bucket key the telemetry
 *  aggregators and their charts share (#2421; was byte-identical in hook/mcp telemetry). */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
