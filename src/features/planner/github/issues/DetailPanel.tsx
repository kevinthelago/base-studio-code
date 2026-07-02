import { timeAgoShort } from "@/shared/lib/core/format";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Chip } from "@/shared/ui/data/Chip";
import { Avatar } from "@/shared/ui/data/Avatar";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { Button } from "@/shared/ui/controls/Button";
import type { FlatIssue } from "./issuesModel";

export function DetailPanel({ issue, onClose }: { issue: FlatIssue; onClose: () => void }) {
  return (
    <aside style={{
      position: "absolute", top: 0, right: 0, bottom: 0, width: 600,
      background: "var(--bg-panel)", borderLeft: "1px solid var(--border)",
      boxShadow: "-20px 0 60px rgba(0,0,0,0.5)",
      display: "flex", flexDirection: "column", zIndex: 10,
    }}>
      {/* Header */}
      <Row align="start" gap={10} style={{
        padding: "14px 20px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
      }}>
        <Box style={{ flex: 1 }}>
          <Row gap={8} align="baseline">
            <Text mono size={11} tone="dim">#{issue.number}</Text>
            <Text as="h3" size="lg" style={{ margin: 0, color: "var(--fg)" }}>{issue.title}</Text>
          </Row>
          <Row gap={6} wrap style={{ marginTop: 8 }}>
            <Chip tone={issue.state === "OPEN" ? "accent" : "neutral"} style={{ fontSize: 9.5 }}>
              ● {issue.state === "OPEN" ? "open" : "closed"}
            </Chip>
            {issue.statusName && (
              <Text mono size={10} tone="dim">
                {issue.statusName}
              </Text>
            )}
            {issue.milestone && (
              <Text mono size={10} tone="accent">{issue.milestone}</Text>
            )}
            {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
          </Row>
        </Box>
        <Button variant="ghost" style={{ height: 26 }}>open on github →</Button>
        <IconButton aria-label="close" onClick={onClose} />
      </Row>

      <Box style={{ flex: 1, overflow: "auto" }}>
        {/* Body */}
        <Box pad={[16, 20]} style={{ borderBottom: "1px solid var(--border-soft)" }}>
          <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>description</Text>
          {issue.body ? (
            <Text as="div" size={12.5} tone="muted" style={{ lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
              {issue.body.slice(0, 800)}{issue.body.length > 800 ? "…" : ""}
            </Text>
          ) : (
            <Text as="div" mono size={11} tone="dim" style={{ fontStyle: "italic" }}>No description.</Text>
          )}
        </Box>

        {/* Meta */}
        <Stack gap={10} style={{ padding: "14px 20px", borderBottom: "1px solid var(--border-soft)" }}>
          {issue.assignees.length > 0 && (
            <Box>
              <Text as="div" mono size={10} tone="dim" style={{ textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>assignees</Text>
              <Row gap={8} wrap align="stretch">
                {issue.assignees.map(a => (
                  <Row key={a.login} gap={6}>
                    <Avatar login={a.login} size={18} palette bordered fontScale={0.56} />
                    <Text mono size={11} tone="muted">@{a.login}</Text>
                  </Row>
                ))}
              </Row>
            </Box>
          )}
          <Row className="mono" gap={24} align="stretch" style={{ fontSize: 11, color: "var(--fg-muted)" }}>
            {issue.comments > 0 && <Text as="span">💬 {issue.comments} comment{issue.comments !== 1 ? "s" : ""}</Text>}
            <Text as="span">updated {timeAgoShort(issue.updatedAt)} ago</Text>
          </Row>
        </Stack>

        {/* Claude breakdown */}
        <Box pad={[14, 20]} bg="var(--bg-elev)">
          <Row gap={8} style={{ marginBottom: 10 }}>
            <Row className="mono" justify="center" style={{
              width: 20, height: 20, borderRadius: 5,
              background: "linear-gradient(135deg, var(--accent), oklch(0.62 0.14 50))",
              color: "#1a120a", fontWeight: 700, fontSize: 11,
            }}>C</Row>
            <Text as="span" mono size={11} style={{ color: "var(--fg)" }}>Claude</Text>
            <Spacer />
            <Button variant="ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>✦ break down</Button>
            <Button variant="ghost" style={{ height: 22, padding: "0 8px", fontSize: 10 }}>open in pane</Button>
          </Row>
          {/* eslint-disable-next-line no-restricted-syntax -- multiline comment composer; the UI-kit has no textarea primitive */}
          <textarea
            className="input mono"
            placeholder="ask claude about this issue…"
            style={{ width: "100%", height: 54, padding: "8px 10px", fontSize: 11, boxSizing: "border-box" }}
          />
        </Box>
      </Box>
    </aside>
  );
}
