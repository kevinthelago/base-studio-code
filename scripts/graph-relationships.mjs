// Derive record→record relationships from code and check that `composes` reflects them.
// The maintainer's rule: any import/use of another record IS a relationship; its absence alerts.
// Modes: --report (dry-run gap), --check (gate: fail on a gap not in the baseline), --baseline, --apply (backfill).
// Resolution is CONSERVATIVE: an edge is derived only when a reference resolves UNAMBIGUOUSLY to exactly
// one record — by TS `provides` specifier, or Rust module-path built from the record id (incl. relative
// self/super, brace groups, and crate-root re-exported symbols). A bare `super::*`/`super::item` that
// resolves to an ANCESTOR is skipped (that is child→parent, a trivial inverse of the parent's own edge).
// Record→record refs resolve by the rules above. External-CRATE refs are the OTHER half, and they
// resolve into `crateDeps` rather than `composes` — see `crateDepsOf`.
//
// THE FRONTEND'S CHAIN SPANS TWO STORES, and that is the THIRD relation here
// (`the-relationship-derivation-spans-both-record-stores`). A TS `@/` specifier resolves against
// `graph/algorithms.db` AND `graph/components.db`: measured 2026-09-16 over 1,572 `@/` imports, 1,207
// resolved to an algorithm record, 165 to a COMPONENT record, and 200 stayed unresolved. Those 165 were
// real relationships present in the code and absent from the graph purely because no relation spanned
// the boundary — `worker-detail-modal.ts` carried `composes: []` while importing six `@/shared/ui/*`
// primitives, every one a component record. They land in `componentDeps`, NOT in `composes`, for a
// stronger reason than the crate half: `repo_store::prune_dangling_composes` names a component record
// as a target "`composes` cannot express" and DELETES it on the next write, the seed guard
// `seed_parses_impl_only_and_is_primitives_rooted` asserts every composes id is a known IMPL, and
// `impl-seed-dedupe.test.ts` asserts it is an impl of the SAME tech. So the member vocabulary of
// `composes` does not widen; the record gains a relation that can hold the edge honestly.
import fs from 'node:fs';
import { loadStore, writeStore, resolveStorePath, resolveComponentStorePath, isSqliteStore } from './lib/recordStore.mjs';
const STORE = process.env.GRAPH_STORE || resolveStorePath();
const BASELINE = 'scripts/graph-relationships.baseline.json';
import path from 'node:path';
const store = loadStore(STORE); // merges graph/records/*.json (retire-json migration)
const recs = store.implementations;
const by = new Map(recs.map(r => [r.id, r]));
const ID = /^[A-Za-z_]\w*$/;
const RUST_KW = new Set(['std', 'core', 'alloc']);

// THE COMPONENT STORE, resolved through the same marker rather than spelled: `new DatabaseSync` on a
// path that does not exist MINTS an empty database, so a wrong guess reads as "no components" instead
// of failing. A checkout without one is valid, and the component half then reports itself as NOT RUN
// rather than reporting every carried `componentDeps` as drift.
const CSTORE = process.env.GRAPH_COMPONENT_STORE || resolveComponentStorePath(path.resolve(path.dirname(STORE), '..'));
const HAVE_COMPONENTS = Boolean(CSTORE) && fs.existsSync(CSTORE);
const crecs = HAVE_COMPONENTS ? loadStore(CSTORE).implementations : [];

// TS provides index
const prov = new Map();
for (const r of recs) if (r.provides) (prov.get(r.provides) ?? prov.set(r.provides, []).get(r.provides)).push(r.id);

// The COMPONENT `provides` index, the same shape — a component record carries the specifier it answers
// exactly as an algorithm record does (measured: 251 of 320 carry one, and no specifier is claimed twice).
const cprov = new Map();
for (const r of crecs) if (r.provides) (cprov.get(r.provides) ?? cprov.set(r.provides, []).get(r.provides)).push(r.id);

// Rust module-path index, from record ids. A bare id (no '--') is a root module in the toy library.
function modpath(r) {
  const i = r.id; if (!i.endsWith('.rs')) return null;
  const base = i.slice(0, -3);
  if (!base.includes('--')) return ['<lib>', [base.replaceAll('-', '_')]];
  let segs = base.split('--'); const crate = segs.shift();
  if (segs.at(-1) === 'mod') segs = segs.slice(0, -1);
  return [crate, segs.map(s => s.replaceAll('-', '_'))];
}
const key = (c, p) => c + '|' + p.join('::');
const idx = new Map();
for (const r of recs) if (r.tech === 'rust') { const mp = modpath(r); if (mp) (idx.get(key(mp[0], mp[1])) ?? idx.set(key(mp[0], mp[1]), []).get(key(mp[0], mp[1]))).push(r.id); }
// longest-prefix match: crate::a::b::item → module crate::a::b (drops the trailing item)
function rkey(c, path) { for (let L = path.length; L > 0; L--) { const h = idx.get(key(c, path.slice(0, L))); if (h) return h.length === 1 ? h[0] : '<AMBIG>'; } return null; }

// crate-root re-export index: a crate root's `pub use PATH::Symbol;` makes `crate::Symbol` mean PATH's
// module record. Only kept when a symbol maps to exactly ONE defining record.
const rootSym = new Map();
function addRootSym(crate, sym, rec) { const k = crate + '|' + sym; (rootSym.get(k) ?? rootSym.set(k, new Set()).get(k)).add(rec); }
for (const r of recs) {
  if (r.tech !== 'rust' || !r.id.endsWith('--lib.rs')) continue;
  const crate = r.id.split('--')[0];
  for (const m of (r.code || '').matchAll(/\bpub\s+use\s+([^;]+);/g)) {
    let spec = m[1].replace(/\s+as\s+\w+/g, '').trim();
    let items, base;
    const br = spec.match(/^(.*?)::\{([^}]*)\}\s*$/);
    if (br) { base = br[1]; items = br[2].split(',').map(s => s.trim()).filter(x => ID.test(x)); }
    else { const s = spec.split('::'); const last = s.pop(); base = s.join('::'); items = [last.trim()].filter(x => ID.test(x)); }
    const bp = base.split('::').filter(x => x !== 'crate' && x !== 'self' && ID.test(x));
    const modRec = rkey(crate, bp);
    for (const it of items) {
      if (modRec && modRec !== '<AMBIG>') addRootSym(crate, it, modRec);       // symbol defined in that module
      const sub = rkey(crate, [...bp, it]); if (sub && sub !== '<AMBIG>') addRootSym(crate, it, sub); // re-exported submodule
    }
  }
}
function rootSymResolve(crate, sym) { const s = rootSym.get(crate + '|' + sym); return s && s.size === 1 ? [...s][0] : null; }

// symbol-DEFINITION index: which record DEFINES a top-level pub item (fn/struct/enum/const/static/
// trait/type/union) at module scope — matched at column 0 of the record's code, so impl methods (indented)
// are excluded. `mod` is deliberately omitted: a module IS its own record, resolved by the module-path
// index, and indexing `pub mod foo` here would wrongly point crate::foo at the DECLARING parent.
// Lets `crate::Symbol` resolve to the defining record even with no `pub use` re-export. Conservative:
// an edge is derived only when exactly ONE record in the crate defines the symbol; ambiguous → skip.
const defSym = new Map();
const DEF_RE = /^pub(?:\(crate\))?\s+(?:async\s+)?(?:unsafe\s+)?(?:fn|struct|enum|const|static|trait|type|union)\s+([A-Za-z_]\w*)/gm;
for (const r of recs) {
  if (r.tech !== 'rust') continue;
  const crate = r.id.split('--')[0];
  for (const m of (r.code || '').matchAll(DEF_RE)) { const k = crate + '|' + m[1]; (defSym.get(k) ?? defSym.set(k, new Set()).get(k)).add(r.id); }
}
function defSymResolve(crate, sym) { const s = defSym.get(crate + '|' + sym); return s && s.size === 1 ? [...s][0] : null; }

// is `targetId`'s module a STRICT ancestor of curSegs in the same crate? (→ child→parent, skip)
function isAncestor(targetId, crate, curSegs) {
  const mp = modpath(by.get(targetId)); if (!mp || mp[0] !== crate) return false;
  const ts = mp[1]; return ts.length < curSegs.length && ts.every((s, i) => s === curSegs[i]);
}

const TS_IMP = /import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
const R_USE = /\buse\s+([^;]+);/g;

/// Which record a TS `@/` specifier names in the COMPONENT store, or `null`.
///
/// COMPONENTS WIN A CONTESTED SPECIFIER, and that precedence is not invented here — plan item
/// `resolver-reads-the-algorithms-store` settled it: a UI record overriding a shared/ui primitive is the
/// established meaning of `provides`, and an algorithm claiming the same specifier would silently shadow
/// a rendering component. Measured on the live stores, exactly ONE specifier is claimed by both.
function componentFor(spec) {
  const hit = cprov.get(spec);
  return hit && hit.length === 1 ? hit[0] : null;
}

export function derive(r) {
  const c = r.code || ''; const t = new Set();
  if (r.tech === 'typescript') {
    for (const m of c.matchAll(TS_IMP)) {
      const s = m[1]; if (!(s.startsWith('@/') || s.startsWith('@bsc/'))) continue;
      // The component store is consulted FIRST, and a hit is NOT a `composes` edge — it belongs to
      // `componentDeps`, the only relation that can carry it across the store boundary.
      if (componentFor(s)) continue;
      const h = prov.get(s); if (h && h.length === 1 && h[0] !== r.id) t.add(h[0]);
    }
  } else if (r.tech === 'rust') {
    const mp = modpath(r); if (!mp) return t; const [crate, segs] = mp;
    for (const m of c.matchAll(R_USE)) {
      let spec = m[1].replace(/\s+as\s+\w+/g, '').trim();
      let braceItems = null; const br = spec.match(/^(.*?)::\{([^}]*)\}\s*$/);
      const core = br ? br[1] : spec;
      if (br) braceItems = br[2].split(',').map(s => s.trim()).filter(x => ID.test(x));
      const rawSegs = core.split('::').map(s => s.trim());
      const head = rawSegs[0]; let base, isSuper = false;
      if (head === 'crate') base = rawSegs.slice(1).filter(x => ID.test(x));
      else if (head === 'self') base = [...segs, ...rawSegs.slice(1).filter(x => ID.test(x))];
      else if (head === 'super') { isSuper = true; let up = [...segs], i = 0; while (i < rawSegs.length && rawSegs[i] === 'super') { up = up.slice(0, -1); i++; } base = [...up, ...rawSegs.slice(i).filter(x => ID.test(x))]; }
      else if (RUST_KW.has(head)) continue;
      else base = [...segs, ...rawSegs.filter(x => ID.test(x))]; // bare: external crate OR own submodule
      const targets = [];
      if (braceItems) {
        for (const it of braceItems) { targets.push(rkey(crate, [...base, it]) ?? rkey(crate, base)); if (base.length === 0) { const rs = rootSymResolve(crate, it) ?? defSymResolve(crate, it); if (rs) targets.push(rs); } }
      } else {
        let h = rkey(crate, base);
        if (!h && head === 'crate' && base.length === 1) h = rootSymResolve(crate, base[0]) ?? defSymResolve(crate, base[0]); // crate-root symbol (re-export or definition)
        targets.push(h);
      }
      for (const h of targets) { if (!h || h === '<AMBIG>' || h === r.id) continue; if (isSuper && isAncestor(h, crate, segs)) continue; t.add(h); }
    }
  }
  return t;
}

/// The COMPONENT RECORDS one record's code imports — the edge `composes` structurally cannot hold.
///
/// Same relationship as `crateDeps`, one boundary over: `composes` is record→record WITHIN the
/// algorithms store, and a frontend record's imports do not respect that boundary. `worker-detail-modal.ts`
/// is the proof case — `composes: []` against six `@/shared/ui/*` imports, every one a component record.
///
/// Conservative in the same way everything here is: a dep is derived only when the specifier resolves to
/// exactly ONE component record. An import that points at a FILE ON DISK resolves to nothing and stays
/// that way — 194 of the 200 unresolved specifiers are the documented module floor, and counting those as
/// missing would destroy the signal this check exists to give.
export function componentDepsOf(r) {
  if (r.tech !== 'typescript') return [];
  const out = new Set();
  for (const m of (r.code || '').matchAll(TS_IMP)) {
    const s = m[1]; if (!(s.startsWith('@/') || s.startsWith('@bsc/'))) continue;
    const hit = componentFor(s);
    if (hit && hit !== r.id) out.add(hit);
  }
  return [...out].sort();
}

/// Records whose stored `crateDeps` disagree with what their code says.
export function crateGaps() {
  const g = {};
  for (const r of recs) {
    if (!r.id?.endsWith('.rs')) continue;
    const der = crateDepsOf(r), have = r.crateDeps || [];
    if (der.join(',') !== have.join(',')) g[r.id] = der;
  }
  return g;
}

/// Records whose stored `componentDeps` disagree with their code.
///
/// EXACT, not baselined, for the same reason the crate half is: a component dep is read straight off the
/// code, so a disagreement is always drift and always actionable. Empty when the checkout has no
/// component store — there is nothing to compare against, and reporting every carried dep as drift would
/// be a lie about a valid checkout. `--report`/`--check` say so out loud rather than passing quietly.
export function componentGaps() {
  const g = {};
  if (!HAVE_COMPONENTS) return g;
  for (const r of recs) {
    if (r.tech !== 'typescript') continue;
    const der = componentDepsOf(r), have = r.componentDeps || [];
    if (der.join(',') !== have.join(',')) g[r.id] = der;
  }
  return g;
}

/// EVERY CRATE NAME THIS WORKSPACE COULD REFER TO — its own members plus everything in the lock.
///
/// Resolving against a real universe rather than a regex is what keeps a local module named `agent`
/// from being recorded as a dependency on the `agent` crate. Underscored, because that is how a crate
/// is spelled in a path (`bsc-util` the package is `bsc_util` in `use`).
function crateUniverse() {
  const out = new Set();
  const add = (t) => { const m = /^name\s*=\s*"([^"]+)"/m.exec(t); if (m) out.add(m[1].replaceAll('-', '_')); };
  for (const d of fs.existsSync('crates') ? fs.readdirSync('crates') : []) {
    const f = path.join('crates', d, 'Cargo.toml');
    if (fs.existsSync(f)) add(fs.readFileSync(f, 'utf8'));
  }
  if (fs.existsSync('src-tauri/Cargo.toml')) add(fs.readFileSync('src-tauri/Cargo.toml', 'utf8'));
  if (fs.existsSync('Cargo.lock'))
    for (const m of fs.readFileSync('Cargo.lock', 'utf8').matchAll(/^name = "([^"]+)"/gm))
      out.add(m[1].replaceAll('-', '_'));
  return out;
}
const CRATES = crateUniverse();
const NOT_A_CRATE = new Set(['std', 'core', 'alloc', 'crate', 'self', 'super']);

/// The EXTERNAL CRATES one record's code reaches for — the edge `composes` structurally cannot hold.
///
/// `composes` is record→record and, measured 2026-09-08, 2,476 of its 2,477 edges stay inside one
/// crate. But 752 records reach ANOTHER crate, and nothing recorded it — so a closure computed from
/// `composes` alone is complete for the layer it describes and silent about the layer above it. That
/// gap is why a record's closure could not be compiled standalone: it was missing `bsc_util`,
/// `bsc_record`, `serde_json` — every one of them present in the code and absent from the graph.
///
/// Tests are excluded deliberately: a dev-dependency is not part of what the record NEEDS to run, and
/// including it would make every closure drag a test harness behind it.
export function crateDepsOf(r) {
  if (!r.id?.endsWith('.rs')) return [];
  const body = (r.code || '').replace(/#\[cfg\(test\)\]\s*mod tests \{[\s\S]*$/, '');
  // A record's OWN crate is not a dependency of it. `bsc_graph::x` inside a bsc-graph record is an
  // absolute self-path, which reads as an external reference and is not one — 18 records did this.
  const own = r.id.split('--')[0].replaceAll('-', '_');
  const out = new Set();
  for (const m of body.matchAll(/(?:^\s*use\s+|(?<![\w:.]))([a-z][a-z0-9_]*)\s*::/gm)) {
    const c = m[1];
    if (!NOT_A_CRATE.has(c) && c !== own && CRATES.has(c)) out.add(c);
  }
  return [...out].sort();
}

export function gaps() { const g = {}; for (const r of recs) { const der = derive(r); const have = new Set(r.composes || []); const missing = [...der].filter(x => !have.has(x)); if (missing.length) g[r.id] = missing.sort(); } return g; }

/// What `--apply` would change, computed WITHOUT touching a record: the `composes` edges to ADD (union-
/// preserving — resolution is conservative, so an edge nobody derived is not wrong) and the `crateDeps`
/// and `componentDeps` to REPLACE (read straight off the code, so a stale entry is wrong rather than extra).
export function backfillPlan() {
  const plan = [];
  for (const r of recs) {
    const change = {};
    const der = derive(r);
    if (der.size) {
      const existing = r.composes || [];
      const have = new Set(existing);
      const add = [...der].filter(x => !have.has(x)).sort();
      if (add.length) change.composes = [...existing, ...add];
    }
    if (r.id?.endsWith('.rs')) {
      const d = crateDepsOf(r);
      if (d.join(',') !== (r.crateDeps || []).join(',')) change.crateDeps = d;
    }
    if (HAVE_COMPONENTS && r.tech === 'typescript') {
      const d = componentDepsOf(r);
      if (d.join(',') !== (r.componentDeps || []).join(',')) change.componentDeps = d;
    }
    if (Object.keys(change).length) plan.push({ rec: r, ...change });
  }
  return plan;
}

/// The LEDGER write for one planned change — a revision per record, never a rewritten file. Every value
/// is single-quoted for the shell, and `--name` is the record's CURRENT name: `impl set` requires it and
/// silently renames the record to whatever it is given.
export function implSetCommand(p) {
  const q = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
  const r = p.rec;
  const parts = ['bsc algorithms impl set --repo --root "$PWD"', `--tech ${q(r.tech)}`, `--id ${q(r.id)}`, `--role ${q(r.role)}`, `--name ${q(r.name)}`];
  if (p.composes) parts.push(`--composes ${q(p.composes.join(','))}`);
  if (p.crateDeps) parts.push(p.crateDeps.length ? `--crate-deps ${q(p.crateDeps.join(','))}` : '--clear crateDeps');
  if (p.componentDeps) parts.push(p.componentDeps.length ? `--component-deps ${q(p.componentDeps.join(','))}` : '--clear componentDeps');
  return parts.join(' ');
}

/// A store this script must not write: it writes JSON, and the committed store is a database.
const isDatabase = (p) => isSqliteStore(p) || /\.db$/i.test(p);

const mode = process.argv[2] || '--report';
if (mode === '--report') {
  const g = gaps(); const prod = recs.filter(r => r.role === 'algorithm');
  console.log(`missing-relationship records: ${Object.keys(g).length} / ${prod.length} algorithm records`);
  const cg = crateGaps();
  const withDeps = recs.filter(r => (r.crateDeps || []).length).length;
  console.log(`crateDeps: ${withDeps} record(s) carry them · ${Object.keys(cg).length} disagree with their code`);
  if (!HAVE_COMPONENTS) {
    console.log('componentDeps: NOT CHECKED — this checkout has no component store');
  } else {
    const comp = componentGaps();
    const withComp = recs.filter(r => (r.componentDeps || []).length).length;
    console.log(`componentDeps: ${withComp} record(s) carry them · ${Object.keys(comp).length} disagree with their code`);
  }
}
else if (mode === '--check') {
  const g = gaps(); const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const nu = []; for (const [id, miss] of Object.entries(g)) { const b = new Set(base[id] || []); for (const m of miss) if (!b.has(m)) nu.push(`${id} -> ${m}`); }
  if (nu.length) { console.error(`RELATIONSHIP GATE: ${nu.length} NEW missing composes edge(s) not in baseline:`); nu.slice(0, 20).forEach(x => console.error('  ' + x)); process.exit(1); }
  // THE CRATE-DEP HALF IS EXACT, not baselined. `composes` needs a baseline because resolution is
  // conservative and a genuine gap can pre-exist; a crate dep is read straight off the code, so a
  // disagreement is always drift and always actionable.
  const cg = crateGaps();
  if (Object.keys(cg).length) {
    console.error(`RELATIONSHIP GATE: ${Object.keys(cg).length} record(s) have stale crateDeps:`);
    Object.entries(cg).slice(0, 20).forEach(([id, d]) => console.error(`  ${id} -> [${d.join(', ')}]`));
    // The fix is printed ready to run, one LEDGER write per record. This line used to say "run --apply",
    // which on a database store wrote JSON over the committed store
    // (`graph-relationships-apply-overwrites-the-committed-store`).
    const stale = new Set(Object.keys(cg));
    console.error('  refresh each through the ledger:');
    for (const p of backfillPlan().filter((p) => stale.has(p.rec.id)).slice(0, 20)) {
      console.error('    ' + implSetCommand({ rec: p.rec, crateDeps: p.crateDeps }));
    }
    process.exit(1);
  }
  // THE CROSS-STORE HALF, exact for the same reason. A checkout with no component store says so rather
  // than passing silently — a skipped check read as a pass is how a gate stops covering what its reader
  // assumes it covers.
  if (!HAVE_COMPONENTS) {
    console.log('relationship gate: no new missing edges, crateDeps current, componentDeps NOT CHECKED (no component store)');
  } else {
    const comp = componentGaps();
    if (Object.keys(comp).length) {
      console.error(`RELATIONSHIP GATE: ${Object.keys(comp).length} record(s) have stale componentDeps:`);
      Object.entries(comp).slice(0, 20).forEach(([id, d]) => console.error(`  ${id} -> [${d.join(', ')}]`));
      const stale = new Set(Object.keys(comp));
      console.error('  refresh each through the ledger:');
      for (const p of backfillPlan().filter((p) => stale.has(p.rec.id)).slice(0, 20)) {
        console.error('    ' + implSetCommand({ rec: p.rec, componentDeps: p.componentDeps }));
      }
      process.exit(1);
    }
    console.log('relationship gate: no new missing edges, crateDeps + componentDeps current');
  }
}
else if (mode === '--baseline') { fs.writeFileSync(BASELINE, JSON.stringify(gaps(), null, 2) + '\n'); console.log('baseline written'); }
else if (mode === '--apply') {
  const plan = backfillPlan();
  // A DATABASE store is REFUSED, and the plan is printed as ledger writes instead
  // (`graph-relationships-apply-overwrites-the-committed-store`). `writeStore` writes JSON; pointed at
  // `graph/algorithms.db` it replaced the store the build compiles from, and the --check leg told people
  // to run exactly this. A revision per record through `bsc algorithms impl set --repo` is the only write that
  // store takes.
  if (isDatabase(STORE)) {
    if (!plan.length) {
      console.log('relationship backfill: nothing to apply');
      process.exit(0);
    }
    console.error(`relationship backfill: ${plan.length} record(s) need edges, and ${STORE} is a record DATABASE — this script writes JSON and will not touch it.`);
    console.error('Apply each through the ledger:');
    for (const p of plan) console.log('  ' + implSetCommand(p));
    process.exit(1);
  }
  // A JSON store (a temp GRAPH_STORE in a test) is still written, through `writeStore` so the split
  // per-record layout is respected.
  let added = 0, changed = 0, cd = 0, cdRecs = 0, pd = 0, pdRecs = 0;
  for (const p of plan) {
    if (p.composes) { added += p.composes.length - (p.rec.composes || []).length; changed++; p.rec.composes = p.composes; }
    if (p.crateDeps) { cd += p.crateDeps.length; cdRecs++; if (p.crateDeps.length) p.rec.crateDeps = p.crateDeps; else delete p.rec.crateDeps; }
    if (p.componentDeps) { pd += p.componentDeps.length; pdRecs++; if (p.componentDeps.length) p.rec.componentDeps = p.componentDeps; else delete p.rec.componentDeps; }
  }
  writeStore(store, STORE);
  console.log(`backfill applied: +${added} composes edges across ${changed} records (union-preserving)`);
  console.log(`crateDeps: ${cd} dependency edge(s) across ${cdRecs} record(s) (replaced, derived from code)`);
  console.log(`componentDeps: ${pd} cross-store edge(s) across ${pdRecs} record(s) (replaced, derived from code)`);
}
