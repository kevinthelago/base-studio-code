// Hook catalog. HOOK_CATALOG is the first-party lifecycle-hook catalog the Hooks view browses.
// The live hook list + fire stats come from the store / backend at runtime — not from this file.

import type { CatalogItem } from "./mcpCatalog";

export const HOOK_CATALOG: CatalogItem[] = [
  { name: "Block PII",   by: "first-party", icon: "⊘", desc: "Hook · PreToolUse — scans outbound tool inputs for PII patterns." },
  { name: "Auto-format", by: "first-party", icon: "§", desc: "Hook · PostToolUse — runs project formatter on every Write." },
];
