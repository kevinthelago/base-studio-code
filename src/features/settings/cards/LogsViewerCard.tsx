import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/shared/ui/controls/Button";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

export function LogsViewerCard({
  stream,
  onClose,
  fileLabel,
}: {
  stream: string;
  onClose: () => void;
  fileLabel: string;
}) {
  const [lines, setLines] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");

  const loadLines = useCallback(async () => {
    try { setLines(await invoke<string[]>("read_log_tail", { stream, limit: 500 })); }
    catch { setLines([]); }
  }, [stream]);

  useEffect(() => {
    void loadLines();
  }, [loadLines]);

  const cleaned = lines.map((l) => l.replace(ANSI, ""));
  const isAppLog = stream === "app";
  const shown = cleaned.filter((l) =>
    (search === "" || l.toLowerCase().includes(search.toLowerCase())) &&
    (!isAppLog || level === "all" || l.includes(level)),
  );

  return (
    <Box pad={12} bg="var(--bg-panel)" border="soft" radius={8} style={{ marginTop: 12 }}>
      <Row gap={8} style={{ marginBottom: 8 }}>
        <Text mono size={11} style={{ color: "var(--fg)" }}>{fileLabel}</Text>
        <Text mono size={10} tone="dim">newest {lines.length}{shown.length !== lines.length ? ` · ${shown.length} shown` : ""}</Text>
        <Box as="span" style={{ flex: 1 }} />
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search…"
          className="mono"
          style={{ fontSize: 11, background: "var(--bg-canvas)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", width: 160 }}
        />
        {isAppLog && (
          <select value={level} onChange={(e) => setLevel(e.target.value)} className="mono" style={{ fontSize: 11, background: "var(--bg-elev)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px" }}>
            <option value="all">all levels</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        <Button size="sm" onClick={() => void navigator.clipboard?.writeText(shown.join("\n"))}>Copy</Button>
        <Button size="sm" onClick={onClose}>Close</Button>
      </Row>
      <pre className="mono" style={{ margin: 0, maxHeight: 320, overflow: "auto", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {shown.length ? shown.join("\n") : <Text tone="dim">{lines.length ? "no lines match the filter" : "empty"}</Text>}
      </pre>
    </Box>
  );
}
