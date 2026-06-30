import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "@/store";
import { ToggleRow } from "../pages/SettingsControls";
import { Card } from "@/shared/ui/data/Card";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";

/** Mirror of the Rust `SandboxReadiness` (#1982) — the OS-sandbox probe result. */
type SandboxReadiness = {
  platform: string;
  needsWsl: boolean;
  wslInstalled: boolean;
  sandboxDistro: string | null;
  /** The app can install the missing piece itself (Linux package manager / WSL rootfs import). */
  autoInstallable: boolean;
  ready: boolean;
  detail: string;
};

/** Agent permission posture (#1916): the deny-list (bypass — auto-run, hooks gate) vs the allow-list
 *  (require approval). The toggle threads through `buildSessionSettings` → `write_session_settings`,
 *  which emits (or omits) `permissions.defaultMode = "bypassPermissions"`. Takes effect next launch.
 *  Under bypass, the OS sandbox (#1980) is the layer that confines Bash — its readiness is probed
 *  (#1982; on Windows it needs WSL2) and surfaced inline so the gap is visible before a session needs it. */
export function PermissionPostureCard() {
  const { bypassPermissions, setBypassPermissions } = useAppStore();
  const [sandbox, setSandbox] = useState<SandboxReadiness | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void safeInvoke<SandboxReadiness | null>("wsl_sandbox_status", undefined, null).then((r) => {
      if (alive) setSandbox(r);
    });
    return () => {
      alive = false;
    };
  }, []);

  // One-click install of the missing OS-sandbox prerequisites — Windows imports the sealed rootfs
  // (#1988); Linux installs bubblewrap + socat via the host package manager (pkexec). Re-probe after,
  // so the status dot reflects the result. Raw `invoke` (not safeInvoke) so the Ok/Err text surfaces.
  const onInstall = async () => {
    setInstalling(true);
    setInstallMsg(null);
    try {
      setInstallMsg(await invoke<string>("provision_sandbox"));
    } catch (e) {
      setInstallMsg(String(e));
    }
    setSandbox(await safeInvoke<SandboxReadiness | null>("wsl_sandbox_status", undefined, null));
    setInstalling(false);
  };

  return (
    <Card title="Agent permissions">
      <ToggleRow
        on={bypassPermissions}
        onToggle={() => setBypassPermissions(!bypassPermissions)}
        title="Autonomous agents (deny-list)"
      >
        When on (default), sessions <b>auto-run without prompts</b> and a set of always-on guards do the
        gating — the dangerous-command floor, each role's denied commands, filesystem confinement to the
        worktree, and the write-scope rules (all enforced by PreToolUse hooks, which hold even in this
        mode). The push-confirm gate still pauses for approval. Turn <b>off</b> to use the classic{" "}
        <b>allow-list</b> instead: every command not on the enumerated allow-list prompts for approval —
        more friction, tighter control. Applies to every session — fleet agents <i>and</i> your manual
        consoles. Takes effect on the next session launch.
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
              <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={onInstall}
                  disabled={installing}
                  style={{
                    background: "var(--accent)", border: "none", color: "var(--accent-text, #1a120a)",
                    cursor: installing ? "default" : "pointer", fontSize: 11, fontWeight: 600,
                    padding: "3px 10px", borderRadius: 4, opacity: installing ? 0.6 : 1,
                  }}
                >
                  {installing ? "Installing…" : sandbox.needsWsl ? "Install sandbox" : "Install bubblewrap"}
                </button>
                {installMsg && <span style={{ color: "var(--fg-muted)", fontSize: 11 }}>{installMsg}</span>}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
