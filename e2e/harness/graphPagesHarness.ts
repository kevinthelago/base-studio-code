// Graph-page load harness (#4188, epic #3604) — drives the REAL loader over EVERY packaged page record,
// in a real browser.
//
// WHY THIS EXISTS. The static gate (`platformBoundary.test.ts`) reads each record's import lines and asks
// whether each specifier resolves. That is a TEXTUAL question. The loader asks a different one: it compiles
// with esbuild-wasm, vendoring siblings recursively into one module, and then every `require()` the emitted
// CommonJS makes must resolve. esbuild-wasm does not run in jsdom, so nothing in the default suite can ask
// the real question. This can — and it asks it for every page, not one.
//
// IT MUST MIRROR THE APP'S RESOLVER EXACTLY, and #4185 is why that is in capitals. Its harness resolved
// only `@/components/<id>` and NOT `provides`, which made it STRICTER than the app: it reported
// `GraphCanvas`, `TabBar` and `IconButton` as unresolved when all three are provided by shared/ui records,
// so the real loader vendors the graph copy and never reaches the registry. Three of its four findings were
// artifacts of the harness. A harness that does not match the thing it guards invents work — which costs
// more than having no harness, because the findings look real.
//
// It stops at LOAD, deliberately. Rendering needs the Tauri-backed store and `invoke`, which a browser
// harness has not got, and faking them would prove that a fake page renders. What this proves is the part
// that is otherwise unprovable outside a running app: each page compiles with its siblings, every import
// resolves against the registry the app actually builds, and a component comes out. Mounting stays the
// live-verify step on a dev instance.
import { registerPlatformModules } from "@/app/runtime/appModules";
import { SHADOW_PAGES } from "@/app/runtime/shadowPages";
import { loadComponentFromSource, compileToCjs } from "@/shared/lib/runtime/componentLoader";
import { verifyGraphRecord } from "@/shared/lib/runtime/verifyRecord";
import { isAppModule } from "@/shared/lib/runtime/moduleRegistry";
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import { resolveGraphSource } from "@/shared/lib/runtime/graphResolver";
import { useAppStore } from "@/store";
import algorithmsSeed from "@data/knowledge/algorithms.json";

/** Every packaged app record — pages, their siblings, and the shared/ui components that `provides` them. */
const packaged = import.meta.glob<{ id: string; srcText?: string; provides?: string }>(
  "/src-tauri/data/components/app/**/*.json",
  { eager: true, import: "default" },
);
const RECORDS = Object.values(packaged);
const BY_ID = new Map(RECORDS.map((r) => [r.id, r]));

/** Seed the store with what SHIPS, then let the REAL resolver run against it.
 *
 *  This file used to carry its own copy of `resolveGraphSource`, and the copy drifted TWICE — its own
 *  comment recorded the first ("the branch #4185's harness was missing"), and by the time logic modules
 *  started becoming algorithm records it was a branch behind again, so it could not see one at all. A
 *  mirrored resolver falls one branch behind every time the real one grows, and the failure mode is
 *  SILENT UNDER-REPORTING: the oracle says "unresolved" about specifiers the app resolves perfectly well,
 *  which is the worst possible answer from the check you delete files on the strength of.
 *
 *  The mirror existed because the harness must verify what SHIPS, not whatever the dev machine's live
 *  store happens to hold. That constraint is about which DATA is loaded, not about which function
 *  resolves — so seeding the packaged data satisfies it and the copy is unnecessary. */
useAppStore.setState({
  components: RECORDS as never,
  algorithmImpls: (algorithmsSeed as { implementations?: unknown[] }).implementations as never,
});

export interface PageResult {
  pageId: string;
  /** The component the loader picked — the page's own function, or the wrong one (the #3874 failure). */
  component?: string;
  error?: string;
}

/** Load every page in the catalogue. Each is reported independently: one broken page must not hide the
 *  verdict on the others, which is what a fail-fast loop would do. */
async function loadAll(): Promise<PageResult[]> {
  registerPlatformModules();
  const results: PageResult[] = [];
  for (const def of SHADOW_PAGES) {
    try {
      // The feature's platform surface, loaded the way the app loads it — through the barrel, whose
      // module-load side effect is the registration.
      await def.ensurePlatform();
      const page = BY_ID.get(def.pageId);
      if (!page?.srcText) throw new Error("no packaged record");
      const Loaded = await loadComponentFromSource(page.srcText, resolveGraphSource);
      results.push({ pageId: def.pageId, component: Loaded.name || "(anonymous)" });
    } catch (e) {
      results.push({ pageId: def.pageId, error: String(e).slice(0, 300) });
    }
  }
  return results;
}

/**
 * RENDER a graph page — behaviour coverage for the copy that actually ships (#4206).
 *
 * `loadAll` above proves a page COMPILES. This mounts one, so its behaviour can be asserted on the copy
 * that actually ships. Until now a migrated page's behaviour tests kept importing the bundled `.tsx`, which
 * the app no longer renders — so #186 (every tab's panes stay mounted, terminals survive a switch) and
 * #3033 (Glance never shows a blocking empty state) have been verified against components nobody mounts.
 * Deleting those files would have turned a false guard into no guard; this is how the guard moves instead.
 *
 * `markerStubs` replaces registered modules with inert markers. In vitest that is `vi.mock`, which has no
 * meaning here — but the registry is just a map, so a stub is one `registerAppModule` call, made AFTER the
 * platform registration so it wins. That is how `TerminalSlot` becomes a marker: the real one claims an
 * xterm from an app-level host a bare page has not got.
 *
 * The marker component is built HERE, with the harness's React — not passed in from the spec. A component
 * cannot cross `page.evaluate`'s serialization boundary, and a hand-rolled element object gets rejected as
 * "a React Element from an older version of React". The spec says WHICH module to replace and how to label
 * the marker; the harness owns the element.
 *
 * `state` is merged into the REAL store, not a fake — the page reads ~110 fields and a stub would drift
 * from the thing it stands in for, which is the bug class this whole session has been unpicking.
 */
export interface MarkerStub {
  /** The registered specifier to replace, e.g. `@/app/console/terminal/TerminalSlot`. */
  specifier: string;
  /** The export the page imports by name, e.g. `TerminalSlot`. */
  exportName: string;
  /** `data-testid` becomes `<testIdPrefix>-<props[idProp]>`, mirroring what the real component renders. */
  testIdPrefix: string;
  idProp: string;
}


/** The Tauri IPC boundary, stubbed (#4206).
 *
 *  A page's real code runs here — hooks, effects, store reads — and some of it calls `invoke`/`listen`.
 *  Tauri v2's api reaches `window.__TAURI_INTERNALS__`, which a plain browser has not got, so the first
 *  call throws `Cannot read properties of undefined (reading 'transformCallback')` and takes the render
 *  with it.
 *
 *  Stubbed at the IPC boundary rather than by faking the store or the hooks: the page then runs its OWN
 *  code all the way down and only the backend round-trip is inert, which is the smallest lie that lets a
 *  page render. Every `invoke` resolves `undefined` and every listener is never called — so a page must
 *  survive a backend that answers nothing, which is a property worth having anyway.
 */
function installTauriShim(): void {
  const w = window as unknown as { __TAURI_INTERNALS__?: Record<string, unknown> };
  if (w.__TAURI_INTERNALS__) return;
  let next = 1;
  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: unknown) => {
      const id = next++;
      (window as unknown as Record<string, unknown>)[`_${id}`] = cb;
      return id;
    },
    invoke: async () => undefined,
    convertFileSrc: (p: string) => p,
    unregisterCallback: () => undefined,
  };
}

async function renderPage(
  pageId: string,
  opts: { state?: Record<string, unknown>; markerStubs?: MarkerStub[] } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const def = SHADOW_PAGES.find((p) => p.pageId === pageId);
    if (!def) throw new Error(`no catalogue entry for "${pageId}"`);
    registerPlatformModules();
    await def.ensurePlatform();

    installTauriShim();
    const [{ useAppStore }, React, ReactDOMClient] = await Promise.all([
      import("@/store"),
      import("react"),
      import("react-dom/client"),
    ]);

    // AFTER the platform registration, so a marker deliberately shadows the real module. Built with THIS
    // React — the loaded page shares the app's single instance, and a second one throws on the first hook.
    for (const stub of opts.markerStubs ?? []) {
      registerAppModule(stub.specifier, {
        [stub.exportName]: (props: Record<string, unknown>) =>
          React.createElement("div", {
            "data-testid": `${stub.testIdPrefix}-${String(props[stub.idProp])}`,
            "data-visible": String(props.visible),
          }),
      });
    }
    if (opts.state) useAppStore.setState(opts.state as never);

    const record = BY_ID.get(pageId);
    if (!record?.srcText) throw new Error("no packaged record");
    const Loaded = await loadComponentFromSource(record.srcText, resolveGraphSource);
    const root = document.getElementById("root");
    if (!root) throw new Error("no #root");
    ReactDOMClient.createRoot(root).render(React.createElement(Loaded));
    // One frame, so effects run and the tree paints before the spec queries it.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 400) };
  }
}


export interface MountResult {
  pageId: string;
  /** The error that stopped it mounting — absent when it mounted and painted. */
  error?: string;
  /** DOM elements rendered. A page that mounts to NOTHING passed a boundary it should have failed.
   *
   *  ELEMENTS, not characters. Text was the first metric and it produced a false finding immediately:
   *  `consolepage` on a pristine store renders its grid shell with zero panes in it — real DOM, no text —
   *  so a character count reported the app's central surface as blank. The harness's own header warns
   *  that an oracle which does not match the thing it guards invents work; this is that, caught once. */
  nodes?: number;
  /** Rendered characters — informational, so a page that renders chrome but no content is still legible
   *  in the report without failing the sweep over it. */
  chars?: number;
}

/**
 * MOUNT every packaged page — the oracle `loadAll` stops one step short of.
 *
 * `loadAll` proves a page COMPILES and exports a component. That is a weaker claim than it sounds, and
 * the 02:00 incident is the proof: the app died with `Cannot read properties of null (reading
 * 'useCallback')` — a hook resolving against a null dispatcher. Such a module compiles perfectly, exports
 * a perfectly good component, and only fails when something MOUNTS it. Every check that stopped at
 * compile was green while 8 of 9 workspaces were dead.
 *
 * So this runs each page all the way to a painted tree, in its OWN container that is unmounted after —
 * a shared root would let one page's surviving effects (timers, listeners, store subscriptions) decide
 * the next page's verdict, which is how a sweep starts inventing findings.
 *
 * Each page is reported independently and the store is reset between them, so one broken page cannot
 * hide the verdict on the rest. Pages are NOT given marker stubs or seeded state: the question here is
 * whether the shipped record mounts at all, and a page that needs a fake to survive is a page whose real
 * failure this sweep should be showing rather than papering over. `renderPage` remains the surface for
 * the behavioural specs that legitimately need both.
 */
async function mountAll(): Promise<MountResult[]> {
  registerPlatformModules();
  installTauriShim();
  const [{ useAppStore }, React, ReactDOMClient] = await Promise.all([
    import("@/store"),
    import("react"),
    import("react-dom/client"),
  ]);
  const pristine = useAppStore.getState();
  const results: MountResult[] = [];

  for (const def of SHADOW_PAGES) {
    const host = document.createElement("div");
    document.body.appendChild(host);
    let root: { unmount: () => void } | undefined;
    // A page that throws during render throws inside React's own error handling, which re-raises to
    // `window.onerror` rather than out of `render()`. Catching it here is what turns "the harness page
    // crashed" into "this page failed", which is the difference between a verdict and a mystery.
    const thrown: string[] = [];
    const onError = (e: ErrorEvent) => thrown.push(String(e.error ?? e.message));
    window.addEventListener("error", onError);
    try {
      await def.ensurePlatform();
      const record = BY_ID.get(def.pageId);
      if (!record?.srcText) throw new Error("no packaged record");
      const Loaded = await loadComponentFromSource(record.srcText, resolveGraphSource);
      root = ReactDOMClient.createRoot(host);
      root.render(React.createElement(Loaded));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      if (thrown.length) throw new Error(thrown[0]);
      results.push({
        pageId: def.pageId,
        nodes: host.querySelectorAll("*").length,
        chars: host.textContent?.length ?? 0,
      });
    } catch (e) {
      results.push({ pageId: def.pageId, error: String(e).slice(0, 300) });
    } finally {
      window.removeEventListener("error", onError);
      try {
        root?.unmount();
      } catch {
        /* an unmount that throws is the page's problem, already recorded above */
      }
      host.remove();
      // Reset the store so a page that wrote state cannot decide the next page's verdict.
      useAppStore.setState(pristine as never, true);
      useAppStore.setState({
        components: RECORDS as never,
        algorithmImpls: (algorithmsSeed as { implementations?: unknown[] }).implementations as never,
      });
    }
  }
  return results;
}

export interface VerifyResult {
  id: string;
  ok: boolean;
  compileError?: string;
  unresolved?: string[];
}

/** LINK-VERIFY every packaged record — not just the pages `loadAll` walks.
 *
 *  `graphPages` proves ~12 pages mount; this asks the weaker-but-far-broader question of all ~383
 *  records: does it compile, and does every specifier it requires resolve? A record that fails this is
 *  one the loader would throw a named error on the moment something mounts it, and until now nothing
 *  asked that of a record no page happens to reach.
 *
 *  Verification does not evaluate, so this sweep runs no module-init side effects. */
async function verifyAll(): Promise<VerifyResult[]> {
  registerPlatformModules();
  // Register EVERY feature's platform surface first — a record's imports can only resolve against what
  // the app has actually registered, and each page's `ensurePlatform` is how the app registers it.
  for (const def of SHADOW_PAGES) {
    try {
      await def.ensurePlatform?.();
    } catch {
      /* a feature that cannot load is the page sweep's finding, not this one's */
    }
  }
  const out: VerifyResult[] = [];
  for (const r of RECORDS) {
    if (!r.srcText) continue;
    const v = await verifyGraphRecord(r.srcText, {
      resolveSource: resolveGraphSource,
      isRegistered: isAppModule,
      compile: (src) => compileToCjs(src),
    });
    out.push({ id: r.id, ok: v.ok, compileError: v.compileError, unresolved: v.unresolved });
  }
  return out;
}

declare global {
  interface Window {
    __graphPagesHarness?: {
      loadAll: () => Promise<PageResult[]>;
      mountAll: () => Promise<MountResult[]>;
      verifyAll: () => Promise<VerifyResult[]>;
      renderPage: typeof renderPage;
    };
  }
}

window.__graphPagesHarness = { loadAll, mountAll, verifyAll, renderPage };
