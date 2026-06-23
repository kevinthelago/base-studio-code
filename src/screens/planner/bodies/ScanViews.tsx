// ScanViews — the scanned-result visualizations for the Source stage (#1209).
// One read-only scan, three ways to read it: a Graph of the inferred Data Model (entities +
// fields + ref edges), a dense List, and a Process view of the captured behaviors (business
// processes, automations by kind, derived logic). Renders the view-model from sourceConfig.ts
// (scanEntities / scanEdges / aggregatePlatform) — i.e. the derived model (#1205) + the structured
// behavior scan (#1209 backend). Hi-fi implementation of design/Source connection pane kickoff
// "Source Scan Views".

import { useMemo, useState } from "react";
import {
  scanEntities, scanEdges, aggregatePlatform, isMultiSource, downstreamImpact,
  type SourceConfig, type ScanViewEntity, type ScanViewField,
  type ScanAutomation, type ScanAutomationKind,
} from "../shared/sourceConfig";

const MONO = "var(--mono)";
type View = "graph" | "list" | "process";

const grpLabel: React.CSSProperties = {
  fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".08em",
};

/** A field's type chip — ref / enum distinctive; everything else a calm plain chip. */
function TypeChip({ f }: { f: ScanViewField }) {
  if (f.type === "ref") {
    return <span style={chip("var(--info)")}>→ {f.refLabel ?? f.ref}</span>;
  }
  if (f.type === "enum") return <span style={chip("var(--violet)")}>enum</span>;
  return (
    <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", borderRadius: 99, padding: "1px 6px" }}>
      {f.type}
    </span>
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
    <div style={{ display: "inline-flex", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: 3, gap: 2, flex: "none" }}>
      {items.map(([v, label]) => {
        const on = v === view;
        return (
          <span key={v} data-testid={`scan-view-${v}`} onClick={() => onView(v)} style={{
            padding: small ? "4px 10px" : "5px 12px", fontSize: fs, cursor: "pointer", borderRadius: "var(--r-sm)",
            fontWeight: on ? 600 : 400, color: on ? "var(--fg)" : "var(--fg-dim)", background: on ? "var(--bg-elev2)" : "transparent",
          }}>{label}</span>
        );
      })}
    </div>
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
    <div style={{ position: "relative", overflow: "auto", maxHeight: 560, background: "radial-gradient(circle at 1px 1px, var(--bg-elev) 1px, transparent 0) 0 0 / 22px 22px, var(--bg-canvas)" }}>
      <div style={{ position: "relative", width: layout.width, height: layout.height }}>
        {/* type legend */}
        <div style={{ position: "absolute", top: 10, left: 10, zIndex: 5, display: "flex", gap: 6, alignItems: "center", background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "5px 9px" }}>
          <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)", letterSpacing: ".06em" }}>TYPES</span>
          <span style={chip("var(--info)")}>ref</span>
          <span style={chip("var(--violet)")}>enum</span>
          <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", borderRadius: 99, padding: "1px 6px" }}>string</span>
          <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--success)" }}>🔑 identity</span>
        </div>

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
            <div key={i} style={{ position: "absolute", left: p.lx - 40, top: p.ly - 8, width: 80, textAlign: "center", fontFamily: MONO, fontSize: 9, color: "var(--info)", pointerEvents: "none" }}>
              <span style={{ background: "var(--bg-canvas)", padding: "1px 5px", borderRadius: "var(--r-sm)" }}>{e.label}</span>
            </div>
          );
        })}

        {/* nodes */}
        {entities.map((e) => {
          const box = layout.boxes.get(e.key)!;
          const isHub = e.key === layout.hubKey;
          return (
            <div key={e.key} data-testid={`scan-node-${e.key}`} style={{
              position: "absolute", left: box.x, top: box.y, width: NODE_W,
              background: "var(--bg-panel)", border: `1px solid ${isHub ? "var(--info)" : "var(--border-soft)"}`,
              borderRadius: "var(--r-lg)", overflow: "hidden",
              boxShadow: isHub ? "0 0 0 4px color-mix(in oklab, var(--info), transparent 92%)" : undefined,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "9px 11px", background: "var(--bg-elev)", borderBottom: "1px solid var(--border-soft)", borderLeft: `3px solid ${e.srcColor}` }}>
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>{e.count.toLocaleString()}</span>
              </div>
              {multi && e.source && (
                <div style={{ display: "flex", alignItems: "center", gap: 5, padding: "4px 11px", borderBottom: "1px solid var(--border-soft)" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: e.srcColor }} />
                  <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-dim)" }}>{e.source}</span>
                </div>
              )}
              {e.fields.map((f) => (
                <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 7, padding: "5px 11px", borderTop: "1px solid var(--border-soft)" }}>
                  {f.identity && <span style={{ fontSize: 9, color: "var(--success)" }}>🔑</span>}
                  <span style={{ fontFamily: MONO, fontSize: 10.5, color: "var(--fg)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.key}</span>
                  <TypeChip f={f} />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── List view ───────────────────────────────────────────────────────────────────────────────
function List({ entities, multi }: { entities: ScanViewEntity[]; multi: boolean }) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(entities.slice(0, 2).map((e) => e.key)));
  const toggle = (k: string) => setOpen((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  return (
    <div style={{ padding: "12px 14px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      {entities.map((e) => {
        const expanded = open.has(e.key);
        const oneliner = `${e.fields.length} fields · ` + e.fields.slice(0, 4).map((f) => f.key + (f.identity ? "🔑" : "") + (f.ref ? `→${f.refLabel ?? f.ref}` : "")).join(", ");
        return (
          <div key={e.key} data-testid={`scan-list-${e.key}`} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
            <div onClick={() => toggle(e.key)} style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 12px", background: "var(--bg-elev)", cursor: "pointer" }}>
              <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
              <span style={{ fontSize: 13, fontWeight: 600 }}>{e.label}</span>
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-dim)" }}>{e.key}</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontFamily: MONO, fontSize: 9.5, color: "var(--fg-muted)" }}>{e.count.toLocaleString()} rows · {e.fields.length} fields</span>
              {multi && e.source && (
                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", borderRadius: 99, padding: "2px 7px" }}>
                  <span style={{ width: 6, height: 6, borderRadius: 99, background: e.srcColor }} />{e.source}
                </span>
              )}
            </div>
            {expanded ? (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {e.fields.map((f) => (
                  <div key={f.key} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 12px", borderTop: "1px solid var(--border-soft)" }}>
                    <span style={{ width: 14, textAlign: "center" }}>{f.identity && <span style={{ fontSize: 9, color: "var(--success)" }}>🔑</span>}</span>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)", minWidth: 128 }}>{f.key}</span>
                    {f.type === "ref" ? <span style={chip("var(--info)")}>ref → {f.refLabel ?? f.ref}</span> : f.type === "enum" ? <span style={chip("var(--violet)")}>enum{f.enumValues && f.enumValues.length ? ` · ${f.enumValues.join(" · ")}` : ""}</span> : (
                      <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", borderRadius: 99, padding: "1px 6px" }}>{f.type}</span>
                    )}
                    <span style={{ flex: 1 }} />
                    {f.required && <span style={{ fontFamily: MONO, fontSize: 8.5, color: "var(--accent)" }}>required</span>}
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ padding: "7px 12px", borderTop: "1px solid var(--border-soft)", fontFamily: MONO, fontSize: 10, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{oneliner}</div>
            )}
          </div>
        );
      })}
    </div>
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
    return <div style={{ padding: "20px 16px", fontSize: 12, color: "var(--fg-dim)" }}>No automations, processes, or derived logic captured for this source.</div>;
  }
  return (
    <div style={{ padding: "13px 16px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
      {p.businessProcesses.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={grpLabel}>business processes</div>
          {p.businessProcesses.map((bp, i) => (
            <div key={i} style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{bp.name}</span>
                <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>on {bp.object || "—"}</span>
                <span style={chip(bp.active ? "var(--success)" : "var(--fg-dim)")}>{bp.active ? "active" : "inactive"}</span>
                <span style={{ flex: 1 }} />
                {multi && <SrcBadge source={bp.source} />}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                {bp.steps.map((s, j) => (
                  <span key={j} style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
                    <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "5px 11px" }}>{s}</span>
                    {j < bp.steps.length - 1 && <span style={{ color: "var(--fg-dim)", fontSize: 12 }}>→</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {groups.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={grpLabel}>automations · by kind</div>
          {groups.map((g) => (
            <div key={g.kind} style={{ display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={chip("var(--accent)")}>{KIND_LABEL[g.kind]}</span>
                {g.legacy && <span style={chip("var(--danger)")}>⚠ legacy · migrate this</span>}
              </div>
              {g.items.map((a, i) => (
                <div key={i} style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 12, fontWeight: 500 }}>{a.name}</span>
                    {a.object && <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>on {a.object}</span>}
                    <span style={{ flex: 1 }} />
                    {multi && <SrcBadge source={a.source} />}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                    {a.trigger && <><span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>trigger</span><Tok>{a.trigger}</Tok><Arr /></>}
                    {a.condition && <><span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>if</span><Tok>{a.condition}</Tok><Arr /></>}
                    {a.actions.map((ac, j) => (
                      <span key={j} style={{ fontFamily: MONO, fontSize: 10, color: "var(--accent)", background: "color-mix(in oklab, var(--accent), transparent 90%)", border: "1px solid color-mix(in oklab, var(--accent), transparent 80%)", borderRadius: "var(--r-sm)", padding: "3px 8px" }}>{ac}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {p.derivedLogic.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <div style={grpLabel}>derived logic</div>
          {p.derivedLogic.map((d, i) => (
            <div key={i} style={{ background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", padding: "9px 11px", display: "flex", flexDirection: "column", gap: 7 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span style={chip("var(--violet)")}>{d.kind}</span>
                <span style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg)" }}>{d.name}</span>
                {d.object && <span style={{ fontFamily: MONO, fontSize: 9, color: "var(--fg-dim)" }}>on {d.object}</span>}
                <span style={{ flex: 1 }} />
                {multi && <SrcBadge source={d.source} />}
              </div>
              {d.expression && <div style={{ fontFamily: MONO, fontSize: 11, color: "var(--fg-muted)", background: "var(--bg-canvas)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", padding: "7px 10px", overflowX: "auto" }}>{d.expression}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function Tok({ children }: { children: React.ReactNode }) {
  return <span style={{ fontFamily: MONO, fontSize: 10, color: "var(--fg)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-sm)", padding: "3px 8px" }}>{children}</span>;
}
function Arr() { return <span style={{ color: "var(--fg-dim)" }}>→</span>; }
function SrcBadge({ source }: { source: string }) {
  if (!source) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontFamily: MONO, fontSize: 9, color: "var(--fg-muted)" }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: "var(--fg-dim)" }} />{source}
    </span>
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
    <div data-testid="scan-views" style={{ background: "var(--bg-panel)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-lg)", overflow: "hidden" }}>
      {/* recap header + toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, padding: "12px 14px", borderBottom: "1px solid var(--border-soft)" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Scanned result</span>
            <span style={chip("var(--success)")}>READ-ONLY</span>
          </div>
          <div style={{ fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.4 }}>
            <span style={{ color: "var(--violet)", fontFamily: MONO, fontSize: 10.5 }}>⬡ {dataModelName} · v{version}</span>
            {" · "}seeds <b style={{ color: "var(--fg)" }}>{impact.entities} {impact.entities === 1 ? "entity" : "entities"} · {impact.fields} fields</b> into features + structure
            {impact.behaviors > 0 && <> · <b style={{ color: "var(--fg)" }}>{impact.behaviors} behaviors</b> carried over</>}
          </div>
        </div>
        <Toggle view={view} onView={setView} />
      </div>

      {view === "graph" && <Graph entities={entities} multi={multi} />}
      {view === "list" && <List entities={entities} multi={multi} />}
      {view === "process" && <Process cfg={cfg} multi={multi} />}
    </div>
  );
}
