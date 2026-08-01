// Glance graph-record compile harness (#4185, epic #3604) — drives the REAL loader over the REAL records,
// in a real browser.
//
// WHY THIS EXISTS. The static gate (`platformBoundary.test.ts`) checks specifiers textually: it reads each
// record's import lines and asks whether each one is registered. That is not the same question the loader
// asks. The loader COMPILES the source with esbuild-wasm — vendoring siblings recursively into one module —
// and then every `require()` the emitted CommonJS makes must resolve. esbuild-wasm does not run in jsdom, so
// nothing in the default suite can ask the real question. This can.
//
// It stops at LOAD, deliberately. Rendering Glance needs the Tauri-backed store and `invoke`, which a
// browser harness has not got — and faking them would prove a fake page renders. What this proves is the
// part that is otherwise unprovable outside a running app: the nine records compile as one module, every
// import resolves against the registry the app actually builds, and a component comes out the other side.
// Mounting is the live-verify step on a dev instance.
import { registerPlatformModules } from "@/app/runtime/appModules";
import { registerGlancePlatform } from "@/features/glance/graphPlatform";
import { loadComponentFromSource } from "@/shared/lib/runtime/componentLoader";
import { GRAPH_SIBLING_PREFIX } from "@/shared/lib/runtime/graphResolver";

/** The packaged Glance records, exactly as they ship. */
const records = import.meta.glob<{ id: string; srcText: string }>(
  "/src-tauri/data/components/app/features/glance/*.json",
  { eager: true, import: "default" },
);
const BY_ID = new Map(Object.values(records).map((r) => [r.id, r]));

/** The app's sibling resolution, over the packaged set — `@/components/<id>` → that record's source. */
const resolveGraphSource = (spec: string): string | null =>
  spec.startsWith(GRAPH_SIBLING_PREFIX)
    ? BY_ID.get(spec.slice(GRAPH_SIBLING_PREFIX.length))?.srcText ?? null
    : null;

async function load(): Promise<{ ids: string[]; component: string }> {
  // The REAL registration path — the shell's platform set plus the feature's own, the same two calls the
  // host makes. Not a curated list: a list would drift from the thing it claims to describe.
  registerPlatformModules();
  registerGlancePlatform();

  const page = BY_ID.get("glancepage");
  if (!page) throw new Error("glancepage is not in the packaged records");
  const Loaded = await loadComponentFromSource(page.srcText, resolveGraphSource);
  return { ids: [...BY_ID.keys()].sort(), component: Loaded.name || "(anonymous)" };
}

declare global {
  interface Window {
    __glanceHarness?: { load: () => Promise<{ ids: string[]; component: string }> };
  }
}

window.__glanceHarness = { load };
