import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { fmtBytes } from "@/shared/lib/core/format";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";

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
    <Card title="Log streams">
      <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
        {files.map((f) => (
          <div key={f.stream} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{f.label}</div>
              <div className="mono" style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 2 }}>
                {f.exists ? `${fmtBytes(f.sizeBytes)} · ${fmtAgo(f.mtimeMs)}` : "not created yet"}
              </div>
            </div>
            {f.text && <Button size="sm" style={selectedStream === f.stream ? { borderColor: "var(--accent)" } : undefined} onClick={() => onViewStream(f.stream)}>View</Button>}
            {f.exists && <Button size="sm" onClick={() => void exportStream(f.stream)}>Export</Button>}
            {f.stream === "perf"
              ? <span className="mono" style={{ fontSize: 10, color: "var(--fg-dim)" }}>retention in Performance →</span>
              : <ConfirmButton size="sm" label="Clear" armedLabel="Confirm" onConfirm={() => clear(f.stream)} />}
          </div>
        ))}
      </div>
    </Card>
  );
}
