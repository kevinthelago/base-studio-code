// Store↔file parity (#4246, epic #3604) — a guard on the copy that actually MOUNTS.
//
// ## The gap
// Three guards watch the graph records, and none of them looks at what renders:
//
// ```text
// graphParity.test.ts   import.meta.glob("@data/components/app/**/*.json")   -> the SEED
// GraphComponent.tsx    useAppStore((s) => s.components.find(...))?.srcText  -> the STORE
// ```
//
// Those are the same document only for a record in the reconcile path. Six page records carry no
// `builtin` — a pre-#4197 partial `bsc ui set` stripped it — so `reconcileSeed` returns early on them and
// `seedAuthoritative` (#3723), the mechanism written to stop exactly this, is never reached. Measured on
// 2026-08-02: `skillspage` renders 9137 characters fewer than its seed, `automationspage` 4591 MORE. The
// drift runs both ways, and no test compares either side against the file the page was transcribed from.
//
// ## Why this is not a vitest test
// The store is machine state (`~/.base-studio-code/components.db`), not repo state, so a repo test has
// nothing to read and CI has no store at all. A test that skipped when the store was absent would report
// green on every machine that could not check — the precise failure #4239 was about, where an undeclared
// exclusion reads as "no drift". So the check runs where the store lives: in the app, on hydrate.
//
// `storeParity.test.ts` covers what CAN be pinned without a store — that the input set is the whole
// catalogue and is non-vacuous, so this can never silently check nothing.
//
// ## Why DEV-only, and why that is not a hole
// The file half comes from a `?raw` glob, which only a development build carries — a packaged app has no
// source tree to compare against, so there is nothing to check there. Drift is INTRODUCED in development,
// which is where this runs. Same reasoning, and the same `import.meta.env.DEV` fence, as shadow mode.
//
// Cheap by construction: text in, outline out. It does NOT load feature chunks or compile anything (that
// is shadow mode's binding walk, which is why THAT one is on demand). Nothing here touches the boot path
// beyond a glob the dev bundle already carries.

import { SHADOW_PAGES, loadFileSource } from "./shadowPages";
import { outlineJsx } from "@/shared/lib/runtime/shadow/jsxOutline";
import { diffOutlines } from "@/shared/lib/runtime/shadow/outlineDiff";

/** The minimum a record needs for this comparison — deliberately structural, so the check does not depend
 *  on `ComponentRecord` and can be exercised with plain objects. */
export interface ParityRecord {
  id: string;
  srcText?: string;
}

/** One rendered module whose STORE copy does not match its file. */
export interface StoreDrift {
  pageId: string;
  recordId: string;
  file: string;
  /** Element nodes present in one copy and not the other, counted with MULTIPLICITY across both sides —
   *  so it can legitimately exceed either total. Read it against the two totals below, never alone. */
  differing: number;
  fileNodes: number;
  graphNodes: number;
}

/** Every catalogued module that HAS a file to compare against.
 *
 *  A page whose file was deleted (`file: null` — the `fleet-*` records, #3636) has no baseline and is not
 *  a gap: the record is the only copy. That is the same distinction the seed-side guard draws, kept
 *  explicit here rather than inferred from a broken path (#4239). */
export function comparableModules(): { pageId: string; recordId: string; file: string }[] {
  return SHADOW_PAGES.flatMap((page) =>
    page.modules
      .filter((m): m is { recordId: string; file: string } => m.file !== null)
      .map((m) => ({ pageId: page.pageId, recordId: m.recordId, file: m.file })),
  );
}

/**
 * Compare each rendered module's STORE copy against its file.
 *
 * A record the store does not hold is SKIPPED, not reported: it means the app is not rendering that
 * module from the graph at all (an un-hydrated store, or a record that never seeded), which is a
 * different condition from drift and would be a false alarm dressed as one. The seed-side guard and
 * `reconcileSeed`'s notices are what cover a missing record.
 *
 * @param records the store's loaded components — `useAppStore.getState().components`.
 */
export async function storeParityDrift(records: ParityRecord[]): Promise<StoreDrift[]> {
  const byId = new Map(records.map((r) => [r.id, r]));
  const out: StoreDrift[] = [];
  for (const m of comparableModules()) {
    const rec = byId.get(m.recordId);
    if (!rec?.srcText) continue; // not rendered from the graph — not this guard's business
    const file = await loadFileSource(m.file);
    if (file === null) continue; // no file half (a packaged build, or a path the catalogue test pins)
    const diff = diffOutlines(outlineJsx(file), outlineJsx(rec.srcText));
    if (diff.identical) continue;
    out.push({
      pageId: m.pageId,
      recordId: m.recordId,
      file: m.file,
      differing: diff.differing,
      fileNodes: diff.fileNodes,
      graphNodes: diff.graphNodes,
    });
  }
  return out;
}

/** One line per drifted module, for the banner and the log. Names the DIRECTION — a store copy with fewer
 *  elements than its file is missing UI, which is a different problem from one that has grown extra.
 *
 *  Both totals are printed rather than a ratio: `differing` counts nodes present in one copy and not the
 *  other WITH MULTIPLICITY, across both sides, so it can legitimately exceed either total (a restructured
 *  page reports 192 differing against a 130-node file). Rendering it as "192 of 130" read as a bug in the
 *  guard; the two totals make the same number obviously sane. */
export function explainDrift(d: StoreDrift): string {
  const dir = d.graphNodes < d.fileNodes ? "renders LESS than" : d.graphNodes > d.fileNodes ? "renders MORE than" : "differs from";
  return `${d.recordId} (${d.pageId}) ${dir} ${d.file} — ${d.differing} differing (file ${d.fileNodes} / store ${d.graphNodes})`;
}

/** Run the check against the live store, DEV only. Returns `[]` in a packaged build, where there is no
 *  source tree to compare against and therefore nothing this could truthfully say. */
export async function checkStoreParity(records: ParityRecord[]): Promise<StoreDrift[]> {
  if (!import.meta.env.DEV) return [];
  return storeParityDrift(records);
}
