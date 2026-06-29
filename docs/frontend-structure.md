# Frontend structure & naming convention

The canonical vocabulary for the application's page structure. One word per level — no synonyms.
This is the source of truth; when a component, prop, or doc disagrees, fix it to match this.

> **The Rail switches Workspaces. A Workspace is composed of a Screen that shows one Page at a time.**

## The hierarchy

```
Rail ──switches──▶ Workspace ──is a──▶ Screen ──shows one──▶ Page
 (left nav)        (rail dest.)       (tabbed shell)        (tab body)
                                       └─ PageTabs (the tab strip)
```

| Level | Canonical word | What it is | Where it lives |
|---|---|---|---|
| L0 | **Rail** | The left-nav switcher. | `app/chrome/Rail.tsx` |
| L1 | **Workspace** | A top-level rail destination (Console, Projects, Skills, GitHub, MCP, Automations, Permissions, Settings). The thing the Rail switches between. Components: `ConsoleWorkspace`, `SkillsWorkspace`, … | `app/registry.ts` (`Workspace` type, `WORKSPACES`) + each feature barrel |
| L2a | **Screen** | The shared **root tabbed shell** a Workspace renders through: a `PageTabs` strip over one active `Page` body, in the `.screen / .screen-page / .screen-body` layout. Controlled — the Workspace owns the page-tab state via `usePageTabs`. | `app/chrome/Screen.tsx` |
| L2b | **PageTabs** | The page-tab strip inside a Screen (select / reorder / tear-off). The model is `usePageTabs`; the rendering primitive is the generic `TabBar`. | `shared/hooks/usePageTabs.ts` + `app/chrome/TabBar.tsx` |
| L3 | **Page** | One tab's swappable body (e.g. Skills → Library / Lessons / Runs; Settings → General / Security / …). A torn-off Page renders alone via the `pageOverride` prop (no `PageTabs` strip). Components: `GeneralPage`, `SecurityPage`, … | inside each Workspace |

## Console's nested vocabulary (unchanged)

The **Console** Workspace does *not* render through the `Screen` shell — it has its own nested model.
These words are deliberately distinct from the L1–L3 set above:

| Console term | What it is |
|---|---|
| **Tab** | A named layout = one CSS-grid of panes (the `Tabstrip`). |
| **Pane** | One grid cell — a single PTY/console session. |
| **View** | A pane's swappable body (chat / files / branches / changes / log) — `TerminalView`, `FilesView`, … |

> Note: the user-facing Console copy still calls a Tab a "workspace" ("New workspace" / "No workspaces").
> That is the Console-local sense — a grid layout — and is **separate** from the L1 `Workspace` type/component.
> (Reconciling that copy is an optional follow-up; it is display text, not a code identifier.)

## Which Workspaces use the Screen shell

| Renders through `Screen` (PageTabs + Pages) | Special-cased |
|---|---|
| Skills, MCP, GitHub, Automations, Permissions, Projects | **Console** (own Tab/Pane grid), **Settings** (own left-nav, but its sections are **Pages**) |

## Rollout status

This convention lands across two issues (the *codebase refactor & consolidation* sweep, v1.0.4 line):

- **Phase 1 — #1878 (done):** the spine. `TabbedScreen` → **`Screen`** shell; the `sectionOverride`
  prop → **`pageOverride`**; the **Page / PageTabs** vocabulary; this doc.
- **Phase 2 — #1879 (done):** free the word at L1 and adopt **Page** for Settings.
  - `registry.ts` `Screen` type → **`Workspace`**, `ScreenMeta` → `WorkspaceMeta`, `SCREENS` →
    `WORKSPACES`, `screenLabel` → `workspaceLabel`.
  - store nav field `activeScreen`/`setScreen` → `activeWorkspace`/`setWorkspace`.
  - rail-destination **components** `*Screen` → `*Workspace` (`ConsoleWorkspace`, `SkillsWorkspace`,
    `McpWorkspace`, `GitHubWorkspace`, `AutomationsWorkspace`, `AgentsWorkspace`, `ProjectsWorkspace`,
    `SettingsWorkspace`) + the `WorkspaceFallback` lazy placeholder.
  - **Settings → Page:** `features/settings/screens/*Screen` → `features/settings/pages/*Page`
    (`GeneralPage`, `SecurityPage`, `GithubPage`, `McpPage`, `PlannerPage`, `SkillsPage`,
    `AutomationsPage`); the dir is renamed `screens/` → `pages/`.
  - The string keys (`"skills"`, `"console"`, …) are unchanged.
- **Optional follow-up:** the `.screen*` **CSS classes** (`.screen` / `.screen-page` / `.screen-body`
  + per-feature `screen-skills`/`screen-console`/…) → `.surface*`/`.workspace*` if desired. Purely
  visual, zero-semantic, wide; left as-is — the `Screen` shell emitting `.screen` reads fine.

### "Screen" is overloaded — what was deliberately NOT renamed

The L1 rename was **surgical**, because other subsystems use "Screen" for unrelated things and must stay:
the planner render-preview's `StageScreen*` / `stageScreens`, and the UI editor's `uiScreens` /
`currentScreen` / `setScreenKey`. (The Settings `screens/*Screen` sub-pages *were* migrated — to Pages.)

## Naming rules for new code

- A new top-level rail destination is a **Workspace**; it renders a **`Screen`** and defines its **Pages**.
- Never reuse **Screen** for an L1 destination, **Page** for a Console View, or **Tab** for a Page.
- The page-tab state always comes from **`usePageTabs`**; don't hand-roll a tab strip.
