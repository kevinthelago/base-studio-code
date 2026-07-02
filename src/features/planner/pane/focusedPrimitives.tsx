// Small, self-contained UI atoms for the focused ProjectPane bodies (#1560, split verbatim out of
// FocusedBodies.tsx). Pure presentational components + the role / capability / context-kind palettes
// they read. No state, no effects.
import type { Posture, Perm, Flow, Agent } from "./projectPaneData";
import "./projectPane.css";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";
import { Box } from "@/shared/ui/layout/Box";

interface Role { c: string; label: string }
interface Cap { k: string; g: string; label: string }

/* role palette + caps */
export const ROLES: Record<string, Role> = {
  planner:  { c: "oklch(0.72 0.10 230)", label: "planner" },
  worker:   { c: "oklch(0.80 0.14 70)",  label: "worker" },
  reviewer: { c: "oklch(0.70 0.12 300)", label: "reviewer" },
  triage:   { c: "oklch(0.72 0.10 195)", label: "triage" },
  tester:   { c: "oklch(0.72 0.13 145)", label: "tester" },
  director: { c: "oklch(0.70 0.14 350)", label: "director" },
};

export const CAPS: Cap[] = [
  { k: "read",   g: "R", label: "read files" },
  { k: "edit",   g: "E", label: "edit files" },
  { k: "create", g: "C", label: "create & delete" },
  { k: "run",    g: "$", label: "run commands" },
  { k: "net",    g: "N", label: "network" },
  { k: "push",   g: "⇡", label: "commit & push" },
  { k: "pkg",    g: "P", label: "install packages" },
];

export const CTX_KIND: Record<string, string> = {
  spec:   "oklch(0.72 0.10 230)",
  claude: "oklch(0.80 0.14 70)",
  kb:     "oklch(0.70 0.12 300)",
  doc:    "oklch(0.66 0.06 200)",
};

/* primitives */
export function Dot({ s }: { s: string }) {
  return <Box as="span" className={"sdot " + s} />;
}

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

export function Avatar({ id, sz = 17, agents = [] }: { id: string; sz?: number; agents?: Agent[] }) {
  const a = agents.find((x) => x.id === id);
  const color = a ? a.color : "var(--fg-dim)";
  const initial = a ? a.initial : "?";
  return <Box as="span" className="av" bg={color} style={{ width: sz, height: sz, fontSize: sz * 0.53 }}>{initial}</Box>;
}

export function PostureBar({ perm }: { perm: Perm }) {
  return (
    <Box as="span" className="posture" title="read · edit · create · run · net · push · pkg">
      {CAPS.map((c) => (
        <i key={c.k} className={perm[c.k]} title={`${c.label}: ${perm[c.k]}`} />
      ))}
    </Box>
  );
}

export function Tri({ value, onChange }: { value: Posture; onChange?: (v: Posture) => void }) {
  return (
    <SegmentedControl
      variant="joined"
      options={(["allow", "ask", "deny"] as Posture[]).map((v) => ({
        label: v,
        on: value === v,
        onClick: () => onChange && onChange(v),
        tone: v,
      }))}
    />
  );
}

export function FlowBadges({ flow }: { flow: Flow }) {
  return (
    <Box as="span" style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      <Box as="span" className="fbadge" title="autonomy">{flow.autonomy}</Box>
      <Box as="span" className="fbadge" title="push policy">{flow.push}</Box>
      <Box as="span" className={"fbadge" + (flow.gate === "hard" ? " hard" : "")} title="enforcement gate">
        {flow.gate} gate
      </Box>
    </Box>
  );
}

export function Tile({ v, k }: { v: number | string; k: string }) {
  return (
    <Box className="tile">
      <Box className="v">{v}</Box>
      <Box className="k">{k}</Box>
    </Box>
  );
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
