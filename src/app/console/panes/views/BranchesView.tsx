import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";

export interface Branch {
  n: string;
  cur?: boolean;
  ahead?: number;
  behind?: number;
  age: string;
  merged?: boolean;
  stale?: boolean;
}

interface BranchesViewProps {
  small?: boolean;
  branches: Branch[];
}

export function BranchesView({ small = false, branches }: BranchesViewProps) {
  return (
    <Box style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 8px" : "10px 12px",
    }}>
      <Row className="mono" align="baseline" gap={8} style={{
        marginBottom: 6,
        fontSize: 10, color: "var(--fg-dim)",
        textTransform: "uppercase", letterSpacing: ".06em",
      }}>
        <Text>{branches.length} branches</Text>
        <Text>·</Text>
        <Text>{branches.filter((b) => (b.ahead ?? 0) > 0).length} ahead, {branches.filter((b) => b.stale).length} stale</Text>
      </Row>
      {branches.map((b) => (
        <Grid key={b.n} className="mono" cols="14px 1fr auto auto" gap={8} align="center" style={{
          padding: "4px 6px", borderRadius: 4,
          background: b.cur ? "color-mix(in oklch, var(--accent), transparent 90%)" : "transparent",
          fontSize: small ? 10 : 11,
        }}>
          <Text style={{ color: b.cur ? "var(--accent)" : "var(--fg-dim)" }}>{b.cur ? "●" : "○"}</Text>
          <Text style={{
            color: b.cur ? "var(--accent)" : b.merged ? "var(--fg-dim)" : "var(--fg)",
            textDecoration: b.merged ? "line-through" : "none",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>{b.n}</Text>
          <Text size={small ? 9.5 : 10} tone="muted" style={{ whiteSpace: "nowrap" }}>
            {(b.ahead ?? 0) > 0 && <Text style={{ color: "var(--info)" }}>⇡{b.ahead}</Text>}
            {(b.ahead ?? 0) > 0 && (b.behind ?? 0) > 0 && " "}
            {(b.behind ?? 0) > 0 && <Text tone="accent">⇣{b.behind}</Text>}
            {b.merged && <Text tone="success">merged</Text>}
            {b.stale && <Text tone="danger">stale</Text>}
          </Text>
          <Text size={small ? 9 : 10} tone="dim">{b.age}</Text>
        </Grid>
      ))}
    </Box>
  );
}
