// FocusedTargetsBody — right-pane body for the "collectTargets" stage.
//
// Reads the planner's declared `collectTargets.json` and shows the external sources
// to collect from (scrape/fetch), their per-source scope, the bound Data Model, and
// a readiness gate (≥1 source declared + Data Model bound). Transcribed from the
// design prototype (collection/panes.jsx · TargetsPane).

import { useStageJson } from "./useStageJson";
import { modeSummary, type CollectTargets } from "./dataCollection";
import { Card, EntityChip, SourceHead, Readiness, Kv } from "./DataCollectionPrimitives";

const mono = "var(--mono)";

export function FocusedTargetsBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<CollectTargets>(projectId, "collectTargets");

  if (loading) {
    return <div className="empty-state" data-testid="targets-loading"><span className="empty-icon">◎</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading targets…</span></div>;
  }

  const sources = data?.sources ?? [];
  const dm = data?.dataModel ?? null;
  const bound = !!dm;

  if (sources.length === 0) {
    return (
      <div data-testid="focused-targets-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="sources">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">🎯</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No sources declared yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 360, textAlign: "center", lineHeight: 1.5 }}>
              The planner declares the external sites, APIs, and datasets this project collects from — they appear here once it writes <code>collectTargets.json</code>.
            </span>
          </div>
        </Card>
        <Readiness checks={[
          { id: "src", label: "At least one source declared", ok: false, detail: "0 sources" },
          { id: "dm", label: "Data Model bound", ok: false, detail: "none" },
        ]} />
      </div>
    );
  }

  return (
    <div data-testid="focused-targets-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {/* declared sources */}
      <Card label="sources" hint={modeSummary(sources)}>
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          {sources.map((s) => (
            <div key={s.id}>
              <SourceHead s={s} />
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5, flexWrap: "wrap" }}>
                {s.type && <span style={{ padding: "1px 6px", borderRadius: 4, fontFamily: mono, fontSize: 9, color: "var(--fg-dim)", background: "var(--bg-elev)", border: "1px solid var(--border-soft)" }}>{s.type}</span>}
                {(s.feeds?.length ?? 0) > 0 && <span style={{ fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)" }}>feeds</span>}
                {s.feeds?.map((f) => <EntityChip key={f} name={f} />)}
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* per-source scope */}
      <Card label="scope per source" hint="keep the crawl / fetch bounded">
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {sources.map((s) => (
            <div key={s.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 7 }}>
                <span style={{ fontFamily: "var(--sans)", fontSize: 12, fontWeight: 600, color: "var(--fg)" }}>{s.label}</span>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                <Kv k={s.mode === "scrape" ? "start" : "query"} v={s.scope?.start} />
                <Kv k={s.mode === "scrape" ? "pattern" : "paging"} v={s.scope?.pattern} />
                <Kv k="cap" v={s.scope?.bound} />
              </div>
            </div>
          ))}
        </div>
      </Card>

      {/* bound Data Model */}
      <Card
        label="target data model"
        badge={<span style={{ fontFamily: mono, fontSize: 9, color: bound ? "var(--success)" : "var(--accent)" }}>{bound ? "✓ bound" : "not bound"}</span>}
      >
        {bound && dm ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg)" }}>◆ {dm.name}</span>
            <span style={{ color: "var(--fg-dim)" }}>·</span>
            {dm.entities.map((e) => (
              <span key={e.name} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <EntityChip name={e.name} />
                <span style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)" }}>{e.fields.length}f</span>
              </span>
            ))}
          </div>
        ) : (
          <div style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)" }}>
            Sources declared, but no Data Model bound yet — bind one in the Model stage to continue.
          </div>
        )}
      </Card>

      <Readiness
        checks={[
          { id: "src", label: "At least one source declared", ok: true, detail: `${sources.length} sources` },
          { id: "dm", label: "Data Model bound", ok: bound, detail: bound && dm ? dm.name : "none" },
        ]}
        tail={<><b>{modeSummary(sources)}</b>{dm ? <> → the {dm.name} Data Model.</> : "."}</>}
      />
    </div>
  );
}
