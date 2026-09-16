// Shared record-store loader: a store file (graph/algorithms.json) merged with any per-record files
// under a sibling `records/` dir (the file-per-record layout retiring the monolith,
// epic-retire-json-ledgers-for-db-and-git-drivers). Mirrors graph-materialize::load_merged_store so
// JS readers and the Rust materializer agree on the record set. A record lives in exactly one place;
// no records/ dir (e.g. a temp GRAPH_STORE in a test) means the file is returned untouched.
import { readFileSync, writeFileSync, existsSync, readdirSync, rmSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { createRequire } from 'node:module';

// ── WHICH LANE A CHECKOUT READS (`the-committed-record-stores-write-into-lanes`) ──────────────────────
//
// The committed record stores hold a row per (id, LANE, rev), and a lane is the git branch a checkout is
// on: a worker's `<project>/<stream>`, a project's `<project>/develop` (lane `<project>`), and develop /
// main / master / detached / no repo all lane `main`. A lane holds rows only for what it changed, so a
// read overlays the lane on its ancestors — the nearest lane that touched an id wins, and its tombstone
// hides every farther one.
//
// The SAME rule lives in `bsc_util::Lane` and in graph-materialize (the build), and it cannot be imported
// here any more than the build can import bsc-util. `scripts/lib/laneCases.json` states it once as data,
// and all three read that table in their tests. Reading `main` alone on a feature branch was the trap: the
// build compiled the branch's lane while every gate leg tested main's bodies.

const MAINLINE_BRANCHES = ['develop', 'main', 'master'];

/** Why `name` cannot be a lane, or `null` when it can — the rules a store key needs. */
export function laneProblem(name) {
  if (typeof name !== 'string' || name.length === 0) return 'a lane name cannot be empty';
  if (/[\s\p{Cc}]/u.test(name)) return `\`${name}\` holds whitespace or a control character`;
  if (name.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    return `\`${name}\` has an empty, \`.\` or \`..\` segment`;
  }
  return null;
}

/** The lane a branch is. `null` (detached, no repo) and a mainline branch are `main`. */
export function laneFromBranch(branch) {
  const b = typeof branch === 'string' ? branch.trim() : '';
  if (!b || MAINLINE_BRANCHES.includes(b)) return 'main';
  const cut = b.lastIndexOf('/');
  const name = cut >= 0 && b.slice(cut + 1) === 'develop' ? b.slice(0, cut) : b;
  return laneProblem(name) ? 'main' : name;
}

/** The branch `dir`'s checkout is on, read from HEAD without spawning git — `null` if detached or no repo. */
export function branchOf(dir) {
  let at = resolvePath(dir);
  for (;;) {
    const dot = join(at, '.git');
    if (existsSync(dot)) {
      let head;
      try {
        if (statSync(dot).isDirectory()) {
          head = join(dot, 'HEAD');
        } else {
          const line = readFileSync(dot, 'utf8').split('\n').map((l) => l.trim()).find((l) => l.startsWith('gitdir:'));
          if (!line) return null;
          const target = line.slice('gitdir:'.length).trim();
          head = join(isAbsolute(target) ? target : join(at, target), 'HEAD');
        }
        const text = readFileSync(head, 'utf8').trim();
        return text.startsWith('ref: refs/heads/') ? text.slice('ref: refs/heads/'.length) : null;
      } catch {
        return null;
      }
    }
    const up = dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/** The lane a checkout at `dir` reads: `BSC_LANE`, then `BSC_GRAPH_LANE`, else its branch. */
export function resolveLane(dir, env = process.env) {
  for (const name of ['BSC_LANE', 'BSC_GRAPH_LANE']) {
    const v = env?.[name];
    if (typeof v === 'string' && !laneProblem(v.trim())) return v.trim();
  }
  return laneFromBranch(branchOf(dir));
}

/** Every lane `lane` reads through, landed line FIRST: `a/b` is `['main', 'a', 'a/b']`. */
export function laneChain(lane) {
  const chain = [lane];
  let at = lane;
  while (at !== 'main') {
    const cut = at.lastIndexOf('/');
    at = cut >= 0 ? at.slice(0, cut) : 'main';
    chain.push(at);
  }
  return chain.reverse();
}

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

/**
 * The COMPONENT store this checkout reads, from the same marker
 * (`the-relationship-derivation-spans-both-record-stores`).
 *
 * The two committed stores hold the two halves of the FRONTEND's dependency chain: an algorithm record
 * importing `@/shared/ui/overlay/ModalScrim` is importing a COMPONENT record, and until this existed
 * there was no relation that could span them — `worker-detail-modal.ts` carried `composes: []` while
 * importing six of them. Resolved through `graph/store.toml` for the same reason `resolveStorePath` is:
 * a spelled filename is stale the moment the store moves, and `new DatabaseSync` on a path that does
 * not exist MINTS an empty database rather than failing, so a wrong guess reads as "no components".
 *
 * `null` when the checkout has no component store — a valid state (a fresh clone mid-migration), and
 * the caller degrades to algorithms-only rather than inventing an empty one.
 */
export function resolveComponentStorePath(root = '.') {
  const marker = join(root, 'graph', 'store.toml');
  let name = 'components.db';
  if (existsSync(marker)) {
    for (const line of readFileSync(marker, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('#')) continue;
      const m = t.match(/^components\s*=\s*"?([^"\s]+)"?/);
      if (m) { name = m[1]; break; }
    }
  }
  const at = join(root, 'graph', name);
  return existsSync(at) ? at : null;
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
 *   * the checkout's LANE over its ancestors: the nearest lane holding an id wins (see `laneChain`);
 *   * a NULL body is a TOMBSTONE — the record is retired, and the previous revision must NOT win;
 *   * `impl` rows are implementations, `edge` rows are the relationship tier, a NULL tier is `impl`.
 */
function loadStoreFromDb(storePath, lane) {
  const chain = laneChain(lane);
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    const marks = chain.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT r.id AS id, r.lane AS lane, r.json AS json, r.tier AS tier
           FROM record_revs r
           JOIN (SELECT id, lane, MAX(rev) AS rev FROM record_revs WHERE lane IN (${marks}) GROUP BY id, lane) top
             ON top.id = r.id AND top.lane = r.lane AND top.rev = r.rev`,
      )
      .all(...chain);
    // Per id, the NEAREST lane's head row — body or tombstone. `chain` is landed line first, so a higher
    // index is nearer.
    const rank = new Map(chain.map((l, i) => [l, i]));
    const nearest = new Map();
    for (const row of rows) {
      const r = rank.get(row.lane);
      const have = nearest.get(row.id);
      if (!have || r > have.rank) nearest.set(row.id, { rank: r, json: row.json, tier: row.tier });
    }
    const implementations = [];
    const edges = [];
    for (const id of [...nearest.keys()].sort()) {
      const { json, tier } = nearest.get(id);
      if (json === null || json === undefined) continue; // tombstone: retired, not stale
      const rec = JSON.parse(json);
      ((tier ?? 'impl') === 'edge' ? edges : implementations).push(rec);
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

/**
 * The merged store. A DATABASE is read in the lane its checkout is on (`opts.lane` overrides), which is
 * the lane the build compiles — reading `main` alone would test different code from the code it builds.
 */
export function loadStore(storePath = resolveStorePath(), opts = {}) {
  if (isSqliteStore(storePath)) {
    return loadStoreFromDb(storePath, opts.lane ?? resolveLane(dirname(resolvePath(storePath))));
  }
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
  // A DATABASE is never written from here (`graph-relationships-apply-overwrites-the-committed-store`).
  // This function writes JSON; the committed store the build compiles from is SQLite, and with no
  // `records/` dir beside it the branch below would have replaced it with a JSON document. Refused by
  // the file's magic AND by a `.db` name, so a path that does not exist yet is not minted as JSON either.
  if (isSqliteStore(storePath) || /\.db$/i.test(storePath)) {
    throw new Error(
      `refusing to write ${storePath}: it is a record DATABASE and writeStore writes JSON, which would replace ` +
        'the store the build compiles from. Change a record through the ledger instead: ' +
        'bsc graph impl set --repo --root <checkout> --tech <tech> --id <id> --role <role> --name <its name> ' +
        '--composes a,b --crate-deps a,b',
    );
  }
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
