// MCP server catalog. MCP_CATALOG is the first-party MCP server catalog the MCP screen browses
// and the planner's `<mcp_assign>` path installs from (#858). The live server list, health, and
// call stats come from the store / backend at runtime — not from this file.

/** A browseable catalog entry (shared shape for MCP servers + hooks). */
export interface CatalogItem {
  name: string;
  by: string;
  icon: string;
  desc: string;
  /** External download/repo link (#858). First-party servers install from source (not npm/PyPI),
   *  so the card surfaces a GitHub link (to `main`) for download + setup. */
  link?: string;
  /** One-line setup hint shown with the download link (clone + build/run). */
  install?: string;
  /** Built-in/always-available server (#1196) — ships compiled in the app bundle (a native sidecar),
   *  so it has NO download/build step and is exposed to the planner by default. The MCP screen shows
   *  it as built-in instead of a download card. */
  builtIn?: boolean;
}

// The catalog DATA is externalized to `@data/mcp/catalog.json` (#2146, epic #2027 tail) — the single
// source, editable without touching code and part of the exportable app-config bundle; the config-dir
// copy (#2047) overlays the embedded default via `overlayFile`. This module keeps the TYPE + accessor.
//
// The first-party MCP servers (#858) install from source via the download link. Generic third-party
// servers (Sentry/Linear/Postgres/Slack/Stripe/Brave/SQLite/Notion) were pruned from the browse list
// (#870) so the catalog features our first-party servers. Their templates (lib/mcpServers.ts) stay —
// the planner's `<mcp_assign name="…" />` path still wires a working config for well-known names even
// though they're no longer browseable.
import catalogEmbedded from "@data/mcp/catalog.json";
import { overlayFile } from "@/shared/lib/core/configOverrides";

export const MCP_CATALOG: CatalogItem[] = overlayFile("mcp/catalog.json", catalogEmbedded as CatalogItem[]);
