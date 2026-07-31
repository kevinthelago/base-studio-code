import type { AppStore } from "./types";

/**
 * The fields written to the persisted cache file (`app-state.json`) — the zustand `persist`
 * `partialize` allowlist. Whatever is returned here is `JSON.stringify`'d and flushed to disk on
 * EVERY store `set()`; whatever is left out is never persisted (and re-derives from its real source).
 *
 * DO NOT put anything a `bsc` store owns and re-hydrates at boot in here. Persisting such a field
 * duplicates a source of truth into a throwaway cache — and because `persist` re-serializes this whole
 * object on every write, a large one freezes the app. That is exactly what happened with the component
 * library (#3610): `components` is a **592 KB** blob loaded fresh from `bsc ui` via `hydrateComponents()`
 * (`useAppBoot.ts`) on every boot, yet it was in this list, so every unrelated store write (dozens of
 * pollers, every 1–4s) re-stringified + fsynced ~600 KB on the main thread. It is deliberately ABSENT
 * below — the in-memory store copy stays (fast synchronous reads); only the disk copy is gone.
 *
 * (`kits`/`kitUsage` stay: small first-paint caches. `kitDispatches` stays: a durable fan-out queue,
 * not a bsc-owned cache — it must survive a restart to be drained.)
 */
export function persistedState(s: AppStore) {
  return {
    activeWorkspace:    s.activeWorkspace,
    tabs:            s.tabs,
    activeTabIdx:    s.activeTabIdx,
    terminalFontSize: s.terminalFontSize,
    accent:          s.accent,
    kitTheme:        s.kitTheme,
    soundNotifications: s.soundNotifications, // #3082: opt-in coord-event notification sounds
    ttsEnabled:      s.ttsEnabled,      // #3804: opt-in spoken coordination (a11y Tier 1)
    ttsRate:         s.ttsRate,
    ttsVoice:        s.ttsVoice,
    ttsVerbosity:    s.ttsVerbosity,
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
    projectLinks:         s.projectLinks,   // #2253: user-drawn Glance project relationships
    autoTriage:           s.autoTriage,   // #2265: per-project fault auto-triage toggle
    glanceOff:            s.glanceOff,   // #3239: per-node Glance off/deactivated toggle
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
    planDeployConfig:      s.planDeployConfig,
    planMarketConfig:      s.planMarketConfig, // #2430: the market-stage assessment
    planTransformations:   s.planTransformations, // #2509: the transformations confirm queue
    reposPublic:           s.reposPublic,   // #1227: repo visibility (default + …)
    repoPublic:            s.repoPublic,    //        per-repo overrides) survives restart
    planSkippedStages:   s.planSkippedStages,
    planAutomations:       s.planAutomations,
    planStageConfig:       s.planStageConfig,
    projectBlueprintId:    s.projectBlueprintId,
    planClassification:    s.planClassification,
    uiScreens:             s.uiScreens,
    uiApproved:            s.uiApproved,
    activeBlueprintId:     s.activeBlueprintId,
    planFleet:             s.planFleet,
    planFleetTopology:     s.planFleetTopology,
    planFleetDirectorDrive: s.planFleetDirectorDrive,
    pinnedContext:         s.pinnedContext,
    mcpServers:            s.mcpServers,
    hooks:                 s.hooks,
    // Per-session skill choices keyed by stable identity (#1056) — persist so a
    // worker/triage session keeps its assigned skills across a restart.
    sessionSkillOverrides: s.sessionSkillOverrides,
    // Task groups + per-session group toggles (#skills-groups) — reusable skill bundles.
    sessionSkillGroups:    s.sessionSkillGroups,
    demoActive:            s.demoActive, // #2272: a loaded demo state + its pre-demo backup survive restart
    demoBackup:            s.demoBackup,
    teamsZoom:             s.teamsZoom,  // #2199/#2700: per-team canvas zoom (view state)
    // OMITTED — every one of these is a `bsc`-owned library REPLACED from its store at boot, so a
    // persisted copy is a second source that can only drift, and it is re-serialized on every store
    // write. Measured before removal: app-state.json was 519 KB, of which these were 505 KB (96%);
    // one Design Studio scan issued 110 store writes, i.e. ~57 MB of stringify+fsync on the main
    // thread for a scan that touches `componentBuildStatus`. Each store was verified to hold every
    // row its cache held (cache-only rows: 0) before the copy was dropped.
    //   components (#3610) 592 KB  → hydrateComponents  · blueprints  395 KB → store/index.ts:202
    //   skills + skillGroups 71 KB → hydrateSkills      · personas     33 KB → hydratePersonas
    //   teams                 6 KB → hydrateOrgs   · triagedProjects (#4088) → projects.db
    // The in-memory copies stay (synchronous reads are unaffected); only the disk copy is gone.
    kits:                  s.kits,       // #2269: the component kits (technology-scoped namespaces)
    kitUsage:              s.kitUsage,   // #2277: the consumer index (project→kit) — a fast-first-paint cache
    kitDispatches:         s.kitDispatches, // #2277: the pending fan-out queue — durable so the drain delivers it after a restart
  };
}
