// Presentational readiness/perms banners rendered above the xterm terminal host
// (extracted from TerminalView, #1645). Pure props in — NO xterm/PTY refs, no
// effects. TerminalView owns the readiness verdict + warnDismissed state and the
// terminal wiring; this only renders the resulting banners.

import { useAppStore } from "@/store";
import { IconButton } from "@/shared/ui/controls/IconButton";
import { Row } from "@/shared/ui/layout/Row";
import { Text } from "@/shared/ui/typography/Text";
import { SessionReadinessBanner } from "@/app/SessionReadinessBanner";
import { SessionFailure } from "@/app/SessionFailure";
import type { ReadinessCheck } from "@/shared/lib/core/diagnostics";

interface TerminalBannersProps {
  paneId: string;
  /** Verdict-derived critical failures (block the terminal). */
  criticalChecks: ReadinessCheck[];
  /** Verdict-derived non-blocking warnings. */
  warningChecks: ReadinessCheck[];
  /** Re-run the readiness preflight probe. */
  onRetry: () => void;
  /** True once the user has dismissed the warning banner this session. */
  warnDismissed: boolean;
  /** Dismiss the warning banner. */
  onDismissWarn: () => void;
  /** #799 — the pane's assigned profile was edited while running; nudge to relaunch. */
  permsStale: boolean;
}

/**
 * The stacked pane banners: a blocking {@link SessionFailure} for critical
 * prerequisite gaps, else a dismissible {@link SessionReadinessBanner} for
 * warnings, plus the #799 "permissions changed — relaunch" nudge.
 */
export function TerminalBanners({
  paneId,
  criticalChecks,
  warningChecks,
  onRetry,
  warnDismissed,
  onDismissWarn,
  permsStale,
}: TerminalBannersProps) {
  return (
    <>
      {criticalChecks.length > 0 && (
        <SessionFailure critical={criticalChecks} onRetry={onRetry} />
      )}
      {criticalChecks.length === 0 && !warnDismissed && warningChecks.length > 0 && (
        <SessionReadinessBanner
          warnings={warningChecks}
          onDismiss={onDismissWarn}
          onSignInGitHub={
            warningChecks.some((c) => c.id === "gh-auth")
              ? () => useAppStore.getState().navigate({ workspace: "settings", page: "github" }) // #3598/#3602: land on the GitHub settings section, not the last-viewed one
              : undefined
          }
        />
      )}
      {permsStale && (
        <Row className="mono" gap={8} style={{
          padding: "6px 12px",
          fontSize: 11, color: "var(--accent)",
          background: "color-mix(in oklch, var(--accent), transparent 90%)",
          borderBottom: "1px solid color-mix(in oklch, var(--accent), transparent 70%)",
        }}>
          <Text as="span">⟳</Text>
          <Text tone="muted" style={{ flex: 1 }}>
            Permissions changed on the Security page — <b style={{ color: "var(--fg)" }}>relaunch this console</b> to apply.
          </Text>
          <IconButton aria-label="Dismiss" size="sm" onClick={() => useAppStore.getState().clearPanePermsStale(paneId)} />
        </Row>
      )}
    </>
  );
}
