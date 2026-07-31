// #4091 fixtures — the three structural rules the algorithms harvest now applies.

// A COMPONENT: renders JSX, so it belongs to the component graph (`bsc ui harvest`), never here.
export function StatusBadge({ ok }: { ok: boolean }) {
  return <span className={ok ? "ok" : "bad"}>{ok ? "OK" : "FAIL"}</span>;
}

// A React HOOK: bound to React's runtime and this app's store — glue, not portable computation.
export function useThingCount(): number {
  const rows = useAppStore((s) => s.things);
  return rows.length;
}

// A module-level ALGORITHM with a NESTED closure. The outer function is a candidate; `step` is not —
// nothing outside `rollingMean` can name it.
export function rollingMean(xs: number[], window: number): number[] {
  const step = (acc: number, x: number) => acc + x;
  const out: number[] = [];
  for (let i = 0; i + window <= xs.length; i++) {
    out.push(xs.slice(i, i + window).reduce(step, 0) / window);
  }
  return out;
}
