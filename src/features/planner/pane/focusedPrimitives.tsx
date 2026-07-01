// Small, self-contained UI atoms for the focused ProjectPane bodies (#1560, split verbatim out of
// FocusedBodies.tsx). Pure presentational components + the role / capability / context-kind palettes
// they read. No state, no effects.
import type { Posture, Perm, Flow, Agent } from "./projectPaneData";
import "./projectPane.css";
import { SegmentedControl } from "@/shared/ui/controls/SegmentedControl";

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
  return <span className={"sdot " + s} />;
}

export function RoleChip({ role, mute }: { role: string; mute?: boolean }) {
  const R = ROLES[role] || { c: "var(--fg-dim)", label: role };
  return (
    <span className="role" style={{
      background: `color-mix(in oklch, ${R.c}, transparent ${mute ? 90 : 84}%)`,
      color: R.c, border: `1px solid color-mix(in oklch, ${R.c}, transparent 72%)`,
    }}>
      <i style={{ background: R.c }} />{R.label}
    </span>
  );
}

export function Avatar({ id, sz = 17, agents = [] }: { id: string; sz?: number; agents?: Agent[] }) {
  const a = agents.find((x) => x.id === id);
  const color = a ? a.color : "var(--fg-dim)";
  const initial = a ? a.initial : "?";
  return <span className="av" style={{ width: sz, height: sz, background: color, fontSize: sz * 0.53 }}>{initial}</span>;
}

export function PostureBar({ perm }: { perm: Perm }) {
  return (
    <span className="posture" title="read · edit · create · run · net · push · pkg">
      {CAPS.map((c) => (
        <i key={c.k} className={perm[c.k]} title={`${c.label}: ${perm[c.k]}`} />
      ))}
    </span>
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
    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
      <span className="fbadge" title="autonomy">{flow.autonomy}</span>
      <span className="fbadge" title="push policy">{flow.push}</span>
      <span className={"fbadge" + (flow.gate === "hard" ? " hard" : "")} title="enforcement gate">
        {flow.gate} gate
      </span>
    </span>
  );
}

export function Tile({ v, k }: { v: number | string; k: string }) {
  return (
    <div className="tile">
      <div className="v">{v}</div>
      <div className="k">{k}</div>
    </div>
  );
}

export function KindDot({ kind }: { kind: string }) {
  return <span style={{
    width: 6, height: 6, borderRadius: 2, flex: "0 0 6px",
    background: CTX_KIND[kind] || "var(--fg-dim)",
  }} />;
}

export function Seg({ options, value, onChange, tiny }: {
  options: string[]; value: string; onChange?: (v: string) => void; tiny?: boolean;
}) {
  return (
    <span className="mono" style={{
      display: "inline-flex", border: "1px solid var(--border-soft)",
      borderRadius: 5, overflow: "hidden",
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
    </span>
  );
}
