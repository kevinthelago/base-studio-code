// plannerSandbox (#1988) — the opt-in WSL2-sandbox launch overrides shared by BOTH planner launch
// sites (the initial mount in usePlannerTerminal AND the restart in usePlanningSession), so they can't
// drift apart (the restart path used to skip the sandbox entirely). When the sandbox toggle is on AND
// the planner runs on bsc-agent — the only runtime baked into the sealed distro — the hub is relocated
// into the distro (setup_sandbox_hub) and the session spawns INSIDE it; otherwise it's the host launch.
//
// The launch reads the toggle only at spawn time, so flipping it while a planner is OPEN does nothing
// to the live session — Planning.tsx restarts the open planner on a flip so it converts.

import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { useAppStore } from "@/store";

/** Whether a planner `pty_create` should spawn into the sandbox: the toggle is on, the harness is
 *  bsc-agent (baked into the distro), and there's a host hub to relocate. Pure — unit-testable. */
export function wantsSandboxLaunch(
  sandboxConsoles: boolean,
  providerId: string | undefined,
  planningDir: string,
): boolean {
  return sandboxConsoles && providerId === "bsc-agent" && !!planningDir;
}

/** Resolve the `cwd` + `wslDistro` for a planner `pty_create`. When the sandbox is wanted, relocate the
 *  hub into the distro (`setup_sandbox_hub`) and spawn at the distro cwd; on failure — or when not
 *  wanted — fall back to the host hub (no distro). Reads the current `sandboxConsoles` from the store. */
export async function resolvePlannerSandbox(
  providerId: string | undefined,
  planningDir: string,
  projectKey: string,
): Promise<{ cwd: string; wslDistro: string | undefined }> {
  const wants = wantsSandboxLaunch(useAppStore.getState().sandboxConsoles, providerId, planningDir);
  const sandboxHub = wants
    ? await safeInvoke<string | null>(
        "setup_sandbox_hub", { key: projectKey }, null,
        (e: unknown) => console.error("sandbox hub setup failed (falling back to host):", e),
      )
    : null;
  return { cwd: sandboxHub ?? planningDir, wslDistro: sandboxHub ? "bsc-agent-sandbox" : undefined };
}
