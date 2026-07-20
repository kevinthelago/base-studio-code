import { useEffect } from "react";
import { useAppStore } from "@/store";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";

/**
 * Resolves the base-studio-code source tree this app was built from, ONCE per app run (#3509).
 *
 * A role declares its harvest roots symbolically (`app-repo`) because a role is machine-independent;
 * turning that into a real path is the launch's job, and `buildAgentEnv` is synchronous. So the path
 * is resolved here at boot and parked in the store, where any later launch can read it without an
 * await. Returns null on a shipped binary (no source tree) — a role whose only declared root cannot
 * be resolved simply gets no harvest roots, which fails CLOSED.
 */
export function useAppRepoRoot(): void {
  const appRepoRoot = useAppStore((s) => s.appRepoRoot);
  const setAppRepoRoot = useAppStore((s) => s.setAppRepoRoot);

  useEffect(() => {
    if (appRepoRoot !== null) return;
    let cancelled = false;
    void safeInvoke<string | null>("debug_repo_root", undefined, null, () => {}).then((root) => {
      if (!cancelled && root) setAppRepoRoot(root);
    });
    return () => {
      cancelled = true;
    };
  }, [appRepoRoot, setAppRepoRoot]);
}
