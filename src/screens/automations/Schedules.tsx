import { useAppStore } from "../../store";
import { paneCount, type Every, type Automation, type SimpleWhen } from "../../lib/automations/scheduler";
import { isValidCron } from "../../lib/automations/cron";
import { fmtStamp } from "./format";

const EVERY_OPTS: Every[] = ["minute", "hour", "day", "weekday"];

interface SchedulesTabProps {
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  onNew: () => void;
  onViewAllHistory: (id: string) => void;
}

function runsTable(runs: Automation["runs"]) {
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
          <span className="t">{fmtStamp(r.at)}</span>
          <span className={"st " + r.status}>{r.status === "ok" ? "✓ ok" : r.status === "skipped" ? "− skipped" : "✗ fail"}</span>
          <span className="out">{r.note}</span>
        </div>
      ))}
    </div>
  );
}

/** The Schedules tab — list of real automations + a live editor for the selected one. */
export function SchedulesTab({ selectedId, setSelectedId, onNew, onViewAllHistory }: SchedulesTabProps) {
  const { automations, updateAutomation, setAutomationArmed, removeAutomation, tabs, paneNames, kbBlocks } = useAppStore();

  if (automations.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--fg-muted)" }}>No automations yet</div>
        <div className="hint" style={{ maxWidth: 380, textAlign: "center", lineHeight: 1.6 }}>
          Schedule a command or a knowledge block to fire into a console pane on a cadence.
        </div>
        <button className="btn primary" onClick={onNew}>+ New automation</button>
      </div>
    );
  }

  const sel = automations.find(a => a.id === selectedId) ?? automations[0];
  const armedCount = automations.filter(a => a.armed).length;
  const tabIdx = tabs.findIndex(t => t.name === sel.targetTab);
  const paneOpts = tabIdx >= 0 ? Array.from({ length: paneCount(tabs[tabIdx].layout) }, (_, i) => i) : [];
  const isSimple = sel.when.kind === "simple";
  const patchSimple = (p: Partial<SimpleWhen>) => {
    if (sel.when.kind !== "simple") return;
    updateAutomation(sel.id, { when: { ...sel.when, ...p } });
  };
  const setMode = (kind: "simple" | "cron") => {
    if (kind === sel.when.kind) return;
    updateAutomation(sel.id, {
      when: kind === "cron" ? { kind: "cron", expr: "0 9 * * *" } : { kind: "simple", every: "day", at: "09:00" },
    });
  };

  return (
    <div className="sched-layout">
      <div className="card sched-list">
        <div className="head">
          <div className="head-row">
            <h3>Schedules</h3>
            <span className="hint">{automations.length} total · {armedCount} armed</span>
          </div>
        </div>
        <div className="scroll">
          {automations.map(a => (
            <div key={a.id} className={"sched-row" + (a.id === sel.id ? " on" : "")} onClick={() => setSelectedId(a.id)}>
              <div className="l1">
                <span className={"dot" + (a.armed ? "" : " off")} />
                <span className="spacer" />
                <span className={"tag" + (a.action === "knowledge" ? " info" : "")} style={{ fontSize: 9.5 }}>{a.action}</span>
              </div>
              <div className="name">{a.name}</div>
              <div className="meta">
                <span>{a.when.kind === "simple"
                  ? `⏱ every ${a.when.every}${a.when.every !== "minute" ? " · " + a.when.at : ""}`
                  : `⏱ cron · ${a.when.expr}`}</span>
                <span>{a.targetTab ? `→ ${a.targetTab} › pane ${a.targetPaneIdx + 1}` : "→ (no target)"}</span>
              </div>
            </div>
          ))}
          <div style={{ padding: "12px 14px" }}>
            <button className="btn ghost" style={{ width: "100%", justifyContent: "center" }} onClick={onNew}>+ new automation</button>
          </div>
        </div>
      </div>

      <div className="card editor">
        <div className="head">
          <input className="name-input" value={sel.name} onChange={e => updateAutomation(sel.id, { name: e.target.value })} />
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontFamily: "var(--mono)", fontSize: 11 }}>
            <span className={"toggle" + (sel.armed ? " on" : "")} title="armed" onClick={() => setAutomationArmed(sel.id, !sel.armed)} />
            <span style={{ color: sel.armed ? "var(--success)" : "var(--fg-dim)" }}>{sel.armed ? "armed" : "disarmed"}</span>
          </div>
          <button className="btn danger" onClick={() => { removeAutomation(sel.id); setSelectedId(null); }}>delete</button>
        </div>

        {/* when */}
        <div className="es"><div className="es-row">
          <div className="es-lbl accent">when</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div className="pill-group">
              <div className={"pill" + (isSimple ? " on" : "")} onClick={() => setMode("simple")}>simple</div>
              <div className={"pill" + (!isSimple ? " on" : "")} onClick={() => setMode("cron")}>cron</div>
            </div>
            {sel.when.kind === "simple" ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                <span>every</span>
                <select className="input" style={{ width: 120 }} value={sel.when.every} onChange={e => patchSimple({ every: e.target.value as Every })}>
                  {EVERY_OPTS.map(o => <option key={o} value={o}>{o}</option>)}
                </select>
                {sel.when.every !== "minute" && (
                  <>
                    <span>at</span>
                    <input className="input" style={{ width: 90 }} value={sel.when.at}
                      placeholder={sel.when.every === "hour" ? ":MM" : "HH:MM"}
                      onChange={e => patchSimple({ at: e.target.value })} />
                  </>
                )}
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>
                <span>cron</span>
                <input className="input" style={{ width: 200 }} value={sel.when.expr} placeholder="0 9 * * *" spellCheck={false}
                  onChange={e => updateAutomation(sel.id, { when: { kind: "cron", expr: e.target.value } })} />
                {isValidCron(sel.when.expr)
                  ? <span style={{ color: "var(--fg-dim)", fontSize: 10 }}>min hour day-of-month month day-of-week</span>
                  : <span style={{ color: "var(--danger)", fontSize: 10 }}>invalid expression</span>}
              </div>
            )}
            <div className="cron-strip">
              <span className="label">next run</span>
              <span className="expr">{sel.armed ? fmtStamp(sel.nextRunAt) : "disarmed"}</span>
              <span style={{ flex: 1 }} />
              <span>last · <b>{sel.lastRunAt ? fmtStamp(sel.lastRunAt) : "never"}</b></span>
            </div>
          </div>
        </div></div>

        {/* target */}
        <div className="es"><div className="es-row">
          <div className="es-lbl info">target</div>
          {tabs.length === 0 ? (
            <div className="hint">No console tabs open — open a console (and a pane) to target.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div className="field"><label>console</label>
                <select className="input" value={sel.targetTab} onChange={e => updateAutomation(sel.id, { targetTab: e.target.value, targetPaneIdx: 0 })}>
                  {!tabs.some(t => t.name === sel.targetTab) && <option value={sel.targetTab}>{sel.targetTab || "(pick a console)"}</option>}
                  {tabs.map(t => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
              </div>
              <div className="field"><label>pane</label>
                <select className="input" value={sel.targetPaneIdx} onChange={e => updateAutomation(sel.id, { targetPaneIdx: Number(e.target.value) })}>
                  {paneOpts.length === 0 && <option value={0}>Pane 1</option>}
                  {paneOpts.map(i => {
                    const nm = paneNames[tabIdx]?.[i];
                    return <option key={i} value={i}>Pane {i + 1}{nm ? ` · ${nm}` : ""}</option>;
                  })}
                </select>
              </div>
            </div>
          )}
        </div></div>

        {/* action */}
        <div className="es"><div className="es-row">
          <div className="es-lbl success">action</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div className="pill-group">
              <div className={"pill" + (sel.action === "command" ? " on" : "")} onClick={() => updateAutomation(sel.id, { action: "command" })}>run command</div>
              <div className={"pill" + (sel.action === "knowledge" ? " on" : "")} onClick={() => updateAutomation(sel.id, { action: "knowledge" })}>load knowledge block</div>
            </div>
            {sel.action === "command" ? (
              <input className="input" placeholder="command to run in the target pane…" value={sel.command ?? ""} onChange={e => updateAutomation(sel.id, { command: e.target.value })} />
            ) : (
              <select className="input" value={sel.blockId ?? ""} onChange={e => updateAutomation(sel.id, { blockId: e.target.value })}>
                <option value="">— pick a knowledge block —</option>
                {kbBlocks.map(b => <option key={b.id} value={b.id}>{b.title}</option>)}
              </select>
            )}
            <span className="hint">
              {sel.action === "command"
                ? "Typed into the target pane's session, then submitted."
                : "The block's content is injected into the target pane as a message."}
            </span>
          </div>
        </div></div>

        {/* history */}
        <div className="es" style={{ background: "var(--bg-canvas)" }}><div className="es-row">
          <div className="es-lbl muted">history</div>
          <div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 10 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-muted)" }}>last {sel.runs.length} runs</span>
              <span style={{ flex: 1 }} />
              {sel.runs.length > 0 && <button className="btn ghost" style={{ height: 22, fontSize: 10.5 }} onClick={() => onViewAllHistory(sel.id)}>view all →</button>}
            </div>
            {runsTable(sel.runs)}
          </div>
        </div></div>
      </div>
    </div>
  );
}
