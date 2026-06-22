> ⚠️ **This application creates issues, milestones, repositories, etc. by default — please be aware!** The project planning page will show you everything that will be done before it happens.

> 📍 **Where we are:** `1.0.3` is the **current version — in active development**, focused on **user experience, resiliency, and the core Default (greenfield) blueprint and its triage**. We release builds early and keep improving a version until its theme is complete, so `1.0.3` is *Current*, not done. Landed so far: a foolproof, stripped-down **Default** blueprint (advanced stages moved to a new **Complete** blueprint), the planner consolidation (Blueprints folded into the planner page, live render-preview), the plan working-store moved to **plan.db**, **crash recovery** (one-click restore after an unclean shutdown), and **progress-gated triage** (resumes from plan.db and skips workers that already finished). **Next up is `1.0.4` — enterprise integration & migration:** pull data from the systems businesses already run on — **ERP, CRM, BPM** and others — into canonical **data models**, then generate your own **bespoke software** to replace them, with compliance baked in. See the [Roadmap](#roadmap).

# base-studio-code

[![CI](https://github.com/kevinthelago/base-studio-code/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinthelago/base-studio-code/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kevinthelago/base-studio-code/actions/workflows/codeql.yml/badge.svg)](https://github.com/kevinthelago/base-studio-code/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/kevinthelago/base-studio-code?include_prereleases&sort=semver)](https://github.com/kevinthelago/base-studio-code/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)

> **The CDE — Claude Development Environment.** It's like an IDE, except the thing you build *with* is a roomful of Claudes running in parallel. (Yes, we made the acronym up. No, we're not taking it back.) 🤖

Desktop host application for a multi-agent AI development workflow platform. Run many Claude coding agents in parallel across multiple repositories, with standardized knowledge injected per project based on its tech stack.

Pairs **optionally** with **mobile-studio-code**, a standalone companion app that can tunnel into a desktop session over a **zero-knowledge Cloudflare relay** — end-to-end encrypted (Noise IK), paired by QR — so the same agents can be driven from your phone, from anywhere.

## Project Blueprints

*A core feature of the platform.* A **Blueprint** is a reusable planning template — an ordered list of planning **stages** (context, repos, UI design, structure, permissions, …), each with its own prompt module, a declarative completion **gate**, and optional attached **skills / knowledge**. Pick one — built-ins span the project lifecycle: **greenfield** (Default, Complete), **transform** (Refactor & Cleanup, Split / Combine microservices, Migrate stack), **harden** (Harden security), and **data** (Data migration, Data collection) — searchable and filterable by category. It seeds every new project's planning session: which stages run, what Claude is told in each, and what happens to each stage's output. You can also **author your own blueprint** in the planner and publish it to a gist to share. Stages are gated and dependency-aware — a stage stays locked until its prerequisites are met, and the planning progress bar tracks the state.

A standout capability is the **live UI preview**: the UI stage's generated screen skeletons are bundled with `esbuild-wasm` and rendered as an interactive **2D/3D walkthrough** in a sandboxed iframe, right inside the planning page — no preview server, no leaving the app. Approve screens one at a time to advance the stage.

The planning arc: **pitch → plan, stage by stage → live preview → gate checks → publish to GitHub → launch the fleet.**

> 🚧 Blueprints are largely mature: lifecycle categories, the drag-reorder Blueprint editor with the Design-with-Claude assistant, attachable skills/knowledge, per-stage grading, drag-and-drop file intake, and gist sharing all work today. The main remaining piece is the execution-side conductor (staged build → test → review → integrate).

## Features

- **Project planning → fleet orchestration** — a dedicated planning session turns a pitch or repo set into a publishable GitHub structure (milestones, granular issues, `stream:` labels), then launches a fleet: one least-privilege worker per stream in its own git worktree, coordinated by a director
- **Parallel agent sessions** — multiple PTY-backed console panes per workspace tab, each tied to its own Claude instance
- **Live git context** — repo name, branch, and dirty status auto-detected from the shell's working directory
- **Knowledge Store** — named markdown blocks tagged by tech stack, injected into agent system prompts
- **GitHub integration** — OAuth/PAT auth, repo overview, Actions workflows, and webhook management
- **Extensions (MCP)** — attach Model Context Protocol servers per project, pre-trusted into every agent session
- **Custom blueprints** — author a reusable planning template in the planner and publish it to a gist
- **Automations** — cron-scheduled commands and knowledge injections across panes
- **Data models** *(planned — `1.0.4`)* — a canonical schema layer the data blueprints (migration, scraping) map into, for migrating off enterprise systems
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

## Roadmap

A snapshot of where the platform is and where it's headed. (Dates aren't promised; sequence is.)

**🚧 Current — `1.0.3` · user experience, resiliency & the core Default blueprint and its triage**

> We ship builds from this version early and keep working it until the theme is complete — so `1.0.3` is **Current**, not closed. The items below have landed; the version stays open for more UX, resiliency, and triage polish until done.

- **Simplicity** — a foolproof, trimmed **Default** blueprint (context → repos → deploy → features → UI → structure → permissions); the advanced stages (MCP servers, automations, skills) moved to a new **Complete** blueprint
- **Planner consolidation** — Blueprints folded into the planner page with the live render-preview; lifecycle categories, the drag-reorder editor with the Design-with-Claude assistant, attachable skills/knowledge, per-stage grading, file intake, gist sharing, and authoring your own blueprint
- **plan.db working store** — the plan's live state (context required-set, fleet + per-stream permissions, deploy, MCP, the authored blueprint, issues) moved into a per-project SQLite store, rehydratable from GitHub
- **Progress-gated triage** — relaunch reads issue status from plan.db, resumes from what changed, and **skips workers that already finished** so completed work doesn't restart
- **Resiliency** — **crash recovery** (unclean-shutdown detection + one-click session restore), faster/lazier boot (metrics + logging deferred off the startup path), and durable per-project repo links
- **Fleet model** — least-privilege workers in git worktrees coordinated by a director; workers build against planned contracts **in parallel** (no runtime dependency-wait) and don't spin up their own sub-agents
- Parallel **console** sessions, **Knowledge Store**, **GitHub** integration, **automations**, **MCP extensions**, the **Deploy** stage + pane, and the optional **mobile tunnel** (zero-knowledge Cloudflare relay, Noise IK E2E)

**🔜 Next — `1.0.4` · enterprise integration & migration**
- **Pull data from enterprise systems** — ERP, CRM, BPM, and other software solutions — into canonical **data models** via MCP connectors
- **Migrate off an existing solution to bespoke generated software** — map the imported data into your own custom app, generated and run by the fleet
- **Compliance** — a user-updatable Compliance MCP server (regulations, accessibility, user-protection) integrated into the planner, so generated software is compliant by default

**🗺️ Then — `1.0.5` · the UI release**
- An in-app, **Claude-Design-like** way to define each **page, component, and animation** — generate, preview, and iterate UI inside the planner (closing the external Claude Design round-trip), rendered live by the render-preview

**Later**
- The execution-side **conductor** (staged build → test → review → integrate)
- Expanded blueprint catalog and richer per-stage gates and checks

## Versioning & Releases

base-studio-code is at the **`1.0.x`** series and under active development. **`1.0.0` was the first official release** — the first version considered stable and ready for general use. The `1.0.x` line is bumped conservatively: **patch** bumps for fixes and small improvements, **minor** bumps for feature releases (e.g. enterprise integration & migration lands as `1.0.4`).

We work one version at a time, **release-and-continue**: a version ships builds early and stays **Current** — actively worked — until its theme is complete; only then does the next minor become the focus. A released build is a checkpoint, not the end of the version.

See [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © 2026 Kevin Lago
