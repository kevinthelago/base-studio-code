// Integrations focused-pane body (#1200) — surfaces the integrations the forming plan implies
// (MCP servers, source connectors, credentials), each marked assigned / available / missing, and
// offers an in-session add path: assign an available MCP server, or queue a connector for the
// Source stage — without leaving the planning session. Store-backed (planSections + source config +
// mcpServers); the classification itself is the pure `integrationGaps` engine.

import { useMemo } from "react";
import { useAppStore } from "@/store";
import { applyMcpAssign } from "../shared/planExtensions";
import { defaultSourceConfig } from "../shared/sourceConfig";
import { integrationGaps, type ImpliedIntegration, type IntegrationStatus } from "../shared/integrationGaps";

const MONO = "var(--mono)";
const grpLabel: React.CSSProperties = { fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" };

const STATUS_COLOR: Record<IntegrationStatus, string> = {
  assigned: "var(--success)",
  available: "var(--accent)",
  missing: "var(--danger)",
};
// Actionable first (missing, available), then the already-wired ones.
const STATUS_ORDER: Record<IntegrationStatus, number> = { missing: 0, available: 1, assigned: 2 };
const KIND_BADGE: Record<string, string> = { mcp: "MCP", connector: "SRC", credential: "KEY" };

function Pill({ n, label, color }: { n: number; label: string; color: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 9px", borderRadius: "var(--r-md)", background: `color-mix(in oklch, ${color}, transparent 90%)`, border: `1px solid color-mix(in oklch, ${color}, transparent 74%)` }}>
      <span style={{ fontFamily: MONO, fontSize: 12, color, fontWeight: 600 }}>{n}</span>
      <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-muted)" }}>{label}</span>
    </div>
  );
}

function Row({ item, onAssign, onDeclare }: { item: ImpliedIntegration; onAssign: (name: string) => void; onDeclare: (id: string) => void }) {
  const color = STATUS_COLOR[item.status];
  return (
    <div data-testid={`integration-item-${item.key}`} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 11px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>
      <span style={{ width: 7, height: 7, borderRadius: 99, flexShrink: 0, background: color }} />
      <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)", border: "1px solid var(--border-soft)", borderRadius: 3, padding: "1px 4px", flexShrink: 0 }}>{KIND_BADGE[item.kind]}</span>
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 12, color: "var(--fg)" }}>{item.label}</span>
        <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.reason}</span>
      </div>
      <span style={{ fontFamily: MONO, fontSize: 9.5, color, flexShrink: 0 }}>{item.status}</span>
      {item.action === "assign" && (
        <button data-testid={`integration-assign-${item.ref}`} onClick={() => onAssign(item.ref)} style={btn("var(--accent)")}>Assign</button>
      )}
      {item.action === "declare" && (
        <button data-testid={`integration-declare-${item.ref}`} onClick={() => onDeclare(item.ref)} style={btn("var(--accent)")}>Add source</button>
      )}
      {(item.action === "credential" || item.action === "install") && (
        <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)", flexShrink: 0 }}>{item.action === "credential" ? "Source stage" : "MCP stage"}</span>
      )}
    </div>
  );
}

function btn(color: string): React.CSSProperties {
  return { height: 24, padding: "0 11px", flexShrink: 0, border: `1px solid ${color}`, borderRadius: "var(--r-md)", cursor: "pointer", fontFamily: MONO, fontSize: 10.5, background: `color-mix(in oklch, ${color}, transparent 88%)`, color };
}

/** Integrations stage body — what the plan needs, what's wired, what to add. */
export function FocusedIntegrationsBody({ projectId }: { projectId?: string }) {
  const pid = projectId ?? "";
  const sections = useAppStore((s) => s.planSections[pid]);
  const sourceCfg = useAppStore((s) => s.planSourceConfig[pid]);
  const mcpServers = useAppStore((s) => s.mcpServers);
  const addMcpServer = useAppStore((s) => s.addMcpServer);
  const updateMcpServer = useAppStore((s) => s.updateMcpServer);
  const setPlanSourceConfig = useAppStore((s) => s.setPlanSourceConfig);

  const text = useMemo(() => Object.values(sections ?? {}).join("\n\n"), [sections]);
  const gaps = useMemo(
    () => integrationGaps({ text, sources: sourceCfg?.sources ?? [], mcpServers, projectId: pid }),
    [text, sourceCfg, mcpServers, pid],
  );
  const sorted = useMemo(
    () => [...gaps.items].sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]),
    [gaps.items],
  );

  const assignMcp = (name: string) => applyMcpAssign({ mcpServers, addMcpServer, updateMcpServer }, name, pid);
  const declareConnector = (id: string) => {
    const cur = sourceCfg ?? defaultSourceConfig();
    if (cur.proposed.includes(id) || cur.sources.some((s) => s.connectorId === id)) return;
    setPlanSourceConfig(pid, { ...cur, proposed: [...cur.proposed, id] });
  };

  if (gaps.total === 0) {
    return (
      <div data-testid="integrations-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div data-testid="integrations-empty" style={{ padding: "16px 13px", borderRadius: "var(--r-md)", background: "var(--bg-elev)", border: "1px dashed var(--border-soft)", fontFamily: MONO, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.6 }}>
          No integrations implied yet. As the plan's stack, features, and sources take shape, the tools, connectors, and credentials it needs surface here — assigned, available, or missing.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="integrations-body" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
        <span style={grpLabel}>{gaps.total} implied</span>
        <Pill n={gaps.assigned} label="assigned" color="var(--success)" />
        <Pill n={gaps.available} label="available" color="var(--accent)" />
        <Pill n={gaps.missing} label="missing" color="var(--danger)" />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sorted.map((it) => (
          <Row key={it.key} item={it} onAssign={assignMcp} onDeclare={declareConnector} />
        ))}
      </div>

      <div style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", lineHeight: 1.6, paddingTop: 2 }}>
        Need a source with no connector? The planner can author a native integration in-session with{" "}
        <code style={{ color: "var(--fg-muted)" }}>bsc-plan integration add</code> — it becomes a native connector like the built-ins.
      </div>
    </div>
  );
}
