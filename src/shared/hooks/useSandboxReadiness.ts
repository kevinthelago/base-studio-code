// Shared OS-sandbox readiness + one-click install (#1916 / #1982 / #1988). Probes whether the Bash
// sandbox can engage on this host and drives its install (`provision_sandbox`), which streams
// `sandbox-install` progress events so callers can show live progress. On completion it re-probes so
// `sandbox.ready` reflects the result. Used by BOTH the Settings posture card and the first-run setup
// banner, so the detect + install logic lives in one place.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";

/** Mirror of the Rust `SandboxReadiness` (#1982) — the OS-sandbox probe result. */
export interface SandboxReadiness {
  platform: string;
  needsWsl: boolean;
  wslInstalled: boolean;
  sandboxDistro: string | null;
  /** The app can install the missing piece itself (Linux package manager / WSL rootfs import). */
  autoInstallable: boolean;
  ready: boolean;
  detail: string;
  /** Which agent runtimes the imported sealed distro carries (#4260); null when it isn't imported. */
  agentSandboxRuntimes: SandboxRuntimes | null;
  /**
   * Set when the imported distro is missing runtimes it needs to host the fleet — a distro built
   * before #4260 has the sidecars but no `claude` (the DEFAULT harness) and no `gh`. Reported
   * separately from `ready`, which is about whether the Bash sandbox can engage at all: the two
   * are different axes and folding them would make "not ready" ambiguous.
   */
  agentSandboxGap: string | null;
}

/** Mirror of the Rust `SandboxRuntimes` (#4260) — what the sealed distro can actually run. */
export interface SandboxRuntimes {
  claude: boolean;
  bscAgent: boolean;
  gh: boolean;
  git: boolean;
}

export interface UseSandboxReadiness {
  sandbox: SandboxReadiness | null;
  installing: boolean;
  installLog: string[];
  installMsg: string | null;
  /** Run the one-click install (`provision_sandbox`), streaming progress, then re-probe. */
  install: () => Promise<void>;
}

/**
 * @param enabled — when `false`, skip the readiness probe entirely (the caller won't render the
 *   sandbox UI). Lets a posture-gated card avoid the `wsl_sandbox_status` probe in the allow-list
 *   posture, so it isn't paid on every mount of a page that hosts the card.
 */
export function useSandboxReadiness(enabled = true): UseSandboxReadiness {
  const [sandbox, setSandbox] = useState<SandboxReadiness | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState<string[]>([]);
  const [installMsg, setInstallMsg] = useState<string | null>(null);

  const probe = useCallback(async () => {
    setSandbox(await safeInvoke<SandboxReadiness | null>("wsl_sandbox_status", undefined, null));
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void safeInvoke<SandboxReadiness | null>("wsl_sandbox_status", undefined, null).then((r) => {
      if (alive) setSandbox(r);
    });
    return () => {
      alive = false;
    };
  }, [enabled]);

  // Raw `invoke` (not safeInvoke) so the final Ok/Err text surfaces; `sandbox-install` events stream the
  // package manager / rootfs-import output live into `installLog`.
  const install = useCallback(async () => {
    setInstalling(true);
    setInstallMsg(null);
    setInstallLog([]);
    const unlisten = await listen<{ phase: string; line?: string }>("sandbox-install", (e) => {
      const { phase, line } = e.payload;
      if ((phase === "start" || phase === "log") && line) setInstallLog((prev) => [...prev, line]);
    });
    try {
      setInstallMsg(await invoke<string>("provision_sandbox"));
    } catch (e) {
      setInstallMsg(String(e));
    }
    unlisten();
    await probe();
    setInstalling(false);
  }, [probe]);

  return { sandbox, installing, installLog, installMsg, install };
}
