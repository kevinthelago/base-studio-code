// CI health card — pass/fail matrix over the last 7 days per repo (#1644).

import type { CiRow } from "../lib/githubSummary";

export function CIHealthCard({ matrix, loading }: {
  matrix: CiRow[];
  loading: boolean;
}) {
  return (
    <div className="card" style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>CI health</h3>
        <span className="hint">last 7 days · all branches</span>
      </div>
      {matrix.length === 0 && !loading && (
        <div className="mono" style={{ fontSize: 11, color: "var(--fg-dim)", padding: "4px 0" }}>No CI runs found.</div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {matrix.map(({ name, days }) => (
          <div key={name} style={{ display: "grid", gridTemplateColumns: "80px 1fr 28px", gap: 8, alignItems: "center" }}>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</span>
            <div style={{ display: "flex", gap: 4 }}>
              {days.map((d, i) => (
                <div key={i} style={{
                  flex: 1, height: 14, borderRadius: 3,
                  background: d === null ? "var(--bg-elev2)" : d ? "var(--success)" : "var(--danger)",
                  opacity: d === null ? 0.4 : 0.85,
                }} />
              ))}
            </div>
            <span className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", textAlign: "right" }}>
              {days.filter(d => d === true).length}/{days.filter(d => d !== null).length}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
