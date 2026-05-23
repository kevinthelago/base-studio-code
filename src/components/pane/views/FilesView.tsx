export interface FileRow {
  name: string;
  path: string;
  depth?: number;
  dir?: boolean;
  open?: boolean;
  status?: "M" | "A" | "??" | "D";
}

interface FilesViewProps {
  small?: boolean;
  cwd?: string;
  tree: FileRow[];
  active?: string;
}

export function FilesView({ small = false, cwd, tree, active }: FilesViewProps) {
  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 4px" : "8px 6px",
      fontFamily: "var(--mono)", fontSize: small ? 10 : 11, color: "var(--fg-muted)",
    }}>
      <div style={{
        padding: "2px 8px 6px", color: "var(--fg-dim)", fontSize: small ? 9.5 : 10,
        display: "flex", alignItems: "center", gap: 6,
      }}>
        <span>{cwd}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "var(--accent)" }}>± 4</span>
      </div>
      {tree.map((row, i) => (
        <div key={i} style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "2px 8px",
          paddingLeft: 8 + (row.depth ?? 0) * 12,
          background: row.path === active ? "var(--bg-elev)" : "transparent",
          borderRadius: 3,
          color: row.dir ? "var(--fg)" : "var(--fg-muted)",
          cursor: "pointer",
        }}>
          <span style={{ width: 10, color: "var(--fg-dim)", visibility: row.dir ? "visible" : "hidden" }}>
            {row.open ? "▾" : "▸"}
          </span>
          <span style={{
            color: row.dir ? "var(--accent)" : "var(--fg-muted)",
            opacity: row.dir ? 0.9 : 0.7,
          }}>
            {row.dir ? (row.open ? "⌹" : "⌷") : "·"}
          </span>
          <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {row.name}
          </span>
          {row.status && (
            <span style={{
              fontSize: small ? 9 : 9.5, padding: "0 4px", borderRadius: 3,
              color: row.status === "M" ? "var(--accent)"
                : row.status === "A" ? "var(--success)"
                : row.status === "??" ? "var(--fg-dim)" : "var(--fg-muted)",
              background: "var(--bg-elev2)",
            }}>{row.status}</span>
          )}
        </div>
      ))}
    </div>
  );
}
