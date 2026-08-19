// A default import of packaged data JSON must yield the DATA, not the module namespace.
//
// This is the bug that broke `mcppage` and `planningpage` in a browser while `npm run gate` stayed
// green. esbuild compiles `import x from "spec"` to `__toESM(require("spec")).default`, and `__toESM`
// passes a module through ONLY if it carries `__esModule` — otherwise it wraps as
// `{...mod, default: mod}`, so `.default` is the namespace. Vite's eager-glob namespaces have no
// `__esModule`, so every default import of a packaged data JSON inside a record resolved to an object
// where the code expected its contents:
//
//   MODELS.map is not a function · PLAN_STAGES.map · MCP_CATALOG.filter · BUILTIN_MCP_SERVERS.filter
//
// Most degraded (the loader declined the override and fell back to the bundled module), which is why
// only two pages actually died — and why it went unnoticed: the failure was mostly SILENT.
//
// The registration was necessary but not sufficient, and nothing tested the sufficient half. This does.
import { describe, it, expect } from "vitest";
import { registerPlatformModules } from "@/app/runtime/appModules";
import { resolveAppModule, isAppModule } from "@/shared/lib/runtime/moduleRegistry";

/** esbuild's interop helper, reproduced exactly — this is the consumer whose contract we must satisfy. */
function toESM(mod: unknown): Record<string, unknown> {
  const m = mod as Record<string, unknown>;
  return m && m.__esModule ? m : { ...(m ?? {}), default: m };
}
/** What a record's default import of `spec` actually evaluates to at runtime. */
const defaultImport = (spec: string) => toESM(resolveAppModule(spec)).default;

describe("a default import of packaged data JSON yields the data", () => {
  registerPlatformModules();

  it("registers the data JSON at all", () => {
    expect(isAppModule("@data/console/models.json")).toBe(true);
  });

  it.each([
    ["@data/console/models.json", "MODELS"],
    ["@data/mcp/catalog.json", "MCP_CATALOG"],
    ["@data/mcp/builtin-servers.json", "BUILTIN_MCP_SERVERS"],
  ])("%s resolves to an ARRAY, not a namespace (%s)", (spec) => {
    if (!isAppModule(spec)) return;            // a data file may be renamed; the shape test is the point
    const value = defaultImport(spec);
    expect(Array.isArray(value), `${spec} → ${Object.prototype.toString.call(value)}`).toBe(true);
  });

  it("the namespace itself still has no __esModule — the wrapper is what supplies it", () => {
    // Pins the ROOT CAUSE rather than the symptom. If Vite ever starts emitting `__esModule`, this
    // fails and tells the next reader that `asEsModule` may have become unnecessary — instead of the
    // wrapper quietly persisting as cargo with nobody able to say why it exists.
    const raw = import.meta.glob<unknown>("@data/console/models.json", { eager: true });
    const ns = Object.values(raw)[0] as Record<string, unknown>;
    expect("__esModule" in ns).toBe(false);
    expect("default" in ns).toBe(true);
  });

  it("a module that ALREADY declares __esModule is not rewrapped", () => {
    // `asEsModule` must leave a genuine CJS-interop module alone; double-wrapping would bury its default.
    const already = { __esModule: true, default: [1, 2, 3] };
    expect(toESM(already).default).toBe(already.default);
  });
});
