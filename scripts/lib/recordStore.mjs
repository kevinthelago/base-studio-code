// Shared record-store loader: a store file (graph/algorithms.json) merged with any per-record files
// under a sibling `records/` dir (the file-per-record layout retiring the monolith,
// epic-retire-json-ledgers-for-db-and-git-drivers). Mirrors graph-materialize::load_merged_store so
// JS readers and the Rust materializer agree on the record set. A record lives in exactly one place;
// no records/ dir (e.g. a temp GRAPH_STORE in a test) means the file is returned untouched.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';

/**
 * Which store this checkout reads, from `graph/store.toml` — the marker that decoupled root discovery
 * from the store file (`the-repo-root-is-its-own-marker`). Falls back to the historical name so a
 * worktree older than the marker still loads.
 */
export function resolveStorePath(root = '.') {
  const marker = join(root, 'graph', 'store.toml');
  if (existsSync(marker)) {
    for (const line of readFileSync(marker, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      const m = t.match(/^store\s*=\s*"?([^"\s]+)"?/);
      if (m) return join(root, 'graph', m[1]);
    }
  }
  return join(root, 'graph', 'algorithms.json');
}

/** Is this file a SQLite database? By its MAGIC, never its name — the marker may name it anything. */
export function isSqliteStore(path) {
  if (!existsSync(path)) return false;
  let fd;
  try {
    fd = openSync(path, 'r');
    const head = Buffer.alloc(16);
    return readSync(fd, head, 0, 16, 0) === 16 && head.toString('latin1') === 'SQLite format 3\0';
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Read a DATABASE store — natively, with `node:sqlite`, and NOT by shelling to `bsc`.
 *
 * The first version asked `bsc graph dump --repo`, to keep ONE implementation of the rule that decides
 * what a store contains. That was the right instinct and the wrong call, because it makes every JS
 * gate leg depend on a working binary — and the gate's own `clippy --all-targets` ZEROES
 * `target/debug/bsc` partway through, so legs after it got a zero-byte binary and a store that read as
 * empty. `pickUsable` then falls back to the staged sidecar, which is only as fresh as the last
 * `build:plan`. Two failures in one day from the same dependency.
 *
 * So the rule is duplicated here, deliberately, and `recordStore.parity.test.ts` PROVES the two agree
 * against the real store — the same mitigation `emit-manifests` uses for its second renderer. The rule
 * is small and stated once:
 *
 *   * newest revision per id, per lane;
 *   * a NULL body is a TOMBSTONE — the record is retired, and the previous revision must NOT win;
 *   * `impl` rows are implementations, `edge` rows are the relationship tier, a NULL tier is `impl`.
 */
function loadStoreFromDb(storePath, lane = 'main') {
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        `SELECT r.id AS id, r.json AS json, r.tier AS tier
           FROM record_revs r
           JOIN (SELECT id, MAX(rev) AS rev FROM record_revs WHERE lane = ? GROUP BY id) top
             ON top.id = r.id AND top.rev = r.rev
          WHERE r.lane = ?
          ORDER BY r.id`,
      )
      .all(lane, lane);
    const implementations = [];
    const edges = [];
    for (const row of rows) {
      if (row.json === null || row.json === undefined) continue; // tombstone: retired, not stale
      const rec = JSON.parse(row.json);
      ((row.tier ?? 'impl') === 'edge' ? edges : implementations).push(rec);
    }
    return { implementations, edges };
  } finally {
    db.close();
  }
}

/** `node:sqlite` is experimental and warns on import; the warning is noise in every gate log. */
function sqliteModule() {
  const prev = process.emitWarning;
  process.emitWarning = (...args) => {
    if (String(args[0] ?? '').includes('SQLite is an experimental feature')) return;
    return prev.apply(process, args);
  };
  try {
    return createRequire(import.meta.url)('node:sqlite');
  } finally {
    process.emitWarning = prev;
  }
}

export function loadStore(storePath = resolveStorePath()) {
  if (isSqliteStore(storePath)) return loadStoreFromDb(storePath);
  const store = JSON.parse(readFileSync(storePath, 'utf8'));
  const dir = join(dirname(storePath) || '.', 'records');
  if (existsSync(dir) && Array.isArray(store.implementations)) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      store.implementations.push(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
  }
  return store;
}
export function loadImplementations(storePath) { return loadStore(storePath).implementations; }

/**
 * Write a merged store back to the SPLIT layout — the counterpart to `loadStore`, and the thing whose
 * absence made `graph-relationships --apply` a store-destroying command.
 *
 * `loadStore` merges `graph/records/*.json` into `store.implementations`, so writing that object
 * straight back to `graph/algorithms.json` puts every record into the monolith and leaves the
 * per-record files behind it — 1,885 records duplicated, and the next merged read seeing each twice.
 * The read half was migrated for the split; this half was not, and nothing noticed because the gate
 * that guards store READERS cannot see a writer.
 *
 * Mirrors `bsc_graph::repo_store::write_at`: each record goes to `records/<id>.json`, the store file
 * keeps the document's other keys with an EMPTY `implementations` array, and a record file that is no
 * longer in the document is removed. With no `records/` dir it writes the whole document through, so a
 * temp `GRAPH_STORE` in a test behaves exactly as it did before.
 */
export function writeStore(store, storePath = 'graph/algorithms.json') {
  const dir = join(dirname(storePath) || '.', 'records');
  if (!existsSync(dir)) {
    writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n');
    return;
  }
  const kept = new Set();
  for (const rec of store.implementations || []) {
    if (!rec || typeof rec.id !== 'string') {
      throw new Error(`a record has no \`id\`, so it has no file to live in: ${JSON.stringify(rec)}`);
    }
    kept.add(`${rec.id}.json`);
    const file = join(dir, `${rec.id}.json`);
    const body = JSON.stringify(rec, null, 2) + '\n';
    // Only when the bytes actually change, so an unchanged record keeps its mtime and git stays quiet.
    if (!existsSync(file) || readFileSync(file, 'utf8') !== body) writeFileSync(file, body);
  }
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    if (!kept.has(f)) rmSync(join(dir, f));
  }
  writeFileSync(storePath, JSON.stringify({ ...store, implementations: [] }, null, 2) + '\n');
}
