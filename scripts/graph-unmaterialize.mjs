#!/usr/bin/env node
/**
 * `node scripts/graph-unmaterialize.mjs [--apply]` — write materialized records back out as files.
 *
 * The rollback for files-to-zero. Every record in the committed store that carries a `src` is written
 * back to that path, restoring the crate to an ordinary file tree. Undoing the rest is then mechanical:
 * delete the crate's `build.rs`, drop its `include!`, and re-add its `mod` declarations.
 *
 * It exists because a one-way migration is not a decision, it is a bet. The trade being taken — losing
 * git blame, review diffs and goto-definition on the materialized modules — is one the maintainer chose
 * on 2026-08-19 with those costs named, and a chosen trade should stay reversible while it is still
 * being evaluated.
 *
 * DRY BY DEFAULT. It prints what it would write and touches nothing without `--apply`, because the
 * paths it writes to are exactly the paths a migration deleted, and an accidental run would resurrect
 * a second copy of every module — the two-live-copies state this whole architecture exists to avoid.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";

const ROOT = join(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "..");

/** Records that carry both a `src` path and a body — necessary to restore, but NOT sufficient. */
export function restorable(impls) {
  return (impls ?? []).filter(
    (i) => typeof i?.src === "string" && i.src.trim() && typeof i?.code === "string" && i.code.trim(),
  );
}

/**
 * What a restore would write, and what it refuses.
 *
 * THE REFUSAL IS THE IMPORTANT HALF, and it was found by running the dry run rather than by reasoning.
 * The store holds two different KINDS of record with a `src`:
 *
 *  * a **module** record — the whole file, materialized at build time. Its `src` does NOT exist on disk;
 *    that absence is the entire point of the migration. Restoring it is correct.
 *  * a **function** record — one function LIFTED OUT of a file that still exists and still holds other
 *    code. `unquote.rs` carries 8 lines and names `crates/cve/src/install.rs`, a live 200-line module.
 *    Writing it back would delete that file's other contents.
 *
 * The discriminator is simply whether the target exists: a materialized module's file is absent by
 * construction, so a target that IS present means this record does not own it. `bsc graph emit` reaches
 * the same conclusion from the other direction and refuses to write over a record's shared `src` at all.
 *
 * @param {Array<{id?: string, src?: string, code?: string}>} [impls]
 * @param {(path: string) => boolean} [exists] does the repo-relative path already have a file?
 */
export function planRestore(impls, exists = (/** @type {string} */ _path) => false) {
  const plan = [];
  const refused = [];
  for (const i of restorable(impls)) {
    const entry = { id: i.id, path: i.src, content: i.code.endsWith("\n") ? i.code : `${i.code}\n` };
    if (exists(i.src)) {
      refused.push({
        ...entry,
        reason:
          "the file EXISTS — a materialized module's source is absent by construction, so this record " +
          "is a function lifted out of a live file and writing it back would delete the rest",
      });
    } else {
      plan.push(entry);
    }
  }
  return { plan, refused };
}

if (process.argv[1]?.endsWith("graph-unmaterialize.mjs")) {
  const apply = process.argv.includes("--apply");
  const storePath = join(ROOT, "graph", "algorithms.json");
  let store;
  try {
    store = JSON.parse(readFileSync(storePath, "utf8"));
  } catch (err) {
    process.stdout.write(`cannot read ${storePath}: ${err.message}\n`);
    process.exit(1);
  }

  const { plan, refused } = planRestore(store.implementations, (p) => existsSync(join(ROOT, p)));
  for (const r of refused) {
    process.stdout.write(`  REFUSED ${r.path}  (from ${r.id})\n           ${r.reason}\n`);
  }
  if (!plan.length) {
    process.stdout.write("nothing to restore — no record in the committed store carries a `src`\n");
    process.exit(0);
  }

  process.stdout.write(`\n${apply ? "restoring" : "would restore"} ${plan.length} file(s):\n`);
  for (const f of plan) {
    process.stdout.write(`  ${f.path}   (${f.content.split("\n").length} lines, from ${f.id})\n`);
    if (apply) {
      mkdirSync(join(ROOT, dirname(f.path)), { recursive: true });
      writeFileSync(join(ROOT, f.path), f.content, "utf8");
    }
  }
  if (!apply) {
    process.stdout.write("\nDRY RUN — pass --apply to write. Then remove the crate's build.rs, drop its\n");
    process.stdout.write("`include!(concat!(env!(\"OUT_DIR\"), …))`, and restore its `mod` declarations.\n");
  }
  process.exit(0);
}
