# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**base-studio-code** is the desktop host application for a multi-agent AI development workflow platform. It pairs with **mobile-studio-code**, a companion mobile app that tunnels into the desktop session so agents can be orchestrated from anywhere. The desktop is authoritative — it owns the agent processes, GitHub connections, and knowledge stores. Mobile is a thin client.

The core value proposition: run many AI coding agents in parallel across multiple repositories, with standardized knowledge (prompts, GitHub Actions templates, automation recipes) injected per project based on its tech stack.

## Technology Decisions (TBD — record here as stack is chosen)

This section should be updated once the tech stack is decided. Candidates to evaluate:

- **Desktop shell**: Tauri (Rust + WebView), Electron, or native Rust TUI
- **Agent orchestration**: Claude API with parallel streaming sessions
- **Tunneling to mobile**: WebSocket server on desktop, client on mobile (or ngrok-style relay)
- **Storage**: SQLite (via `rusqlite` or `sqlx`) for settings, knowledge stores, conversation history
- **Frontend (if web-based)**: React or Svelte

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator      — spawns/manages parallel Claude API sessions
├── GitHub Integration      — OAuth, repo selection, PR/issue access
├── Knowledge Store         — injectable context blocks keyed by tech stack tag
├── Automation Engine       — user-defined triggers → agent actions
├── WebSocket Server        — tunnel endpoint for mobile-studio-code
└── UI Shell                — tabbed console grid, settings, store editor
```

```
mobile-studio-code (thin client)
└── WebSocket Client        — connects to desktop host tunnel
    └── Mirrors console grid view + basic input
```

## UI Layout

### 1. Main Console View (Primary Screen)

The main workspace. A configurable grid of agent consoles. Grid sizes: 1×1, 1×2, 2×2, 2×3, 3×3, 4×4, 5×5.

```
┌─────────────────────────────────────────────────────────────┐
│  [base-studio]  [Tab 1 ▼]  [Tab 2 ▼]  [+ New Tab]   [⚙ Settings] │
├─────────────────────────────────────────────────────────────┤
│  Layout: [1×1] [1×2] [2×2] [2×3] [3×3] …   [+ Agent]       │
├──────────────────────┬──────────────────────────────────────┤
│                      │                                      │
│  Agent Console A     │  Agent Console B                    │
│  ─────────────────   │  ─────────────────                  │
│  Repo: my-api        │  Repo: mobile-studio-code           │
│  Model: sonnet-4.6   │  Model: opus-4.7                    │
│  Status: ● Running   │  Status: ○ Idle                     │
│                      │                                      │
│  > fix auth bug      │  > write unit tests for...          │
│  [assistant output…] │  [assistant output…]                │
│                      │                                      │
│  ──────────────────  │  ──────────────────                 │
│  [  User input...  ] │  [  User input...  ]                │
│  [Send] [Inject ▼]   │  [Send] [Inject ▼]                  │
└──────────────────────┴──────────────────────────────────────┘
```

Each console panel is independently configured with: repo, model, system prompt/persona, and injected knowledge blocks. "Inject ▼" opens a picker for knowledge store entries relevant to that repo's stack.

### 2. Tab Configuration

Each top-level tab is a named workspace with its own grid layout and set of agent consoles. Tabs persist across sessions.

```
┌───────────────────────────────────────────┐
│  Tab Name:  [ Backend Work              ] │
│  Grid:      [2×2 ▼]                       │
│                                           │
│  Console Slots:  [A] [B] [C] [D]          │
│  — Each slot: repo, model, initial prompt │
│                                           │
│  [Save]   [Delete Tab]                    │
└───────────────────────────────────────────┘
```

### 3. Settings — GitHub

```
┌─────────────────────────────────────────────────┐
│  GitHub                                         │
│  ─────────────────────────────────────────────  │
│  Account:    [ Connect GitHub Account ]         │
│  Connected:  @kevinthelago  ✓                   │
│                                                 │
│  Repositories                                   │
│  ─────────────────────────────────────────────  │
│  [ ] org/repo-a         [ ] org/repo-b          │
│  [x] kevinthelago/api   [x] kevinthelago/mobile │
│  [Search repos…]                                │
│                                                 │
│  Default branch strategy: [develop → main ▼]   │
│  [Save]                                         │
└─────────────────────────────────────────────────┘
```

### 4. Settings — Integrations

```
┌─────────────────────────────────────────────────┐
│  Integrations                                   │
│  ─────────────────────────────────────────────  │
│  Claude API                                     │
│    Key: [••••••••••••••••]  [Verify]            │
│    Default model: [claude-sonnet-4-6 ▼]         │
│                                                 │
│  Mobile Tunnel                                  │
│    Status: ● Listening on ws://localhost:7734   │
│    Auth token: [auto-generated]  [Regenerate]  │
│    [Show QR for mobile pairing]                 │
│                                                 │
│  Future: Linear, Slack, Jira, Sentry…           │
└─────────────────────────────────────────────────┘
```

### 5. Settings — Automations

User-defined trigger → action rules that fire agents automatically.

```
┌─────────────────────────────────────────────────────────────┐
│  Automations                          [+ New Automation]    │
│  ─────────────────────────────────────────────────────────  │
│  ▸ On PR opened in kevinthelago/api                         │
│    → Run agent: "Review PR against CLAUDE.md standards"     │
│    → Inject: [github-actions/node, code-review-checklist]   │
│    Status: ● Enabled                  [Edit] [Delete]       │
│                                                             │
│  ▸ On new GitHub Issue assigned to me                       │
│    → Run agent: "Draft implementation plan as comment"      │
│    Status: ○ Disabled                 [Edit] [Delete]       │
│                                                             │
│  Automation Editor:                                         │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Trigger: [GitHub Event ▼]  Event: [PR Opened ▼]     │   │
│  │ Filter:  Repo [kevinthelago/api ▼]                  │   │
│  │ Action:  [Run Agent ▼]                              │   │
│  │ Prompt:  [____________________________________]     │   │
│  │ Inject:  [Select knowledge blocks…]                 │   │
│  │ [Save]  [Cancel]                                    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 6. Knowledge Store

Reusable context blocks injected into agent conversations. Each block is tagged with one or more tech stack identifiers so the UI can suggest relevant blocks per repo.

```
┌─────────────────────────────────────────────────────────────┐
│  Knowledge Store                    [+ New Block]           │
│  ─────────────────────────────────────────────────────────  │
│  Filter: [All ▼]   Search: [________________]               │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ [rust] [tauri]  CI/CD — GitHub Actions (Rust/Tauri)  │  │
│  │ Cross-platform build matrix, cargo test, clippy…     │  │
│  │                              [Edit] [Delete] [Copy]  │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ [typescript] [react]  Code Review Checklist           │  │
│  │ Accessibility, bundle size, hook rules…               │  │
│  │                              [Edit] [Delete] [Copy]  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  Block Editor:                                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Name:  [________________________________]           │   │
│  │ Tags:  [rust] [tauri] [+ add tag]                   │   │
│  │ Body:  (markdown, injected verbatim into context)   │   │
│  │ ┌───────────────────────────────────────────────┐  │   │
│  │ │                                               │  │   │
│  │ │  # GitHub Actions — Rust                      │  │   │
│  │ │  ...                                          │  │   │
│  │ └───────────────────────────────────────────────┘  │   │
│  │ [Save]  [Cancel]                                    │   │
│  └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

### 7. Mobile View (mobile-studio-code mirror)

The mobile app displays the same grid but condensed. Tapping a console expands it full-screen. Input is available but layout controls are read-only from mobile (grid is configured on desktop).

```
┌─────────────────────┐
│  base-studio  ⚡ ▤  │
├─────────────────────┤
│  ┌────────┬───────┐ │
│  │Agent A │Agent B│ │
│  │● Run.. │○ Idle │ │
│  └────────┴───────┘ │
│  ┌────────┬───────┐ │
│  │Agent C │Agent D│ │
│  │● Run.. │● Run..│ │
│  └────────┴───────┘ │
├─────────────────────┤
│  Tap console to     │
│  expand & interact  │
└─────────────────────┘
```

## Key Concepts

**Knowledge Block** — A named markdown blob tagged with stack identifiers (e.g., `rust`, `react`, `postgres`). Injected into an agent's system prompt or as a user message before the conversation. Enables standardized GitHub Actions configs, code review checklists, architecture patterns, etc. across all projects.

**Console** — A single agent session tied to a repo, model, and optional knowledge blocks. Multiple consoles run in parallel within a tab.

**Tab** — A named workspace containing one grid layout with N consoles. Persists between sessions.

**Tunnel** — The WebSocket bridge between desktop and mobile. Desktop runs the server; mobile connects as a client. Authentication is token-based with QR pairing for convenience.

**Automation** — An event-driven rule (GitHub webhook, schedule, etc.) that automatically spawns an agent with a pre-configured prompt and knowledge injection.

## Companion App

**mobile-studio-code** lives in a separate repository. The integration contract between the two apps (tunnel protocol, message schema) must be kept in sync. Any breaking changes to the WebSocket message format require coordinated updates in both repos.

## Development Notes

- This repository (`base-studio-code`) is the desktop host. It owns the authoritative state.
- All agent sessions are managed here; mobile is display/input only.
- Commit to `develop` branch for all features; `main` is production-stable.
- Branch naming: `{issue-number}-{short-description}` branched from `develop`.
