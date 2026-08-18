// Closing a promotion's `composes` graph — which store-only records must ride along into the seed.
//
// WHY IT IS NEEDED. `knowledge.test.ts` asserts that every id in an impl's `composes` is a REAL impl in
// the seed, of the same tech. So promoting an impl whose `composes` points at something still store-only
// breaks the seed the moment it lands — the first unfiltered run promoted 35 impls and left 33 dangling
// references. `promote-records` therefore REFUSES such an impl, which is correct but pessimal: measured
// on the drained tree, `unclosed-composes` was the biggest wall at 32 modules.
//
// Most of those refusals are ordering that resolves itself. The rest are not: 10 were blocked on
// function records harvested out of the SAME FILE as their consumer (`fnv1a32.ts` from `hash.ts`,
// `merge-role-defaults.ts` from `roleModel.ts`), and those in turn compose the TypeScript language
// PRIMITIVES — of which the seed had exactly one, `typescript.number`, while the store had six. So the
// wall was mostly a seed gap in the language kit's base, not a promotion problem.
//
// THE RULE, and the safety argument for it: a record with NO `provides` is a pure LIBRARY entry. It
// answers no specifier, so the runtime never serves it in place of a module and shipping it cannot
// change what the app renders — it only makes the graph's own references resolve. A record WITH
// `provides` is a global override and must earn its place through the normal promotion gate (body
// matches the file, imports resolve); it is never carried in on the strength of being composed.

/**
 * The store-only LIBRARY records that must ride along so `roots`' composes graph closes in the seed.
 *
 * @param {{ roots: string[], byId: Map<string, {id: string, provides?: string, composes?: string[]}>,
 *           seeded: Set<string> }} input
 * @returns {{ carry: string[], blocked: Map<string, string>, }} `carry` in dependency order (a record
 *   always follows the ones it composes); `blocked` maps an id that could NOT be carried to the reason.
 */
export function libraryCarryClosure({ roots, byId, seeded }) {
  const carry = [];
  const blocked = new Map();
  const state = new Map(); // id -> "ok" | "blocked", memoized across roots

  /** Post-order so a carried record is always written after everything it composes. */
  const visit = (id, stack) => {
    if (seeded.has(id)) return true;
    const seen = state.get(id);
    if (seen) return seen === "ok";
    // A CYCLE is not a failure — `composes` is a knowledge graph and may loop. Treat the back-edge as
    // satisfied by the in-progress visit; the post-order push below still orders the rest.
    if (stack.has(id)) return true;

    const rec = byId.get(id);
    if (!rec) { blocked.set(id, "no record in the store"); state.set(id, "blocked"); return false; }
    if (rec.provides) {
      // An OVERRIDE. It must pass the normal gate; carrying it would ship a record that claims a
      // specifier without anything having checked it against the file it shadows.
      blocked.set(id, `claims ${rec.provides} — must be promoted, not carried`);
      state.set(id, "blocked");
      return false;
    }

    stack.add(id);
    const ok = (rec.composes ?? []).every((c) => visit(c, stack));
    stack.delete(id);
    if (!ok) { blocked.set(id, "its own composes do not close"); state.set(id, "blocked"); return false; }

    state.set(id, "ok");
    carry.push(id);
    return true;
  };

  for (const r of roots) visit(r, new Set());
  return { carry, blocked };
}
