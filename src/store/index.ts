import { create } from "zustand";
import { bscJson, bscWrite } from "@/shared/lib/core/bsc";
import { persist, createJSONStorage } from "zustand/middleware";
import { persistStorage } from "@/shared/lib/core/storage";
import {       deriveTabIdentity } from "@/shared/lib/core/projectPaths";
import {  refreshBuiltIns, type Blueprint } from "@/features/planner/stages/blueprints";
import { reconcileBuiltInProfiles } from "@/features/agents/lib/agentProfiles";
import { migrateLegacyExtensions } from "@/features/mcp/lib/migrateExtensions";
import { createMcpSlice } from "@/features/mcp/store";
import { createPersonasSlice } from "@/features/personas/store";
import { reconcilePersonas } from "@/features/personas/lib/persona";
import { createOrgSlice } from "@/features/org/store";
import { createComponentsSlice } from "@/features/components/store";
import { reconcileOrgs } from "@/features/org/lib/org";
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
      ...createMcpSlice(set, get, store),
      ...createPersonasSlice(set, get, store),
      ...createOrgSlice(set, get, store),
      ...createComponentsSlice(set, get, store),
    }),
    {
      name: "app-state",
      storage: createJSONStorage(() => persistStorage),
      // Exclude transient UI-only state from the persisted snapshot.
      partialize: (s) => ({
        activeWorkspace:    s.activeWorkspace,
        tabs:            s.tabs,
        activeTabIdx:    s.activeTabIdx,
        terminalFontSize: s.terminalFontSize,
        accent:          s.accent,
        kitTheme:        s.kitTheme,
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
        projectLinks:         s.projectLinks,   // #2253: user-drawn Glance project relationships
        autoTriage:           s.autoTriage,   // #2265: per-project fault auto-triage toggle
        autoKitDispatch:      s.autoKitDispatch, // #2277: per-project kit auto-dispatch toggle
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
        orgs:                  s.orgs,       // #2193: the persona-relationship graph library (reconciled on load)
        demoActive:            s.demoActive, // #2272: a loaded demo state + its pre-demo backup survive restart
        demoBackup:            s.demoBackup,
        orgZoom:               s.orgZoom,    // #2199: per-org canvas zoom (view state)
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
        // Personas was folded into Org (#2199) — a last-mode of "personas" now opens Org.
        if (state && (state.projectsPageMode as string) === "personas") state.projectsPageMode = "org";
        // The Fleet page-mode was folded into Glance (#2223/#2228) — a last-mode of "fleet" opens Projects.
        if (state && (state.projectsPageMode as string) === "fleet") state.projectsPageMode = "projects";
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
        // Same discipline for the org library (#2193): re-seed dropped built-ins, restore built-in
        // identity, keep user edits + user-authored orgs.
        if (state?.orgs) state.orgs = reconcileOrgs(state.orgs);
        if (state?.blueprints) {
          state.blueprints = refreshBuiltIns(state.blueprints);
        }
        // Same idea for permission profiles: refresh the built-ins from the role JSON, drop retired
        // demos + stale generated profiles, keep the user's customs (the unified role→profile model).
        if (state?.agentProfiles) {
          state.agentProfiles = reconcileBuiltInProfiles(state.agentProfiles);
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
