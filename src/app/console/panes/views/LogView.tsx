export interface Commit {
  s: string;
  m: string;
  who: string;
  t: string;
  head?: boolean;
  merge?: boolean;
}

interface LogViewProps {
  small?: boolean;
  commits: Commit[];
}

export function LogView({ small = false, commits }: LogViewProps) {
  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 10px" : "10px 14px",
    }}>
      {commits.map((c) => (
        <div key={c.s} className="mono" style={{
          display: "grid", gridTemplateColumns: "16px 50px 1fr auto", gap: 8,
          padding: "4px 0", alignItems: "baseline",
          fontSize: small ? 10 : 11,
        }}>
          <span style={{ color: c.head ? "var(--accent)" : c.merge ? "var(--info)" : "var(--fg-dim)" }}>
            {c.head ? "●" : c.merge ? "◆" : "○"}
          </span>
          <span style={{ color: "var(--accent)" }}>{c.s}</span>
          <span style={{
            color: "var(--fg-muted)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {c.m} <span style={{ color: "var(--fg-dim)" }}>· @{c.who}</span>
          </span>
          <span style={{ color: "var(--fg-dim)", fontSize: small ? 9 : 9.5 }}>{c.t}</span>
        </div>
      ))}
    </div>
  );
}
