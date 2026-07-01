import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";
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
        <div
          style={{
            marginTop: 12,
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              marginTop: 4,
              flexShrink: 0,
              background: sandbox.ready ? "var(--ok, #3fb950)" : "var(--warn, #d29922)",
            }}
            aria-hidden
          />
          <div>
            <b>
              OS sandbox (Bash){sandbox.ready ? " — active" : sandbox.needsWsl ? " — needs WSL2" : ""}:
            </b>{" "}
            <span style={{ color: "var(--fg-muted)" }}>{sandbox.detail}</span>
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
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
                    <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{installMsg}</span>
                  )}
                </div>
                {installing && (
                  <div aria-hidden style={{ height: 3, borderRadius: 2, background: "var(--bg-elev2)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: "30%", background: "var(--accent)", animation: "scan 1.1s linear infinite" }} />
                  </div>
                )}
                {installLog.length > 0 && (
                  <pre
                    className="mono"
                    style={{
                      margin: 0, maxHeight: 120, overflow: "auto", padding: "6px 8px", borderRadius: 4,
                      background: "var(--bg-canvas)", border: "1px solid var(--border-soft)",
                      fontSize: 10.5, lineHeight: 1.5, color: "var(--fg-muted)", whiteSpace: "pre-wrap",
                    }}
                  >
                    {installLog.join("\n")}
                  </pre>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
