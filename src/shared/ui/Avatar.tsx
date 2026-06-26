// A round GitHub user avatar (#1493) — the initial on a login-hashed color. Consolidates the
// byte-identical copies that lived in GitHubSummary / ProjectsSummary (summary feeds) and the
// palette/ring variant in the planner Issues / ProjectBoard assignee stacks.
//
// NOTE: the chart/fleet avatar with the `bot` ◆ glyph is a DIFFERENT component, kept in
// ui/charts/primitives.tsx — it renders agent glyphs, not GitHub logins.

import { loginColor } from "@/shared/lib/core/format";
import { avatarColor } from "@/shared/lib/github/colors";

interface AvatarProps {
  login: string;
  size?: number;
  /** Use the discrete AVATAR_PALETTE (assignee stacks) instead of the continuous loginColor hue. */
  palette?: boolean;
  /** The 1.5px canvas ring used so overlapping avatars read as separate disks. */
  bordered?: boolean;
  /** Horizontal offset — negative for overlapping assignee stacks. */
  ml?: number;
  /** Font size as a fraction of `size` (default 0.5; the assignee stacks use 0.56). */
  fontScale?: number;
}

export function Avatar({ login, size = 20, palette = false, bordered = false, ml, fontScale = 0.5 }: AvatarProps) {
  return (
    <span title={"@" + login} style={{
      width: size, height: size, borderRadius: "50%",
      background: palette ? avatarColor(login) : loginColor(login), color: "#1a120a",
      fontFamily: "var(--mono)", fontWeight: 700, fontSize: size * fontScale,
      display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
      ...(ml ? { marginLeft: ml } : {}),
      ...(bordered ? { border: "1.5px solid var(--bg-canvas)" } : {}),
    }}>{login[0]?.toUpperCase() ?? "?"}</span>
  );
}
