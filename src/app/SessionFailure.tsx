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
        background: "#181a1f",
        color: "#eeeae4",
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        textAlign: "center",
      }}
    >
      <Text as="div" size={28} style={{ lineHeight: 1 }}>⚠</Text>
      <Text as="div" size={14} weight={600} style={{ color: "#d4554f" }}>
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
              background: "#1e1f24",
              border: "1px solid #3a1a1a",
              borderRadius: 6,
              padding: "10px 14px",
              textAlign: "left",
            }}
          >
            <Text size={12} style={{ color: "#e06c75" }}>{c.message}</Text>
            {c.installUrl && (
              <a
                href={c.installUrl}
                target="_blank"
                rel="noreferrer"
                style={{
                  color: "#61afef",
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
      {/* eslint-disable-next-line no-restricted-syntax -- bespoke failure-panel button with its own dark-theme inline styling (not the .btn kit) */}
      <button
        onClick={onRetry}
        style={{
          marginTop: 4,
          padding: "7px 20px",
          borderRadius: 5,
          border: "1px solid #44474f",
          background: "#1e1f24",
          color: "#eeeae4",
          fontFamily: '"JetBrains Mono", monospace',
          fontSize: 12,
          cursor: "pointer",
        }}
      >
        Retry
      </button>
      <Text as="div" size={11} style={{ color: "#44474f", maxWidth: 380 }}>
        Install the missing tools, then click Retry. The session will probe again
        without a full relaunch.
      </Text>
    </Stack>
  );
}
