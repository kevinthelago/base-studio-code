// The security feature's graph-platform surface (#3646, epic #3604) — the feature-internal modules a
// graph-loaded Security page imports but does NOT redraw: the pure permission-profile / console / audit /
// flow domain logic. Registered HERE, inside the feature, because the shell must not reach a feature's
// internals (#1545) and eager-importing them from `app/` would de-lazy the feature at boot. The security
// host calls this synchronously before the graph page loads, so the modules are present when the compiled
// page's `require()` runs. Mirrors registerFleetPlatform / registerAutomationsPlatform.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as AgentProfiles from "./lib/agentProfiles";
import * as ConsoleModel from "./lib/consoleModel";
import * as AuditRows from "./lib/auditRows";
import * as BadgeTone from "./lib/badgeTone";
import * as AppSession from "./lib/appSession";
import * as FlowModel from "./lib/flowModel";

let done = false;

/** Register the security page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerSecurityPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/security/lib/agentProfiles", AgentProfiles);
  registerAppModule("@/features/security/lib/consoleModel", ConsoleModel);
  registerAppModule("@/features/security/lib/auditRows", AuditRows);
  registerAppModule("@/features/security/lib/badgeTone", BadgeTone);
  registerAppModule("@/features/security/lib/appSession", AppSession);
  registerAppModule("@/features/security/lib/flowModel", FlowModel);
}
