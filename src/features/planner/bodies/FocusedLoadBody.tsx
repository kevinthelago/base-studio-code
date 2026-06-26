// FocusedLoadBody — right-pane body for the "dataLoad" stage.
//
// Reads the planner's `dataLoad.json` and shows the load + reconcile plan the
// DIRECTOR runs: headline totals (rows · lineage · validation · conflicts), the
// source-precedence rule, a per-entity breakdown (rows / null% / valid% / sources /
// merge summary / conflict resolution), and the downstream artifacts + load issues.
// Transcribed from source/sections.jsx (LoadPreviewCard + DownstreamCard).

import { useStageJson } from "./useStageJson";
import { type LoadPlan, type LoadEntity } from "./dataCollection";
import { Card, Readiness } from "./bodyPrimitives";

const mono = "var(--mono)";

function Stat({ k, v, tone }: { k: string; v: string; tone?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span style={{ fontFamily: mono, fontSize: 14, color: tone ?? "var(--fg)" }}>{v}</span>
      <span style={{ fontFamily: mono, fontSize: 8.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-dim)" }}>{k}</span>
    </div>
  );
}

function EntityRow({ e }: { e: LoadEntity }) {
  return (
    <div style={{ padding: "7px 0", borderBottom: "1px solid var(--border-soft)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--sans)", fontSize: 12.5, fontWeight: 600, color: "var(--fg)" }}>{e.entity}</span>
        {e.rows && <span style={{ fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>{e.rows} rows</span>}
        <span style={{ flex: 1 }} />
        {(e.src ?? []).map((s) => (
          <span key={s} style={{ fontFamily: mono, fontSize: 8.5, padding: "1px 6px", borderRadius: 4, color: "var(--fg-muted)", background: "var(--bg-elev2)", border: "1px solid var(--border-soft)" }}>{s}</span>
        ))}
        {e.valid != null && <span style={{ fontFamily: mono, fontSize: 9.5, color: e.valid >= 98 ? "var(--success)" : "var(--accent)" }}>{e.valid}% valid</span>}
      </div>
      {(e.merged || e.conflict || e.note) && (
        <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", gap: 10, fontFamily: mono, fontSize: 9.5, color: "var(--fg-dim)" }}>
          {e.merged && <span>⤧ {e.merged}</span>}
          {e.conflict && <span style={{ color: "var(--accent)" }}>conflict: {e.conflict}</span>}
          {e.note && <span style={{ color: "var(--info)" }}>{e.note}</span>}
        </div>
      )}
    </div>
  );
}

export function FocusedLoadBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<LoadPlan>(projectId, "dataLoad");

  if (loading) {
    return <div className="empty-state" data-testid="load-loading"><span className="empty-icon">⤧</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading load plan…</span></div>;
  }

  const per = data?.per ?? [];

  if (per.length === 0) {
    return (
      <div data-testid="focused-load-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="load & reconcile">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">⤧</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No load plan yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              The director's merge-by-identity load plan — with lineage and conflict resolution — appears here once the planner writes <code>dataLoad.json</code>.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  const artifacts = data?.artifacts ?? [];
  const issues = data?.issues ?? [];

  return (
    <div data-testid="focused-load-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {/* headline */}
      <Card label="load preview" hint="runs at build">
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
          {data?.total != null && <Stat k="rows" v={data.total} />}
          {data?.entities != null && <Stat k="entities" v={String(data.entities)} />}
          {data?.lineage != null && <Stat k="lineage" v={`${data.lineage}%`} tone="var(--success)" />}
          {data?.validation != null && <Stat k="validation" v={`${data.validation}%`} tone={data.validation >= 98 ? "var(--success)" : "var(--accent)"} />}
          {data?.conflicts != null && <Stat k="conflicts" v={String(data.conflicts)} tone={data.conflicts ? "var(--accent)" : "var(--fg)"} />}
        </div>
        {(data?.precedence?.length ?? 0) > 0 && (
          <div style={{ marginTop: 10, fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>
            precedence (highest first): {data!.precedence!.join(" › ")}
          </div>
        )}
      </Card>

      {/* per-entity */}
      <Card label="per entity" hint="merge by identity key">
        <div>{per.map((e) => <EntityRow key={e.entity} e={e} />)}</div>
      </Card>

      {/* downstream artifacts */}
      {artifacts.length > 0 && (
        <Card label="generated at publish">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {artifacts.map((a, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 10.5 }}>
                <span>{a.glyph ?? "◆"}</span>
                <span style={{ color: "var(--fg)" }}>{a.name}</span>
                {a.detail && <span style={{ color: "var(--fg-dim)" }}>· {a.detail}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* load issues */}
      {issues.length > 0 && (
        <Card label="load issues" hint={`${issues.length} → board`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {issues.map((it, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 10.5 }}>
                <span style={{ color: "var(--fg-dim)" }}>☑</span>
                <span style={{ color: "var(--fg-muted)" }}>{it.t}</span>
                <span style={{ flex: 1 }} />
                {it.tag && <span style={{ fontSize: 8.5, padding: "1px 6px", borderRadius: 4, color: "var(--fg-dim)", border: "1px solid var(--border-soft)" }}>{it.tag}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <Readiness
        checks={[
          { id: "loaded", label: "Load verified against expectations", ok: (data?.validation ?? 0) >= 98, detail: data?.validation != null ? `${data.validation}% valid` : "—" },
          { id: "lineage", label: "Lineage recorded for every value", ok: (data?.lineage ?? 0) >= 100, detail: data?.lineage != null ? `${data.lineage}%` : "—" },
          { id: "conflicts", label: "Conflicts resolved by precedence", ok: !data?.conflicts || (data?.precedence?.length ?? 0) > 0, detail: data?.conflicts ? `${data.conflicts} via precedence` : "none" },
        ]}
        tail={<>The director merges by identity key with declared source precedence — every loaded value is auditable.</>}
      />
    </div>
  );
}
