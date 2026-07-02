import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Code } from "@/shared/ui/data/Code";
import { useAppStore } from "@/store";
import { useSandboxReadiness } from "@/shared/hooks/useSandboxReadiness";

/**
 * The OS-sandbox row of the dependency view (#1916). Shows the sandbox's status + the explicit, informed
 * install (with live progress), via the shared `useSandboxReadiness` hook. Inform-first: the install is
 * a button shown only after the gap is surfaced, never automatic. Rendered only under the deny-list
 * posture, where the OS sandbox is the layer that confines Bash (under the allow-list it isn't required).
 */
export function SandboxDependencyCard() {
  const bypassPermissions = useAppStore((s) => s.bypassPermissions);
  // Only probe when the card will actually render (deny-list posture) — skips the wsl.exe probe on
  // General-page mount for allow-list users.
  const { sandbox, installing, installLog, installMsg, install } = useSandboxReadiness(bypassPermissions);

  if (!bypassPermissions || !sandbox) return null;

  return (
    <Card title="OS sandbox (Bash isolation)">
      <Row align="start" gap={8} style={{ fontSize: 12, lineHeight: 1.5 }}>
        <Box
          as="span"
          bg={sandbox.ready ? "var(--ok, #3fb950)" : "var(--warn, #d29922)"} style={{
            width: 8, height: 8, borderRadius: "50%", marginTop: 4, flexShrink: 0,
          }}
          aria-hidden
        />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <b>{sandbox.ready ? "Active" : "Not set up"}</b>{" "}
          <Text tone="muted">— {sandbox.detail}</Text>
          {!sandbox.ready && sandbox.autoInstallable && (
            <Stack gap={6} style={{ marginTop: 8 }}>
              <Row gap={8} wrap>
                {/* eslint-disable-next-line no-restricted-syntax -- bespoke compact accent install button with custom inline styling; not the .btn family */}
                <button
                  onClick={install}
                  disabled={installing}
                  style={{
                    background: "var(--accent)", border: "none", color: "var(--accent-text, #1a120a)",
                    cursor: installing ? "default" : "pointer", fontSize: 11, fontWeight: 600,
                    padding: "3px 10px", borderRadius: 4, opacity: installing ? 0.6 : 1,
                  }}
                >
                  {installing ? "Installing…" : sandbox.needsWsl ? "Install sandbox" : "Install bubblewrap"}
                </button>
                {installMsg && !installing && (
                  <Text tone="muted" size={11}>{installMsg}</Text>
                )}
              </Row>
              {installing && (
                <Box aria-hidden bg="var(--bg-elev2)" radius={2} style={{ height: 3, overflow: "hidden" }}>
                  <Box bg="var(--accent)" style={{ height: "100%", width: "30%", animation: "scan 1.1s linear infinite" }} />
                </Box>
              )}
              {installLog.length > 0 && (
                <Code maxHeight={120} style={{ padding: "6px 8px", borderRadius: 4, fontSize: 10.5 }}>
                  {installLog.join("\n")}
                </Code>
              )}
            </Stack>
          )}
        </Box>
      </Row>
    </Card>
  );
}
