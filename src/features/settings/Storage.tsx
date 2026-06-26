import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmButton } from "@/shared/ui/ConfirmButton";
import { fmtBytes } from "@/shared/lib/core/format";

// One fleet worktree's disk footprint (mirrors Rust `WorktreeUsage`, #1080).
interface WorktreeUsage {
  projectKey: string;
  name: string;
  path: string;
  sizeBytes: number;
  targetBytes: number;
}

function btn(extra: React.CSSProperties = {}): React.CSSProperties {
  return { padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5, background: "var(--bg-elev)", color: "var(--fg-muted)", border: "1px solid var(--border)", ...extra };
}

export function StorageSettings() {
  const [rows, setRows] = useState<WorktreeUsage[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const flash = (msg: string) => { setNotice(msg); setTimeout(() => setNotice(""), 6000); };

  const refresh = useCallback(async () => {
    try { setRows(await invoke<WorktreeUsage[]>("worktrees_disk_usage")); }
    catch { setRows([]); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // Reclaim every worktree of one project (drops the dir + git admin records + build artifacts).
  const reclaim = useCallback(async (projectKey: string) => {
    setBusy(true);
    try {
      const n = await invoke<number>("reclaim_worktrees", { projectKey });
      flash(`Reclaimed ${n} worktree${n === 1 ? "" : "s"}.`);
      await refresh();
    } catch (e) { flash(String(e)); }
    setBusy(false);
  }, [refresh]);

  // Group by project so the user reclaims a whole project's fleet at once.
  const byProject = new Map<string, WorktreeUsage[]>();
  for (const r of rows) {
    const list = byProject.get(r.projectKey) ?? [];
    list.push(r);
    byProject.set(r.projectKey, list);
  }
  const projects = [...byProject.entries()]
    .map(([key, list]) => ({
      key,
      list,
      total: list.reduce((s, r) => s + r.sizeBytes, 0),
      targetTotal: list.reduce((s, r) => s + r.targetBytes, 0),
    }))
    .sort((a, b) => b.total - a.total);
  const grandTotal = rows.reduce((s, r) => s + r.sizeBytes, 0);

  return (
    <div style={{ maxWidth: 760, display: "flex", flexDirection: "column", gap: 0 }}>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: "var(--sans)", fontSize: 16, color: "var(--fg)", marginBottom: 6 }}>Storage</div>
        <div style={{ fontFamily: "var(--sans)", fontSize: 11.5, lineHeight: 1.5, color: "var(--fg-muted)" }}>
          Each fleet agent builds in its own git worktree, and every worktree accumulates its own{" "}
          <code style={{ fontFamily: "var(--mono)" }}>target/</code> (build artifacts) — which Cargo never garbage-collects.
          Worktrees are removed automatically when a project is deleted; reclaim them here at any time to free disk space.
          Reclaiming removes a worktree's checkout and its build artifacts (the agent's committed work is on its branch and is preserved).
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg)" }}>
          {rows.length} worktree{rows.length === 1 ? "" : "s"} · {fmtBytes(grandTotal)} total
        </span>
        <span style={{ flex: 1 }} />
        <button style={btn()} disabled={busy} onClick={() => void refresh()}>Refresh</button>
      </div>

      {projects.length === 0 ? (
        <div style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "20px 16px", fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-dim)" }}>
          No fleet worktrees on disk.
        </div>
      ) : (
        projects.map((p) => (
          <div key={p.key} style={{ background: "var(--bg-panel)", borderRadius: 8, border: "1px solid var(--border-soft)", padding: "4px 16px", marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border-soft)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: "var(--sans)", fontSize: 13, color: "var(--fg)" }}>{p.key}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", marginTop: 2 }}>
                  {p.list.length} worktree{p.list.length === 1 ? "" : "s"} · {fmtBytes(p.total)} ({fmtBytes(p.targetTotal)} in target/)
                </div>
              </div>
              <ConfirmButton size="sm" label="Reclaim" armedLabel="Confirm" disabled={busy} onConfirm={() => reclaim(p.key)} />
            </div>
            {p.list.map((w) => (
              <div key={w.path} style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0 8px 12px", borderBottom: "1px solid var(--border-soft)" }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--fg-muted)" }}>{w.name}</div>
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--fg-dim)", whiteSpace: "nowrap" }}>
                  {fmtBytes(w.sizeBytes)}{w.targetBytes > 0 ? ` · ${fmtBytes(w.targetBytes)} target/` : ""}
                </div>
              </div>
            ))}
          </div>
        ))
      )}

      {notice && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--accent)", marginTop: 4, wordBreak: "break-all" }}>{notice}</div>
      )}

      <div style={{ fontFamily: "var(--sans)", fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-dim)", marginTop: 12 }}>
        Worktrees live under <code style={{ fontFamily: "var(--mono)" }}>~/.base-studio-code/worktrees/</code>.
      </div>
    </div>
  );
}
