// The settings feature's graph-platform surface (register-the-feature-logic-surface) — the modules a
// graph-loaded record imports from this feature but does NOT redraw.
//
// Registered HERE, inside the feature, because the shell must not reach a feature's internals (#1545)
// and eager-importing them from `app/` would de-lazy the whole feature at boot. The feature's BARREL
// calls this at module load, so the shadow catalogue's `ensurePlatform: () => import("@/features/settings")`
// is what registers them — the same shape `registerAutomationsPlatform` already uses.
//
// These files STAY on disk: registration is not migration. It makes a record that imports them
// loadable, which is the prerequisite for migrating the modules that import THEM.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
import * as ToolPresets from "@/features/settings/lib/toolPresets";
import * as Appearance from "@/features/settings/lib/appearance";
import * as ClaudeConfigHelpers from "@/features/settings/cards/claudeConfig.helpers";
import * as UseGithubConnect from "@/features/settings/lib/useGithubConnect";
import * as Shortcuts from "@/features/settings/lib/shortcuts";
import * as Keybindings from "@/features/settings/lib/keybindings";
import * as SessionsBehaviorSpec from "@/features/settings/cards/sessionsBehaviorSpec";

let done = false;

/** Register this feature's injected graph-platform modules by the specifiers a record imports. Idempotent. */
export function registerSettingsPlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/features/settings/lib/toolPresets", ToolPresets);
  registerAppModule("@/features/settings/lib/appearance", Appearance);
  registerAppModule("@/features/settings/cards/claudeConfig.helpers", ClaudeConfigHelpers);
  registerAppModule("@/features/settings/lib/useGithubConnect", UseGithubConnect);
  registerAppModule("@/features/settings/lib/shortcuts", Shortcuts);
  registerAppModule("@/features/settings/lib/keybindings", Keybindings);
  registerAppModule("@/features/settings/cards/sessionsBehaviorSpec", SessionsBehaviorSpec);
}
