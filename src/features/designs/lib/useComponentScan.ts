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
import { scannableComponents, pendingScans, scanComponents } from "./componentScan";
import { type KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

/** The packaged kit artifact (built-in `source` + `runtime` closure), same import the single-component
 *  `ComponentPreviewFrame` uses — its `source` survives here (the store SEED strips it, this raw import
 *  keeps it), so a built-in resolves its `@/…` closure at scan time. */
const ARTIFACT = reactUiArtifact as unknown as KitArtifact;

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
 * @param comps  the active kit's components (the scan is kit-scoped, mirroring the graph).
 * @param artifact the packaged kit artifact; defaults to the bundled react-ui one (overridable for tests).
 */
export function useComponentScan(active: boolean, comps: ComponentRecord[], artifact: KitArtifact = ARTIFACT): void {
  const setStatus = useAppStore((s) => s.setComponentBuildStatus);
  const setStateHealth = useAppStore((s) => s.setComponentStateHealth);
  // The signature we last recorded a result for, per component id — survives kit switches + revisits, so
  // an already-built component is never re-bundled unless its source changed.
  const scannedSigs = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!active) return;
    const scannable = scannableComponents(comps, artifact);
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
        setStatus(id, status);
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
  }, [active, comps, artifact, setStatus, setStateHealth]);
}
