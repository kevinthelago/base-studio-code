// ScanViews — the scanned-result visualizations for the Source stage (#1209).
// One read-only scan, three ways to read it: a Graph of the inferred Data Model (entities +
// fields + ref edges), a dense List, and a Process view of the captured behaviors (business
// processes, automations by kind, derived logic). Renders the view-model from sourceConfig.ts
// (scanEntities / scanEdges / aggregatePlatform) — i.e. the derived model (#1205) + the structured
// behavior scan (#1209 backend). Hi-fi implementation of design/Source connection pane kickoff
// "Source Scan Views".

import { useMemo, useState } from "react";
import { useExpandable } from "@/shared/hooks/useExpandable";
import {
  scanEntities, scanEdges, aggregatePlatform, isMultiSource, downstreamImpact,
  type SourceConfig, type ScanViewEntity, type ScanViewField,
  type ScanAutomation, type ScanAutomationKind,
} from "../lib/sourceConfig";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

const MONO = "var(--mono)";
type View = "graph" | "list" | "process";

const grpLabel: React.CSSProperties = {
  fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".08em",
};

/** A field's type chip — ref / enum distinctive; everything else a calm plain chip. */
function TypeChip({ f }: { f: ScanViewField }) {
  if (f.type === "ref") {
    return <Box as="span" style={chip("var(--info)")}>→ {f.refLabel ?? f.ref}</Box>;
  }
  if (f.type === "enum") return <Box as="span" style={chip("var(--violet)")}>enum</Box>;
  return (
    <Box as="span" pad={[1, 6]} bg="var(--bg-elev2)" border="soft" radius={99} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-muted)"}}>
      {f.type}
    </Box>
  );
}
function chip(color: string): React.CSSProperties {
  return {
    fontFamily: MONO, fontSize: 8.5, color, whiteSpace: "nowrap",
    background: `color-mix(in oklab, ${color}, transparent 88%)`,
    border: `1px solid color-mix(in oklab, ${color}, transparent 76%)`,
    borderRadius: 99, padding: "1px 6px",
  };
}

/** Segmented Graph · List · Process toggle. */
function Toggle({ view, onView, small }: { view: View; onView: (v: View) => void; small?: boolean }) {
  const fs = small ? 11.5 : 12;
  const items: [View, string][] = [["graph", "⬡ Graph"], ["list", "≣ List"], ["process", "⤳ Process"]];
  return (
    <Box pad={3} bg="var(--bg-elev)" border="soft" radius="md" style={{ display: "inline-flex", gap: 2, flex: "none" }}>
      {items.map(([v, label]) => {
        const on = v === view;
        return (
          <Box as="span" key={v} data-testid={`scan-view-${v}`} onClick={() => onView(v)} bg={on ? "var(--bg-elev2)" : "transparent"} radius="sm" style={{
            padding: small ? "4px 10px" : "5px 12px", fontSize: fs, cursor: "pointer",
            fontWeight: on ? 600 : 400, color: on ? "var(--fg)" : "var(--fg-dim)",
          }}>{label}</Box>
        );
      })}
    </Box>
  );
}

// ── Graph view ──────────────────────────────────────────────────────────────────────────────
const NODE_W = 216;

function nodeHeight(e: ScanViewEntity, multi: boolean): number {
  return 34 + (multi ? 22 : 0) + e.fields.length * 27 + 2;
}

function Graph({ entities, multi }: { entities: ScanViewEntity[]; multi: boolean }) {
  const edges = useMemo(() => scanEdges(entities), [entities]);
  const layout = useMemo(() => {
    const incoming = new Map<string, number>();
    edges.forEach((e) => incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1));
    let hub = entities[0];
    let best = -1;
    for (const e of entities) {
      const c = incoming.get(e.key) ?? 0;
      if (c > best) { best = c; hub = e; }
    }
    const sats = entities.filter((e) => e.key !== hub.key);
    const GAP = 18, TOP = 20, LEFTX = 24, RIGHTX = 24 + NODE_W + 150;
    const boxes = new Map<string, { x: number; y: number; w: number; h: number }>();
    let y = TOP;
    for (const s of sats) {
      const h = nodeHeight(s, multi);
      boxes.set(s.key, { x: RIGHTX, y, w: NODE_W, h });
      y += h + GAP;
    }
    const rightTotal = Math.max(y - GAP, TOP);
    const hubH = nodeHeight(hub, multi);
    boxes.set(hub.key, { x: LEFTX, y: Math.max(TOP, TOP + (rightTotal - TOP - hubH) / 2), w: NODE_W, h: hubH });
    const width = RIGHTX + NODE_W + 24;
    const height = Math.max(rightTotal, boxes.get(hub.key)!.y + hubH) + 24;
    return { boxes, hubKey: hub.key, width, height };
  }, [entities, edges, multi]);

  const edgePath = (aKey: string, bKey: string) => {
    const a = layout.boxes.get(aKey)!;
    const b = layout.boxes.get(bKey)!;
    const goesRight = b.x >= a.x;
    const sx = a.x + (goesRight ? a.w : 0), sy = a.y + a.h / 2;
    const tx = b.x + (goesRight ? 0 : b.w), ty = b.y + b.h / 2;
    const mx = (sx + tx) / 2;
    return { d: `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`, lx: mx, ly: (sy + ty) / 2, label: "" };
  };

  return (
    <Box bg="radial-gradient(circle at 1px 1px, var(--bg-elev) 1px, transparent 0) 0 0 / 22px 22px, var(--bg-canvas)" style={{ position: "relative", overflow: "auto", maxHeight: 560}}>
      <Box style={{ position: "relative", width: layout.width, height: layout.height }}>
        {/* type legend */}
        <Row gap={6} style={{ position: "absolute", top: 10, left: 10, zIndex: 5, background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "5px 9px" }}>
          <Text mono size={8.5} tone="dim" style={{ letterSpacing: ".06em" }}>TYPES</Text>
          <Box as="span" style={chip("var(--info)")}>ref</Box>
          <Box as="span" style={chip("var(--violet)")}>enum</Box>
          <Box as="span" pad={[1, 6]} bg="var(--bg-elev2)" border="soft" radius={99} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-muted)"}}>string</Box>
          <Text mono size={8.5} tone="success">🔑 identity</Text>
        </Row>

        {/* edges */}
        <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}>
          <defs>
            <marker id="sv-arrow" markerWidth="9" markerHeight="9" refX="6.5" refY="3" orient="auto">
              <path d="M0,0 L6.5,3 L0,6 Z" fill="var(--info)" />
            </marker>
          </defs>
          {edges.map((e, i) => {
            const p = edgePath(e.from, e.to);
            return <path key={i} d={p.d} fill="none" stroke="var(--info)" strokeWidth={1.5} markerEnd="url(#sv-arrow)" opacity={0.6} />;
          })}
        </svg>
        {edges.map((e, i) => {
          const p = edgePath(e.from, e.to);
          return (
            <Box key={i} style={{ position: "absolute", left: p.lx - 40, top: p.ly - 8, width: 80, textAlign: "center", fontFamily: MONO, fontSize: 9, color: "var(--info)", pointerEvents: "none" }}>
              <Box as="span" pad={[1, 5]} bg="var(--bg-canvas)" radius="sm">{e.label}</Box>
            </Box>
          );
        })}

        {/* nodes */}
        {entities.map((e) => {
          const box = layout.boxes.get(e.key)!;
          const isHub = e.key === layout.hubKey;
          return (
            <Box key={e.key} data-testid={`scan-node-${e.key}`} bg="var(--bg-panel)" radius="lg" style={{
              position: "absolute", left: box.x, top: box.y, width: NODE_W, border: `1px solid ${isHub ? "var(--info)" : "var(--border-soft)"}`, overflow: "hidden",
              boxShadow: isHub ? "0 0 0 4px color-mix(in oklab, var(--info), transparent 92%)" : undefined,
            }}>
              <Row gap={8} style={{ padding: "9px 11px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)", borderLeft: `3px solid ${e.srcColor}` }}>
                <Box as="span" style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</Box>
                <Text mono size={9} tone="dim">{e.count.toLocaleString()}</Text>
              </Row>
              {multi && e.source && (
                <Row gap={5} style={{ padding: "4px 11px", borderBottom: "1px solid var(--border-soft)" }}>
                  <Box as="span" bg={e.srcColor} radius={99} style={{ width: 6, height: 6}} />
                  <Text mono size={8.5} tone="dim">{e.source}</Text>
                </Row>
              )}
              {e.fields.map((f) => (
                <Row key={f.key} gap={7} style={{ padding: "5px 11px", borderTop: "1px solid var(--border-soft)" }}>
                  {f.identity && <Text size={9} tone="success">🔑</Text>}
                  <Box as="span" style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.key}</Box>
                  <TypeChip f={f} />
                </Row>
              ))}
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

// ── List view ───────────────────────────────────────────────────────────────────────────────
function List({ entities, multi }: { entities: ScanViewEntity[]; multi: boolean }) {
  const { open, toggle } = useExpandable(entities.slice(0, 2).map((e) => e.key));
  return (
    <Stack gap={8} style={{ padding: "12px 14px 14px" }}>
      {entities.map((e) => {
        const expanded = open.has(e.key);
        const oneliner = `${e.fields.length} fields · ` + e.fields.slice(0, 4).map((f) => f.key + (f.identity ? "🔑" : "") + (f.ref ? `→${f.refLabel ?? f.ref}` : "")).join(", ");
        return (
          <Box key={e.key} data-testid={`scan-list-${e.key}`} bg="var(--bg-panel)" border="soft" radius="lg" style={{ overflow: "hidden" }}>
            <Row onClick={() => toggle(e.key)} gap={9} style={{ padding: "9px 12px", background: "var(--bg-elev)", cursor: "pointer" }}>
              <Text tone="dim" size={10}>{expanded ? "▾" : "▸"}</Text>
              <Text size={13} weight={600}>{e.label}</Text>
              <Text mono size={9.5} tone="dim">{e.key}</Text>
              <Spacer />
              <Text mono size={9.5} tone="muted">{e.count.toLocaleString()} rows · {e.fields.length} fields</Text>
              {multi && e.source && (
                <Box as="span" pad={[2, 7]} bg="var(--bg-elev2)" border="soft" radius={99} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, color: "var(--fg-muted)"}}>
                  <Box as="span" bg={e.srcColor} radius={99} style={{ width: 6, height: 6}} />{e.source}
                </Box>
              )}
            </Row>
            {expanded ? (
              <Stack>
                {e.fields.map((f) => (
                  <Row key={f.key} gap={9} style={{ padding: "6px 12px", borderTop: "1px solid var(--border-soft)" }}>
                    <Box as="span" style={{ width: 14, textAlign: "center" }}>{f.identity && <Text size={9} tone="success">🔑</Text>}</Box>
                    <Text mono size={11} style={{ color: "var(--fg)", minWidth: 128 }}>{f.key}</Text>
                    {f.type === "ref" ? <Box as="span" style={chip("var(--info)")}>ref → {f.refLabel ?? f.ref}</Box> : f.type === "enum" ? <Box as="span" style={chip("var(--violet)")}>enum{f.enumValues && f.enumValues.length ? ` · ${f.enumValues.join(" · ")}` : ""}</Box> : (
                      <Box as="span" pad={[1, 6]} bg="var(--bg-elev2)" border="soft" radius={99} style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-muted)"}}>{f.type}</Box>
                    )}
                    <Spacer />
                    {f.required && <Text mono size={8.5} tone="accent">required</Text>}
                  </Row>
                ))}
              </Stack>
            ) : (
              <Box pad={[7, 12]} style={{ borderTop: "1px solid var(--border-soft)", fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{oneliner}</Box>
            )}
          </Box>
        );
      })}
    </Stack>
  );
}

// ── Process view ────────────────────────────────────────────────────────────────────────────
const KIND_LABEL: Record<ScanAutomationKind, string> = {
  validation: "Validation", workflow: "Workflow", flow: "Flow", processBuilder: "Process Builder", recurring: "Recurring", other: "Other",
};
const KIND_ORDER: ScanAutomationKind[] = ["validation", "workflow", "flow", "processBuilder", "recurring", "other"];

function Process({ cfg, multi }: { cfg: SourceConfig; multi: boolean }) {
  const p = useMemo(() => aggregatePlatform(cfg), [cfg]);
  const groups = useMemo(() => {
    const by = new Map<ScanAutomationKind, ScanAutomation[]>();
    for (const a of p.automations) { const arr = by.get(a.kind) ?? []; arr.push(a); by.set(a.kind, arr); }
    return KIND_ORDER.filter((k) => by.has(k)).map((k) => ({ kind: k, legacy: k === "processBuilder", items: by.get(k)! }));
  }, [p]);
  const empty = p.businessProcesses.length === 0 && p.automations.length === 0 && p.derivedLogic.length === 0;
  if (empty) {
    return <Text as="div" size={12} tone="dim" style={{ padding: "20px 16px" }}>No automations, processes, or derived logic captured for this source.</Text>;
  }
  return (
    <Stack gap={16} style={{ padding: "13px 16px 16px" }}>
      {p.businessProcesses.length > 0 && (
        <Stack gap={9}>
          <Text as="div" style={grpLabel}>business processes</Text>
          {p.businessProcesses.map((bp, i) => (
            <Stack key={i} gap={10} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 12 }}>
              <Row gap={9} wrap>
                <Text size={13} weight={600}>{bp.name}</Text>
                <Text mono size={9} tone="dim">on {bp.object || "—"}</Text>
                <Box as="span" style={chip(bp.active ? "var(--success)" : "var(--fg-dim)")}>{bp.active ? "active" : "inactive"}</Box>
                <Spacer />
                {multi && <SrcBadge source={bp.source} />}
              </Row>
              <Row gap={7} wrap>
                {bp.steps.map((s, j) => (
                  <Box as="span" key={j} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <Box as="span" pad={[5, 11]} bg="var(--bg-elev2)" border="soft" radius="md" style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)"}}>{s}</Box>
                    {j < bp.steps.length - 1 && <Text tone="dim" size={12}>→</Text>}
                  </Box>
                ))}
              </Row>
            </Stack>
          ))}
        </Stack>
      )}

      {groups.length > 0 && (
        <Stack gap={9}>
          <Text as="div" style={grpLabel}>automations · by kind</Text>
          {groups.map((g) => (
            <Stack key={g.kind} gap={7}>
              <Row gap={8}>
                <Box as="span" style={chip("var(--accent)")}>{KIND_LABEL[g.kind]}</Box>
                {g.legacy && <Box as="span" style={chip("var(--danger)")}>⚠ legacy · migrate this</Box>}
              </Row>
              {g.items.map((a, i) => (
                <Stack key={i} gap={8} style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "9px 11px" }}>
                  <Row gap={8} wrap>
                    <Text size={12} weight={500}>{a.name}</Text>
                    {a.object && <Text mono size={9} tone="dim">on {a.object}</Text>}
                    <Spacer />
                    {multi && <SrcBadge source={a.source} />}
                  </Row>
                  <Row gap={7} wrap>
                    {a.trigger && <><Text mono size={9} tone="dim">trigger</Text><Tok>{a.trigger}</Tok><Arr /></>}
                    {a.condition && <><Text mono size={9} tone="dim">if</Text><Tok>{a.condition}</Tok><Arr /></>}
                    {a.actions.map((ac, j) => (
                      <Box as="span" key={j} pad={[3, 8]} bg="color-mix(in oklab, var(--accent), transparent 90%)" radius="sm" style={{ fontFamily: MONO, fontSize: 10, color: "var(--accent)", border: "1px solid color-mix(in oklab, var(--accent), transparent 80%)"}}>{ac}</Box>
                    ))}
                  </Row>
                </Stack>
              ))}
            </Stack>
          ))}
        </Stack>
      )}

      {p.derivedLogic.length > 0 && (
        <Stack gap={9}>
          <Text as="div" style={grpLabel}>derived logic</Text>
          {p.derivedLogic.map((d, i) => (
            <Stack key={i} gap={7} style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "9px 11px" }}>
              <Row gap={8} wrap>
                <Box as="span" style={chip("var(--violet)")}>{d.kind}</Box>
                <Text mono size={11} style={{ color: "var(--fg)" }}>{d.name}</Text>
                {d.object && <Text mono size={9} tone="dim">on {d.object}</Text>}
                <Spacer />
                {multi && <SrcBadge source={d.source} />}
              </Row>
              {d.expression && <Box pad={[7, 10]} bg="var(--bg-canvas)" border="soft" radius="sm" style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg-muted)", overflowX: "auto" }}>{d.expression}</Box>}
            </Stack>
          ))}
        </Stack>
      )}
    </Stack>
  );
}
function Tok({ children }: { children: React.ReactNode }) {
  return <Box as="span" pad={[3, 8]} bg="var(--bg-elev2)" border="soft" radius="sm" style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg)"}}>{children}</Box>;
}
function Arr() { return <Text tone="dim">→</Text>; }
function SrcBadge({ source }: { source: string }) {
  if (!source) return null;
  return (
    <Box as="span" style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, color: "var(--fg-muted)" }}>
      <Box as="span" bg="var(--fg-dim)" radius={99} style={{ width: 6, height: 6}} />{source}
    </Box>
  );
}

// ── main ────────────────────────────────────────────────────────────────────────────────────
export function ScanViews({ cfg, dataModelName, version = 1 }: { cfg: SourceConfig; dataModelName: string; version?: number }) {
  const entities = useMemo(() => scanEntities(cfg), [cfg]);
  const multi = useMemo(() => isMultiSource(cfg), [cfg]);
  const impact = useMemo(() => downstreamImpact(cfg), [cfg]);
  const [view, setView] = useState<View>(entities.length > 6 ? "list" : "graph");

  if (entities.length === 0) return null;

  return (
    <Box data-testid="scan-views" bg="var(--bg-panel)" border="soft" radius="lg" style={{ overflow: "hidden" }}>
      {/* recap header + toggle */}
      <Row justify="between" gap={14} style={{ padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <Stack gap={4} style={{ minWidth: 0 }}>
          <Row gap={8}>
            <Text size={14} weight={600}>Scanned result</Text>
            <Box as="span" style={chip("var(--success)")}>READ-ONLY</Box>
          </Row>
          <Text as="div" size={11.5} tone="muted" style={{ lineHeight: 1.4 }}>
            <Text mono size={10.5} style={{ color: "var(--violet)" }}>⬡ {dataModelName} · v{version}</Text>
            {" · "}seeds <b style={{ color: "var(--fg)" }}>{impact.entities} {impact.entities === 1 ? "entity" : "entities"} · {impact.fields} fields</b> into features + structure
            {impact.behaviors > 0 && <> · <b style={{ color: "var(--fg)" }}>{impact.behaviors} behaviors</b> carried over</>}
          </Text>
        </Stack>
        <Toggle view={view} onView={setView} />
      </Row>

      {view === "graph" && <Graph entities={entities} multi={multi} />}
      {view === "list" && <List entities={entities} multi={multi} />}
      {view === "process" && <Process cfg={cfg} multi={multi} />}
    </Box>
  );
}
