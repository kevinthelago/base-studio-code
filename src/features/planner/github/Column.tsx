import { Stack } from "@/shared/ui/layout/Stack";
import { Row } from "@/shared/ui/layout/Row";
import { Spacer } from "@/shared/ui/layout/Spacer";
import { Text } from "@/shared/ui/typography/Text";
import { Box } from "@/shared/ui/layout/Box";
import { StatusDot } from "@/shared/ui/feedback/StatusDot";
import { IssueCard } from "./IssueCard";
import type { BoardColumn, BoardIssue } from "./projectBoard.types";

export function Column({
  col, issues, onIssueClick,
}: { col: BoardColumn; issues: BoardIssue[]; onIssueClick: (n: number) => void }) {
  return (
    <Stack style={{
      flex: "1 1 0", minWidth: 230,
      background: "var(--bg-panel)",
      borderRadius: 8, border: "1px solid var(--border-soft)", overflow: "hidden",
    }}>
      <Row className="mono" gap={8} style={{
        padding: "10px 12px", borderBottom: "1px solid var(--border-soft)",
        background: "var(--bg-elev)",
        fontSize: 11,
      }}>
        <StatusDot color={col.color} size={7} />
        <Text as="span" style={{ color: "var(--fg)" }}>{col.name}</Text>
        <Text tone="dim">{issues.length}</Text>
        <Spacer />
        <Text tone="dim" style={{ cursor: "pointer" }}>+</Text>
        <Text tone="dim" style={{ cursor: "pointer" }}>⋯</Text>
      </Row>
      <Stack gap={7} style={{ flex: 1, overflow: "auto", padding: 8 }}>
        {issues.map(c => (
          <IssueCard key={c.id} issue={c} focused={c.focused} onClick={() => onIssueClick(c.number)} />
        ))}
        <Box pad={[7, 9]} radius={5} style={{
          marginTop: 4,
          border: "1px dashed var(--border)",
          textAlign: "center", fontSize: 10, color: "var(--fg-dim)", cursor: "pointer",
        }} className="mono">+ new card</Box>
      </Stack>
    </Stack>
  );
}
