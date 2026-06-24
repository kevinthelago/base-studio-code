# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**base-studio-code** is the desktop host application for a multi-agent AI development workflow platform. The desktop is authoritative — it owns the agent processes, GitHub connections, and knowledge stores. It pairs with **mobile-studio-code**, a **standalone** mobile app (its own repo, usable on its own) that can **optionally tunnel** into a desktop session — over a zero-knowledge Cloudflare relay, end-to-end encrypted (Noise IK) — so the same agents can be driven from a phone, from anywhere.

The core value proposition: run many AI coding agents in parallel across multiple repositories, with standardized knowledge (prompts, GitHub Actions templates, automation recipes) injected per project based on its tech stack.

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust backend + WebView) |
| Frontend | React 18 + TypeScript, bundled with Vite |
| State management | Zustand |
| Styling | CSS custom properties (`src/styles/tokens.css`) |
| Fonts | Inter (sans) · JetBrains Mono (mono) via Google Fonts |
| Agent orchestration | Claude Code (default) or the model-agnostic `bsc-agent` shell; pluggable `LlmProvider` — Anthropic (`claude-sonnet-4-6` default), OpenAI, Gemini, local (`crates/llm`) |
| Mobile tunnel | Relay client (`src-tauri/src/tunnel.rs`) dialing a zero-knowledge Cloudflare Worker relay (`relay/`) — Noise IK E2E + QR pairing |
| Storage | SQLite (`crates/kb`, `crates/orch`) |

## Testing

Every feature or bug fix must include tests as part of the same branch — never after. Tests are not optional.

| What changed | What to test |
|---|---|
| New store action | Unit test covering the action's state transitions and edge cases |
| New component | Render smoke test + interaction tests for each user-facing behavior |
| New Rust command | Unit test or integration test in `src-tauri/src/lib.rs` `#[cfg(test)]` module |
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
│   ├── Cargo.toml           # workspace
│   ├── tauri.conf.json
│   └── src/main.rs          # Tauri entry; registers commands
├── src/                     # React frontend (TypeScript)
│   ├── main.tsx             # Vite entry; imports tokens.css
│   ├── App.tsx              # Shell (Titlebar + Rail + screen switcher)
│   ├── styles/
│   │   └── tokens.css       # Design tokens, base component styles
│   ├── components/
│   │   ├── chrome/          # Titlebar, Rail, Tabstrip, StatusBar
│   │   └── pane/            # PaneShell, ViewTabs, HamburgerMenu
│   │       └── views/       # ConsoleView, FilesView, BranchesView, ChangesView, LogView
│   ├── screens/
│   │   ├── Console.tsx
│   │   ├── KnowledgeStore.tsx
│   │   ├── github/          # index (GitHubShell), Empty, Overview, Actions, Hooks
│   │   ├── automations/     # index (AutomationShell), Schedules, Commands
│   │   └── settings/        # index (SettingsShell), GitHub, Integrations
│   ├── data/
│   │   └── mock.ts          # All typed sample data extracted from design files
│   └── store/
│       └── index.ts         # Zustand store
├── design/                  # ⚠️  REFERENCE ONLY — do not edit
│   └── *.jsx / styles.css   # Browser-rendered design prototype (Babel standalone)
└── package.json
```

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator      — spawns/manages parallel Claude API sessions  (crates/orch)
├── GitHub Integration      — OAuth, repo selection, PR/issue access       (crates/gh)
├── Knowledge Store         — injectable context blocks keyed by stack tag  (crates/kb)
├── Mobile relay client     — dials the Cloudflare relay for mobile pairing (src-tauri/src/tunnel.rs)
└── UI Shell                — Tauri WebView running the React frontend
```

```
mobile-studio-code (standalone app — separate repo; usable on its own)
└── Relay client (optional) → tunnels into a desktop session via the relay
    └── Mirrors console grid view + basic input
```

## Key Concepts

**Knowledge Block** — A named markdown blob tagged with stack identifiers (e.g., `rust`, `react`, `postgres`). Injected into an agent's system prompt or as a user message. Enables standardized GitHub Actions configs, code review checklists, and architecture patterns across all projects.

**Console** — A single agent session tied to a repo, model, and optional knowledge blocks. Multiple consoles run in parallel within a tab.

**Pane** — The UI cell that renders one console. Each pane has a swappable view (console chat, file tree, branch list, diff, commit log) selected via icon tabs. Configuration is exposed via the hamburger menu (model, repo, cwd).

**Tab** — A named workspace containing one CSS grid layout with N panes. Persists across sessions.

**Tunnel** — The **optional** bridge between desktop and the standalone mobile app. Both peers dial out to a **zero-knowledge Cloudflare relay** (`relay/`); the desktop runs the relay client (`src-tauri/src/tunnel.rs`) and the session is end-to-end encrypted with **Noise IK** (the relay only ever sees ciphertext). Pairing is by QR.

**Automation** — A cron-triggered rule that automatically dispatches a command or loads a knowledge block into a specified console pane.

## Project Planning

The flagship feature. A **dedicated, app-owned planning session** turns a pitch (new project) or an existing repo set into a complete, executable plan: the feature breakdown, the GitHub structure (milestones + granular issues), the parallel-agent fleet, and the context files every downstream session runs under. The user steers the conversation; the planner produces everything. Entry: `src/screens/projects/` (Planning.tsx, ProjectsList.tsx); backend setup: `src-tauri/src/lib.rs` (`setup_workspaces`).

### The right pane — focused plan view (#652)
The planning page is a split: the live Claude session (terminal, center) + the **focused project pane** (`ProjectPane.tsx`, `focus` mode). The pane shows **one phase at a time** — a navigable **stepper** (per-phase status from `sectionStatus`: complete/active/locked/upcoming, incomplete phases pulse), a phase header with a **gate pill** (`evalGate`), lock/done banners, the phase body (Context / Structure+grade+lens / Permissions+director, else a generic card), and a **footer advance bar** (back · jump/back-to-current · approve & continue when the gate passes · publish). It auto-follows the live session (`currentSection` = active phase) while letting the user navigate; selection resets on a project/blueprint switch. Pure model: `focusedPlan.ts`; shell: `FocusedShell.tsx`. (Replaced the all-sections scroll + the full-width N-bar.)

### Blueprints — the lifecycle library (#609 / #645 / #636 / #647)
A **blueprint** is the reusable template that seeds a project's plan: an ordered set of stages, each with a prompt module, **pipelines**, a declarative **gate** (`gateRule` → `evalGate`), an optional **output disposition**, and attached **skills**. Model: `src/screens/projects/blueprints.ts`; UI: `BlueprintsPage.tsx` (library + drag-reorder editor + Design-with-Claude assistant).
- **Category + mode (#645):** every blueprint carries a lifecycle `category` — **greenfield** (create from a pitch), **transform** (restructure existing repos), **harden** (improve in place), **maintain** — and a `mode` (`create` vs `operate`, which selects the planner intro). The Library groups/filters/searches by category. Built-ins: Default / Full-stack / Mobile / API (greenfield) + Refactor & Cleanup, Split / Combine microservices, Migrate (transform) + Harden security (harden). Domain greenfields (CAD, simulation) stay out of the packaged app — catalog later (#649).
- **Skills (#636):** a section (or the whole blueprint) can attach reusable **skills / knowledge** — the KB blocks + Skills library, unified (`blueprintSkills.ts`). They're resolved and written to the hub's `skills.md` for the planner, and inlined into each worker's `CLAUDE.local.md` at fleet launch (`ensure_worktree`). The assistant can author + attach new ones.
- **Switching (#647):** `projectBlueprintId` records which blueprint seeded a project; opening one whose blueprint differs from the selected one prompts to **reset** (re-seed + clear progress/grades + restart, `applyBlueprintToProject`), **keep**, or export files first.

### The project key
`effectiveProjectId = planningSessionKey || activeProjectId || planningTitle || planningPitch` (Planning.tsx). In practice `planningSessionKey` wins and is set to the project **title/name** when planning starts (`setPlanningSession(title)`). `sanitize_project_key` (lib.rs) slugifies it: keep `[A-Za-z0-9-]`, everything else to `_`, cap 80 chars. **WARNING: the key is title-derived, not a stable id** — renaming the project changes the key (and its on-disk paths), and two same-titled projects collide. (Open item: mint a stable id at project creation and key the workspaces off that.)

### Workspace layout
`setup_workspaces` creates the project hub at `~/.base-studio-code/projects/<key>/`:
- `CLAUDE.md` — *currently* the planner spec (see "Session roles + the CLAUDE.md model")
- `.claude/settings.json` — planner permissions (read/write md + WebFetch + git/gh)
- plan **section files**, flat: `goal.md`, `scope.md`, `stack.md`, `architecture.md`, …
- `phases.json` (milestones), `issues.json` (granular issues), `fleet.json` (streams)
- `prompts/` — kickoff scripts the planner authors (`<stream>-kickoff.md`, `director-kickoff.md`)
- `kb_index.md`, `automations.md`, `github_context.md`
- linked repos cloned in as subdirs (`<key>/<repo>/`); fleet worktrees under `<key>/.worktrees/`

### The planner is plan-only
Role gate #219: `git: read`, `github: read`, `code: none`. It reads for context and writes plan files, but cannot edit project code, commit, push, or open PRs. Publishing the GitHub structure is done by the **app** (`handlePublish`), not the planner's shell.

### The planning workflow (driven by the planner CLAUDE.md template in lib.rs)
1. Link repositories; read the Knowledge Base.
2. **Discovery checklist** (goal, users, scope, ux, stack, architecture, schema, api, security, testing, …) — scan, propose, confirm, one topic at a time. Each becomes a section file + a `<plan_update>` tag (the right panel reveals it live).
3. **Develop the GitHub structure — the feature workshop** (#318, the deep interactive core): map the features, drive each down (behavior + acceptance / build approach / tools / data + deps), propose-then-interrogate, one feature at a time, then sequence into phases.
4. **Granular, agent-ready issues** (#311, `issues.json`): each `PlanIssue` carries acceptance criteria, owned files, dependencies, labels, milestone, owning stream — enough that an agent finishes without asking.
5. **Plan the agent fleet** (`fleet.json`): non-overlapping streams (owns globs, issues, dependsOn), recommended session count, optional director.
6. **Publish** (`handlePublish`): repos, project board, one milestone per phase, one GitHub issue per `PlanIssue` (body = acceptance + owns + deps, pinned to its milestone), `stream:<id>` labels.

### Per-agent configuration set during planning
- **Profiles** (#289, `src/screens/agents/`): a least-privilege `AgentProfile` (commands / tools / write-paths / net) per stream, applied at launch.
- **Flows** (#297, `src/screens/projects/agentFlow.ts`): `autonomy` (continuous/checkpoint/confirm) + `push` (auto-pr/push-confirm/commit-only/none) + `trigger` + `gate` — drives each agent's git/gh permissions, kickoff prose, and pause-visibility.

### Session roles + the CLAUDE.md model (and a known issue)
Three kinds of session live around a project, each needing **different** context:
- **Planner** — the planning spec; plan-only.
- **Orchestrator / director** — coordinates the fleet (review/merge PRs, resolve logged decisions, keep the board current); never plans or writes feature code.
- **Agents / workers / triage** — execute their assigned issue in a worktree, guided by their repo `CLAUDE.md` + `CLAUDE.local.md` (the plan) + their kickoff.

**Current state:** the planner spec is written to `projects/<key>/CLAUDE.md`, which is the **ancestor of every execution session** (director + workers run under `projects/<key>/`). Claude Code loads `CLAUDE.md` from the cwd and every parent, so the planner spec leaks into those sessions and they get pulled toward planning. A `READ FIRST` scope guard at the top of the planner CLAUDE.md is the interim band-aid (#320/#331).

**Intended architecture (in progress):** the planning session is **isolated in its own tree** (not an ancestor of the repos), `projects/<key>/CLAUDE.md` becomes the **orchestrator** spec, and the planner **generates** the orchestrator + agent context files as deliverables. Converge on this when touching `setup_workspaces` / the planning launch / `fleetStartProject`.

## Console — the execution surface

Where the planned work runs. A **tab** holds a CSS-grid of **panes**; each pane is a PTY session running `claude` in a repo or worktree, with swappable **views** (console chat, files, branches, changes, log). Backend: `pty_create` in lib.rs; launch wiring: `src/components/pane/views/TerminalView.tsx` + `fleetStartProject` in `src/store/index.ts`.

### Session roles + the role gate (#219, `src/lib/sessionRoles.ts`)
Every session has a role bounding its capabilities (least privilege), applied at launch via `ensure_session_settings` to `.claude/settings.json`:

| Role | git | github | code |
|---|---|---|---|
| planner | read | read | none |
| worker | write | read | write (owned globs only) |
| director | write | write | none |
| triage | none | write | none |
| tester / reviewer / conductor | read | read | none |

`roleDeniedCommands` denies the mutating git/gh commands a role cannot run; `roleWriteRules` denies/scopes the file-write tools. The session allows Bash broadly and guarantees `gh`/`git` on PATH; Claude Code precedence is **deny > ask > allow**.

### The fleet (`fleetStartProject`)
One click fills a build tab:
- **Director** at the project hub (`projects/<key>/`), kickoff `prompts/director-kickoff.md` — sees every repo + worktree; coordinates, never writes feature code.
- **Workers** each in their own **git worktree** (`projects/<key>/.worktrees/<repo>--<id>/`) on a **branch named after the stream id**, seeded with `CLAUDE.local.md` (the plan, copied in by `ensure_worktree`) and the stream's kickoff (`prompts/<id>-kickoff.md`, else `buildStreamPrompt`). Per-agent profile + flow applied.

### Per-agent flow at launch (#297)
Drives: which git/gh writes auto-approve vs **prompt** (the `ask` tier for a hard push-confirm gate) vs deny; the autonomy + push paragraph in the kickoff; and a coordination wake when a checkpoint/confirm agent pauses. The flow's push policy is the **authority** over `git push` / `gh pr create` and lifts the role gate's broad gh-write deny for exactly those two (#304) — so an `auto-pr` worker can open its own PR while `gh pr merge` / repo-delete stay role-denied.

### Coordination (#199, `src/lib/coordination.ts`)
Agents emit structured events to an app-wide `coord.log`: `bsc-blocked --on <ref>` (waiting on a dependency), `bsc-wait` (paused for the user, #297), and the satisfy emitters `bsc-landed/merged/closed/failed`. The **Coordination inbox** (`CoordinatorInbox`) shows blocked / paused / ready sessions; one whose deps land (or that the user resumes) is **woken** — relaunched fresh with a token-aware wake prompt. Auto-wake is opt-in (`useCoordinator`).

### bsc-* shell helpers
Installed into every session via `BASH_ENV` to `~/.base-studio-code/bsc-env.sh` (written by `pty_create`): `bsc-checkpoint` (resume note), `bsc-note` / `bsc-blocked` (DECISIONS.md + coord events), `bsc-audit` (#257 tool-attempt log), `bsc-confine` (#158 FS confinement), `bsc-wait` + the coord emitters. **WARNING: each rc constant must end with a trailing newline** or the concatenated shell functions glue together and the whole rc breaks with a syntax error (#296) — the `full_bsc_rc_is_syntactically_valid_bash` test guards this.

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

### Roadmap

| Version | Status | Theme |
|---|---|---|
| v1.0.3 | Complete | User experience, resiliency, and the core **Default** (greenfield) blueprint and its **triage** — the progress-gated relaunch that resumes from plan.db and skips completed workers. Running in parallel, the **model-agnostic agent shell** (`bsc-agent`, epic #1078) lets the platform run on any LLM (Anthropic/OpenAI/Gemini/local); Claude Code stays the default until parity. |
| **v1.0.4** | **Current** | **Enterprise integration & migration** — connect **read-only** to an existing system (CRM/ERP/BPM, Salesforce first) and **scan the whole platform**: data types *and* configurations *and* behaviors. The planner produces a **Platform Behavior Summary** — objects/fields, automations (validation rules, workflows, Flows/Process Builder), business processes (approval processes), and derived logic (formula fields, Apex) — so **automations, business processes, and data are all migratable**: reproduced as the generated app's schema and logic via canonical **data models** + MCP connectors, with a compliance layer baked into the planner. |
| v1.0.5 | Planned | **The UI release** — an in-app, Claude-Design-like way to define each page, component, and animation, rendered live by the render-preview (closing the external Claude Design round-trip), plus **iterative UI loops** (generate → live-preview → refine in-app, the same tight loop the fleet runs for code). |

The agent-shell track shipped alongside v1.0.3 but is themed separately on the public [Roadmap](README.md#roadmap)
("Run on any model"). v1.0.3 is now **Complete** and **v1.0.4** is **Current**. When v1.0.4 is complete,
move it to **Complete** and promote **v1.0.5** to **Current**.

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

### Dependency order for UI issues

```
#2 scaffold
  └─ #3 CSS + chrome
       ├─ #4 pane system
       └─ #5 store + router
            ├─ #6 Console screen
            ├─ #7 Knowledge Store screen
            ├─ #8 GitHub screen
            ├─ #9 Automations screen
            └─ #10 Settings screen
```

Issues #4 and #5 can be worked in parallel after #3 merges. Issues #6–#10 can be worked in parallel after #4 and #5 merge.

## Design Reference

`design/` contains the full browser-rendered prototype (React JSX + Babel standalone). Every screen, component, color token, layout, and sample data set is defined there. When implementing a screen, match the design exactly — layout, inline styles, and CSS class usage. Do not modify files under `design/`.

## Companion App

**mobile-studio-code** lives in a separate repository. The WebSocket message schema between the two apps must stay in sync. Breaking changes to the tunnel protocol require coordinated PRs in both repos.
