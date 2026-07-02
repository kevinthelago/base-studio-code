// Tools & permissions view (#1149) — an INSPECT panel for a console pane. Surfaces the pane's
// least-privilege posture inline (what the agent in this pane may touch) instead of burying it in a
// menu: the session ROLE's capability tiers (github / git / code) and its owned write paths, read
// straight from the role model (`sessionRoles`). Styled to the Console-Shell theme.
//
// MCP servers are attached per project/profile, not per console pane, so they're noted rather than
// listed here (a follow-up can resolve the pane's effective server set).

import { roleCapability, type SessionRole, type AccessTier } from "@/shared/lib/session/sessionRoles";
import { Box } from "@/shared/ui/layout/Box";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";

const MONO = "var(--mono)";

/** Map an access tier to a themed color: write ⇒ green, read ⇒ amber, none ⇒ red. */
function tierColor(t: AccessTier): string {
  return t === "write" ? "var(--state-run)" : t === "read" ? "var(--state-wait)" : "var(--state-stopped)";
}

const grpLabel: React.CSSProperties = {
  color: "var(--fg-dim)", fontSize: 9.5, letterSpacing: ".08em", fontFamily: MONO,
};

export function ToolsView({ role, small }: { role?: string; small?: boolean }) {
  void small;
  // An ad-hoc interactive console has no fleet role / least-privilege gate.
  if (!role) {
    return (
      <Box pad={[12, 13]} style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.7 }}>
        <Text as="div" style={grpLabel}>PERMISSIONS</Text>
        <Text as="div" tone="dim" style={{ marginTop: 8 }}>
          Interactive console — no least-privilege role applied. Launched fleet sessions
          (worker / director / triage / …) show their capability posture here.
        </Text>
      </Box>
    );
  }

  const cap = roleCapability(role as SessionRole);
  const rows: { key: string; tier: AccessTier; note: string }[] = [
    { key: "github", tier: cap.github, note: "issues / PRs / API mutations" },
    { key: "git", tier: cap.git, note: "commit / push / merge" },
    { key: "code", tier: cap.code, note: "edit files on disk" },
  ];
  const globs = cap.writeGlobs.length ? cap.writeGlobs : null;

  return (
    <Box pad={[12, 13]} style={{ flex: 1, minHeight: 0, overflow: "auto", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.6 }}>
      <Text as="div" style={{ ...grpLabel, marginBottom: 7 }}>ROLE · {role.toUpperCase()}</Text>
      {rows.map((r) => (
        <Row key={r.key} gap={9} style={{ padding: "4px 6px", borderRadius: 6 }}>
          <Text style={{ color: tierColor(r.tier), width: 12 }}>●</Text>
          <Text style={{ color: "var(--fg)", width: 60 }}>{r.key}</Text>
          <Text tone="dim" size={10} style={{ flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.note}</Text>
          <Text size={10} style={{ color: tierColor(r.tier) }}>{r.tier}</Text>
        </Row>
      ))}

      <Text as="div" style={{ ...grpLabel, margin: "12px 0 6px" }}>WRITE PATHS</Text>
      {globs ? (
        <Row gap={5} wrap align="stretch">
          {globs.map((g) => (
            <Text key={g} tone="muted" size={10} style={{ padding: "1px 6px", borderRadius: 5, background: "var(--bg-elev2)" }}>{g}</Text>
          ))}
        </Row>
      ) : (
        <Text as="div" tone="dim" size={10.5}>
          {cap.code === "none" ? "no code writes — read-only role" : "owned globs only (assigned at fleet launch)"}
        </Text>
      )}

      <Text as="div" style={{ ...grpLabel, margin: "12px 0 6px" }}>MCP SERVERS</Text>
      <Text as="div" tone="dim" size={10.5}>Attached per project at launch — see the project's MCP pane.</Text>
    </Box>
  );
}
