// FocusedExtractBody — right-pane body for the "dataExtract" stage.
//
// Reads the planner's `dataExtract.json` and shows, per source, the extraction
// rules (selector/path → Data Model field), the unmapped-field gaps, a sample
// extraction preview, and coverage — plus a readiness gate. Transcribed from
// collection/panes.jsx · ExtractPane.

import { useStageJson } from "./useStageJson";
import { type ExtractPlan, type ExtractSource } from "./dataCollection";
import { Card, ModeChip, EntityChip, Readiness } from "./DataCollectionPrimitives";

const mono = "var(--mono)";

function RulesCard({ s }: { s: ExtractSource }) {
  const kind = s.kind ?? "HTML";
  return (
    <Card
      label={`${kind.toLowerCase()} rules · ${s.label}`}
      badge={<ModeChip mode={s.mode} />}
      hint={s.artifact ? `artifact ${s.artifact}` : undefined}
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", gap: 8, fontFamily: mono, fontSize: 8.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--fg-dim)" }}>
          <span>{kind === "HTML" ? "selector" : "path"}</span>
          <span style={{ flex: 1 }} />
          <span>→ model field</span>
        </div>
        {s.rules.map((r, i) => {
          const gap = r.ok === false;
          const fieldName = r.field.includes(".") ? r.field.split(".")[1] : r.field;
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0", opacity: gap ? 0.85 : 1 }}>
              <span style={{ fontFamily: mono, fontSize: 10.5, color: gap ? "var(--accent)" : "var(--fg-muted)" }}>{r.sel}</span>
              <span style={{ color: "var(--fg-dim)" }}>→</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <EntityChip name={r.entity} />
                <span style={{ fontFamily: mono, fontSize: 10, color: "var(--fg)" }}>.{fieldName}</span>
                {r.ref && <span style={{ fontFamily: mono, fontSize: 8.5, color: "var(--info)" }}>ref → {r.ref}</span>}
              </span>
              <span style={{ flex: 1 }} />
              {gap && <span style={{ fontFamily: mono, fontSize: 8.5, padding: "1px 6px", borderRadius: 4, color: "var(--accent)", border: "1px solid var(--accent-dim)" }}>no match</span>}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export function FocusedExtractBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<ExtractPlan>(projectId, "dataExtract");

  if (loading) {
    return <div className="empty-state" data-testid="extract-loading"><span className="empty-icon">⛏</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading extraction…</span></div>;
  }

  const sources = data?.sources ?? [];

  if (sources.length === 0) {
    return (
      <div data-testid="focused-extract-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="per-source extraction rules">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">⛏</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No extraction rules yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              Once raw artifacts are captured, the planner maps their elements to the Data Model in <code>dataExtract.json</code> — the rules appear here.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  const gaps = data?.gaps;
  const sample = data?.sample;
  const cov = data?.coverage;
  const unmappedModel = gaps?.unmappedModel ?? [];
  const unmappedSource = gaps?.unmappedSource ?? [];
  const totalGaps = unmappedModel.length + unmappedSource.length;
  const covPct = cov?.pct ?? (cov && cov.total ? Math.round(((cov.parsed ?? 0) / cov.total) * 1000) / 10 : undefined);

  return (
    <div data-testid="focused-extract-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {sources.map((s) => <RulesCard key={s.id} s={s} />)}

      {/* field-mapping gaps */}
      {(unmappedModel.length > 0 || unmappedSource.length > 0) && (
        <Card label="field mapping" hint={`${totalGaps} gap${totalGaps !== 1 ? "s" : ""}`}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <div>
              <div style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)", marginBottom: 5 }}>model fields · no source ({unmappedModel.length})</div>
              {unmappedModel.map((g, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontFamily: mono, fontSize: 10, marginBottom: 3 }}>
                  <span style={{ color: "var(--fg-muted)" }}>{g.field}</span><span style={{ flex: 1 }} /><span style={{ color: "var(--fg-dim)" }}>{g.why}</span>
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)", marginBottom: 5 }}>source elements · unmapped ({unmappedSource.length})</div>
              {unmappedSource.map((g, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontFamily: mono, fontSize: 10, marginBottom: 3 }}>
                  <span style={{ color: "var(--fg-muted)" }}>{g.sel}</span><span style={{ flex: 1 }} /><span style={{ color: "var(--fg-dim)" }}>{g.why}</span>
                </div>
              ))}
            </div>
          </div>
        </Card>
      )}

      {/* sample preview */}
      {sample && sample.cols.length > 0 && (
        <Card label="sample extraction preview" accent badge={<span style={{ fontFamily: mono, fontSize: 9, color: "var(--fg-dim)" }}>ran on a sampled artifact</span>}>
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: mono, fontSize: 10 }}>
              <thead>
                <tr>{sample.cols.map((c) => (
                  <th key={c} style={{ textAlign: "left", padding: "4px 8px", color: "var(--fg-dim)", borderBottom: "1px solid var(--border-soft)", fontWeight: 500 }}>{c}</th>
                ))}</tr>
              </thead>
              <tbody>
                {sample.rows.map((row, i) => (
                  <tr key={i}>{sample.cols.map((c) => {
                    const v = row[c];
                    const miss = v == null || v === "";
                    return <td key={c} style={{ padding: "4px 8px", color: miss ? "var(--accent)" : "var(--fg-muted)", borderBottom: "1px solid var(--border-soft)" }}>{miss ? "—" : v}</td>;
                  })}</tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 6, fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>
            {`${sample.rows.length} rows produced`}
          </div>
        </Card>
      )}

      {/* coverage */}
      {cov && (
        <Card label="coverage">
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ display: "flex", flexDirection: "column" }}>
              <span style={{ fontFamily: mono, fontSize: 13, color: "var(--fg)" }}>{cov.parsed ?? "—"}/{cov.total ?? "—"}</span>
              <span style={{ fontFamily: mono, fontSize: 8.5, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>parsed</span>
            </span>
            <span style={{ flex: 1, height: 5, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden" }}>
              <span style={{ display: "block", height: "100%", width: `${covPct ?? 0}%`, background: (covPct ?? 0) >= 95 ? "var(--success)" : "var(--accent)" }} />
            </span>
            {covPct != null && <span style={{ fontFamily: mono, fontSize: 10, color: (covPct >= 95) ? "var(--success)" : "var(--accent)" }}>{covPct}%</span>}
          </div>
          {(cov.gaps ?? []).map((g, i) => (
            <div key={i} style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 10, color: "var(--fg-dim)" }}>
              <span style={{ fontSize: 8.5, padding: "1px 6px", borderRadius: 4, color: "var(--accent)", border: "1px solid var(--accent-dim)" }}>field gap</span>
              {g.field} — {g.why}
            </div>
          ))}
        </Card>
      )}

      <Readiness
        checks={[
          { id: "rules", label: "Extraction rules defined per source", ok: true, detail: `${sources.length} source${sources.length !== 1 ? "s" : ""}` },
          { id: "map", label: "Field mapping resolved", ok: totalGaps === 0, detail: `${totalGaps} gap${totalGaps !== 1 ? "s" : ""}` },
          { id: "rows", label: "Structured rows produced", ok: !!sample && sample.rows.length > 0, detail: sample ? "preview ok" : "none" },
          ...(covPct != null ? [{ id: "cov", label: "Coverage ≥ 95%", ok: covPct >= 95, detail: `${covPct}%` }] : []),
        ]}
        tail={<>Structured rows feed the shared <b>Clean → Load</b> back half — quality gate · reconcile · lineage.</>}
      />
    </div>
  );
}
