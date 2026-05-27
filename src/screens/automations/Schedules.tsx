import { useState } from "react";
import { AUTO_SCHEDULES, AUTO_RUNS, type AutoSchedule, type AutoRun } from "../../data/automations";

function runsTable(runs: AutoRun[]) {
  if (runs.length === 0) {
    return (
      <div style={{ padding: 14, textAlign: "center", color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 11, border: "1px dashed var(--border)", borderRadius: 6 }}>
        no runs yet
      </div>
    );
  }
  return (
    <div className="runs-table">
      {runs.map((r, i) => (
        <div className="r" key={i}>
          <span className="t">{r.when}</span>
          <span className={"st " + r.status}>{r.status === "ok" ? "✓ ok" : r.status === "warn" ? "◑ warn" : "✗ fail"}</span>
          <span className="dur">{r.dur}</span>
          <span className="out">{r.out}</span>
        </div>
      ))}
    </div>
  );
}

function cmdAction(s: AutoSchedule) {
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>command</span>
        <input className="input" placeholder="type a command…" style={{ flex: 1 }} defaultValue={s.action.detail} key={s.id} />
      </div>
      <div className="script-box">
        <div className="head">
          <span>command</span><span>·</span>
          <select className="input" style={{ height: 18, fontSize: 10, padding: "0 6px", width: "auto" }} defaultValue="run as shell">
            <option>run as shell</option><option>send as message to claude</option><option>inject as system prompt</option>
          </select>
          <span style={{ flex: 1 }} />
          <span className="fire">▶ test fire</span>
        </div>
        <pre><span className="prompt">$</span> {s.action.detail}</pre>
      </div>
    </>
  );
}

function knowAction(s: AutoSchedule) {
  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>block</span>
        <select className="input" style={{ flex: "0 0 320px" }} defaultValue="blk_9a2c">
          <option value="blk_9a2c">blk_9a2c · Review policy — TS / Rust</option>
          <option>blk_71fe · Tunnel framing v2</option>
          <option>blk_4ad8 · @reviewer system prompt</option>
          <option>blk_2199 · Decision · SQLite over LMDB</option>
        </select>
        <span className="tag amber">#review-policy</span>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)", textTransform: "uppercase", letterSpacing: ".06em" }}>load as</span>
        <div className="pill-group">
          <div className="pill on">pinned context</div>
          <div className="pill">user message</div>
          <div className="pill">system prompt</div>
        </div>
        <span style={{ flex: 1 }} />
        <span className="hint">survives /reset · removed when schedule disabled</span>
      </div>
      <div className="script-box">
        <div className="head">
          <span>preview</span><span>·</span>
          <span style={{ color: "var(--accent)" }}>{s.action.block}</span>
          <span style={{ flex: 1 }} />
          <span style={{ color: "var(--fg-dim)" }}>42 lines · last updated 14:02</span>
        </div>
        <pre style={{ color: "var(--fg-muted)", fontSize: 11 }}>{`# Review policy — TS / Rust

Applies to: acme/payments, acme/ledger-core

## Required signals
- cargo clippy --workspace must pass
- cargo fmt --check must pass
- New public surface needs a doc-comment
…`}</pre>
      </div>
    </>
  );
}

/** The Schedules tab — list of schedules plus a deep editor for the selected one. */
export function SchedulesTab({ onViewAllHistory }: { onViewAllHistory: (sid: string) => void }) {
  const [selectedId, setSelectedId] = useState(AUTO_SCHEDULES[0].id);
  const [armed, setArmed] = useState<Record<string, boolean>>(
    () => Object.fromEntries(AUTO_SCHEDULES.map(s => [s.id, s.on])),
  );
  const sel = AUTO_SCHEDULES.find(s => s.id === selectedId) ?? AUTO_SCHEDULES[0];
  const isCmd = sel.action.kind === "command";
  const armedCount = AUTO_SCHEDULES.filter(s => armed[s.id]).length;
  const runs = AUTO_RUNS[sel.id] ?? [];

  return (
    <div className="sched-layout">
      <div className="card sched-list">
        <div className="head">
          <div className="head-row">
            <h3>Schedules</h3>
            <span className="hint">{AUTO_SCHEDULES.length} total · {armedCount} armed</span>
          </div>
          <input className="input" placeholder="filter…" style={{ marginTop: 8, height: 24, fontSize: 10.5 }} />
        </div>
        <div className="scroll">
          {AUTO_SCHEDULES.map(s => (
            <div key={s.id} className={"sched-row" + (s.id === sel.id ? " on" : "")} onClick={() => setSelectedId(s.id)}>
              <div className="l1">
                <span className={"dot" + (armed[s.id] ? "" : " off")} />
                <span className="sid">{s.id}</span>
                <span className="spacer" />
                <span className={"tag" + (s.action.kind === "knowledge" ? " info" : "")} style={{ fontSize: 9.5 }}>{s.action.kind}</span>
              </div>
              <div className="name">{s.name}</div>
              <div className="meta">
                <span>⏱ every {s.when.every} · {s.when.at}</span>
                <span>→ {s.target.console}{s.target.pane ? " › " + s.target.pane : ""}</span>
              </div>
            </div>
          ))}
          <div style={{ padding: "12px 14px" }}>
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center" }}>+ new schedule</button>
          </div>
        </div>
      </div>

      <div className="card editor">
        <div className="head">
          <span className="sid">{sel.id}</span>
          <input className="name-input" defaultValue={sel.name} key={sel.id} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
            <span className={"toggle" + (armed[sel.id] ? " on" : "")} title="armed" onClick={() => setArmed(a => ({ ...a, [sel.id]: !a[sel.id] }))} />
            <span style={{ color: armed[sel.id] ? "var(--success)" : "var(--fg-dim)" }}>{armed[sel.id] ? "armed" : "disarmed"}</span>
          </div>
          <button className="btn">save</button>
        </div>

        {/* when */}
        <div className="es">
          <div className="es-row">
            <div className="es-lbl accent">when</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="pill-group">
                <div className="pill on">simple</div>
                <div className="pill">cron</div>
                <div className="pill">after event</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                <span>every</span>
                <select className="input" style={{ width: 120 }} value={sel.when.every} key={sel.id + "-every"} onChange={() => {}}>
                  <option value="day">day</option><option value="weekday">weekday</option><option value="week">week</option><option value="month">month</option><option value="hour">hour</option>
                </select>
                <span>at</span>
                <input className="input" defaultValue={sel.when.at} style={{ width: 80 }} key={sel.id + "-at"} />
                <span>·</span>
                <select className="input" style={{ width: 120 }} defaultValue="local"><option>local</option><option>UTC</option></select>
              </div>
              <div className="cron-strip">
                <span className="label">cron</span>
                <span className="expr">{sel.cron}</span>
                <span style={{ flex: 1 }} />
                <span>next run · <b>{sel.nextRun}</b></span>
              </div>
            </div>
          </div>
        </div>

        {/* target */}
        <div className="es">
          <div className="es-row">
            <div className="es-lbl info">target</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field"><label>console</label>
                <select className="input" value={sel.target.console} key={sel.id + "-con"} onChange={() => {}}>
                  <option>orchestrator</option><option>feat/tunnel</option><option>scratch</option><option>all consoles</option>
                </select>
              </div>
              <div className="field"><label>pane (agent)</label>
                <select className="input" value={sel.target.pane || "(any free)"} key={sel.id + "-pane"} onChange={() => {}}>
                  <option>@scratch</option><option>@reviewer</option><option>@docs</option><option>@github</option><option>(any free)</option>
                </select>
              </div>
              <div className="field"><label>if console isn't open</label>
                <select className="input" defaultValue="open it"><option>open it</option><option>skip</option><option>queue</option></select>
              </div>
              <div className="field"><label>if pane is busy</label>
                <select className="input" defaultValue="queue behind current run"><option>wait briefly</option><option>queue behind current run</option><option>skip</option></select>
              </div>
            </div>
          </div>
        </div>

        {/* action */}
        <div className="es">
          <div className="es-row">
            <div className="es-lbl success">action</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="pill-group">
                <div className={"pill" + (isCmd ? " on" : "")}>run command</div>
                <div className={"pill" + (!isCmd ? " on" : "")}>load knowledge block</div>
                <div className="pill">reset pane</div>
              </div>
              {isCmd ? cmdAction(sel) : knowAction(sel)}
            </div>
          </div>
        </div>

        {/* guard */}
        <div className="es">
          <div className="es-row">
            <div className="es-lbl muted">guard</div>
            <div className="guards">
              <label><input type="checkbox" defaultChecked style={{ accentColor: "var(--accent)" }} /> notify on failure</label>
              <label><input type="checkbox" defaultChecked style={{ accentColor: "var(--accent)" }} /> max 1 concurrent run</label>
              <label><input type="checkbox" style={{ accentColor: "var(--accent)" }} /> dry-run only</label>
              <label><input type="checkbox" style={{ accentColor: "var(--accent)" }} /> pause when on battery</label>
            </div>
          </div>
        </div>

        {/* history */}
        <div className="es" style={{ background: "var(--bg-canvas)" }}>
          <div className="es-row">
            <div className="es-lbl muted">history</div>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>last {runs.length} runs</span>
                <span style={{ flex: 1 }} />
                <button className="btn ghost" style={{ height: 22, fontSize: 10.5 }} onClick={() => onViewAllHistory(sel.id)}>view all →</button>
              </div>
              {runsTable(runs)}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
