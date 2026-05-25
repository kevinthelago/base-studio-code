import { useState } from "react";
import { useAppStore } from "../../store";

export function CommandsTab() {
  const { commands, addCommand, removeCommand } = useAppStore();
  const [search, setSearch] = useState("");

  const filtered = commands.filter(c =>
    !search.trim() ||
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.cmd.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 14 }}>
        <h3 style={{ margin: 0 }}>Reusable commands</h3>
        <span className="hint">
          Pick these from any schedule's action picker, or run them ad-hoc from the pane menu.
        </span>
        <div style={{ flex: 1 }} />
        <input
          className="input"
          placeholder="⌕ search…"
          style={{ width: 200 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button className="btn primary" onClick={addCommand}>+ new snippet</button>
      </div>

      {filtered.length === 0 ? (
        <div style={{
          padding: "48px 24px", textAlign: "center",
          fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg-dim)",
        }}>
          {commands.length === 0
            ? "No commands yet. Click \"+ new snippet\" to create one."
            : "No commands match your search."}
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
          {filtered.map(c => (
            <div key={c.id} className="card" style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{c.id}</span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--fg)" }}>{c.name}</span>
                <div style={{ flex: 1 }} />
                <span className={"tag " + (c.kind === "claude" ? "info" : "")} style={{ fontSize: 9.5 }}>
                  {c.kind === "claude" ? "claude prompt" : "shell"}
                </span>
                <span className="hint">used {c.used}×</span>
              </div>
              <pre style={{
                margin: 0, padding: "8px 10px",
                background: "var(--bg-canvas)",
                border: "1px solid var(--border-soft)", borderRadius: 5,
                fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
                lineHeight: 1.55, whiteSpace: "pre-wrap",
                minHeight: 32,
              }}>
                {c.cmd
                  ? <><span style={{ color: c.kind === "claude" ? "var(--info)" : "var(--accent)" }}>
                      {c.kind === "claude" ? "›" : "$"}
                    </span>{" "}{c.cmd}</>
                  : <span style={{ color: "var(--fg-dim)" }}>no command yet</span>}
              </pre>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                {c.tags.map(t => (
                  <span key={t} className="tag" style={{ fontSize: 9.5 }}>#{t}</span>
                ))}
                <div style={{ flex: 1 }} />
                <button className="btn ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>edit</button>
                <button className="btn ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>schedule…</button>
                <button
                  className="btn ghost"
                  style={{ height: 22, padding: "0 8px", fontSize: 10, color: "var(--danger)", borderColor: "var(--danger)" }}
                  onClick={() => removeCommand(c.id)}
                >delete</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
