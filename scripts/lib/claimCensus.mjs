/**
 * WHICH RECORDS CLAIM A MODULE THEY ARE NOT — the census, as pure functions.
 *
 * `provides` is a GLOBAL override resolved at RUNTIME against the STORE, consulted before the platform
 * registry. So a record that claims a specifier while disagreeing with the module behind it wins over
 * the live module for every runtime-compiled consumer. `docs/records.md` already states the rule — "if a
 * record is not the whole module, drop its `provides`" — and nothing measured it, so nothing applied it.
 *
 * # Why the classification is the deliverable, not the list
 *
 * A raw list of divergent records is unactionable, because three different things divide it and only one
 * of them should keep its claim:
 *
 *   • a PREVIEW-SHAPED DERIVATIVE — it vendors a fake, inlines SAMPLE data, or swaps a resolver so the
 *     record renders in isolation. Repairing its imports would put sample data on live screens: that
 *     nearly shipped, and is why 7 records had `provides` dropped rather than their imports fixed.
 *   • a PER-COMPONENT LIFT — one component taken out of a multi-component file. It legitimately exports
 *     only its own, so "missing exports the file has" is EXPECTED here and means nothing.
 *   • the NEWER TRUTH — the record is genuinely ahead of the file. Only this one keeps `provides`.
 *
 * # The multi-component correction
 *
 * Several records sharing one `src` is the signal that the file holds several components, so a record
 * exporting a subset is a lift, not a loss. Without it the "drops exports" count is an overcount — it was
 * measured at 33 when the item was written, and the item flagged the number as untrustworthy for exactly
 * this reason.
 */

/** A local definition whose name says it stands in for real data. */
const FAKE_NAME = /\b(?:SAMPLE|MOCK|FAKE|DEMO|STUB|FIXTURE)_[A-Z0-9_]+\b/;

/**
 * Every specifier the source imports from, as a Set.
 *
 * @param {string} src
 * @returns {Set<string>}
 */
export function importedSpecifiers(src) {
  const out = new Set();
  for (const m of String(src).matchAll(/\bfrom\s+["']([^"']+)["']/g)) out.add(m[1]);
  return out;
}

/**
 * Classify ONE divergent record.
 *
 * `sharesSrc` is how many live records point at the same `src` — the multi-component signal.
 * `fileExports`/`recordExports` may be `null`, which `exportedNames` returns for a module containing
 * `export * from`: it cannot enumerate through a star, and a confident answer derived from "I cannot
 * tell" is the worst of the three.
 *
 * The JSDoc types are load-bearing, not decoration: `scripts/**` is type-checked, and without them the
 * `= null` defaults infer as `null | undefined`, so every caller passing a real Set fails `tsc` while
 * the tests pass. Green tests and red types is a real split, and the gate is what shows it.
 *
 * @param {{ recordSrc?: string, fileSrc?: string, fileExports?: Set<string> | null,
 *           recordExports?: Set<string> | null, sharesSrc?: number }} input
 * @returns {{ kind: string, why: string, keepsProvides: boolean }}
 */
export function classify({ recordSrc = "", fileSrc = "", fileExports = null, recordExports = null, sharesSrc = 1 }) {
  const fileImports = importedSpecifiers(fileSrc);
  const recImports = importedSpecifiers(recordSrc);
  const droppedImports = [...fileImports].filter((s) => !recImports.has(s));

  // A vendored fake is the sharpest signal there is: the record names SAMPLE_/MOCK_ data the file does
  // not, or it stopped importing something and defines its own stand-in instead.
  const vendorsFake = FAKE_NAME.test(recordSrc) && !FAKE_NAME.test(fileSrc);
  if (vendorsFake) {
    return { kind: "preview-derivative", why: "defines SAMPLE/MOCK data its file does not", keepsProvides: false };
  }
  if (droppedImports.length && recordSrc.length >= fileSrc.length * 0.5) {
    return {
      kind: "preview-derivative",
      why: `stops importing ${droppedImports.slice(0, 3).join(", ")} and stands it in locally`,
      keepsProvides: false,
    };
  }

  const drops =
    fileExports && recordExports ? [...fileExports].filter((n) => !recordExports.has(n)) : null;

  // THE CORRECTION. Several records on one `src` means the file holds several components, so exporting
  // a subset is the lift working as intended rather than an export being lost.
  if (drops?.length && sharesSrc > 1) {
    return {
      kind: "per-component-lift",
      why: `${sharesSrc} records share this file; exporting only its own is expected`,
      keepsProvides: false,
    };
  }
  if (drops === null) {
    return { kind: "unknown", why: "a star export means the exports cannot be enumerated", keepsProvides: false };
  }
  if (drops.length) {
    return { kind: "drops-exports", why: `the file exports ${drops.join(", ")} and the record does not`, keepsProvides: false };
  }
  // Same exports, different body: the record is a genuine newer version of the same module.
  return { kind: "newer-truth", why: "same exports, different body", keepsProvides: true };
}

/**
 * Roll per-record verdicts up into the counts a census prints.
 *
 * @param {{ kind: string, keepsProvides: boolean }[]} verdicts
 */
export function summarize(verdicts) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const v of verdicts) counts[v.kind] = (counts[v.kind] ?? 0) + 1;
  return {
    total: verdicts.length,
    counts,
    shouldDropProvides: verdicts.filter((v) => !v.keepsProvides).length,
  };
}
