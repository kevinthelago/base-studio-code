// Non-dismissible blocking panel for critical PTY readiness failures (#564).
//
// Shown in place of the terminal when Git Bash, the claude CLI, or git are
// missing from the session shell. The user must install the missing tool and
// retry — the session cannot proceed without these.

import type { ReadinessCheck } from "../lib/diagnostics";

interface SessionFailureProps {
  critical: ReadinessCheck[];
  onRetry: () => void;
}

export function SessionFailure({ critical, onRetry }: SessionFailureProps) {
  if (critical.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: "32px 24px",
        background: "#181a1f",
        color: "#eeeae4",
        fontFamily: '"JetBrains Mono", monospace',
        fontSize: 13,
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 28, lineHeight: 1 }}>⚠</div>
      <div style={{ fontWeight: 600, fontSize: 14, color: "#d4554f" }}>
        Session prerequisites missing
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 10,
          maxWidth: 480,
          width: "100%",
        }}
      >
        {critical.map((c) => (
          <div
            key={c.id}
            style={{
              background: "#1e1f24",
              border: "1px solid #3a1a1a",
              borderRadius: 6,
              padding: "10px 14px",
              textAlign: "left",
              display: "flex",
              flexDirection: "column",
              gap: 6,
            }}
          >
            <span style={{ color: "#e06c75", fontSize: 12 }}>{c.message}</span>
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
          </div>
        ))}
      </div>
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
      <div style={{ color: "#44474f", fontSize: 11, maxWidth: 380 }}>
        Install the missing tools, then click Retry. The session will probe again
        without a full relaunch.
      </div>
    </div>
  );
}
