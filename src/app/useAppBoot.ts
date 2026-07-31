import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { addDbProject, listDbProjects, setDbTriaged } from "@/features/planner";
import { markBoot, logStartupTrace } from "@/shared/lib/core/startupTrace";
import { startPerfMonitor, recordStoreWrite } from "@/shared/lib/core/perf";
import { log } from "@/shared/lib/core/log";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import { worktreeChecks, reconcileMissingWorktrees } from "@/shared/lib/fleet/worktreeReconcile";
import { useAppStore } from "@/store";
import { accentVars } from "@/features/settings";
import { applyThemeToRoot } from "@/shared/ui/kit/theme";
import { applyContributionsToRoot } from "@/shared/ui/kit";

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
  const kitTheme = useAppStore((s) => s.kitTheme);
  const kitThemes = useAppStore((s) => s.kitThemes);
  const designContributions = useAppStore((s) => s.designContributions);
  const hasHydrated = useAppStore((s) => s.hasHydrated);
  const setBscBaseDir = useAppStore((s) => s.setBscBaseDir);
  // Guards the one-time draft→DB migration (#2995) so it fires exactly once per app session.
  const draftsMigratedToDb = useRef(false);
  const triagedSyncedToDb = useRef(false);
  const worktreeReconciled = useRef(false);

  // Apply the chosen accent to the design-token CSS vars at the document root,
  // live on change and after persisted state rehydrates. Inline vars on :root
  // override the stylesheet defaults; the default accent is a no-op restore.
  useEffect(() => {
    const { accent: a, accentDim } = accentVars(accent);
    const root = document.documentElement;
    root.style.setProperty("--accent", a);
    root.style.setProperty("--accent-dim", accentDim);
  }, [accent]);

  // Apply the chosen kit theme (#1852 Phase 3) to the semantic component tokens at the document root,
  // live on change and after rehydrate. A theme sets --card-*/--btn-*/--field-*/--chip-* overrides;
  // switching clears the prior theme's set first, so `default` restores the stylesheet look.
  // `kitThemes` is read as a dep (#2488) so the vars re-apply after the theme STORE hydrates — the
  // chosen theme may be designer-edited (or designer-authored) and differ from the packaged fallback.
  useEffect(() => { void kitThemes; applyThemeToRoot(kitTheme); }, [kitTheme, kitThemes]);

  // Apply the persisted downloaded-blueprint design overlays (#2656/#2663), live on add/remove AND after
  // the store rehydrates. Keyed on `designContributions` (NOT the one-shot mount effect) because persist
  // hydration is async: a mount-time read sees the default [] and would never re-apply the restored
  // overlays. Mirrors applyThemeToRoot above (compose-don't-mutate — a managed :root <style>).
  useEffect(() => { applyContributionsToRoot(designContributions); }, [designContributions]);

  // Startup timing trace (#perf): mark the gate commit, then the first paint of the
  // real UI once the store rehydrates — logStartupTrace emits the breakdown once.
  useEffect(() => { markBoot("mounted"); }, []);
  useEffect(() => {
    if (!hasHydrated) return;
    markBoot("hydrated");
    requestAnimationFrame(() => { markBoot("painted"); logStartupTrace(); });
  }, [hasHydrated]);

  // One-time draft → projects-DB migration (#2995): after the store rehydrates, upsert every entry in
  // the fragile `localDraftProjects` cache into the durable projects DB (`bsc project db add` is an
  // idempotent upsert), so drafts that only ever lived in the cache become restart-durable. Gated on
  // `hasHydrated` because persist is async — a mount-time read would see the pre-hydration empty map —
  // and ref-guarded so it runs exactly once. Each write is fire-and-forget and degrades silently when
  // the bridge/binary is absent.
  useEffect(() => {
    if (!hasHydrated || draftsMigratedToDb.current) return;
    draftsMigratedToDb.current = true;
    const drafts = useAppStore.getState().localDraftProjects;
    for (const [key, d] of Object.entries(drafts)) {
      void addDbProject({ key, title: d.title, pitch: d.pitch, state: "drafted" });
    }
  }, [hasHydrated]);

  // TRIAGED markers ↔ projects.db (#4088). The marker gates the whole Glance network (#2541), and it
  // used to live ONLY in app-state.json — unreachable from `bsc`, lost on an app-state reset, and
  // diagnosable only by reading a raw zustand blob. projects.db is the source now; this reconciles.
  //
  // BOTH directions, once, in this order:
  //   ① push any marker the cache still holds that the DB has not got — the upgrade path, so a user
  //     who triaged projects before #4088 does not watch them vanish from Glance on first launch;
  //   ② union the DB's markers into the cache — the durable set wins for everything else, and a
  //     marker set on another machine or repaired via `bsc project triaged set` shows up here.
  //
  // Gated on `hasHydrated` (persist is async — a mount-time read sees an empty map) and ref-guarded so
  // it runs exactly once. Degrades silently: with no bridge the in-memory cache still gates the session.
  useEffect(() => {
    if (!hasHydrated || triagedSyncedToDb.current) return;
    triagedSyncedToDb.current = true;
    void (async () => {
      const cached = useAppStore.getState().triagedProjects;
      const rows = await listDbProjects();
      if (!rows) return; // bridge unreachable — keep the cache as-is
      const fromDb: Record<string, number> = {};
      for (const r of rows) {
        if (typeof r.triagedAt === "number") fromDb[r.key] = r.triagedAt;
      }
      for (const key of Object.keys(cached)) {
        if (!(key in fromDb)) void setDbTriaged(key); // ① upgrade the pre-#4088 markers forward
      }
      useAppStore.getState().hydrateTriaged(fromDb); // ② durable set into the cache
    })();
  }, [hasHydrated]);

  // Fleet worktree reconciliation (#3614): after hydrate, mark any persisted fleet worker whose worktree
  // was reclaimed by the boot-GC (merged+clean = work landed) as ENDED — so its `<project> · build` tab
  // renders a resting card instead of relaunching the worker into a deleted directory. That relaunch
  // spawned a burst of doomed PTYs into missing cwds, jamming the backend event loop on EVERY boot. Gated
  // on `hasHydrated` (persist is async), ref-guarded to run once. `dir_exists` defaults to `true` on any
  // bridge/command miss, so a probe failure can never wrongly end a live worker.
  useEffect(() => {
    if (!hasHydrated || worktreeReconciled.current) return;
    worktreeReconciled.current = true;
    const s = useAppStore.getState();
    const checks = worktreeChecks(s.fleetPaneStreams, s.endedPanes, s.disabledPanes, s.paneCwds);
    if (checks.length === 0) return;
    void reconcileMissingWorktrees(
      checks,
      (cwd) => safeInvoke<boolean>("dir_exists", { path: cwd }, true),
      (paneId) => !!useAppStore.getState().endedPanes[paneId],
      (paneId, info) => {
        log.info(`worktree-reconcile: ${paneId} worktree gone → marking ended (${info.summary})`);
        useAppStore.getState().markPaneEnded(paneId, info);
      },
      () => Date.now(),
    );
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
      .then((v) => {
        useAppStore.getState().setUncleanShutdown(v);
        // #3961: the same signal, asked of the LOOP store. A loop in flight when the app died is never
        // reconciled — nothing closes it, so it stays `open` forever and a participant's `bsc loop
        // watch` blocks on a turn that will never come. Only an UNCLEAN shutdown implies that; after a
        // clean quit an open loop is legitimately dormant, so this is gated exactly like the session
        // restore. `--dry-run` only COUNTS them; nothing is written until the user acts on the banner.
        if (v) void useAppStore.getState().probeInterruptedLoops();
      })
      .catch(() => { /* command absent (e.g. tests) — leave false */ });
    // Skills library (#1338 ph2): hydrate from the global skills.db so the desktop UI, the planner,
    // and every live `bsc-skill` session share ONE library. Reconciles the code-owned packaged set
    // and seeds the db on first run; a no-op when the bridge is absent (keeps the seeded set).
    void useAppStore.getState().hydrateSkills();
    // Persona library (#2094): hydrate from the global persona store (`bsc persona`) so the desktop
    // Personas tab, live sessions, and the planner share ONE library. Reconciles the packaged
    // built-ins + seeds the store on first run; a no-op when the bridge is absent (keeps the seed).
    void useAppStore.getState().hydratePersonas();
    // Org library (#2193): hydrate the persona-relationship graph from the global org store (`bsc org`)
    // so the desktop Org tab, live sessions, and the planner share ONE library. Reconciles the packaged
    // built-ins + seeds the store on first run; a no-op when the bridge is absent (keeps the seed).
    void useAppStore.getState().hydrateOrgs();
    // Component library (#2269): hydrate the proven-component library from the global `bsc ui`
    // store so the planner's test_ui pane + (later) the Design Studio share ONE library. A no-op that
    // keeps the typed seed when the bridge is unreachable (which is every build until the store lands).
    void useAppStore.getState().hydrateComponents();
    // Kit-usage consumer index (#2277): hydrate which projects use which kit from the global
    // `bsc ui usage` store — the edges a kit change fans out over. No-op keeping the cache when
    // the bridge is absent.
    void useAppStore.getState().hydrateKitUsage();
    // Kit themes (#2488): hydrate the designer-writable theme collection from the global `bsc ui
    // theme` store — the Settings picker, the Design Studio preview switcher, and every ThemeScope
    // resolve against it. No-op keeping the packaged registry when the bridge is absent.
    void useAppStore.getState().hydrateThemes();
    // Data-defined component variants (#2569): compile the designer-authored `bsc ui variants` store
    // into the managed `<style>` so an LLM-authored variant renders on boot (re-applied on ui-touch).
    void useAppStore.getState().hydrateVariants();
    // (Design contributions are applied by the `designContributions`-keyed effect above, #2663 — a
    // one-shot mount read here saw the pre-hydration default [] and never re-applied the restored set.)
    // Project relationships (#2253): hydrate the Glance L1 network edges from the global `bsc project
    // link` store so the desktop, live sessions, and a restart share ONE set. A no-op when the bridge
    // is absent (keeps the persisted cache).
    void useAppStore.getState().hydrateProjectLinks();
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
