// Component preview-error scan (#2838) — the PURE spine of the Design Studio's on-visit build sweep.
// When the Studio is visited we esbuild-build EACH buildable component in the active kit, throttled to a
// small concurrency, and record ok / error per component so the graph can badge the ones that fail to
// build. This module owns the React-free, esbuild-free logic (which components to scan, the throttle
// pool, and ok/error derivation) so it's unit-testable; the hook (`useComponentScan`) wires it to the
// real `bundleComponent` (esbuild-wasm, which can't run under jsdom) and the store.
//
// SCOPE: only components that HAVE buildable source (`componentPreviewFiles` non-null) and then FAIL are
// this scan's concern. A component with NO buildable source (`componentPreviewFiles` === null) is a
// separate, static graph-health finding (the `no-implementation` category) — never scanned here.
import { componentPreviewFiles, type KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

/** One component's preview-build outcome — the value the graph badges off. `ok` = built clean; `error`
 *  carries the esbuild/compile message for the node's tooltip. */
export type ComponentBuildStatus =
  | { state: "ok" }
  | { state: "error"; message: string };

/** A component queued for the build scan: its id, a change-signature (so an edit re-queues just it), and
 *  the in-memory files + entry to hand esbuild. */
export interface ScannableComponent {
  id: string;
  /** Any change to the buildable source re-queues this component (see {@link buildSignature}). */
  sig: string;
  files: Record<string, string>;
  entry: string;
}

/** A component's build signature — the fields that decide what gets bundled. A change to any of them
 *  (a designer edit, a re-authored source) means a stale ok/error, so the scan re-queues it. */
export function buildSignature(c: ComponentRecord): string {
  return [c.id, c.src ?? "", c.source ?? "", c.srcText ?? ""].join(" ");
}

/** The subset of `comps` that HAS buildable preview source (`componentPreviewFiles` non-null) — the scan
 *  targets. Components with no buildable source are deliberately excluded (they're the separate static
 *  `no-implementation` graph-health finding, not a build FAILURE), so this never double-reports them. */
export function scannableComponents(comps: ComponentRecord[], artifact: KitArtifact): ScannableComponent[] {
  const out: ScannableComponent[] = [];
  for (const c of comps) {
    const build = componentPreviewFiles(c, artifact);
    if (build) out.push({ id: c.id, sig: buildSignature(c), files: build.files, entry: build.entry });
  }
  return out;
}

/** Those whose signature changed since the last scan (or were never scanned) — the re-queue set. Lets a
 *  re-scan skip components already built at their current source, so a revisit / kit-toggle is cheap. */
export function pendingScans(scannable: ScannableComponent[], prevSigs: Map<string, string>): ScannableComponent[] {
  return scannable.filter((s) => prevSigs.get(s.id) !== s.sig);
}

/**
 * Run `worker` over `items` with at most `concurrency` in flight, queueing the rest. Resolves once every
 * item has been processed. Pure — a fixed-size pool of `pump`s each pull the next item until the queue is
 * drained, so no more than `concurrency` `worker` calls overlap. A REJECTING worker rejects the whole
 * run, so callers must make `worker` non-throwing (the scan worker catches build errors and records them).
 */
export async function runPooled<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const size = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  let cursor = 0;
  const pump = async (): Promise<void> => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  };
  await Promise.all(Array.from({ length: size }, () => pump()));
}

/** Derive an ok/error status from a build outcome: a `null`/`undefined` error ⇒ ok; anything else ⇒ an
 *  error status with a readable message. Pure. */
export function toBuildStatus(error: unknown): ComponentBuildStatus {
  if (error == null) return { state: "ok" };
  return { state: "error", message: error instanceof Error ? error.message : String(error) };
}

/** Bundle one component's in-memory files → the build artifact. `bundleComponent` throws on a build
 *  error, which the scan catches; the resolved value is unused (we only care ok vs threw). */
export type BundleFn = (files: Record<string, string>, entry: string) => Promise<unknown>;

/**
 * Build each scannable component with `bundle`, throttled to `concurrency` in flight, reporting ok/error
 * per id via `onResult`. `bundle` throwing (an esbuild compile/resolve failure) is CAUGHT and recorded as
 * an error status — one bad component never aborts the sweep. `isCancelled` short-circuits both before a
 * build starts and before its result is reported, so an unmount / re-scan doesn't write stale state.
 *
 * The scan's spine, kept pure (no React, no esbuild): the hook passes the real `bundleComponent` + a
 * store setter; a test passes a mock bundle (some resolve, some throw) and asserts the derived statuses.
 */
export async function scanComponents(
  scannable: ScannableComponent[],
  bundle: BundleFn,
  concurrency: number,
  onResult: (id: string, status: ComponentBuildStatus) => void,
  isCancelled: () => boolean = () => false,
): Promise<void> {
  await runPooled(scannable, concurrency, async (item) => {
    if (isCancelled()) return;
    let error: unknown = null;
    try {
      await bundle(item.files, item.entry);
    } catch (e) {
      // Preserve a thrown falsy value as a non-null marker so `toBuildStatus` still classifies it error.
      error = e ?? new Error("preview build failed");
    }
    if (isCancelled()) return;
    onResult(item.id, toBuildStatus(error));
  });
}
