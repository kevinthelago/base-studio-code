// useComponentScan (#2838, #2908) — the Design Studio's on-visit preview-error scan. While the Studio page
// is mounted (`active`; it lazily mounts on FIRST visit via KeptMountedPage, never at app boot), it
// esbuild-builds each buildable component in the active kit AND runs each build-clean one in a hidden
// iframe (#2908) — throttled to a small concurrency so it never hangs the app — recording
// ok/build-error/runtime-error per component in the store. The graph badges the errors.
//
// The pure spine (which components to scan, the throttle pool, build→run→status derivation) lives in
// `componentScan.ts` and is unit-tested with a mocked bundle + run; this hook only wires it to the real
// esbuild-wasm `bundleComponent` + the DOM `probeComponentRuntime` (neither runs under jsdom) and the
// store, with cancellation.
import { useEffect, useRef } from "react";
import reactUiArtifact from "@data/components/react-ui.json";
import { useAppStore } from "@/store";
import { bundleComponent } from "@/shared/lib/preview/componentBundle";
import { probeComponentRuntime } from "@/shared/lib/preview/componentRuntimeProbe";
import { collectAppCss } from "@/shared/lib/preview/collectAppCss";
import { scannableComponents, pendingScans, scanComponents, durableLogSync, type ComponentScanResult, type ComponentBuildStatus } from "./componentScan";
import { recordPreviewError } from "./componentBridge";
import { type KitArtifact, type LibraryModuleResolver } from "./componentPreview";
import { libraryModuleResolver } from "./libraryModules";
import type { ComponentRecord } from "./model";

/** The packaged kit artifact (built-in `source` + `runtime` closure), same import the single-component
 *  `ComponentPreviewFrame` uses — its `source` survives here (the store SEED strips it, this raw import
 *  keeps it), so a built-in resolves its `@/…` closure at scan time. */
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

/** How many component builds run at once — a small pool so the sweep stays local + non-blocking. Each
 *  build is a synchronous-ish esbuild-wasm pass; 3 keeps the UI responsive on a large kit. */
const SCAN_CONCURRENCY = 3;

/** How long results buffer before one batched store commit (#4132). Long enough that a burst of builds
 *  collapses into a single render, short enough that badges still stream in visibly during a sweep. */
const SCAN_FLUSH_MS = 150;

/**
 * Scan the active kit's components for preview-build errors while `active`, recording each result in the
 * store (`setComponentBuildStatus`). Re-runs when `comps` changes (a designer edit), re-queuing only the
 * components whose build signature changed; a revisit with no edits is a no-op (all signatures cached).
 *
 * @param active whether the Studio page is currently mounted/visible — gates the scan so it runs on
 *               VISIT (KeptMountedPage first-mount), not at app boot.
 * @param comps  the active kit's components (the scan is kit-scoped, mirroring the graph).
 * @param artifact the packaged kit artifact; defaults to the bundled react-ui one (overridable for tests).
 */
export function useComponentScan(
  active: boolean,
  comps: ComponentRecord[],
  artifact: KitArtifact = ARTIFACT,
  // The library resolver the sweep builds with — the active blueprint's pinned sound kit (#3412) when the
  // caller has project context. It is part of the build, so a kit switch re-queues the affected components.
  libResolver: LibraryModuleResolver = libraryModuleResolver,
): void {
  const applyResults = useAppStore((s) => s.applyComponentScanResults);
  // The signature we last recorded a result for, per component id — survives kit switches + revisits, so
  // an already-built component is never re-bundled unless its source changed.
  const scannedSigs = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!active) return;
    const scannable = scannableComponents(comps, artifact, libResolver);
    const pending = pendingScans(scannable, scannedSigs.current);
    if (pending.length === 0) return;
    const sigById = new Map(pending.map((p) => [p.id, p.sig]));
    // App styles once per sweep (not per component) so each runtime probe renders faithfully.
    const appCss = collectAppCss();

    let cancelled = false;

    // #4132: BATCH the store writes. Results land one at a time (a throttled pool of esbuild passes), and
    // writing each straight through cost two commits per component — ~496 for this kit — every one of
    // which re-rendered the whole graph. Buffer them and flush on a short timer instead: the badges still
    // appear progressively (a sweep takes seconds, the flush window is 150ms) but a visit now costs
    // O(sweep-duration / 150ms) commits rather than O(2N).
    let buffer: ComponentScanResult[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      flushTimer = null;
      if (cancelled || buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      applyResults(batch);
    };
    const enqueue = (result: ComponentScanResult) => {
      buffer.push(result);
      flushTimer ??= setTimeout(flush, SCAN_FLUSH_MS);
    };

    void scanComponents(
      pending,
      bundleComponent,
      SCAN_CONCURRENCY,
      (id, status, stateBlanks) => {
        if (cancelled) return;
        // Mark the signature only once its result lands, so a cancelled build is re-queued next run
        // (never marked-but-unscanned).
        scannedSigs.current.set(id, sigById.get(id) ?? "");
        // #3540: mirror the render result to the DURABLE log BEFORE overwriting the store status, so the
        // prior status is still readable — `durableLogSync` records a runtime throw and clears a
        // now-resolved error (fire-and-forget; a missing `bsc` no-ops it). This is what makes
        // `bsc ui doctor` see the COMPLETE errored set, not only components a human opened.
        // The durable-log diff still reads the PRIOR status, so it must consult the store PLUS anything
        // already buffered but not yet flushed — otherwise a component scanned twice within one flush
        // window would diff against a stale value.
        // (a manual reverse scan — `findLast` is past this project's tsc lib target)
        let pendingPrior: ComponentBuildStatus | undefined;
        for (let i = buffer.length - 1; i >= 0; i--) if (buffer[i].id === id) { pendingPrior = buffer[i].status; break; }
        const sync = durableLogSync(pendingPrior ?? useAppStore.getState().componentBuildStatus[id], status);
        if (sync !== null) void recordPreviewError(id, sync);
        // Both halves go in one batched entry. `stateBlanks` is always carried (even `[]`) so a fixed
        // component clears its prior blank badge on re-scan.
        enqueue({ id, status, stateBlanks });
      },
      () => cancelled,
      // Runtime probe (#2908): run each build-clean component in a hidden iframe to catch a throw the
      // build can't see (e.g. a d3-force tick). Inconclusive/infra failures resolve ok — never a false badge.
      (js) => probeComponentRuntime(js, appCss),
    );
    return () => {
      // Flush what already landed BEFORE cancelling — those builds really happened, and dropping them
      // would re-queue work whose signature was already marked scanned (a badge that never returns).
      if (flushTimer) clearTimeout(flushTimer);
      if (buffer.length) applyResults(buffer);
      buffer = [];
      cancelled = true;
    };
  }, [active, comps, artifact, libResolver, applyResults]);
}
