// The plan-injection provenance banner (#1107). Surfaces the markers the deterministic scan flagged
// in the planner's authored sections, at the planning pane's top, so the user reviews them before
// the plan seeds the fleet. Acknowledge-to-clear by default; the hard-gate setting turns the ack off
// and demands the flagged content be removed.

import { type InjectionGate, injectionSignature } from "../lib/planInjection";

const MONO = "var(--mono)";
const CAT_LABEL: Record<string, string> = {
  override: "instruction override", exfiltration: "exfiltration",
  perms: "permission bypass", destructive: "destructive git/gh", ci: "CI / hook tampering",
};

export function InjectionGateBanner({ gate, onAcknowledge }: {
  gate: InjectionGate;
  onAcknowledge: (signature: string) => void;
}) {
  if (gate.findings.length === 0) return null;
  const blocked = gate.mode === "blocked";
  const cleared = gate.cleared;
  const color = blocked ? "var(--danger)" : cleared ? "var(--success)" : "var(--accent)";
  const n = gate.findings.length;

  return (
    <div data-testid="injection-banner" style={{
      flex: "0 0 auto", margin: "10px 12px 0", borderRadius: "var(--r-md)", overflow: "hidden",
      border: `1px solid color-mix(in oklch, ${color}, transparent 60%)`,
      background: `color-mix(in oklch, ${color}, transparent 90%)`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px" }}>
        <span style={{ fontSize: 13, color }}>{blocked ? "⛔" : cleared ? "✓" : "⚠"}</span>
        <span style={{ fontFamily: MONO, fontSize: 11, color, fontWeight: 600 }}>
          {n} possible prompt-injection marker{n !== 1 ? "s" : ""} in the plan
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>
          {blocked ? "hard-block" : cleared ? "reviewed" : "review to publish"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4, padding: "0 11px 9px", maxHeight: 160, overflowY: "auto" }}>
        {gate.findings.map((f, i) => (
          <div key={`${f.file}-${f.line}-${i}`} style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-muted)", lineHeight: 1.45 }}>
            <span style={{ color: "var(--info)" }}>{f.file}:{f.line}</span>
            {" · "}<span style={{ color }}>{CAT_LABEL[f.category] ?? f.category}</span>
            <div style={{ color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{f.context}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 11px", borderTop: `1px solid color-mix(in oklch, ${color}, transparent 70%)` }}>
        <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)", flex: 1, lineHeight: 1.5 }}>
          {blocked
            ? "These read like instructions injected from reviewed content. Remove them from the plan to publish (hard-block is on in Settings)."
            : "Confirm none of these is an instruction smuggled in from a reviewed repo or page before it seeds the fleet."}
        </span>
        {!blocked && !cleared && (
          <button
            data-testid="injection-ack"
            onClick={() => onAcknowledge(injectionSignature(gate.findings))}
            style={{
              flex: "0 0 auto", fontFamily: MONO, fontSize: 10, fontWeight: 600, color: "oklch(0.20 0.04 70)",
              background: "var(--accent)", border: "none", borderRadius: "var(--r-sm)", padding: "5px 11px", cursor: "pointer", whiteSpace: "nowrap",
            }}
          >I&apos;ve reviewed these</button>
        )}
      </div>
    </div>
  );
}
