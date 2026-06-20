// RelationshipInspector — the detail panel under the swimlane graph. Spells out the
// focused stream / edge / artifact's relationships in words, with the runtime mechanism
// for each (the coord ref it blocks on, hardness, via). Ported from design/bsc ·
// Agent Relationships - Swimlanes · inspector().

import type { ReactNode } from "react";
import {
  EDGE_KIND_META, ARTIFACT_COLOR, ROLE_COLOR, DIRECTOR_COLOR, hardLabel, runtimeNote,
  type RelationshipGraph, type RelFocus,
} from "./relationshipGraph";

const mono = "var(--mono)";

function Pill({ text, c }: { text: string; c: string }) {
  return (
    <span style={{
      fontFamily: mono, fontSize: 8, padding: "1px 7px", borderRadius: 99, whiteSpace: "nowrap", color: c,
      background: `color-mix(in oklch, ${c}, transparent 86%)`, border: `1px solid color-mix(in oklch, ${c}, transparent 62%)`,
    }}>{text}</span>
  );
}

function RelRow({ glyph, c, head, detail, onClick }: { glyph: string; c: string; head: string; detail?: ReactNode; onClick?: () => void }) {
  return (
    <div onClick={onClick} style={{ display: "flex", alignItems: "baseline", gap: 9, padding: "6px 9px", borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border-soft)", cursor: onClick ? "pointer" : "default" }}>
      <span style={{ flex: "0 0 16px", textAlign: "center", fontFamily: mono, fontSize: 11, color: c }}>{glyph}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg)" }}>{head}</div>
        {detail && <div style={{ fontFamily: mono, fontSize: 8.5, color: "var(--fg-dim)", marginTop: 2, lineHeight: 1.45 }}>{detail}</div>}
      </div>
    </div>
  );
}

function Head({ title, sub, c }: { title: string; sub?: string; c?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 11 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: c ?? "var(--accent)" }} />
      <span style={{ fontFamily: mono, fontSize: 12.5, fontWeight: 600, color: "var(--fg)" }}>{title}</span>
      {sub && <span style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)" }}>{sub}</span>}
    </div>
  );
}

export function RelationshipInspector({ graph, focus, onFocusAgent, onInspectArtifact, onInspectEdge }: {
  graph: RelationshipGraph;
  focus: RelFocus;
  onFocusAgent: (id: string) => void;
  onInspectArtifact: (id: string) => void;
  onInspectEdge: (id: string) => void;
}) {
  const { streams, artifacts, edges, cycleEdgeIds } = graph;

  if (!focus) {
    const hcount = edges.filter((e) => e.kind === "handoff").length;
    return (
      <div>
        <div style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)", marginBottom: 9 }}>relationship inspector</div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px", borderRadius: 8, background: "var(--bg-panel)", border: "1px dashed var(--border)" }}>
          <span style={{ fontSize: 18, opacity: 0.4 }}>⤚</span>
          <div>
            <div style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg-muted)" }}>Hover a stream to spotlight its relationships.</div>
            <div style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)", marginTop: 3 }}>
              Click to pin · click an artifact or edge to inspect it. {streams.length} streams · {artifacts.length} contracts · {hcount} handoffs.
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (focus.type === "art") {
    const a = artifacts.find((x) => x.id === focus.id);
    if (!a) return null;
    const ac = ARTIFACT_COLOR[a.kind], rdy = a.status === "ready";
    const ce = edges.filter((e) => e.kind === "handoff" && e.artifact === a.id);
    return (
      <div>
        <Head title={`contract:${a.id}`} sub={a.kind} c={ac} />
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <RelRow glyph="▲" c="var(--accent)" head={`produced by ${a.producer}`} detail={`publishes the ${a.kind} · status ${rdy ? "ready" : "pending"}`} onClick={() => onFocusAgent(a.producer)} />
          {a.consumers.map((c) => {
            const e = ce.find((x) => x.to === c);
            return <RelRow key={c} glyph="⤓" c="var(--accent)" head={`${c} consumes it`} detail={`bsc-blocked --on contract:${a.id}${e ? ` · ${hardLabel(e.hardness)} · via ${e.viaEff}` : ""}`} onClick={() => onFocusAgent(c)} />;
          })}
          <div style={{ fontFamily: mono, fontSize: 8.5, color: "var(--fg-dim)", marginTop: 2 }}>
            {rdy ? "● ready — parked consumers have been satisfied & woken." : `○ pending — consumers wait until ${a.producer} lands it.`}
          </div>
        </div>
      </div>
    );
  }

  if (focus.type === "edge") {
    const e = edges.find((x) => x.id === focus.id);
    if (!e) return null;
    const km = EDGE_KIND_META[e.kind], cyc = cycleEdgeIds.has(e.id);
    return (
      <div>
        <Head title={`${e.from} → ${e.to}`} sub={e.kind} c={cyc ? "var(--danger)" : km.color} />
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          <Pill text={km.label} c={km.color} />
          <Pill text={hardLabel(e.hardness)} c="var(--info)" />
          <Pill text={`via ${e.viaEff}`} c={e.viaEff === "director" ? DIRECTOR_COLOR : "var(--fg-muted)"} />
          {e.artifact && <Pill text={`contract:${e.artifact}`} c="var(--accent)" />}
        </div>
        <div style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-muted)", lineHeight: 1.6, padding: "8px 10px", borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border-soft)" }}>
          {runtimeNote(e)}
        </div>
        {cyc && <div style={{ fontFamily: mono, fontSize: 9, color: "var(--danger)", marginTop: 8 }}>⚠ part of a dependency cycle — this blocks the structure gate.</div>}
      </div>
    );
  }

  // agent
  const a = streams.find((s) => s.id === focus.id);
  if (!a) return null;
  const rc = ROLE_COLOR[a.role ?? ""] ?? "var(--fg-dim)";
  const produces = artifacts.filter((x) => x.producer === a.id);
  const consumes = artifacts.filter((x) => x.consumers.includes(a.id));
  const others = edges.filter((e) => (e.from === a.id || e.to === a.id) && e.kind !== "handoff");
  const rows: ReactNode[] = [];
  produces.forEach((x) => rows.push(<RelRow key={`p${x.id}`} glyph="▲" c="var(--accent)" head={`produces contract:${x.id}`} detail={`→ ${x.consumers.join(", ") || "no consumers"} · ${x.status === "ready" ? "ready" : "pending"}`} onClick={() => onInspectArtifact(x.id)} />));
  consumes.forEach((x) => {
    const e = edges.find((ed) => ed.from === x.producer && ed.to === a.id && ed.kind === "handoff");
    rows.push(<RelRow key={`co${x.id}`} glyph="⤓" c="var(--accent)" head={`waits on contract:${x.id}`} detail={`from ${x.producer} · ${e ? `${hardLabel(e.hardness)} · via ${e.viaEff}` : ""} · ${x.status === "ready" ? "satisfied" : "pending"}`} onClick={() => onInspectArtifact(x.id)} />);
  });
  others.forEach((e) => {
    const out = e.from === a.id, other = out ? e.to : e.from, km = EDGE_KIND_META[e.kind];
    let phrase: string;
    if (e.kind === "blocking") phrase = out ? `blocks ${other}` : `blocks on ${other}`;
    else if (e.kind === "sequence") phrase = out ? `runs before ${other}` : `runs after ${other}`;
    else if (e.kind === "shared") phrase = `co-owns interface with ${other}`;
    else if (e.kind === "mutex") phrase = `mutex (serialized) with ${other}`;
    else if (e.kind === "review") phrase = out ? `reviews ${other}` : `reviewed by ${other}`;
    else phrase = out ? `notifies ${other}` : `notified by ${other}`;
    rows.push(<RelRow key={`o${e.id}`} glyph={km.glyph} c={cycleEdgeIds.has(e.id) ? "var(--danger)" : km.color} head={phrase} detail={`${km.label} · ${hardLabel(e.hardness)} · via ${e.viaEff}`} onClick={() => onInspectEdge(e.id)} />);
  });
  return (
    <div>
      <Head title={a.id} sub={`${a.role ?? "stream"} · ⎇ ${a.repo ?? ""}`} c={rc} />
      {(a.owns?.length ?? 0) > 0 && (
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 11 }}>
          {a.owns!.map((o) => <span key={o} style={{ fontFamily: mono, fontSize: 8.5, padding: "1px 6px", borderRadius: 3, background: "var(--bg-elev)", border: "1px solid var(--border-soft)", color: "var(--fg-muted)" }}>{o}</span>)}
        </div>
      )}
      <div style={{ fontFamily: mono, fontSize: 9, textTransform: "uppercase", letterSpacing: ".08em", color: "var(--fg-dim)", marginBottom: 8 }}>relationships ({rows.length})</div>
      {rows.length ? <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{rows}</div> : <div style={{ fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)" }}>No cross-stream relationships.</div>}
    </div>
  );
}
