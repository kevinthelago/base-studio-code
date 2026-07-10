// The packaged component kits, loaded from `src-tauri/data/components/*.json` (#2305 slice 1b) — the
// same externalized-config pattern as personas/blueprints/skills (#2027/#2185). Each file is ONE
// self-contained kit (`{ order, kit, components }`), which is deliberately the unit of distribution:
// a kit is a single portable JSON file you can drop in a GitHub gist and import by URL. The generated
// `react-ui.json` is kept in sync with the shared-UI manifest by `reactUiKit.gen.test.ts` (the
// hand-authored `examples` demo kit was retired by #2506 — react-ui's pages tier, #2505, superseded
// it).
//
// NO config-dir overlay here (#2514, removing the #2305 `overlayGlob` hook): the packaged kit files
// are the AUTHORITATIVE seed of the hash-reconciled kit store (#2483), and a config-dir copy broke
// that contract both ways — a copy of a packaged stem silently PINNED the effective seed at the
// copy's drop-date roster (every later refresh/retire verdict became unreachable: the live #2514
// incident, where an auto-seeded `config/components/` snapshot froze the library at its first-run
// content), and a copy of a RETIRED stem would resurrect the retired kit as a ghost. Customizing a
// built-in goes through the Design Studio (the store copy wins via the user-modified hash judgment);
// adding a kit goes through the import flow (gist / share code, #2305 slice 1c).
import type { ComponentRecord, Kit } from "./model";
import { stampSeedHash } from "./seedRefresh";

/** Drop the verbatim implementation `source` (#2794) when seeding the mutable component STORE: it
 *  belongs only in the packaged/released kit ARTIFACT (the vendored-source emit path, epic #2793), so
 *  the store stays a lean contract catalog. Also keeps the #2483 `seedHash` stable — it hashes the same
 *  source-free record as before this field existed, so existing installs don't spuriously re-seed. */
function withoutSource(c: ComponentRecord): ComponentRecord {
  if (c.source === undefined) return c;
  const lean = { ...c };
  delete lean.source;
  return lean;
}

/** One packaged kit file under `@data/components/*.json`. */
interface KitFile {
  /** Ascending display order in the library (absent sorts as 0). Stripped on assembly. */
  order?: number;
  /** Global-store identity (#2465, react-ui only): the publisher-scoped id (`bsc/react-ui`) +
   *  exact version the packaged kit is registered under in the versioned `bsc ui kit` store.
   *  Ignored here (the library keys on `kit.id`); the store/pin machinery reads it. */
  id?: string;
  version?: string;
  kit: Kit;
  components: ComponentRecord[];
  /** The transitive non-component support closure (#2798) — `{ <path rel. to src/> : <source> }` the
   *  vendored-source emit (②·2, epic #2793) vendors as a `_kit/` runtime. ARTIFACT-ONLY: the seed
   *  ignores it (the store is a lean contract catalog), so it never rides into `~/.base-studio-code`. */
  runtime?: Record<string, string>;
}

const kitModules = import.meta.glob<{ default: KitFile }>("@data/components/*.json", { eager: true });

/** Assemble the packaged kit library from the per-kit JSON files (embedded only — see the module doc
 *  for why the config-dir overlay is deliberately NOT applied, #2514): order by `order`, and stamp
 *  `builtin` + `seedHash` (#2483) on every kit + record. The hash is computed HERE, at assembly time —
 *  the packaged JSON files never bake it in. */
export function makeBuiltinKits(): { kits: Kit[]; components: ComponentRecord[] } {
  const files = Object.values(kitModules)
    .map((m) => m.default)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    kits: files.map((f) => stampSeedHash({ ...f.kit, builtin: true })),
    components: files.flatMap((f) => f.components.map((c) => stampSeedHash({ ...withoutSource(c), builtin: true }))),
  };
}
