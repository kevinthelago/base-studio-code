import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { markBoot, logStartupTrace } from "@/shared/lib/core/startupTrace";
import { startPerfMonitor, recordStoreWrite } from "@/shared/lib/core/perf";
import { log } from "@/shared/lib/core/log";
import { useAppStore } from "@/store";
import { accentVars } from "@/features/settings/lib/appearance";

/** Delay (ms after hydration) before the perf monitor + store-write diagnostics start, so they don't
 *  load the cold-start window (#1033). Metrics during boot have no diagnostic value. */
const METRICS_GRACE_MS = 5000;

/**
 * The app-shell boot + lifecycle effects, pulled out of App so the shell reads as composition:
 * the accent CSS vars, the startup-timing trace, the one-shot base-dir / crash-flag / skills
 * hydration, and the deferred perf monitor + store-write diagnostics.
 */
export function useAppBoot() {
  const accent = useAppStore((s) => s.accent);
  const hasHydrated = useAppStore((s) => s.hasHydrated);
  const setBscBaseDir = useAppStore((s) => s.setBscBaseDir);

  // Apply the chosen accent to the design-token CSS vars at the document root,
  // live on change and after persisted state rehydrates. Inline vars on :root
  // override the stylesheet defaults; the default accent is a no-op restore.
  useEffect(() => {
    const { accent: a, accentDim } = accentVars(accent);
    const root = document.documentElement;
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-dim", accentDim);
  }, [accent]);

  // Startup timing trace (#perf): mark the gate commit, then the first paint of the
  // real UI once the store rehydrates — logStartupTrace emits the breakdown once.
  useEffect(() => { markBoot("mounted"); }, []);
  useEffect(() => {
    if (!hasHydrated) return;
    markBoot("hydrated");
    requestAnimationFrame(() => { markBoot("painted"); logStartupTrace(); });
  }, [hasHydrated]);

  // Fetch the app-managed base directory once so the rest of the UI can
  // compute repo local paths deterministically without round-tripping Rust.
  useEffect(() => {
    invoke<string>("get_base_dir")
      .then(setBscBaseDir)
      .catch((e) => log.error(`get_base_dir failed: ${e}`));
    // Crash recovery (#1041): learn once whether the previous shutdown was unclean — gates the
    // restore banner + session auto-resume (a clean quit leaves sessions dormant).
    invoke<boolean>("was_unclean_shutdown")
      .then((v) => useAppStore.getState().setUncleanShutdown(v))
      .catch(() => { /* command absent (e.g. tests) — leave false */ });
    // Skills library (#1338 ph2): hydrate from the global skills.db so the desktop UI, the planner,
    // and every live `bsc-skill` session share ONE library. Reconciles the code-owned packaged set
    // and seeds the db on first run; a no-op when the bridge is absent (keeps the seeded set).
    void useAppStore.getState().hydrateSkills();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Defer the perf monitor + store-write diagnostics past the cold-start window (#1033). Both run
  // every 2s and add IPC + sampling load that's pure overhead while the app is still booting (and
  // useless before it's interactive) — start them a few seconds after hydration instead of at mount.
  useEffect(() => {
    if (!hasHydrated) return;
    let unsub: (() => void) | undefined;
    const id = setTimeout(() => {
      // Watch the main thread for jank (logs `[perf] main thread blocked …`).
      startPerfMonitor();
      // Count how often each store key changes, so a re-render loop reveals which key drives it.
      unsub = useAppStore.subscribe((state, prev) => {
        const s = state as unknown as Record<string, unknown>;
        const p = prev as unknown as Record<string, unknown>;
        for (const k in s) {
          if (s[k] !== p[k]) recordStoreWrite(k);
        }
      });
    }, METRICS_GRACE_MS);
    return () => { clearTimeout(id); unsub?.(); };
  }, [hasHydrated]);
}
