export interface Branch {
  n: string;
  cur?: boolean;
  ahead?: number;
  behind?: number;
  age: string;
  merged?: boolean;
  stale?: boolean;
}

interface BranchesViewProps {
  small?: boolean;
  branches: Branch[];
}

export function BranchesView({ small = false, branches }: BranchesViewProps) {
  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 8px" : "10px 12px",
    }}>
      <div className="mono" style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6,
        fontSize: 10, color: "var(--fg-dim)",
        textTransform: "uppercase", letterSpacing: ".06em",
      }}>
        <span>{branches.length} branches</span>
        <span>·</span>
        <span>{branches.filter((b) => (b.ahead ?? 0) > 0).length} ahead, {branches.filter((b) => b.stale).length} stale</span>
      </div>
      {branches.map((b) => (
        <div key={b.n} className="mono" style={{
          display: "grid", gridTemplateColumns: "14px 1fr auto auto", gap: 8,
          alignItems: "center", padding: "4px 6px", borderRadius: 4,
          background: b.cur ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
          fontSize: small ? 10 : 11,
        }}>
          <span style={{ color: b.cur ? "var(--accent)" : "var(--fg-dim)" }}>{b.cur ? "●" : "○"}</span>
          <span style={{
            color: b.cur ? "var(--accent)" : b.merged ? "var(--fg-dim)" : "var(--fg)",
            textDecoration: b.merged ? "line-through" : "none",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{b.n}</span>
          <span style={{ fontSize: small ? 9.5 : 10, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>
            {(b.ahead ?? 0) > 0 && <span style={{ color: "var(--info)" }}>⇡{b.ahead}</span>}
            {(b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0 && " "}
            {(b.behind ?? 0) > 0 && <span style={{ color: "var(--accent)" }}>⇣{b.behind}</span>}
            {b.merged && <span style={{ color: "var(--success)" }}>merged</span>}
            {b.stale && <span style={{ color: "var(--danger)" }}>stale</span>}
          </span>
          <span style={{ fontSize: small ? 9 : 10, color: "var(--fg-dim)" }}>{b.age}</span>
        </div>
      ))}
    </div>
  );
}
