import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmButton } from "@/shared/ui/ConfirmButton";
import { fmtBytes } from "@/shared/lib/core/format";
import { SettingsCardHead, settingsBtn as btn } from "../screens/SettingsControls";

interface LogFileInfo {
  stream: string; label: string; path: string;
  sizeBytes: number; mtimeMs: number; exists: boolean; text: boolean;
}

function fmtAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function LogsInventoryCard({
  selectedStream,
  onViewStream,
  flash,
  refreshTrigger = 0,
}: {
  selectedStream: string | null;
  onViewStream: (stream: string) => void;
  flash: (msg: string) => void;
  refreshTrigger?: number;
}) {
  const [files, setFiles] = useState<LogFileInfo[]>([]);

  const refresh = useCallback(async () => {
    try { setFiles(await invoke<LogFileInfo[]>("list_log_files")); } catch { setFiles([]); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh, refreshTrigger]);

  const clear = useCallback(async (stream: string) => {
    try {
      if (stream === "perf") await invoke("perf_clear_history");
      else await invoke("clear_log", { stream });
      await refresh();
      if (selectedStream === stream && stream !== "perf") {
        onViewStream(stream); // trigger reload in viewer
      }
    } catch (e) { flash(String(e)); }
  }, [refresh, selectedStream, onViewStream, flash]);

  const exportStream = useCallback(async (stream: string) => {
    try { flash(`Exported to ${await invoke<string>("export_log", { stream })}`); }
    catch (e) { flash(String(e)); }
  }, [flash]);

  return (
    <div className="card">
      <SettingsCardHead title="Log streams" />
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {files.map((f) => (
          <div key={f.stream} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{f.label}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", marginTop: 2 }}>
                {f.exists ? `${fmtBytes(f.sizeBytes)} · ${fmtAgo(f.mtimeMs)}` : "not created yet"}
              </div>
            </div>
            {f.text && <button style={btn(selectedStream === f.stream ? { borderColor: "var(--accent)", color: "var(--fg)" } : {})} onClick={() => onViewStream(f.stream)}>View</button>}
            {f.exists && <button style={btn()} onClick={() => void exportStream(f.stream)}>Export</button>}
            {f.stream === "perf"
              ? <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>retention in Performance →</span>
              : <ConfirmButton size="sm" label="Clear" armedLabel="Confirm" onConfirm={() => clear(f.stream)} />}
          </div>
        ))}
      </div>
    </div>
  );
}
