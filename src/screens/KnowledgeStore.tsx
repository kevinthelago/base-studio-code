import { StatusBar } from "../components/chrome/StatusBar";
import { KB_TAGS, KB_BLOCKS } from "../data/mock";

const KB_EDITOR_BODY = `# Review policy — TS / Rust

Applies to: acme/payments, acme/ledger-core

## Required signals
- \`cargo clippy --workspace\` must pass
- \`cargo fmt --check\` must pass
- New public surface needs a doc-comment
- Migrations require an explicit \`rollback.sql\`

## Tone
- Friendly, terse, no preamble.
- Quote line numbers, never paraphrase code.

## Out of scope
- Style nits beyond rustfmt
- Bumping deps unless asked

> Linked from agent prompt @reviewer`;

export function KnowledgeStoreScreen() {
  const selected = KB_BLOCKS.find((b) => b.sel) ?? KB_BLOCKS[0];

  return (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Tag rail */}
        <aside style={{
          width: 200, flex: "0 0 200px", background: "var(--bg-panel)",
          borderRight: "1px solid var(--border-soft)", padding: "14px 8px",
          display: "flex", flexDirection: "column", gap: 1, overflow: "auto",
        }}>
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
            color: "var(--fg-dim)", padding: "2px 12px 8px",
            display: "flex", justifyContent: "space-between",
          }}>
            <span>TAGS</span>
            <span style={{ cursor: "pointer", color: "var(--fg-muted)" }}>+</span>
          </div>
          {KB_TAGS.map((t) => (
            <div key={t.name} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              padding: "6px 10px 6px 12px",
              borderRadius: 5, fontSize: 11.5,
              background: t.on ? "var(--bg-elev)" : "transparent",
              color: t.on ? "var(--fg)" : "var(--fg-muted)",
              borderLeft: t.on ? "2px solid var(--accent)" : "2px solid transparent",
              paddingLeft: t.on ? 10 : 12,
              cursor: "pointer", fontFamily: "var(--mono)",
            }}>
              <span>#{t.name}</span>
              <span style={{ color: "var(--fg-dim)", fontSize: 10.5 }}>{t.n}</span>
            </div>
          ))}
          <div style={{ height: 14 }} />
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, letterSpacing: ".08em",
            color: "var(--fg-dim)", padding: "2px 12px 8px",
          }}>SOURCES</div>
          {["manual", "agent-authored", "github · imported"].map((s) => (
            <div key={s} style={{
              padding: "6px 12px", fontSize: 11.5, fontFamily: "var(--mono)",
              color: "var(--fg-muted)", cursor: "pointer",
            }}>{s}</div>
          ))}
        </aside>

        {/* Block list */}
        <aside style={{
          width: 280, flex: "0 0 280px", background: "var(--bg-canvas)",
          borderRight: "1px solid var(--border-soft)", display: "flex", flexDirection: "column",
        }}>
          <div style={{
            padding: "12px 12px 8px", borderBottom: "1px solid var(--border-soft)",
            display: "flex", flexDirection: "column", gap: 8,
          }}>
            <input className="input" placeholder="⌕ search blocks…" />
            <div style={{ display: "flex", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
              <span className="hint">7 blocks · #review-policy</span>
              <select className="input" style={{ height: 22, width: 90, fontSize: 10.5 }}>
                <option>updated</option><option>title</option><option>size</option>
              </select>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "auto" }}>
            {KB_BLOCKS.map((b) => (
              <div key={b.id} style={{
                padding: "11px 12px", borderBottom: "1px solid var(--border-soft)",
                background: b.sel ? "var(--bg-elev)" : "transparent",
                borderLeft: b.sel ? "2px solid var(--accent)" : "2px solid transparent",
                paddingLeft: b.sel ? 10 : 12,
                cursor: "pointer",
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{b.id}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{b.updated}</span>
                </div>
                <div style={{
                  fontSize: 12, color: b.sel ? "var(--fg)" : "var(--fg-muted)",
                  marginBottom: 5, fontWeight: 500,
                }}>{b.title}</div>
                <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {b.tags.map((tag) => (
                    <span key={tag} className={"tag " + (tag === "review-policy" ? "amber" : "")}>
                      #{tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)" }}>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>+ New block</button>
          </div>
        </aside>

        {/* Editor + preview */}
        <section style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          <header style={{
            padding: "12px 18px", borderBottom: "1px solid var(--border-soft)",
            display: "flex", alignItems: "center", gap: 10, background: "var(--bg-panel)",
          }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{selected.id}</span>
            <input className="input" defaultValue={selected.title}
              style={{
                flex: 1, height: 30, fontSize: 14, fontFamily: "var(--sans)",
                background: "transparent", border: "1px solid transparent",
              }} />
            {selected.tags.map((tag) => (
              <span key={tag} className={"tag " + (tag === "review-policy" ? "amber" : "")}>#{tag}</span>
            ))}
            <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>+ tag</button>
            <div style={{ width: 1, height: 18, background: "var(--border-soft)" }} />
            <button className="btn ghost" style={{ height: 24 }}>↗ link</button>
            <button className="btn ghost" style={{ height: 24 }}>⎘ embed</button>
            <button className="btn">save</button>
          </header>

          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            {/* Raw editor */}
            <div style={{
              flex: 1, padding: "18px 22px", overflow: "auto",
              borderRight: "1px solid var(--border-soft)",
            }}>
              <pre style={{
                margin: 0, fontFamily: "var(--mono)", fontSize: 12, lineHeight: 1.7,
                color: "var(--fg)", whiteSpace: "pre-wrap",
              }}>{KB_EDITOR_BODY}</pre>
            </div>

            {/* Preview */}
            <div style={{ flex: 1, padding: "18px 24px", overflow: "auto", background: "var(--bg-panel)" }}>
              <div style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                textTransform: "uppercase", letterSpacing: ".08em", marginBottom: 10,
              }}>preview</div>
              <h1 style={{ fontSize: 22, margin: "0 0 14px", fontWeight: 600, fontFamily: "var(--sans)" }}>
                Review policy — TS / Rust
              </h1>
              <p style={{ margin: "0 0 18px", color: "var(--fg-muted)", fontSize: 12 }}>
                Applies to:{" "}
                <code style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>acme/payments</code>,{" "}
                <code style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>acme/ledger-core</code>.
              </p>
              <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Required signals</h3>
              <ul style={{ margin: "0 0 16px 20px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.7 }}>
                <li><code style={{ fontFamily: "var(--mono)" }}>cargo clippy --workspace</code> must pass</li>
                <li><code style={{ fontFamily: "var(--mono)" }}>cargo fmt --check</code> must pass</li>
                <li>New public surface needs a doc-comment</li>
                <li>Migrations require an explicit <code>rollback.sql</code></li>
              </ul>
              <h3 style={{ fontSize: 14, margin: "0 0 8px" }}>Tone</h3>
              <ul style={{ margin: "0 0 16px 20px", color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.7 }}>
                <li>Friendly, terse, no preamble.</li>
                <li>Quote line numbers, never paraphrase code.</li>
              </ul>
              <div style={{
                marginTop: 18, padding: "10px 14px",
                borderLeft: "2px solid var(--accent-dim)",
                background: "var(--bg-elev)",
                fontSize: 11, color: "var(--fg-muted)",
              }}>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
                  marginBottom: 4, textTransform: "uppercase", letterSpacing: ".06em",
                }}>backlinks</div>
                Used by agent{" "}
                <code style={{ color: "var(--success)" }}>@reviewer</code>{" "}
                · 3 other blocks link here.
              </div>
            </div>
          </div>
        </section>
      </div>
      <StatusBar />
    </div>
  );
}
