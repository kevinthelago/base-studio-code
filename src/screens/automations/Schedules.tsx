import { SCHEDULES } from "../../data/mock";

type Schedule = typeof SCHEDULES[number];

function Lbl({ c, children }: { c: "accent" | "info" | "success" | "muted"; children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: "var(--mono)", fontSize: 10.5,
      color: c === "accent" ? "var(--accent)" : c === "info" ? "var(--info)" : c === "success" ? "var(--success)" : "var(--fg-muted)",
      textTransform: "uppercase", letterSpacing: ".08em",
      paddingTop: 6,
    }}>{children}</div>
  );
}

function Pill({ on, children }: { on?: boolean; children: React.ReactNode }) {
  return (
    <span style={{
      padding: "3px 10px", borderRadius: 4,
      background: on ? "var(--bg-canvas)" : "transparent",
      border: "1px solid " + (on ? "var(--accent-dim)" : "transparent"),
      color: on ? "var(--accent)" : "var(--fg-muted)",
      fontFamily: "var(--mono)", fontSize: 10.5, cursor: "pointer",
    }}>{children}</span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{
        fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        textTransform: "uppercase", letterSpacing: ".06em",
      }}>{label}</span>
      {children}
    </div>
  );
}

function CommandAction({ detail }: { detail: string }) {
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
          textTransform: "uppercase", letterSpacing: ".06em",
        }}>from</span>
        <select className="input" style={{ flex: "0 0 220px" }}>
          <option>— pick from saved snippets —</option>
          <option>cmd_lint  · cargo fmt --check &amp;&amp; cargo clippy</option>
          <option>cmd_test  · cargo test --workspace --quiet</option>
          <option>cmd_sync  · git fetch --all &amp;&amp; gh pr list --state open</option>
        </select>
        <span style={{ color: "var(--fg-dim)", fontSize: 11 }}>or</span>
        <input className="input" placeholder="type a command…" style={{ flex: 1 }} />
      </div>
      <div style={{
        border: "1px solid var(--border-soft)", borderRadius: 6,
        background: "var(--bg-canvas)", overflow: "hidden",
      }}>
        <div style={{
          padding: "6px 10px", borderBottom: "1px solid var(--border-soft)",
          background: "var(--bg-elev)",
          display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        }}>
          <span>command</span>
          <span>·</span>
          <select className="input" defaultValue="shell" style={{ height: 18, fontSize: 10, padding: "0 6px" }}>
            <option value="shell">run as shell</option>
            <option>send as message to claude</option>
            <option>inject as system prompt</option>
          </select>
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--accent)" }}>▶ test fire</span>
        </div>
        <pre style={{
          margin: 0, padding: "10px 12px",
          fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg)",
          lineHeight: 1.55, whiteSpace: "pre-wrap",
        }}>{detail}</pre>
      </div>
    </>
  );
}

function KnowledgeAction({ detail }: { detail: string }) {
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
          textTransform: "uppercase", letterSpacing: ".06em",
        }}>block</span>
        <select className="input" style={{ flex: "0 0 320px" }} defaultValue="blk_9a2c">
          <option value="blk_9a2c">blk_9a2c · Review policy — TS / Rust</option>
          <option>blk_71fe · Tunnel framing v2</option>
          <option>blk_4ad8 · @reviewer system prompt</option>
          <option>blk_2199 · Decision · SQLite over LMDB</option>
        </select>
        <span className="tag amber">#review-policy</span>
        <span className="tag">#decisions</span>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
          textTransform: "uppercase", letterSpacing: ".06em",
        }}>load as</span>
        <div style={{
          display: "flex", gap: 6, padding: 3,
          background: "var(--bg-elev)", borderRadius: 6, border: "1px solid var(--border-soft)",
        }}>
          <Pill on>pinned context</Pill>
          <Pill>user message</Pill>
          <Pill>system prompt</Pill>
        </div>
        <span style={{ flex: 1 }} />
        <span className="hint">survives /reset · removed when schedule disabled</span>
      </div>

      <div style={{
        border: "1px solid var(--border-soft)", borderRadius: 6,
        background: "var(--bg-canvas)", overflow: "hidden",
      }}>
        <div style={{
          padding: "6px 10px", borderBottom: "1px solid var(--border-soft)",
          background: "var(--bg-elev)", display: "flex", alignItems: "center", gap: 8,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)",
        }}>
          <span>preview</span>
          <span>·</span>
          <span style={{ color: "var(--accent)" }}>blk_9a2c</span>
          <div style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-dim)" }}>42 lines · last updated 14:02</span>
        </div>
        <pre style={{
          margin: 0, padding: "10px 12px",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)",
          lineHeight: 1.55, whiteSpace: "pre-wrap", maxHeight: 120, overflow: "hidden",
        }}>
          {`# Review policy — TS / Rust\n\nApplies to: acme/payments, acme/ledger-core\n\n## Required signals\n- cargo clippy --workspace must pass\n- cargo fmt --check must pass\n- New public surface needs a doc-comment\n…`}
        </pre>
      </div>

      <div style={{
        fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)",
        padding: "4px 0",
      }}>{detail}</div>
    </>
  );
}

function ScheduleEditor({ s }: { s: Schedule }) {
  return (
    <div className="card" style={{ padding: 0 }}>
      <div style={{
        padding: "14px 18px", borderBottom: "1px solid var(--border-soft)",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{s.id}</span>
        <input className="input" defaultValue={s.name}
          style={{
            flex: 1, height: 30, fontSize: 14, fontFamily: "var(--sans)",
            background: "transparent", border: "1px solid transparent",
          }} />
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
          <span style={{
            width: 30, height: 18, borderRadius: 99,
            background: s.on ? "var(--accent)" : "var(--bg-elev2)",
            border: "1px solid " + (s.on ? "transparent" : "var(--border)"),
            position: "relative",
          }}>
            <span style={{
              position: "absolute", top: 2,
              ...(s.on ? { right: 2 } : { left: 2 }),
              width: 14, height: 14,
              background: s.on ? "#1a120a" : "var(--fg-dim)",
              borderRadius: "50%",
            }} />
          </span>
          enabled
        </label>
        <button className="btn">save</button>
      </div>

      <div style={{
        padding: "18px 20px",
        display: "grid", gridTemplateColumns: "72px 1fr",
        gap: "14px 18px", alignItems: "start",
      }}>
        <Lbl c="accent">when</Lbl>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{
            display: "flex", gap: 6, padding: 3, background: "var(--bg-elev)",
            borderRadius: 6, border: "1px solid var(--border-soft)", width: "fit-content",
          }}>
            <Pill on>simple</Pill><Pill>cron</Pill><Pill>after event</Pill>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>every</span>
            <select className="input" style={{ width: 130 }} defaultValue="day">
              <option>day</option><option>weekday</option><option>week</option>
              <option>month</option><option>hour</option>
            </select>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>at</span>
            <input className="input" defaultValue="02:00" style={{ width: 80 }} />
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>·</span>
            <select className="input" style={{ width: 130 }} defaultValue="local">
              <option>local</option><option>UTC</option>
            </select>
          </div>
          <div style={{
            padding: "8px 12px",
            border: "1px solid var(--border-soft)", borderRadius: 5,
            background: "var(--bg-canvas)",
            fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-muted)",
            display: "flex", gap: 10, alignItems: "center",
          }}>
            <span style={{ color: "var(--fg-dim)" }}>cron</span>
            <span style={{ color: "var(--accent)" }}>0 2 * * *</span>
            <span style={{ flex: 1 }} />
            <span>next run · <b style={{ color: "var(--fg)" }}>{s.nextRun}</b></span>
          </div>
        </div>

        <Lbl c="info">target</Lbl>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="tab">
            <select className="input" defaultValue={s.target.split(" › ")[0]}>
              <option>orchestrator</option><option>feat/tunnel</option>
              <option>scratch</option><option>all tabs</option>
            </select>
          </Field>
          <Field label="pane (agent)">
            <select className="input" defaultValue={s.target.split(" › ")[1] ?? ""}>
              <option>@scratch</option><option>@reviewer</option>
              <option>@docs</option><option>@github</option><option>(any free)</option>
            </select>
          </Field>
          <Field label="if tab isn't open">
            <select className="input" defaultValue="open">
              <option value="open">open it</option><option>skip</option><option>queue</option>
            </select>
          </Field>
          <Field label="if pane is busy">
            <select className="input" defaultValue="queue">
              <option>wait briefly</option><option value="queue">queue behind current run</option><option>skip</option>
            </select>
          </Field>
        </div>

        <Lbl c="success">action</Lbl>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{
            display: "flex", gap: 6, padding: 3, background: "var(--bg-elev)",
            borderRadius: 6, border: "1px solid var(--border-soft)", width: "fit-content",
          }}>
            <Pill on={s.action === "command"}>run command</Pill>
            <Pill on={s.action === "knowledge"}>load knowledge block</Pill>
            <Pill>reset pane</Pill>
          </div>
          {s.action === "command"
            ? <CommandAction detail={s.detail} />
            : <KnowledgeAction detail={s.detail} />}
        </div>

        <Lbl c="muted">guard</Lbl>
        <div style={{
          display: "flex", gap: 14, alignItems: "center", fontSize: 11.5, flexWrap: "wrap",
          color: "var(--fg-muted)",
        }}>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" defaultChecked style={{ accentColor: "var(--accent)" }} /> notify on failure
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" defaultChecked style={{ accentColor: "var(--accent)" }} /> max 1 concurrent run
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" style={{ accentColor: "var(--accent)" }} /> dry-run only (log, don't execute)
          </label>
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input type="checkbox" style={{ accentColor: "var(--accent)" }} /> pause when on battery
          </label>
        </div>
      </div>
    </div>
  );
}

const HISTORY_RUNS = [
  { ts: "today 02:00",     st: "ok",   dur: "38s",   out: "digest block updated (blk_d9f0)" },
  { ts: "yesterday 02:00", st: "ok",   dur: "42s",   out: "no new decisions; reused" },
  { ts: "2d ago 02:00",    st: "warn", dur: "1m12s", out: "context cap hit; truncated 4 blocks" },
  { ts: "3d ago 02:00",    st: "ok",   dur: "35s",   out: "digest block updated (blk_d9c1)" },
  { ts: "4d ago 02:00",    st: "fail", dur: "6s",    out: "claude · rate-limited; retried at 02:05 (ok)" },
];

function ScheduleHistory({ s }: { s: Schedule }) {
  return (
    <div className="card" style={{ padding: "14px 18px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>Run history</h3>
        <span className="hint">{s.id} · last 5</span>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" style={{ height: 24, fontSize: 10.5 }}>view all</button>
      </div>
      <div style={{ borderRadius: 6, border: "1px solid var(--border-soft)", overflow: "hidden" }}>
        {HISTORY_RUNS.map((r, i) => (
          <div key={i} style={{
            display: "grid", gridTemplateColumns: "170px 80px 60px 1fr",
            gap: 10, padding: "9px 14px", alignItems: "baseline", fontSize: 11,
            background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
            borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
          }}>
            <span style={{ fontFamily: "var(--mono)", color: "var(--fg-muted)" }}>{r.ts}</span>
            <span style={{
              fontFamily: "var(--mono)", fontSize: 10.5,
              color: r.st === "ok" ? "var(--success)" : r.st === "warn" ? "var(--accent)" : "var(--danger)",
            }}>
              {r.st === "ok" ? "✓ ok" : r.st === "warn" ? "◑ warn" : "✗ fail"}
            </span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)" }}>{r.dur}</span>
            <span style={{
              color: "var(--fg-muted)", fontFamily: "var(--mono)", fontSize: 10.5,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>{r.out}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function SchedulesTab() {
  const sel = SCHEDULES.find(s => s.sel) ?? SCHEDULES[0];
  return (
    <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 16, height: "100%" }}>
      <div className="card" style={{ padding: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ padding: "12px 14px 8px", borderBottom: "1px solid var(--border-soft)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
            <h3 style={{ margin: 0 }}>Schedules</h3>
            <span className="hint">5 total · 4 armed</span>
          </div>
          <input className="input" placeholder="filter…" style={{ marginTop: 8, height: 24, fontSize: 10.5 }} />
        </div>
        <div style={{ flex: 1, overflow: "auto" }}>
          {SCHEDULES.map(s => (
            <div key={s.id} style={{
              padding: "11px 14px", borderBottom: "1px solid var(--border-soft)",
              background: s.sel ? "var(--bg-elev)" : "transparent",
              borderLeft: s.sel ? "2px solid var(--accent)" : "2px solid transparent",
              paddingLeft: s.sel ? 12 : 14,
              cursor: "pointer",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: s.on ? "var(--success)" : "var(--fg-dim)",
                }} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>{s.id}</span>
                <span style={{ flex: 1 }} />
                <span className={"tag " + (s.action === "knowledge" ? "info" : "")} style={{ fontSize: 9.5 }}>
                  {s.action}
                </span>
              </div>
              <div style={{
                fontSize: 12, color: s.sel ? "var(--fg)" : "var(--fg-muted)",
                marginTop: 4, fontWeight: 500,
              }}>{s.name}</div>
              <div style={{
                marginTop: 5, fontFamily: "var(--mono)", fontSize: 9.5,
                color: "var(--fg-dim)", display: "flex", gap: 8, flexWrap: "wrap",
              }}>
                <span>⏱ {s.when}</span>
                <span>→ {s.target}</span>
              </div>
            </div>
          ))}
          <div style={{ padding: "12px 14px" }}>
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center" }}>+ new schedule</button>
          </div>
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 12, minWidth: 0 }}>
        <ScheduleEditor s={sel} />
        <ScheduleHistory s={sel} />
      </div>
    </div>
  );
}
