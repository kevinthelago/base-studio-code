// Settings → Agents. Command auto-approval moved to per-agent profiles (#1457) — the standalone
// global/project/repo allowlist editor was retired. This section now points to the Permissions
// screen (where profiles live) and hosts session-wide agent defaults.

export function AgentsSettings() {
  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Agents</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12 }}>
        Default behavior applied to all Claude sessions.
      </p>

      {/* Command permissions now live in profiles ─────────────────── */}
      <div className="card">
        <h3 style={{ margin: "0 0 6px" }}>Command permissions</h3>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12, lineHeight: 1.6 }}>
          Auto-approved shell commands are now part of each agent's <strong>profile</strong> (managed on
          the <strong>Permissions</strong> screen), alongside its tool and file-write posture. A session
          auto-approves exactly its assigned profile's command list. <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>gh</code>,{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>git</code>, and{" "}
          <code style={{ fontFamily: "var(--mono)", fontSize: 11 }}>bsc-plan</code> are always enabled by
          the backend. A curated set of dangerous commands is always blocked.
        </p>
      </div>

      {/* Placeholder cards for future agent-level settings */}
      <div style={{ height: 18 }} />
      <div className="card" style={{ opacity: 0.5 }}>
        <h3 style={{ margin: "0 0 6px" }}>Default system prompt</h3>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Prepended to every new session's system prompt. · coming soon
        </p>
      </div>

      <div style={{ height: 12 }} />
      <div className="card" style={{ opacity: 0.5 }}>
        <h3 style={{ margin: "0 0 6px" }}>Auto-context injection</h3>
        <p style={{ margin: 0, color: "var(--fg-muted)", fontSize: 12 }}>
          Automatically inject relevant knowledge blocks based on the active repo's tech stack. · coming soon
        </p>
      </div>
    </div>
  );
}
