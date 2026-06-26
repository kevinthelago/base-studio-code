// Shared GitHub display colors (#1492) — one home for the avatar palette and ProjectV2
// option colors that were copy-pasted byte-for-byte across the planner/github views
// (ProjectBoard, Issues, Insights). Feature-agnostic and pure.

/**
 * The discrete avatar palette. Distinct from the continuous-hue `loginColor` in
 * `core/format.ts`: this hashes a login into one of six fixed swatches, which the
 * planner/github board + issue views use for assignee/author avatars.
 */
export const AVATAR_PALETTE = [
  "oklch(0.7 0.13 30)", "oklch(0.7 0.10 220)", "oklch(0.68 0.13 145)",
  "oklch(0.7 0.12 290)", "oklch(0.7 0.14 50)", "oklch(0.65 0.08 195)",
];

/** A stable avatar color hashed from a login into {@link AVATAR_PALETTE}. */
export function avatarColor(login: string): string {
  let h = 0;
  for (const c of login) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length];
}

/** GitHub ProjectV2 single-select option color enum → CSS token. */
export const GH_OPTION_COLORS: Record<string, string> = {
  GRAY:   "var(--fg-dim)",
  BLUE:   "var(--info)",
  GREEN:  "var(--success)",
  YELLOW: "oklch(0.78 0.14 70)",
  ORANGE: "var(--accent)",
  RED:    "var(--danger)",
  PINK:   "oklch(0.7 0.18 340)",
  PURPLE: "oklch(0.68 0.13 290)",
};
