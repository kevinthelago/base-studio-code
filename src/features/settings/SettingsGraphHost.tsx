// The Settings page host (#3658, epic #3604) — renders the Settings workspace FROM THE GRAPH. The workspace
// (nav + section detail) + its 7 section pages (General/Planner/Skills/Automations/MCP/GitHub/Security) are
// sourced from the components graph (the authored `settingspage` node + siblings, seeded from
// `data/components/app/**`), not bundled files. It registers the settings feature's injected platform surface
// (the 37 setting cards + the two page helpers + the cross-feature TunnelSettings), then mounts `settingspage`
// through the runtime loader. Mirrors the other feature graph-hosts. (Settings has no tear-off, so no
// `pageOverride`.)
import { GraphComponent } from "@/shared/lib/runtime/GraphComponent";
import { GraphPageFallback } from "@/shared/lib/runtime/GraphPageFallback";
import { registerSettingsPlatform } from "./graphPlatform";

// Register at module load — before the workspace ever renders — so the injected modules are in the registry
// when the graph page's compiled `require()` runs. Idempotent.
registerSettingsPlatform();

export function SettingsGraphHost() {
  // Fallback offers Reload-to-apply / Re-seed (#3648/#3652) when the source isn't in the library yet.
  return <GraphComponent id="settingspage" fallback={<GraphPageFallback page="Settings" icon="⚙" />} />;
}
