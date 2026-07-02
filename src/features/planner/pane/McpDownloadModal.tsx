// Download-confirmation modal for MCP servers a plan pulls in automatically (#1055). The blueprint
// a project uses, and the servers the planner assigns, can reference first-party MCP servers that
// install from source. Rather than silently cloning third-party code, we surface this modal — each
// server with its description and a link to its GitHub repo — and only download on the user's
// confirmation. Presentational + self-contained (the parent owns the clone/build + status) so it's
// unit-testable; styled to match the blueprint modals.

import { ModalScrim } from "@/shared/ui/overlay/ModalScrim";
import { Chip } from "@/shared/ui/data/Chip";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { IconBox } from "@/shared/ui/data/IconBox";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Card } from "@/shared/ui/data/Card";

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
    <Box className="bp-page" style={{ position: "fixed", inset: 0 }}>
      <ModalScrim onDismiss={busy ? undefined : onCancel} blur style={{ padding: 30 }}>
        <Stack className="modal" role="dialog" aria-label="Download MCP servers" style={{ width: 560, maxWidth: "100%", maxHeight: "88vh", background: "var(--bg-panel)", border: "1px solid var(--border)", borderRadius: "var(--r-lg)", boxShadow: "0 24px 70px rgba(0,0,0,.55)", overflow: "hidden" }}>
          <Row className="modal-head" gap={11} style={{ padding: "16px 20px", borderBottom: "1px solid var(--border-soft)" }}>
            <IconBox size={30} radius={7} fontSize={15} background="color-mix(in oklch, var(--accent), transparent 84%)" color="var(--accent)">↓</IconBox>
            <Box>
              <h2 className="mono" style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Download MCP servers</h2>
              <Text as="div" size={10.5} tone="dim" style={{ marginTop: 1 }}>Your plan uses these MCP servers — review the source, then install.</Text>
            </Box>
            <IconButton aria-label="cancel" style={{ marginLeft: "auto" }} onClick={onCancel} disabled={busy} />
          </Row>

          <Stack className="modal-body" gap={10} style={{ padding: 20, overflowY: "auto" }}>
            {items.map((it) => (
              <Card key={it.name} style={{ padding: 13 }}>
                <Row gap={9} style={{ marginBottom: 6 }}>
                  <Text as="span" mono size={13} weight={600} style={{ color: "var(--fg)" }}>{it.name}</Text>
                  <Chip>first-party</Chip>
                  <Box as="span" style={{ flex: 1 }} />
                  {it.status !== "pending" && (
                    <Text as="span" mono size={10.5} style={{ color: STATUS_COLOR[it.status] }}>{STATUS_LABEL[it.status]}</Text>
                  )}
                </Row>
                {it.desc && <Box className="hint" style={{ marginBottom: 6 }}>{it.desc}</Box>}
                <a className="mono" href={it.link} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: "var(--accent)", wordBreak: "break-all" }}>{it.link}</a>
                {it.install && <Box className="hint" style={{ marginTop: 6, fontSize: 10 }}>{it.install}</Box>}
              </Card>
            ))}
          </Stack>

          <Row className="modal-foot" gap={9} style={{ padding: "14px 20px", borderTop: "1px solid var(--border-soft)" }}>
            <Box as="span" className="hint">Downloads from GitHub into <Text as="span" mono>~/.base-studio-code/mcp/</Text>. Skip to install later from the MCP screen.</Box>
            <Box as="span" style={{ flex: 1 }} />
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
          </Row>
        </Stack>
      </ModalScrim>
    </Box>
  );
}
