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
import { loadComponentFromSource } from "@/shared/lib/runtime/componentLoader";
import { GRAPH_SIBLING_PREFIX } from "@/shared/lib/runtime/graphResolver";

/** Every packaged app record — pages, their siblings, and the shared/ui components that `provides` them. */
const packaged = import.meta.glob<{ id: string; srcText?: string; provides?: string }>(
  "/src-tauri/data/components/app/**/*.json",
  { eager: true, import: "default" },
);
const RECORDS = Object.values(packaged);
const BY_ID = new Map(RECORDS.map((r) => [r.id, r]));

/** `resolveGraphSource`, mirrored: a SIBLING by id (#3606), or a record whose `provides` matches the
 *  specifier (#3660 graph-first — the branch #4185's harness was missing). Anything else returns null and
 *  goes to the registry, exactly as `routeImport` does. */
function resolveGraphSource(specifier: string): string | null {
  const record = specifier.startsWith(GRAPH_SIBLING_PREFIX)
    ? BY_ID.get(specifier.slice(GRAPH_SIBLING_PREFIX.length))
    : RECORDS.find((r) => r.provides === specifier);
  return record?.srcText ?? null;
}

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

declare global {
  interface Window {
    __graphPagesHarness?: { loadAll: () => Promise<PageResult[]> };
  }
}

window.__graphPagesHarness = { loadAll };
