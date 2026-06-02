THIS APPLICATION CREATES BY DEFAULT ISSUES, MILESTONES, REPOSITORIES, ECT. please be aware! the project planning page will show you everything that will be done

# base-studio-code

Desktop host application for a multi-agent AI development workflow platform. Run many Claude coding agents in parallel across multiple repositories, with standardized knowledge injected per project based on its tech stack.

Pairs with **mobile-studio-code**, a companion app that tunnels into the desktop session so agents can be orchestrated from anywhere.

## Roadmap

Building toward **1.0.0** — the first official release — one focused release at a time. Work runs in parallel across milestones; **0.6.0 (Knowledge Base)** is the named development preview, while the multi-agent **planning + fleet orchestration** (0.7.0) is where most of the active work is right now.

| Version | Focus | Status |
|---|---|---|
| 0.6.0 | **Knowledge Base** — UX rework, T-layout, doc-assignment, resizable panes | in progress (~4/7) |
| 0.7.0 | **Automations & multi-agent planning** — cron scheduling + plan → publish → fleet | in progress (~11/15) |
| 0.8.0 | **Extensions (MCP)** — agent-facing tooling via an in-process MCP host + hooks | early (~1/3) |
| 0.9.0 | **Tunneling, mobile & security** — token-authed WS tunnel + relay + pairing + repo-scoped credentials | in progress (~9/12) |
| 1.0.0 | **First official release (GA)** — feature pages polished, code signing, packaging, publish | planned (~7/12) |

### In flight now — the planning → orchestration loop (0.7.0)

- **Project planning page** — repo-first milestone/issue structure, per-agent permission + flow editor, context-file viewer
- **Plan → GitHub sync** — milestones, issues, and `stream:` labels created per pane section; plan docs pushed to each repo
- **Fleet launch** — one worker per stream in its own git worktree + branch, least-privilege profiles, a director at the project hub
- **Console hardening** — broadcast mode, pane/tab/view navigation hotkeys, font zoom

### Still to do before 1.0.0

- **0.6.0** — finish the Knowledge Base page (remaining UX + empty/first-run states)
- **0.8.0** — the in-process MCP extension host + server-management UI
- **1.0.0** — GitHub-screen review polish, Windows/macOS code signing + packaging, the release pipeline

Tracked as [GitHub milestones](https://github.com/kevinthelago/base-studio-code/milestones). The `0.x` series is a development preview — see [Versioning & Releases](#versioning--releases).


## Features

- **Parallel agent sessions** — multiple PTY-backed console panes per workspace tab, each tied to its own Claude instance
- **Live git context** — repo name, branch, and dirty status auto-detected from the shell's working directory
- **Knowledge Store** — named markdown blocks tagged by tech stack, injected into agent system prompts
- **GitHub integration** — OAuth/PAT auth, repo overview, Actions workflows, and webhook management
- **Automations** — cron-scheduled commands and knowledge injections across panes
- **Persist & restore** — workspace layout, pane names, and working directories survive restarts

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust + WebView2 / WebKit) |
| Frontend | React 18 + TypeScript, bundled with Vite |
| State | Zustand v5 with `persist` middleware |
| Terminal | xterm.js v5 + portable-pty (ConPTY on Windows) |
| Styling | CSS custom properties (`src/styles/tokens.css`) |
| Fonts | Inter · JetBrains Mono (Google Fonts) |
| Agent API | Anthropic Claude API (`claude-sonnet-4-6` default) |

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 20+
- [Rust](https://rustup.rs/) stable
- [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your platform

### Install

```bash
git clone https://github.com/kevinthelago/base-studio-code
cd base-studio-code
npm install
```

### Run

```bash
# Frontend-only dev server (hot-reload, no native window)
npm run dev

# Full Tauri app with native window + hot-reload
npm run tauri -- dev

# Production build
npm run tauri -- build
```

### Other commands

```bash
npm run typecheck   # TypeScript type-check without emit
npm run lint        # ESLint
npm run format      # Prettier
cargo test          # Rust backend tests
```

## Project Structure

```
base-studio-code/
├── src-tauri/          # Rust backend (Tauri v2)
│   ├── src/lib.rs      # PTY, git info, file picker, API proxy commands
│   └── tauri.conf.json
├── src/                # React frontend
│   ├── App.tsx         # Shell (Titlebar + Rail + screen switcher)
│   ├── styles/
│   │   └── tokens.css  # Design tokens + base styles
│   ├── components/
│   │   ├── chrome/     # Titlebar, Rail, Tabstrip, StatusBar
│   │   └── pane/       # PaneShell, ViewTabs, PaneMenu, views/
│   ├── screens/        # Console, KnowledgeStore, GitHub, Automations, Settings
│   ├── store/          # Zustand store
│   └── data/           # Mock/sample data
├── design/             # ⚠️ Reference prototype only — do not edit
└── docs/               # Architecture and design documentation
```

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator   — parallel Claude API sessions
├── GitHub Integration   — OAuth, repos, PRs, Actions, hooks
├── Knowledge Store      — context blocks keyed by stack tag
├── WebSocket Server     — tunnel for mobile-studio-code
└── UI Shell             — Tauri WebView + React frontend
```

## Versioning & Releases

base-studio-code is pre-1.0 and under active development. The `0.x` series is a **development preview** — features and internals may change between releases, and builds are published as drafts for testing rather than general use.

**`1.0.0` will be the first official release** — the first version considered stable and ready for general use. Until then, versions are bumped conservatively (patch bumps for fixes, minor for features) so that `1.0.0` stays a meaningful milestone rather than just the next number.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © 2026 Kevin Lago
