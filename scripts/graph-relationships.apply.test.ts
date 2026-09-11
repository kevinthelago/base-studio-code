// `graph-relationships-apply-overwrites-the-committed-store`: the relationship backfill must never write
// JSON over the committed record DATABASE.
//
// `graph-relationships.mjs --apply` ended in `writeStore(store, STORE)`, and `writeStore` wrote JSON
// straight to the store path whenever no `records/` dir sat beside it — which, once the committed store
// became `graph/algorithms.db`, was every time. The relationship gate's own failure message told people
// to run it. These tests drive a REAL SQLite store in the ledger's schema and assert its bytes survive.
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeStore } from "./lib/recordStore.mjs";

const REPO = resolve(__dirname, "..");
const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "graph-rel-apply-"));
  made.push(d);
  return d;
};
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** A record DATABASE in the ledger's schema, holding `records` at rev 1 on lane main. */
function recordDb(dir: string, records: Record<string, unknown>[]): string {
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const path = join(dir, "algorithms.db");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE record_revs (id TEXT NOT NULL, lane TEXT NOT NULL DEFAULT 'main', rev INTEGER NOT NULL, " +
      "base_rev INTEGER, json TEXT, tier TEXT NOT NULL DEFAULT 'impl', at INTEGER NOT NULL DEFAULT 0, " +
      "by TEXT NOT NULL DEFAULT '', note TEXT, PRIMARY KEY (id, lane, rev))",
  );
  const insert = db.prepare("INSERT INTO record_revs (id, lane, rev, json) VALUES (?, 'main', 1, ?)");
  for (const r of records) insert.run(r.id, JSON.stringify(r));
  db.close();
  return path;
}

/** Run the script the way a person or the gate does, against `store`. */
function relationships(mode: string, store: string) {
  try {
    const stdout = execFileSync("node", ["scripts/graph-relationships.mjs", mode], {
      cwd: REPO,
      env: { ...process.env, GRAPH_STORE: store },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

describe("writeStore never writes JSON over a record database", () => {
  it("refuses a real SQLite store and leaves it byte-for-byte", () => {
    const db = recordDb(scratch(), [{ id: "a.ts", tech: "typescript", role: "algorithm", name: "A" }]);
    const before = sha(db);
    expect(() => writeStore({ implementations: [] }, db)).toThrow(/record DATABASE/);
    expect(sha(db)).toBe(before);
  });

  it("refuses a .db path that does not exist yet, and does not mint one", () => {
    const path = join(scratch(), "graph", "algorithms.db");
    expect(() => writeStore({ implementations: [] }, path)).toThrow(/bsc graph impl set --repo/);
    expect(existsSync(path)).toBe(false);
  });

  it("still writes a JSON store, as a temp GRAPH_STORE in a test needs", () => {
    const path = join(scratch(), "store.json");
    writeStore({ implementations: [{ id: "a.ts" }] }, path);
    expect(JSON.parse(readFileSync(path, "utf8")).implementations).toEqual([{ id: "a.ts" }]);
  });
});

describe("graph-relationships.mjs against a record database", () => {
  const importer = {
    id: "a.ts", tech: "typescript", role: "algorithm", name: "Alpha's view", provides: "@/features/a",
    code: 'import { b } from "@/features/b";\nexport const a = b;\n',
  };
  const imported = { id: "b.ts", tech: "typescript", role: "algorithm", name: "B", provides: "@/features/b", code: "export const b = 1;\n" };

  it("--apply prints the ledger write for each record and never touches the file", () => {
    const db = recordDb(scratch(), [importer, imported]);
    const before = sha(db);
    const run = relationships("--apply", db);
    expect(run.status, run.stderr).toBe(1);
    expect(run.stderr).toContain("is a record DATABASE");
    expect(run.stdout).toContain("bsc graph impl set --repo");
    expect(run.stdout).toContain("--id 'a.ts'");
    expect(run.stdout).toContain("--composes 'b.ts'");
    expect(run.stdout, "the name is shell-quoted, apostrophe and all").toContain("--name 'Alpha'\\''s view'");
    expect(sha(db)).toBe(before);
  });

  it("--check names the ledger write for a stale crateDeps, not --apply", () => {
    const stale = { id: "bsc-probe--thing.rs", tech: "rust", role: "algorithm", name: "thing", code: "use serde_json::Value;\npub fn f(_: Value) {}\n", crateDeps: [] };
    const db = recordDb(scratch(), [stale]);
    const run = relationships("--check", db);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("stale crateDeps");
    expect(run.stderr).toContain("--crate-deps 'serde_json'");
    expect(run.stderr).not.toContain("--apply");
  });
});
