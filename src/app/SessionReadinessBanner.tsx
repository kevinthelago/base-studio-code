// Dismissible amber banner for non-critical PTY readiness warnings (#564).
//
// Renders below the pane chrome when `gh`/`gh auth` checks fail — the agent
// shell still works, but GitHub integration is degraded. Each warning gets its
// own install/action link. The user can dismiss the whole banner once they've
// acknowledged it.

import type { ReadinessCheck } from "@/shared/lib/core/diagnostics";
import { IconButton } from "@/shared/ui/IconButton";

interface SessionReadinessBannerProps {
  warnings: ReadinessCheck[];
  onDismiss: () => void;
  /** Called when the user clicks "Sign in to GitHub" for a gh-auth warning. */
  onSignInGitHub?: () => void;
}

export function SessionReadinessBanner({
  warnings,
  onDismiss,
  onSignInGitHub,
}: SessionReadinessBannerProps) {
  if (warnings.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 8,
        padding: "6px 10px",
        fontSize: 12,
        lineHeight: 1.4,
        color: "#e5c07b",
        background: "#3a2f1a",
        borderBottom: "1px solid #5a4a28",
        flexShrink: 0,
      }}
    >
      <span style={{ fontWeight: 600, whiteSpace: "nowrap", marginTop: 1 }}>
        ⚠ GitHub
      </span>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
        {warnings.map((w) => (
          <span key={w.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span>{w.message}</span>
            {w.id === "gh-auth" && onSignInGitHub && (
              <button
                onClick={onSignInGitHub}
                style={{
                  background: "transparent",
                  border: "1px solid #e5c07b",
                  color: "#e5c07b",
                  cursor: "pointer",
                  fontSize: 11,
                  padding: "1px 6px",
                  borderRadius: 3,
                  lineHeight: 1.4,
                }}
              >
                Sign in →
              </button>
            )}
            {w.installUrl && w.id !== "gh-auth" && (
              <a
                href={w.installUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "#e5c07b", fontSize: 11, textDecoration: "underline" }}
              >
                Install →
              </a>
            )}
          </span>
        ))}
      </div>
      <IconButton aria-label="Dismiss GitHub warning" onClick={onDismiss} style={{ color: "#e5c07b", flexShrink: 0 }} />
    </div>
  );
}
