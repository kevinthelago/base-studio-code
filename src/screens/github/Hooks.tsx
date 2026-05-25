import { useState } from "react";

interface Hook {
  n: string;
  on: boolean;
  scope: "shared" | "local";
  desc: string;
  cmds: string[];
}

const DEFAULT_HOOKS: Hook[] = [
  { n: "pre-commit",  on: true,  scope: "shared",
    desc: "Runs before each commit; non-zero exit blocks it.",
    cmds: ["cargo fmt --check", "cargo clippy --quiet", "tools/check-blocked-paths.sh"] },
  { n: "pre-push",    on: true,  scope: "shared",
    desc: "Runs before push to remote.",
    cmds: ["cargo test --workspace --quiet"] },
  { n: "commit-msg",  on: true,  scope: "shared",
    desc: "Lints the message; enforces Conventional Commits.",
    cmds: ['tools/commit-lint.sh "$1"'] },
  { n: "post-merge",  on: false, scope: "shared",
    desc: "Runs after a successful merge.",
    cmds: [] },
  { n: "post-checkout", on: true, scope: "local",
    desc: "Runs after checkout / branch switch. Local-only.",
    cmds: ["base-studio rescan-repo --pane=@reviewer"] },
  { n: "prepare-commit-msg", on: false, scope: "shared",
    desc: "Pre-fills the commit message template.",
    cmds: [] },
];

export function HooksBody() {
  const [hooks, setHooks] = useState<Hook[]>(DEFAULT_HOOKS);

  function toggleHook(name: string) {
    setHooks(prev => prev.map(h => h.n === name ? { ...h, on: !h.on } : h));
  }

  const activeCount = hooks.filter(h => h.on).length;

  return (
    <>
      <div className="card" style={{ padding: "14px 18px", marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <h3 style={{ margin: 0 }}>Git hooks</h3>
          <span className="hint">
            Tracked in <code style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>.githooks/</code> and
            installed via <code style={{ fontFamily: "var(--mono)", color: "var(--fg)" }}>core.hooksPath</code> — your team gets them automatically.
          </span>
          <div style={{ flex: 1 }} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
            <span style={{
              width: 30, height: 18, borderRadius: 99, background: "var(--accent)", position: "relative",
            }}>
              <span style={{
                position: "absolute", top: 2, right: 2, width: 14, height: 14,
                background: "#1a120a", borderRadius: "50%",
              }} />
            </span>
            installed
          </label>
        </div>
        <div style={{
          display: "flex", gap: 14, marginTop: 10,
          fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
        }}>
          <span>core.hooksPath = <span style={{ color: "var(--accent)" }}>.githooks/</span></span>
          <span>·</span>
          <span>{hooks.length} hooks · {activeCount} active</span>
          <span>·</span>
          <span>shared with all collaborators on commit</span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 12 }}>
        {hooks.map(h => (
          <div key={h.n} className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 6 }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%",
                background: h.on ? "var(--success)" : "var(--fg-dim)",
                flexShrink: 0, alignSelf: "center",
              }} />
              <h3 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 13 }}>{h.n}</h3>
              <span className={"tag " + (h.scope === "shared" ? "amber" : "")} style={{ fontSize: 9.5 }}>
                {h.scope}
              </span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>edit</button>
              <label style={{ display: "flex", alignItems: "center", cursor: "pointer" }}
                onClick={() => toggleHook(h.n)}>
                <span style={{
                  width: 24, height: 14, borderRadius: 99,
                  background: h.on ? "var(--accent)" : "var(--bg-elev2)",
                  border: "1px solid " + (h.on ? "transparent" : "var(--border)"),
                  position: "relative",
                  transition: "background .15s",
                }}>
                  <span style={{
                    position: "absolute", top: 1,
                    ...(h.on ? { right: 1 } : { left: 1 }),
                    width: 10, height: 10, borderRadius: "50%",
                    background: h.on ? "#1a120a" : "var(--fg-dim)",
                    transition: "left .15s, right .15s",
                  }} />
                </span>
              </label>
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-muted)", marginBottom: 10, lineHeight: 1.5 }}>
              {h.desc}
            </div>
            {h.cmds.length > 0 ? (
              <pre style={{
                margin: 0, padding: "8px 10px",
                background: "var(--bg-canvas)",
                border: "1px solid var(--border-soft)", borderRadius: 5,
                fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
                lineHeight: 1.55, whiteSpace: "pre-wrap",
              }}>
                {h.cmds.map((c, i) => (
                  <span key={i}>
                    <span style={{ color: "var(--accent)" }}>$</span> {c}{i < h.cmds.length - 1 ? "\n" : ""}
                  </span>
                ))}
              </pre>
            ) : (
              <div style={{
                padding: "8px 10px",
                border: "1px dashed var(--border)", borderRadius: 5,
                fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)",
                textAlign: "center",
              }}>(no script) — + add command</div>
            )}
          </div>
        ))}
      </div>

      <div style={{
        marginTop: 14, padding: "12px 16px",
        border: "1px dashed var(--border)", borderRadius: 8,
        display: "flex", gap: 14, alignItems: "center",
        fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
      }}>
        <span style={{ color: "var(--accent)" }}>tip</span>
        <span>
          Edits to shared hooks land in <code style={{ color: "var(--fg)" }}>.githooks/</code> and ship in your next commit.
          Local hooks live in <code style={{ color: "var(--fg)" }}>.git/hooks/</code> and stay on your machine only.
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn">+ new hook</button>
      </div>
    </>
  );
}
