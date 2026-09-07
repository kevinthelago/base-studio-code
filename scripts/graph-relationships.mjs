// Derive record→record relationships from code and check that `composes` reflects them.
// The maintainer's rule: any import/use of another record IS a relationship; its absence alerts.
// Modes: --report (dry-run gap), --check (gate: fail on a gap not in the baseline), --baseline, --apply (backfill).
// Resolution is CONSERVATIVE: an edge is derived only when a reference resolves UNAMBIGUOUSLY to exactly
// one record — by TS `provides` specifier, or Rust module-path built from the record id (incl. relative
// self/super, brace groups, and crate-root re-exported symbols). A bare `super::*`/`super::item` that
// resolves to an ANCESTOR is skipped (that is child→parent, a trivial inverse of the parent's own edge).
// External-crate/std refs resolve to nothing. Validated: 21/21 observability parent→child, 93/94 hand-set.
import fs from 'node:fs';
const STORE = process.env.GRAPH_STORE || 'graph/algorithms.json';
const BASELINE = 'scripts/graph-relationships.baseline.json';
const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
const recs = store.implementations;
const by = new Map(recs.map(r => [r.id, r]));
const ID = /^[A-Za-z_]\w*$/;
const RUST_KW = new Set(['std', 'core', 'alloc']);

// TS provides index
const prov = new Map();
for (const r of recs) if (r.provides) (prov.get(r.provides) ?? prov.set(r.provides, []).get(r.provides)).push(r.id);

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

export function derive(r) {
  const c = r.code || ''; const t = new Set();
  if (r.tech === 'typescript') {
    for (const m of c.matchAll(TS_IMP)) { const s = m[1]; if (!(s.startsWith('@/') || s.startsWith('@bsc/'))) continue; const h = prov.get(s); if (h && h.length === 1 && h[0] !== r.id) t.add(h[0]); }
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

export function gaps() { const g = {}; for (const r of recs) { const der = derive(r); const have = new Set(r.composes || []); const missing = [...der].filter(x => !have.has(x)); if (missing.length) g[r.id] = missing.sort(); } return g; }

const mode = process.argv[2] || '--report';
if (mode === '--report') { const g = gaps(); const prod = recs.filter(r => r.role === 'algorithm'); console.log(`missing-relationship records: ${Object.keys(g).length} / ${prod.length} algorithm records`); }
else if (mode === '--check') {
  const g = gaps(); const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const nu = []; for (const [id, miss] of Object.entries(g)) { const b = new Set(base[id] || []); for (const m of miss) if (!b.has(m)) nu.push(`${id} -> ${m}`); }
  if (nu.length) { console.error(`RELATIONSHIP GATE: ${nu.length} NEW missing composes edge(s) not in baseline:`); nu.slice(0, 20).forEach(x => console.error('  ' + x)); process.exit(1); }
  console.log('relationship gate: no new missing edges');
}
else if (mode === '--baseline') { fs.writeFileSync(BASELINE, JSON.stringify(gaps(), null, 2) + '\n'); console.log('baseline written'); }
else if (mode === '--apply') {
  let added = 0, changed = 0;
  for (const r of recs) { const der = derive(r); if (!der.size) continue; const existing = r.composes || []; const have = new Set(existing); const add = [...der].filter(x => !have.has(x)).sort(); if (add.length) { r.composes = [...existing, ...add]; added += add.length; changed++; } }
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
  console.log(`backfill applied: +${added} composes edges across ${changed} records (union-preserving, composes-only)`);
}
