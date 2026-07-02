import { Avatar } from "@/shared/ui/data/Avatar";
import { Card } from "@/shared/ui/data/Card";
import { Button } from "@/shared/ui/controls/Button";
import { Grid } from "@/shared/ui/layout/Grid";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

// ── Risk register (manual — from plan sessions) ───────────────────────────────

interface Risk { sev: "high" | "med" | "low"; proj: string; r: string; own: string }

export function RiskRegister() {
  // Risks are logged manually during planning sessions; no live source is wired yet (#…), so this
  // renders an honest empty state until one is — never fabricated entries.
  const risks: Risk[] = [];
  const med = risks.filter(r => r.sev === "med").length;
  const low = risks.filter(r => r.sev === "low").length;
  return (
    <Card
      style={{ padding: "14px 16px" }}
      title="Risk register"
      hint={risks.length ? `${med} medium · ${low} low across active projects` : "logged during planning"}
      right={risks.length > 0 ? <Button variant="ghost" style={{ height: 24, fontSize: 10.5 }}>view all</Button> : undefined}
      headMb={10}
    >
      {risks.length === 0 ? (
        <Text as="div" mono size={11} tone="dim" style={{ padding: "18px 12px", textAlign: "center" }}>
          No risks logged yet.
        </Text>
      ) : (
        <Box border="soft" radius={6} style={{ overflow: "hidden" }}>
          <Grid className="mono" cols="50px 110px 1fr 60px" gap={8} style={{
            padding: "7px 12px",
            background: "var(--bg-elev2)", borderBottom: "1px solid var(--border-soft)",
            fontSize: 10, color: "var(--fg-dim)",
            textTransform: "uppercase", letterSpacing: ".06em",
          }}>
            <Text as="span">sev</Text><Text as="span">project</Text><Text as="span">risk</Text><Text as="span">owner</Text>
          </Grid>
          {risks.map((r, i) => (
            <Grid key={i} cols="50px 110px 1fr 60px" gap={8} align="center" style={{
              padding: "8px 12px",
              background: i % 2 ? "var(--bg-panel)" : "var(--bg-elev)",
              borderTop: i === 0 ? "0" : "1px solid var(--border-soft)",
              fontSize: 11.5,
            }}>
              <Box as="span" className="mono" style={{ fontSize: 10, color: r.sev === "high" ? "var(--danger)" : r.sev === "med" ? "var(--accent)" : "var(--fg-dim)" }}>
                ● {r.sev}
              </Box>
              <Box as="span" className="mono" style={{ fontSize: 10.5, color: "var(--fg-muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.proj}</Box>
              <Text as="span" style={{ color: "var(--fg)" }}>{r.r}</Text>
              <Avatar login={r.own} />
            </Grid>
          ))}
        </Box>
      )}
    </Card>
  );
}
