// kitChrome (#2420) — the small chrome bits Design Studio and the Planner Components pane both
// hand-rolled: the role-colored dot and the kit-switcher chip. Shared WITHIN the feature (the two
// surfaces are different densities of the same library, so the vocabulary must match).
import type { ReactNode, CSSProperties } from "react";
import { Box } from "@/shared/ui/layout/Box";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { ROLE_COLOR, type Role, type Kit } from "./lib/model";

/** The role-colored dot beside a component name. `glow` adds the soft ring (px) the studio's
 *  tree rows / inspector title use. */
export function RoleDot({ role, size = 8, glow, style }: { role: Role; size?: number; glow?: number; style?: CSSProperties }) {
  const color = ROLE_COLOR[role];
  return (
    <StatusDot
      color={color} size={size}
      style={{ ...(glow ? { boxShadow: `0 0 0 ${glow}px color-mix(in srgb, ${color} 22%, transparent)` } : {}), ...style }}
    />
  );
}

/** The kit-switcher chip: the kit's color swatch + name (+ optional trailing count). The two
 *  surfaces keep their own density via their CSS class (`ds-kitchip` / `pcp-kitchip`). */
export function KitChip({ kit, on, className, title, onClick, children }: {
  kit: Kit;
  on: boolean;
  /** The surface's chip class — `ds-kitchip` (studio toolbar) or `pcp-kitchip` (planner pane). */
  className: string;
  title?: string;
  onClick?: () => void;
  /** Optional trailing content (e.g. the studio's component count). */
  children?: ReactNode;
}) {
  return (
    <Box as="button" className={`${className}${on ? " on" : ""}`} title={title} onClick={onClick}>
      <ColorSwatch color={kit.dot} size={6} />{kit.name}{children}
    </Box>
  );
}
