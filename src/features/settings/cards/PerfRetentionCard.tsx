import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { PerfConfig } from "@/store";
import { ConfirmButton } from "@/shared/ui/ConfirmButton";
import { SettingsRow as Row, SettingsSelect as Select } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/Card";

export function PerfRetentionCard() {
  const { perfConfig, setPerfConfig } = useAppStore();
  const [clearStatus, setClearStatus] = useState<"idle" | "ok" | "err">("idle");

  const update = (patch: Partial<PerfConfig>) => {
    setPerfConfig({ ...perfConfig, ...patch });
  };

  const clearHistory = async () => {
    try {
      await invoke("perf_clear_history");
      setClearStatus("ok");
      setTimeout(() => setClearStatus("idle"), 2000);
    } catch {
      setClearStatus("err");
      setTimeout(() => setClearStatus("idle"), 2000);
    }
  };

  return (
    <Card title="Metrics retention">
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <Row
          label="History retention"
          hint="Samples older than this are deleted from the database automatically."
        >
          <Select
            value={perfConfig.retentionHours}
            options={[
              { label: "1 hour", value: 1 },
              { label: "6 hours", value: 6 },
              { label: "24 hours (default)", value: 24 },
              { label: "72 hours", value: 72 },
              { label: "Unlimited", value: 0 },
            ]}
            onChange={(v) => update({ retentionHours: v as number })}
          />
        </Row>

        <Row
          label="Max database size"
          hint="Prune oldest rows if the DB file exceeds this size. 0 = no limit."
        >
          <Select
            value={perfConfig.maxDbMb}
            options={[
              { label: "10 MB", value: 10 },
              { label: "50 MB (default)", value: 50 },
              { label: "200 MB", value: 200 },
              { label: "No limit", value: 0 },
            ]}
            onChange={(v) => update({ maxDbMb: v as number })}
          />
        </Row>

        <Row
          label="Clear history"
          hint="Delete all stored samples from the database and the in-memory ring buffer."
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <ConfirmButton
              label="Clear history"
              armedLabel="Click again to confirm"
              onConfirm={clearHistory}
            />
            {clearStatus === "ok" && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)" }}>Cleared</span>
            )}
            {clearStatus === "err" && (
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)" }}>Failed</span>
            )}
          </div>
        </Row>
      </div>
    </Card>
  );
}
