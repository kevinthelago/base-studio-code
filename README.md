> ⚠️ **This application creates issues, milestones, repositories, etc. by default — please be aware!** The project planning page will show you everything that will be done before it happens.

> 📍 **Where we are:** `1.0.4` — **enterprise integration & migration** — is the current version, released and in active development, with a `1.0.41` consolidation checkpoint just cut ahead of the upcoming `1.0.5` **UI release**. See the **[Roadmap](ROADMAP.md)** for the full version-by-version breakdown.

# base-studio-code

[![CI](https://github.com/kevinthelago/base-studio-code/actions/workflows/ci.yml/badge.svg)](https://github.com/kevinthelago/base-studio-code/actions/workflows/ci.yml)
[![CodeQL](https://github.com/kevinthelago/base-studio-code/actions/workflows/codeql.yml/badge.svg)](https://github.com/kevinthelago/base-studio-code/actions/workflows/codeql.yml)
[![Release](https://img.shields.io/github/v/release/kevinthelago/base-studio-code?include_prereleases&sort=semver)](https://github.com/kevinthelago/base-studio-code/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/Tauri-v2-24C8DB?logo=tauri&logoColor=white)](https://tauri.app/)

> **The CDE — Claude Development Environment.** It's like an IDE, except the thing you build *with* is a roomful of agents running in parallel — Claude by default, or any model you bring. (Yes, we made the acronym up. No, we're not taking it back.) 🤖

Desktop host application for a multi-agent AI development workflow platform. Run many AI coding agents in parallel across multiple repositories — on Claude Code or the model-agnostic `bsc-agent` shell — with standardized knowledge injected per project based on its tech stack.

Pairs **optionally** with **mobile-studio-code**, a standalone companion app that can tunnel into a desktop session over a **zero-knowledge Cloudflare relay** — end-to-end encrypted (Noise IK), paired by QR — so the same agents can be driven from your phone, from anywhere.

### Run on any model

The platform isn't locked to one vendor. Alongside Claude Code, it ships **`bsc-agent`** — a model-agnostic agent shell we built — a native agent runtime so the fleet can be driven by **any** LLM: **Anthropic, OpenAI, Gemini, or a local/open-weight model** (Ollama-compatible). It satisfies the same *contracts* Claude Code does — telemetry (`audit.log` / `tokens.log`), the transcript schema cost-accounting reads, context files (`CLAUDE.md` / `CLAUDE.local.md`), the role/permission model, and MCP config — so every existing reader and UI keeps working unchanged. It enforces permissions and emits telemetry **natively** (no `.claude/settings.json`), loads ancestor context + `.claude/skills`, and speaks MCP. Pick a provider, model, and key in **Settings → Integrations**; **Claude Code stays the default** and you choose the runtime per session. Under the hood: a Tauri-free provider crate (`crates/llm`) behind an `LlmProvider` seam, and a `bsc-agent` sidecar selected via a `HarnessAdapter`.

## Project Blueprints

*A core feature of the platform.* A **Blueprint** is a reusable planning template — an ordered list of planning **stages** (context, deployment, features, UI design, structure, integrations, …), each with its own prompt module, a declarative completion **gate**, and optional attached **skills**. The packaged greenfield built-ins are **Default** (a trimmed, foolproof path) and **Complete** (every advanced stage — MCP servers, automations, skills); you can also **author your own blueprint** in the planner and publish it to a gist to share. It seeds every new project's planning session: which stages run, what Claude is told in each, and what happens to each stage's output. Stages are gated and dependency-aware — a stage stays locked until its prerequisites are met, and the planning progress bar tracks the state.

A standout capability is the **live UI preview**: the UI stage's generated screen skeletons are bundled with `esbuild-wasm` and rendered as an interactive **2D/3D walkthrough** in a sandboxed iframe, right inside the planning page — no preview server, no leaving the app. Approve screens one at a time to advance the stage.

The planning arc: **pitch → plan, stage by stage → live preview → gate checks → publish to GitHub → launch the fleet.**

> 🚧 Blueprints are largely mature: lifecycle categories, the drag-reorder Blueprint editor with the Design-with-Claude assistant, attachable skills/knowledge, drag-and-drop file intake, and gist sharing all work today. The main remaining piece is the execution-side conductor (staged build → test → review → integrate).

## Features

- **Project planning → fleet orchestration** — a dedicated planning session turns a pitch or repo set into a publishable GitHub structure (milestones, granular issues, `stream:` labels), then launches a fleet: one least-privilege worker per stream in its own git worktree, coordinated by a director
- **Model-agnostic agent shell (`bsc-agent`)** — a native agent runtime so the fleet runs on **any** LLM (Anthropic, OpenAI, Gemini, local), with native tool use, permission enforcement, telemetry + transcript, ancestor context + `.claude/skills` loading, and an MCP client; shipped as a sidecar and selectable per session ([details](#run-on-any-model))
- **Parallel agent sessions** — multiple PTY-backed console panes per workspace tab, each tied to its own agent instance
- **Live git context** — repo name, branch, and dirty status auto-detected from the shell's working directory
- **Dependencies, locked once** — the Deploy stage pins every repo's libraries — and the registry/source each comes from — in one manifest; publish seeds each repo's `package.json` / `Cargo.toml` (plus `.npmrc` / `.cargo/config.toml` for private sources) so the parallel fleet never collides on dependencies
- **Skills** — reusable markdown blocks (the Skills library), attachable per blueprint/section and written into each agent's `.claude/skills/` as injectable context
- **GitHub integration** — OAuth/PAT auth, repo overview, Actions workflows, webhook management, and a richer publish (repo description, stack topics, a plan-driven README)
- **Extensions (MCP)** — attach Model Context Protocol servers per project, pre-trusted into every agent session
- **Live state, reachable from any session** — every app store (the plan, skills, the canonical data model, logs, compliance, blueprints, projects) is exposed to a running agent through bundled `bsc-*` CLIs, so an agent can read or drive project state directly from its own shell
- **Custom blueprints** — author a reusable planning template in the planner and publish it to a gist
- **Automations** — cron-scheduled commands dispatched across panes
- **Log management** — view, filter, limit, clear, and export every log stream from **Settings → Logs**
- **Canonical data model** — a DuckDB-backed schema layer (`crates/data`, `bsc data`) a migration source maps into; **connectors are authored by the planner agent** as validated manifests (probe → validate → try) and captured as reusable skills — no native per-vendor code
- **Persist & restore** — workspace layout, pane names, and working directories survive restarts

### The app, screen by screen

Eight surfaces, reached from the left rail:

- **Console** — the execution surface where planned work runs. Tabbed workspaces, each a configurable grid of terminal panes; every pane is a real PTY running an agent, with swappable views for the terminal, files, branches, diffs, the session log, and live tokens/cost
- **Projects** — the flagship planner: pitch → staged plan → live UI preview → publish to GitHub → launch the fleet, alongside a live **Fleet** board (one worker per stream, coordinated by a director)
- **Skills** — the injectable-context library: searchable skills and task groups, attachable per session, with invocation telemetry and per-project lessons
- **Automations** — cron-scheduled commands dispatched into console panes, with armed status and run history
- **MCP** — install, configure, and update Model Context Protocol servers (including built-in sidecars) and event-triggered hooks
- **GitHub** — organization and per-repo analytics plus the Projects v2 board: branches, the PR queue, CI status, and contributors, behind OAuth or a PAT
- **Security** — the least-privilege control room: a role and profile per session (write-path scope, network, command policy), enforced at launch via a **deny-list model** (sessions auto-run, gated by always-on hooks; the allow-list stays as an opt-in posture toggle), with an opt-in **model-agnostic OS sandbox** that runs sessions inside a **sealed WSL2 distro** (no Windows-drive mount, no interop — the cage is the *environment*, so any LLM is confined), plus a live audit feed of every tool attempt
- **Settings** — providers/keys, mobile-tunnel pairing, appearance, diagnostics, performance, logs, and storage

## Tech Stack

| Layer | Choice |
|---|---|
| Desktop shell | Tauri v2 (Rust + WebView2 / WebKit) |
| Frontend | React 19 + TypeScript, bundled with Vite |
| State | Zustand v5 with `persist` middleware |
| Terminal | xterm.js v5 + portable-pty (ConPTY on Windows) |
| Styling | CSS custom properties (`src/styles/tokens.css`) |
| Fonts | Inter · JetBrains Mono (Google Fonts) |
| Agent runtime | Claude Code (default) **or** the model-agnostic `bsc-agent` shell, selected per session via a `HarnessAdapter` |
| LLM providers | Anthropic · OpenAI · Gemini · local/open-weight — pluggable behind `LlmProvider` (`crates/llm`); `claude-sonnet-4-6` default |

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
├── src-tauri/          # Rust backend (Tauri v2) — one folder per subsystem under src/
│   ├── src/            # platform · app · console · agent · project · planner · fleet ·
│   │                   #   github · sources · extensions · observability · mobile
│   └── tauri.conf.json
├── crates/             # Tauri-free workspace crates — data · plandb · skilldb · llm · research ·
│                       #   compliance · logs · bsc-blueprint · bsc-project · bsc-agent
│                       #   (+ bsc-util / bsc-sqlite-util / bsc-cli-util / mcp-rpc)
├── src/                # React frontend — feature-first vertical slices (imports use `@/…`)
│   ├── app/            # the shell — main/App, chrome (Rail · Titlebar · Tabstrip), and the
│   │                   #   console execution surface (ConsoleScreen + panes/ + lib/)
│   ├── features/       # one folder per feature = UI + lib/ (pure domain) + store.ts + index.ts:
│   │                   #   planner (flagship) · skills · mcp · automations · github · tunnel · agents · settings
│   ├── shared/         # feature-agnostic (lint-enforced: no @/features or @/app value imports):
│   │                   #   lib/ (core · session · fleet · github · security), hooks/, ui/ (Avatar ·
│   │                   #   LabelChip · Chip · Dialog · charts), data/
│   ├── store/          # Zustand store composition (slices/ + types/ + updateHelpers)
│   └── styles/         # tokens.css — design tokens + base styles
├── design/             # ⚠️ Reference prototype only — do not edit
└── docs/               # Architecture and design documentation
```

## Architecture

```
base-studio-code (desktop host)
├── Agent Orchestrator   — parallel agent sessions (PTY: Claude Code or bsc-agent) + planning/fleet
├── GitHub Integration   — OAuth, repos, PRs, Actions, hooks
├── Skills Library       — reusable context blocks keyed by stack tag
├── Mobile relay client  — dials the zero-knowledge Cloudflare relay (Noise IK E2E)
└── UI Shell             — Tauri WebView + React frontend
```

## Roadmap

Where the platform is and where it's headed — sequence, not dates:

- **✅ `1.0.3` — Complete** · user experience, resiliency, the core **Default** blueprint + triage, and the parallel **run-on-any-model** `bsc-agent` pillar
- **🚧 `1.0.4` — Current** · **enterprise integration & migration** — connect read-only to ERP/CRM/BPM, scan data + configs + behaviors into canonical data models, and generate bespoke software with compliance baked in
- **📦 `1.0.41` — Checkpoint** · a consolidation stop-gap ahead of `1.0.5`: the codebase refactor & consolidation sweep, integrations as agent-authored connectors, a data-driven planner, and planner/fleet hardening
- **🔜 `1.0.5` — Next** · **the UI release** — define pages, components, and animations in-app with iterative UI loops (generate → live-preview → refine), rendered live

**→ Full version-by-version detail lives in [ROADMAP.md](ROADMAP.md).**

## Versioning & Releases

base-studio-code is on the **`1.0.x`** series under active development. `1.0.0` was the first official release; the line is bumped conservatively (**patch** for fixes, **minor** for feature releases), **release-and-continue** — a version ships builds early and stays Current until its theme is complete.

See the **[Roadmap](ROADMAP.md)** for the version breakdown and [CHANGELOG.md](CHANGELOG.md) for release history.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

[MIT](LICENSE) © 2026 Kevin Lago
