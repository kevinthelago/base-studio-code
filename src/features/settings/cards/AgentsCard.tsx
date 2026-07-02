// Settings → Agents. Command auto-approval moved to per-agent profiles (#1457) — the standalone
// global/project/repo allowlist editor was retired. This section now points to the Permissions
// screen (where profiles live) and hosts session-wide agent defaults.
import { Card } from "@/shared/ui/data/Card";
import { Box } from "@/shared/ui/layout/Box";

export function AgentsCard() {
  return (
    <Box style={{ maxWidth: 820 }}>
      <h2 className="mono" style={{ fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Agents</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Default behavior applied to all Claude sessions.
      </p>

      {/* Command permissions now live in profiles ─────────────────── */}
      <Card title="Command permissions">
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
          Auto-approved shell commands are now part of each agent's <strong>profile</strong> (managed on
          the <strong>Permissions</strong> screen), alongside its tool and file-write posture. A session
          auto-approves exactly its assigned profile's command list. <code className="mono" style={{ fontSize: 11 }}>gh</code>,{" "}
          <code className="mono" style={{ fontSize: 11 }}>git</code>, and{" "}
          <code className="mono" style={{ fontSize: 11 }}>bsc-plan</code> are always enabled by
          the backend. A curated set of dangerous commands is always blocked.
        </p>
      </Card>

      {/* Placeholder cards for future agent-level settings */}
      <Box style={{ height: 18 }} />
      <Card style={{ opacity: 0.5 }} title="Default system prompt">
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Prepended to every new session's system prompt. · coming soon
        </p>
      </Card>

      <Box style={{ height: 12 }} />
      <Card style={{ opacity: 0.5 }} title="Auto-context injection">
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Automatically inject relevant knowledge blocks based on the active repo's tech stack. · coming soon
        </p>
      </Card>
    </Box>
  );
}
