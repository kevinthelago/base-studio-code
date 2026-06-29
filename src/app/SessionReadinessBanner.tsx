// Dismissible warn banner for non-critical PTY readiness warnings (#564).
//
// Renders below the pane chrome when `gh`/`gh auth` checks fail — the agent
// shell still works, but GitHub integration is degraded. Each warning gets its
// own install/action link. The user can dismiss the whole banner once they've
// acknowledged it.

import type { ReadinessCheck } from "@/shared/lib/core/diagnostics";
import { Banner } from "@/shared/ui/Banner";

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
    <Banner
      variant="bar"
      tone="warn"
      loud
      role="alert"
      onDismiss={onDismiss}
      lead={<span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>⚠ GitHub</span>}
    >
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
        {warnings.map((w) => (
          <span key={w.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span>{w.message}</span>
            {w.id === "gh-auth" && onSignInGitHub && (
              <button
                onClick={onSignInGitHub}
                style={{
                  background: "transparent", border: "1px solid currentColor", color: "currentColor",
                  cursor: "pointer", fontSize: 11, padding: "1px 6px", borderRadius: 3, lineHeight: 1.4,
                }}
              >
                Sign in →
              </button>
            )}
            {w.installUrl && w.id !== "gh-auth" && (
              <a href={w.installUrl} target="_blank" rel="noreferrer"
                style={{ color: "currentColor", fontSize: 11, textDecoration: "underline" }}>
                Install →
              </a>
            )}
          </span>
        ))}
      </div>
    </Banner>
  );
}
