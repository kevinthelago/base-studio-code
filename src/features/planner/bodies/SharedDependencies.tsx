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

const MONO = "var(--mono)";
const NPM = "#cb3837";
const ecoColor = (eco: string) => (eco === "cargo" ? "var(--warn)" : NPM);

/** A small pill. */
function pill(text: string, color: string, opts: { fs?: number; tint?: number } = {}) {
  const t = opts.tint ?? 86;
  return (
    <span style={{
      fontFamily: MONO, fontWeight: 600, fontSize: opts.fs ?? 8.5, color,
      background: `color-mix(in oklch, ${color}, transparent ${t}%)`,
      border: `1px solid color-mix(in oklch, ${color}, transparent ${t - 14}%)`,
      padding: "2px 6px", borderRadius: 4, whiteSpace: "nowrap",
    }}>{text}</span>
  );
}

function DepRow({ d, registries }: { d: StreamDependency; registries: Record<string, DependencyRegistry> }) {
  const isPrivate = !!(d.source && registries[d.source]);
  const verColor = d.version ? "var(--fg-dim)" : "var(--warn)";
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
      <span style={{
        flexShrink: 0, fontFamily: MONO, fontWeight: 600, fontSize: 8, color: isPrivate ? "var(--violet)" : ecoColor(d.ecosystem),
        background: `color-mix(in oklch, ${isPrivate ? "var(--violet)" : ecoColor(d.ecosystem)}, transparent 84%)`,
        border: `1px solid color-mix(in oklch, ${isPrivate ? "var(--violet)" : ecoColor(d.ecosystem)}, transparent 70%)`,
        padding: "2px 5px", borderRadius: 4,
      }}>{d.ecosystem}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 10.5, color: "var(--fg)" }}>{d.name}</span>
        <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 10.5, color: verColor }}>{d.version ? `@${d.version}` : "@latest"}</span>
        {d.sharedWith.length > 0 && <span style={{ marginLeft: 6 }}>{pill(`↔ shared · ${d.sharedWith.join(", ")}`, "var(--success)")}</span>}
        {isPrivate && <span style={{ marginLeft: 6 }}>{pill("private", "var(--violet)")}</span>}
        {d.dev && <span style={{ marginLeft: 6 }}>{pill("dev", "var(--violet)")}</span>}
        {d.why && <div style={{ fontFamily: "var(--sans)", fontWeight: 500, fontSize: 9.5, color: "var(--fg-dim)", marginTop: 1 }}>{d.why}</div>}
      </div>
    </div>
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
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 11 }}>
      <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--fg-dim)" }}>Shared dependencies</span>
      <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9, color: "var(--fg-dim)" }}>multi-stream repos only</span>
    </div>
  );

  if (views.length === 0) {
    return (
      <div style={{ padding: "14px 16px 20px", borderTop: "1px solid var(--border-soft)" }}>
        {label}
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "10px 12px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
          <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 11 }}>◴</span>
          <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9.5, color: "var(--fg-dim)" }}>Every repo has a single owner — nothing to pre-lock; deps stay agent-managed.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: "14px 16px 20px", borderTop: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", gap: 12 }}>
      {label}

      {views.map((v) => {
        const cloned = v.total === 0;
        return (
          <div key={v.repo}>
            <div style={{ background: "var(--bg-elev)", border: "1px solid var(--border)", borderRadius: 9, overflow: "hidden" }}>
              {/* repo header */}
              <div style={{ padding: 11, borderBottom: "1px solid var(--border-soft)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 11.5, color: "var(--fg)" }}>{v.repo}</span>
                  <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border)", padding: "2px 6px", borderRadius: 4 }}>{v.streams.length} streams</span>
                  <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9, color: "var(--fg-dim)" }}>→ reconcile to 1 lock</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: cloned ? "var(--warn)" : "var(--success)" }}>{cloned ? "!" : "🔒"}</span>
                </div>
                <div style={{ fontFamily: "var(--sans)", fontWeight: 500, fontSize: 9.5, lineHeight: 1.45, color: "var(--fg-dim)", marginTop: 6 }}>
                  {cloned
                    ? "Lock this repo's dependencies before the fleet runs — each stream declares its own, reconciled once so the streams sharing it never redefine them."
                    : "Each stream declares its own deps; reconciled once so the streams sharing this repo never redefine them."}
                </div>
                {/* registries */}
                {v.registries.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginTop: 9 }}>
                    <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 8, letterSpacing: ".08em", textTransform: "uppercase", color: "var(--fg-dim)" }}>registries</span>
                    {v.registries.map((g) => g.private
                      ? <span key={g.key}>{pill(`${g.url} · ${g.scope ?? ""} · auth ${g.auth ?? "—"}`, "var(--violet)", { tint: 86 })}</span>
                      : <span key={g.key}>{pill(`${g.name} · public`, NPM, { tint: 88 })}</span>)}
                  </div>
                )}
              </div>

              {/* per-stream */}
              {v.byStream.map((g, i) => {
                const c = colorOf(g.stream);
                const last = i === v.byStream.length - 1;
                return (
                  <div key={g.stream} style={{ padding: "10px 11px", borderBottom: last ? undefined : "1px solid var(--border-soft)" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: g.empty ? 0 : 9 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 2, background: c }} />
                      <span style={{ fontFamily: MONO, fontWeight: 600, fontSize: 10.5, color: "var(--fg)" }}>{nameOf(g.stream)}</span>
                      <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9, color: "var(--fg-dim)" }}>{g.empty ? "· orchestrates" : `· declares ${g.deps.length}`}</span>
                      {!g.empty && (
                        <span onClick={() => onAdd?.(v.repo, g.stream)} style={{ marginLeft: "auto", fontFamily: MONO, fontWeight: 600, fontSize: 9, color: "var(--fg-dim)", cursor: onAdd ? "pointer" : "default" }}>＋ add</span>
                      )}
                    </div>
                    {g.empty ? (
                      <div style={{ fontFamily: "var(--sans)", fontWeight: 500, fontSize: 9.5, color: "var(--fg-dim)", paddingLeft: 15, borderLeft: `1px solid color-mix(in oklch, ${c}, transparent 80%)` }}>
                        No build deps — owns the reconciled lock for this repo.
                      </div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 15, borderLeft: `1px solid color-mix(in oklch, ${c}, transparent 80%)` }}>
                        {g.deps.map((d, j) => <DepRow key={d.name + j} d={d} registries={registries} />)}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ fontFamily: "var(--sans)", fontWeight: 500, fontSize: 9.5, lineHeight: 1.5, color: "var(--fg-dim)", marginTop: 9, padding: "0 2px" }}>
              Per-stream deps reconcile into the repo's single <span style={{ fontFamily: MONO, color: "var(--fg-muted)" }}>package.json</span> / <span style={{ fontFamily: MONO, color: "var(--fg-muted)" }}>Cargo.toml</span> and are inlined into every agent on the repo.
            </div>
          </div>
        );
      })}

      {/* single-owner repos note */}
      {singleOwner.map(([repo, streams]) => (
        <div key={repo} style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 10px", background: "var(--bg-elev)", border: "1px solid var(--border-soft)", borderRadius: 7 }}>
          <span style={{ color: "var(--fg-dim)", fontFamily: MONO, fontSize: 11 }}>◴</span>
          <span style={{ fontFamily: MONO, fontWeight: 500, fontSize: 9.5, color: "var(--fg-dim)" }}>{repo} has a single owner ({nameOf(streams[0])}) — its deps stay agent-managed.</span>
        </div>
      ))}
    </div>
  );
}
