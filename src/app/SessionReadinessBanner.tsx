// Dismissible warn banner for non-critical PTY readiness warnings (#564).
//
// Renders below the pane chrome when `gh`/`gh auth` checks fail — the agent
// shell still works, but GitHub integration is degraded. Each warning gets its
// own install/action link. The user can dismiss the whole banner once they've
// acknowledged it.

import type { ReadinessCheck } from "@/shared/lib/core/diagnostics";
import { Banner } from "@/shared/ui/feedback/Banner";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";

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
      lead={<Text weight={600} style={{ whiteSpace: "nowrap" }}>⚠ GitHub</Text>}
    >
      <Stack gap={3} style={{ flex: 1 }}>
        {warnings.map((w) => (
          <Box as="span" key={w.id} style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <Text>{w.message}</Text>
            {w.id === "gh-auth" && onSignInGitHub && (
              // eslint-disable-next-line no-restricted-syntax -- bespoke inline "Sign in" link-button (currentColor border, banner-scoped styling)
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
          </Box>
        ))}
      </Stack>
    </Banner>
  );
}
