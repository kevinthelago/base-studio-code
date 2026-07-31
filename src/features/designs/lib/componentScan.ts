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
//
// STATE BLANKS (#3191): the same sweep also render-confirms a component's supported data-STATES. A DATA
// component (collection prop) is built in the `empty` state and a component with a `loading` prop in the
// `loading` state; a build-clean, renders-fine-LOADED component that produces a BLANK #root in one of those
// states is flagged `empty-empty-state` / `empty-loading-state` (RUNTIME-only HealthCategory values — the
// static `analyzeGraphHealth`/Rust doctor can't render, so they never emit these). This is the render angle
// on the #3135 static no-empty/no-loading advisories: it catches a component that HAS an empty/loading
// branch which itself renders nothing (e.g. `data.length ? list : null`), which the static heuristic misses.
import type { RuntimeOutcome } from "@/shared/lib/preview/componentRuntimeProbe";
import {
  componentPreviewFiles, isCollectionProp, isLoadingProp,
  type KitArtifact, type LibraryModuleResolver,
} from "./componentPreview";
import type { HealthCategory } from "./graphHealth";
import { libraryModuleResolver } from "./libraryModules";
import { BASE_STUDIO_CODE_KIT_ID } from "./seed";
import type { ComponentRecord } from "./model";

/** The two RUNTIME data-state health categories the scan render-confirms (#3191) — a subset of
 *  {@link HealthCategory} (the `Extract` binds them to real members, so a typo fails to compile). */
export type RuntimeStateCategory = Extract<HealthCategory, "empty-empty-state" | "empty-loading-state">;

/** One component's preview outcome — the value the graph badges off. `ok` = built clean, ran without
 *  throwing, AND rendered something; `error` carries a readable message for the node's tooltip and a
 *  `kind` distinguishing a `build` failure (esbuild) from a `runtime` throw (an exception during the
 *  component's own render); `empty` = built + mounted clean but rendered NOTHING visible (#2926). */
export type ComponentBuildStatus =
  | { state: "ok" }
  | { state: "error"; kind: "build" | "runtime"; message: string }
  | { state: "empty"; message: string };

/**
 * What the scan should mirror to the DURABLE preview-error log (`bsc ui preview-error`) for a component
 * whose status went `prior` → `next` (#3540) — so `bsc ui doctor` sees the COMPLETE errored set, not
 * just components a human opened. Returns:
 *  - the message to RECORD, for BOTH a `build` failure and a `runtime` throw (#3549). Doctor's STATIC
 *    checks assume a build error is always statically detectable, but it isn't (WorkspaceShellPage's
 *    extensionless `src` built clean by the analyzer yet the real esbuild loader rejected its TS), so
 *    the real preview build is the authority — its failures must reach the log too. The message is
 *    prefixed with the kind (`build:`/`render:`) so the doctor finding reads correctly for either;
 *  - `""` to CLEAR, when a component that WAS an error is now ok/empty (so a fixed one drops out);
 *  - `null` to do nothing — a first-visit `ok`/`empty` (no prior error), so a sweep of ~50 healthy
 *    components logs nothing.
 *
 * Pure — the hook calls `recordPreviewError` only when this is non-null.
 */
export function durableLogSync(
  prior: ComponentBuildStatus | undefined,
  next: ComponentBuildStatus,
): string | null {
  if (next.state === "error") return `${next.kind === "build" ? "build" : "render"}: ${next.message}`;
  if (prior?.state === "error") return ""; // next is now ok/empty — a prior error is resolved, so clear it
  return null;
}

/** A per-STATE preview build to render-confirm for a BLANK #root (#3191) — the empty/loading data-state a
 *  component supports. `category` is the finding it yields when that state renders nothing; `files`/`entry`
 *  build that state's preview (the same file set as loaded — only the sampled props differ). */
export interface StateProbe {
  category: RuntimeStateCategory;
  files: Record<string, string>;
  entry: string;
}

/** A component queued for the build scan: its id, a change-signature (so an edit re-queues just it), and
 *  the in-memory files + entry to hand esbuild. */
export interface ScannableComponent {
  id: string;
  /** Any change to the buildable source re-queues this component (see {@link buildSignature}). */
  sig: string;
  files: Record<string, string>;
  entry: string;
  /** Extra per-state preview builds to render-confirm for a blank (#3191) — present only for a component
   *  that HAS the relevant state (a collection prop → `empty`; a `loading` prop → `loading`). Undefined
   *  for a component with no such state (a Button), so it is never probed for a state it can't have. */
  states?: StateProbe[];
}

/** A component's build signature — the fields that decide what gets bundled. A change to any of them
 *  (a designer edit, a re-authored source) means a stale ok/error, so the scan re-queues it. */
export function buildSignature(c: ComponentRecord): string {
  return [c.id, c.src ?? "", c.source ?? "", c.srcText ?? ""].join(" ");
}

/** The subset of `comps` that HAS buildable preview source (`componentPreviewFiles` non-null) — the scan
 *  targets. Components with no buildable source are deliberately excluded (they're the separate static
 *  `no-implementation` graph-health finding, not a build FAILURE), so this never double-reports them.
 *
 *  An APP-GRAPH record (`kitId === BASE_STUDIO_CODE_KIT_ID`) is ALSO excluded (#3859) — it no longer
 *  previews through this esbuild-in-iframe path (it renders live via the runtime loader,
 *  `GraphRecordPreviewFrame`), so building+running it here would be dead work: bundling every page in the
 *  kit on every Studio visit for a build/runtime check nothing reads. */
export function scannableComponents(
  comps: ComponentRecord[],
  artifact: KitArtifact,
  // The library resolver the scan judges `@bsc/…` imports with — the ACTIVE project's pinned sound kit
  // when a caller has project context (#3412), else the packaged default. It is part of the build, so a
  // kit switch changes which components build and must reach the scan, not just the live preview.
  libResolver: LibraryModuleResolver = libraryModuleResolver,
): ScannableComponent[] {
  const out: ScannableComponent[] = [];
  for (const c of comps) {
    if (c.kitId === BASE_STUDIO_CODE_KIT_ID) continue; // #3859 — live-hosted, not scanned here
    // Same-kit siblings so a composing user component's imported siblings vendor into its build (#3112).
    const siblings = comps.filter((s) => s.kitId === c.kitId && s.id !== c.id);
    const build = componentPreviewFiles(c, artifact, siblings, libResolver);
    if (!build) continue;
    // Only VENDORED sibling files + any `@bsc/…` LIBRARY module (#3116) add info beyond `buildSignature(c)`:
    // a built-in's whole-artifact file set isn't record-derived and a non-composing component vendors
    // nothing, so both keep sig === buildSignature(c) exactly (the pre-#3112 contract); a composer folds in
    // its siblings, and a library-importer folds in the vendored impl so an algorithm edit re-queues it.
    const sibSrcs = new Set(siblings.map((s) => s.src).filter(Boolean));
    const vendored = Object.keys(build.files).filter((k) => sibSrcs.has(k) || k.startsWith("@bsc/")).sort();
    // Runtime data-state probes (#3191): a DATA component (collection prop) also gets an `empty`-state build
    // and a component with a LOADING prop a `loading`-state build, so the scan can render-confirm a BLANK
    // #root in that state. Same file set as loaded — only the sampled props differ (`samplePropValue` empties
    // collections / turns on the loading prop) — so each reuses `componentPreviewFiles(..., state)`.
    const states: StateProbe[] = [];
    if (c.props.some(isCollectionProp)) {
      const s = componentPreviewFiles(c, artifact, siblings, libResolver, "empty");
      if (s) states.push({ category: "empty-empty-state", files: s.files, entry: s.entry });
    }
    if (c.props.some(isLoadingProp)) {
      const s = componentPreviewFiles(c, artifact, siblings, libResolver, "loading");
      if (s) states.push({ category: "empty-loading-state", files: s.files, entry: s.entry });
    }
    // Fold the qualifying states into the sig so adding/removing a collection/loading prop re-queues the
    // component. Appends "" for a stateless component ⇒ sig === buildSignature(c) exactly (pre-#3191 contract).
    const sig = (vendored.length
      ? buildSignature(c) + vendored.map((k) => `${k} ${build.files[k]}`).join("")
      : buildSignature(c)) + states.map((s) => s.category).join("");
    out.push({ id: c.id, sig, files: build.files, entry: build.entry, states: states.length ? states : undefined });
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
 * Render-confirm each supported data-STATE of a build-clean component (#3191), returning the categories it
 * renders BLANK in. For each state build, BUILD it then RUN it; a clean mount that renders NOTHING
 * (`ok && empty`) yields that state's category. A build error, a runtime throw, or a non-blank render yields
 * nothing — conservative: only a demonstrable, render-confirmed blank flags (a real EmptyState / skeleton
 * renders content ⇒ never flagged). Called ONLY when the component rendered fine LOADED, so a finding here
 * is precisely "works normally but blanks in this state". Pure given `bundle`/`run` (the hook wires the real
 * esbuild bundle + iframe probe; tests pass mocks).
 */
export async function probeStateBlanks(states: StateProbe[], bundle: BundleFn, run: RunFn): Promise<RuntimeStateCategory[]> {
  const blanks: RuntimeStateCategory[] = [];
  for (const s of states) {
    let js: string;
    try {
      js = await bundle(s.files, s.entry);
    } catch {
      continue; // a state build that won't compile isn't a blank-render signal — skip it
    }
    let outcome: RuntimeOutcome;
    try {
      outcome = await run(js);
    } catch {
      continue; // probe-infra failure ⇒ inconclusive, never a false flag
    }
    if (outcome.ok && outcome.empty) blanks.push(s.category);
  }
  return blanks;
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
 *
 * `onResult`'s third arg is the render-confirmed data-state blanks (#3191) — the `empty-empty-state` /
 * `empty-loading-state` categories the component blanks in, probed ONLY when it built + rendered fine LOADED
 * (a blank-loaded #2926 / errored component is already reported, so its state probes would be noise). Empty
 * for a component with no such fault or no probed states; a 2-arg `onResult` callback simply ignores it.
 */
export async function scanComponents(
  scannable: ScannableComponent[],
  bundle: BundleFn,
  concurrency: number,
  onResult: (id: string, status: ComponentBuildStatus, stateBlanks: RuntimeStateCategory[]) => void,
  isCancelled: () => boolean = () => false,
  run: RunFn = NO_RUNTIME_PROBE,
): Promise<void> {
  await runPooled(scannable, concurrency, async (item) => {
    if (isCancelled()) return;
    const status = await buildAndProbe(item, bundle, run);
    const stateBlanks = status.state === "ok" && item.states?.length
      ? await probeStateBlanks(item.states, bundle, run)
      : [];
    if (isCancelled()) return;
    onResult(item.id, status, stateBlanks);
  });
}
