import { useState } from "react";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Chip } from "@/shared/ui/data/Chip";
import { TextArea } from "@/shared/ui/controls/Field";
import { Avatar } from "@/shared/ui/data/Avatar";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { Button } from "@/shared/ui/controls/Button";
import type { BoardIssue } from "./projectBoard.types";
import { truncate } from "@/shared/lib/core/format";

// ── Issue drawer ──────────────────────────────────────────────────────────────

export function IssueDrawer({ issue, onClose }: { issue: BoardIssue; onClose: () => void }) {
  const [comment, setComment] = useState("");
  return (
    <aside style={{
      position: "absolute", top: 0, right: 0, bottom: 0, width: 680,
      background: "var(--bg-panel)",
      borderLeft: "1px solid var(--border)",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.5)",
      display: "flex", flexDirection: "column",
      zIndex: 10,
    }}>
      <Row align="start" gap={10} style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
      }}>
        <Box style={{ flex: 1 }}>
          <Row gap={10} align="baseline">
            <Text mono size={11} tone="dim">#{issue.number}</Text>
            <Text as="h3" size={15} style={{ margin: 0, fontFamily: "var(--sans)", color: "var(--fg)" }}>{issue.title}</Text>
          </Row>
          <Row gap={6} wrap style={{ marginTop: 8 }}>
            <Chip tone={issue.state === "OPEN" ? "accent" : "neutral"} style={{ fontSize: 9.5 }}>
              ● {issue.state === "OPEN" ? "open" : "closed"}
            </Chip>
            {issue.milestone && (
              <Text mono size={10} tone="accent">{issue.milestone}</Text>
            )}
            {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
          </Row>
        </Box>
        <Button variant="ghost" style={{ height: 26 }}>open on github →</Button>
        <IconButton aria-label="close" onClick={onClose} />
      </Row>

      <Stack style={{ flex: 1, overflow: "auto" }}>
        {/* Description */}
        <Box pad={[16, 20]} style={{ borderBottom: "1px solid var(--border-soft)" }}>
          <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>description</Text>
          {issue.body ? (
            <Text as="div" size={12.5} tone="muted" style={{ fontFamily: "var(--sans)", lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {truncate(issue.body, 600)}
            </Text>
          ) : (
            <Text as="div" mono size={11} tone="dim" style={{ fontStyle: "italic" }}>No description.</Text>
          )}
        </Box>

        {/* Assignees */}
        {issue.assignees.length > 0 && (
          <Box pad={[12, 20]} style={{ borderBottom: "1px solid var(--border-soft)" }}>
            <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>assignees</Text>
            <Row gap={8} wrap align="stretch">
              {issue.assignees.map(a => (
                <Row key={a.login} gap={6}>
                  <Avatar login={a.login} size={20} palette bordered fontScale={0.56} />
                  <Text mono size={11} tone="muted">@{a.login}</Text>
                </Row>
              ))}
            </Row>
          </Box>
        )}

        {/* Claude subtask breakdown (demo) */}
        <Box pad={[14, 20]} style={{ borderBottom: "1px solid var(--border-soft)" }}>
          <Row gap={10} align="baseline" style={{ marginBottom: 10 }}>
            <Row className="mono" justify="center" style={{
              width: 20, height: 20, borderRadius: 5,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "var(--on-accent)", fontWeight: 700, fontSize: 11,
            }}>C</Row>
            <Text as="span" mono size={11.5} style={{ color: "var(--fg)" }}>Claude · subtask breakdown</Text>
            <Spacer />
            <Button variant="ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>✦ generate</Button>
          </Row>
          <Box className="mono" pad={[8, 10]} bg="var(--bg-canvas)" radius={5} style={{ fontSize: 11, color: "var(--fg-dim)", fontStyle: "italic"}}>
            Click "generate" to have Claude break this issue into subtasks.
          </Box>
        </Box>

        {/* Composer */}
        <Stack gap={8} style={{ padding: "14px 20px", background: "var(--bg-elev)" }}>
          <TextArea
            className="mono"
            value={comment}
            onChange={setComment}
            placeholder="leave a comment, or /assign, /label, /close, /ai breakdown…"
            style={{ minHeight: 60, padding: "8px 10px", fontSize: 11 }}
          />
          <Row gap={8}>
            <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>✦ ask claude…</Button>
            <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>open in pane</Button>
            <Spacer />
            <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }} onClick={onClose}>close</Button>
            <Button variant="primary" style={{ height: 24, fontSize: 10.5 }}>comment</Button>
          </Row>
        </Stack>
      </Stack>
    </aside>
  );
}
