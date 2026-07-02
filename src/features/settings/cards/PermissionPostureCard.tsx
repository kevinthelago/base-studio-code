import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";
import { Row } from "@/shared/ui/layout/Row";
import { Stack } from "@/shared/ui/layout/Stack";
import { Box } from "@/shared/ui/layout/Box";
import { Text } from "@/shared/ui/typography/Text";
import { Code } from "@/shared/ui/data/Code";
import { useSandboxReadiness } from "@/shared/hooks/useSandboxReadiness";

/** Agent permission posture (#1916): the deny-list (bypass — auto-run, hooks gate) vs the allow-list
 *  (require approval). The toggle threads through `buildSessionSettings` → `write_session_settings`,
 *  which emits (or omits) `permissions.defaultMode = "bypassPermissions"`. Takes effect next launch.
 *  Under bypass, the OS sandbox (#1980) is the layer that confines Bash — its readiness is probed
 *  (#1982) and surfaced inline, with a one-click installer (live progress) when the app can fix it. */
export function PermissionPostureCard() {
  const { bypassPermissions, setBypassPermissions } = useAppStore();
  const { sandbox, installing, installLog, installMsg, install } = useSandboxReadiness();

  return (
    <Card title="Agent permissions">
      <ToggleRow
        on={bypassPermissions}
        onToggle={() => setBypassPermissions(!bypassPermissions)}
        title="Autonomous agents (deny-list)"
      >
        Off <b>(default)</b> uses the <b>allow-list</b>: the common dev toolchains (git/gh, the read-only
        inspection set, and the mainstream build/test tools) <b>auto-run</b>, and any other command{" "}
        <b>prompts for approval</b> — with the always-on guards underneath (dangerous-command floor, role
        denies, filesystem confinement, write-scope, all PreToolUse hooks). Turn <b>on</b> for autonomous
        agents that <b>auto-run everything</b> without prompts (the same guards still hold, and an
        OS-level sandbox confines raw Bash). The push-confirm gate always pauses for approval either way. Applies
        to every session — fleet agents <i>and</i> your manual consoles. Takes effect on the next launch.
      </ToggleRow>

      {bypassPermissions && sandbox && (
        <Row
          align="start"
          gap={8}
          style={{
            marginTop: 12,
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <Box
            as="span"
            bg={sandbox.ready ? "var(--ok, #3fb950)" : "var(--warn, #d29922)"} style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              marginTop: 4,
              flexShrink: 0,
            }}
            aria-hidden
          />
          <Box>
            <b>
              OS sandbox (Bash){sandbox.ready ? " — active" : sandbox.needsWsl ? " — needs WSL2" : ""}:
            </b>{" "}
            <Text tone="muted">{sandbox.detail}</Text>
            {sandbox.needsWsl && !sandbox.ready && (
              <>
                {" "}
                <a
                  href="https://github.com/kevinthelago/base-studio-code/issues/1982"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "var(--accent)" }}
                >
                  setup&nbsp;guide
                </a>
                . Until then the deny-list hooks still gate; only raw Bash is unconfined.
              </>
            )}
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
      )}
    </Card>
  );
}
