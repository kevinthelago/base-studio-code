import { useAppStore } from "@/store";
import { StatTile } from "@/shared/ui/data/StatTile";
import { SelectField } from "@/shared/ui/controls/Field";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { EmptyState } from "@/shared/ui/feedback/EmptyState";
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
    <Box as="span" className={"status-chip" + (status === st ? " on" : "")} data-st={st} onClick={() => setStatus(st)}>
      <Box as="span" className="dot" />{label}
      {count !== undefined && <Text as="span" tone="dim" style={{ marginLeft: 2 }}>{count}</Text>}
    </Box>
  );

  // The runs are read straight from the store (instant, no async load), so there's no loading skeleton
  // here — a compact empty state replaces the bare "No runs yet" text when nothing has run (#2247).
  if (rows.length === 0) {
    return (
      <EmptyState
        icon="◷" iconVariant="dashed"
        title="No runs yet"
        description="Armed automations record every run here — when it fired, its target, and the outcome."
      />
    );
  }

  return (
    <>
      <Box className="hist-summary">
        <StatTile k="total runs" v={rows.length} sub={<>across {automations.length} automations</>} />
        <StatTile k="success rate" v={`${succRate}%`} tone="success" sub={<>{ok} ok · {skipped} skipped · {fail} fail</>} />
        <StatTile k="skipped" v={skipped} sub="target wasn't open" />
        <StatTile k="failed" v={fail} tone="danger" sub="dispatch errored" />
      </Box>

      <Box className="history-toolbar">
        <Box as="span" className="lbl">status</Box>
        <Box className="chips">
          {chip("all", "all")}
          {chip("ok", "ok", ok)}
          {chip("skipped", "skipped", skipped)}
          {chip("fail", "fail", fail)}
        </Box>
        <Box as="span" className="lbl" style={{ marginLeft: 14 }}>automation</Box>
        <SelectField style={{ width: 240 }} value={sched} onChange={setSched}>
          <option value="all">all automations</option>
          {automations.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </SelectField>
        <Box className="spacer" />
      </Box>

      <Box className="hist-table">
        <Box className="hist-row head">
          <Text as="span">when</Text><Text as="span">automation</Text><Text as="span">target</Text><Text as="span">status</Text><Text as="span">note</Text>
        </Box>
        {filtered.map((r, i) => (
          <Box className="hist-row" key={i}>
            <Box as="span" className="when">{fmtStamp(r.at)}</Box>
            <Box as="span" className="sched">{r.name}</Box>
            <Box as="span" className="target">{r.target}</Box>
            <Box as="span" className={"st-cell " + r.status}><Box as="span" className="sym">{SYM[r.status]}</Box> {r.status}</Box>
            <Box as="span" className="out">{r.note}</Box>
          </Box>
        ))}
      </Box>
    </>
  );
}
