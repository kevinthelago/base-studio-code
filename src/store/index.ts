import { create } from "zustand";
import { bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { persist, createJSONStorage } from "zustand/middleware";
import { persistStorage } from "@/shared/lib/core/storage";
import { grandfatherTriaged, grandfatherLocalPublished } from "./triagedMigration";
import { safeInvoke } from "@/shared/lib/core/safeInvoke";
import {       deriveTabIdentity } from "@/shared/lib/core/projectPaths";
import {  refreshBuiltIns, type Blueprint } from "@/features/planner/stages/blueprints";
import { reconcileBuiltInProfiles } from "@/features/security/lib/agentProfiles";
import { migrateLegacyExtensions } from "@/features/mcp/lib/migrateExtensions";
import { createMcpSlice } from "@/features/mcp/store";
import { createPersonasSlice } from "@/features/personas/store";
import { reconcilePersonas } from "@/features/personas/lib/persona";
import { createOrgSlice } from "@/features/teams/store";
import { createComponentsSlice } from "@/features/designs/store";
import { reconcileOrgs } from "@/features/teams/lib/team";
import { refreshPackagedSkills } from "@/features/skills/lib/skills";
import { createSkillsSlice } from "@/features/skills/store";

import { type AppStore } from "./types";
import { createSessionSlice } from "./slices/session";
import { createPlanSlice } from "./slices/plan";
import { createProjectsSlice } from "./slices/projects";
import { createAutomationsSlice } from "@/features/automations/store";
import { createCoreSlice } from "./slices/core";
import { createLlmSettingsSlice } from "./slices/llmSettings";
import { createGithubSlice } from "@/features/github/store";
import { createShellSlice } from "./slices/shell";
import { createTunnelSlice } from "@/features/tunnel/store";
import { createConsoleSlice } from "./slices/console";

// Re-export the public store API so existing `from "@/store"` imports keep resolving.
export { PROJECT_INIT_PROMPT, TRIAGE_PROMPT, buildTriagePrompt } from "./constants";
export type { GithubUser, PerfConfig, LogConfig, ToolPermissions, ConfigProfile, AutomationSuggestion, GithubRepo } from "./types";

import { newTabId } from "./helpers";

export const useAppStore = create<AppStore>()(
  persist(
    (set, get, store) => ({
      ...createConsoleSlice(set, get, store),
      ...createGithubSlice(set, get, store),
      ...createShellSlice(set, get, store),
      ...createTunnelSlice(set, get, store),

      ...createCoreSlice(set, get, store),
      ...createLlmSettingsSlice(set, get, store),
      ...createAutomationsSlice(set, get, store),
      ...createProjectsSlice(set, get, store),

      ...createPlanSlice(set, get, store),
      ...createSessionSlice(set, get, store),
      ...createSkillsSlice(set, get, store),
      ...createMcpSlice(set, get, store),
      ...createPersonasSlice(set, get, store),
      ...createOrgSlice(set, get, store),
      ...createComponentsSlice(set, get, store),
    }),
    {
      name: "app-state",
      storage: createJSONStorage(() => persistStorage),
      version: 1,
      // #2548: one-time grandfather. The Glance triaged filter (#2541) is forward-looking, so on an
      // upgrade from persist v0 an existing user's already-worked projects (published + fleeted) carry
      // no `triagedProjects` marker and vanish from Glance. Backfill it once from the persisted board +
      // fleets. A fresh install starts at v1 with no persisted state, so this never runs for it and the
      // strict rule holds (a new draft/published project stays hidden until it's actually triaged).
      migrate: (persisted, version) => {
        const s = (persisted ?? {}) as Partial<AppStore> & {
          githubState?: { records?: { title?: string }[] };
          planFleet?: Record<string, { streams?: unknown[] } | undefined>;
          triagedProjects?: Record<string, number>;
        };
        if (version < 1 && Object.keys(s.triagedProjects ?? {}).length === 0) {
          s.triagedProjects = grandfatherTriaged(s.githubState?.records, s.planFleet, Date.now());
        }
        return s as AppStore;
      },
      // Exclude transient UI-only state from the persisted snapshot.
      partialize: (s) => ({
        activeWorkspace:    s.activeWorkspace,
        tabs:            s.tabs,
        activeTabIdx:    s.activeTabIdx,
        terminalFontSize: s.terminalFontSize,
        accent:          s.accent,
        kitTheme:        s.kitTheme,
        designContributions: s.designContributions, // #2656: downloaded-blueprint design overlays survive restart
        keybindings:     s.keybindings,
        paneViews:       s.paneViews,
        paneNames:       s.paneNames,
        paneCwds:        s.paneCwds,
        paneWslDistro:   s.paneWslDistro,
        paneWasClaude:   s.paneWasClaude,
        paneDirectorDrive: s.paneDirectorDrive,
        paneDirectorMode: s.paneDirectorMode,
        paneStream: s.paneStream,
        disabledPanes:   s.disabledPanes,
        endedPanes:      s.endedPanes,   // #920: a finished worker's resting state survives restart
        githubConnected: s.githubConnected,
        githubToken:     s.githubToken,
        githubState:     s.githubState,   // #2446: last-known GitHub board state (stale overlay after restart)
        repoGithubTokens: s.repoGithubTokens,
        githubUser:      s.githubUser,
        githubRepos:     s.githubRepos,
        activeRepoName:  s.activeRepoName,
        automationsTab:  s.automationsTab,
        pageTabOrder:    s.pageTabOrder,
        activePageTab:   s.activePageTab,
        settingsSection: s.settingsSection,
        sandboxNudgeDismissCount: s.sandboxNudgeDismissCount,
        perfConfig:      s.perfConfig,
        logConfig:       s.logConfig,
        idleReaper:      s.idleReaper,
        tunnelRelayUrl:  s.tunnelRelayUrl,
        agentProfiles:   s.agentProfiles,
        paneProfiles:    s.paneProfiles,
        paneRoleGlobs:   s.paneRoleGlobs,
        paneRepos:       s.paneRepos,
        paneFlows:       s.paneFlows,
        claudeApiKey:    s.claudeApiKey,
        llmProvider:     s.llmProvider,
        llmModel:        s.llmModel,
        openaiKey:       s.openaiKey,
        geminiKey:       s.geminiKey,
        localBaseUrl:    s.localBaseUrl,
        schedules:            s.schedules,
        commands:             s.commands,
        automations:          s.automations,
        deniedCommands:       s.deniedCommands,
        autoFocusMode:        s.autoFocusMode,
        autoAdvanceOnReply:   s.autoAdvanceOnReply,
        autoResumeClaude:     s.autoResumeClaude,
        injectionHardGate:    s.injectionHardGate,
        bypassPermissions:    s.bypassPermissions,
        sandboxConsoles:      s.sandboxConsoles,
        showConsolePage:      s.showConsolePage,
        autoPlanWithClaude:   s.autoPlanWithClaude,
        autoCompleteGates:    s.autoCompleteGates,
        allowGateOverride:    s.allowGateOverride,
        restrictToBscIssues:  s.restrictToBscIssues,
        coordAutoWake:        s.coordAutoWake,
        defaultModel:         s.defaultModel,
        fleetHarness:         s.fleetHarness,
        paneModels:           s.paneModels,
        focusTarget:          s.focusTarget,
        fleetPaneStreams:     s.fleetPaneStreams,
        projectLocalRepos:    s.projectLocalRepos,
        localDraftProjects:   s.localDraftProjects,
        triagedProjects:      s.triagedProjects,  // #2541: drafted→triaged marker; gates the Glance network
        projectLinks:         s.projectLinks,   // #2253: user-drawn Glance project relationships
        autoTriage:           s.autoTriage,   // #2265: per-project fault auto-triage toggle
        autoKitDispatch:      s.autoKitDispatch, // #2277: per-project kit auto-dispatch toggle
        autoApplyKitChanges:  s.autoApplyKitChanges, // #2944: global kit-change auto-apply toggle (Planner settings)
        issueLinks:           s.issueLinks,
        achievements:         s.achievements,
        hiddenProjectIds:     s.hiddenProjectIds,
        defaultStartupPromptDoc: s.defaultStartupPromptDoc,
        projectStartupPromptDoc: s.projectStartupPromptDoc,
        repoStartupPromptDoc:    s.repoStartupPromptDoc,
        repoTriagePromptDoc:     s.repoTriagePromptDoc,
        configProfiles:       s.configProfiles,
        planStages:          s.planStages,
        planConfirmedStages: s.planConfirmedStages,
        planAuthoredBlueprint: s.planAuthoredBlueprint,
        planDeployConfig:      s.planDeployConfig,
        planMarketConfig:      s.planMarketConfig, // #2430: the market-stage assessment
        planTransformations:   s.planTransformations, // #2509: the transformations confirm queue
        reposPublic:           s.reposPublic,   // #1227: repo visibility (default + …)
        repoPublic:            s.repoPublic,    //        per-repo overrides) survives restart
        planSkippedStages:   s.planSkippedStages,
        planAutomations:       s.planAutomations,
        planStageConfig:       s.planStageConfig,
        projectBlueprintId:    s.projectBlueprintId,
        uiScreens:             s.uiScreens,
        uiApproved:            s.uiApproved,
        blueprints:            s.blueprints,
        activeBlueprintId:     s.activeBlueprintId,
        dataModels:            s.dataModels,
        activeDataModelId:     s.activeDataModelId,
        loadVerified:          s.loadVerified,
        planFleet:             s.planFleet,
        planFleetTopology:     s.planFleetTopology,
        planFleetDirectorDrive: s.planFleetDirectorDrive,
        pinnedContext:         s.pinnedContext,
        mcpServers:            s.mcpServers,
        hooks:                 s.hooks,
        skills:                s.skills,
        // Per-session skill choices keyed by stable identity (#1056) — persist so a
        // worker/triage session keeps its assigned skills across a restart.
        sessionSkillOverrides: s.sessionSkillOverrides,
        // Task groups + per-session group toggles (#skills-groups) — reusable skill bundles.
        skillGroups:           s.skillGroups,
        sessionSkillGroups:    s.sessionSkillGroups,
        personas:              s.personas,   // #2094: the agent-identity library (built-ins reconciled on load)
        teams:                 s.teams,      // #2193/#2700: the persona-relationship graph (team) library (reconciled on load)
        demoActive:            s.demoActive, // #2272: a loaded demo state + its pre-demo backup survive restart
        demoBackup:            s.demoBackup,
        teamsZoom:             s.teamsZoom,  // #2199/#2700: per-team canvas zoom (view state)
        components:            s.components, // #2269: the proven-component library (seed until the bsc store lands)
        kits:                  s.kits,       // #2269: the component kits (technology-scoped namespaces)
        kitUsage:              s.kitUsage,   // #2277: the consumer index (project→kit) — a fast-first-paint cache
        kitDispatches:         s.kitDispatches, // #2277: the pending fan-out queue — durable so the drain delivers it after a restart
      }),
      // Storage is async (Tauri plugin-store), so hydration finishes AFTER the
      // first render. Flip hasHydrated here so the shell can hold its first paint
      // until the persisted state is in — otherwise screens flash from defaults
      // (e.g. GitHub "not connected" → connected) on every load.
      onRehydrateStorage: () => (state) => {
        // Back-fill stable identity onto tabs persisted before these fields existed.
        // #463: a stable `id` (detached set / re-dock / order key off it). #457: the
        // project-tab identity (projectKey/kind/seq), derived once from the frozen name
        // so the next fleet/triage launch can find-and-reuse the tab instead of forking
        // a duplicate. Both are one-time legacy upgrades and no-ops thereafter.
        if (state?.tabs) {
          state.tabs = state.tabs.map((t) => {
            let next = t.id ? t : { ...t, id: newTabId() };
            if (!next.projectKey && !next.kind) {
              const ident = deriveTabIdentity(next.name);
              if (ident) next = { ...next, ...ident };
            }
            return next;
          });
        }
        // Migrate the legacy unified `extensions` list → split `mcpServers` / `hooks` slices and
        // the renamed MCP route key (#mcp-hooks-split). One-time; no-op once migrated.
        migrateLegacyExtensions(state);
        // The Blueprints page-mode was folded into the Planner tab's blueprint rail (#blueprints);
        // a user whose last mode was it would otherwise land on a blank canvas.
        if (state && (state.projectsPageMode as string) === "blueprints") state.projectsPageMode = "projects";
        // Personas was folded into the Teams page (#2199) — a last-mode of "personas" now opens Teams.
        if (state && (state.projectsPageMode as string) === "personas") state.projectsPageMode = "teams";
        // The Teams page-mode id was renamed "org" → "teams" (#2700) — map a last-mode of "org" forward.
        if (state && (state.projectsPageMode as string) === "org") state.projectsPageMode = "teams";
        // The Fleet page-mode was folded into Glance (#2223/#2228) — a last-mode of "fleet" opens Projects.
        if (state && (state.projectsPageMode as string) === "fleet") state.projectsPageMode = "projects";
        // Design Studio moved from its own rail Workspace to a Planner tab (#move-to-planner). A user whose
        // last workspace was "design" would otherwise land on a removed screen — redirect to Planner on its
        // Designs page.
        if (state && (state.activeWorkspace as string) === "design") {
          state.activeWorkspace = "projects";
          state.projectsPageMode = "designs";
        }
        // The Designs page-mode key was renamed "design" → "designs" (#2701, feature-folder rename to
        // match the on-screen "Designs" tab). A user whose last page-mode was "design" now opens "designs".
        if (state && (state.projectsPageMode as string) === "design") state.projectsPageMode = "designs";
        // The standalone Themes page-mode was retired (#2850) — theme viewing folded into the Components
        // tab's theme try-on preview (right-pane themes menu + palette + big preview). A last-mode of
        // "themes" now opens Components (Designs).
        if (state && (state.projectsPageMode as string) === "themes") state.projectsPageMode = "designs";
        // Algorithms moved from its own rail Workspace to a Planner tab (#2785). A user whose last
        // workspace was "algorithms" would otherwise land on a removed screen — redirect to Planner on
        // its Algorithms page.
        if (state && (state.activeWorkspace as string) === "algorithms") {
          state.activeWorkspace = "projects";
          state.projectsPageMode = "algorithms";
        }
        // The Security workspace's key was renamed "agents" → "security" (#2702, naming realignment).
        // A user whose last workspace was "agents" would otherwise land on a removed key.
        if (state && (state.activeWorkspace as string) === "agents") state.activeWorkspace = "security";
        // Refresh BUILT-IN blueprints from code on every load (#677). They're code-owned
        // templates, but `blueprints` is persisted — so improvements to a built-in (the
        // `optional` UI stage, enabled repos, updated prompts, …) would never reach a user
        // who seeded their store before the change. We replace each persisted built-in with
        // its current definition (by id) and add any new built-ins; user-created / forked /
        // imported blueprints are left untouched.
        // Reconcile the persona library with the packaged built-ins (#2094): re-seed any dropped
        // built-in, restore built-in identity, and keep user edits + user-authored personas. Same
        // code-owned-template discipline as the blueprints refresh below.
        if (state?.personas) state.personas = reconcilePersonas(state.personas);
        // #2700: the org feature was renamed "teams" — its persisted store fields `orgs`/`orgZoom` are now
        // `teams`/`teamsZoom`. Map an existing on-disk snapshot's old keys onto the new ones so a user's
        // saved teams + per-team zoom survive the rename (the JSON shape is unchanged; only key names moved).
        if (state) {
          const legacy = state as unknown as Record<string, unknown>;
          if (legacy.orgs !== undefined && legacy.teams === undefined) legacy.teams = legacy.orgs;
          if (legacy.orgZoom !== undefined && legacy.teamsZoom === undefined) legacy.teamsZoom = legacy.orgZoom;
          delete legacy.orgs;
          delete legacy.orgZoom;
        }
        // Same discipline for the team library (#2193): re-seed dropped built-ins, restore built-in
        // identity, keep user edits + user-authored teams.
        if (state?.teams) state.teams = reconcileOrgs(state.teams);
        if (state?.blueprints) {
          state.blueprints = refreshBuiltIns(state.blueprints);
        }
        // Same idea for permission profiles: refresh the built-ins from the role JSON, drop retired
        // demos + stale generated profiles, keep the user's customs (the unified role→profile model).
        if (state?.agentProfiles) {
          state.agentProfiles = reconcileBuiltInProfiles(state.agentProfiles);
        }
        // #2548 follow-up: the one-time triaged grandfather backfilled from the PERSISTED github board +
        // fleets, but both are empty when the user is logged out / after a state reset — so an existing
        // user's on-disk published projects still vanished from the Glance network (only the demo loaded).
        // REPAIR once: when `triagedProjects` is still empty, grandfather from the RELIABLE local published
        // inventory (`list_local_projects`), plus a re-derive from any github board / fleets now present.
        // The empty-guard makes it self-limiting — a backfill makes triagedProjects non-empty, so it never
        // re-runs, preserving the forward-looking rule (a genuinely new draft stays hidden until triaged).
        if (state && Object.keys(state.triagedProjects ?? {}).length === 0) {
          void safeInvoke<{ key: string; title: string; published: boolean }[]>("list_local_projects", undefined, []).then((list) => {
            const keys = (Array.isArray(list) ? list : []).filter((p) => p?.published).map((p) => p.key);
            useAppStore.setState((s) => {
              if (Object.keys(s.triagedProjects).length > 0) return {}; // something already stamped meanwhile — leave it
              const now = Date.now();
              const seeded = grandfatherTriaged(s.githubState?.records, s.planFleet, now);
              const merged = grandfatherLocalPublished(keys, seeded, now);
              return Object.keys(merged).length ? { triagedProjects: merged } : {};
            });
          });
        }
        // Hydrate user blueprints from their on-disk dir (#blueprints) over the `bsc` bridge
        // (`bsc blueprint list --full`, #2143): union them in (so one that survived a store reset or a
        // fresh download appears), and migrate any persisted-but-not-yet-on-disk user blueprint forward
        // to the dir (`bsc blueprint set`). The dir is the durable home; the persisted list is a cache;
        // built-ins stay code-owned. Blueprints are GLOBAL (no project key) → `null`. `bscJson` degrades
        // to `[]` when the bridge is unreachable — safe here: an empty list simply unions nothing (the
        // `if (fromDir.length)` guard), so it never blanks the seeded/persisted set. Async — runs after
        // hydration settles.
        void bscJson<unknown[]>(null, ["blueprint", "list", "--full"], []).then((rows) => {
          const coerce = (b: unknown): Blueprint | undefined =>
            b && typeof (b as Blueprint).id === "string" && Array.isArray((b as Blueprint).sections)
              ? (b as Blueprint)
              : undefined;
          const fromDir = rows.map(coerce).filter((b): b is Blueprint => !!b && b.origin !== "built-in");
          const onDiskIds = new Set(fromDir.map((b) => b.id));
          if (fromDir.length) {
            useAppStore.setState((s) => {
              const byId = new Map(s.blueprints.map((b) => [b.id, b]));
              for (const b of fromDir) byId.set(b.id, b); // the dir wins for user blueprints
              return { blueprints: [...byId.values()] };
            });
          }
          for (const b of useAppStore.getState().blueprints) {
            if (b.origin !== "built-in" && !onDiskIds.has(b.id)) {
              void bscWrite(null, ["blueprint", "set"], b);
            }
          }
        });
        // Same for the packaged skills (#677-style): replace the code-owned set from
        // code and prune any retired packaged skill, so a store seeded with the old
        // dev-workflow skills picks up the compliance/standards library on next load.
        if (state?.skills) {
          state.skills = refreshPackagedSkills(state.skills);
        }
        // Release the gate once hydration settles — on success or error — so the
        // shell never hangs on a blank canvas (on error the store keeps defaults).
        (state ?? useAppStore.getState()).setHasHydrated(true);
      },
    }
  )
);
