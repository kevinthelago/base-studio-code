# base-studio-code

Desktop host application for a multi-agent AI development workflow platform. Run many Claude coding agents in parallel across multiple repositories, with standardized knowledge injected per project based on its tech stack.

Pairs with **mobile-studio-code**, a companion app that tunnels into the desktop session so agents can be orchestrated from anywhere.

## Roadmap

Everything currently in development lands in **0.6.0**; later milestones cover what comes after, on the way to **1.0.0** (the first official release). Latest shipped: **0.5.1**.

| Version | Focus |
|---|---|
| 0.6.0 | **Current development** — Knowledge Base UX, Automations, Extensions (agent-facing MCP tooling), and multi-agent planning |
| 0.9.0 | **Tunneling & mobile integration** — secure WebSocket tunnel + mobile-studio-code pairing |
| 1.0.0 | **First official release** — GA polish + publish |

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
