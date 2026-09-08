// Shared record-store loader: a store file (graph/algorithms.json) merged with any per-record files
// under a sibling `records/` dir (the file-per-record layout retiring the monolith,
// epic-retire-json-ledgers-for-db-and-git-drivers). Mirrors graph-materialize::load_merged_store so
// JS readers and the Rust materializer agree on the record set. A record lives in exactly one place;
// no records/ dir (e.g. a temp GRAPH_STORE in a test) means the file is returned untouched.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

export function loadStore(storePath = 'graph/algorithms.json') {
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
