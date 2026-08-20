// Every CSS file under src/ must actually PARSE.
//
// Why this exists: `src/features/logs/logs.css` documented the entry glob inside its header
// comment. A recursive glob contains a star followed by a slash — the exact sequence that ENDS a
// CSS comment — so the comment terminated nine lines early and the rest of the prose was handed
// to the parser as CSS. `npm run build` failed on EVERY platform with
//
//   [plugin vite:css-post] SyntaxError: [lightningcss minify] Unexpected token Delim('`')
//
// and it stayed invisible because `vite build` is deliberately OUTSIDE the default gate
// (CLAUDE.md lists it as optional), so nothing ever ran it. tsc, eslint and vitest were all green
// the entire time.
//
// This is the repo's recurring failure mode written down once more: a gate that passes while
// covering less than the reader assumes. The fix for one file would not have prevented the next
// one, so this checks the whole directory.
//
// lightningcss is the RIGHT oracle rather than a hand-rolled comment scanner: it is literally what
// vite invokes to minify, so "parses here" and "builds there" cannot drift apart. It arrives
// transitively via vite; if that ever stops being true this test fails loudly rather than
// silently skipping, which is the whole point.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(process.cwd(), "src");

function cssFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) cssFiles(p, out);
    else if (e.endsWith(".css")) out.push(p);
  }
  return out;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let lightningcss: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  lightningcss = require("lightningcss");
} catch {
  lightningcss = null;
}

describe("every CSS file under src/ parses", () => {
  const files = cssFiles(SRC);

  it("finds CSS to check at all", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(files.length).toBeGreaterThan(10);
  });

  it("can load the same parser the build uses", () => {
    expect(
      lightningcss,
      "lightningcss is unresolvable — it arrives transitively via vite, so this test can no " +
        "longer prove what `vite build` will do. Add it as an explicit devDependency.",
    ).not.toBeNull();
  });

  it.each(files.map((f) => relative(SRC, f)))("%s", (rel) => {
    const full = join(SRC, rel);
    const code = readFileSync(full);
    expect(() =>
      // minify: true matches what vite:css-post actually runs, which is where the original
      // failure surfaced. Parsing without minifying would not have caught it.
      lightningcss.transform({ filename: rel, code, minify: true }),
    ).not.toThrow();
  });
});
