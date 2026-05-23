# base-studio-code

Desktop host application for a multi-agent AI development workflow platform. Run many Claude coding agents in parallel across multiple repositories, with standardized knowledge injected per project based on its tech stack.

Pairs with **mobile-studio-code**, a companion app that tunnels into the desktop session so agents can be orchestrated from anywhere.

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

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © 2026 Kevin Lago
