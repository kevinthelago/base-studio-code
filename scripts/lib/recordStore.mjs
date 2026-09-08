// Shared record-store loader: a store file (graph/algorithms.json) merged with any per-record files
// under a sibling `records/` dir (the file-per-record layout retiring the monolith,
// epic-retire-json-ledgers-for-db-and-git-drivers). Mirrors graph-materialize::load_merged_store so
// JS readers and the Rust materializer agree on the record set. A record lives in exactly one place;
// no records/ dir (e.g. a temp GRAPH_STORE in a test) means the file is returned untouched.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
