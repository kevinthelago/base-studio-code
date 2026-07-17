// Small, self-contained UI atoms for the focused ProjectPane bodies (#1560, split verbatim out of
// FocusedBodies.tsx). Pure presentational components + the role / context-kind palettes they read.
// No state, no effects.
import "./projectPane.css";
import { StatTile } from "@/shared/ui/data/StatTile";
import { Box } from "@/shared/ui/layout/Box";

interface Role { c: string; label: string }

/* role palette */
export const ROLES: Record<string, Role> = {
  planner:  { c: "oklch(0.72 0.10 230)", label: "planner" },
  worker:   { c: "oklch(0.80 0.14 70)",  label: "worker" },
  reviewer: { c: "oklch(0.70 0.12 300)", label: "reviewer" },
  triage:   { c: "oklch(0.72 0.10 195)", label: "triage" },
  tester:   { c: "oklch(0.72 0.13 145)", label: "tester" },
  director: { c: "oklch(0.70 0.14 350)", label: "director" },
};

export const CTX_KIND: Record<string, string> = {
  spec:   "oklch(0.72 0.10 230)",
  claude: "oklch(0.80 0.14 70)",
  kb:     "oklch(0.70 0.12 300)",
  doc:    "oklch(0.66 0.06 200)",
};

/* primitives */
export function RoleChip({ role, mute }: { role: string; mute?: boolean }) {
  const R = ROLES[role] || { c: "var(--fg-dim)", label: role };
  return (
    <Box as="span" className="role" bg={`color-mix(in oklch, ${R.c}, transparent ${mute ? 90 : 84}%)`} style={{
      color: R.c, border: `1px solid color-mix(in oklch, ${R.c}, transparent 72%)`,
    }}>
      <i style={{ background: R.c }} />{R.label}
    </Box>
  );
}

export function Tile({ v, k }: { v: number | string; k: string }) {
  return <StatTile k={k} v={v} />;
}

export function KindDot({ kind }: { kind: string }) {
  return <Box as="span" bg={CTX_KIND[kind] || "var(--fg-dim)"} radius={2} style={{
    width: 6, height: 6, flex: "0 0 6px",
  }} />;
}

export function Seg({ options, value, onChange, tiny }: {
  options: string[]; value: string; onChange?: (v: string) => void; tiny?: boolean;
}) {
  return (
    <Box as="span" className="mono" border="soft" radius={5} style={{
      display: "inline-flex", overflow: "hidden",
      fontSize: tiny ? 9 : 9.5,
    }}>
      {options.map((o, i) => {
        const on = o === value;
        return (
          // eslint-disable-next-line no-restricted-syntax -- bespoke inline-styled segmented cell (local `Seg` primitive); SegmentedControl/.btn would change rendering
          <button key={o} onClick={() => onChange && onChange(o)} style={{
            border: 0, borderRight: i < options.length - 1 ? "1px solid var(--border-soft)" : 0,
            background: on ? "color-mix(in oklch, var(--accent), transparent 84%)" : "transparent",
            color: on ? "var(--accent)" : "var(--fg-dim)",
            padding: "2px 7px", cursor: "pointer", whiteSpace: "nowrap",
          }}>{o}</button>
        );
      })}
    </Box>
  );
}
