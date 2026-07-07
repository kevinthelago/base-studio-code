// The packaged component kits, loaded from `src-tauri/data/components/*.json` (#2305 slice 1b) — the
// same externalized-config pattern as personas/blueprints/skills (#2027/#2185). Each file is ONE
// self-contained kit (`{ order, kit, components }`), which is deliberately the unit of distribution:
// a kit is a single portable JSON file you can drop in a GitHub gist and import by URL. The generated
// `react-ui.json` is kept in sync with the shared-UI manifest by `reactUiKit.gen.test.ts` (the
// hand-authored `examples` demo kit was retired by #2506 — react-ui's pages tier, #2505, superseded
// it). The config-dir overlay (`overlayGlob`) lets a user drop a replacement/extra kit into their
// config dir without a rebuild.
import { overlayGlob } from "@/shared/lib/core/configOverrides";
import type { ComponentRecord, Kit } from "./model";
import { stampSeedHash } from "./seedRefresh";

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
}

const kitModules = import.meta.glob<{ default: KitFile }>("@data/components/*.json", { eager: true });

/** Assemble the packaged kit library from the per-kit JSON files: apply the config-dir overlay, order
 *  by `order`, and stamp `builtin` + `seedHash` (#2483) on every kit + record. The hash is computed
 *  HERE, at assembly time — the packaged JSON files never bake it in, so every packaged kit (and any
 *  config-dir overlay kit) gets it for free. */
export function makeBuiltinKits(): { kits: Kit[]; components: ComponentRecord[] } {
  const files = overlayGlob<KitFile>("components", kitModules)
    .map(([, f]) => f)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    kits: files.map((f) => stampSeedHash({ ...f.kit, builtin: true })),
    components: files.flatMap((f) => f.components.map((c) => stampSeedHash({ ...c, builtin: true }))),
  };
}
