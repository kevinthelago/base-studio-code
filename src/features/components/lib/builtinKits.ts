// The packaged component kits, loaded from `src-tauri/data/components/*.json` (#2305 slice 1b) — the
// same externalized-config pattern as personas/blueprints/skills (#2027/#2185). Each file is ONE
// self-contained kit (`{ order, kit, components }`), which is deliberately the unit of distribution:
// a kit is a single portable JSON file you can drop in a GitHub gist and import by URL. The generated
// `react-ui.json` is kept in sync with the shared-UI manifest by `reactUiKit.gen.test.ts`; the
// `examples` kit is hand-authored demo data. The config-dir overlay (`overlayGlob`) lets a user drop a
// replacement/extra kit into their config dir without a rebuild.
import { overlayGlob } from "@/shared/lib/core/configOverrides";
import type { ComponentRecord, Kit } from "./model";

/** One packaged kit file under `@data/components/*.json`. */
interface KitFile {
  /** Ascending display order in the library (absent sorts as 0). Stripped on assembly. */
  order?: number;
  kit: Kit;
  components: ComponentRecord[];
}

const kitModules = import.meta.glob<{ default: KitFile }>("@data/components/*.json", { eager: true });

/** Assemble the packaged kit library from the per-kit JSON files: apply the config-dir overlay, order
 *  by `order`, and stamp `builtin` on every kit + record. */
export function makeBuiltinKits(): { kits: Kit[]; components: ComponentRecord[] } {
  const files = overlayGlob<KitFile>("components", kitModules)
    .map(([, f]) => f)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    kits: files.map((f) => ({ ...f.kit, builtin: true })),
    components: files.flatMap((f) => f.components.map((c) => ({ ...c, builtin: true }))),
  };
}
