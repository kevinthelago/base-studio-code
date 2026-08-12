// The studio-sessions feature's graph-platform surface (register-the-feature-logic-surface) — the modules a
// graph-loaded record imports from this feature but does NOT redraw.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545)
// and eager-importing them from `app/` would de-lazy the whole feature at boot. The feature's BARREL
// calls this at module load, so the shadow catalogue's `ensurePlatform: () => import("@/features/studio-sessions")`
// is what registers them — the same shape `registerAutomationsPlatform` already uses.
//
// These files STAY on disk: registration is not migration. It makes a record that imports them
// loadable, which is the prerequisite for migrating the modules that import THEM.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as UseStudioReaper from "@/features/studio-sessions/useStudioReaper";
import * as Store from "@/features/studio-sessions/store";
import * as StudioSessions from "@/features/studio-sessions/lib/studioSessions";

let done = false;

/** Register this feature's injected graph-platform modules by the specifiers a record imports. Idempotent. */
export function registerStudioSessionsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/studio-sessions/useStudioReaper", UseStudioReaper);
  registerAppModule("@/features/studio-sessions/store", Store);
  registerAppModule("@/features/studio-sessions/lib/studioSessions", StudioSessions);
}
