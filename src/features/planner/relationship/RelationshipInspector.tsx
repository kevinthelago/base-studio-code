// RelationshipInspector — the detail panel under the swimlane graph. Spells out the
// focused stream / edge / artifact's relationships in words, with the runtime mechanism
// for each (the coord ref it blocks on, hardness, via). Ported from design/bsc ·
// Agent Relationships - Swimlanes · inspector().

import type { ReactNode } from "react";
import { Chip } from "@/shared/ui/data/Chip";
import { ColorSwatch } from "@/shared/ui/controls/ColorSwatch";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import {
  EDGE_KIND_META, ARTIFACT_COLOR, ROLE_COLOR, DIRECTOR_COLOR, hardLabel, runtimeNote,
  type RelationshipGraph, type RelFocus,
} from "./relationshipGraph";

const mono = "var(--mono)";

// Folded onto the shared color-mix Chip (#2160) — radius 99, no fontWeight; the knobs reproduce it exactly.
function Pill({ text, c }: { text: string; c: string }) {
  return (
    <Chip color={c} bgAlpha={86} borderAlpha={62} fontSize={8} padding="1px 7px" style={{ whiteSpace: "nowrap" }}>{text}</Chip>
  );
}

function RelRow({ glyph, c, head, detail, onClick }: { glyph: string; c: string; head: string; detail?: ReactNode; onClick?: () => void }) {
  return (
    <Row onClick={onClick} gap={9} align="baseline" style={{ padding: "6px 9px", borderRadius: 6, background: "var(--bg-panel)", border: "1px solid var(--border-soft)", cursor: onClick ? "pointer" : "default" }}>
      <Box as="span" style={{ flex: "0 0 16px", textAlign: "center", fontFamily: mono, fontSize: 11, color: c }}>{glyph}</Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text as="div" size={10.5} style={{ fontFamily: mono, color: "var(--fg)" }}>{head}</Text>
        {detail && <Text as="div" size={8.5} tone="dim" style={{ fontFamily: mono, marginTop: 2, lineHeight: 1.45 }}>{detail}</Text>}
      </Box>
    </Row>
  );
}

function Head({ title, sub, c }: { title: string; sub?: string; c?: string }) {
  return (
    <Row gap={9} style={{ marginBottom: 11 }}>
      <ColorSwatch color={c ?? "var(--accent)"} size={8} />
      <Text as="span" size={12.5} weight={600} style={{ fontFamily: mono, color: "var(--fg)" }}>{title}</Text>
      {sub && <Text as="span" size={9} tone="dim" style={{ fontFamily: mono }}>{sub}</Text>}
    </Row>
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
      <Box>
        <Text as="div" size={9} tone="dim" style={{ fontFamily: mono, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 9 }}>relationship inspector</Text>
        <Row gap={10} style={{ padding: "14px", borderRadius: 8, background: "var(--bg-panel)", border: "1px dashed var(--border)" }}>
          <Text as="span" size={18} style={{ opacity: 0.4 }}>⤚</Text>
          <Box>
            <Text as="div" size={10.5} tone="muted" style={{ fontFamily: mono }}>Hover a stream to spotlight its relationships.</Text>
            <Text as="div" size={9} tone="dim" style={{ fontFamily: mono, marginTop: 3 }}>
              Click to pin · click an artifact or edge to inspect it. {streams.length} streams · {artifacts.length} contracts · {hcount} handoffs.
            </Text>
          </Box>
        </Row>
      </Box>
    );
  }

  if (focus.type === "art") {
    const a = artifacts.find((x) => x.id === focus.id);
    if (!a) return null;
    const ac = ARTIFACT_COLOR[a.kind], rdy = a.status === "ready";
    const ce = edges.filter((e) => e.kind === "handoff" && e.artifact === a.id);
    return (
      <Box>
        <Head title={`contract:${a.id}`} sub={a.kind} c={ac} />
        <Stack gap={6}>
          <RelRow glyph="▲" c="var(--accent)" head={`produced by ${a.producer}`} detail={`publishes the ${a.kind} · status ${rdy ? "ready" : "pending"}`} onClick={() => onFocusAgent(a.producer)} />
          {a.consumers.map((c) => {
            const e = ce.find((x) => x.to === c);
            return <RelRow key={c} glyph="⤓" c="var(--accent)" head={`${c} consumes it`} detail={`held at launch until contract:${a.id} lands${e ? ` · ${hardLabel(e.hardness)} · via ${e.viaEff}` : ""}`} onClick={() => onFocusAgent(c)} />;
          })}
          <Text as="div" size={8.5} tone="dim" style={{ fontFamily: mono, marginTop: 2 }}>
            {rdy ? "● ready — parked consumers have been satisfied & woken." : `○ pending — consumers wait until ${a.producer} lands it.`}
          </Text>
        </Stack>
      </Box>
    );
  }

  if (focus.type === "edge") {
    const e = edges.find((x) => x.id === focus.id);
    if (!e) return null;
    const km = EDGE_KIND_META[e.kind], cyc = cycleEdgeIds.has(e.id);
    return (
      <Box>
        <Head title={`${e.from} → ${e.to}`} sub={e.kind} c={cyc ? "var(--danger)" : km.color} />
        <Row gap={6} wrap align="stretch" style={{ marginBottom: 10 }}>
          <Pill text={km.label} c={km.color} />
          <Pill text={hardLabel(e.hardness)} c="var(--info)" />
          <Pill text={`via ${e.viaEff}`} c={e.viaEff === "director" ? DIRECTOR_COLOR : "var(--fg-muted)"} />
          {e.artifact && <Pill text={`contract:${e.artifact}`} c="var(--accent)" />}
        </Row>
        <Box pad={[8, 10]} bg="var(--bg-panel)" border="soft" radius={6} style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-muted)", lineHeight: 1.6}}>
          {runtimeNote(e)}
        </Box>
        {cyc && <Text as="div" size={9} tone="danger" style={{ fontFamily: mono, marginTop: 8 }}>⚠ part of a dependency cycle — this blocks the structure gate.</Text>}
      </Box>
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
    <Box>
      <Head title={a.id} sub={`${a.role ?? "stream"} · ⎇ ${a.repo ?? ""}`} c={rc} />
      {(a.owns?.length ?? 0) > 0 && (
        <Row gap={5} wrap align="stretch" style={{ marginBottom: 11 }}>
          {a.owns!.map((o) => <Box as="span" key={o} pad={[1, 6]} bg="var(--bg-elev)" border="soft" radius={3} style={{ fontFamily: mono, fontSize: 8.5, color: "var(--fg-muted)" }}>{o}</Box>)}
        </Row>
      )}
      <Text as="div" size={9} tone="dim" style={{ fontFamily: mono, textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 8 }}>relationships ({rows.length})</Text>
      {rows.length ? <Stack gap={6}>{rows}</Stack> : <Text as="div" size={9.5} tone="dim" style={{ fontFamily: mono }}>No cross-stream relationships.</Text>}
    </Box>
  );
}
