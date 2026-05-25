# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**base-studio-code** is the desktop host application for a multi-agent AI development workflow platform. It pairs with **mobile-studio-code**, a companion mobile app that tunnels into the desktop session so agents can be orchestrated from anywhere. The desktop is authoritative — it owns the agent processes, GitHub connections, and knowledge stores. Mobile is a thin client.

The core value proposition: run many AI coding agents in parallel across multiple repositories, with standardized knowledge (prompts, GitHub Actions templates, automation recipes) injected per project based on its tech stack.

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust backend + WebView) |
| Frontend | React 18 + TypeScript, bundled with Vite |
| State management | Zustand |
| Styling | CSS custom properties (`src/styles/tokens.css`) |
| Fonts | Inter (sans) · JetBrains Mono (mono) via Google Fonts |
| Agent orchestration | Claude API (default: `claude-sonnet-4-6`) |
| Mobile tunnel | WebSocket server (`crates/ws-server`) — token auth + QR pairing |
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
├── WebSocket Server        — tunnel endpoint for mobile-studio-code       (crates/ws-server)
└── UI Shell                — Tauri WebView running the React frontend
```

```
mobile-studio-code (thin client — separate repo)
└── WebSocket Client        → connects to desktop host tunnel
    └── Mirrors console grid view + basic input
```

## Key Concepts

**Knowledge Block** — A named markdown blob tagged with stack identifiers (e.g., `rust`, `react`, `postgres`). Injected into an agent's system prompt or as a user message. Enables standardized GitHub Actions configs, code review checklists, and architecture patterns across all projects.

**Console** — A single agent session tied to a repo, model, and optional knowledge blocks. Multiple consoles run in parallel within a tab.

**Pane** — The UI cell that renders one console. Each pane has a swappable view (console chat, file tree, branch list, diff, commit log) selected via icon tabs. Configuration is exposed via the hamburger menu (model, repo, cwd).

**Tab** — A named workspace containing one CSS grid layout with N panes. Persists across sessions.

**Tunnel** — The WebSocket bridge between desktop and mobile. Desktop runs the server (`crates/ws-server`); mobile connects as a client. Authentication is token-based with QR pairing.

**Automation** — A cron-triggered rule that automatically dispatches a command or loads a knowledge block into a specified console pane.

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
