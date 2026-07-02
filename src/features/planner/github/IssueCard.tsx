import { Avatar } from "@/shared/ui/data/Avatar";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import type { BoardIssue } from "./projectBoard.types";

export function IssueCard({ issue, focused, onClick }: { issue: BoardIssue; focused?: boolean; onClick?: () => void }) {
  return (
    <Stack
      onClick={onClick}
      gap={5}
      style={{
        background: focused ? "color-mix(in oklch, var(--accent), transparent 92%)" : "var(--bg-canvas)",
        border: "1px solid " + (focused ? "var(--accent-dim)" : "var(--border-soft)"),
        borderRadius: 6, padding: "9px 11px",
        cursor: "pointer",
        boxShadow: focused ? "0 4px 14px rgba(0,0,0,0.25)" : "none",
      }}
    >
      <Row gap={6} align="baseline">
        <Text mono size={10} tone="dim">#{issue.number}</Text>
        {issue.milestone && (
          <Text mono size={9} tone="accent">{issue.milestone}</Text>
        )}
        <Spacer />
      </Row>

      <Text as="div" size={12} style={{ fontFamily: "var(--sans)", color: "var(--fg)", lineHeight: 1.4 }}>{issue.title}</Text>

      {issue.labels.length > 0 && (
        <Row gap={4} wrap align="stretch">
          {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
        </Row>
      )}

      <Row gap={6} style={{ marginTop: 1 }}>
        <Row align="stretch">
          {issue.assignees.length > 0
            ? issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} size={18} ml={i === 0 ? 0 : -6} palette bordered fontScale={0.56} />)
            : <Box as="span" className="mono" style={{
                width: 18, height: 18, borderRadius: "50%",
                border: "1px dashed var(--border)", color: "var(--fg-dim)",
                fontSize: 10,
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>?</Box>
          }
        </Row>
        <Spacer />
        {issue.comments > 0 && (
          <Text mono size={9.5} tone="dim">
            💬 {issue.comments}
          </Text>
        )}
      </Row>
    </Stack>
  );
}
