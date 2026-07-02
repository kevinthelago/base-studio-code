// Hook catalog. HOOK_CATALOG is the first-party lifecycle-hook catalog the Hooks view browses.
// The live hook list + fire stats come from the store / backend at runtime — not from this file.

import type { CatalogItem } from "./mcpCatalog";
import hookCatalogEmbedded from "@data/mcp/hooks.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

// The catalog DATA is externalized to `@data/mcp/hooks.json` (#2146, epic #2027 tail) — editable
// without touching code + part of the exportable config bundle; the config-dir copy (#2047) overlays
// the embedded default via `overlayFile`.
export const HOOK_CATALOG: CatalogItem[] = overlayFile("mcp/hooks.json", hookCatalogEmbedded as CatalogItem[]);
