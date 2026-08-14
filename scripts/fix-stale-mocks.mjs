// Rewrite `vi.mock("./x")` to the `@/…` alias wherever the relative target no longer exists in `src/`.
//
// A mock keys on the RESOLVED module. While `src/a/b.ts` exists, a consumer's `@/a/b` and a test's `./b`
// resolve to the same file and the mock applies. Retire the file and they stop agreeing — the consumer
// resolves through `tsconfig.paths` to the emitted record, the test's relative path resolves elsewhere (or
// nowhere), and the mock SILENTLY STOPS APPLYING. The test still runs, against the real module.
//
// `retire-module.mjs` now rewrites `vi.mock` alongside the import forms, so this only has to clean up
// mocks whose target was retired before that was true. It is idempotent — a second run finds nothing.
//
//   node scripts/fix-stale-mocks.mjs [--dry]
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");
const SRC = join(REPO, "src");

const files = [];
(function walk(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(join(dir, e.name), r);
    else if (/\.(ts|tsx)$/.test(e.name)) files.push(r);
  }
})(SRC, "");

const EXT = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];
const existsInSrc = (rel) => EXT.some((e) => existsSync(join(SRC, rel + e)));

let touched = 0, rewritten = 0;
for (const f of files) {
  const abs = join(SRC, f);
  const before = readFileSync(abs, "utf8");
  const fromDir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
  const after = before.replace(
    /((?:vi\.mock|vi\.doMock|vi\.unmock)\s*\(\s*)(['"])(\.\.?\/[^'"]+)\2/g,
    (whole, head, q, relSpec) => {
      const out = [];
      for (const seg of `${fromDir}/${relSpec}`.split("/")) {
        if (seg === "" || seg === ".") continue;
        if (seg === "..") out.pop();
        else out.push(seg);
      }
      const target = out.join("/");
      // Only the ones whose target is GONE. A mock of a module that still exists resolves fine either
      // way, and rewriting it would be churn with no behaviour behind it.
      if (existsInSrc(target)) return whole;
      rewritten++;
      return `${head}${q}@/${target}${q}`;
    },
  );
  if (after !== before) {
    touched++;
    console.log(`   ${DRY ? "would rewrite" : "rewrote"}  ${f}`);
    if (!DRY) writeFileSync(abs, after);
  }
}
console.log(`${DRY ? "would fix" : "fixed"} ${rewritten} stale mock specifier(s) across ${touched} file(s)`);
