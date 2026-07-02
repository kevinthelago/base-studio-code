// The focused MCP Servers stage (#878, split from FocusedBodies.tsx #1757): the project's MCP
// servers as one expandable card each — transport + install status, an enable toggle, the launch
// command, and the fleet scope it's granted to. A first-party server downloads on assign; its
// "build" button runs the toolchain build (uv/pnpm) before the fleet can use it. An enabled,
// project-scoped server reaches the director AND every worker.
import { useState } from "react";
import { useExpandable } from "@/shared/hooks/useExpandable";
import type { McpServer } from "@/features/planner/pane/projectPaneData";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Code } from "@/shared/ui/data/Code";
import type { McpHandlers } from "./focusedHandlers";

const MCP_TRANSPORT: Record<string, { c: string; label: string }> = {
  stdio: { c: "oklch(0.72 0.10 230)", label: "stdio" },
  http:  { c: "oklch(0.80 0.14 70)",  label: "http" },
};
const MCP_STATUS: Record<McpServer["status"], { c: string; dot: string; label: string }> = {
  ready:       { c: "var(--success)", dot: "on",   label: "ready" },
  downloaded:  { c: "var(--fg-muted)", dot: "idle", label: "downloaded · build to run" },
  available:   { c: "var(--fg-dim)",  dot: "idle", label: "available · download to run" },
  downloading: { c: "var(--info)",    dot: "run",  label: "downloading…" },
  building:    { c: "var(--info)",    dot: "run",  label: "building…" },
  error:       { c: "var(--danger)",  dot: "",     label: "build failed" },
};

export function McpsBody({ servers, onToggle, onBuild, onAdd, onRemove }: McpHandlers & {
  servers?: McpServer[];
}) {
  const list = servers ?? [];
  const { open, toggle: toggleOpen } = useExpandable();
  const [draft, setDraft] = useState("");

  const ready = list.filter((s) => s.enabled && s.status === "ready").length;
  const errored = list.filter((s) => s.enabled && s.status === "error").length;
  const busy = (s: McpServer) => s.status === "downloading" || s.status === "building";

  const tile = (v: React.ReactNode, k: string, c?: string) => (
    <Box pad={[8, 11]} bg="var(--bg-canvas)" border="soft" radius={8} style={{ flex: 1}}>
      <Text as="div" mono size={18} weight={600} style={{ color: c ?? "var(--fg)" }}>{v}</Text>
      <Box className="mono" style={{ fontSize: 9, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".05em", marginTop: 1 }}>{k}</Box>
    </Box>
  );

  return (
    <Stack gap={12}>
      <Row gap={8} align="stretch">
        {tile(<>{ready}<Text as="span" size={11} tone="dim"> / {list.length}</Text></>, "ready", "var(--success)")}
        {tile(list.filter((s) => s.enabled).length, "enabled")}
        {tile(errored, errored === 1 ? "needs attention" : "need attention", errored ? "var(--danger)" : undefined)}
      </Row>

      {list.length === 0 && (
        <Box className="empty-state"><Box as="span" className="empty-icon">⊕</Box><Box as="span">No MCP servers yet — assign one below or have the planner add it</Box></Box>
      )}

      <Stack gap={8}>
        {list.map((s) => {
          const tr = MCP_TRANSPORT[s.transport] ?? MCP_TRANSPORT.stdio;
          const stat = MCP_STATUS[s.status];
          const isOpen = open.has(s.id);
          const isErr = s.enabled && s.status === "error";
          return (
            <Box key={s.id} bg="var(--bg-canvas)" radius={9} style={{ overflow: "hidden",
              border: "1px solid " + (isErr ? "color-mix(in oklch, var(--danger), transparent 60%)" : isOpen ? "var(--border)" : "var(--border-soft)"),
              opacity: s.enabled ? 1 : 0.72,
            }}>
              <Row gap={10} style={{ padding: "10px 12px" }}>
                <Box as="span" className="mono" radius={6} style={{
                  width: 24, height: 24, display: "grid", placeItems: "center", flex: "0 0 24px",
                  fontSize: 12, color: tr.c,
                  border: `1px solid color-mix(in oklch, ${tr.c}, transparent 55%)`,
                }}>{(s.name[0] ?? "?").toUpperCase()}</Box>
                <Stack gap={3} onClick={() => toggleOpen(s.id)} style={{ flex: 1, minWidth: 0, cursor: "pointer" }}>
                  <Row gap={7}>
                    <Box as="span" className="mono-value">{s.name}</Box>
                    {s.official && <Text as="span" className="chip" size={8}>official</Text>}
                    {!s.official && s.downloadable && <Text as="span" className="chip" size={8}>first-party</Text>}
                    <Text as="span" className="chip" size={8} style={{ color: tr.c, borderColor: `color-mix(in oklch, ${tr.c}, transparent 70%)` }}>{tr.label}</Text>
                  </Row>
                  {s.desc && <Box as="span" className="mono" style={{ fontSize: 9.5, color: "var(--fg-dim)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.desc}</Box>}
                </Stack>
                <Stack align="end" gap={5}>
                  <Row gap={5}>
                    <Box as="span" className={"sdot " + stat.dot} style={s.status === "error" ? { background: "var(--danger)" } : undefined} />
                    <Text as="span" mono size={9.5} style={{ color: stat.c }}>{stat.label}</Text>
                  </Row>
                  <Box as="span" className={"toggle" + (s.enabled ? " on" : "")} title={s.enabled ? "granted to the fleet" : "disabled"} onClick={() => onToggle?.(s.id)} />
                </Stack>
              </Row>

              {isErr && s.err && (
                <Row gap={7} style={{ padding: "0 12px 10px" }}>
                  <Text as="span" mono size={9.5} tone="danger">⚠ {s.err}</Text>
                  <Spacer />
                  {/* eslint-disable-next-line no-restricted-syntax -- bespoke `.mini` button, not a `.btn`-family control */}
                  <button className="mini" onClick={() => onBuild?.(s)}>retry build</button>
                </Row>
              )}

              {isOpen && (
                <Box style={{ padding: "10px 12px 12px", borderTop: "1px solid var(--border-soft)" }}>
                  <Text as="div" mono size={9} tone="dim" style={{ marginBottom: 4 }}>command</Text>
                  <Code style={{
                    background: "var(--bg-elev)", borderRadius: 6, padding: "6px 9px",
                    marginBottom: 11, whiteSpace: "nowrap",
                  }}><Text as="span" tone="accent">$ </Text>{s.cmd || "—"}</Code>

                  <Text as="div" mono size={9} tone="dim" style={{ marginBottom: 6 }}>scope · {s.scope}</Text>
                  {s.agents.length > 0 ? (
                    <Row gap={6} wrap align="stretch" style={{ marginBottom: 11 }}>
                      {s.agents.map((id) => (
                        <Box as="span" key={id} className="mono" pad={[2, 8]} bg="var(--bg-elev)" border="soft" radius={99} style={{ fontSize: 9.5, color: "var(--fg)"}}>@{id}</Box>
                      ))}
                    </Row>
                  ) : (
                    <Text as="div" mono size={9.5} tone="dim" style={{ marginBottom: 11 }}>not wired yet — enable to grant the fleet access</Text>
                  )}

                  <Row gap={7} align="stretch">
                    {s.downloadable && s.status !== "ready" && (
                      // eslint-disable-next-line no-restricted-syntax -- bespoke `.mini accent` button, not a `.btn`-family control
                      <button className="mini accent" disabled={busy(s)} onClick={() => onBuild?.(s)}>
                        {s.status === "downloading" ? "downloading…" : s.status === "building" ? "building…" : s.status === "available" ? "download + build" : "build"}
                      </button>
                    )}
                    <Spacer />
                    {/* eslint-disable-next-line no-restricted-syntax -- bespoke `.mini` button, not a `.btn`-family control */}
                    <button className="mini" onClick={() => onRemove?.(s.id)}>remove</button>
                  </Row>
                </Box>
              )}
            </Box>
          );
        })}
      </Stack>

      <Row gap={7} align="stretch">
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke inline add-row input (flex Row + Enter handler); TextField's .field wrapper would change layout */}
        <input
          className="input"
          placeholder="＋ add an MCP server — catalog name, command, or remote URL"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}
          style={{ flex: 1, height: 28, fontSize: 10.5 }}
        />
        {/* eslint-disable-next-line no-restricted-syntax -- bespoke `.mini accent` button, not a `.btn`-family control */}
        <button className="mini accent" disabled={!draft.trim()} onClick={() => { if (draft.trim()) { onAdd?.(draft.trim()); setDraft(""); } }}>add</button>
      </Row>
    </Stack>
  );
}
