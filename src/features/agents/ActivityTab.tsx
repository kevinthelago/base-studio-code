// Agents — Activity tab (#1643 split from AgentsScreen).
//
// The per-pane tool-attempt feed (#257): summary cards, decision + console filters,
// and the table of allow/ask/block rows. Row derivation + filtering + counts are pure
// (./lib/auditRows); this is render + light filter view state.

import {
  filterAuditRows, fmtAuditTime, type AuditDisplayRow, type DecFilter,
} from "./lib/auditRows";
import type { AgentProfile, ConsoleSession } from "./lib/agentProfiles";

export interface ActivityTabProps {
  rows: AuditDisplayRow[];
  consoles: ConsoleSession[];
  actDecision: DecFilter; setActDecision: (d: DecFilter) => void;
  actConsole: string; setActConsole: (c: string) => void;
  allow: number; ask: number; block: number;
  find: (id: string) => AgentProfile | undefined;
}

export function ActivityTab({ rows, consoles, actDecision, setActDecision, actConsole, setActConsole, allow, ask, block, find }: ActivityTabProps) {
  const shown = filterAuditRows(rows, actDecision, actConsole);
  const decChip = (d: DecFilter, label: string, n?: number) => (
    <span className={`dchip ${actDecision === d ? "on" : ""}`} data-d={d === "all" ? undefined : d} onClick={() => setActDecision(d)}>
      <span className="dot" />{label}{n !== undefined && <span style={{ color: "var(--fg-dim)", marginLeft: 2 }}>{n}</span>}
    </span>
  );
  return (
    <>
      <div className="summary">
        <div className="card"><div className="k">decisions</div><div className="v">{rows.length}</div><div className="sub">across {consoles.length} consoles</div></div>
        <div className="card"><div className="k">auto-allowed</div><div className="v success">{allow}</div><div className="sub">ran without a prompt</div></div>
        <div className="card"><div className="k">prompted</div><div className="v accent">{ask}</div><div className="sub">you confirmed</div></div>
        <div className="card"><div className="k">blocked</div><div className="v danger">{block}</div><div className="sub">policy denied</div></div>
      </div>

      <div className="act-toolbar">
        <span className="lbl">decision</span>
        <div style={{ display: "flex", gap: 4 }}>
          {decChip("all", "all")}
          {decChip("allow", "allowed", allow)}
          {decChip("ask", "asked", ask)}
          {decChip("block", "blocked", block)}
        </div>
        <span className="lbl" style={{ marginLeft: 14 }}>console</span>
        <select className="input" style={{ width: 200 }} value={actConsole} onChange={(e) => setActConsole(e.target.value)}>
          <option value="all">all consoles</option>
          {consoles.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <div className="spacer" />
        <span className="hint" style={{ fontFamily: "var(--mono)" }}>per the configured policy</span>
      </div>

      <div className="act-table">
        <div className="act-row head">
          <span>time</span><span>console › pane</span><span>profile</span><span>command / action</span><span>decision</span>
        </div>
        {shown.length === 0 && (
          <div style={{ padding: "18px 14px", fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-dim)" }}>
            No activity yet. Tool attempts are logged once a pane has a profile or role assigned.
          </div>
        )}
        {shown.map((r, i) => {
          const p = find(r.profileId);
          const sym = r.decision === "allow" ? "✓" : r.decision === "ask" ? "◑" : "✗";
          const decLabel = r.decision === "allow" ? "allowed" : r.decision === "ask" ? "asked" : "blocked";
          const kindGlyph = r.kind === "cmd" ? "$" : r.kind === "net" ? "⇡" : "⚒";
          return (
            <div className="act-row" key={i}>
              <span className="when">{fmtAuditTime(r.ts)}</span>
              <span style={{ color: "var(--fg-muted)" }}>{r.console} <span style={{ color: "var(--fg-dim)" }}>›</span> {r.pane}</span>
              <span className="prof">{p && <span className="sw" style={{ background: p.color }} />}{p?.name ?? r.profileId}</span>
              <span className="cmd"><span style={{ color: "var(--fg-dim)" }}>{kindGlyph}</span> {r.target}</span>
              <span className={`dec ${r.decision}`}>{sym} {decLabel}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}
