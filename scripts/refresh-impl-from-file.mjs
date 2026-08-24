// Refresh an EXISTING impl record's `code` from the file it claims to be — by id, never by harvest.
//
// WHY NOT `bsc graph harvest --module --apply`. That authors the candidate under an id DERIVED FROM THE
// FILENAME, and four different feature barrels all derive `index.ts`. Applying them in turn would write
// them over one another under one id — a collision that reads as "it worked" four times. The existing
// records are `teams-index.ts`, `debug-index.ts`, `kit-index.ts`, `designs-index.ts`, and the refresh has
// to target those, so the id is passed rather than guessed.
//
// The file is the authority here, deliberately: it is the copy `tsc`, `lint`, `vitest` and `vite build`
// all validate, and these records claim to BE it. A record that is meant to differ should not carry a
// `provides` naming its file — see `npm run census:claims`.
//
//   node scripts/refresh-impl-from-file.mjs <impl-id>=<src-relative-path>… [--apply]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fileAsRecordSource, exportedNames } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BSC = process.env.BSC_BIN ?? "C:/Users/Kevin/Projects/rust/base-studio-code/target/release/bsc.exe";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const pairs = argv.filter((a) => !a.startsWith("--")).map((a) => {
  const [id, rel] = a.split("=");
  if (!id || !rel) { console.error(`bad argument "${a}" — expected <impl-id>=<src-relative-path>`); process.exit(2); }
  return { id, rel };
});
if (!pairs.length) { console.error("usage: node scripts/refresh-impl-from-file.mjs <impl-id>=<src-path>… [--apply]"); process.exit(2); }

const impls = new Map(
  JSON.parse(execFileSync(BSC, ["graph", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 })).map((r) => [r.id, r]),
);
const dir = mkdtempSync(join(tmpdir(), "refresh-impl-"));

for (const { id, rel } of pairs) {
  const rec = impls.get(id);
  if (!rec) { console.log(`SKIP ${id} — not in the store`); continue; }
  const code = fileAsRecordSource(join(REPO, "src", rel), rel);
  const before = rec.code ?? "";
  if (before === code) { console.log(`SKIP ${id} — already equals its file`); continue; }

  // Report what the refresh RESTORES. A refresh that adds nothing back is still fine, but a refresh that
  // restores named exports is the whole point of the exercise, and saying so makes it reviewable.
  const had = exportedNames(before), now = exportedNames(code);
  const restored = had && now ? [...now].filter((n) => !had.has(n)) : null;
  const removed = had && now ? [...had].filter((n) => !now.has(n)) : null;
  console.log(`${APPLY ? "REFRESH" : "would refresh"} ${id.padEnd(20)} ${before.length} -> ${code.length} chars`);
  if (restored?.length) console.log(`    restores export(s): ${restored.join(", ")}`);
  // A refresh should not REMOVE an export. If it does, the record held something the file does not, and
  // that is a judgement call rather than a sync — so it is surfaced instead of being applied quietly.
  if (removed?.length) console.log(`    ⚠ removes export(s) the record had: ${removed.join(", ")} — adjudicate before applying`);
  if (!APPLY) continue;

  const f = join(dir, `${id}.txt`);
  writeFileSync(f, code);
  execFileSync(BSC, [
    "graph", "impl", "set",
    "--id", id, "--tech", rec.tech ?? "typescript", "--role", rec.role ?? "algorithm",
    "--name", rec.name ?? id, "--code-file", f,
    "--by", "claude",
    "--note", `refresh from ${rel}: this record carries a provides naming that file, so it must BE that file — the file is the copy every gate validates`,
  ], { encoding: "utf8" });
  console.log(`    written`);
}
if (!APPLY) console.log("\n(dry run — pass --apply to write)");
