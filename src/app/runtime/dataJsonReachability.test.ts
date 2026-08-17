// Every `@data/*.json` a module imports must resolve through the platform registry.
//
// THE GAP THIS CLOSES. A record is compiled by the runtime loader, which resolves each import against the
// platform registry and the record store. `appModules.ts` bound ~199 specifiers and **every one was a
// MODULE** — there was no `@data/…json` key in it at all. So a module importing packaged data could never
// become a record, and `docs/records.md` recorded that as a rule ("a record may not import `@data/*.json`")
// when it was really just an absent registration. 35 modules are held back by it.
//
// WHY A SCAN RATHER THAN A PATTERN. The registration is a glob, so it cannot drift from the files — but it
// CAN drift from the specifier form importers actually write, and that is the half a glob cannot check.
// This asserts REACH: take every `@data/*.json` specifier that real source imports, and require the
// registry to answer it. Same shape as `styleReachability.test.ts`, and for the same reason — a pattern
// that looks right is not evidence, a directory listing is.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dataSpecifierFor } from "./appModules";

const SRC = join(process.cwd(), "src");

/** Every non-test module under `src/`, with its text. */
function listModules(dir = SRC, rel = ""): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listModules(join(dir, e.name), r));
    else if (/\.tsx?$/.test(e.name) && !/\.(test|spec)\.tsx?$/.test(e.name))
      out.push({ path: r, text: readFileSync(join(dir, e.name), "utf8") });
  }
  return out;
}

const DATA_JSON_IMPORT = /from\s+["'](@data\/[^"']+\.json)["']/g;

/** What the registration actually globs — the same glob `appModules.ts` uses, so the two cannot disagree. */
const GLOBBED = new Set(
  Object.keys(import.meta.glob("@data/**/*.json", { eager: false }))
    .map(dataSpecifierFor)
    .filter((s): s is string => s != null),
);

describe("every @data JSON a module imports is reachable through the registry", () => {
  const modules = listModules();

  it("finds modules to check at all", () => {
    // Non-vacuity: a listing that stopped walking would make an empty sweep read as a clean one.
    expect(modules.length).toBeGreaterThan(200);
  });

  it("every imported @data/*.json specifier is registered", () => {
    const imported = new Map<string, string>(); // specifier → first importer, for a useful message
    for (const m of modules) {
      for (const hit of m.text.matchAll(DATA_JSON_IMPORT)) {
        if (!imported.has(hit[1])) imported.set(hit[1], m.path);
      }
    }
    // Non-vacuity again: the whole point is that 44 of these exist today.
    expect(imported.size, "modules do import packaged @data JSON").toBeGreaterThan(20);

    const missing = [...imported].filter(([spec]) => !GLOBBED.has(spec));
    expect(
      missing.map(([spec, by]) => `${spec} (imported by ${by})`),
      `a @data JSON the registry cannot serve. Any module importing it is BLOCKED from becoming a ` +
        `record — the loader resolves against the registry and the record store, and a JSON file in ` +
        `neither resolves to nothing:\n  `,
    ).toEqual([]);
  });

  it("maps a glob key to the specifier an importer writes", () => {
    // The one hand-written step, and the only place the two halves can disagree.
    expect(dataSpecifierFor("/src-tauri/data/ui/themes.json")).toBe("@data/ui/themes.json");
    expect(dataSpecifierFor("/src-tauri/data/components/app/x/y.json")).toBe("@data/components/app/x/y.json");
    // Absolute keys carry a machine prefix in some Vite versions — the match is on the data dir, not the head.
    expect(dataSpecifierFor("C:/repo/src-tauri/data/mcp/catalog.json")).toBe("@data/mcp/catalog.json");
    expect(dataSpecifierFor("/somewhere/else/thing.json"), "a non-@data key is declined").toBeNull();
  });
});
