// Shared dependencies — the Streams pane's per-repo → per-stream dependency surface (#1429).
//
// When 2+ streams build the same repo, each declares its own deps and they reconcile into the repo's
// single lock; this section shows them per stream, flags the cross-stream version-locks, and lists
// the repo's registries. Single-owner repos are omitted (their deps stay agent-managed). Pure
// presentational — reads the fleet streams (data.agents) + the locked manifest (dependencies +
// registries) and computes the view via sharedRepoDependencies(). Design: design/Claude Design
// kickoff — Streams pane/Streams Pane.dc.html §6.

import {
  sharedRepoDependencies, type PlanDependency, type DependencyRegistry, type StreamDependency,
} from "../issues/dependencies";
import type { Agent } from "../pane/projectPane.types";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

const MONO = "var(--mono)";
const NPM = "#cb3837";
const ecoColor = (eco: string) => (eco === "cargo" ? "var(--warn)" : NPM);

/** A small pill. */
function pill(text: string, color: string, opts: { fs?: number; tint?: number } = {}) {
  const t = opts.tint ?? 86;
  return (
    <Box as="span" style={{
      fontFamily: MONO, fontWeight: 600, fontSize: opts.fs ?? 8.5, color,
      background: `color-mix(in oklch, ${color}, transparent ${t}%)`,
      border: `1px solid color-mix(in oklch, ${color}, transparent ${t - 14}%)`,
      padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap",
    }}>{text}</Box>
  );
}

function DepRow({ d, registries }: { d: StreamDependency; registries: Record<string, DependencyRegistry> }) {
  const isPrivate = !!(d.source && registries[d.source]);
  const verColor = d.version ? "var(--fg-dim)" : "var(--warn)";
  return (
    <Row align="baseline" gap={8}>
      <Box as="span" style={{
        flexShrink: 0, fontFamily: MONO, fontWeight: 600, fontSize: 8, color: isPrivate ? "var(--violet)" : ecoColor(d.ecosystem),
        background: `color-mix(in oklch, ${isPrivate ? "var(--violet)" : ecoColor(d.ecosystem)}, transparent 84%)`,
        border: `1px solid color-mix(in oklch, ${isPrivate ? "var(--violet)" : ecoColor(d.ecosystem)}, transparent 70%)`,
        padding: "2px 5px", borderRadius: 4,
      }}>{d.ecosystem}</Box>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text mono weight={600} size={10.5} style={{ color: "var(--fg)" }}>{d.name}</Text>
        <Text mono weight={500} size={10.5} style={{ color: verColor }}>{d.version ? `@${d.version}` : "@latest"}</Text>
        {d.sharedWith.length > 0 && <Box as="span" style={{ marginLeft: 6 }}>{pill(`↔ shared · ${d.sharedWith.join(", ")}`, "var(--success)")}</Box>}
        {isPrivate && <Box as="span" style={{ marginLeft: 6 }}>{pill("private", "var(--violet)")}</Box>}
        {d.dev && <Box as="span" style={{ marginLeft: 6 }}>{pill("dev", "var(--violet)")}</Box>}
        {d.why && <Text as="div" weight={500} size={9.5} tone="dim" style={{ fontFamily: "var(--sans)", marginTop: 1 }}>{d.why}</Text>}
      </Box>
    </Row>
  );
}

export function SharedDependenciesSection({ agents, dependencies = [], registries = {}, onAdd }: {
  agents?: Agent[];
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
  /** Add a dep to a (repo, stream) — opens the planner-side flow. Optional. */
  onAdd?: (repo: string, stream: string) => void;
}) {
  const list = agents ?? [];
  // repo → the streams building it (from the fleet).
  const repoStreams: Record<string, string[]> = {};
  for (const a of list) { if (a.repo) (repoStreams[a.repo] ??= []).push(a.id ?? a.name); }
  const colorOf = (id: string) => list.find((a) => (a.id ?? a.name) === id)?.color ?? "var(--fg-dim)";
  const nameOf = (id: string) => list.find((a) => (a.id ?? a.name) === id)?.name ?? id;

  const views = sharedRepoDependencies(dependencies, registries, repoStreams);
  const singleOwner = Object.entries(repoStreams).filter(([, s]) => s.length === 1);

  const label = (
    <Row justify="between" style={{ marginBottom: 11 }}>
      <Text mono weight={600} size={9.5} tone="dim" style={{ letterSpacing: ".14em", textTransform: "uppercase" }}>Shared dependencies</Text>
      <Text mono weight={500} size={9} tone="dim">multi-stream repos only</Text>
    </Row>
  );

  if (views.length === 0) {
    return (
      <Box style={{ padding: "14px 0 20px", borderTop: "1px solid var(--border-soft)" }}>
        {label}
        <Row gap={7} style={{ padding: "10px 12px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
          <Text mono size={11} tone="dim">◴</Text>
          <Text mono weight={500} size={9.5} tone="dim">Every repo has a single owner — nothing to pre-lock; deps stay agent-managed.</Text>
        </Row>
      </Box>
    );
  }

  return (
    <Stack gap={12} style={{ padding: "14px 0 20px", borderTop: "1px solid var(--border-soft)" }}>
      {label}

      {views.map((v) => {
        const cloned = v.total === 0;
        return (
          <Box key={v.repo}>
            <Box style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
              {/* repo header */}
              <Box style={{ padding: 11, borderBottom: "1px solid var(--border-soft)" }}>
                <Row gap={8}>
                  <Text mono weight={600} size={11.5} style={{ color: "var(--fg)" }}>{v.repo}</Text>
                  <Box as="span" style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border)", padding: "2px 6px", borderRadius: 4 }}>{v.streams.length} streams</Box>
                  <Text mono weight={500} size={9} tone="dim">→ reconcile to 1 lock</Text>
                  <Text size={11} style={{ marginLeft: "auto", color: cloned ? "var(--warn)" : "var(--success)" }}>{cloned ? "!" : "🔒"}</Text>
                </Row>
                <Text as="div" weight={500} size={9.5} tone="dim" style={{ fontFamily: "var(--sans)", lineHeight: 1.45, marginTop: 6 }}>
                  {cloned
                    ? "Lock this repo's dependencies before the fleet runs — each stream declares its own, reconciled once so the streams sharing it never redefine them."
                    : "Each stream declares its own deps; reconciled once so the streams sharing this repo never redefine them."}
                </Text>
                {/* registries */}
                {v.registries.length > 0 && (
                  <Row wrap gap={6} style={{ marginTop: 9 }}>
                    <Text mono weight={600} size={8} tone="dim" style={{ letterSpacing: ".08em", textTransform: "uppercase" }}>registries</Text>
                    {v.registries.map((g) => g.private
                      ? <Box as="span" key={g.key}>{pill(`${g.url} · ${g.scope ?? ""} · auth ${g.auth ?? "—"}`, "var(--violet)", { tint: 86 })}</Box>
                      : <Box as="span" key={g.key}>{pill(`${g.name} · public`, NPM, { tint: 88 })}</Box>)}
                  </Row>
                )}
              </Box>

              {/* per-stream */}
              {v.byStream.map((g, i) => {
                const c = colorOf(g.stream);
                const last = i === v.byStream.length - 1;
                return (
                  <Box key={g.stream} style={{ padding: "10px 11px", borderBottom: last ? undefined : "1px solid var(--border-soft)" }}>
                    <Row gap={7} style={{ marginBottom: g.empty ? 0 : 9 }}>
                      <Box as="span" style={{ width: 7, height: 7, borderRadius: 2, background: c }} />
                      <Text mono weight={600} size={10.5} style={{ color: "var(--fg)" }}>{nameOf(g.stream)}</Text>
                      <Text mono weight={500} size={9} tone="dim">{g.empty ? "· orchestrates" : `· declares ${g.deps.length}`}</Text>
                      {!g.empty && (
                        <Text mono weight={600} size={9} tone="dim" onClick={() => onAdd?.(v.repo, g.stream)} style={{ marginLeft: "auto", cursor: onAdd ? "pointer" : "default" }}>＋ add</Text>
                      )}
                    </Row>
                    {g.empty ? (
                      <Text as="div" weight={500} size={9.5} tone="dim" style={{ fontFamily: "var(--sans)", paddingLeft: 15, borderLeft: `1px solid color-mix(in oklch, ${c}, transparent 80%)` }}>
                        No build deps — owns the reconciled lock for this repo.
                      </Text>
                    ) : (
                      <Stack gap={8} style={{ paddingLeft: 15, borderLeft: `1px solid color-mix(in oklch, ${c}, transparent 80%)` }}>
                        {g.deps.map((d, j) => <DepRow key={d.name + j} d={d} registries={registries} />)}
                      </Stack>
                    )}
                  </Box>
                );
              })}
            </Box>
            <Text as="div" weight={500} size={9.5} tone="dim" style={{ fontFamily: "var(--sans)", lineHeight: 1.5, marginTop: 9, padding: "0 2px" }}>
              Per-stream deps reconcile into the repo's single <Text mono tone="muted">package.json</Text> / <Text mono tone="muted">Cargo.toml</Text> and are inlined into every agent on the repo.
            </Text>
          </Box>
        );
      })}

      {/* single-owner repos note */}
      {singleOwner.map(([repo, streams]) => (
        <Row key={repo} gap={7} style={{ padding: "8px 10px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
          <Text mono size={11} tone="dim">◴</Text>
          <Text mono weight={500} size={9.5} tone="dim">{repo} has a single owner ({nameOf(streams[0])}) — its deps stay agent-managed.</Text>
        </Row>
      ))}
    </Stack>
  );
}
