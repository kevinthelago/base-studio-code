import { describe, it, expect } from 'vitest';
import { derive } from './graph-relationships.mjs';
// The MERGED store loader (`epic-retire-json-ledgers-for-db-and-git-drivers`) — the committed store is
// a DATABASE. Reading a spelled JSON path would shrink
// the population this recognizer is proved over without failing: the `parents.length > 0` floor below
// would still pass on whatever observability records happened to remain.
import { loadStore, resolveStorePath } from './lib/recordStore.mjs';

// The recognizer must reproduce the observability parent->child edges set during decomposition:
// a --mod.rs parent re-exports its leaves (`pub(crate) use <child>::<fn>;`), which IS a relationship.
// This fails against a resolver that ignores relative (self/bare) uses — the bug found while building it.
describe('graph relationship recognizer', () => {
  // Resolved through the MARKER (`graph/store.toml`), never spelled: the store's filename and format
  // are exactly what that marker decides, so a spelled path reads as "the store is missing" the moment
  // it moves rather than as "this test is stale".
  const recs = loadStore(resolveStorePath()).implementations;
  const by = new Map(recs.map((r: any)=>[r.id,r]));
  it('reproduces every hand-set observability parent→child composes edge from code', () => {
    const parents = recs.filter((r: any)=> r.id.endsWith('--mod.rs') && r.id.includes('observability') && (r.composes||[]).length);
    expect(parents.length).toBeGreaterThan(0);
    for (const p of parents) {
      const der = derive(p);
      for (const child of p.composes.filter((c: string)=>by.has(c))) {
        expect(der.has(child), `${p.id} should derive its child ${child}`).toBe(true);
      }
    }
  });
});
