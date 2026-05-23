export interface DiffLine {
  sign: " " | "+" | "-";
  text: string;
}

export interface DiffHunk {
  file: string;
  add: number;
  del: number;
  sample: DiffLine[];
}

interface ChangesViewProps {
  small?: boolean;
  hunks: DiffHunk[];
}

export function ChangesView({ small = false, hunks }: ChangesViewProps) {
  const totalAdd = hunks.reduce((s, h) => s + h.add, 0);
  const totalDel = hunks.reduce((s, h) => s + h.del, 0);

  return (
    <div style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 8px" : "10px 12px",
    }}>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8,
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        textTransform: "uppercase", letterSpacing: ".06em",
      }}>
        <span>{hunks.length} files changed</span>
        <span>·</span>
        <span style={{ color: "var(--success)" }}>+{totalAdd}</span>
        <span style={{ color: "var(--danger)" }}>−{totalDel}</span>
        <div style={{ flex: 1 }} />
        <span style={{ color: "var(--accent)", textTransform: "none", letterSpacing: 0 }}>stash · commit</span>
      </div>
      {hunks.map((h, i) => (
        <div key={i} style={{
          marginBottom: 8, borderRadius: 5,
          border: "1px solid var(--border-soft)", overflow: "hidden",
        }}>
          <div style={{
            padding: "5px 9px", background: "var(--bg-elev)",
            display: "flex", alignItems: "baseline", gap: 8,
            fontFamily: "var(--mono)", fontSize: small ? 10 : 11,
          }}>
            <span style={{
              color: "var(--fg)", flex: 1,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>{h.file}</span>
            <span style={{ color: "var(--success)", fontSize: small ? 9.5 : 10 }}>+{h.add}</span>
            <span style={{ color: "var(--danger)",  fontSize: small ? 9.5 : 10 }}>−{h.del}</span>
          </div>
          <pre style={{
            margin: 0, padding: "6px 0",
            fontFamily: "var(--mono)", fontSize: small ? 9.5 : 10.5,
            lineHeight: 1.5, background: "var(--bg-canvas)",
          }}>
            {h.sample.map((line, j) => (
              <div key={j} style={{
                padding: "0 9px",
                background: line.sign === "+" ? "color-mix(in oklch, var(--success), transparent 88%)"
                  : line.sign === "-" ? "color-mix(in oklch, var(--danger), transparent 88%)"
                  : "transparent",
                color: line.sign === "+" ? "var(--success)"
                  : line.sign === "-" ? "var(--danger)"
                  : "var(--fg-muted)",
              }}>
                <span style={{ display: "inline-block", width: 10, color: "var(--fg-dim)" }}>{line.sign}</span>
                {line.text}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}
