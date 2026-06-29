// Agents — Activity tab (#1643 split from AgentsWorkspace).
//
// The per-pane tool-attempt feed (#257): summary cards, decision + console filters,
// and the table of allow/ask/block rows. Row derivation + filtering + counts are pure
// (./lib/auditRows); this is render + light filter view state.

import {
  filterAuditRows, fmtAuditTime, type AuditDisplayRow, type DecFilter,
} from "./lib/auditRows";
import type { AgentProfile, ConsoleSession } from "./lib/agentProfiles";
import { StatTile } from "@/shared/ui/StatTile";

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
        <StatTile k="decisions" v={rows.length} sub={<>across {consoles.length} consoles</>} />
        <StatTile k="auto-allowed" v={allow} tone="success" sub="ran without a prompt" />
        <StatTile k="prompted" v={ask} tone="accent" sub="you confirmed" />
        <StatTile k="blocked" v={block} tone="danger" sub="policy denied" />
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
