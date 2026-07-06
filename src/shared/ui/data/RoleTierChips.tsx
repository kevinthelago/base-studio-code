// RoleTierChips (#2420) — a session role's capability tiers (git · github · code · net) as colored
// mono pills: the permission floor a persona/position inherits. Extracted from the duplicate pair
// (personas `RoleTiers` / org `TierChips`) so both features render the same clearance row.
import { Row } from "@/shared/ui/layout/Row";
import { Chip } from "@/shared/ui/data/Chip";
import { roleCapability, type SessionRole } from "@/shared/lib/session/sessionRoles";

/** Tier → pill color: write = accent (mutating), read = info, none = dim. */
const TIER_COLOR: Record<string, string> = { none: "var(--fg-dim)", read: "var(--info)", write: "var(--accent)" };

export interface RoleTierChipsProps {
  /** The session role whose capability floor to render. */
  role: SessionRole;
}

/** The four capability tiers of a role, as coloured pills — the permission floor a persona inherits. */
export function RoleTierChips({ role }: RoleTierChipsProps) {
  const cap = roleCapability(role);
  const tiers: [string, string][] = [["git", cap.git], ["github", cap.github], ["code", cap.code], ["net", cap.net]];
  return (
    <Row gap={5} wrap>
      {/* One template-literal text node — `{k} · {v}` renders three nodes, which breaks exact-text queries. */}
      {tiers.map(([k, v]) => <Chip key={k} color={TIER_COLOR[v] ?? "var(--fg-dim)"}>{`${k} · ${v}`}</Chip>)}
    </Row>
  );
}
