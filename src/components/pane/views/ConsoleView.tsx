export interface TextBlock  { kind: "text";     text: string }
export interface ThinkingBlock { kind: "thinking"; text: string; dur: string; collapsed?: boolean }
export interface ToolBlock  { kind: "tool";     tool: string; args: string; ok?: boolean; summary?: string; preview?: string }
export type Block = TextBlock | ThinkingBlock | ToolBlock;

export interface AssistantTurn { role: "assistant"; blocks: Block[] }
export interface UserTurn      { role: "user";      text: string    }
export type Turn = AssistantTurn | UserTurn;

interface ConsoleViewProps {
  small?: boolean;
  withInput?: boolean;
  turns: Turn[];
  draft?: string;
  streaming?: boolean;
}

export function ConsoleView({ small = false, withInput = true, turns, draft, streaming }: ConsoleViewProps) {
  return (
    <>
      <div style={{
        flex: 1, minHeight: 0, overflow: "auto",
        padding: small ? "8px 10px" : "12px 16px",
        fontFamily: "var(--mono)", fontSize: small ? 10.5 : 11.5,
        lineHeight: 1.55, color: "var(--fg-muted)",
        display: "flex", flexDirection: "column", gap: small ? 10 : 14,
      }}>
        {turns.map((t, i) => <TurnRow key={i} t={t} small={small} />)}
        {streaming && (
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            color: "var(--fg-dim)", fontSize: small ? 9.5 : 10.5,
          }}>
            <span style={{
              width: 8, height: 8, borderRadius: "50%", background: "var(--accent)",
              animation: "pulse 1.4s ease-in-out infinite",
            }} />
            claude is writing…
          </div>
        )}
      </div>

      {withInput && (
        <div style={{
          padding: "7px 10px", borderTop: "1px solid var(--border-soft)",
          background: "var(--bg-canvas)",
          display: "flex", flexDirection: "column", gap: 5,
        }}>
          <div style={{
            display: "flex", alignItems: "center", gap: 6,
            fontFamily: "var(--mono)", fontSize: small ? 10 : 11,
            color: draft ? "var(--fg)" : "var(--fg-dim)",
          }}>
            <span style={{ color: "var(--accent)" }}>▸</span>
            <span style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {draft ?? "ask claude… try /scan to load repo context"}
            </span>
            {!small && (
              <>
                <span style={{
                  padding: "0 5px", borderRadius: 3,
                  background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
                  color: "var(--fg-muted)", fontSize: 10,
                }}>+ attach</span>
                <span style={{
                  padding: "0 5px", borderRadius: 3,
                  background: "var(--accent)", color: "#1a120a", fontWeight: 600, fontSize: 10,
                }}>↵ send</span>
              </>
            )}
          </div>
          {!small && (
            <div style={{ display: "flex", gap: 6, fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>
              {["/scan", "/pin", "/tools", "/reset", "/export"].map((cmd) => (
                <span key={cmd} style={{ color: "var(--info)" }}>{cmd}</span>
              ))}
              <span style={{ flex: 1 }} />
              <span>tools: <span style={{ color: "var(--fg-muted)" }}>read · write · bash · git · gh · kb</span></span>
              <span>·</span>
              <span>14.2k / 200k</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function TurnRow({ t, small }: { t: Turn; small: boolean }) {
  if (t.role === "user") {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <div style={{
          maxWidth: "82%",
          padding: small ? "5px 9px" : "7px 11px",
          borderRadius: 8,
          background: "color-mix(in oklch, var(--info), transparent 86%)",
          border: "1px solid color-mix(in oklch, var(--info), transparent 70%)",
          color: "var(--fg)",
          fontFamily: small ? "var(--mono)" : "var(--sans)",
          fontSize: small ? 10.5 : 12,
          lineHeight: 1.55, whiteSpace: "pre-wrap",
        }}>{t.text}</div>
      </div>
    );
  }
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {!small && (
        <div style={{
          flex: "0 0 22px", width: 22, height: 22, borderRadius: 5,
          background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
          color: "#1a120a", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 11,
          display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2,
        }}>C</div>
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        {t.blocks.map((b, i) => <BlockRow key={i} b={b} small={small} />)}
      </div>
    </div>
  );
}

function BlockRow({ b, small }: { b: Block; small: boolean }) {
  if (b.kind === "thinking") {
    return (
      <div style={{
        padding: small ? "4px 8px" : "6px 10px",
        borderRadius: 6, background: "var(--bg-elev)",
        border: "1px dashed var(--border-soft)",
        fontFamily: "var(--mono)", fontSize: small ? 9.5 : 10.5,
        color: "var(--fg-dim)", fontStyle: "italic",
      }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 6,
          marginBottom: b.collapsed ? 0 : 4, color: "var(--fg-muted)", fontStyle: "normal",
        }}>
          <span>{b.collapsed ? "▸" : "▾"}</span>
          <span>thinking</span>
          <span style={{ color: "var(--fg-dim)" }}>· {b.dur}</span>
        </div>
        {!b.collapsed && <div>{b.text}</div>}
      </div>
    );
  }
  if (b.kind === "tool") {
    return (
      <div style={{
        borderRadius: 6, background: "var(--bg-elev)",
        border: "1px solid var(--border-soft)", overflow: "hidden",
      }}>
        <div style={{
          padding: small ? "4px 8px" : "5px 10px",
          background: "color-mix(in oklch, var(--success), transparent 90%)",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--mono)", fontSize: small ? 9.5 : 10.5,
        }}>
          <span style={{ color: "var(--success)", fontWeight: 600 }}>{b.tool}</span>
          <span style={{
            color: "var(--fg-muted)", flex: 1,
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{b.args}</span>
          <span style={{ color: b.ok === false ? "var(--danger)" : "var(--success)" }}>
            {b.ok === false ? "✗" : "✓"} {b.summary}
          </span>
        </div>
        {b.preview && (
          <pre style={{
            margin: 0, padding: small ? "5px 10px" : "8px 12px",
            fontFamily: "var(--mono)", fontSize: small ? 9.5 : 10.5,
            color: "var(--fg-muted)", lineHeight: 1.55,
            whiteSpace: "pre-wrap", maxHeight: small ? 60 : 120, overflow: "hidden",
          }}>{b.preview}</pre>
        )}
      </div>
    );
  }
  return (
    <div style={{
      fontFamily: small ? "var(--mono)" : "var(--sans)",
      fontSize: small ? 10.5 : 12, color: "var(--fg)", lineHeight: 1.6, whiteSpace: "pre-wrap",
    }}>{b.text}</div>
  );
}
