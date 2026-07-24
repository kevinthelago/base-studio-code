// The platform module registration (#3605/#3606, epic #3604) — the shell's list of the app's OWN modules
// that graph-loaded code may import, wired to the LIVE instances. This is the platform ↔ graph boundary:
// everything registered here stays real code (React, the store, the shared/ui design system, and the few
// behavioural leaves a migrated page composes but does NOT redraw); everything else the graph provides.
//
// Lives in `app/` because only the shell knows the whole module set, and it must register the SAME
// React/store instances the running app uses — a second copy would break hooks. Registered LAZILY (after
// `primeConfigOverrides`, see main.tsx): these imports pull in `@data`-backed modules, so evaluating them
// before the config prime would freeze the wrong config into their eager consts.
//
// The FLEET-specific data/hooks/logic (below) are injected for #3606 (a UI-only slice); #3607 relocates the
// logic into the algorithms graph, at which point those specifiers drop out of this list.
import * as React from "react";
import * as JsxRuntime from "react/jsx-runtime";
import * as Store from "@/store";
// ── The design system: the platform UI vocabulary a graph page composes ──────────────────────────────
import * as ColorSwatch from "@/shared/ui/controls/ColorSwatch";
import * as Button from "@/shared/ui/controls/Button";
import * as Charts from "@/shared/ui/charts";
import * as Stack from "@/shared/ui/layout/Stack";
import * as Row from "@/shared/ui/layout/Row";
import * as GridMod from "@/shared/ui/layout/Grid";
import * as BoxMod from "@/shared/ui/layout/Box";
import * as TextMod from "@/shared/ui/typography/Text";
import * as Card from "@/shared/ui/data/Card";
import * as Chip from "@/shared/ui/data/Chip";
import * as Skeleton from "@/shared/ui/feedback/Skeleton";
import * as CardStates from "@/shared/ui/feedback/CardStates";
import * as EmptyStateMod from "@/shared/ui/feedback/EmptyState";
import * as Field from "@/shared/ui/controls/Field";
import * as SegmentedControl from "@/shared/ui/controls/SegmentedControl";
import * as StatTile from "@/shared/ui/data/StatTile";
import * as Pane from "@/shared/ui/overlay/Pane";
// ── The tabbed-workspace shell a page composes (#3642): Screen + the page-tab + draft hooks ───────────
import * as Screen from "@/shared/ui/layouts/Screen";
import * as UsePageTabs from "@/shared/hooks/usePageTabs";
import * as UseDraft from "@/shared/hooks/useDraft";
import * as LogsBridge from "@/shared/lib/core/logsBridge";
// ── Live data + hooks the FleetPage panels read (feature-agnostic → stay injected permanently) ────────
import * as FleetData from "@/shared/data/fleet";
import * as UseFleetLive from "@/shared/hooks/useFleetLive";
import * as UsePoll from "@/shared/hooks/usePoll";
import * as UsePaneTokenUsage from "@/app/console/lib/usePaneTokenUsage";
import * as Bsc from "@/shared/lib/core/bsc";
import * as ProjectPaths from "@/shared/lib/core/projectPaths";
import * as UseCoordLog from "@/shared/lib/fleet/useCoordLog";
import * as CoordinationWakes from "@/shared/lib/fleet/coordinationWakes";
// ── Additional shared UI + libs a migrated page composes (#3646, Security onward) ─────────────────────
import * as StatusDot from "@/shared/ui/feedback/StatusDot";
import * as CardListRow from "@/shared/ui/data/CardListRow";
import * as IconBox from "@/shared/ui/data/IconBox";
import * as Banner from "@/shared/ui/feedback/Banner";
import * as SectionHeader from "@/shared/ui/layout/SectionHeader";
import * as Spacer from "@/shared/ui/layout/Spacer";
import * as PromptDialog from "@/shared/ui/overlay/promptDialog";
import * as Format from "@/shared/lib/core/format";
import * as Coordination from "@/shared/lib/fleet/coordination";
import * as CoordinatorActuate from "@/shared/lib/fleet/coordinatorActuate";
// ── Additional shared UI + libs a migrated page composes (#3650, GitHub onward) ───────────────────────
import * as ActivityFeed from "@/shared/ui/data/ActivityFeed";
import * as Avatar from "@/shared/ui/data/Avatar";
import * as FillBar from "@/shared/ui/data/FillBar";
import * as SectionLabel from "@/shared/ui/layout/SectionLabel";
import * as MasterDetail from "@/shared/ui/layouts/MasterDetail";
import * as RepoPulse from "@/shared/data/repoPulse";
import * as RepoPulseLive from "@/shared/lib/github/repoPulseLive";
import * as GithubLib from "@/shared/lib/github/github";
import * as MathLib from "@/shared/lib/core/math";
import * as Opener from "@tauri-apps/plugin-opener"; // a graph page may open an external URL
// ── Additional shared UI + hooks a migrated page composes (#3654, Skills onward) ──────────────────────
import * as Toggle from "@/shared/ui/controls/Toggle";
import * as SearchField from "@/shared/ui/controls/SearchField";
import * as Checkbox from "@/shared/ui/controls/Checkbox";
import * as DataTableRow from "@/shared/ui/data/DataTableRow";
import * as ModalScrim from "@/shared/ui/overlay/ModalScrim";
import * as RailSection from "@/shared/ui/layouts/RailSection";
import * as RailRow from "@/shared/ui/layouts/RailRow";
import * as GraphRail from "@/shared/ui/layouts/GraphRail";
import * as UseRailSections from "@/shared/hooks/useRailSections";
import * as UseDragResize from "@/shared/hooks/useDragResize";
import * as SkillsData from "@/shared/data/skills";
import * as TauriCore from "@tauri-apps/api/core"; // a graph page may `invoke` a Tauri command
// ── Catalog data a migrated page composes (#3656, MCP onward) ─────────────────────────────────────────
import * as McpCatalog from "@/shared/data/mcpCatalog";
import * as HookCatalog from "@/shared/data/hookCatalog";
// ── Small leaf deps a graph-loaded shared/ui primitive needs (#3674, shared/ui-as-data batch 3) ────────
import * as TypographyType from "@/shared/ui/typography/type"; // Text: fontSize/toneColor
import * as Shimmer from "@/shared/ui/feedback/shimmer";       // Skeleton: the shimmer style const
import * as GithubColors from "@/shared/lib/github/colors";    // Avatar: avatarColor/palette
import * as LayoutSpace from "@/shared/ui/layout/space";       // Box/Stack/Row/Grid/Spacer: space/pad/flexStyle (#3680)
import * as UseModalDismiss from "@/shared/hooks/useModalDismiss"; // ModalScrim/TabBar (#3684)
import * as UseClickOutside from "@/shared/hooks/useClickOutside"; // TabBar (#3684)
import * as ReactDOM from "react-dom";                             // TabBar: createPortal (#3684)
import * as Eyebrow from "@/shared/ui/typography/Eyebrow";         // SessionDock (#3684)
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";

// The FLEET-specific injected leaves (WorkerDetail) + logic (useFleetGithub / fleetCost) are NOT registered
// here — the shell must not reach a feature's internals (#1545), and eager-importing them would de-lazy the
// whole planner at boot. The fleet feature registers its OWN graph-platform surface (`registerFleetPlatform`,
// features/planner/fleet/graphPlatform.ts), called by the fleet host that renders the graph page.

/** specifier → the app's live module. A graph component's `import … from "<specifier>"` resolves here. */
const PLATFORM: Record<string, unknown> = {
  // React — the app's ONE instance, so a loaded component's hooks share the app's dispatcher.
  react: React,
  "react/jsx-runtime": JsxRuntime, // esbuild `jsx: "automatic"` emits this
  "@/store": Store, // the live app state — a loaded page reads/subscribes to the REAL store, not a stub
  "@/shared/ui/controls/ColorSwatch": ColorSwatch,
  "@/shared/ui/controls/Button": Button,
  "@/shared/ui/charts": Charts,
  "@/shared/ui/layout/Stack": Stack,
  "@/shared/ui/layout/Row": Row,
  "@/shared/ui/layout/Grid": GridMod,
  "@/shared/ui/layout/Box": BoxMod,
  "@/shared/ui/typography/Text": TextMod,
  "@/shared/ui/data/Card": Card,
  "@/shared/ui/data/Chip": Chip,
  "@/shared/ui/feedback/Skeleton": Skeleton,
  "@/shared/ui/feedback/CardStates": CardStates,
  "@/shared/ui/feedback/EmptyState": EmptyStateMod,
  "@/shared/ui/controls/Field": Field,
  "@/shared/ui/controls/SegmentedControl": SegmentedControl,
  "@/shared/ui/data/StatTile": StatTile,
  "@/shared/ui/overlay/Pane": Pane,
  // The tabbed-workspace shell + its hooks a migrated page composes (#3642, Automations onward).
  "@/shared/ui/layouts/Screen": Screen,
  "@/shared/hooks/usePageTabs": UsePageTabs,
  "@/shared/hooks/useDraft": UseDraft,
  // Shared UI + libs the Security page composes (#3646, Security onward).
  "@/shared/ui/feedback/StatusDot": StatusDot,
  "@/shared/ui/data/CardListRow": CardListRow,
  "@/shared/ui/data/IconBox": IconBox,
  "@/shared/ui/feedback/Banner": Banner,
  "@/shared/ui/layout/SectionHeader": SectionHeader,
  "@/shared/ui/layout/Spacer": Spacer,
  "@/shared/ui/overlay/promptDialog": PromptDialog,
  "@/shared/lib/core/format": Format,
  "@/shared/lib/fleet/coordination": Coordination,
  "@/shared/lib/fleet/coordinatorActuate": CoordinatorActuate,
  // Shared UI + libs the GitHub page composes (#3650, GitHub onward).
  "@/shared/ui/data/ActivityFeed": ActivityFeed,
  "@/shared/ui/data/Avatar": Avatar,
  "@/shared/ui/data/FillBar": FillBar,
  "@/shared/ui/layout/SectionLabel": SectionLabel,
  "@/shared/ui/layouts/MasterDetail": MasterDetail,
  "@/shared/data/repoPulse": RepoPulse,
  "@/shared/lib/github/repoPulseLive": RepoPulseLive,
  "@/shared/lib/github/github": GithubLib,
  "@/shared/lib/core/math": MathLib,
  "@tauri-apps/plugin-opener": Opener,
  // Shared UI + hooks the Skills page composes (#3654, Skills onward).
  "@/shared/ui/controls/Toggle": Toggle,
  "@/shared/ui/controls/SearchField": SearchField,
  "@/shared/ui/controls/Checkbox": Checkbox,
  "@/shared/ui/data/DataTableRow": DataTableRow,
  "@/shared/ui/overlay/ModalScrim": ModalScrim,
  "@/shared/ui/layouts/RailSection": RailSection,
  "@/shared/ui/layouts/RailRow": RailRow,
  "@/shared/ui/layouts/GraphRail": GraphRail,
  "@/shared/hooks/useRailSections": UseRailSections,
  "@/shared/hooks/useDragResize": UseDragResize,
  "@/shared/data/skills": SkillsData,
  "@tauri-apps/api/core": TauriCore,
  // Catalog data the MCP page composes (#3656, MCP onward).
  "@/shared/data/mcpCatalog": McpCatalog,
  "@/shared/data/hookCatalog": HookCatalog,
  // Small leaf deps a graph-loaded shared/ui primitive imports (#3674, batch 3).
  "@/shared/ui/typography/type": TypographyType,
  "@/shared/ui/feedback/shimmer": Shimmer,
  "@/shared/lib/github/colors": GithubColors,
  "@/shared/ui/layout/space": LayoutSpace,
  "@/shared/hooks/useModalDismiss": UseModalDismiss,
  "@/shared/hooks/useClickOutside": UseClickOutside,
  "react-dom": ReactDOM,
  "@/shared/ui/typography/Eyebrow": Eyebrow,
  "@/shared/lib/core/logsBridge": LogsBridge,
  "@/shared/data/fleet": FleetData,
  "@/shared/hooks/useFleetLive": UseFleetLive,
  "@/shared/hooks/usePoll": UsePoll,
  "@/app/console/lib/usePaneTokenUsage": UsePaneTokenUsage,
  "@/shared/lib/core/bsc": Bsc,
  "@/shared/lib/core/projectPaths": ProjectPaths,
  "@/shared/lib/fleet/useCoordLog": UseCoordLog,
  "@/shared/lib/fleet/coordinationWakes": CoordinationWakes,
};

let done = false;

/** Register every platform module by its import specifier. Idempotent — safe to call at each boot / HMR. */
export function registerPlatformModules(): void {
  if (done) return;
  done = true;
  for (const [specifier, mod] of Object.entries(PLATFORM)) registerAppModule(specifier, mod);
}
