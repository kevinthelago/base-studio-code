// Component preview-error scan (#2838, #2908) — the PURE spine of the Design Studio's on-visit sweep.
// When the Studio is visited we esbuild-build EACH buildable component in the active kit AND, when the
// build is clean, RUN it in a sandboxed iframe (#2908) — throttled to a small concurrency — recording
// ok / build-error / runtime-error per component so the graph can badge the ones that fail. This module
// owns the React-free, esbuild-free, DOM-free logic (which components to scan, the throttle pool, and
// the build→run→status derivation) so it's unit-testable; the hook (`useComponentScan`) wires it to the
// real `bundleComponent` (esbuild-wasm) and `probeComponentRuntime` (a hidden iframe) — neither of which
// can run under jsdom — and the store.
//
// WHY RUN, not just build (#2908): the build-only scan caught esbuild compile/resolve failures but was
// BLIND to components that build clean yet THROW at runtime — e.g. a d3-force `ForceGraph` whose
// simulation throws on its timer tick. Those looked healthy on the graph until opened. Running each
// build-clean component closes that gap; a build-clean-but-throws component is now badged proactively.
//
// SCOPE: only components that HAVE buildable source (`componentPreviewFiles` non-null) and then FAIL are
// this scan's concern. A component with NO buildable source (`componentPreviewFiles` === null) is a
// separate, static graph-health finding (the `no-implementation` category) — never scanned here.
import type { RuntimeOutcome } from "@/shared/lib/preview/componentRuntimeProbe";
import { componentPreviewFiles, type KitArtifact } from "./componentPreview";
import type { ComponentRecord } from "./model";

/** One component's preview outcome — the value the graph badges off. `ok` = built clean, ran without
 *  throwing, AND rendered something; `error` carries a readable message for the node's tooltip and a
 *  `kind` distinguishing a `build` failure (esbuild) from a `runtime` throw (an exception during the
 *  component's own render); `empty` = built + mounted clean but rendered NOTHING visible (#2926). */
export type ComponentBuildStatus =
  | { state: "ok" }
  | { state: "error"; kind: "build" | "runtime"; message: string }
  | { state: "empty"; message: string };

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

/** Derive a BUILD ok/error status from an esbuild outcome: a `null`/`undefined` error ⇒ ok; anything
 *  else ⇒ a `build` error status with a readable message. Pure. */
export function toBuildStatus(error: unknown): ComponentBuildStatus {
  if (error == null) return { state: "ok" };
  return { state: "error", kind: "build", message: error instanceof Error ? error.message : String(error) };
}

/** Bundle one component's in-memory files → the built ESM module source. `bundleComponent` throws on a
 *  build error, which the scan catches; the resolved JS is handed to the runtime probe (#2908). */
export type BundleFn = (files: Record<string, string>, entry: string) => Promise<string>;

/** Run a built component module and report whether it threw at runtime. Non-throwing by contract: an
 *  INFRA failure (no DOM, a timeout, a probe error) resolves `{ ok: true }` so the scan never
 *  false-badges a healthy component — only a component that DEMONSTRABLY threw is reported not-ok. */
export type RunFn = (bundleJs: string) => Promise<RuntimeOutcome>;

/** The default run step: no runtime probe (build-only scan). Callers that want runtime detection pass a
 *  real `RunFn` (the hook wires `probeComponentRuntime`); tests pass a mock. */
const NO_RUNTIME_PROBE: RunFn = async () => ({ ok: true });

/**
 * Derive one component's status: BUILD it, and if it builds clean, RUN it (#2908). A build throw ⇒ a
 * `build` error; a clean build that then throws at runtime ⇒ a `runtime` error; otherwise ok. The runtime
 * probe is treated as best-effort — if `run` itself rejects (a probe-infrastructure failure, not the
 * component), we fall back to `ok` so a healthy component is never false-badged. Pure given `bundle`/`run`.
 */
export async function buildAndProbe(item: ScannableComponent, bundle: BundleFn, run: RunFn): Promise<ComponentBuildStatus> {
  let js: string;
  try {
    js = await bundle(item.files, item.entry);
  } catch (e) {
    // Preserve a thrown falsy value as a non-null marker so `toBuildStatus` still classifies it error.
    return toBuildStatus(e ?? new Error("preview build failed"));
  }
  let outcome: RuntimeOutcome;
  try {
    outcome = await run(js);
  } catch {
    return { state: "ok" }; // probe infra failure ⇒ inconclusive, never a false badge
  }
  if (!outcome.ok) return { state: "error", kind: "runtime", message: outcome.message };
  // Built + mounted clean, but rendered nothing visible (#2926) — a distinct "no output" signal.
  if (outcome.empty) return { state: "empty", message: "renders nothing — the component mounts but produces no visible output" };
  return { state: "ok" };
}

/**
 * Scan each buildable component (build + optional runtime probe), throttled to `concurrency` in flight,
 * reporting ok / build-error / runtime-error per id via `onResult`. A build failure (esbuild) OR a runtime
 * throw (`run`) is recorded as an error status — one bad component never aborts the sweep. `isCancelled`
 * short-circuits both before work starts and before its result is reported, so an unmount / re-scan
 * doesn't write stale state. `run` defaults to a no-op probe (build-only) so existing callers/tests keep
 * their behavior; the hook passes the real `probeComponentRuntime`.
 *
 * The scan's spine, kept pure (no React, no esbuild, no DOM): the hook passes the real `bundleComponent`
 * + `probeComponentRuntime` + a store setter; a test passes mocks and asserts the derived statuses.
 */
export async function scanComponents(
  scannable: ScannableComponent[],
  bundle: BundleFn,
  concurrency: number,
  onResult: (id: string, status: ComponentBuildStatus) => void,
  isCancelled: () => boolean = () => false,
  run: RunFn = NO_RUNTIME_PROBE,
): Promise<void> {
  await runPooled(scannable, concurrency, async (item) => {
    if (isCancelled()) return;
    const status = await buildAndProbe(item, bundle, run);
    if (isCancelled()) return;
    onResult(item.id, status);
  });
}
