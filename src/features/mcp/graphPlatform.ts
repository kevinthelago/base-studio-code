// The mcp feature's graph-platform surface (#3656, epic #3604) — the feature-internal modules a graph-loaded
// MCP page imports but does NOT redraw: the install/version/catalog/telemetry logic, the `./shared` grab-bag
// (the useGhProjects hook + the drawer/row/card helpers), and the install-status hook. Registered HERE,
// inside the feature, because the shell must not reach a feature's internals (#1545). The mcp host calls this
// synchronously before the graph page loads. Mirrors the fleet/automations/security/github/skills platforms.
// (`@/features/mcp` — the barrel with HooksView/telemetry — is registered by the AUTOMATIONS platform; these
// are the mcp INTERNALS, a disjoint set of specifiers.)
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as McpInstall from "./lib/mcpInstall";
import * as McpServers from "./lib/mcpServers";
import * as Hooks from "./lib/hooks";
import * as McpTelemetry from "./lib/mcpTelemetry";
import * as Shared from "./shared";
import * as GraphPlatform from "@/features/mcp/graphPlatform";
import * as SessionConfig from "@/features/mcp/lib/sessionConfig";
import * as HookTelemetry from "@/features/mcp/lib/hookTelemetry";
import * as MigrateExtensions from "@/features/mcp/lib/migrateExtensions";
// ── Reached only THROUGH a migrated logic module (retire-the-first-19-logic-modules) ─────────────
// A module that becomes an algorithm record stops being resolved by Vite and starts being resolved by
// the LOADER, so its own imports become the graph's problem. None of these were registered before,
// because no record imported them DIRECTLY — each arrives transitively with the hook that was retired.
import * as McpVersioning from "@/features/mcp/lib/mcpVersioning";

let done = false;

/** Register the mcp page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerMcpPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/mcp/lib/mcpInstall", McpInstall);
  registerAppModule("@/features/mcp/lib/mcpServers", McpServers);
  registerAppModule("@/features/mcp/lib/hooks", Hooks);
  registerAppModule("@/features/mcp/lib/mcpTelemetry", McpTelemetry);
  registerAppModule("@/features/mcp/shared", Shared);
  registerAppModule("@/features/mcp/graphPlatform", GraphPlatform);
  registerAppModule("@/features/mcp/lib/sessionConfig", SessionConfig);
  registerAppModule("@/features/mcp/lib/hookTelemetry", HookTelemetry);
  registerAppModule("@/features/mcp/lib/migrateExtensions", MigrateExtensions);
  registerAppModule("@/features/mcp/lib/mcpVersioning", McpVersioning);
}
