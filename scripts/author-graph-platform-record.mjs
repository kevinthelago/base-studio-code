// Author a `graphPlatform.ts` registrar as an impl record, so its file can retire.
//
// WHY THESE ARE NOT FLOOR. `docs/records.md` listed the registrars as permanently files because "they are
// what REGISTERS records; a record cannot register itself". Eight of them are already records — debug,
// designs, personas, planner, settings, studio-sessions, teams, tunnel — and the app ships that way. There
// is no circularity: a retired registrar resolves at BUILD time through the `@/` alias into
// `.bsc-records/`, exactly like any other module. The runtime graph loader is never involved.
//
// THE MODULE STATE IS BENIGN, which is the second reason they were held back. Every registrar carries
// `let done = false`, and the standing rule is that a record vendors a second copy of a module's state.
// What the state DOES decides: `done` is a one-shot guard whose only effect is skipping redundant writes
// into a SHARED GLOBAL registry, and `registerAppModule` is itself idempotent, so two copies each register
// once and the outcome is identical. Contrast `announcer.ts`, where the vendored state was a subscriber
// list — there the second copy swallowed every announcement.
//
// TWO MECHANICAL TRAPS THIS EXISTS TO AVOID:
//   * `bsc algorithms harvest --module` derives the id from the FILE STEM, so all sixteen derive
//     `graph-platform.ts` and each `--apply` would overwrite the last under one id. The shipped eight use
//     `<feature>-graph-platform.ts`; this follows that.
//   * `execFileSync`, never a shell. Git Bash rewrites an argument that looks like a path, so
//     `--provides "@/features/sounds/graphPlatform"` reaches the binary as
//     `@C:/Program Files/Git/features/sounds/graphPlatform` — stored silently, with no error.
//
//   node scripts/author-graph-platform-record.mjs <src-relative-path>… [--apply]
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { fileAsRecordSource } from "./lib/recordSource.mjs";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BSC = process.env.BSC_BIN ?? "C:/Users/Kevin/Projects/rust/base-studio-code/target/release/bsc.exe";
const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const targets = argv.filter((a) => !a.startsWith("--"));
if (!targets.length) { console.error("usage: node scripts/author-graph-platform-record.mjs <src-path>… [--apply]"); process.exit(2); }

/** `features/planner/session/graphPlatform.ts` → `planner-session-graph-platform.ts`, matching the eight
 *  already in the seed (`tunnel-graph-platform.ts`, `studio-sessions-graph-platform.ts`, …). The owning
 *  segments are everything between `features/`|`app/` and the filename, so a nested registrar keeps its
 *  parent in the id rather than colliding with the feature's own. */
function idFor(rel) {
  const parts = rel.split("/").slice(0, -1).filter((p) => p !== "features" && p !== "app");
  return `${parts.join("-")}-graph-platform.ts`;
}

const dir = mkdtempSync(join(tmpdir(), "author-gp-"));
const existing = new Map(
  JSON.parse(execFileSync(BSC, ["algorithms", "impl", "list"], { encoding: "utf8", maxBuffer: 1 << 28 })).map((r) => [r.id, r]),
);

for (const rel of targets) {
  const id = idFor(rel);
  const provides = `@/${rel.replace(/\.tsx?$/, "")}`;
  const clash = existing.get(id);
  if (clash && String(clash.src ?? "").split("\\").join("/") !== `src/${rel}`) {
    console.log(`SKIP ${id} — already names a DIFFERENT module (${clash.src}); pick another id`);
    continue;
  }
  const code = fileAsRecordSource(join(REPO, "src", rel), rel);
  console.log(`${APPLY ? "AUTHOR" : "would author"} ${id.padEnd(34)} provides ${provides}  (${code.length} chars)`);
  if (!APPLY) continue;

  const f = join(dir, `${id}.txt`);
  writeFileSync(f, code);
  execFileSync(BSC, [
    "algorithms", "impl", "set",
    "--id", id, "--tech", "typescript", "--role", "algorithm", "--name", "graphPlatform",
    "--code-file", f, "--src", `src/${rel}`, "--provides", provides,
    // NO `--module-state`. These modules were made stateless by the registrar migration, and declaring
    // state here would re-trip the very guard that removal was for: `impl set` refuses a
    // `provides` from a stateful record onto a REGISTERED specifier. The field is a DECLARATION the
    // store enforces against, not a description it ignores.
    "--clear", "moduleState",
    "--by", "claude",
    "--note", "the graph-platform registrar as a record: eight peers already ship this way, a retired registrar resolves at build time through the alias (no loader, no circularity), and the `done` guard it used to carry is gone because registerAppModule is a Map set and was already idempotent",
  ], { encoding: "utf8" });
  console.log("    written");
}
if (!APPLY) console.log("\n(dry run — pass --apply to write)");
