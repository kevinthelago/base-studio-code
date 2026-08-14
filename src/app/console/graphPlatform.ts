// The console's graph-platform surface (#4186, epic #3604) — the shell-owned modules a graph-loaded
// Console imports but does NOT redraw.
//
// Unlike every other graph-platform this one lives in `app/`, not a feature: the console pane system IS the
// shell (#1309), so there is no feature barrel to hang the registration on. That also means there is no
// #1545 boundary to route around — the shell may import anything — and the split is drawn on behaviour
// instead: what MOVES to the graph is the layout (the tab strip, the pane grid, the pane chrome); what
// stays here is everything that does something.
//
// THE PANE VIEWS STAY CODE, deliberately. `FilesView` / `ChangesView` / `BranchesView` / `LogView` /
// `TelemetryView` / `ToolsView` are the surfaces that talk to git, the filesystem and the log engine, and
// `TerminalSlot` is how a pane claims its live xterm from the app-level `TerminalHost` (#2378). A page that
// re-compiles must be able to re-render a SLOT without disturbing the terminal behind it — which is exactly
// why the terminals were moved out of the page in the first place.
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
// — the pane system's pure helpers + hooks —
import * as ConsoleFocus from "@/app/console/lib/consoleFocus";
import * as ModelDisplay from "./lib/modelDisplay";
import * as Models from "./lib/models";
import * as PaneIdentity from "./lib/paneIdentity";
import * as PaneStatus from "./lib/paneStatus";
import * as Providers from "./lib/providers";
import * as UseIdleReaper from "@/app/console/lib/useIdleReaper";
import * as UsePaneActivityFeed from "./lib/usePaneActivityFeed";
import * as UsePaneTokenUsage from "@/app/console/lib/usePaneTokenUsage";
import * as MenuPlacement from "./panes/menuPlacement";
import * as ViewDefs from "./panes/viewDefs";
// — the pane VIEWS: the behaviour a pane cell hosts —
import * as TerminalSlot from "./terminal/TerminalSlot";
// — the pumps the page mounts —
import * as UseCoordinator from "./useCoordinator";
import * as UseDirectorPump from "@/app/console/useDirectorPump";
import * as UseFaultTriage from "@/app/console/useFaultTriage";
import * as UseKitDispatch from "@/app/console/useKitDispatch";
import * as UseStudioNetworkPump from "@/app/console/useStudioNetworkPump";
// The one cross-feature surface the console page composes — the cockpit's public API. The shell may
// reach a feature BARREL (#1545 restricts internals), and this coupling already exists in the live file.
import * as Glance from "@/features/glance";
// The console-lib helpers a migrated `useHotkeys` record imports (register-the-console-lib-remainder).
// Registered from the CONSOLE platform, not the shell: app/console owns them.
import * as Broadcast from "@/app/console/lib/broadcast";
import * as ClearInput from "@/app/console/lib/clearInput";
import * as PaneSelect from "@/app/console/lib/paneSelect";

let done = false;

/** Register the console page's injected graph-platform modules by the specifiers it imports. Idempotent. */
export function registerConsolePlatform(): void {
  if (done) return;
  done = true;
  registerAppModule("@/app/console/lib/consoleFocus", ConsoleFocus);
  registerAppModule("@/app/console/lib/modelDisplay", ModelDisplay);
  registerAppModule("@/app/console/lib/models", Models);
  registerAppModule("@/app/console/lib/paneIdentity", PaneIdentity);
  registerAppModule("@/app/console/lib/paneStatus", PaneStatus);
  registerAppModule("@/app/console/lib/providers", Providers);
  registerAppModule("@/app/console/lib/useIdleReaper", UseIdleReaper);
  registerAppModule("@/app/console/lib/usePaneActivityFeed", UsePaneActivityFeed);
  registerAppModule("@/app/console/lib/usePaneTokenUsage", UsePaneTokenUsage);
  registerAppModule("@/app/console/panes/menuPlacement", MenuPlacement);
  registerAppModule("@/app/console/panes/viewDefs", ViewDefs);
  registerAppModule("@/app/console/terminal/TerminalSlot", TerminalSlot);
  registerAppModule("@/app/console/useCoordinator", UseCoordinator);
  registerAppModule("@/app/console/useDirectorPump", UseDirectorPump);
  registerAppModule("@/app/console/useFaultTriage", UseFaultTriage);
  registerAppModule("@/app/console/useKitDispatch", UseKitDispatch);
  registerAppModule("@/app/console/useStudioNetworkPump", UseStudioNetworkPump);
  registerAppModule("@/features/glance", Glance);
  registerAppModule("@/app/console/lib/broadcast", Broadcast);
  registerAppModule("@/app/console/lib/clearInput", ClearInput);
  registerAppModule("@/app/console/lib/paneSelect", PaneSelect);
}
