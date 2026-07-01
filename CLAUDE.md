# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**base-studio-code** is the desktop host application for a multi-agent AI development workflow platform. The desktop is authoritative — it owns the agent processes, GitHub connections, and the skills library. It pairs with **mobile-studio-code**, a **standalone** mobile app (its own repo, usable on its own) that can **optionally tunnel** into a desktop session — over a zero-knowledge Cloudflare relay, end-to-end encrypted (Noise IK) — so the same agents can be driven from a phone, from anywhere.

The core value proposition: run many AI coding agents in parallel across multiple repositories, with standardized knowledge (prompts, GitHub Actions templates, automation recipes) injected per project based on its tech stack.

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust backend + WebView) |
| Frontend | React 19 + TypeScript, bundled with Vite |
| State management | Zustand |
| Styling | CSS custom properties (`src/styles/tokens.css`) |
| Fonts | Inter (sans) · JetBrains Mono (mono) via Google Fonts |
| Agent orchestration | Claude Code (default) or the model-agnostic `bsc-agent` shell; pluggable `LlmProvider` — Anthropic (`claude-sonnet-4-6` default), OpenAI, Gemini, local (`crates/llm`) |
| Mobile tunnel | Relay client (`src-tauri/src/mobile/tunnel/`) dialing a zero-knowledge Cloudflare Worker relay (`relay/`) — Noise IK E2E + QR pairing |
| Storage | SQLite (`crates/plandb`, plan store) · DuckDB (`crates/data`, canonical Data Model) |

## Testing

Every feature or bug fix must include tests as part of the same branch — never after. Tests are not optional.

| What changed | What to test |
|---|---|
| New store action | Unit test covering the action's state transitions and edge cases |
| New component | Render smoke test + interaction tests for each user-facing behavior |
| New Rust command | Unit test in the owning domain module's `#[cfg(test)]` block; cross-cutting tests live in `src-tauri/src/tests.rs` |
| Bug fix | A regression test that would have caught the original bug |

**Frontend:** Vitest + React Testing Library. Run with `npm test`.
**Rust:** Standard `#[test]` in a `#[cfg(test)]` module. Run with `cargo test --manifest-path src-tauri/Cargo.toml`.

Mocks for Tauri APIs (`invoke`, `listen`, `plugin-store`) are pre-configured in `src/test/setup.ts` and apply to every test file automatically.

## Commands

```bash
npm run dev               # Vite dev server — frontend only (hot-reload)
npm run tauri -- dev      # Full Tauri app with native window + hot-reload
npm run tauri -- build    # Production build (creates platform installer)
cargo test                # Run Rust backend tests
npm run typecheck    # TypeScript type-check without emit
```

## Project Structure

```
base-studio-code/
├── src-tauri/               # Rust backend (Tauri v2)
│   ├── Cargo.toml           # workspace root
│   ├── tauri.conf.json
│   └── src/                 # ONE FOLDER PER SUBSYSTEM — the folder tree IS the architecture
│       ├── main.rs          #   binary entry → app::run()
│       ├── lib.rs           #   crate root: module decls + the leaf-helper prelude (#1918; no module aliases)
│       ├── prelude.rs        #   the crate's named leaf-helper prelude (paths/git/shell/fs/…), `use crate::prelude::*`
│       ├── tests.rs         #   cross-cutting test module (+ testutil.rs)
│       ├── platform/        #   OS primitives: paths, git, shell, process, fsx, docstore
│       ├── app/             #   Tauri shell: run(), state, recovery, dialog
│       ├── console/         #   interactive PTY surface: pty, ledger, discovery, shell_rc
│       ├── session/         #   session launch/config/permissioning: harness, launch, claude_config, settings, llm
│       ├── project/         #   on-disk hub + plan store: hub, plan_files, plan_db, blueprints, files, dead_code, ui_skeleton
│       ├── planner/         #   planning session: prompts, directives, workspace
│       ├── fleet/           #   worker fleet: worktree, director, staging
│       ├── github/          #   GitHub integration: api, oauth, repos, readiness, git_hooks
│       ├── sources/         #   migration data sources: data, oauth, credentials
│       ├── extensions/      #   MCP servers, hooks, skills, cfg
│       ├── observability/   #   logs, perf, tokens, audit
│       └── mobile/          #   paired companion: push + tunnel/{state,transport,commands} (wire protocol + Noise → crates/bsc-tunnel)
├── crates/                  # workspace crates (Tauri-free, CLI-spawnable)
│   ├── data/                #   canonical Data Model (DuckDB) + connectors (pkg bsc-data, bsc data CLI)
│   ├── plandb/              #   per-project plan store (SQLite) + bsc plan CLI
│   ├── skilldb/             #   global skills + task-groups store (SQLite) + bsc skill CLI
│   ├── logs/                #   unified log/perf/cost engine + bsc logs CLI (#1607)
│   ├── compliance/          #   compliance-standards store + bsc compliance CLI & bsc mcp compliance server
│   ├── research/            #   literature research + bsc mcp research server
│   ├── llm/                 #   model-agnostic LlmProvider abstraction (pkg bsc-llm)
│   ├── bsc-agent/           #   model-agnostic agent runtime
│   ├── bsc-blueprint/       #   user blueprint store + bsc blueprint CLI
│   ├── bsc-project/         #   project-hub list/published store + bsc project CLI
│   ├── mcp-rpc/             #   shared stdio JSON-RPC MCP server scaffold
│   ├── bsc-tunnel/          #   mobile-tunnel wire contract + Noise IK crypto (Tauri-free; shared with mobile-studio-code)
│   └── bsc-util/ · bsc-sqlite-util/ · bsc-cli-util/   #   shared internal libs (paths, SQLite, CLI arg parsing)
├── src/                     # React frontend (TS) — FEATURE-FIRST vertical slices (#1309). The four
│   │                        #   top-level dirs ARE the architecture; imports use `@/…` → src (no
│   │                        #   deep `../../` relatives). No more layer dirs (components/lib/hooks/…).
│   ├── app/                 # the SHELL — knows every feature; features don't know it
│   │   ├── main.tsx  App.tsx   #   Vite entry + the Titlebar/Rail/screen-switcher shell
│   │   ├── registry.ts      #   canonical Workspace → {label, icon} (#1879); the rail + titlebar both read it
│   │   ├── chrome/          #   Rail, Titlebar, Screen (shared tabbed shell, #1878), Tabstrip, TabBar, StatusBar
│   │   ├── console/         #   the execution surface: ConsoleWorkspace + panes/ + lib/ (pane system)
│   │   ├── safety/          #   the crash layer: ErrorBoundary + fatalOverlay (self-installing DOM crash overlay, #1905)
│   │   └── *Banner.tsx      #   crash/quarantine/readiness banners
│   ├── features/            # ONE FOLDER PER FEATURE = UI + lib/ (pure domain) + store.ts (its slice)
│   │   │                    #   + index.ts (public API barrel). Import UI via @/features/<x>; import
│   │   │                    #   the pure domain via @/features/<x>/lib/* (keeps React out of non-UI).
│   │   ├── skills/ · mcp/ · automations/ · github/ · tunnel/ · agents/ · settings/
│   │   └── planner/         #   the flagship (session/, pane/, bodies/, blueprints/, stages/, …, lib/)
│   ├── shared/              # feature-agnostic; no feature imports it
│   │   ├── lib/             #   core (log/perf/llm), session, fleet, security, cleanup
│   │   ├── hooks/  ·  data/ #   shared hooks · typed sample data (mock.ts)
│   │   └── ui/              #   shared primitives, grouped (#1902): controls/ overlay/ feedback/ data/ layout/ charts/ + icons.tsx
│   ├── styles/tokens.css    # design tokens + base component styles
│   └── store/               # Zustand store COMPOSITION
│       ├── index.ts         #   create() composes feature slices + persist
│       ├── types.ts         #   AppStore = feature slice interfaces (`extends …Slice`) + core fields
│       └── slices/          #   console (core app state), plan, projects, session + core/shell residuals
├── design/                  # ⚠️  REFERENCE ONLY — do not edit
│   └── *.jsx / styles.css   # Browser-rendered design prototype (Babel standalone)
└── package.json
```

### Frontend conventions (feature-first, #1309)

The frontend is **feature-first vertical slices** — `app/` (shell) · `features/` (one folder per
feature) · `shared/` (feature-agnostic) · `store/`. There are no layer dirs (`components/`, `lib/`,
`hooks/`, `screens/`, `data/` are gone). Rules:

- **Page-structure vocabulary (#1878/#1879):** one word per level — the **Rail** switches
  **Workspaces**; a Workspace is composed of a **Screen** (the shared tabbed shell, `app/chrome/Screen.tsx`)
  that shows one **Page** at a time over a **PageTabs** strip (`usePageTabs` + `TabBar`). Rail
  destinations are `*Workspace` (`registry.ts` `Workspace` type + `activeWorkspace`); Settings sections
  are Pages (`features/settings/pages/*Page`). Console keeps its own nested **Tab → Pane → View**. Full
  convention: [`docs/frontend-structure.md`](docs/frontend-structure.md).
- **A feature owns everything it needs:** `features/<x>/` holds the UI, a `lib/` of pure (React-free)
  domain logic, a `store.ts` (its Zustand slice + slice interface), colocated tests, and an `index.ts`
  barrel that is the feature's public API. Import a feature's UI via `@/features/<x>`; import its pure
  domain directly via `@/features/<x>/lib/...` (so non-UI modules never pull in React).
- **Path alias:** use `@/…` (→ `src/…`), never deep `../../..` relatives, so moves don't churn importers.
  (tsconfig `paths` + vite/vitest `resolve.alias`.)
- **app/ vs features/ vs shared/:** the shell (`app/`) knows every feature and composes them; features
  don't import `app/`. `shared/` is feature-agnostic (no feature imports). The **console** pane system +
  its state are the shell (`app/console/` + the core `console` store slice — the ~110-field core app
  state, navigation + hydration + tabs + panes), not a feature.
- **Store:** `store/index.ts` composes the slices; `AppStore` is `extends`-ed from each feature's slice
  interface. Per-feature slices live in `features/<x>/store.ts`; the core app state + labelled residuals
  (`console`, `core`, `shell`, `plan`, `projects`, `session`) remain under `store/slices/` — a candidate
  for further splitting later.
- The big `planner` files (`Planning.tsx` ~3k, `ProjectPane.tsx` ~1.5k) moved as-is; **splitting them
  into focused modules is a remaining quality pass** (not a structural move).
- **Cross-repo contract fixtures** (`tunnelProtocol.fixtures.json`, `plannerCore.fixtures.json`) live in
  their feature's `lib/` but are byte-exact wire contracts ALSO consumed by the Rust tests and
  mobile-studio-code. The Rust tests resolve them **by filename** (`find_fixture` in
  `src-tauri/src/mobile/tunnel/mod.rs`), so moving a feature slice does **not** break Rust CI — but
  **renaming a fixture file** means updating the Rust `find_fixture("…")` call (and mobile-studio-code)
  in lockstep. (This is the one place Rust reaches into the frontend tree; everything else it reads is
  backend-owned — `src-tauri/data/`, `src-tauri/tests/`.) Colocating the fixture with its feature
  is **deliberate** (the feature owns its contract; #1335 weighed a shared `contracts/` dir and chose
  not to, since that fights feature-ownership) — so `find_fixture` requires **exactly one** name match
  under `src/` (it panics on zero or a name collision) rather than silently taking the first.

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator      — spawns/manages parallel agent sessions       (src-tauri/src/{console,session,fleet})
├── GitHub Integration      — OAuth, repo selection, PR/issue access       (src-tauri/src/github)
├── Mobile relay client     — dials the Cloudflare relay for mobile pairing (src-tauri/src/mobile/tunnel)
└── UI Shell                — Tauri WebView running the React frontend
```

```
mobile-studio-code (standalone app — separate repo; usable on its own)
└── Relay client (optional) → tunnels into a desktop session via the relay
    └── Mirrors console grid view + basic input
```

## Key Concepts

**Skill** — A named, reusable markdown block (the **Skills library**, `src/features/skills/` + `crates/skilldb` + the `bsc skill` CLI) that supplies injectable context — standardized GitHub Actions configs, code review checklists, architecture patterns. Attached per blueprint/section and written into the session's `.claude/skills/`. This is the injectable-context system (it superseded the old Knowledge Base).

**Console** — A single agent session tied to a repo, model, and optional skills. Multiple consoles run in parallel within a tab.

**Pane** — The UI cell that renders one console. Each pane has a swappable view (console chat, file tree, branch list, diff, commit log) selected via icon tabs. Configuration is exposed via the hamburger menu (model, repo, cwd).

**Tab** — A named workspace containing one CSS grid layout with N panes. Persists across sessions.

**Tunnel** — The **optional** bridge between desktop and the standalone mobile app. Both peers dial out to a **zero-knowledge Cloudflare relay** (`relay/`); the desktop runs the relay client (`src-tauri/src/mobile/tunnel/`) and the session is end-to-end encrypted with **Noise IK** (the relay only ever sees ciphertext). Pairing is by QR.

**Automation** — A cron-triggered rule that automatically dispatches a command into a specified console pane.

## Project Planning

The flagship feature. A **dedicated, app-owned planning session** turns a pitch (new project) or an existing repo set into a complete, executable plan: the feature breakdown, the GitHub structure (milestones + granular issues), the parallel-agent fleet, and the context files every downstream session runs under. The user steers the conversation; the planner produces everything. Entry: `src/features/planner/` (`session/Planning.tsx`, `list/ProjectsList.tsx`); backend setup: `src-tauri/src/planner/workspace.rs` (`setup_workspaces`).

### The right pane — focused plan view (#652)
The planning page is a split: the live Claude session (terminal, center) + the **focused project pane** (`ProjectPane.tsx`, `focus` mode). The pane shows **one phase at a time** — a navigable **stepper** (per-phase status from `sectionStatus`: complete/active/locked/upcoming, incomplete phases pulse), a phase header with a **gate pill** (`evalGate`), lock/done banners, the phase body (Context / Structure+lens / Permissions+director, else a generic card), and a **footer advance bar** (back · jump/back-to-current · approve & continue when the gate passes · publish). It auto-follows the live session (`currentSection` = active phase) while letting the user navigate; selection resets on a project/blueprint switch. Pure model: `focusedPlan.ts`; shell: `FocusedShell.tsx`. (Replaced the all-sections scroll + the full-width N-bar.)

### Blueprints — the lifecycle library (#609 / #645 / #636 / #647)
A **blueprint** is the reusable template that seeds a project's plan: an ordered set of stages, each with a prompt module, **pipelines**, a declarative **gate** (`gateRule` → `evalGate`), an optional **output disposition**, and attached **skills**. Model: `src/features/planner/stages/blueprints.ts`; UI: `blueprints/BlueprintEditor.tsx` (drag-reorder editor + Design-with-Claude assistant) + the library rail in `list/ProjectsList.tsx`.
- **Category + mode (#645):** every blueprint carries a lifecycle `category` — **greenfield** (create from a pitch), **transform** (restructure existing repos), **harden** (improve in place), **maintain** — and a `mode` (`create` vs `operate`, which selects the planner intro). The Library groups/filters/searches by category. Built-ins: Default / Full-stack / Mobile / API (greenfield) + Refactor & Cleanup, Split / Combine microservices, Migrate (transform) + Harden security (harden). Domain greenfields (CAD, simulation) stay out of the packaged app — catalog later (#649).
- **Skills (#636):** a section (or the whole blueprint) can attach reusable **skills** — the Skills library (`blueprintSkills.ts`). They're resolved and written to the hub's `skills.md` for the planner, and inlined into each worker's `CLAUDE.local.md` at fleet launch (`ensure_worktree`). The assistant can author + attach new ones.
- **Switching (#647):** `projectBlueprintId` records which blueprint seeded a project; opening one whose blueprint differs from the selected one prompts to **reset** (re-seed + clear progress + restart, `applyBlueprintToProject`), **keep**, or export files first.

### The project key
`effectiveProjectId = planningSessionKey || activeProjectId || planningTitle || planningPitch` (Planning.tsx). In practice `planningSessionKey` wins. `sanitize_project_key` (`platform/fsx.rs`) slugifies it: keep `[A-Za-z0-9-]`, everything else to `_`, cap 80 chars (the backend treats the key as fully **opaque**).

**Stable id at creation (#1741).** A new project mints a **stable, opaque key** at creation (`mintProjectId` in `shared/lib/core/projectPaths.ts` → `p-<base36 epoch>-<random>`, already slug-safe so `sanitize_project_key` is a no-op). It's stored as the `localDraftProjects` map key and used as `planningSessionKey`, so the project **title/name is display-only** — renaming changes only the label, never the key or any on-disk path (hub, plan.db, DuckDB store, worktrees, session skill group), and two same-titled projects get **distinct** keys. The node-id alias set at publish (`projectKeyAlias[nodeId] = stableId`) is how a published project reopened from the board (`handleEditPlan` / `ProjectsHeader.handlePlan`) resolves back to its stable key.

**Grandfathering.** The rule is `key = project.stableId ?? <legacy title-derived key>`: a project created **before** #1741 has no minted id, so its key resolution falls back to today's title-derived behavior and its on-disk hub/plan.db/worktrees are **untouched** (no migration, no directory move). Migrating legacy title-keyed projects onto stable ids (which would require moving on-disk dirs + `git worktree repair`) is a deliberate follow-up, out of scope here.

### Workspace layout
`setup_workspaces` creates the project hub at `~/.base-studio-code/projects/<key>/`:
- `CLAUDE.md` — *currently* the planner spec (see "Session roles + the CLAUDE.md model")
- `.claude/settings.json` — planner permissions (read/write md + WebFetch + git/gh)
- plan **section files**, flat: `goal.md`, `scope.md`, `stack.md`, `architecture.md`, …
- `phases.json` (milestones) + `plan.db` — the per-project SQLite working store holding the granular issues, fleet streams + per-stream permissions, and context required-set. #1805 made plan.db the **sole fleet store** (the legacy `fleet.json`/`issues.json` files are no longer authored — `issues.json` is a projection rendered from plan.db; any stray `fleet.json` is migrated in once by `migrate_stray_fleet_json`)
- `prompts/` — kickoff scripts the planner authors (`<stream>-kickoff.md`, `director-kickoff.md`)
- `automations.md`, `github_context.md`
- linked repos cloned in as subdirs (`<key>/<repo>/`); fleet worktrees live **outside** the hub at `~/.base-studio-code/worktrees/<key>/<repo>--<slug>/` (#844, so the planner `CLAUDE.md` is not their ancestor — `worktrees_dir` in `platform/paths.rs`)

### The planner is plan-only
Role gate #219: `git: read`, `github: read`, `code: none`. It reads for context and writes plan files, but cannot edit project code, commit, push, or open PRs. Publishing the GitHub structure is done by the **app** (`handlePublish`), not the planner's shell.

### The planning workflow (driven by the planner CLAUDE.md template in `planner/prompts.rs` + `planner/directives.rs`)
1. Link repositories.
2. **Discovery checklist** (goal, users, scope, ux, stack, architecture, schema, api, security, testing, …) — scan, propose, confirm, one topic at a time. Each becomes a section file + a `<plan_update>` tag (the right panel reveals it live).
3. **Develop the GitHub structure — the feature workshop** (#318, the deep interactive core): map the features, drive each down (behavior + acceptance / build approach / tools / data + deps), propose-then-interrogate, one feature at a time, then sequence into phases.
4. **Granular, agent-ready issues** (#311, in `plan.db`): each `PlanIssue` carries acceptance criteria, owned files, dependencies, labels, milestone, owning stream — enough that an agent finishes without asking.
5. **Plan the agent fleet** (`plan.db` `fleet_stream` rows): non-overlapping streams (owns globs, issues, dependsOn), recommended session count, optional director.
6. **Publish** (`handlePublish`): repos, project board, one milestone per phase, one GitHub issue per `PlanIssue` (body = acceptance + owns + deps, pinned to its milestone), `stream:<id>` labels.

### Per-agent configuration set during planning
- **Profiles** (#289, `src/features/agents/`): a least-privilege `AgentProfile` (commands / tools / write-paths / net) per stream, applied at launch.
- **Flows** (#297, `src/features/planner/fleet/agentFlow.ts`): `autonomy` (continuous/checkpoint/confirm) + `push` (auto-pr/push-confirm/commit-only/none) + `trigger` + `gate` — drives each agent's git/gh permissions, kickoff prose, and pause-visibility.

### Session roles + the CLAUDE.md model (and a known issue)
Three kinds of session live around a project, each needing **different** context:
- **Planner** — the planning spec; plan-only.
- **Orchestrator / director** — coordinates the fleet (review/merge PRs, resolve logged decisions, keep the board current); never plans or writes feature code.
- **Agents / workers / triage** — execute their assigned issue in a worktree, guided by their repo `CLAUDE.md` + `CLAUDE.local.md` (the plan) + their kickoff.

**Current state:** the planner spec is written to `projects/<key>/CLAUDE.md`, which is the **ancestor of every execution session** (director + workers run under `projects/<key>/`). Claude Code loads `CLAUDE.md` from the cwd and every parent, so the planner spec leaks into those sessions and they get pulled toward planning. A `READ FIRST` scope guard at the top of the planner CLAUDE.md is the interim band-aid (#320/#331).

**Intended architecture (in progress):** the planning session is **isolated in its own tree** (not an ancestor of the repos), `projects/<key>/CLAUDE.md` becomes the **orchestrator** spec, and the planner **generates** the orchestrator + agent context files as deliverables. Converge on this when touching `setup_workspaces` / the planning launch / `fleetStartProject`.

## Console — the execution surface

Where the planned work runs. A **tab** holds a CSS-grid of **panes**; each pane is a PTY session running `claude` in a repo or worktree, with swappable **views** (console chat, files, branches, changes, log). Backend: `pty_create` in `console/pty/` (dir-module: `mod.rs` + `job.rs`); launch wiring: `src/app/console/panes/views/TerminalView.tsx` + `fleetStartProject` in `src/store/index.ts`.

### Session roles + the role gate (#219, `src/shared/lib/session/sessionRoles.ts`)
Every session has a role bounding its capabilities (least privilege), applied at launch via `ensure_session_settings` to `.claude/settings.json`:

| Role | git | github | code |
|---|---|---|---|
| planner | read | read | none |
| worker | write | read | write (owned globs only) |
| director | write | write | none |
| triage | none | write | none |
| tester / reviewer / conductor | read | read | none |
| issuer | read | write | none |
| juror | read | read | none |

(`tester`/`reviewer`/`conductor` are the pipeline-stage roles, #220; `issuer` is intake-only — shapes a request into a GitHub issue and hands off, #376; `juror` independently judges a landing against its acceptance criteria, #394.) `roleDeniedCommands` denies the mutating git/gh commands a role cannot run; `roleWriteRules` denies/scopes the file-write tools. The session allows Bash broadly and guarantees `gh`/`git` on PATH; Claude Code precedence is **deny > ask > allow**. (**Permission postures** (#1916/#2050): the PreToolUse hooks — `bsc-deny` (dangerous floor + role/user denies), `bsc-confine` (FS confinement), `bsc-scope` (write-scope) — are the always-on floor, firing **and blocking under BOTH postures** (even bypass, where `permissions.deny` is ignored). The **default is the ALLOW-LIST** (#2050): Claude's `default` mode auto-runs the broad `base.json` allow-list (git/gh + the read-only inspection set + the mainstream build/test toolchains) and prompts for anything else — low-friction but safe. **Bypass** (sessions auto-run everything, hooks-only gating) is the opt-in power **posture toggle** (Settings → Security). On top, an opt-in **model-agnostic OS sandbox** (#1988): a session runs inside a **sealed WSL2 distro** (`bsc-agent-sandbox` — no `/mnt/c` mount, no Windows interop, baked into `/etc/wsl.conf`), so the cage is the *environment* and confines whatever LLM drives the session, not just Claude (`pty_create`'s opt-in `wsl_distro`; provision + readiness in Settings → Security; a Settings → Agents toggle launches consoles inside it). **Per-agent isolation via Linux users** is planned for v1.0.5 (#1994).)

### The fleet (`fleetStartProject`)
One click fills a build tab:
- **Director** at the project hub (`projects/<key>/`), kickoff `prompts/director-kickoff.md` — sees every repo + worktree; coordinates, never writes feature code.
- **Workers** each in their own **git worktree** (`~/.base-studio-code/worktrees/<key>/<repo>--<slug>/`, outside the hub per #844) on a **branch named after the stream id**, seeded with `CLAUDE.local.md` (the plan, copied in by `ensure_worktree`) and the stream's kickoff (`prompts/<id>-kickoff.md`, else `buildStreamPrompt`). Per-agent profile + flow applied.

### Per-agent flow at launch (#297)
Drives: which git/gh writes auto-approve vs **prompt** (the `ask` tier for a hard push-confirm gate) vs deny; the autonomy + push paragraph in the kickoff; and a coordination wake when a checkpoint/confirm agent pauses. The flow's push policy is the **authority** over `git push` / `gh pr create` and lifts the role gate's broad gh-write deny for exactly those two (#304) — so an `auto-pr` worker can open its own PR while `gh pr merge` / repo-delete stay role-denied.

### Coordination (#199, `src/shared/lib/fleet/coordination.ts`)
Agents emit structured events to an app-wide `coord.log`: `bsc-wait` (paused for the user, #297), the worker↔director Q&A pair `bsc-ask`/`bsc-answer`, the `bsc-issue`/`bsc-assign` capture-and-route emitters, and the completion emitters `bsc-landed/merged/closed/failed`. The **Coordination inbox** (`CoordinatorInbox`) surfaces paused / blocked-on-a-question / ready sessions for the user. **Runtime dependency-wait was removed (#1039):** there is no `bsc-blocked --on` and no coordinator auto-wake — `dependsOn` is a *planning-time* sequencing hint only; at run time workers build against the planned contracts in parallel and never park on an upstream, and the director owns contracts + integration.

### bsc-* shell helpers + the runtime state-CLI surface (#1325)
Two distinct mechanisms reach a live session's own shell. **Pure-shell helpers** are installed into every session via `BASH_ENV` to `~/.base-studio-code/bsc-env.sh` (written by `pty_create`, `console/shell_rc.rs`): `bsc-checkpoint` (resume note), `bsc-note` (DECISIONS.md provenance), `bsc-audit` (#257 tool-attempt log), `bsc-confine` (#158 FS confinement), `bsc-wait` + the coord emitters (`bsc-ask`/`bsc-answer`, `bsc-landed/merged/closed/failed`, `bsc-issue`/`bsc-assign`). **WARNING: each rc constant must end with a trailing newline** or the concatenated shell functions glue together and the whole rc breaks with a syntax error (#296) — the `full_bsc_rc_is_syntactically_valid_bash` test guards this. (`bsc-blocked` was removed, #1039.)

**The unified `bsc` state CLI (#1877):** the runtime principle is that **every persistent app store is reachable from a live session via the one bundled `bsc` binary** — execed by an absolute path from `$BSC_BIN` (no PATH changes), with each former per-store sidecar now a **subcommand** of `bsc`: `bsc plan` (plan.db, `$BSC_PLAN_DB`), `bsc skill` (global skills.db, incl. `get`/`remove`), `bsc data` (canonical DuckDB model/scan/tables + `connector` — which **replaces** the deprecated `bsc plan integration`, #1721), `bsc logs` (unified logs + perf/cost), `bsc compliance` (compliance standards — the CLI alongside the `bsc mcp compliance` server), `bsc blueprint` (user blueprints), `bsc project` (project-hub list/published), and `bsc files` (file tree). The bundled MCP servers are reached the same way — `bsc mcp research` / `bsc mcp compliance`. So a live session can read or drive any of these stores directly from bash. (The only other bundled binary is `bsc-agent`, `$BSC_AGENT_BIN`, the model-agnostic agent runtime.)

### Pipelines (#220) and GitHub-readiness (#297 S1)
- **Pipelines**: a staged conductor sequences build, test, review, integrate with the least-privilege tester/reviewer/conductor roles, bounded by retry limits.
- **GitHub-readiness probe**: on launch each claude-launching pane probes `gh`/`git` on PATH + `gh auth`; if not ready it shows a dismissible amber banner in the pane so the gap surfaces before the agent hits it mid-task.

### Triage
A per-repo session that resumes the repo's prior conversation (`claude --continue`) with `prompts/<repo>-triage.md`, to work the repo's open issues by priority.

## Roadmap & Release Process

Development is organized into **versions**, worked one at a time. A version is not a frozen
snapshot you finish before cutting a build — it is a **living milestone** you ship early and keep
improving until its theme is complete. We release a version, then continue working on that same
version (refining, fixing, and filling out its theme) until every issue under it is done; only then
does the next version become the focus. So a version on the roadmap is **Current** (actively being
built on, even though a build may already be released under that number) rather than **Shipped**.

**The cycle for a version:**
1. **Open** the version with a theme and its set of issues (the work that defines "complete").
2. **Build** through those issues on `{issue-number}-{short-description}` branches → `develop`.
3. **Release** early and often from `develop → main` — a released build does **not** close the
   version; it's a checkpoint, and work on the same version continues.
4. **Complete** the version only when all of its issues are done. The next version then becomes
   Current and step 1 repeats.

At any time exactly one version is **Current**. Earlier versions are **Complete**; later versions
are **Planned**.

### Versioning policy (pre-v2 is loose on purpose)

The app is still coalescing — not every feature is well defined, work spans many files and overlaps
with other work — so the version numbers are **deliberately loose** until it's unified. Three phases:

1. **`1.0.4n` — fix & polish (CURRENT).** Bump the trailing digit for each release (`1.0.41`,
   `1.0.42`, …). Development stays the firehose: the fleet pushes to `develop`, features overlap,
   nothing is gated on a tidy theme. A release is just a snapshot of `develop`.
2. **`1.0.5` — the UI release + finishing the maintenance bots.** The next themed step, cut once the
   fix/polish pass feels done.
3. **`2.0.0` — unification.** Once every feature the maintainer wants is added and the app is a
   defined product, we cut `2.0.0` and switch to **rigorous semver** (major/minor/patch by their real
   meaning), followed strictly from there. This is the hand-off point where release discipline tightens.

The pre-v2 numbering is an intentional trade for velocity — **do not "fix" it or relitigate the
scheme.** The phase boundaries are tracked as GitHub **milestones** (`1.0.5 …`, `2.0.0 …`).

### Cutting a release — one command

`npm run release` does the whole cut in one go: bump the version in **both** `package.json` and
`src-tauri/tauri.conf.json`, stamp the `CHANGELOG.md` `[Unreleased]` section as the new version,
commit, tag `vX.Y.Z`, and `git push --follow-tags` — which fires the tag-triggered `release.yml` to
build the platform installers and cut the GitHub Release.

- `npm run release` — patch bump (the `1.0.4n` cadence: `1.0.41 → 1.0.42`).
- `npm run release -- 1.0.5` — an explicit version (a themed step, or `2.0.0`).
- `npm run release -- minor` / `major` — a semver bump (used from v2 on).

Run it from an up-to-date `develop` with a clean working tree. Only `package.json` +
`tauri.conf.json` carry the app version; `src-tauri/Cargo.toml` stays at its crate version.

### Roadmap

| Version | Status | Theme |
|---|---|---|
| v1.0.3 | Complete | User experience, resiliency, and the core **Default** (greenfield) blueprint and its **triage** — the progress-gated relaunch that resumes from plan.db and skips completed workers. Running in parallel, the **model-agnostic agent shell** (`bsc-agent`, epic #1078) lets the platform run on any LLM (Anthropic/OpenAI/Gemini/local); Claude Code stays the default until parity. |
| **v1.0.4** | **Current** | **Enterprise integration & migration** — connect **read-only** to an existing system (CRM/ERP/BPM, Salesforce first) and **scan the whole platform**: data types *and* configurations *and* behaviors. The planner produces a **Platform Behavior Summary** — objects/fields, automations (validation rules, workflows, Flows/Process Builder), business processes (approval processes), and derived logic (formula fields, Apex) — so **automations, business processes, and data are all migratable**: reproduced as the generated app's schema and logic via canonical **data models** + **agent-authored connector manifests** (the planner probes the source and authors the connector; native per-vendor connectors were removed, #1976) + MCP connectors, with a compliance layer baked into the planner. The v1.0.5 line generalizes this into a global **Integrations Platform** (#1965). |
| **v1.0.4n** | **Current** · fix & polish | The rolling `1.0.4n` fix-and-polish line (`1.0.41`, `1.0.42`, …, per the Versioning policy above) — the large volume of no-user-facing-feature refactor, integration-architecture, and hardening work, plus ongoing polish. **Codebase refactor & consolidation**: feature-first frontend vertical slices (#1309) — `app/` shell · `features/` (UI + pure `lib/` + slice + `index.ts` barrel) · `shared/` · `store/`, `@/…` alias; shared UI primitives (`Banner`/`Card`/`Button`/`StatTile`/`EmptyState`/`BackButton`/`IconButton`/`ModalScrim`/`Dialog`/…) + a consistency sweep; `Planning.tsx`+`FocusedBodies.tsx` decomposition, `handlePublish`→`publishSteps.ts`, reusable `usePoll`/`useGithubQuery`/`useCoordLog` + `safeInvoke`/`fireInvoke`; Rust consolidation (`bsc-cli-util`, Tauri-free `bsc-blueprint`/`bsc-project`/`bsc-tunnel`, `session/` domain, `src-tauri/prompts`→`data`, **plan.db as the sole fleet store**, `tests.rs` decomposed, reference-context removed). **Integrations as agent-authored connectors** (#1962): the planner probes a source and authors the connector manifest (probe→validate→try, captured as skills); native connectors/presets/catalog removed (#1976); dynamic Source pane + runtime OAuth. **Data-driven planner**: Rust-inline prose/stage-registry/role-capabilities/deploy-taxonomy extracted to `@data/*`; tag-parsing → `bsc`. **Planner/fleet hardening**: unified stage vocabulary (#1958) + milestone phases removed (#1942); Repos+Deploy→**Deployment** and Fleet+Streams→**Streams** (carded, collapsible); fleet-identity, warden re-quarantine, worker-trust/prompt, and triage-tab-naming fixes. |
| v1.0.5 | Planned | **The UI release** — an in-app, Claude-Design-like way to define each page, component, and animation, rendered live by the render-preview (closing the external Claude Design round-trip), plus **iterative UI loops** (generate → live-preview → refine in-app, the same tight loop the fleet runs for code) — **and finishing the maintenance bots** (#1957). |
| v2.0.0 | Planned | **Unification + rigorous semver.** Once every feature the maintainer wants is added and the app is a defined product, cut `2.0.0` and switch to **strict semver** (see the Versioning policy above) — the hand-off point where release discipline tightens. |

The agent-shell track shipped alongside v1.0.3 but is themed separately on the public [Roadmap](README.md#roadmap)
("Run on any model"). v1.0.3 is now **Complete** and **v1.0.4** is **Current**. When v1.0.4 is complete,
move it to **Complete** and promote **v1.0.5** to **Current**.

The *codebase refactor & consolidation* work (the frontend feature-first reorg, shared UI primitives,
large-file decomposition, Rust crate consolidation) plus the integration-architecture and planner/fleet
hardening was cut as the **v1.0.41** checkpoint — a labelled stop-gap on the v1.0.4 line, before v1.0.5.
(Semver note: `1.0.41` sorts *after* `1.0.5`, so it's a "1.0.4, revision 1" marker, not a number between
the two.) Its changes are stamped under the `[1.0.41]` CHANGELOG section; new post-checkpoint work
accrues under `[Unreleased]`. The full version-by-version breakdown lives in
[ROADMAP.md](ROADMAP.md).

## GitHub Workflow

### Branch strategy

```
{issue-number}-{short-description}  →  develop  →  main
```

- All feature/fix branches are cut from `develop`.
- PRs target `develop`. CI must pass before merge.
- `develop → main` is a separate PR; merge only when `develop` is stable.
- Never push directly to `main` or `develop`.

### Issue → branch → PR flow

1. Claim the GitHub Issue; confirm acceptance criteria.
2. Create the branch from the issue using `gh issue develop <number>` or the GitHub UI Development panel.
3. Implement the minimum changes to close the issue.
4. Push and open a PR targeting `develop`. Reference the issue with `Closes #N`.

### Parallel worktree agents

Independent issues are worked **concurrently**, each by an agent in its own **git worktree** so
parallel file edits never collide. Every worktree agent runs the same lifecycle — the commands below
are the full set it needs end to end.

**1 · Set up the worktree** (branch off the latest `develop`):
```bash
git fetch origin develop
git worktree add .claude/worktrees/{issue}-{short-description} -b {issue}-{short-description} origin/develop
```

**`node_modules` — nested worktrees need NO install.** A worktree created *nested under the repo
root* (the convention: `.claude/worktrees/<branch>/`) resolves every dependency from the repo-root
`node_modules` via Node/npm's normal upward directory walk — `tsc`, `vitest`, `eslint`, and the app's
imports all find it, and `npm run <script>` prepends every ancestor `node_modules/.bin` to PATH. So a
nested worktree is **zero-install**: 0 MB, 0 install time, and **safe to delete** (no local
`node_modules`, no junction → `git worktree remove` cannot wipe the shared install). This is enabled by
`server.fs.strict: false` in `vitest.config.ts`, which lets the install-free worktree read esbuild-wasm
from the shared ancestor `node_modules` (#1669).

> Two exceptions still need a **real** `npm install` in the worktree:
> - A **sibling / out-of-repo** worktree (e.g. `../bsc-1474-planning`) — it is not on the repo-root
>   resolution path.
> - You need `npx vite build` (the optional gate step) — Vite's dep pre-bundling wants deps physically
>   present; `typecheck` / `lint` / `test` do not.
>
> **NEVER** share `node_modules` via a junction/symlink: the junction breaks esbuild (wasm fs-deny) and
> `git worktree remove` follows it and wipes the main install. Use the nested zero-install pattern (or a
> real install), never a link.

**2 · Implement** the minimum change to close the issue, **with its tests in the same branch** (never after).

**3 · Verify — the gate (every command must pass; mirrors CI exactly):**
```bash
# Frontend (run when src/ changed)
npm run typecheck                                   # tsc --noEmit, must be clean
npm run lint                                        # eslint, 0 errors (react-compiler rules tsc/test miss)
npm test                                            # vitest run — all green
npx vite build                                      # optional: production bundle still builds

# Rust (run when src-tauri/ or crates/ changed)
cargo check --workspace
cargo clippy --workspace --all-targets -- -D warnings   # --all-targets — --lib misses test-target lints
cargo test --workspace                                  # or `-p <crate>` to scope a slow build
```

**4 · Commit** on the branch (do **not** push until approved); end the message with the agreed
`Co-Authored-By:` trailer.

**5 · Push + PR** (after approval): push the branch, then
`gh pr create --base develop --title "…" --body "… Closes #N"`.

**6 · Merge + clean up** once the PR's CI gate is green
(`gh pr merge <n> --merge --admin` — the PR run IS the integration test, so don't wait past green):
```bash
git push origin --delete {branch}
git worktree remove --force <worktree-path>          # real node_modules → safe; a junction is NOT
git branch -D {branch}                               # fails while the branch is checked out in a worktree
```

Gotchas:
- **Base drift:** a branch cut from an older `develop` can fail an *unrelated* test that broke on the
  current `develop` (the fleet pushes straight to `develop`, bypassing CI). Refresh with
  `git merge origin/develop` and re-push rather than chasing a phantom failure.
- The merge's `--delete-branch` aborts if the branch is checked out in a worktree — delete the **remote**
  branch, `git worktree remove --force` the worktree, then delete the **local** branch (order matters).

### Dependency order for UI issues

```
#2 scaffold
  └─ #3 CSS + chrome
       ├─ #4 pane system
       └─ #5 store + router
            ├─ #6 Console screen
            ├─ #8 GitHub screen
            ├─ #9 Automations screen
            └─ #10 Settings screen
```

Issues #4 and #5 can be worked in parallel after #3 merges. Issues #6–#10 can be worked in parallel after #4 and #5 merge.

## Design Reference

`design/` contains the full browser-rendered prototype (React JSX + Babel standalone). Every screen, component, color token, layout, and sample data set is defined there. When implementing a screen, match the design exactly — layout, inline styles, and CSS class usage. Do not modify files under `design/`.

## Companion App

**mobile-studio-code** lives in a separate repository. The WebSocket message schema between the two apps must stay in sync. Breaking changes to the tunnel protocol require coordinated PRs in both repos.
