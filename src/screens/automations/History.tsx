import { AUTO_SCHEDULES, AUTO_HISTORY, type RunStatus } from "../../data/automations";

type StatusFilter = "all" | RunStatus;

interface HistoryProps {
  status: StatusFilter;
  setStatus: (s: StatusFilter) => void;
  sched: string; // "all" | schedule id
  setSched: (s: string) => void;
}

const SYM: Record<RunStatus, string> = { ok: "✓", warn: "◑", fail: "✗" };

/** The History tab — summary cards + a filterable cross-schedule run table. */
export function HistoryTab({ status, setStatus, sched, setSched }: HistoryProps) {
  const filtered = AUTO_HISTORY.filter(r =>
    (status === "all" || r.status === status) && (sched === "all" || r.sid === sched),
  );
  const ok = AUTO_HISTORY.filter(r => r.status === "ok").length;
  const warn = AUTO_HISTORY.filter(r => r.status === "warn").length;
  const fail = AUTO_HISTORY.filter(r => r.status === "fail").length;
  const succRate = Math.round((100 * ok) / AUTO_HISTORY.length);

  const chip = (st: StatusFilter, label: string, count?: number) => (
    <span
      className={"status-chip" + (status === st ? " on" : "")}
      data-st={st}
      onClick={() => setStatus(st)}
    >
      <span className="dot" />{label}
      {count !== undefined && <span style={{ color: "var(--fg-dim)", marginLeft: 2 }}>{count}</span>}
    </span>
  );

  return (
    <>
      <div className="hist-summary">
        <div className="card">
          <div className="k">last 7 days</div>
          <div className="v">{AUTO_HISTORY.length}</div>
          <div className="sub">runs across {AUTO_SCHEDULES.length} schedules</div>
        </div>
        <div className="card">
          <div className="k">success rate</div>
          <div className="v success">{succRate}%</div>
          <div className="sub">{ok} ok · {warn} warn · {fail} fail</div>
        </div>
        <div className="card">
          <div className="k">avg duration</div>
          <div className="v">24s</div>
          <div className="sub">p95 · 1m 42s</div>
        </div>
        <div className="card">
          <div className="k">next run</div>
          <div className="v accent">15:15</div>
          <div className="sub">S-04 · Refresh review policy</div>
        </div>
      </div>

      <div className="history-toolbar">
        <span className="lbl">status</span>
        <div className="chips">
          {chip("all", "all")}
          {chip("ok", "ok", ok)}
          {chip("warn", "warn", warn)}
          {chip("fail", "fail", fail)}
        </div>
        <span className="lbl" style={{ marginLeft: 14 }}>schedule</span>
        <select className="input" style={{ width: 240 }} value={sched} onChange={e => setSched(e.target.value)}>
          <option value="all">all schedules</option>
          {AUTO_SCHEDULES.map(s => <option key={s.id} value={s.id}>{s.id} · {s.name}</option>)}
        </select>
        <div className="spacer" />
        <input className="input" placeholder="search output…" style={{ width: 220 }} />
        <button className="btn ghost">export csv</button>
      </div>

      <div className="hist-table">
        <div className="hist-row head">
          <span>when</span><span>id</span><span>schedule</span><span>target</span><span>status</span><span>duration</span><span>trigger</span>
        </div>
        {filtered.map((r, i) => (
          <div className="hist-row" key={i}>
            <span className="when">{r.when}</span>
            <span className="sid">{r.sid}</span>
            <span><div className="sched">{r.name}</div><div className="out">{r.out}</div></span>
            <span className="target">{r.target}</span>
            <span className={"st-cell " + r.status}><span className="sym">{SYM[r.status]}</span> {r.status}</span>
            <span className="dur">{r.dur}</span>
            <span className="trig">{r.trigger}</span>
          </div>
        ))}
      </div>
    </>
  );
}
