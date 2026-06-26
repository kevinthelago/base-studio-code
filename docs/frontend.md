# Frontend reference

A map of the React/TypeScript frontend for **base-studio-code** — the desktop host's UI shell, rendered inside the Tauri v2 WebView. This is the orientation guide for a developer new to the codebase; the root [`CLAUDE.md`](../CLAUDE.md) is the terse operating manual (commands, conventions, the gate), and this doc expands on it and keeps the file-level map accurate. When the two disagree, trust the code — and this doc is verified against it.

For the Rust backend (Tauri commands, the agent fleet, the plan store, the mobile tunnel), see [`docs/backend.md`](backend.md).

---

## 1. Overview & stack

The frontend is a single-page React app that runs in the Tauri WebView and talks to the Rust backend over Tauri's `invoke` IPC + event channels. It is the "UI Shell" in the architecture: every other subsystem (agent orchestration, GitHub, the mobile relay) lives in Rust; the frontend drives them and renders their state.

| Layer | Choice | Notes |
|---|---|---|
| UI library | **React 19** (`react` / `react-dom` `^19.2.7`) | CLAUDE.md still says "React 18" — the actual dependency is React 19. |
| Language | TypeScript (`^6`), `strict` + `noUnusedLocals`/`noUnusedParameters`/`noFallthroughCasesInSwitch` | `tsconfig.json` |
| Bundler / dev server | **Vite 8** (`@vitejs/plugin-react`) | `vite.config.ts` |
| State | **Zustand 5** (one composed store) | `src/store/` |
| Styling | CSS custom properties (design tokens) | `src/styles/tokens.css` |
| Tests | **Vitest 4** + React Testing Library + jsdom | `vitest.config.ts`, `src/test/setup.ts` |
| Lint / format | ESLint 10 (typescript-eslint, react-hooks, react-refresh) + Prettier | `npm run lint`, `npm run format` |
| Terminal | xterm.js (`@xterm/xterm` + fit/webgl addons) | the console PTY surface |
| Misc | `lucide-react` (icons), `react-markdown`, `qrcode.react` (tunnel pairing), `esbuild-wasm` (in-app bundling for UI previews) | |

Tauri bridges used directly: `@tauri-apps/api` (core `invoke`, events), `@tauri-apps/plugin-store` (persisted state), `@tauri-apps/plugin-log`, `@tauri-apps/plugin-opener`.

---

## 2. Directory layout

The frontend is **feature-first vertical slices** (#1309). The top-level dirs under `src/` *are* the architecture — there are no layer dirs (`components/`, `hooks/`, `screens/`, `lib/` at the root are gone).

```
src/
├── app/        the SHELL — knows every feature; features never import it
├── features/   ONE FOLDER PER FEATURE = UI + lib/ (pure domain) + store.ts + index.ts barrel
├── shared/     feature-agnostic; no feature imports it (lib / hooks / data / ui)
├── store/      Zustand store COMPOSITION (index.ts + types.ts + slices/)
├── styles/     tokens.css — design tokens + base component CSS
├── test/       setup.ts — global Tauri mocks for Vitest
└── assets/     bundled media (achievement sound/image)
```

### The dependency rules

- **`app/` (the shell)** knows every feature and composes them. Features must **not** import from `app/`.
- **`shared/`** is feature-agnostic: it may be imported by anything, but it imports no feature.
- **A feature owns everything it needs:** UI components, a `lib/` of pure (React-free) domain logic, a `store.ts` (its Zustand slice + slice interface), colocated `*.test.ts(x)` tests, and an `index.ts` barrel that is its public API.
- Import a feature's **UI** via the barrel (`@/features/skills`); import its **pure domain** directly (`@/features/skills/lib/skills`) so non-UI modules never pull in React.

### Path aliases (no deep relatives)

Set in `tsconfig.json` (`paths`) and mirrored in `vite.config.ts` + `vitest.config.ts` (`resolve.alias`):

| Alias | Resolves to | Use |
|---|---|---|
| `@/…` | `src/…` | all frontend imports — never `../../..` |
| `@prompts/…` | `src-tauri/prompts/…` | build-time-bundled prompt/stage/blueprint JSON (lives outside `src/`, loaded via `import.meta.glob`) |

---

## 3. The shell — `src/app/`

The shell is the chrome around the screens plus the console execution surface.

### Entry & composition

- **`app/main.tsx`** — Vite entry; mounts `<App/>`.
- **`app/App.tsx`** — the top-level shell: the Titlebar, the left Rail, the console Tabstrip, the StatusBar, the crash/recovery/quarantine banners, the `ErrorBoundary`, and the screen switcher. It holds first paint until the persisted store has hydrated (`hasHydrated`) to avoid a defaults flash. It wires always-on hooks (`useScheduler`, `useTunnelSync`, `useWarden`, `useWorkerAutoEnd`, tunnel control hooks).
- **Lazy screens:** only the Console mounts at boot. Every other screen is `React.lazy`-imported from its feature barrel and code-split, so the heavy planner chunk loads on first navigation, not cold start. Projects lazy-mounts on first visit then *stays mounted* (CSS-hidden) so its local state + PTYs survive; the console likewise stays mounted across all navigations so xterm/PTY sessions are never torn down.

### Navigation — the screen registry

- **`app/registry.ts`** is the single source of truth for the eight top-level screens. `Screen` is the union type; `SCREENS` is the ordered `{ key, label, Icon }` list (rail order is product-locked by `rail.test.tsx`); `screenLabel()` is the canonical display name read by both the rail tooltip and the titlebar "you are here" crumb (so they can't drift). `app/chrome/Rail.tsx` re-exports `Screen` for back-compat.

| Screen key | Label | Notes |
|---|---|---|
| `console` | Console | the execution surface (always mounted) |
| `projects` | Projects | the planner — flagship feature |
| `skills` | Skills | the injectable-context library |
| `github` | GitHub | OAuth, repos, the project board |
| `agents` | **Permissions** | note: key is `agents`, label is "Permissions" |
| `mcp` | MCP | MCP servers + hooks |
| `automation` | Automations | cron-triggered rules |
| `settings` | Settings | |

### Chrome — `app/chrome/`

`Rail.tsx` (left nav), `Titlebar.tsx`, `Tabstrip.tsx` + `TabBar.tsx` (console workspace tabs, with tear-off-to-window support), `StatusBar.tsx`.

### The console pane system — `app/console/`

This is **not** a feature — the console + its state are part of the shell. It is where planned work runs.

- **`ConsoleScreen.tsx`** — renders the active tab's CSS-grid of panes.
- **`panes/`** — `PaneShell.tsx` (one pane), `ViewTabs.tsx` (the icon tabs that swap a pane's view), `HamburgerMenu.tsx` / `PaneMenu.tsx` (per-pane config: model, repo, cwd), and **`panes/views/`** — the swappable views: `TerminalView` (the xterm PTY — the launch wiring), `ConsoleView`, `FilesView`, `BranchesView`, `ChangesView`, `LogView`, `ToolsView`, `TelemetryView`.
- **`lib/`** — the pane domain logic (pure + a few hooks): `paneIdentity.ts` (the **stable pane id** model, #1176), `focusQueue.ts`, `paneStatus.ts`/`paneActivity.ts`, `idleReaper.ts`, `sessionRecovery.ts`/`resumeClaude.ts`, `broadcast.ts`, `models.ts`/`modelDisplay.ts`, `detachWindow.ts` (tear-off windows), and **`lib/providers/`** — the pluggable console-provider registry (claude, codex, gemini, aider, ollama, amazonq, `bsc-agent`).

### Banners & safety — `app/`

`CrashRecoveryBanner`, `SessionRecoveryBanner`, `SessionReadinessBanner`, `QuarantineBanner` (the warden hard-paused a drifted worker), `ErrorBoundary`, `SuperUserAchievement` (an easter egg).

---

## 4. Features — `src/features/`

### How a feature is structured

```
features/<x>/
├── index.ts            public API barrel (UI exports) — import via @/features/<x>
├── <Component>.tsx     the feature UI (+ colocated <Component>.test.tsx)
├── store.ts            its Zustand slice + the slice interface (composed into AppStore)
├── lib/                pure, React-free domain logic — import via @/features/<x>/lib/*
└── <x>.css             feature styles (optional)
```

### The real features

| Feature | Screen | What it is |
|---|---|---|
| **`planner/`** | Projects | **the flagship** — the app-owned planning session that turns a pitch or repo set into an executable plan. See below. |
| `skills/` | Skills | the **Skills library** — reusable markdown context blocks (the injectable-context system that superseded the old Knowledge Base), written into a session's `.claude/skills/`. Source of truth is the global `skills.db`; the slice is a write-through cache (`hydrateSkills`). |
| `mcp/` | MCP | MCP servers + hooks management; catalog + per-session assignment. |
| `automations/` | Automations | cron-triggered rules (`useScheduler`) that dispatch a command into a console pane. |
| `github/` | GitHub | GitHub OAuth, repo selection, the Projects v2 board (the board moved here, #498). |
| `agents/` | Permissions | least-privilege `AgentProfile`s (commands / tools / write-paths / net) applied per stream at launch (#289). |
| `tunnel/` | — (no screen) | the mobile-pairing relay client UI + sync hooks (`useTunnelSync`, etc.); QR pairing. |
| `settings/` | Settings | appearance (accent), keybindings, LLM provider config, integrations, perf/log config. |

> Barrels are `index.ts` for every feature **except `planner`, which is `index.tsx`** (it exports a component).

### The planner (flagship)

`features/planner/` is by far the largest feature — a vertical slice with many sub-areas:

| Sub-dir | Holds |
|---|---|
| `session/` | the live planning session: **`Planning.tsx`** (the big page) + its extracted **`use*` hooks** (`usePlanGates`, `usePlanPublish`, `usePlanSectionPoll`, `usePlannerTagStream`, `usePlannerRepoManagement`, `usePlanMcpDownloads`, `usePlanSkillsManagement`, `usePlannerBlueprint`, …) + the autopilot (`planAutopilot*`), parsing (`planningParse.ts`), and the planner-conductor. |
| `list/` | `ProjectsList.tsx` — the project list + blueprint-library rail. |
| `pane/` | the focused project pane (`ProjectPane.tsx`, `FocusedShell.tsx`, `focusedPlan.ts`) — one phase at a time, a stepper, gate pill, advance bar (#652). |
| `stages/` | the planning-stage model: `blueprints.ts` (lifecycle templates), `planStages.ts`, `planSections.ts`. |
| `blueprints/` | the blueprint editor (`BlueprintEditor.tsx`) + `blueprintSkills.ts`. |
| `bodies/` | per-stage body components rendered in the focused pane. |
| `fleet/` | the agent-fleet model: `agentFlow.ts` (autonomy + push policy, #297), `directorDrive.ts`. |
| `issues/` · `relationship/` · `preview/` · `data/` · `github/` · `lib/` | granular issues, the relationship/topology graph, render-preview, canonical Data Models, GitHub-structure cards, and a large `lib/` of pure planning domain (`planEval/`, `planContract/`, `plannerCore/`, `plannerSync/`, deploy/source/integration config, lint/readiness/injection scanners). |

A blueprint seeds a project's plan (ordered stages, each with a prompt module, pipelines, a declarative gate, attached skills). Built-ins are code-owned and refreshed from code on every load (`refreshBuiltIns` in the store's `onRehydrateStorage`); user blueprints persist to an on-disk dir. See the root `CLAUDE.md` "Project Planning" section for the full planner workflow.

---

## 5. State management — `src/store/`

One Zustand store, composed from slices, persisted via the Tauri store plugin.

- **`store/index.ts`** — `create<AppStore>()(persist(...))`. The state object is built by **spreading every slice creator** together:
  - shell/core slices under `store/slices/`: `console.ts` (the ~110-field core app state — tabs, panes, navigation, hydration), `core.ts`, `shell.ts`, `plan.ts`, `projects.ts`, `session.ts`.
  - feature slices under `features/<x>/store.ts`: `createMcpSlice`, `createSkillsSlice`, `createAutomationsSlice`, `createGithubSlice`, `createTunnelSlice`.
- **`store/types.ts`** — the `AppStore` interface. It `extends` each feature's slice interface (`SkillsSlice`, `McpSlice`, `AutomationsSlice`, `GithubSlice`, `TunnelSlice`) and adds the core fields/actions inline. This is the place to read to understand the full state shape.
- **Persistence** — `name: "app-state"`, backed by `persistStorage` (the Tauri plugin-store) via `createJSONStorage`. A **`partialize`** whitelist persists only durable state; transient UI state (focus queue, live pane status, dormant/quarantined panes, hydration flag) is excluded. `onRehydrateStorage` runs one-time migrations (legacy tab identity backfill, `extensions` → `mcpServers`/`hooks` split, blueprint/skill refresh-from-code) and flips `hasHydrated` so the shell can paint.

Because storage is async, hydration finishes *after* first render — hence the `hasHydrated` gate in `App.tsx`.

---

## 6. Styling — `src/styles/tokens.css`

All color, type, radius, and base component styling is driven by CSS custom properties on `:root`. Key points:

- **OKLCH color tokens** — `--bg-canvas/panel/elev/elev2`, `--border(-soft)`, `--fg(-muted/-dim)`, `--accent(-dim)`, `--success/info/violet/danger`.
- **Themes** — a `[data-theme="light"]` override block, plus a **`.console-theme`** scoped palette (the dark indigo "Console Shell" look applied to the ConsoleScreen root, #1149) that recolors pane chrome without per-component rewrites.
- **Fonts** — `--mono` (JetBrains Mono), `--sans` (Inter).
- The **accent** is user-configurable (Settings → Appearance): `App.tsx` writes `--accent`/`--accent-dim` onto the document root from the persisted `accent` id (`accentVars`), live on change and after rehydration.

Components mostly use these tokens via inline styles and shared CSS classes (`.btn`, `.field`, etc.). Match the `design/` prototype for new screens (it is reference-only — do not edit it).

Shared presentational primitives live in **`src/shared/ui/`**: `Dialog`, `Avatar`, `ConfirmButton`, `LabelChip`, `Toggle`, and `charts/`.

---

## 7. Testing

**Vitest + React Testing Library**, jsdom environment, `globals: true`. Tests are colocated (`*.test.ts` / `*.test.tsx`) next to the code they cover.

```bash
npm test            # vitest run — the one-shot CI run
npm run test:watch  # watch mode
npm run test:coverage
```

- **`src/test/setup.ts`** is the global setup (registered in `vitest.config.ts`). It mocks the Tauri bridges so no test touches native code:
  - `@tauri-apps/api/core` → `invoke` resolves `null`
  - `@tauri-apps/api/event` → `listen`/`emit`
  - `@tauri-apps/plugin-log`, `@tauri-apps/plugin-opener`, `@tauri-apps/plugin-store`

  These apply to **every** test file automatically. Override `invoke` per-test when you need a specific return value.
- The Vitest config re-declares the `@/` and `@prompts/` aliases, so imports resolve identically to the app.

What to test (from `CLAUDE.md`): a new store action → its state transitions + edge cases; a new component → render smoke test + interaction tests; a bug fix → a regression test. Tests ship in the **same branch** as the change.

---

## 8. Gotchas worth knowing

- **Cross-repo contract fixtures.** Two JSON files are byte-exact wire contracts shared with the Rust tests *and* mobile-studio-code:
  - `src/features/tunnel/lib/tunnelProtocol.fixtures.json`
  - `src/features/planner/lib/plannerCore/plannerCore.fixtures.json`

  They live in their feature's `lib/` (deliberate — the feature owns its contract, #1335). The Rust tests resolve them **by filename** (`find_fixture` in `src-tauri/src/mobile/tunnel/mod.rs`), so *moving* a feature slice doesn't break Rust CI — but **renaming a fixture** means updating the Rust `find_fixture("…")` call and mobile-studio-code in lockstep. `find_fixture` requires exactly one name match under `src/` (panics on zero or a collision).

- **Tauri return-value casing.** Tauri auto-renames command **arguments** to snake_case, but **not** return values. A Rust command returning a struct must serialize fields in the casing the frontend reads, or the field comes back `undefined` silently. Match the frontend's expected casing when adding or consuming a command.

- **The push gate (run before pushing frontend changes).** CI mirrors these exactly; all must pass:
  ```bash
  npm run typecheck   # tsc --noEmit, clean
  npm run lint        # eslint, 0 errors (react-compiler/hooks rules tsc + tests miss)
  npm test            # vitest run, all green
  ```
  `npm run lint` catches react-hooks rule violations that `typecheck` and `vitest` do not — don't skip it. Re-run `npm run typecheck` after your *final* `.ts` edit (CI's tsc enforces a stricter lib target than esbuild's test transpile, so a passing test can still fail typecheck).

- **`@prompts/` is outside `src/`.** Stage/blueprint JSON is bundled from `src-tauri/prompts/` at build time via `import.meta.glob` — it's data, not source you edit casually.

- **Lazy-mount lifecycle.** Console and Projects stay mounted (CSS-hidden) after first render to preserve xterm/PTY sessions and local state; other screens unmount when inactive. Keep heavy module graphs out of the boot path.

---

## 9. The backend

For the Rust side — Tauri commands, the agent/fleet orchestration, the SQLite plan store, the DuckDB Data Model, and the mobile relay — see [`docs/backend.md`](backend.md).
