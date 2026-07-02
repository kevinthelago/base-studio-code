import { Box } from "@/shared/ui/layout/Box";
import { Grid } from "@/shared/ui/layout/Grid";
import { Text } from "@/shared/ui/typography/Text";

export interface Commit {
  s: string;
  m: string;
  who: string;
  t: string;
  head?: boolean;
  merge?: boolean;
}

interface LogViewProps {
  small?: boolean;
  commits: Commit[];
}

export function LogView({ small = false, commits }: LogViewProps) {
  return (
    <Box style={{
      flex: 1, minHeight: 0, overflow: "auto",
      padding: small ? "6px 10px" : "10px 14px",
    }}>
      {commits.map((c) => (
        <Grid key={c.s} className="mono" cols="16px 50px 1fr auto" gap={8} align="baseline" style={{
          padding: "4px 0",
          fontSize: small ? 10 : 11,
        }}>
          <Text style={{ color: c.head ? "var(--accent)" : c.merge ? "var(--info)" : "var(--fg-dim)" }}>
            {c.head ? "●" : c.merge ? "◆" : "○"}
          </Text>
          <Text tone="accent">{c.s}</Text>
          <Text style={{
            color: "var(--fg-muted)",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
          }}>
            {c.m} <Text tone="dim">· @{c.who}</Text>
          </Text>
          <Text tone="dim" size={small ? 9 : 9.5}>{c.t}</Text>
        </Grid>
      ))}
    </Box>
  );
}
