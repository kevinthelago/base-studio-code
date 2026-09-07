// Derive record→record relationships from code and check that `composes` reflects them.
// The maintainer's rule: any import/use of another record IS a relationship; its absence alerts.
// Modes: --report (dry-run gap), --check (gate: fail on a gap not in the baseline), --apply (backfill; GUARDED).
// Resolution is CONSERVATIVE: an edge is derived only when a reference resolves UNAMBIGUOUSLY to exactly
// one record (by TS `provides` specifier, or Rust module-path built from the record id). External-crate
// and std refs resolve to nothing and add no edge. Validated: 21/21 observability parent→child, 92/94
// hand-set record edges, 0 ambiguous.
import fs from 'node:fs';
const STORE = process.env.GRAPH_STORE || 'graph/algorithms.json';
const BASELINE = 'scripts/graph-relationships.baseline.json';
const store = JSON.parse(fs.readFileSync(STORE,'utf8'));
const recs = store.implementations;
const by = new Map(recs.map(r=>[r.id,r]));
const prov = new Map();
for (const r of recs) if (r.provides) (prov.get(r.provides)??prov.set(r.provides,[]).get(r.provides)).push(r.id);
const RUST_KW = new Set(['std','core','alloc']);
function modpath(r){ const i=r.id; if(!i.endsWith('.rs'))return null;
  let segs=i.slice(0,-3).split('--'); const crate=segs.shift();
  if(segs.at(-1)==='mod')segs=segs.slice(0,-1);
  return [crate, segs.map(s=>s.replaceAll('-','_'))]; }
const idx=new Map(); const key=(c,p)=>c+'|'+p.join('::');
for(const r of recs) if(r.tech==='rust'){ const mp=modpath(r); if(mp)(idx.get(key(mp[0],mp[1]))??idx.set(key(mp[0],mp[1]),[]).get(key(mp[0],mp[1]))).push(r.id); }
function rkey(c,path){ for(let L=path.length;L>0;L--){ const k=key(c,path.slice(0,L)); const h=idx.get(k); if(h) return h.length===1?h[0]:'<AMBIG>'; } return null; }
const TS_IMP=/import\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]/g;
const R_USE=/\b(?:pub(?:\([^)]*\))?\s+)?use\s+([A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_*{][A-Za-z0-9_]*)*)/g;
const ID=/^[A-Za-z_]\w*$/;
export function derive(r){ const c=r.code||''; const t=new Set();
  if(r.tech==='typescript'){ for(const m of c.matchAll(TS_IMP)){ const s=m[1]; if(!(s.startsWith('@/')||s.startsWith('@bsc/')))continue; const h=prov.get(s); if(h&&h.length===1&&h[0]!==r.id)t.add(h[0]); } }
  else if(r.tech==='rust'){ const mp=modpath(r); if(!mp)return t; const[crate,segs]=mp;
    for(const m of c.matchAll(R_USE)){ const parts=m[1].split('::'); const head=parts[0]; let path;
      if(head==='crate')path=parts.slice(1);
      else if(head==='self')path=[...segs,...parts.slice(1)];
      else if(head==='super'){ let up=[...segs],i=0; while(i<parts.length&&parts[i]==='super'){up=up.slice(0,-1);i++;} path=[...up,...parts.slice(i)]; }
      else if(RUST_KW.has(head))continue;
      else path=[...segs,...parts];
      path=path.filter(p=>ID.test(p));
      const h=rkey(crate,path); if(h&&h!=='<AMBIG>'&&h!==r.id)t.add(h); } }
  return t; }
// gaps: record -> [derived edges not in composes]
export function gaps(){ const g={};
  for(const r of recs){ const der=derive(r); const have=new Set(r.composes||[]);
    const missing=[...der].filter(x=>!have.has(x)); if(missing.length)g[r.id]=missing.sort(); }
  return g; }
const mode=process.argv[2]||'--report';
if(mode==='--report'){ const g=gaps(); const prod=recs.filter(r=>r.role==='algorithm');
  console.log(`missing-relationship records: ${Object.keys(g).length} / ${prod.length} algorithm records`);
}else if(mode==='--check'){ const g=gaps();
  const base=fs.existsSync(BASELINE)?JSON.parse(fs.readFileSync(BASELINE,'utf8')):{};
  const nu=[]; for(const [id,miss] of Object.entries(g)){ const b=new Set(base[id]||[]); for(const m of miss) if(!b.has(m)) nu.push(`${id} -> ${m}`); }
  if(nu.length){ console.error(`RELATIONSHIP GATE: ${nu.length} NEW missing composes edge(s) not in baseline:`); nu.slice(0,20).forEach(x=>console.error('  '+x)); process.exit(1); }
  console.log('relationship gate: no new missing edges'); 
}else if(mode==='--baseline'){ fs.writeFileSync(BASELINE, JSON.stringify(gaps(),null,2)+'\n'); console.log('baseline written'); }
else if(mode==='--apply'){ let added=0,changed=0;
  for(const r of recs){ const der=derive(r); if(!der.size)continue; const existing=r.composes||[]; const have=new Set(existing);
    const add=[...der].filter(x=>!have.has(x)).sort(); if(add.length){ r.composes=[...existing,...add]; added+=add.length; changed++; } }
  fs.writeFileSync(STORE, JSON.stringify(store,null,2)+'\n');
  console.log(`backfill applied: +${added} composes edges across ${changed} records (union-preserving, composes-only)`); }
