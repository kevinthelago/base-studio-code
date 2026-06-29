// Download-confirmation modal for MCP servers a plan pulls in automatically (#1055). The blueprint
// a project uses, and the servers the planner assigns, can reference first-party MCP servers that
// install from source. Rather than silently cloning third-party code, we surface this modal — each
// server with its description and a link to its GitHub repo — and only download on the user's
// confirmation. Presentational + self-contained (the parent owns the clone/build + status) so it's
// unit-testable; styled to match the blueprint modals.

import { ModalScrim } from "@/shared/ui/ModalScrim";
import { Chip } from "@/shared/ui/Chip";
import { IconButton } from "@/shared/ui/IconButton";

export type McpDownloadStatus = "pending" | "downloading" | "building" | "ready" | "error";

/** One server queued for download — catalog metadata + its live install status. */
export interface McpDownloadItem {
  name: string;
  repo: string;
  /** GitHub repo link (the source the user is consenting to install). */
  link: string;
  desc?: string;
  install?: string;
  status: McpDownloadStatus;
}

const STATUS_LABEL: Record<McpDownloadStatus, string> = {
  pending: "",
  downloading: "downloading…",
  building: "building…",
  ready: "✓ installed",
  error: "failed",
};

const STATUS_COLOR: Record<McpDownloadStatus, string> = {
  pending: "var(--fg-dim)",
  downloading: "var(--accent)",
  building: "var(--accent)",
  ready: "var(--success)",
  error: "var(--danger)",
};

/**
 * @param items   the servers queued for download, with live status
 * @param onConfirm  download all still-pending/failed servers (parent runs clone+build)
 * @param onCancel   dismiss — skip the un-downloaded servers (and close when all are done)
 */
export function McpDownloadModal({ items, onConfirm, onCancel }: {
  items: McpDownloadItem[];
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const busy = items.some((i) => i.status === "downloading" || i.status === "building");

  const anyActionable = items.some((i) => i.status === "pending" || i.status === "error");
  const allDone = items.length > 0 && items.every((i) => i.status === "ready");

  return (
    <div className="bp-page" style={{ position: "fixed", inset: 0 }}>
      <ModalScrim onDismiss={busy ? undefined : onCancel} blur style={{ padding: 30 }}>
        <div className="modal" role="dialog" aria-label="Download MCP servers" style={{ width: 560, maxWidth: "100%", maxHeight: "88vh", display: "flex", flexDirection: "column", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 24px 70px rgba(0,0,0,.55)", overflow: "hidden" }}>
          <div className="modal-head" style={{ display: "flex", alignItems: "center", gap: 11, padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <span className="mh-ico" style={{ width: 30, height: 30, flex: "0 0 30px", borderRadius: 7, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontWeight: 700, fontSize: 15, background: "color-mix(in oklch, var(--accent), transparent 84%)", color: "var(--accent)" }}>↓</span>
            <div>
              <h2 style={{ margin: 0, fontFamily: "var(--mono)", fontSize: 14, fontWeight: 600 }}>Download MCP servers</h2>
              <div style={{ fontSize: 10.5, color: "var(--fg-dim)", marginTop: 1 }}>Your plan uses these MCP servers — review the source, then install.</div>
            </div>
            <IconButton aria-label="cancel" style={{ marginLeft: "auto" }} onClick={onCancel} disabled={busy} />
          </div>

          <div className="modal-body" style={{ padding: 20, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10 }}>
            {items.map((it) => (
              <div key={it.name} className="card" style={{ padding: 13 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 6 }}>
                  <span className="mono" style={{ fontSize: 13, fontWeight: 600, color: "var(--fg)" }}>{it.name}</span>
                  <Chip>first-party</Chip>
                  <span style={{ flex: 1 }} />
                  {it.status !== "pending" && (
                    <span className="mono" style={{ fontSize: 10.5, color: STATUS_COLOR[it.status] }}>{STATUS_LABEL[it.status]}</span>
                  )}
                </div>
                {it.desc && <div className="hint" style={{ marginBottom: 6 }}>{it.desc}</div>}
                <a className="mono" href={it.link} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--accent)", wordBreak: "break-all" }}>{it.link}</a>
                {it.install && <div className="hint" style={{ marginTop: 6, fontSize: 10 }}>{it.install}</div>}
              </div>
            ))}
          </div>

          <div className="modal-foot" style={{ display: "flex", alignItems: "center", gap: 9, padding: "14px 20px", borderTop: "1px solid var(--border-soft)" }}>
            <span className="hint">Downloads from GitHub into <span className="mono">~/.base-studio-code/mcp/</span>. Skip to install later from the MCP screen.</span>
            <span style={{ flex: 1 }} />
            {allDone ? (
              <button className="btn primary" onClick={onCancel}>Done</button>
            ) : (
              <>
                <button className="btn ghost" onClick={onCancel} disabled={busy}>Cancel</button>
                <button className="btn primary" onClick={onConfirm} disabled={busy || !anyActionable}>
                  {busy ? "Downloading…" : "Download all"}
                </button>
              </>
            )}
          </div>
        </div>
      </ModalScrim>
    </div>
  );
}
