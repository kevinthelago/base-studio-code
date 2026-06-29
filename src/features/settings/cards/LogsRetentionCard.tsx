import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import type { LogConfig } from "@/store";
import { SettingsCardHead, SettingsRow as Row, SettingsSelect as Select, settingsBtn as btn } from "../pages/SettingsControls";

export function LogsRetentionCard({
  onEnforced,
  flash,
}: {
  onEnforced?: () => void;
  flash: (msg: string) => void;
}) {
  const { logConfig, setLogConfig } = useAppStore();
  const [busy, setBusy] = useState(false);

  const enforceNow = useCallback(async () => {
    setBusy(true);
    try {
      await invoke("enforce_log_caps");
      flash("Caps enforced.");
      if (onEnforced) onEnforced();
    }
    catch (e) { flash(String(e)); }
    setBusy(false);
  }, [flash, onEnforced]);

  const update = (patch: Partial<LogConfig>) => setLogConfig({ ...logConfig, ...patch });

  return (
    <div className="card">
      <SettingsCardHead title="Log retention" />
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        <Row label="Max lines per log" hint="On enforcement (and at startup), each telemetry log is trimmed to its newest N lines.">
          <Select
            value={logConfig.maxLines}
            options={[
              { label: "1,000", value: 1000 },
              { label: "5,000", value: 5000 },
              { label: "10,000 (default)", value: 10000 },
              { label: "50,000", value: 50000 },
              { label: "Unlimited", value: 0 },
            ]}
            onChange={(v) => update({ maxLines: v as number })}
          />
        </Row>
        <Row label="Max size per log" hint="If a log still exceeds this after the line cap, its oldest lines are dropped until it fits. 0 = no limit.">
          <Select
            value={logConfig.maxSizeMb}
            options={[
              { label: "5 MB", value: 5 },
              { label: "20 MB (default)", value: 20 },
              { label: "100 MB", value: 100 },
              { label: "No limit", value: 0 },
            ]}
            onChange={(v) => update({ maxSizeMb: v as number })}
          />
        </Row>
        <Row label="Trim logs now" hint="Apply the caps to every telemetry log immediately, instead of waiting for the next startup.">
          <button style={btn({ color: "var(--fg)" })} disabled={busy} onClick={() => void enforceNow()}>{busy ? "Enforcing…" : "Enforce now"}</button>
        </Row>
      </div>
    </div>
  );
}
