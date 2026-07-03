// Shared dependencies — the FOCUSED stream's slice of the per-repo → per-stream dependency surface
// (#1429 / #2191). Formerly a fleet-wide section listing every shared repo; now scoped to the one
// focused stream and shown inside its inspector card stack (StreamFocusCards). For the focused
// stream it answers: is my repo shared (built by 2+ streams), with WHICH other streams, and what deps
// do *I* declare (with the cross-stream version-locks) + the repo's registries. A single-owner repo
// gets a one-line note (deps stay agent-managed). Pure presentational — reads the fleet streams
// (data.agents) + the locked manifest (dependencies + registries) and computes via
// sharedRepoDependencies(). Design: design/Streams Pane Redesign/Streams Pane.dc.html.

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
    <Box as="span" pad={[2, 6]} bg={`color-mix(in oklch, ${color}, transparent ${t}%)`} radius={4} style={{
      fontFamily: MONO, fontWeight: 600, fontSize: opts.fs ?? 8.5, color,
      border: `1px solid color-mix(in oklch, ${color}, transparent ${t - 14}%)`, whiteSpace: "nowrap",
    }}>{text}</Box>
  );
}

/** One declared dependency + the cross-stream version-lock it participates in. */
function DepRow({ d, registries }: { d: StreamDependency; registries: Record<string, DependencyRegistry> }) {
  const isPrivate = !!(d.source && registries[d.source]);
  const verColor = d.version ? "var(--fg-dim)" : "var(--warn)";
  return (
    <Row align="baseline" gap={8}>
      <Box as="span" pad={[2, 5]} bg={`color-mix(in oklch, ${isPrivate ? "var(--violet)" : ecoColor(d.ecosystem)}, transparent 84%)`} radius={4} style={{
        flexShrink: 0, fontFamily: MONO, fontWeight: 600, fontSize: 8, color: isPrivate ? "var(--violet)" : ecoColor(d.ecosystem),
        border: `1px solid color-mix(in oklch, ${isPrivate ? "var(--violet)" : ecoColor(d.ecosystem)}, transparent 70%)`,
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

/** The focused stream's shared-dependency slice (#2191). Rendered inside the stream inspector's
 *  "Shared dependencies" card. `a` is the focused stream; `agents` is the whole fleet (to detect which
 *  streams share the repo); `dependencies` + `registries` are the locked manifest. */
export function StreamSharedDeps({ a, agents = [], dependencies = [], registries = {} }: {
  a: Agent;
  agents?: Agent[];
  dependencies?: PlanDependency[];
  registries?: Record<string, DependencyRegistry>;
}) {
  // repo → the streams building it (from the fleet), keyed the same way sharedRepoDependencies expects.
  const repoStreams: Record<string, string[]> = {};
  for (const s of agents) { if (s.repo) (repoStreams[s.repo] ??= []).push(s.id ?? s.name); }
  const nameOf = (id: string) => agents.find((x) => (x.id ?? x.name) === id)?.name ?? id;

  const view = sharedRepoDependencies(dependencies, registries, repoStreams).find((v) => v.repo === a.repo);

  // Single-owner (or unbuilt) repo — nothing to reconcile; this stream owns its deps outright.
  if (!view) {
    return (
      <Row gap={7} style={{ padding: "8px 10px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
        <Text mono size={11} tone="dim">◴</Text>
        <Text mono weight={500} size={9.5} tone="dim">
          {a.repo ? `${a.repo} is yours alone — its deps stay agent-managed.` : "No repo assigned to this stream."}
        </Text>
      </Row>
    );
  }

  const me = a.id ?? a.name;
  const others = view.streams.filter((s) => s !== me).map(nameOf);
  const mine = view.byStream.find((g) => g.stream === me);

  return (
    <Stack gap={11}>
      {/* which repo, and who this stream shares it with */}
      <Row gap={8} wrap align="baseline">
        <Text mono weight={600} size={11} style={{ color: "var(--fg)" }}>{view.repo}</Text>
        <Box as="span" pad={[2, 6]} bg="var(--bg-elev2)" border radius={4} style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9, color: "var(--fg-muted)" }}>{view.streams.length} streams</Box>
        {others.length > 0 && <Text mono weight={500} size={9.5} tone="dim">shared with {others.join(", ")}</Text>}
      </Row>

      {/* registries the repo's deps reference */}
      {view.registries.length > 0 && (
        <Row wrap gap={6} align="center">
          <Text mono weight={600} size={8} tone="dim" style={{ letterSpacing: ".08em", textTransform: "uppercase" }}>registries</Text>
          {view.registries.map((g) => g.private
            ? <Box as="span" key={g.key}>{pill(`${g.url} · ${g.scope ?? ""} · auth ${g.auth ?? "—"}`, "var(--violet)", { tint: 86 })}</Box>
            : <Box as="span" key={g.key}>{pill(`${g.name} · public`, NPM, { tint: 88 })}</Box>)}
        </Row>
      )}

      {/* THIS stream's declared deps (or the orchestrator/empty note) */}
      {!mine || mine.empty ? (
        <Text as="div" mono weight={500} size={9.5} tone="dim" style={{ lineHeight: 1.5 }}>
          No build deps of your own — you hold the reconciled lock for this repo.
        </Text>
      ) : (
        <Stack gap={8} style={{ paddingLeft: 12, borderLeft: `1px solid color-mix(in oklch, ${a.color ?? "var(--accent)"}, transparent 80%)` }}>
          {mine.deps.map((d, j) => <DepRow key={d.name + j} d={d} registries={registries} />)}
        </Stack>
      )}

      <Text as="div" weight={500} size={9.5} tone="dim" style={{ fontFamily: "var(--sans)", lineHeight: 1.5 }}>
        Per-stream deps reconcile into the repo's single <Text mono tone="muted">package.json</Text> / <Text mono tone="muted">Cargo.toml</Text> and are inlined into every agent on the repo.
      </Text>
    </Stack>
  );
}
