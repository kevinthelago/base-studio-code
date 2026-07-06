import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmButton } from "@/shared/ui/controls/ConfirmButton";
import { fmtBytes, timeAgoMs } from "@/shared/lib/core/format";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

interface LogFileInfo {
  stream: string; label: string; path: string;
  sizeBytes: number; mtimeMs: number; exists: boolean; text: boolean;
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
      <Stack gap={0}>
        {files.map((f) => (
          <Row key={f.stream} gap={12} style={{ padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <Text as="div" size={13} style={{ fontFamily: "var(--sans)", color: "var(--fg)" }}>{f.label}</Text>
              <Text as="div" mono size={10.5} tone="dim" style={{ marginTop: 2 }}>
                {f.exists ? `${fmtBytes(f.sizeBytes)} · ${timeAgoMs(f.mtimeMs)}` : "not created yet"}
              </Text>
            </Box>
            {f.text && <Button size="sm" style={selectedStream === f.stream ? { borderColor: "var(--accent)" } : undefined} onClick={() => onViewStream(f.stream)}>View</Button>}
            {f.exists && <Button size="sm" onClick={() => void exportStream(f.stream)}>Export</Button>}
            {f.stream === "perf"
              ? <Text as="span" mono size="xs" tone="dim">retention in Performance →</Text>
              : <ConfirmButton size="sm" label="Clear" armedLabel="Confirm" onConfirm={() => clear(f.stream)} />}
          </Row>
        ))}
      </Stack>
    </Card>
  );
}
