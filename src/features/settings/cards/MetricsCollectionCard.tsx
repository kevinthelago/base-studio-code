import { useAppStore } from "@/store";
import type { PerfConfig } from "@/store";
import { Toggle } from "@/shared/ui/controls/Toggle";
import { SettingsRow as Row, SettingsSelect as Select } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";
import { Stack } from "@/shared/ui/layout/Stack";

export function MetricsCollectionCard() {
  const { perfConfig, setPerfConfig } = useAppStore();

  const update = (patch: Partial<PerfConfig>) => {
    setPerfConfig({ ...perfConfig, ...patch });
  };

  return (
    <Card title="Performance metrics collection">
      <Stack gap={0}>
        <Row
          label="Enable metrics collection"
          hint="Disabling stops sampling and stops writing new rows; existing history is kept."
        >
          <Toggle on={perfConfig.enabled} onClick={() => update({ enabled: !perfConfig.enabled })} />
        </Row>

        <Row
          label="Sampling interval"
          hint="How often to capture a snapshot of each agent's RSS and CPU usage."
        >
          <Select
            value={perfConfig.intervalSecs}
            options={[
              { label: "Off", value: 0 },
              { label: "1 s", value: 1 },
              { label: "2 s (default)", value: 2 },
              { label: "5 s", value: 5 },
            ]}
            onChange={(v) => update({ intervalSecs: v as number })}
          />
        </Row>

        <Row
          label="Metric families"
          hint="Which sources to record. Process = per-agent shell RSS/CPU. Frontend = WebView heap, jank, PTY throughput."
        >
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <label className="mono" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 11.5, color: "var(--fg-muted)" }}>
              <Toggle on={perfConfig.trackProcess} onClick={() => update({ trackProcess: !perfConfig.trackProcess })} />
              Process
            </label>
            <label className="mono" style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 11.5, color: "var(--fg-muted)" }}>
              <Toggle on={perfConfig.trackFrontend} onClick={() => update({ trackFrontend: !perfConfig.trackFrontend })} />
              Frontend
            </label>
          </div>
        </Row>
      </Stack>
    </Card>
  );
}
