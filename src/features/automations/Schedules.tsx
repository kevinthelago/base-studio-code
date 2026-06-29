import { useAppStore } from "@/store";
import { paneCount, type Every, type Automation, type SimpleWhen } from "./lib/scheduler";
import { isValidCron } from "./lib/cron";
import { fmtStamp } from "./format";
import { Pane } from "@/shared/ui/Pane";
import { Chip } from "@/shared/ui/Chip";
import { SegmentedControl } from "@/shared/ui/SegmentedControl";
import { EmptyState } from "@/shared/ui/EmptyState";

const EVERY_OPTS: Every[] = ["minute", "hour", "day", "weekday"];

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

/** The Schedules tab — the full-width list of automations. Selecting one opens the slide-in
 *  <ScheduleDrawer> (rendered in the screen overlay), matching the MCP + Skills editor drawers (#1824). */
export function SchedulesTab({ selectedId, onSelect, onNew }: {
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
}) {
  const automations = useAppStore(s => s.automations);

  if (automations.length === 0) {
    return (
      <EmptyState
        title="No automations yet"
        description="Schedule a command to fire into a console pane on a cadence."
        actions={<button className="btn primary" onClick={onNew}>+ New automation</button>}
      />
    );
  }

  const armedCount = automations.filter(a => a.armed).length;
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
            <div key={a.id} className={"sched-row" + (a.id === selectedId ? " on" : "")} onClick={() => onSelect(a.id)}>
              <div className="l1">
                <span className={"dot" + (a.armed ? "" : " off")} />
                <span className="spacer" />
                <Chip style={{ fontSize: 9.5 }}>{a.action}</Chip>
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
    </div>
  );
}

/** The slide-in editor for the selected schedule — the unified <Pane> drawer (#1824), the same
 *  chrome as the MCP server/hook + Skills drawers. Rendered in the AutomationsScreen overlay. */
export function ScheduleDrawer({ selected, onClose, onViewAllHistory }: {
  selected: Automation | null;
  onClose: () => void;
  onViewAllHistory: (id: string) => void;
}) {
  const { updateAutomation, setAutomationArmed, removeAutomation, tabs, paneNames } = useAppStore();
  const sel = selected;
  const close = onClose;

  const tabIdx = sel ? tabs.findIndex(t => t.name === sel.targetTab) : -1;
  const paneOpts = tabIdx >= 0 ? Array.from({ length: paneCount(tabs[tabIdx].layout) }, (_, i) => i) : [];
  const patchSimple = (p: Partial<SimpleWhen>) => {
    if (sel && sel.when.kind === "simple") updateAutomation(sel.id, { when: { ...sel.when, ...p } });
  };
  const setMode = (kind: "simple" | "cron") => {
    if (!sel || kind === sel.when.kind) return;
    updateAutomation(sel.id, {
      when: kind === "cron" ? { kind: "cron", expr: "0 9 * * *" } : { kind: "simple", every: "day", at: "09:00" },
    });
  };

  return (
    <Pane
      flush
      open={!!sel}
      onClose={close}
      onRemove={() => { if (sel) { removeAutomation(sel.id); close(); } }}
      header={sel && (
        <>
          <input className="name-input" value={sel.name} onChange={e => updateAutomation(sel.id, { name: e.target.value })} />
          <span className={"toggle" + (sel.armed ? " on" : "")} title="armed" onClick={() => setAutomationArmed(sel.id, !sel.armed)} />
          <span style={{ color: sel.armed ? "var(--success)" : "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 11 }}>{sel.armed ? "armed" : "disarmed"}</span>
        </>
      )}
      body={sel && (
        <>
          {/* when */}
          <div className="es"><div className="es-row">
            <div className="es-lbl accent">when</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <SegmentedControl
                options={[
                  { label: "simple", on: sel.when.kind === "simple", onClick: () => setMode("simple") },
                  { label: "cron", on: sel.when.kind === "cron", onClick: () => setMode("cron") },
                ]}
              />
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
              <input className="input" placeholder="command to run in the target pane…" value={sel.command ?? ""} onChange={e => updateAutomation(sel.id, { command: e.target.value })} />
              <span className="hint">Typed into the target pane's session, then submitted.</span>
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
        </>
      )}
    />
  );
}
