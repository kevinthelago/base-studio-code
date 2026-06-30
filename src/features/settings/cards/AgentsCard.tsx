// Settings → Agents. Command auto-approval moved to per-agent profiles (#1457) — the standalone
// global/project/repo allowlist editor was retired. This section now points to the Permissions
// screen (where profiles live) and hosts session-wide agent defaults.
import { Card } from "@/shared/ui/data/Card";
import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";

export function AgentsCard() {
  const { sandboxConsoles, setSandboxConsoles } = useAppStore();
  return (
    <div style={{ maxWidth: 820 }}>
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

      {/* Run consoles inside the sealed WSL2 sandbox (#1988) */}
      <div style={{ height: 18 }} />
      <Card title="Sandboxed consoles">
        <ToggleRow
          on={sandboxConsoles}
          onToggle={() => setSandboxConsoles(!sandboxConsoles)}
          title="Run new console sessions inside the WSL2 sandbox"
        >
          New console panes launch a clean shell <b>inside the sealed <code>bsc-agent-sandbox</code>{" "}
          distro</b> (no <code>/mnt/c</code>, no Windows interop) instead of on the host — so whatever
          runs is confined to the cage, regardless of which LLM drives it. Requires the sandbox installed
          (Settings → Security). Your Windows repos aren't mounted in yet, so this is a
          scratch/verification shell for now. Takes effect on the next console you open.
        </ToggleRow>
      </Card>

      {/* Placeholder cards for future agent-level settings */}
      <div style={{ height: 18 }} />
      <Card style={{ opacity: 0.5 }} title="Default system prompt">
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Prepended to every new session's system prompt. · coming soon
        </p>
      </Card>

      <div style={{ height: 12 }} />
      <Card style={{ opacity: 0.5 }} title="Auto-context injection">
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Automatically inject relevant knowledge blocks based on the active repo's tech stack. · coming soon
        </p>
      </Card>
    </div>
  );
}
