// useComponentScan (#2838, #2908) — the Design Studio's on-visit preview-error scan. While the Studio page
// is mounted (`active`; it lazily mounts on FIRST visit via KeptMountedPage, never at app boot), it
// esbuild-builds each buildable SANDBOXED-preview component in the active kit AND runs each build-clean
// one in a hidden iframe (#2908) — throttled to a small concurrency so it never hangs the app — recording
// ok/build-error/runtime-error per component in the store. The graph badges the errors. An APP-GRAPH
// record (`kitId === base-studio-code`) is excluded (#3859) — it previews live via the runtime loader, not
// this esbuild path, so there is nothing here for it to build or run.
//
// The pure spine (which components to scan, the throttle pool, build→run→status derivation) lives in
// `componentScan.ts` and is unit-tested with a mocked bundle + run; this hook only wires it to the real
// esbuild-wasm `bundleComponent` + the DOM `probeComponentRuntime` (neither runs under jsdom) and the
// store, with cancellation.
import { useEffect, useRef } from "react";
import { useAppStore } from "@/store";
import { bundleComponent } from "@/shared/lib/preview/componentBundle";
import { probeComponentRuntime } from "@/shared/lib/preview/componentRuntimeProbe";
import { collectAppCss } from "@/shared/lib/preview/collectAppCss";
import { scannableComponents, pendingScans, scanComponents, durableLogSync } from "./componentScan";
import { recordPreviewError } from "./componentBridge";
import { EMPTY_ARTIFACT, type KitArtifact, type LibraryModuleResolver } from "./componentPreview";
import { libraryModuleResolver } from "./libraryModules";
import type { ComponentRecord } from "./model";

/** How many component builds run at once — a small pool so the sweep stays local + non-blocking. Each
 *  build is a synchronous-ish esbuild-wasm pass; 3 keeps the UI responsive on a large kit. */
const SCAN_CONCURRENCY = 3;

/**
 * Scan the active kit's components for preview-build errors while `active`, recording each result in the
 * store (`setComponentBuildStatus`). Re-runs when `comps` changes (a designer edit), re-queuing only the
 * components whose build signature changed; a revisit with no edits is a no-op (all signatures cached).
 *
 * @param active whether the Studio page is currently mounted/visible — gates the scan so it runs on
 *               VISIT (KeptMountedPage first-mount), not at app boot.
 * @param comps  the active kit's components (the scan is kit-scoped, mirroring the graph); app-graph
 *               records (`kitId === base-studio-code`) are excluded regardless (#3859, `scannableComponents`).
 * @param artifact the packaged kit artifact; defaults to {@link EMPTY_ARTIFACT} (#3859 — nothing this scan
 *               still builds needs it; overridable for tests).
 */
export function useComponentScan(
  active: boolean,
  comps: ComponentRecord[],
  artifact: KitArtifact = EMPTY_ARTIFACT,
  // The library resolver the sweep builds with — the active blueprint's pinned sound kit (#3412) when the
  // caller has project context. It is part of the build, so a kit switch re-queues the affected components.
  libResolver: LibraryModuleResolver = libraryModuleResolver,
): void {
  const setStatus = useAppStore((s) => s.setComponentBuildStatus);
  const setStateHealth = useAppStore((s) => s.setComponentStateHealth);
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
        const sync = durableLogSync(useAppStore.getState().componentBuildStatus[id], status);
        setStatus(id, status);
        if (sync !== null) void recordPreviewError(id, sync);
        // Render-confirmed data-state blanks (#3191) — folded into the graph's health badges. Always write
        // (even `[]`) so a fixed component clears its prior blank badge on re-scan.
        setStateHealth(id, stateBlanks);
      },
      () => cancelled,
      // Runtime probe (#2908): run each build-clean component in a hidden iframe to catch a throw the
      // build can't see (e.g. a d3-force tick). Inconclusive/infra failures resolve ok — never a false badge.
      (js) => probeComponentRuntime(js, appCss),
    );
    return () => { cancelled = true; };
  }, [active, comps, artifact, libResolver, setStatus, setStateHealth]);
}
