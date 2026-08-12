// The teams feature's graph-platform surface (register-the-feature-logic-surface) — the modules a
// graph-loaded record imports from this feature but does NOT redraw.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545)
// and eager-importing them from `app/` would de-lazy the whole feature at boot. The feature's BARREL
// calls this at module load, so the shadow catalogue's `ensurePlatform: () => import("@/features/teams")`
// is what registers them — the same shape `registerAutomationsPlatform` already uses.
//
// These files STAY on disk: registration is not migration. It makes a record that imports them
// loadable, which is the prerequisite for migrating the modules that import THEM.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as Team from "@/features/teams/lib/team";
import * as OrgLayout from "@/features/teams/lib/orgLayout";
import * as OrgView from "@/features/teams/lib/orgView";
import * as OrgPools from "@/features/teams/lib/orgPools";
import * as TeamsLayout from "@/features/teams/lib/teamsLayout";

let done = false;

/** Register this feature's injected graph-platform modules by the specifiers a record imports. Idempotent. */
export function registerTeamsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/teams/lib/team", Team);
  registerAppModule("@/features/teams/lib/orgLayout", OrgLayout);
  registerAppModule("@/features/teams/lib/orgView", OrgView);
  registerAppModule("@/features/teams/lib/orgPools", OrgPools);
  registerAppModule("@/features/teams/lib/teamsLayout", TeamsLayout);
}
