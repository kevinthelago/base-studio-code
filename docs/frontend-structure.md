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
| L2a | **Screen** | The shared **root tabbed shell** a Workspace renders through: a `PageTabs` strip over one active `Page` body, in the `.screen / .screen-page / .screen-body` layout. Controlled — the Workspace owns the page-tab state via `usePageTabs`. | `shared/ui/layouts/Screen.tsx` |
| L2b | **PageTabs** | The page-tab strip inside a Screen (select / reorder / tear-off). The model is `usePageTabs`; the rendering primitive is the generic `TabBar`. Keyboard: **Ctrl+← / Ctrl+→** step pages (#4167) — `Screen` publishes `pageNav` to the store and `useHotkeys` matches the chord, because `shared/` may not import a feature's value symbols (#1626/#1703). | `shared/hooks/usePageTabs.ts` + `shared/ui/layouts/TabBar.tsx` |
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
- **Phase 2c — #1886 (done):** the CSS layer. The `Screen` shell's own structural classes
  (`.screen` / `.screen-page` / `.screen-body`) **stay** — they correctly name the `Screen` component
  (like `Dialog`→`.dialog`). The per-**Workspace** scoping classes each Workspace passes as the
  `Screen`'s `className` were renamed `<x>-screen` → `<x>-workspace`: `auto-workspace` (Automations),
  `ext-workspace` (the shared full-bleed panel class, used by MCP/Projects/etc.), `projects-workspace`
  (Projects), `skills-workspace` (Skills) — CSS defs (feature CSS + `tokens.css`) and `className` usages
  in lockstep. (`screen-reader` and prose were untouched.)

### "Screen" is overloaded — what was deliberately NOT renamed

The L1 rename was **surgical**, because other subsystems use "Screen" for unrelated things and must stay:
the planner render-preview's `StageScreen*` / `stageScreens`, and the UI editor's `uiScreens` /
`currentScreen` / `setScreenKey`. (The Settings `screens/*Screen` sub-pages *were* migrated — to Pages.)

## Naming rules for new code

- A new top-level rail destination is a **Workspace**; it renders a **`Screen`** and defines its **Pages**.
- Never reuse **Screen** for an L1 destination, **Page** for a Console View, or **Tab** for a Page.
- The page-tab state always comes from **`usePageTabs`**; don't hand-roll a tab strip.

## Feature boundaries — the barrel is the public API (#1545)

A feature is a **black box behind its `index.ts` barrel**. The barrel is the feature's public API; everything else under `features/<x>/` (its `lib/*`, components, subdirs) is **private**.

- **Cross-feature imports go through the barrel:** import `@/features/<x>` — never `@/features/<x>/lib/foo` or `@/features/<x>/SomeComponent`. So a feature can refactor its internals without churning importers. Need a symbol another feature reaches for? **Re-export it from that feature's `index.ts`** (a curated public API), don't deep-import it.
- **Intra-feature imports keep using the alias:** within `features/<x>/`, `@/features/<x>/lib/foo` is fine (the repo prefers the `@/` alias over `../../` — see "Path alias"). Only *cross*-feature deep imports are forbidden.
- **`import type` is exempt:** a type-only coupling is erased at build and doesn't wire runtime, so `import type { T } from "@/features/<x>/lib/..."` stays allowed (mirrors the `shared/` rule, #1626).
- **Enforced by lint:** `eslint.config.js` generates a per-feature `no-restricted-imports` block (each feature forbids the *other* features' internals) plus an app-shell block. `components/**` and `glance/**` are temporarily exempt as importers (a parallel restructure, #2197/#2214/#2372) — remove them from `EXEMPT_IMPORTERS` to fold them in.
- **Shared vs. feature-owned data:** genuinely feature-agnostic infrastructure lives in `shared/` — e.g. the **GitHub data/query layer** (`shared/lib/github/*`: the client, `useGithubQuery`, `projectV2`, `projectSync`, `issueProvenance`, device flow) that both `github` and `planner` consume. A feature's *views* over that data stay feature-owned (planner's `ProjectBoard`/`Roadmap`/`Issues`/`Insights` are planner's; github's screen imports them one-way through the planner barrel). `shared/` never value-imports a feature (#1626).
