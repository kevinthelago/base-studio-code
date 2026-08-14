// Every stylesheet under `src/` must reach the bundle (#retiring-a-file-orphaned-its-stylesheet).
//
// THE BUG THIS EXISTS FOR. A component's CSS reached the bundle because the component's FILE imported
// it. A RECORD cannot import a stylesheet — the runtime loader resolves against the platform registry
// and the record store, and a stylesheet is in neither — so the seed projection drops it, correctly.
// Harmless while the file still exists; fatal the moment the file is RETIRED, because the last importer
// leaves with it. Ten stylesheets silently stopped shipping and the Banner and the Design Studio
// components rail rendered unstyled.
//
// WHY NO OTHER GATE SAW IT. Every module still resolved. typecheck, lint, vitest, `vite build`,
// `dev-boot-check` and the e2e mount sweep were all green, because a missing stylesheet is not a missing
// module: the app boots, mounts, and simply looks wrong. Nothing in the suite had an opinion about CSS
// REACHING anything — the whole class was unguarded.
//
// `main.tsx` now globs every `.css` eagerly, which makes orphaning impossible by construction. This
// asserts the glob's REACH rather than trusting its pattern: a stylesheet parked outside `src/` (or a
// pattern narrowed in a later edit) would silently drop back out.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");

/** Every `.css` under `src/`, as `src/`-relative POSIX paths — from a real directory listing, so a file
 *  added in a directory nobody thought about is still counted. */
function listCss(dir = SRC, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listCss(join(dir, e.name), r));
    else if (e.name.endsWith(".css")) out.push(r);
  }
  return out;
}

/** What the entry's eager glob actually matches, resolved by Vite at transform time. */
const globbed = new Set(
  Object.keys(import.meta.glob("@/**/*.css", { eager: false })).map((p) => p.replace(/^\/src\//, "")),
);

describe("every stylesheet reaches the bundle", () => {
  const all = listCss();

  it("finds stylesheets to check at all", () => {
    // Non-vacuity: a listing that stopped walking would make an empty sweep read as a clean one.
    expect(all.length).toBeGreaterThan(20);
  });

  it("the entry's glob covers every .css file on disk", () => {
    const missed = all.filter((f) => !globbed.has(f));
    expect(
      missed,
      `stylesheets the entry glob does not match — they ship only if some module still imports them, ` +
        `which is exactly the dependency that broke:\n  ${missed.join("\n  ")}`,
    ).toEqual([]);
  });

  it("main.tsx still globs them, and still imports tokens.css FIRST", () => {
    // The glob is the mechanism; losing it re-opens the whole class in a way nothing else would notice.
    const entry = readFileSync(join(SRC, "app/main.tsx"), "utf8");
    expect(entry, "main.tsx eagerly globs every stylesheet").toMatch(
      /import\.meta\.glob\(\s*["']@\/\*\*\/\*\.css["']\s*,\s*\{\s*eager:\s*true\s*\}\s*\)/,
    );
    // Token layer before component layer: the components consume the custom properties tokens.css
    // defines, and a glob that landed first would order the cascade by filename instead.
    const tokensAt = entry.indexOf('import "@/styles/tokens.css"');
    const globAt = entry.indexOf("import.meta.glob");
    expect(tokensAt, "tokens.css is imported").toBeGreaterThan(-1);
    expect(tokensAt, "tokens.css comes before the glob").toBeLessThan(globAt);
  });
});
