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
// ── Projects page (#3874) — the leaves it composes but does not redraw. ──────────────────────────────
import * as InlineError from "@/shared/ui/feedback/InlineError";
import * as DialogMod from "@/shared/ui/overlay/Dialog";
import * as SafeInvoke from "@/shared/lib/core/safeInvoke";
// #4224 — the four the Planning session reaches that no earlier graph page did: the completion probe,
// the LLM config, the GitHub project sync, and the terminal constants the session's pane shares with
// the console. Feature-agnostic (or app-owned), so the shell's platform set.
import * as ClaudeComplete from "@/shared/lib/core/claudeComplete";
import * as LlmConfig from "@/shared/lib/core/llmConfig";
import * as ProjectSync from "@/shared/lib/github/projectSync";
import * as TerminalConstants from "@/app/console/lib/terminalConstants";
import * as GithubProbe from "@/shared/lib/github/githubProbe";
import * as GithubState from "@/shared/lib/github/githubState";
import * as StatTile from "@/shared/ui/data/StatTile";
import * as Pane from "@/shared/ui/overlay/Pane";
// ── Project pane (#3901) — the shared primitives its components compose. ─────────────────────────────
import * as BackButton from "@/shared/ui/controls/BackButton";
import * as ModalCard from "@/shared/ui/overlay/ModalCard";
// ── The tabbed-workspace shell a page composes (#3642): Screen + the page-tab + draft hooks ───────────
import * as Screen from "@/shared/ui/layouts/Screen";
import * as UsePageTabs from "@/shared/hooks/usePageTabs";
import * as UseDraft from "@/shared/hooks/useDraft";
import * as LogsBridge from "@/shared/lib/core/logsBridge";
// ── Live data + hooks the FleetPage panels read (feature-agnostic → stay injected permanently) ────────
import * as FleetData from "@/shared/data/fleet";
import * as UsePoll from "@/shared/hooks/usePoll";
// #4185 — the feature-agnostic surface the graph-loaded Glance cockpit reaches: the crumb hook, the
// perf marker, the session-log tail, the preview source resolver, the claude-running guard, and the demo
// snapshot. None of these are glance's own, so they belong to the shell's platform set, not a feature's.
import * as UseCrumbEntity from "@/shared/hooks/useCrumbEntity";
import * as Perf from "@/shared/lib/core/perf";
import * as SessionLog from "@/shared/lib/logs/sessionLog";
import * as PreviewSource from "@/shared/lib/preview/previewSource";
import * as EnsureClaudeRunning from "@/shared/lib/session/ensureClaudeRunning";
import * as DemoSnapshot from "@/store/demoSnapshot";
import * as UsePaneTokenUsage from "@/app/console/lib/usePaneTokenUsage";
import * as Bsc from "@/shared/lib/core/bsc";
import * as ProjectPaths from "@/shared/lib/core/projectPaths";
import * as UseCoordLog from "@/shared/lib/fleet/useCoordLog";
// #4186 — the four the Console page reaches that no earlier graph page did: the launch gate and its hook,
// the worker-audit reader behind the pane states, and the CI watcher. Feature-agnostic, so the shell's set.
import * as LaunchGate from "@/shared/lib/fleet/launchGate";
import * as UseFleetGate from "@/shared/lib/fleet/useFleetGate";
import * as WorkerAudit from "@/shared/lib/fleet/workerAudit";
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
// #4219 — the two the Algorithms workspace reaches that no earlier graph page did: the folder row its
// rail draws with, and the dock-entrance hook. Feature-agnostic, so the shell's platform set.
import * as RailFolderRow from "@/shared/ui/layouts/RailFolderRow";
import * as UseDockEntrance from "@/shared/hooks/useDockEntrance";
import * as GraphRail from "@/shared/ui/layouts/GraphRail";
// #4185 — the three the Glance cockpit reaches that no earlier graph page did: the canvas it draws the
// project network on, the icon button its dock and inspector use, and the tab strip. Feature-agnostic, so
// they belong to the shell's platform set.
import * as TabBar from "@/shared/ui/layouts/TabBar";
import * as IconButton from "@/shared/ui/controls/IconButton";
import * as PreviewReview from "@/shared/lib/preview/previewReview";
import * as GraphCanvas from "@/shared/ui/layouts/GraphCanvas";
// The six modules the packaged PAGE records honestly import and the registry did not expose, so the
// write gate refused those records outright ("resolving to no registered platform module and no
// @/components/<id> sibling"). Each is a real, correctly-cased file; they were simply never registered.
import * as PaneGrid from "@/shared/ui/layouts/PaneGrid";
import * as GraphLegend from "@/shared/ui/layouts/GraphLegend";
import * as SplitView from "@/shared/ui/layouts/SplitView";
import * as Sequence from "@/shared/ui/layouts/Sequence";
import * as PagesPageHeader from "@/shared/ui/pages/pageHeader";
// Through the feature BARREL (#1545): `app/` may not reach a feature's internals. The registry KEY
// below stays the deep specifier, because that is the string the `accessibilitypage` record imports.
import * as SettingsPageHeader from "@/features/settings";
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
import * as LucideReact from "lucide-react";                       // icons: createLucideIcon (#3686)
// #4230 — the three shared modules the planner's stage bodies reach that no earlier graph page did:
// the expand/collapse hook the MCP, Features and Scan bodies share, the inline code block, and the
// self-wired kit renderer the Transformations body embeds. Feature-agnostic, so the shell's set.
import * as UseExpandable from "@/shared/hooks/useExpandable";
import * as CodeMod from "@/shared/ui/data/Code";
import * as SharedUiSpec from "@/shared/ui/spec";
// #4232 — the kit barrel `ProjectSetupPage` composes the packaged UI kit from.
import * as SharedUiKit from "@/shared/ui/kit";
// #4235 - reconciling the drifted shared/ui records pulled in what the FILES had grown and the records
// had not: `a11y` is #3775's `clickable()` keyboard-operability helper (Card, CardListRow, DataTableRow,
// Toggle), and `Screen` gained a `PageBoundary` + its `pageNav` keyboard paging.
import * as SharedUiA11y from "@/shared/ui/a11y";
import * as PageBoundary from "@/shared/ui/layouts/PageBoundary";
import * as PageNav from "@/shared/ui/layouts/pageNav";
// #4238 — `PageBoundary` is a record now, and it logs what it catches.
import * as CoreLog from "@/shared/lib/core/log";
// #4224 — zustand's shallow comparator, which the Planning session selects with. A BARE specifier, and the
// loader requires those registered exactly like a first-party one. `platformBoundary` used to skip bare
// specifiers as "the import-map's concern"; the browser check caught this because the loader does not.
import * as ZustandShallow from "zustand/react/shallow";
// ── The LOGIC SURFACE a record imports (register-the-shell-logic-surface) ─────────────────────────
// These modules STAY on disk — registration is not migration. A graph record that imports one of them
// resolves it here instead of failing to load, which is the prerequisite for migrating the modules that
// import THEM: five modules measured against the un-registered surface dragged in 251 unresolved
// specifiers, so module-by-module migration is impossible until this resolves.
// Shell scope only — @/shared/**, @/app/** and feature BARRELS. A feature's INTERNALS cannot be
// registered from here (#1545); each feature registers its own in its graphPlatform.ts.
import * as Achievements from "@/shared/lib/core/achievements";
import * as AchievementChime from "@/shared/lib/core/achievementChime";
import * as LocationCrumb from "@/app/chrome/locationCrumb";
import * as UseAppRepoRoot from "@/shared/hooks/useAppRepoRoot";
import * as UseHotkeys from "@/app/useHotkeys";
import * as UseNavigateBridge from "@/app/useNavigateBridge";
import * as UseFleetWakeBridge from "@/app/useFleetWakeBridge";
import * as UseDebugChannel from "@/app/useDebugChannel";
import * as UseDockBack from "@/app/useDockBack";
import * as Automations from "@/features/automations";
import * as Tunnel from "@/features/tunnel";
import * as UseCoordAnnouncer from "@/app/a11y/useCoordAnnouncer";
import * as UseCoordSpeaker from "@/app/a11y/useCoordSpeaker";
import * as UseWarden from "@/shared/lib/fleet/useWarden";
import * as UseWorkerAutoEnd from "@/shared/lib/fleet/useWorkerAutoEnd";
import * as Sounds from "@/features/sounds";
import * as UseAppBoot from "@/app/useAppBoot";
import * as UseNavHistory from "@/shared/hooks/useNavHistory";
import * as Registry from "@/app/registry";
import * as StreamCompletion from "@/shared/lib/fleet/streamCompletion";
import * as SessionRecovery from "@/app/console/lib/sessionRecovery";
import * as PaneInject from "@/shared/lib/fleet/paneInject";
import * as UseSandboxReadiness from "@/shared/hooks/useSandboxReadiness";
import * as DockBack from "@/shared/lib/core/dockBack";
import * as DetachWindow from "@/app/console/lib/detachWindow";
import * as Diagnostics from "@/shared/lib/core/diagnostics";
import * as GraphPlatform from "@/app/console/graphPlatform";
import * as TerminalClipboard from "@/shared/lib/session/terminalClipboard";
import * as Terminal from "@/app/console/lib/terminal";
import * as TerminalKeys from "@/app/console/lib/terminalKeys";
import * as TerminalNudge from "@/app/console/lib/terminalNudge";
import * as JumbleProbe from "@/app/console/lib/jumbleProbe";
import * as Checkpoint from "@/shared/lib/session/checkpoint";
import * as PendingPtyData from "@/app/console/lib/pendingPtyData";
import * as SessionLaunch from "@/app/console/lib/sessionLaunch";
import * as UseTerminalSession from "@/app/console/useTerminalSession";
import * as RepoCredentials from "@/shared/lib/github/repoCredentials";
import * as PaneActivity from "@/app/console/lib/paneActivity";
import * as TerminalAdmission from "@/app/console/lib/terminalAdmission";
import * as SystemSessions from "@/shared/lib/session/systemSessions";
import * as StartupTrace from "@/shared/lib/core/startupTrace";
import * as ConfigOverrides from "@/shared/lib/core/configOverrides";
import * as PoolPlan from "@/shared/lib/session/poolPlan";
import * as RequestSpawn from "@/shared/lib/session/requestSpawn";
import * as ComponentBundle from "@/shared/lib/preview/componentBundle";
import * as CollectAppCss from "@/shared/lib/preview/collectAppCss";
import * as UseGraphPage from "@/shared/ui/layouts/useGraphPage";
import * as SelectionNeighborhood from "@/shared/lib/graph/selectionNeighborhood";
import * as CrossGraph from "@/shared/lib/graph/crossGraph";
import * as NodeUrn from "@/shared/lib/graph/nodeUrn";
import * as Types from "@/shared/lib/github/types";
import * as SessionRoles from "@/shared/lib/session/sessionRoles";
import * as Algorithms from "@/features/algorithms";
import * as FleetLive from "@/shared/lib/fleet/fleetLive";
import * as ProjectV2 from "@/shared/lib/github/projectV2";
import * as UseGithubQuery from "@/shared/lib/github/useGithubQuery";
import * as RoleProfile from "@/shared/lib/session/roleProfile";
import * as AppStateGist from "@/store/appStateGist";
import * as IdleReaper from "@/app/console/lib/idleReaper";
import * as ShellConfig from "@/shared/lib/core/shellConfig";
import * as Studio from "@/features/studio";
import * as Speech from "@/shared/lib/a11y/speech";
import * as ComponentLoader from "@/shared/lib/runtime/componentLoader";
import * as GraphResolver from "@/shared/lib/runtime/graphResolver";
import * as RenderGate from "@/shared/lib/runtime/renderGate";
// The loader HOST, and the one runtime module that was left unregistered while its three siblings above
// were not. That gap had consequences: `resolveGraphSource` checks records BEFORE the registry, so with
// nothing registered the `graphcomponent` RECORD was the only thing serving the specifier — and every
// graph consumer that imports it (`AlgorithmsGraphHost`, `SoundsGraphHost`, and through them the whole
// Projects page) got that record vendored into its closure, where it failed to compile and took the page
// down with it.
//
// It must be ONE instance, which is the deeper reason: `GraphComponent` owns the loader's caches —
// `compiles`, `compileCounts`, and the `lastGood` map it imports. A second copy is a second set of those,
// so a page mounted through the record would compile against a different in-flight map and a different
// last-good memory than the app's own. That is the stateful-record-shadows-a-live-module hazard
// `bsc ui set` refuses at write time now; registering it here is the other half.
import * as GraphComponentHost from "@/shared/lib/runtime/GraphComponent";
import * as Announcer from "@/shared/lib/a11y/announcer";
import * as Theme from "@/shared/ui/kit/theme";
import * as Resolve from "@/shared/ui/kit/resolve";
import * as UseSelection from "@/shared/ui/pages/useSelection";
import * as NetworkLayout from "@/shared/ui/pages/networkLayout";
import * as Manifest from "@/shared/ui/manifest";
import * as GeneralNode from "@/shared/ui/spec/generalNode";
import * as SpecWalk from "@/shared/ui/spec/specWalk";
// `record-link-debt` — five of the six specifiers that were registered NOWHERE, so any record importing
// one threw the loader's named error the moment something mounted it. Each of these five ALSO exists as a
// record (`keyvaluelist`, `labelchip`, `sessionfailure`, `sessionreadinessbanner`), and the tempting fix
// was to give those records a `provides` field instead. That is a TRAP: `resolveGraphSource` matches
// `provides` GLOBALLY, so the record would override the bundled module for EVERY graph consumer — and all
// four are drifted from their files. Registering the FILE resolves to the newer copy; the `provides` flip
// (and the file's deletion) is `record-src-reconcile`'s move, once the fold has made the record newer.
import * as KeyValueList from "@/shared/ui/data/KeyValueList"; // collection/pipeline/record/table/treeexplorer pages
import * as LabelChip from "@/shared/ui/data/LabelChip";       // issuecard, detailpanel
import * as SessionFailure from "@/app/SessionFailure";        // terminalbanners
import * as SessionReadinessBanner from "@/app/SessionReadinessBanner"; // terminalbanners
import * as TauriApp from "@tauri-apps/api/app"; // statusbar reads the app version — bare, like @tauri-apps/api/core
// The event API, sibling of core/app above. THIRTEEN records reach for `listen` — every log/coord/PTY
// stream in the app is a Tauri event subscription — and each was unpromotable purely because the
// specifier had no registration, not because anything about the module was unfit.
import * as TauriEvent from "@tauri-apps/api/event";
// The two window APIs a record reaches for (`register-the-third-party-packages`): `DetachedTabStrip`
// needs `window`, `detachSection` needs `webviewWindow`. Cheap to register eagerly — they are thin
// wrappers over the same IPC `core` already registered above, not a new dependency for the bundle.
import * as TauriWindow from "@tauri-apps/api/window";
import * as TauriWebviewWindow from "@tauri-apps/api/webviewWindow";
import * as UseGraphViewport from "@/shared/ui/layouts/useGraphViewport"; // GraphCanvas/Tree (#3692)
import * as RenderProfiler from "@/shared/lib/core/renderProfiler";       // GraphCanvas (#3692)
import * as TreeLayout from "@/shared/ui/layouts/treeLayout";             // Tree (#3692)
import * as EdgePath from "@/shared/lib/graph/edgePath";                  // Tree (#3692)
import { registerAppModule } from "@/shared/lib/runtime/moduleRegistry";
// ── Reached only THROUGH a migrated logic module (retire-the-first-19-logic-modules) ─────────────
// A module that becomes an algorithm record stops being resolved by Vite and starts being resolved by
// the LOADER, so its own imports become the graph's problem. None of these were registered before,
// because no record imported them DIRECTLY — each arrives transitively with the hook that was retired.
import * as FleetGithub from "@/shared/lib/github/fleetGithub";
import * as TurnHooks from "@/shared/lib/session/turnHooks";
import * as FleetRoster from "@/shared/lib/fleet/fleetRoster";
import * as UseScreenSession from "@/shared/lib/session/useScreenSession";
import * as Mock from "@/shared/data/mock";
// The remaining leaves records import that nothing answered (`register-the-remaining-unresolvable`).
// The four `store/types` modules are TYPE-ONLY and compile to empty JS — but `store/types.ts` re-exports
// them with `export *`, which is a VALUE re-export and does emit a require, so the runtime genuinely
// needs them present. Registering an empty module costs nothing. The other three are already in the
// shell's eager graph.
import * as StoreTypes from "@/store/types";
import * as StoreTypesConsole from "@/store/types/console";
import * as StoreTypesGithub from "@/store/types/github";
import * as StoreTypesPerf from "@/store/types/perf";
// The other three `store/types` leaves, for the same reason: `store/types.ts` re-exports each with
// `export *`, a VALUE re-export that emits a require even though the modules compile to empty JS.
import * as StoreTypesShell from "@/store/types/shell";
import * as StoreTypesProjects from "@/store/types/projects";
import * as StoreTypesPlan from "@/store/types/plan";
import * as StoreTypesSession from "@/store/types/session";
// The kit page `shared/ui/registry` composes. Small and already in the shared surface.
import * as NetworkPage from "@/shared/ui/pages/NetworkPage";
import * as KitRenderer from "@/shared/ui/spec/KitRenderer";
import * as GraphPrimitive from "@/shared/ui/spec/graphPrimitive";
import * as GraphModules from "@/shared/lib/runtime/graphModules";
// The six shared/store leaves a record can import but nothing answered
// (`the-records-floor-is-a-chore-list-not-a-wall`). Registering is what lets a RECORD depend on a module
// that stays a FILE, and these are the safe ones to add: every one is already in the shell's eager graph
// (the store is registered whole two lines below; `attest` is the records runtime itself), so none of
// them de-lazies a feature the way `TerminalHost` (xterm) or `DetachedWindow` (a second window root)
// would. Those belong in the console feature's own graph-platform, not here.
import * as Attest from "@/shared/lib/runtime/attest";
import * as UiRegistry from "@/shared/ui/registry";
import * as StoreHelpers from "@/store/helpers";
import * as StorePlanSlice from "@/store/slices/plan";
import * as DetachSection from "@/shared/lib/core/detachSection";
import * as FaultTriage from "@/shared/lib/fleet/faultTriage";

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
  // #3874 — Projects.
  "@/shared/ui/feedback/InlineError": InlineError,
  "@/shared/ui/overlay/Dialog": DialogMod,
  "@/shared/lib/core/safeInvoke": SafeInvoke,
  "@/shared/lib/core/claudeComplete": ClaudeComplete,
  "@/shared/lib/core/llmConfig": LlmConfig,
  "@/shared/lib/github/projectSync": ProjectSync,
  "@/app/console/lib/terminalConstants": TerminalConstants,
  "@/shared/lib/github/githubProbe": GithubProbe,
  "@/shared/lib/github/githubState": GithubState,
  "@/shared/ui/data/StatTile": StatTile,
  "@/shared/ui/overlay/Pane": Pane,
  // #3901 — the project pane's remaining shared leaves (BackButton on the stage footer, ModalCard for
  // the MCP download modal). The other 13 specifiers it needs were already registered.
  "@/shared/ui/controls/BackButton": BackButton,
  "@/shared/ui/overlay/ModalCard": ModalCard,
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
  "@/shared/ui/layouts/RailFolderRow": RailFolderRow,
  "@/shared/hooks/useDockEntrance": UseDockEntrance,
  "@/shared/ui/layouts/GraphRail": GraphRail,
  "@/shared/ui/layouts/TabBar": TabBar,
  "@/shared/ui/controls/IconButton": IconButton,
  "@/shared/lib/preview/previewReview": PreviewReview,
  "@/shared/ui/layouts/GraphCanvas": GraphCanvas,
  "@/shared/ui/layouts/PaneGrid": PaneGrid,
  "@/shared/ui/layouts/GraphLegend": GraphLegend,
  "@/shared/ui/layouts/SplitView": SplitView,
  "@/shared/ui/layouts/Sequence": Sequence,
  // LOWERCASE `pageHeader` — that is the tracked filename. Six page records import it as `PageHeader`,
  // which resolves on NTFS and nowhere else; those records are corrected rather than this key bent to
  // match them. It is the same wrong-case path that made `graph-delete-retired-shared-page-files` a
  // phantom item, where `git ls-files` shows no `PageHeader.tsx` was ever tracked.
  "@/shared/ui/pages/pageHeader": PagesPageHeader,
  // The barrel under its OWN key as well. It is the same module object, already imported eagerly one
  // screen up, so this costs nothing — but without it `@/features/settings` is unregistered, and
  // `useAppBoot` and `useHotkeys` (which import the barrel) read as unresolvable. Registering a module
  // under one of its re-export paths does not answer the path importers actually write.
  "@/features/settings": SettingsPageHeader,
  "@/features/settings/pages/SettingsPageHeader": SettingsPageHeader,
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
  "lucide-react": LucideReact,
  "@/shared/hooks/useExpandable": UseExpandable,
  "@/shared/ui/data/Code": CodeMod,
  "@/shared/ui/spec": SharedUiSpec,
  "@/shared/ui/kit": SharedUiKit,
  "@/shared/ui/a11y": SharedUiA11y,
  "@/shared/ui/layouts/PageBoundary": PageBoundary,
  "@/shared/ui/layouts/pageNav": PageNav,
  "@/shared/lib/core/log": CoreLog,
  "zustand/react/shallow": ZustandShallow,
  "@/shared/ui/layouts/useGraphViewport": UseGraphViewport,
  "@/shared/lib/core/renderProfiler": RenderProfiler,
  "@/shared/ui/layouts/treeLayout": TreeLayout,
  "@/shared/lib/graph/edgePath": EdgePath,
  "@/shared/lib/core/logsBridge": LogsBridge,
  "@/shared/data/fleet": FleetData,
  "@/shared/hooks/usePoll": UsePoll,
  "@/shared/hooks/useCrumbEntity": UseCrumbEntity,
  "@/shared/lib/core/perf": Perf,
  "@/shared/lib/logs/sessionLog": SessionLog,
  "@/shared/lib/preview/previewSource": PreviewSource,
  "@/shared/lib/session/ensureClaudeRunning": EnsureClaudeRunning,
  "@/store/demoSnapshot": DemoSnapshot,
  "@/app/console/lib/usePaneTokenUsage": UsePaneTokenUsage,
  "@/shared/lib/core/bsc": Bsc,
  "@/shared/lib/core/projectPaths": ProjectPaths,
  "@/shared/lib/fleet/useCoordLog": UseCoordLog,
  "@/shared/lib/fleet/launchGate": LaunchGate,
  "@/shared/lib/fleet/useFleetGate": UseFleetGate,
  "@/shared/lib/fleet/workerAudit": WorkerAudit,
  "@/shared/lib/fleet/coordinationWakes": CoordinationWakes,
  // `record-link-debt` — see the import block above for why these register the file rather than
  // `provides`-ing the record of the same name.
  "@/shared/ui/data/KeyValueList": KeyValueList,
  "@/shared/ui/data/LabelChip": LabelChip,
  "@/app/SessionFailure": SessionFailure,
  "@/app/SessionReadinessBanner": SessionReadinessBanner,
  "@tauri-apps/api/app": TauriApp,
  "@tauri-apps/api/event": TauriEvent,
  "@tauri-apps/api/window": TauriWindow,
  "@tauri-apps/api/webviewWindow": TauriWebviewWindow,
// ── The LOGIC SURFACE a record imports (register-the-shell-logic-surface) ─────────────────────────
// These modules STAY on disk — registration is not migration. A graph record that imports one of them
// resolves it here instead of failing to load, which is the prerequisite for migrating the modules that
// import THEM: five modules measured against the un-registered surface dragged in 251 unresolved
// specifiers, so module-by-module migration is impossible until this resolves.
// Shell scope only — @/shared/**, @/app/** and feature BARRELS. A feature's INTERNALS cannot be
// registered from here (#1545); each feature registers its own in its graphPlatform.ts.
  "@/shared/lib/core/achievements": Achievements,
  "@/shared/lib/core/achievementChime": AchievementChime,
  "@/app/chrome/locationCrumb": LocationCrumb,
  "@/shared/hooks/useAppRepoRoot": UseAppRepoRoot,
  "@/app/useHotkeys": UseHotkeys,
  "@/app/useNavigateBridge": UseNavigateBridge,
  "@/app/useFleetWakeBridge": UseFleetWakeBridge,
  "@/app/useDebugChannel": UseDebugChannel,
  "@/app/useDockBack": UseDockBack,
  "@/features/automations": Automations,
  "@/features/tunnel": Tunnel,
  "@/app/a11y/useCoordAnnouncer": UseCoordAnnouncer,
  "@/app/a11y/useCoordSpeaker": UseCoordSpeaker,
  "@/shared/lib/fleet/useWarden": UseWarden,
  "@/shared/lib/fleet/useWorkerAutoEnd": UseWorkerAutoEnd,
  "@/features/sounds": Sounds,
  "@/app/useAppBoot": UseAppBoot,
  "@/shared/hooks/useNavHistory": UseNavHistory,
  "@/app/registry": Registry,
  "@/shared/lib/fleet/streamCompletion": StreamCompletion,
  "@/app/console/lib/sessionRecovery": SessionRecovery,
  "@/shared/lib/fleet/paneInject": PaneInject,
  "@/shared/hooks/useSandboxReadiness": UseSandboxReadiness,
  "@/shared/lib/core/dockBack": DockBack,
  "@/app/console/lib/detachWindow": DetachWindow,
  "@/shared/lib/core/diagnostics": Diagnostics,
  "@/app/console/graphPlatform": GraphPlatform,
  "@/shared/lib/session/terminalClipboard": TerminalClipboard,
  "@/app/console/lib/terminal": Terminal,
  "@/app/console/lib/terminalKeys": TerminalKeys,
  "@/app/console/lib/terminalNudge": TerminalNudge,
  "@/app/console/lib/jumbleProbe": JumbleProbe,
  "@/shared/lib/session/checkpoint": Checkpoint,
  "@/app/console/lib/pendingPtyData": PendingPtyData,
  "@/app/console/lib/sessionLaunch": SessionLaunch,
  "@/app/console/useTerminalSession": UseTerminalSession,
  "@/shared/lib/github/repoCredentials": RepoCredentials,
  "@/app/console/lib/paneActivity": PaneActivity,
  "@/app/console/lib/terminalAdmission": TerminalAdmission,
  "@/shared/lib/session/systemSessions": SystemSessions,
  "@/shared/lib/core/startupTrace": StartupTrace,
  "@/shared/lib/core/configOverrides": ConfigOverrides,
  "@/shared/lib/session/poolPlan": PoolPlan,
  "@/shared/lib/session/requestSpawn": RequestSpawn,
  "@/shared/lib/preview/componentBundle": ComponentBundle,
  "@/shared/lib/preview/collectAppCss": CollectAppCss,
  "@/shared/ui/layouts/useGraphPage": UseGraphPage,
  "@/shared/lib/graph/selectionNeighborhood": SelectionNeighborhood,
  "@/shared/lib/graph/crossGraph": CrossGraph,
  "@/shared/lib/graph/nodeUrn": NodeUrn,
  "@/shared/lib/github/types": Types,
  "@/shared/lib/session/sessionRoles": SessionRoles,
  "@/features/algorithms": Algorithms,
  "@/shared/lib/fleet/fleetLive": FleetLive,
  "@/shared/lib/github/projectV2": ProjectV2,
  "@/shared/lib/github/useGithubQuery": UseGithubQuery,
  "@/shared/lib/session/roleProfile": RoleProfile,
  "@/store/appStateGist": AppStateGist,
  "@/app/console/lib/idleReaper": IdleReaper,
  "@/shared/lib/core/shellConfig": ShellConfig,
  "@/features/studio": Studio,
  "@/shared/lib/a11y/speech": Speech,
  "@/shared/lib/runtime/componentLoader": ComponentLoader,
  "@/shared/lib/runtime/graphResolver": GraphResolver,
  "@/shared/lib/runtime/renderGate": RenderGate,
  "@/shared/lib/runtime/GraphComponent": GraphComponentHost,
  "@/shared/lib/a11y/announcer": Announcer,
  "@/shared/ui/kit/theme": Theme,
  "@/shared/ui/kit/resolve": Resolve,
  "@/shared/ui/pages/useSelection": UseSelection,
  "@/shared/ui/pages/networkLayout": NetworkLayout,
  "@/shared/ui/manifest": Manifest,
  "@/shared/ui/spec/generalNode": GeneralNode,
  "@/shared/ui/spec/specWalk": SpecWalk,
// ── Reached only THROUGH a migrated logic module (retire-the-first-19-logic-modules) ─────────────
// A module that becomes an algorithm record stops being resolved by Vite and starts being resolved by
// the LOADER, so its own imports become the graph's problem. None of these were registered before,
// because no record imported them DIRECTLY — each arrives transitively with the hook that was retired.
  "@/shared/lib/github/fleetGithub": FleetGithub,
  "@/shared/lib/session/turnHooks": TurnHooks,
  "@/shared/lib/fleet/fleetRoster": FleetRoster,
  "@/shared/lib/session/useScreenSession": UseScreenSession,
  "@/shared/data/mock": Mock,
  "@/store/types": StoreTypes,
  "@/store/types/console": StoreTypesConsole,
  "@/store/types/github": StoreTypesGithub,
  "@/store/types/perf": StoreTypesPerf,
  "@/store/types/shell": StoreTypesShell,
  "@/store/types/projects": StoreTypesProjects,
  "@/store/types/plan": StoreTypesPlan,
  "@/store/types/session": StoreTypesSession,
  "@/shared/ui/pages/NetworkPage": NetworkPage,
  "@/shared/ui/spec/KitRenderer": KitRenderer,
  "@/shared/ui/spec/graphPrimitive": GraphPrimitive,
  "@/shared/lib/runtime/graphModules": GraphModules,
  "@/shared/lib/runtime/attest": Attest,
  "@/shared/ui/registry": UiRegistry,
  "@/store/helpers": StoreHelpers,
  "@/store/slices/plan": StorePlanSlice,
  "@/shared/lib/core/detachSection": DetachSection,
  "@/shared/lib/fleet/faultTriage": FaultTriage,
};

/** Every packaged `@data/**` JSON, keyed by the specifier a module imports it as.
 *
 *  A record is compiled by the runtime loader, which resolves each import against the platform registry
 *  and the record store — and until now EVERY registry entry was a MODULE, so a JSON specifier resolved
 *  to nothing. `docs/records.md` listed "import `@data/*.json`" among the things a record may not do; it
 *  was never a limitation, just an absent registration. 35 modules import one, and for each of them that
 *  import is the only thing standing between the file and a record.
 *
 *  GLOBBED, NOT LISTED. A hand-written list of the 44 specifiers in use would be a second
 *  hand-maintained map beside `PLATFORM`, and the next person to add a data file would get a runtime
 *  failure with no gate to catch it. The glob cannot drift.
 *
 *  ⚠️ NO `import: "default"`. The registry stores module NAMESPACES — every entry above comes from
 *  `import * as X` — and the loader reads `.default` off one to satisfy `import x from "…"`. Unwrapping
 *  here would register the parsed value itself, so a default import would resolve to `undefined.default`.
 *
 *  Bundle cost is ~nil rather than ~11 MB, which is why a blanket glob is affordable: the 388 seed
 *  records (2.8 MB) are ALREADY eagerly globbed by `features/designs/lib/seed.ts`, and the two large
 *  files — `react-ui.json` (5.2 MB) and `algorithms.json` (2.6 MB) — are already imported by the modules
 *  registered above. This adds edges to modules the bundle already contains, not new payload. */
const DATA_JSON = import.meta.glob<unknown>("@data/**/*.json", { eager: true });

/** `/src-tauri/data/ui/themes.json` → `@data/ui/themes.json` — the form an importer actually writes. */
const DATA_PREFIX = "/src-tauri/data/";
export function dataSpecifierFor(globKey: string): string | null {
  const at = globKey.indexOf(DATA_PREFIX);
  return at === -1 ? null : `@data/${globKey.slice(at + DATA_PREFIX.length)}`;
}

let done = false;

/** Register every platform module by its import specifier. Idempotent — safe to call at each boot / HMR. */
export function registerPlatformModules(): void {
  if (done) return;
  done = true;
  for (const [specifier, mod] of Object.entries(PLATFORM)) registerAppModule(specifier, mod);
  for (const [key, mod] of Object.entries(DATA_JSON)) {
    const specifier = dataSpecifierFor(key);
    if (specifier) registerAppModule(specifier, mod);
  }
}
