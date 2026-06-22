import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { LogConfig } from "../../store";

// ── Reusable atoms (mirrors Performance.tsx) ─────────────────────────────────────

function ConfirmButton({ label, armedLabel, onConfirm }: {
  label: string; armedLabel: string; onConfirm: () => void | Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  return (
    <button
      onClick={() => { if (armed) { setArmed(false); void onConfirm(); } else { setArmed(true); } }}
      onBlur={() => setArmed(false)}
      style={{
        padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5,
        background: armed ? "var(--danger)" : "var(--bg-elev)",
        color: armed ? "var(--bg-canvas)" : "var(--danger)",
        border: "1px solid " + (armed ? "var(--danger)" : "color-mix(in oklch, var(--danger), transparent 55%)"),
      }}
    >{armed ? armedLabel : label}</button>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{label}</div>
        {hint && <div style={{ fontFamily: "var(--sans)", fontSize: 11, color: "var(--fg-dim)", marginTop: 2 }}>{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Select({ value, options, onChange }: {
  value: number; options: { label: string; value: number }[]; onChange: (v: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{ fontFamily: "var(--mono)", fontSize: 11.5, background: "var(--bg-elev)", color: "var(--fg)", border: "1px solid var(--border)", borderRadius: 6, padding: "5px 8px", cursor: "pointer" }}
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function btn(extra: React.CSSProperties = {}): React.CSSProperties {
  return { padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5, background: "var(--bg-elev)", color: "var(--fg-muted)", border: "1px solid var(--border)", ...extra };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────

interface LogFileInfo {
  stream: string; label: string; path: string;
  sizeBytes: number; mtimeMs: number; exists: boolean; text: boolean;
}

function fmtBytes(n: number): string {
  if (n <= 0) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtAgo(ms: number): string {
  if (!ms) return "—";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// The app log's file format carries ANSI color codes (the shared tauri-plugin-log formatter); strip
// them so the raw viewer is readable and the level filter matches.
const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"];

// ── Main component ───────────────────────────────────────────────────────────────

export function LogsSettings() {
  const { logConfig, setLogConfig } = useAppStore();
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("all");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 6000); };

  const refresh = useCallback(async () => {
    try { setFiles(await invoke<LogFileInfo[]>("list_log_files")); } catch { setFiles([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const view = useCallback(async (stream: string) => {
    setSelected(stream); setSearch(""); setLevel("all");
    try { setLines(await invoke<string[]>("read_log_tail", { stream, limit: 500 })); }
    catch { setLines([]); }
  }, []);

  const clear = useCallback(async (stream: string) => {
    try {
      if (stream === "perf") await invoke("perf_clear_history");
      else await invoke("clear_log", { stream });
      await refresh();
      if (selected === stream && stream !== "perf") await view(stream);
    } catch (e) { flash(String(e)); }
  }, [refresh, selected, view]);

  const exportStream = useCallback(async (stream: string) => {
    try { flash(`Exported to ${await invoke<string>("export_log", { stream })}`); }
    catch (e) { flash(String(e)); }
  }, []);

  const enforceNow = useCallback(async () => {
    setBusy(true);
    try { await invoke("enforce_log_caps"); await refresh(); flash("Caps enforced."); }
    catch (e) { flash(String(e)); }
    setBusy(false);
  }, [refresh]);

  const update = (patch: Partial<LogConfig>) => setLogConfig({ ...logConfig, ...patch });

  const cleaned = lines.map((l) => l.replace(ANSI, ""));
  const isAppLog = selected === "app";
  const shown = cleaned.filter((l) =>
    (search === "" || l.toLowerCase().includes(search.toLowerCase())) &&
    (!isAppLog || level === "all" || l.includes(level)),
  );
  const selectedInfo = files.find((f) => f.stream === selected);

  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 16, color: "var(--fg)", marginBottom: 6 }}>Logs</div>
        <div style={{ fontFamily: "var(--sans)", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-muted)" }}>
          View, export, clear, and cap every log stream the app produces — the application log, the
          per-session telemetry logs, and the performance database. Project state (<code style={{ fontFamily: "var(--mono)" }}>plan.db</code>) is not a log and isn't listed.
        </div>
      </div>

      {/* Stream inventory */}
      <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "4px 16px" }}>
        {files.map((f) => (
          <div key={f.stream} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{f.label}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", marginTop: 2 }}>
                {f.exists ? `${fmtBytes(f.sizeBytes)} · ${fmtAgo(f.mtimeMs)}` : "not created yet"}
              </div>
            </div>
            {f.text && <button style={btn(selected === f.stream ? { borderColor: "var(--accent)", color: "var(--fg)" } : {})} onClick={() => void view(f.stream)}>View</button>}
            {f.exists && <button style={btn()} onClick={() => void exportStream(f.stream)}>Export</button>}
            {f.stream === "perf"
              ? <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--fg-dim)" }}>retention in Performance →</span>
              : <ConfirmButton label="Clear" armedLabel="Confirm" onConfirm={() => clear(f.stream)} />}
          </div>
        ))}
      </div>

      {notice && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginTop: 10, wordBreak: "break-all" }}>{notice}</div>
      )}

      {/* Raw viewer */}
      {selected && selectedInfo?.text && (
        <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: 12, marginTop: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>{selectedInfo.label}</span>
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
            <button style={btn()} onClick={() => { setSelected(null); setLines([]); }}>Close</button>
          </div>
          <pre style={{ margin: 0, maxHeight: 320, overflow: "auto", fontFamily: "var(--mono)", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {shown.length ? shown.join("\n") : <span style={{ color: "var(--fg-dim)" }}>{lines.length ? "no lines match the filter" : "empty"}</span>}
          </pre>
        </div>
      )}

      {/* Retention */}
      <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "4px 16px", marginTop: 12 }}>
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
            onChange={(v) => update({ maxLines: v })}
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
            onChange={(v) => update({ maxSizeMb: v })}
          />
        </Row>
        <Row label="Trim logs now" hint="Apply the caps to every telemetry log immediately, instead of waiting for the next startup.">
          <button style={btn({ color: "var(--fg)" })} disabled={busy} onClick={() => void enforceNow()}>{busy ? "Enforcing…" : "Enforce now"}</button>
        </Row>
      </div>

      <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-dim)", marginTop: 12 }}>
        Telemetry logs live in <code style={{ fontFamily: "var(--mono)" }}>~/.base-studio-code/</code>; the application log is rotated by the app. Exports are written to <code style={{ fontFamily: "var(--mono)" }}>~/.base-studio-code/exports/</code>.
      </div>
    </div>
  );
}
