import { timeAgoShort } from "@/shared/lib/core/format";
import { Avatar } from "@/shared/ui/data/Avatar";
import { LabelChip } from "@/shared/ui/data/LabelChip";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { Button } from "@/shared/ui/controls/Button";
import type { FlatIssue } from "./issuesModel";

export function IssueRow({ issue, selected, onClick }: { issue: FlatIssue; selected: boolean; onClick: () => void }) {
  return (
    <Grid
      cols="44px 1fr 180px 80px 50px 48px"
      gap={10}
      align="center"
      onClick={onClick}
      style={{
        padding: "9px 16px",
        background: selected ? "color-mix(in oklch, var(--accent), transparent 93%)" : "transparent",
        borderBottom: "1px solid var(--border-soft)",
        cursor: "pointer",
      }}
      onMouseEnter={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "var(--bg-elev)"; }}
      onMouseLeave={e => { if (!selected) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
    >
      {/* Number + state */}
      <Row gap={5}>
        <StatusDot
          size={8}
          color={issue.state === "OPEN" ? "var(--success)" : "var(--fg-dim)"}
          title={issue.state === "OPEN" ? "open" : "closed"}
        />
        <Text mono size={10.5} tone="dim">
          {issue.number}
        </Text>
      </Row>

      {/* Title + labels */}
      <Box style={{ minWidth: 0 }}>
        <Text as="div" size={12.5} style={{
          color: "var(--fg)", marginBottom: 4,
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        }}>{issue.title}</Text>
        <Row gap={4} wrap align="stretch">
          {issue.statusName && (
            <Box as="span" className="mono" pad={[1, 5]} bg="var(--bg-elev2)" border="soft" radius={3} style={{
              fontSize: 9, color: "var(--fg-dim)",
            }}>{issue.statusName}</Box>
          )}
          {issue.labels.map(l => <LabelChip key={l.name} label={l} />)}
        </Row>
      </Box>

      {/* Assignees + milestone */}
      <Stack gap={4} style={{ minWidth: 0 }}>
        {issue.assignees.length > 0 && (
          <Row align="stretch">
            {issue.assignees.map((a, i) => <Avatar key={a.login} login={a.login} size={16} ml={i === 0 ? 0 : -5} palette bordered fontScale={0.56} />)}
            <Text mono size={10} tone="muted" style={{
              marginLeft: 6,
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            }}>
              {issue.assignees.map(a => a.login).join(", ")}
            </Text>
          </Row>
        )}
        {issue.milestone && (
          <Text mono size={10} tone="accent" style={{ whiteSpace: "nowrap" }}>
            ◈ {issue.milestone}
          </Text>
        )}
      </Stack>

      {/* Comments */}
      <Text as="div" mono size={10.5} tone="dim" style={{ textAlign: "center" }}>
        {issue.comments > 0 ? `💬 ${issue.comments}` : "—"}
      </Text>

      {/* Updated */}
      <Text as="div" mono size={10} tone="dim" style={{ textAlign: "right" }}>
        {timeAgoShort(issue.updatedAt)}
      </Text>

      {/* Open in pane */}
      <Row justify="end" align="stretch">
        <Button
          variant="ghost"
          style={{ height: 22, padding: "0 7px", fontSize: 9.5 }}
          onClick={e => { e.stopPropagation(); }}
        >⊕</Button>
      </Row>
    </Grid>
  );
}
