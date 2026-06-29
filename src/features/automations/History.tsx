import { useAppStore } from "@/store";
import { StatTile } from "@/shared/ui/data/StatTile";
import type { RunStatus } from "./lib/scheduler";
import { fmtStamp } from "./format";

type StatusFilter = "all" | RunStatus;

interface HistoryProps {
  status: StatusFilter;
  setStatus: (s: StatusFilter) => void;
  sched: string; // "all" | automation id
  setSched: (s: string) => void;
}

const SYM: Record<RunStatus, string> = { ok: "✓", skipped: "−", fail: "✗" };

interface Row { at: number; autoId: string; name: string; target: string; status: RunStatus; note: string }

/** The History tab — every recorded automation run, filterable by status + automation. */
export function HistoryTab({ status, setStatus, sched, setSched }: HistoryProps) {
  const { automations } = useAppStore();

  const rows: Row[] = automations
    .flatMap(a => a.runs.map(r => ({
      at: r.at, autoId: a.id, name: a.name,
      target: a.targetTab ? `${a.targetTab} › pane ${a.targetPaneIdx + 1}` : "(no target)",
      status: r.status, note: r.note,
    })))
    .sort((x, y) => y.at - x.at);

  const ok = rows.filter(r => r.status === "ok").length;
  const skipped = rows.filter(r => r.status === "skipped").length;
  const fail = rows.filter(r => r.status === "fail").length;
  const succRate = rows.length ? Math.round((100 * ok) / rows.length) : 0;

  const filtered = rows.filter(r =>
    (status === "all" || r.status === status) && (sched === "all" || r.autoId === sched));

  const chip = (st: StatusFilter, label: string, count?: number) => (
    <span className={"status-chip" + (status === st ? " on" : "")} data-st={st} onClick={() => setStatus(st)}>
      <span className="dot" />{label}
      {count !== undefined && <span style={{ color: "var(--fg-dim)", marginLeft: 2 }}>{count}</span>}
    </span>
  );

  if (rows.length === 0) {
    return (
      <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
        No runs yet — armed automations record their runs here.
      </div>
    );
  }

  return (
    <>
      <div className="hist-summary">
        <StatTile k="total runs" v={rows.length} sub={<>across {automations.length} automations</>} />
        <StatTile k="success rate" v={`${succRate}%`} tone="success" sub={<>{ok} ok · {skipped} skipped · {fail} fail</>} />
        <StatTile k="skipped" v={skipped} sub="target wasn't open" />
        <StatTile k="failed" v={fail} tone="danger" sub="dispatch errored" />
      </div>

      <div className="history-toolbar">
        <span className="lbl">status</span>
        <div className="chips">
          {chip("all", "all")}
          {chip("ok", "ok", ok)}
          {chip("skipped", "skipped", skipped)}
          {chip("fail", "fail", fail)}
        </div>
        <span className="lbl" style={{ marginLeft: 14 }}>automation</span>
        <select className="input" style={{ width: 240 }} value={sched} onChange={e => setSched(e.target.value)}>
          <option value="all">all automations</option>
          {automations.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="spacer" />
      </div>

      <div className="hist-table">
        <div className="hist-row head">
          <span>when</span><span>automation</span><span>target</span><span>status</span><span>note</span>
        </div>
        {filtered.map((r, i) => (
          <div className="hist-row" key={i}>
            <span className="when">{fmtStamp(r.at)}</span>
            <span className="sched">{r.name}</span>
            <span className="target">{r.target}</span>
            <span className={"st-cell " + r.status}><span className="sym">{SYM[r.status]}</span> {r.status}</span>
            <span className="out">{r.note}</span>
          </div>
        ))}
      </div>
    </>
  );
}
