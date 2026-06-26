// FocusedCleaningBody — right-pane body for the "dataClean" stage.
//
// Reads the planner's `dataClean.json` and shows the QUALITY BAR (the confidence a
// row must clear to enter the Data Model), the per-field cleaning rules grouped by
// kind (coerce / standardize / validate), the validation pass-rate, and the
// quarantine policy for failures. There is no design prototype for this stage; the
// layout follows the section's intent + the shared card vocabulary.

import { useStageJson } from "./useStageJson";
import { type CleaningPlan, type CleanRule } from "./dataCollection";
import { Card, Readiness } from "./DataCollectionPrimitives";

const mono = "var(--mono)";

const KIND_LABEL: Record<NonNullable<CleanRule["kind"]>, string> = {
  coerce: "coerce types", standardize: "standardize formats", validate: "validate",
};

export function FocusedCleaningBody({ projectId }: { projectId?: string }) {
  const { data, loading } = useStageJson<CleaningPlan>(projectId, "dataClean");

  if (loading) {
    return <div className="empty-state" data-testid="cleaning-loading"><span className="empty-icon">✦</span>
      <span style={{ fontFamily: mono, fontSize: 12, color: "var(--fg-dim)" }}>Loading cleaning…</span></div>;
  }

  const rules = data?.rules ?? [];
  const bar = data?.qualityBar;

  if (rules.length === 0 && bar == null) {
    return (
      <div data-testid="focused-cleaning-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
        <Card label="cleaning rules">
          <div className="empty-state" style={{ padding: "18px 0" }}>
            <span className="empty-icon">✦</span>
            <span style={{ fontFamily: "var(--sans)", fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>No cleaning rules yet</span>
            <span style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-dim)", maxWidth: 380, textAlign: "center", lineHeight: 1.5 }}>
              The planner sets the quality bar and per-field coerce / standardize / validate rules in <code>dataClean.json</code> — they appear here.
            </span>
          </div>
        </Card>
      </div>
    );
  }

  // Group rules by kind, in a stable order.
  const order: NonNullable<CleanRule["kind"]>[] = ["coerce", "standardize", "validate"];
  const groups = order
    .map((k) => ({ kind: k, rows: rules.filter((r) => (r.kind ?? "validate") === k) }))
    .filter((g) => g.rows.length > 0);
  const validation = data?.validationPct;

  return (
    <div data-testid="focused-cleaning-body" style={{ display: "flex", flexDirection: "column", gap: 14, padding: "16px 18px", overflow: "auto" }}>
      {/* quality bar */}
      {bar != null && (
        <Card label="quality bar" badge={<span style={{ fontFamily: mono, fontSize: 9, color: "var(--accent)" }}>confidence ≥ {bar}%</span>}>
          <div style={{ fontFamily: mono, fontSize: 11, color: "var(--fg-muted)", lineHeight: 1.6 }}>
            A row must clear <b style={{ color: "var(--fg)" }}>{bar}%</b> confidence to be allowed into the Data Model. Failures are quarantined for review.
          </div>
          {validation != null && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 9 }}>
              <span style={{ flex: 1, height: 5, borderRadius: 99, background: "var(--bg-elev2)", overflow: "hidden" }}>
                <span style={{ display: "block", height: "100%", width: `${validation}%`, background: validation >= bar ? "var(--success)" : "var(--danger)" }} />
              </span>
              <span style={{ fontFamily: mono, fontSize: 10, color: validation >= bar ? "var(--success)" : "var(--danger)" }}>{validation}% pass</span>
            </div>
          )}
        </Card>
      )}

      {/* rules by kind */}
      {groups.map((g) => (
        <Card key={g.kind} label={KIND_LABEL[g.kind]} hint={`${g.rows.length} rule${g.rows.length !== 1 ? "s" : ""}`}>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {g.rows.map((r, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: mono, fontSize: 10.5 }}>
                <span style={{ color: "var(--fg)", minWidth: 110 }}>{r.field}</span>
                <span style={{ color: "var(--fg-muted)" }}>{r.rule}</span>
                {r.note && <span style={{ fontSize: 9, color: "var(--fg-dim)" }}>· {r.note}</span>}
              </div>
            ))}
          </div>
        </Card>
      ))}

      {/* quarantine */}
      {data?.quarantine && (
        <Card label="quarantine">
          <div style={{ fontFamily: mono, fontSize: 10.5, color: "var(--fg-muted)", lineHeight: 1.6 }}>
            {data.quarantine.count != null && <><b style={{ color: "var(--fg)" }}>{data.quarantine.count}</b> rows quarantined · </>}
            {data.quarantine.policy ?? "failures held for review before re-processing."}
          </div>
        </Card>
      )}

      <Readiness
        checks={[
          { id: "bar", label: "Quality bar set", ok: bar != null, detail: bar != null ? `≥ ${bar}%` : "unset" },
          { id: "rules", label: "Cleaning rules defined", ok: rules.length > 0, detail: `${rules.length} rule${rules.length !== 1 ? "s" : ""}` },
          ...(validation != null ? [{ id: "pass", label: "Rows pass the quality bar", ok: bar == null || validation >= bar, detail: `${validation}%` }] : []),
        ]}
        tail={<>Cleaned rows feed <b>Load &amp; reconcile</b> — merged by identity key, with lineage.</>}
      />
    </div>
  );
}
