// Agents — Activity tab (#1643 split from AgentsWorkspace).
//
// The per-pane tool-attempt feed (#257): summary cards, decision + console filters,
// and the table of allow/ask/block rows. Row derivation + filtering + counts are pure
// (./lib/auditRows); this is render + light filter view state.

import {
  filterAuditRows, fmtAuditTime, type AuditDisplayRow, type DecFilter,
} from "./lib/auditRows";
import type { AgentProfile, ConsoleSession } from "./lib/agentProfiles";
import { StatTile } from "@/shared/ui/data/StatTile";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

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
    <Box as="span" className={`dchip ${actDecision === d ? "on" : ""}`} data-d={d === "all" ? undefined : d} onClick={() => setActDecision(d)}>
      <Box as="span" className="dot" />{label}{n !== undefined && <Text as="span" tone="dim" style={{ marginLeft: 2 }}>{n}</Text>}
    </Box>
  );
  return (
    <>
      <Box className="summary">
        <StatTile k="decisions" v={rows.length} sub={<>across {consoles.length} consoles</>} />
        <StatTile k="auto-allowed" v={allow} tone="success" sub="ran without a prompt" />
        <StatTile k="prompted" v={ask} tone="accent" sub="you confirmed" />
        <StatTile k="blocked" v={block} tone="danger" sub="policy denied" />
      </Box>

      <Box className="act-toolbar">
        <Box as="span" className="lbl">decision</Box>
        <Row gap={4} align="stretch">
          {decChip("all", "all")}
          {decChip("allow", "allowed", allow)}
          {decChip("ask", "asked", ask)}
          {decChip("block", "blocked", block)}
        </Row>
        <Box as="span" className="lbl" style={{ marginLeft: 14 }}>console</Box>
        <select className="input" style={{ width: 200 }} value={actConsole} onChange={(e) => setActConsole(e.target.value)}>
          <option value="all">all consoles</option>
          {consoles.map((c) => <option key={c.id} value={c.name}>{c.name}</option>)}
        </select>
        <Box className="spacer" />
        <Box as="span" className="hint mono">per the configured policy</Box>
      </Box>

      <Box className="act-table">
        <Box className="act-row head">
          <Box as="span">time</Box><Box as="span">console › pane</Box><Box as="span">profile</Box><Box as="span">command / action</Box><Box as="span">decision</Box>
        </Box>
        {shown.length === 0 && (
          <Text as="div" mono tone="dim" size={11.5} style={{ padding: "18px 14px" }}>
            No activity yet. Tool attempts are logged once a pane has a profile or role assigned.
          </Text>
        )}
        {shown.map((r, i) => {
          const p = find(r.profileId);
          const sym = r.decision === "allow" ? "✓" : r.decision === "ask" ? "◑" : "✗";
          const decLabel = r.decision === "allow" ? "allowed" : r.decision === "ask" ? "asked" : "blocked";
          const kindGlyph = r.kind === "cmd" ? "$" : r.kind === "net" ? "⇡" : "⚒";
          return (
            <Box className="act-row" key={i}>
              <Box as="span" className="when">{fmtAuditTime(r.ts)}</Box>
              <Text as="span" tone="muted">{r.console} <Text as="span" tone="dim">›</Text> {r.pane}</Text>
              <Box as="span" className="prof">{p && <Box as="span" className="sw" bg={p.color} />}{p?.name ?? r.profileId}</Box>
              <Box as="span" className="cmd"><Text as="span" tone="dim">{kindGlyph}</Text> {r.target}</Box>
              <Box as="span" className={`dec ${r.decision}`}>{sym} {decLabel}</Box>
            </Box>
          );
        })}
      </Box>
    </>
  );
}
