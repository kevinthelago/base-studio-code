// Non-dismissible blocking panel for critical PTY readiness failures (#564).
//
// Shown in place of the terminal when Git Bash, the claude CLI, or git are
// missing from the session shell. The user must install the missing tool and
// retry — the session cannot proceed without these.

import type { ReadinessCheck } from "@/shared/lib/core/diagnostics";
import { Stack } from "@/shared/ui/layout/Stack";
import { Text } from "@/shared/ui/typography/Text";

interface SessionFailureProps {
  critical: ReadinessCheck[];
  onRetry: () => void;
}

export function SessionFailure({ critical, onRetry }: SessionFailureProps) {
  if (critical.length === 0) return null;

  return (
    <Stack
      role="alert"
      align="center"
      justify="center"
      gap={16}
      style={{
        flex: 1,
        padding: "32px 24px",
        background: "var(--bg-canvas)",
        color: "var(--fg)",
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        textAlign: "center",
      }}
    >
      <Text as="div" size={28} style={{ lineHeight: 1 }}>⚠</Text>
      <Text as="div" size={14} weight={600} style={{ color: "var(--danger)" }}>
        Session prerequisites missing
      </Text>
      <Stack
        gap={10}
        style={{
          maxWidth: 480,
          width: "100%",
        }}
      >
        {critical.map((c) => (
          <Stack
            key={c.id}
            gap={6}
            style={{
              background: "var(--bg-panel)",
              border: "1px solid color-mix(in oklch, var(--danger), transparent 75%)",
              borderRadius: 6,
              padding: "10px 14px",
              textAlign: "left",
            }}
          >
            <Text size={12} style={{ color: "var(--danger)" }}>{c.message}</Text>
            {c.installUrl && (
              <a
                href={c.installUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "var(--info)",
                  fontSize: 11,
                  textDecoration: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                Download ↗
              </a>
            )}
          </Stack>
        ))}
      </Stack>
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke failure-panel button with its own inline styling (not the .btn kit) */}
      <button
        onClick={onRetry}
        style={{
          marginTop: 4,
          padding: "7px 20px",
          borderRadius: 5,
          border: "1px solid var(--border)",
          background: "var(--bg-panel)",
          color: "var(--fg)",
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
      <Text as="div" size={11} style={{ color: "var(--fg-dim)", maxWidth: 380 }}>
        Install the missing tools, then click Retry. The session will probe again
        without a full relaunch.
      </Text>
    </Stack>
  );
}
