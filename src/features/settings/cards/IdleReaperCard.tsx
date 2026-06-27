import { useAppStore } from "@/store";
import { Toggle } from "@/shared/ui/Toggle";
import { SettingsRow as Row, SettingsSelect as Select } from "../screens/SettingsControls";

export function IdleReaperCard() {
  const idleReaper = useAppStore((s) => s.idleReaper);
  const setIdleReaperConfig = useAppStore((s) => s.setIdleReaperConfig);
  const MIN = 60_000;

  return (
    <div className="card">
      <div style={{ display: "flex", alignItems: "baseline", marginBottom: 12, gap: 10 }}>
        <h3 style={{ margin: 0 }}>Reap idle background sessions</h3>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <Row
          label="Enable idle reaper"
          hint="Kill the PTY of an idle, non-visible project/planner session after the timeout to free memory. It shows a dormant placeholder and resumes (where it left off) on click — never destructive."
        >
          <Toggle on={idleReaper.enabled} onClick={() => setIdleReaperConfig({ enabled: !idleReaper.enabled })} />
        </Row>
        <Row
          label="Idle timeout"
          hint="How long a project/planner session sits idle (and unwatched) before it's reaped."
        >
          <Select
            value={idleReaper.idleMs}
            options={[
              { label: "15 min", value: 15 * MIN },
              { label: "30 min (default)", value: 30 * MIN },
              { label: "1 hour", value: 60 * MIN },
              { label: "2 hours", value: 120 * MIN },
            ]}
            onChange={(v) => setIdleReaperConfig({ idleMs: v as number })}
          />
        </Row>
        <Row
          label="Also reap idle workers"
          hint="Off by default — fleet workers idle legitimately (parked on a dependency or the director). When on, a worker is reaped only after a much longer idle (2×)."
        >
          <Toggle
            on={idleReaper.workerIdleMs !== null}
            onClick={() => setIdleReaperConfig({ workerIdleMs: idleReaper.workerIdleMs === null ? idleReaper.idleMs * 2 : null })}
          />
        </Row>
      </div>
    </div>
  );
}
