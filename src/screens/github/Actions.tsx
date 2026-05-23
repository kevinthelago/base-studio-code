const WORKFLOWS = [
  { f: "ci.yml",      on: true,  st: "passing",  lastRun: "a05 · 4m",  triggers: ["push", "PR"],            sel: true  },
  { f: "clippy.yml",  on: true,  st: "failing",  lastRun: "b04 · 2h",  triggers: ["push"]                            },
  { f: "release.yml", on: true,  st: "passing",  lastRun: "a02 · 2d",  triggers: ["tag v*"]                          },
  { f: "docs.yml",    on: true,  st: "queued",   lastRun: "d02 · 1m",  triggers: ["push docs/**"]                    },
  { f: "nightly.yml", on: false, st: "disabled", lastRun: "—",         triggers: ["cron 0 2 * * *"]                  },
];

const RUNS = [
  { id: "#9128", sha: "a05", st: "passing", who: "lina", t: "4m",  dur: "2m 14s", job: "test+clippy+build" },
  { id: "#9127", sha: "b05", st: "passing", who: "lina", t: "24m", dur: "2m 22s", job: "test+clippy"       },
  { id: "#9126", sha: "d02", st: "queued",  who: "bot",  t: "1m",  dur: "—",      job: "queued"            },
  { id: "#9125", sha: "b04", st: "failing", who: "alex", t: "2h",  dur: "1m 02s", job: "clippy", err: "unused_import" },
  { id: "#9124", sha: "a04", st: "passing", who: "lina", t: "4h",  dur: "2m 09s", job: "test+clippy+build" },
];

function Section2({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        display: "flex", alignItems: "baseline", gap: 8, marginBottom: 6,
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--accent)",
        textTransform: "uppercase", letterSpacing: ".08em",
      }}>
        <span>{label}</span>
        <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
        <span style={{ color: "var(--fg-dim)", cursor: "pointer", textTransform: "none", letterSpacing: 0 }}>+ add</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>{children}</div>
    </div>
  );
}

function RowEditable({ icon, t, v, on, placeholder }: {
  icon: string; t: string; v: string; on?: boolean; placeholder?: boolean;
}) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "22px 130px 1fr 22px",
      gap: 10, alignItems: "center",
      padding: "6px 10px", borderRadius: 5,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      fontFamily: "var(--mono)", fontSize: 11,
    }}>
      <span style={{ color: on ? "var(--accent)" : "var(--fg-dim)" }}>{icon}</span>
      <span style={{ color: on ? "var(--fg)" : "var(--fg-muted)" }}>{t}</span>
      <span style={{
        color: placeholder ? "var(--fg-dim)" : "var(--fg-muted)",
        whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        fontStyle: placeholder ? "italic" : "normal",
      }}>{v}</span>
      <span style={{ color: "var(--fg-dim)", textAlign: "right", cursor: "pointer" }}>⋯</span>
    </div>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "180px 1fr",
      gap: 10, alignItems: "center",
      padding: "5px 10px", borderRadius: 5,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      fontFamily: "var(--mono)", fontSize: 11,
    }}>
      <span style={{ color: "var(--info)" }}>{k}</span>
      <span style={{ color: "var(--fg)" }}>{v}</span>
    </div>
  );
}

function JobRow({ name, runs, steps, dur, st }: {
  name: string; runs: string; steps: string; dur: string; st: string;
}) {
  return (
    <div style={{
      padding: "8px 12px", borderRadius: 6,
      background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
      display: "flex", flexDirection: "column", gap: 5,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{
          width: 7, height: 7, borderRadius: "50%",
          background: st === "passing" ? "var(--success)" : st === "failing" ? "var(--danger)" : "var(--accent)",
        }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--accent)" }}>{name}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>runs-on: {runs}</span>
        <span style={{ flex: 1 }} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-muted)" }}>{dur}</span>
      </div>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", paddingLeft: 15 }}>
        {steps}
      </div>
    </div>
  );
}

export function ActionsBody() {
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 14 }}>
        {([
          ["workflows", "5",      "4 enabled",         "fg"],
          ["last run",  "4m ago", "passing",            "success"],
          ["this week", "47",     "42 ✓ · 4 ✗ · 1 ◑", "accent"],
          ["queued",    "1",      "docs.yml",           "info"],
        ] as const).map(([k, v, sub, tone]) => (
          <div key={k} className="card" style={{ padding: "10px 14px" }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
              textTransform: "uppercase", letterSpacing: ".06em",
            }}>{k}</div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 18, fontWeight: 600,
              color: tone === "success" ? "var(--success)" : tone === "accent" ? "var(--accent)" : tone === "info" ? "var(--info)" : "var(--fg)",
              marginTop: 2,
            }}>{v}</div>
            <div style={{ fontSize: 10.5, color: "var(--fg-muted)", marginTop: 1 }}>{sub}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "260px 1fr", gap: 14 }}>
        {/* Workflow list */}
        <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <h3 style={{ margin: 0 }}>Workflows</h3>
              <span className="hint">.github/workflows/</span>
            </div>
            <input className="input" placeholder="filter…" style={{ marginTop: 8, height: 24, fontSize: 10.5 }} />
          </div>
          <div style={{ flex: 1 }}>
            {WORKFLOWS.map(w => (
              <div key={w.f} style={{
                padding: "10px 14px",
                borderBottom: "1px solid var(--border-soft)",
                background: w.sel ? "var(--bg-elev)" : "transparent",
                borderLeft: w.sel ? "2px solid var(--accent)" : "2px solid transparent",
                paddingLeft: w.sel ? 12 : 14,
                cursor: "pointer",
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{
                    width: 7, height: 7, borderRadius: "50%",
                    background: w.st === "passing" ? "var(--success)"
                      : w.st === "failing" ? "var(--danger)"
                      : w.st === "queued" ? "var(--accent)"
                      : "var(--fg-dim)",
                  }} />
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 11.5,
                    color: w.sel ? "var(--fg)" : "var(--fg-muted)",
                  }}>{w.f}</span>
                  <span style={{ flex: 1 }} />
                  {!w.on && <span className="tag" style={{ fontSize: 9.5 }}>off</span>}
                </div>
                <div style={{ display: "flex", gap: 5, marginTop: 5, flexWrap: "wrap" }}>
                  {w.triggers.map(t => (
                    <span key={t} className="tag" style={{ fontSize: 9.5 }}>{t}</span>
                  ))}
                  <span style={{ flex: 1 }} />
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--fg-dim)" }}>{w.lastRun}</span>
                </div>
              </div>
            ))}
          </div>
          <div style={{ padding: 10, borderTop: "1px solid var(--border-soft)" }}>
            <button className="btn primary" style={{ width: "100%", justifyContent: "center" }}>+ New workflow</button>
          </div>
        </div>

        {/* Editor + runs */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
          <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column" }}>
            <div style={{
              padding: "12px 16px", borderBottom: "1px solid var(--border-soft)",
              display: "flex", alignItems: "center", gap: 10,
            }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>
                .github/workflows/
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg)" }}>ci.yml</span>
              <span className="tag green">● passing</span>
              <span className="hint">edited by you · 4m ago</span>
              <div style={{ flex: 1 }} />
              <div style={{
                display: "flex", gap: 4, padding: 2,
                background: "var(--bg-elev)", borderRadius: 5, border: "1px solid var(--border-soft)",
              }}>
                <button className="btn" style={{
                  height: 22, padding: "0 10px", fontSize: 10.5,
                  background: "var(--bg-elev2)", borderColor: "var(--accent-dim)", color: "var(--accent)",
                }}>structured</button>
                <button className="btn ghost" style={{ height: 22, padding: "0 10px", fontSize: 10.5 }}>raw yaml</button>
              </div>
              <button className="btn ghost" style={{ height: 24 }}>↺ rerun</button>
              <button className="btn">commit &amp; push</button>
            </div>

            <div style={{ padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
              <Section2 label="on">
                <RowEditable on icon="↑" t="push"             v="branches: main, feat/**" />
                <RowEditable on icon="⇄" t="pull_request"     v="any branch · paths-ignore: docs/**" />
                <RowEditable    icon="⏱" t="schedule"         v="not set" placeholder />
                <RowEditable    icon="·" t="workflow_dispatch" v="not set" placeholder />
              </Section2>

              <Section2 label="env">
                <KV k="RUST_VERSION"     v="1.78" />
                <KV k="CARGO_TERM_COLOR" v="always" />
                <KV k="RUSTFLAGS"        v="-D warnings" />
              </Section2>

              <Section2 label="jobs · 3">
                <JobRow name="test"   runs="ubuntu-latest" steps="checkout · setup-rust · cargo test · upload-artifact" dur="2m 14s" st="passing" />
                <JobRow name="clippy" runs="ubuntu-latest" steps="checkout · setup-rust · cargo clippy --workspace"     dur="1m 02s" st="failing" />
                <JobRow name="build"  runs="ubuntu-latest" steps="checkout · setup-rust · cargo build --release"        dur="4m 33s" st="passing" />
              </Section2>
            </div>
          </div>

          <div className="card" style={{ padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <h3 style={{ margin: 0 }}>Recent runs · ci.yml</h3>
              <span className="hint">last 5</span>
              <div style={{ flex: 1 }} />
              <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>view all on github →</button>
            </div>
            <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
              {RUNS.map((r, i) => (
                <div key={r.id} style={{
                  display: "grid", gridTemplateColumns: "70px 60px 80px 1fr 90px 60px",
                  gap: 12, padding: "9px 14px",
                  alignItems: "baseline", fontSize: 11,
                  background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
                  borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
                }}>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--fg-dim)" }}>{r.id}</span>
                  <span style={{ fontFamily: "var(--mono)", color: "var(--accent)" }}>{r.sha}</span>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 10.5,
                    color: r.st === "passing" ? "var(--success)" : r.st === "failing" ? "var(--danger)" : "var(--accent)",
                  }}>
                    {r.st === "passing" ? "✓" : r.st === "failing" ? "✗" : "◑"} {r.st}
                  </span>
                  <span style={{
                    color: "var(--fg-muted)", fontFamily: "var(--mono)", fontSize: 10.5,
                    whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                  }}>
                    {r.job}{"err" in r && r.err && <span style={{ color: "var(--danger)" }}> · {r.err}</span>}
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>
                    @{r.who} · {r.t}
                  </span>
                  <span style={{
                    fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)", textAlign: "right",
                  }}>{r.dur}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
