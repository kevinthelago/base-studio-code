// The automations feature's graph-platform surface (#3642, epic #3604) — the modules a graph-loaded
// Automations page imports but does NOT redraw: the cross-feature `HooksView` + hook-telemetry helpers
// (from the mcp barrel), and the feature's own pure scheduler/cron/format logic. Registered HERE, inside
// the feature, because the shell must not reach a feature's internals (#1545) and eager-importing them
// from `app/` would de-lazy the feature at boot. The automations host calls this synchronously before the
// graph page loads, so the modules are present when the compiled page's `require()` runs. Mirrors
// `registerFleetPlatform` (features/planner/fleet/graphPlatform.ts).
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Mcp from "@/features/mcp"; // HooksView + parseHookLog/aggregateHookTelemetry (the Hooks + Hook-Analytics tabs)
import * as Scheduler from "./lib/scheduler";
import * as Cron from "./lib/cron";
import * as Format from "./format";

let done = false;

/** Register the automations page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerAutomationsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/mcp", Mcp);
  registerAppModule("@/features/automations/lib/scheduler", Scheduler);
  registerAppModule("@/features/automations/lib/cron", Cron);
  registerAppModule("@/features/automations/format", Format);
}
