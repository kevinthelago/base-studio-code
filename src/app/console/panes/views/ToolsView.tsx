// Tools & permissions view (#1149) — an INSPECT panel for a console pane. Surfaces the pane's
// least-privilege posture inline (what the agent in this pane may touch) instead of burying it in a
// menu: the session ROLE's capability tiers (github / git / code) and its owned write paths, read
// straight from the role model (`sessionRoles`). Styled to the Console-Shell theme.
//
// MCP servers are attached per project/profile, not per console pane, so they're noted rather than
// listed here (a follow-up can resolve the pane's effective server set).

import { roleCapability, type SessionRole, type AccessTier } from "@/shared/lib/session/sessionRoles";

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
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 13px", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.7 }}>
        <div style={grpLabel}>PERMISSIONS</div>
        <div style={{ marginTop: 8, color: "var(--fg-dim)" }}>
          Interactive console — no least-privilege role applied. Launched fleet sessions
          (worker / director / triage / …) show their capability posture here.
        </div>
      </div>
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
    <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "12px 13px", fontFamily: MONO, fontSize: 11.5, color: "var(--fg-muted)", lineHeight: 1.6 }}>
      <div style={{ ...grpLabel, marginBottom: 7 }}>ROLE · {role.toUpperCase()}</div>
      {rows.map((r) => (
        <div key={r.key} style={{ display: "flex", alignItems: "center", gap: 9, padding: "4px 6px", borderRadius: 6 }}>
          <span style={{ color: tierColor(r.tier), width: 12 }}>●</span>
          <span style={{ color: "var(--fg)", width: 60 }}>{r.key}</span>
          <span style={{ color: "var(--fg-dim)", fontSize: 10, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.note}</span>
          <span style={{ color: tierColor(r.tier), fontSize: 10 }}>{r.tier}</span>
        </div>
      ))}

      <div style={{ ...grpLabel, margin: "12px 0 6px" }}>WRITE PATHS</div>
      {globs ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {globs.map((g) => (
            <span key={g} style={{ padding: "1px 6px", borderRadius: 5, background: "var(--bg-elev2)", color: "var(--fg-muted)", fontSize: 10 }}>{g}</span>
          ))}
        </div>
      ) : (
        <div style={{ color: "var(--fg-dim)", fontSize: 10.5 }}>
          {cap.code === "none" ? "no code writes — read-only role" : "owned globs only (assigned at fleet launch)"}
        </div>
      )}

      <div style={{ ...grpLabel, margin: "12px 0 6px" }}>MCP SERVERS</div>
      <div style={{ color: "var(--fg-dim)", fontSize: 10.5 }}>Attached per project at launch — see the project's MCP pane.</div>
    </div>
  );
}
