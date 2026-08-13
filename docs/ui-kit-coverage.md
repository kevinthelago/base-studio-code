# UI-kit coverage — the `base-studio-code` kit vs the frontend

A file-level comparison: every non-test `.tsx` under `src/` against the `src` path on each
`base-studio-code` kit record. Regenerate by re-running the audit described at the bottom.

## Headline

| | |
|---|---:|
| Frontend `.tsx` files (tests excluded) | **346** |
| Covered by a kit record that still resolves | **145** (42%) |
| **Not in the kit** | **201** |
| Kit records | 250 |
| …distinct `src` paths | 199 → 145 exist, **54 point at a file that is gone** |

## Records pointing at a file that no longer exists

**7 are legitimate migrations** — the `.tsx` is gone because the graph is now the source,
and these mount at runtime via `GraphComponent`:

`automationspage` · `fleetpage` · `githubpage` · `mcppage` · `securitypage` · `settingspage` · `skillspage`

**47 are drift** — the component was deleted or moved and the record was never updated:

- **src/features/github** (19) — `github-activity-heatmap`, `github-branch-graph`, `github-branches`, `github-churn-by-area`, `github-ci-health`, `github-contributors`, `github-cross-repo-activity`, `github-empty`, `github-file-churn`, `github-kpi-row`, `github-language-mix`, `github-net-lines`, `github-open-prs`, `github-page-mode-strip`, `github-pulse`, `github-pulse-digest`, `github-repos-grid`, `github-review-latency`, `github-velocity`
- **src/features/planner** (9) — `fleet-cost-energy`, `fleet-health`, `fleet-lessons`, `fleet-merge-queue`, `fleet-status`, `fleet-throughput`, `fleet-time-to-land`, `fleet-worker-board`, `relationshipspage`
- **src/features/settings** (7) — `settings-automations`, `settings-general`, `settings-github`, `settings-mcp`, `settings-planner`, `settings-security`, `settings-skills`
- **src/features/security** (4) — `security-activity`, `security-assignments`, `security-flow`, `security-profiles`
- **src/features/automations** (3) — `automations-history`, `automations-hook-analytics`, `automations-schedules`
- **src/features/skills** (3) — `skills-lessons-tab`, `skills-new-group-dialog`, `skills-runs-tab`
- **src/features/teams** (1) — `teams-agent-face`
- **src/shared/ui** (1) — `workspaceshellpage`

## Fully covered groups

- `features/planner/relationship` (2)
- `shared/ui/charts` (3)
- `shared/ui/controls` (12)
- `shared/ui/layout` (8)
- `shared/ui/layouts` (14)
- `shared/ui/overlay` (5)
- `shared/ui/typography` (2)

## Gaps, by group

Ordered by how many files are missing. `n/total` = missing of files in that group.

### `features/settings/cards` — 26/43 missing

- AccentColorCard.tsx
- AchievementsCard.tsx
- AgentRolesCard.tsx
- ClaudeConfigCard.tsx
- ConnectGithubCard.tsx
- DefaultModelCard.tsx
- DemoStateCard.tsx
- DiagnosticsCard.tsx
- IdleReaperCard.tsx
- KitThemeCard.tsx
- LlmProviderCard.tsx
- LogsInventoryCard.tsx
- LogsRetentionCard.tsx
- PerfRetentionCard.tsx
- PermissionPostureCard.tsx
- SandboxDependencyCard.tsx
- SessionsBehaviorCard.tsx
- ShellSelectorCard.tsx
- SoundNotificationsCard.tsx
- StorageCard.tsx
- StudioCard.tsx
- TargetSelector.tsx
- TerminalFontSizeCard.tsx
- ToolPermissionsPanel.tsx
- TtsCard.tsx
- WorkspaceCard.tsx

### `features/planner/bodies` — 17/23 missing

- DeployView.tsx
- FileIntakePane.tsx
- FocusedAutomationsBody.tsx
- FocusedFeaturesBody.tsx
- FocusedPermissionsBody.tsx
- FocusedPlanBody.tsx
- FocusedSkillsBody.tsx
- FocusedSourceBody.tsx
- MarketBody.tsx
- McpsBody.tsx
- ReposDeployView.tsx
- SharedDependencies.tsx
- StreamFocusCards.tsx
- StreamsBody.tsx
- TransformationsBody.tsx
- deployShipSections.tsx
- deployTargetSection.tsx

### `features/designs` — 9/13 missing

- AnimationsMenu.tsx
- ComponentPreviewFrame.tsx
- DesignReconcileModal.tsx
- DesignerLoopBanner.tsx
- DesignerTerminal.tsx
- KitShareModal.tsx
- PaletteStrip.tsx
- PlannerComponentsPane.tsx
- ThemesMenu.tsx

### `app` — 8/10 missing

- Achievement.tsx
- App.tsx
- AppBanners.tsx
- DetachedTabStrip.tsx
- DetachedWindow.tsx
- SessionFailure.tsx
- SessionReadinessBanner.tsx
- main.tsx

### `features/github/summary` — 8/8 missing

- ActivityHeatmap.tsx
- CIHealthCard.tsx
- ContributorsCard.tsx
- CrossRepoActivity.tsx
- GitHubPageModeStrip.tsx
- LanguageMix.tsx
- OpenPRsCard.tsx
- ReposGrid.tsx

### `features/planner/list` — 7/9 missing

- BlueprintCard.tsx
- CloudBlueprints.tsx
- ProjectSetupPage.tsx
- ProjectsHeader.tsx
- ProjectsRail.tsx
- ProjectsSummary.tsx
- ReopenProjectModal.tsx

### `features/settings/pages` — 7/10 missing

- AutomationsPage.tsx
- GeneralPage.tsx
- GithubPage.tsx
- McpPage.tsx
- PlannerPage.tsx
- SecurityPage.tsx
- SkillsPage.tsx

### `features/algorithms/viz/renderers` — 6/6 missing

- ArrayView.tsx
- GraphView.tsx
- MatrixView.tsx
- ScalarView.tsx
- StackView.tsx
- TreeView.tsx

### `features/automations` — 6/6 missing

- AutomationsGraphHost.tsx
- AutomationsStatus.tsx
- History.tsx
- HookAnalytics.tsx
- Schedules.tsx
- index.tsx

### `features/glance` — 6/8 missing

- GlanceCanvas.tsx
- GlanceNode.tsx
- GlancePreviewMorph.tsx
- GlanceSessionLog.tsx
- GlanceStreamMorph.tsx
- GlanceWorkspace.tsx

### `features/security` — 6/6 missing

- ActivityTab.tsx
- AssignmentsTab.tsx
- FlowTab.tsx
- ProfilesTab.tsx
- SecurityGraphHost.tsx
- index.tsx

### `features/algorithms` — 5/5 missing

- AlgorithmsInspector.tsx
- AlgorithmsKitGraph.tsx
- AlgorithmsRail.tsx
- AlgorithmsWorkspace.tsx
- LibrarianTerminal.tsx

### `features/github` — 5/6 missing

- BranchGraph.tsx
- Empty.tsx
- GitHubGraphHost.tsx
- Pulse.tsx
- index.tsx

### `features/planner/github` — 5/8 missing

- Column.tsx
- Insights.tsx
- IssueCard.tsx
- IssueDrawer.tsx
- useActiveProjectGithub.tsx

### `features/planner/session` — 5/7 missing

- GitHubStructureCard.tsx
- InjectionGateBanner.tsx
- Planning.tsx
- PlanningHeader.tsx
- PublishProgressView.tsx

### `features/skills` — 5/10 missing

- RunsTab.tsx
- SessionSkillsModal.tsx
- SkillsGraphHost.tsx
- SkillsStatus.tsx
- index.tsx

### `app/console/panes/views` — 4/8 missing

- TelemetryView.tsx
- TerminalBanners.tsx
- TerminalView.tsx
- ToolsView.tsx

### `features/algorithms/viz` — 4/4 missing

- CodeColumn.tsx
- TracePlayer.tsx
- VizPanel.tsx
- registry.tsx

### `features/planner/fleet` — 4/5 missing

- FleetGraphHost.tsx
- WorkerDetail.tsx
- WorkerDetailPlaceholder.tsx
- WorkerModals.tsx

### `features/planner/pane` — 4/8 missing

- FocusedBodies.tsx
- PlanPreviewPane.tsx
- PlanStageBar.tsx
- ProjectPane.tsx

### `features/sounds` — 4/4 missing

- SoundsInspector.tsx
- SoundsKitGraph.tsx
- SoundsRail.tsx
- SoundsWorkspace.tsx

### `app/chrome` — 3/4 missing

- Rail.tsx
- StatusBar.tsx
- Titlebar.tsx

### `app/console` — 3/6 missing

- PaneAt.tsx
- index.tsx
- useConsoleTabs.tsx

### `features/personas` — 3/3 missing

- PersonaEditor.tsx
- PersonaSummary.tsx
- PersonasPanel.tsx

### `features/planner/github/issues` — 3/3 missing

- DetailPanel.tsx
- FilterBar.tsx
- IssueRow.tsx

### `shared/ui/data` — 3/13 missing

- Code.tsx
- LabelChip.tsx
- RoleTierChips.tsx

### `app/console/terminal` — 2/2 missing

- TerminalHost.tsx
- TerminalSlot.tsx

### `features/debug` — 2/2 missing

- DebugSessionMount.tsx
- RequestSessionsMount.tsx

### `features/mcp` — 2/4 missing

- McpGraphHost.tsx
- index.tsx

### `features/planner` — 2/2 missing

- ProjectsGraphHost.tsx
- index.tsx

### `features/planner/blueprints` — 2/3 missing

- BlueprintModals.tsx
- blueprintIcons.tsx

### `features/planner/list/summary` — 2/4 missing

- ProjectAllocation.tsx
- ProjectsGrid.tsx

### `features/planner/preview` — 2/4 missing

- PreviewPaneShell.tsx
- stageScreens.tsx

### `features/settings` — 2/3 missing

- SettingsGraphHost.tsx
- index.tsx

### `features/studio-sessions` — 2/2 missing

- StudioSessionHosts.tsx
- StudioSessionMount.tsx

### `shared/lib/runtime` — 2/2 missing

- GraphComponent.tsx
- GraphPageFallback.tsx

### `shared/ui` — 2/2 missing

- icons.tsx
- registry.tsx

### `shared/ui/kit` — 2/2 missing

- ThemeProvider.tsx
- ThemeScope.tsx

### `shared/ui/pages` — 2/8 missing

- NetworkPage.tsx
- pageHeader.tsx

### `shared/ui/spec` — 2/2 missing

- KitRenderer.tsx
- SelfWiredKitRenderer.tsx

### `app/console/panes` — 1/2 missing

- PaneShell.tsx

### `app/safety` — 1/1 missing

- ErrorBoundary.tsx

### `features/planner/list/published` — 1/3 missing

- DeleteProjectModal.tsx

### `features/teams` — 1/7 missing

- ArchitectTerminal.tsx

### `features/tunnel` — 1/1 missing

- Tunnel.tsx

### `shared/lib/core` — 1/1 missing

- renderProfiler.tsx

### `shared/ui/feedback` — 1/7 missing

- LiveRegion.tsx

## How this was produced

```
bsc ui list --full            # every kit record, incl. its `src`
# vs every non-test .tsx under src/, matched on the src path
```

Caveats worth keeping in mind when reading the gap list:

- **Not every `.tsx` is a component worth a record.** Hosts, providers, and thin barrels appear here
  as gaps but may never belong in the kit. The number is an upper bound on real work.
- **A missing file is not necessarily harvestable.** `bsc ui harvest src` still reports 289 of 506
  candidates unbuildable — mostly relative-sibling closure (#4076) and unregistered aliases.
- Coverage is matched **per file**, so a file exporting several components counts once.
