// Reconcile `shadowPages.ts` with what is actually on disk: any entry naming a file that no longer
// exists becomes `file: null`, and its name leaves the brace-expansion glob that pairs with it.
//
// `file: null` is the DESIGNED end state, not a special case — it is what `fleetpage` has carried since
// its files went in #3636, and it reads as "no file baseline", so only the binding half of the shadow
// report applies. `shadowPages.test.ts` asserts both halves move together, because a declared path the
// glob does not match ALSO loads as `null`, which would be indistinguishable from a deliberate deletion.
//
// This is a sweep rather than a per-module step because doing it by hand failed on two tranches running.
//
//   node scripts/sync-shadow-catalogue.mjs [--dry]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry");
const CATALOGUE = join(REPO, "src/app/runtime/shadowPages.ts");
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

let text = readFileSync(CATALOGUE, "utf8");
const declared = [...text.matchAll(/file:\s*"(\/src\/[^"]+)"/g)].map((m) => m[1]);
const retired = declared.filter((p) => !existsSync(join(REPO, p.slice(1))));

for (const p of retired) {
  text = text.replace(
    new RegExp(`(\\{\\s*recordId:\\s*"[^"]+",\\s*)file:\\s*"${escape(p)}"(\\s*\\})`),
    "$1file: null$2, // RETIRED — the record is the only copy",
  );
  // Out of the glob it pairs with. These are brace-expansion lists, so the module's basename is one
  // alternative among many: `{A,B,C}.tsx`. Drop the name and the separator it brought with it.
  const name = p.split("/").pop().replace(/\.tsx?$/, "");
  text = text.replace(new RegExp(`([{,])${escape(name)}(?=[,}])`), (_m, lead) => (lead === "{" ? "{" : ","));
}
// Tidy the separators the removals left behind, so the glob stays a valid brace expansion.
text = text.replace(/\{,/g, "{").replace(/,\}/g, "}").replace(/,{2,}/g, ",");

console.log(`${DRY ? "would declare" : "declared"} graph-only: ${retired.length}`);
for (const p of retired) console.log(`   ${p}`);
if (!DRY && retired.length) writeFileSync(CATALOGUE, text);
