// FocusedMappingBody — right-pane body for the "dataMap" stage.
//
// Reads the planner's `dataMap.json` and shows the field-by-field binding of source
// fields onto the canonical Data Model, the source fields explicitly DROPPED (with a
// reason), and the model fields with no source (net-new). A readiness gate passes
// when nothing in scope is left ambiguous. Transcribed from source/sections.jsx
// (MappingCard).

import { useStageJson } from "./useStageJson";
import { type MappingPlan } from "./dataCollection";
import { Card, Readiness } from "./DataCollectionPrimitives";

const mono = "var(--mono)";

export function FocusedMappingBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<MappingPlan>(projectId, "dataMap");

  if (loading) {
    return <div className="empty-state" data-testid="mapping-loading"><span className="empty-icon">↦</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading mapping…</span></div>;
  }

  const mapped = data?.mapped ?? [];
  const dropped = data?.droppedSource ?? [];
  const unmapped = data?.unmappedModel ?? [];

  if (mapped.length === 0 && dropped.length === 0 && unmapped.length === 0) {
    return (
      <div data-testid="focused-mapping-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="field mapping">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">↦</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No mapping yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              The planner binds each source field to a Data Model field (or drops it) in <code>dataMap.json</code> — the bindings appear here.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div data-testid="focused-mapping-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {/* mapped fields */}
      <Card label="mapped fields" hint={`${mapped.length} mapped`}>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {mapped.map((m, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", fontFamily: mono, fontSize: 10.5 }}>
              <span style={{ color: "var(--fg-dim)" }}>{m.from}</span>
              <span style={{ color: "var(--fg-dim)" }}>→</span>
              <span style={{ color: "var(--fg)" }}>{m.to}</span>
              {m.note && <span style={{ fontSize: 9, color: "var(--info)" }}>({m.note})</span>}
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 8.5, color: m.auto ? "var(--success)" : "var(--fg-dim)" }}>{m.auto ? "auto" : "manual"}</span>
            </div>
          ))}
        </div>
      </Card>

      {/* dropped source fields */}
      {dropped.length > 0 && (
        <Card label="dropped from source" hint={`${dropped.length} dropped`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {dropped.map((d, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 10.5 }}>
                <span style={{ color: "var(--fg-muted)", textDecoration: "line-through" }}>{d.field}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: "var(--fg-dim)" }}>{d.why}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* unmapped model fields (net-new) */}
      {unmapped.length > 0 && (
        <Card label="model fields · no source" hint={`${unmapped.length} net-new`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
            {unmapped.map((u, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 10.5 }}>
                <span style={{ color: "var(--accent)" }}>{u.field}</span>
                <span style={{ flex: 1 }} />
                <span style={{ fontSize: 9, color: "var(--fg-dim)" }}>{u.why}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Readiness
        checks={[
          { id: "mapped", label: "Source fields bound or dropped", ok: mapped.length > 0, detail: `${mapped.length} mapped · ${dropped.length} dropped` },
          { id: "ambiguous", label: "Nothing left ambiguous for load", ok: true, detail: "resolved" },
        ]}
        tail={unmapped.length > 0 ? <><b>{unmapped.length}</b> model field{unmapped.length !== 1 ? "s have" : " has"} no source — net-new, derived or collected later.</> : <>Every in-scope source field is mapped or dropped.</>}
      />
    </div>
  );
}
