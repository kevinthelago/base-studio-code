# base-studio-code

[![CI](https://github.com/kevinthelago/base-studio-code/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinthelago/base-studio-code/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kevinthelago/base-studio-code/actions/workflows/codeql.yml/badge.svg)](https://github.com/kevinthelago/base-studio-code/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/kevinthelago/base-studio-code?include_prereleases&sort=semver)](https://github.com/kevinthelago/base-studio-code/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)

> **The CDE — Claude Development Environment.** It's like an IDE, except the thing you build *with* is a roomful of Claudes running in parallel. (Yes, we made the acronym up. No, we're not taking it back.) 🤖

Desktop host application for a multi-agent AI development workflow platform. Run many Claude coding agents in parallel across multiple repositories, with standardized knowledge injected per project based on its tech stack.

Pairs **optionally** with **mobile-studio-code**, a standalone companion app that can tunnel into a desktop session over a **zero-knowledge Cloudflare relay** — end-to-end encrypted (Noise IK), paired by QR — so the same agents can be driven from your phone, from anywhere.

## Project Blueprints & Pipelines

*The current focus of active development.* Planning is built from two composable pieces.

**Blueprints** are reusable planning templates. A Blueprint is an ordered list of planning **stages** — context, repos, UI design, structure, permissions, automations, skills — each with its own prompt module and attached pipelines. Pick one (built-ins: Default, Full-stack web app, Mobile MVP, API microservice) and it seeds every new project's planning session: which stages run, what Claude is told in each, and what happens to each stage's output. Stages are gated and dependency-aware — a stage stays locked until its prerequisites are met, and the planning progress bar tracks the state.

**Pipelines** are pluggable actions that run on a stage's output — on entering a stage, when an artifact changes, on completion, or manually. Some are **gates**: the stage can't complete until the pipeline passes. Built-ins include:

- **render-preview** — bundles the UI stage's generated screen skeletons with `esbuild-wasm` and renders them as a live, interactive **2D/3D walkthrough** in a sandboxed iframe, right inside the planning page — no preview server, no leaving the app. Approve screens one at a time to advance the UI stage.
- **lint-plan** — scans a stage's artifacts for gaps (empty files, unresolved placeholders) and blocks completion until they're resolved.
- …plus publish-side actions: issue generation, milestone sync, stream scoping, and skill indexing.

Together they drive the planning arc: **pitch → plan, stage by stage → live preview → gate checks → publish to GitHub → launch the fleet.**

> 🚧 Blueprints & Pipelines are under active development. The stage registry, the Blueprint editor, and the render-preview / lint-plan pipelines work today; the wider pipeline library and the execution-side conductor (staged build → test → review → integrate) are still being wired up.

## Features

- **Project planning → fleet orchestration** — a dedicated planning session turns a pitch or repo set into a publishable GitHub structure (milestones, granular issues, `stream:` labels), then launches a fleet: one least-privilege worker per stream in its own git worktree, coordinated by a director
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
│   ├── screens/        # Console, Projects (planning), Agents (profiles), KnowledgeStore, GitHub, Automations, Settings
│   ├── store/          # Zustand store
│   └── data/           # Mock/sample data
├── design/             # ⚠️ Reference prototype only — do not edit
└── docs/               # Architecture and design documentation
```

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator   — parallel Claude sessions (PTY) + planning/fleet
├── GitHub Integration   — OAuth, repos, PRs, Actions, hooks
├── Knowledge Store      — context blocks keyed by stack tag
├── Mobile relay client  — dials the zero-knowledge Cloudflare relay (Noise IK E2E)
└── UI Shell             — Tauri WebView + React frontend
```

## Versioning & Releases

base-studio-code is pre-1.0 and under active development. The `0.x` series is a **development preview** — features and internals may change between releases, and builds are published as previews for testing rather than general use.

**`1.0.0` will be the first official release** — the first version considered stable and ready for general use. Until then, versions are bumped conservatively (patch bumps for fixes, minor for features) so that `1.0.0` stays a meaningful milestone rather than just the next number.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © 2026 Kevin Lago
