// Download-confirmation modal for MCP servers a plan pulls in automatically (#1055). The blueprint
// a project uses, and the servers the planner assigns, can reference first-party MCP servers that
// install from source. Rather than silently cloning third-party code, we surface this modal — each
// server with its description and a link to its GitHub repo — and only download on the user's
// confirmation. Presentational + self-contained (the parent owns the clone/build + status) so it's
// unit-testable; styled to match the blueprint modals.

import { ModalCard } from "@/shared/ui/overlay/ModalCard";
import { Chip } from "@/shared/ui/data/Chip";
import { Button } from "@/shared/ui/controls/Button";
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
      <ModalCard
        icon={<Text as="span" size={15}>↓</Text>} title="Download MCP servers"
        sub="Your plan uses these MCP servers — review the source, then install."
        ariaLabel="Download MCP servers"
        onClose={onCancel} busy={busy} width={560}
        foot={
          <>
            <Box as="span" className="hint">Downloads from GitHub into <Text as="span" mono>~/.base-studio-code/mcp/</Text>. Skip to install later from the MCP screen.</Box>
            <Box as="span" style={{ flex: 1 }} />
            {allDone ? (
              <Button variant="primary" onClick={onCancel}>Done</Button>
            ) : (
              <>
                <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancel</Button>
                <Button variant="primary" onClick={onConfirm} disabled={busy || !anyActionable}>
                  {busy ? "Downloading…" : "Download all"}
                </Button>
              </>
            )}
          </>
        }
      >
        <Stack gap={10}>
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
      </ModalCard>
    </Box>
  );
}
