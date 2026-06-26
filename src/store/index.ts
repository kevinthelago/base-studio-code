import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { persist, createJSONStorage } from "zustand/middleware";
import { persistStorage } from "@/shared/lib/core/storage";
import {       deriveTabIdentity } from "@/shared/lib/core/projectPaths";
import {  refreshBuiltIns, type Blueprint } from "@/features/planner/stages/blueprints";
import { migrateLegacyExtensions } from "@/features/extensions/lib/migrateExtensions";
import { createExtensionsSlice } from "@/features/extensions/store";
import { refreshPackagedSkills } from "@/features/skills/lib/skills";
import { createSkillsSlice } from "@/features/skills/store";

import { type AppStore } from "./types";
import { createSessionSlice } from "./slices/session";
import { createPlanSlice } from "./slices/plan";
import { createProjectsSlice } from "./slices/projects";
import { createAutomationsSlice } from "@/features/automations/store";
import { createCoreSlice } from "./slices/core";
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
      ...createAutomationsSlice(set, get, store),
      ...createProjectsSlice(set, get, store),

      ...createPlanSlice(set, get, store),
      ...createSessionSlice(set, get, store),
      ...createSkillsSlice(set, get, store),
      ...createExtensionsSlice(set, get, store),
    }),
    {
      name: "app-state",
      storage: createJSONStorage(() => persistStorage),
      // Exclude transient UI-only state from the persisted snapshot.
      partialize: (s) => ({
        activeScreen:    s.activeScreen,
        tabs:            s.tabs,
        activeTabIdx:    s.activeTabIdx,
        terminalFontSize: s.terminalFontSize,
        accent:          s.accent,
        keybindings:     s.keybindings,
        paneViews:       s.paneViews,
        paneNames:       s.paneNames,
        paneCwds:        s.paneCwds,
        paneWasClaude:   s.paneWasClaude,
        paneDirectorDrive: s.paneDirectorDrive,
        paneDirectorMode: s.paneDirectorMode,
        paneStream: s.paneStream,
        disabledPanes:   s.disabledPanes,
        endedPanes:      s.endedPanes,   // #920: a finished worker's resting state survives restart
        githubConnected: s.githubConnected,
        githubToken:     s.githubToken,
        repoGithubTokens: s.repoGithubTokens,
        githubUser:      s.githubUser,
        githubRepos:     s.githubRepos,
        activeRepoName:  s.activeRepoName,
        automationsTab:  s.automationsTab,
        pageTabOrder:    s.pageTabOrder,
        settingsSection: s.settingsSection,
        perfConfig:      s.perfConfig,
        logConfig:       s.logConfig,
        idleReaper:      s.idleReaper,
        tunnelRelayUrl:  s.tunnelRelayUrl,
        agentProfiles:   s.agentProfiles,
        paneProfiles:    s.paneProfiles,
        paneRoleGlobs:   s.paneRoleGlobs,
        paneRepos:       s.paneRepos,
        paneFlows:       s.paneFlows,
        kbBlocks:        s.kbBlocks,
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
        workflowRuns:         s.workflowRuns,
        projectLocalRepos:    s.projectLocalRepos,
        localDraftProjects:   s.localDraftProjects,
        projectKeyAlias:      s.projectKeyAlias,
        issueLinks:           s.issueLinks,
        achievements:         s.achievements,
        hiddenProjectIds:     s.hiddenProjectIds,
        defaultStartupPromptDoc: s.defaultStartupPromptDoc,
        projectStartupPromptDoc: s.projectStartupPromptDoc,
        repoStartupPromptDoc:    s.repoStartupPromptDoc,
        repoTriagePromptDoc:     s.repoTriagePromptDoc,
        refContextDefault:       s.refContextDefault,
        refContextProject:       s.refContextProject,
        refContextRepo:          s.refContextRepo,
        configProfiles:       s.configProfiles,
        planSections:          s.planSections,
        planConfirmedSections: s.planConfirmedSections,
        planAuthoredBlueprint: s.planAuthoredBlueprint,
        planDeployConfig:      s.planDeployConfig,
        reposPublic:           s.reposPublic,   // #1227: repo visibility (default + …)
        repoPublic:            s.repoPublic,    //        per-repo overrides) survives restart
        planSkippedSections:   s.planSkippedSections,
        planKbAssignments:     s.planKbAssignments,
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
        // The Knowledge Store screen was removed; send a user whose last screen was it
        // back to the console rather than a blank canvas.
        if (state && (state.activeScreen as string) === "knowledge") state.activeScreen = "console";
        // The Blueprints page-mode was folded into the Planner tab's blueprint rail (#blueprints);
        // a user whose last mode was it would otherwise land on a blank canvas.
        if (state && (state.projectsPageMode as string) === "blueprints") state.projectsPageMode = "projects";
        // Refresh BUILT-IN blueprints from code on every load (#677). They're code-owned
        // templates, but `blueprints` is persisted — so improvements to a built-in (the
        // `optional` UI stage, enabled repos, updated prompts, …) would never reach a user
        // who seeded their store before the change. We replace each persisted built-in with
        // its current definition (by id) and add any new built-ins; user-created / forked /
        // imported blueprints are left untouched.
        if (state?.blueprints) {
          state.blueprints = refreshBuiltIns(state.blueprints);
        }
        // Hydrate user blueprints from their on-disk dir (#blueprints): union them in (so one that
        // survived a store reset or a fresh download appears), and migrate any persisted-but-not-yet-
        // on-disk user blueprint forward to the dir. The dir is the durable home; the persisted list
        // is a cache; built-ins stay code-owned. Async — runs after hydration settles.
        void invoke<string[]>("list_blueprints").then((rows) => {
          const parse = (s: string): Blueprint | undefined => {
            try {
              const b = JSON.parse(s);
              return b && typeof b.id === "string" && Array.isArray(b.sections) ? (b as Blueprint) : undefined;
            } catch { return undefined; }
          };
          const fromDir = (rows ?? []).map(parse).filter((b): b is Blueprint => !!b && b.origin !== "built-in");
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
              void invoke("write_blueprint", { id: b.id, json: JSON.stringify(b) }).catch(() => {});
            }
          }
        }).catch(() => {});
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
