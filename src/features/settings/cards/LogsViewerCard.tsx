import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { settingsBtn as btn } from "../pages/SettingsControls";

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
    <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: 12, marginTop: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{fileLabel}</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>newest {lines.length}{shown.length !== lines.length ? ` · ${shown.length} shown` : ""}</span>
        <span style={{ flex: 1 }} />
        <input
          value={search} onChange={(e) => setSearch(e.target.value)} placeholder="search…"
          style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-canvas)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", width: 160 }}
        />
        {isAppLog && (
          <select value={level} onChange={(e) => setLevel(e.target.value)} style={{ fontFamily: "var(--mono)", fontSize: 11, background: "var(--bg-elev)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6, padding: "4px 6px" }}>
            <option value="all">all levels</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
        <button style={btn()} onClick={() => void navigator.clipboard?.writeText(shown.join("\n"))}>Copy</button>
        <button style={btn()} onClick={onClose}>Close</button>
      </div>
      <pre style={{ margin: 0, maxHeight: 320, overflow: "auto", fontFamily: "var(--mono)", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
        {shown.length ? shown.join("\n") : <span style={{ color: "var(--fg-dim)" }}>{lines.length ? "no lines match the filter" : "empty"}</span>}
      </pre>
    </div>
  );
}
