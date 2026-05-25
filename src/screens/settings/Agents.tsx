import { useState } from "react";
import { useAppStore } from "../../store";

const PRESETS: { label: string; commands: string[] }[] = [
  { label: "Rust",   commands: ["cargo", "rustc", "rustfmt"] },
  { label: "Node",   commands: ["npm", "npx", "node", "pnpm"] },
  { label: "Git",    commands: ["git"] },
  { label: "GitHub", commands: ["gh"] },
  { label: "Python", commands: ["python", "pip", "uv"] },
  { label: "Docker", commands: ["docker", "docker-compose"] },
];

export function AgentsSettings() {
  const { allowedCommands, addAllowedCommand, removeAllowedCommand, setAllowedCommands } = useAppStore();
  const [draft, setDraft] = useState("");

  function handleAdd() {
    const cmd = draft.trim().toLowerCase();
    if (!cmd) return;
    addAllowedCommand(cmd);
    setDraft("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") { e.preventDefault(); handleAdd(); }
  }

  function applyPreset(commands: string[]) {
    commands.forEach(addAllowedCommand);
  }

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Agents</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Default behavior applied to all Claude sessions.
      </p>

      {/* Allowed shell commands ───────────────────────────────────── */}
      <div className="card">
        <div style={{ marginBottom: 6 }}>
          <h3 style={{ margin: "0 0 6px" }}>Allowed shell commands</h3>
          <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
            When non-empty, Claude's <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>bash</code> tool
            is restricted to commands matching one of these prefixes. Leave empty to allow everything.
          </p>
        </div>

        {/* Preset chips */}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 14, marginBottom: 10, flexWrap: "wrap" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", marginRight: 2 }}>
            presets
          </span>
          {PRESETS.map((p) => {
            const active = p.commands.every((c) => allowedCommands.includes(c));
            return (
              <button
                key={p.label}
                className="btn"
                onClick={() => applyPreset(p.commands)}
                style={{
                  height: 22, fontSize: 10.5,
                  background: active ? "var(--bg-elev2)" : "var(--bg-elev)",
                  borderColor: active ? "var(--accent-dim)" : "var(--border-soft)",
                  color: active ? "var(--accent)" : "var(--fg-muted)",
                }}
              >
                {p.label}
              </button>
            );
          })}
          {allowedCommands.length > 0 && (
            <button
              className="btn ghost"
              onClick={() => setAllowedCommands([])}
              style={{ height: 22, fontSize: 10.5, marginLeft: "auto", color: "var(--fg-dim)" }}
            >
              clear all
            </button>
          )}
        </div>

        {/* Current allowlist */}
        <div style={{
          minHeight: 52, padding: "8px 10px", marginBottom: 10,
          background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
          borderRadius: 6, display: "flex", flexWrap: "wrap", gap: 5, alignContent: "flex-start",
        }}>
          {allowedCommands.length === 0 ? (
            <span style={{
              fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-dim)",
              alignSelf: "center", padding: "2px 0",
            }}>
              no restrictions · all commands permitted
            </span>
          ) : (
            allowedCommands.map((cmd) => (
              <span
                key={cmd}
                style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  padding: "3px 9px", borderRadius: 4,
                  background: "var(--bg-canvas)", border: "1px solid var(--border)",
                  fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--accent)",
                }}
              >
                {cmd}
                <span
                  onClick={() => removeAllowedCommand(cmd)}
                  style={{
                    cursor: "pointer", color: "var(--fg-dim)",
                    fontSize: 12, lineHeight: 1, marginTop: -1,
                  }}
                >
                  ×
                </span>
              </span>
            ))
          )}
        </div>

        {/* Add input */}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="e.g. cargo, npm run, python…"
            style={{ flex: 1 }}
          />
          <button
            className="btn primary"
            onClick={handleAdd}
            disabled={!draft.trim()}
            style={{ whiteSpace: "nowrap" }}
          >
            + add
          </button>
        </div>
        <div className="hint" style={{ marginTop: 6 }}>
          Press <kbd className="kbd">Enter</kbd> or click Add · changes apply to new sessions immediately
        </div>
      </div>

      {/* Placeholder cards for future agent-level settings */}
      <div style={{ height: 18 }} />
      <div className="card" style={{ opacity: 0.5 }}>
        <h3 style={{ margin: "0 0 6px" }}>Default system prompt</h3>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Prepended to every new session's system prompt. · coming soon
        </p>
      </div>

      <div style={{ height: 12 }} />
      <div className="card" style={{ opacity: 0.5 }}>
        <h3 style={{ margin: "0 0 6px" }}>Auto-context injection</h3>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Automatically inject relevant knowledge blocks based on the active repo's tech stack. · coming soon
        </p>
      </div>
    </div>
  );
}
