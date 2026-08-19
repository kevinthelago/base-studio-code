// The logs feature's graph-platform surface (#3646, epic #3604) — the modules a graph-loaded Logs page
// imports but does NOT redraw: the pure audit-row derivation plus the two capability/console modules the
// derivation reads. Registered HERE, inside the feature, because the shell must not reach a feature's
// internals (#1545) and eager-importing them from `app/` would de-lazy the feature at boot. The logs host
// calls this synchronously before the graph page loads, so the modules are present when the compiled
// page's `require()` runs. Mirrors registerFleetPlatform / registerAutomationsPlatform.
//
// `agentProfiles` and `consoleModel` now live in `shared/lib/security` rather than in a feature: they are
// read by the console shell, the planner, the tunnel projector AND the store, so a feature was never the
// right owner. The registrar still names them because the graph page's audit derivation imports them —
// registering a shared module is fine; IMPORTING another feature's internals is what the boundary forbids.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as AgentProfiles from "@/shared/lib/security/agentProfiles";
import * as ConsoleModel from "@/shared/lib/security/consoleModel";
import * as AuditRows from "@/features/logs/lib/auditRows";
import * as GraphPlatform from "@/features/logs/graphPlatform";

let done = false;

/** Register the Logs page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerLogsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/shared/lib/security/agentProfiles", AgentProfiles);
  registerAppModule("@/shared/lib/security/consoleModel", ConsoleModel);
  registerAppModule("@/features/logs/lib/auditRows", AuditRows);
  registerAppModule("@/features/logs/graphPlatform", GraphPlatform);
}
