> ⚠️ **This application creates issues, milestones, repositories, etc. by default — please be aware!** The project planning page will show you everything that will be done before it happens.

> 📍 **Where we are:** `1.0.4` is the **current version — released and in active development**, focused on **enterprise integration & migration**: connect read-only to the systems businesses already run on — **ERP, CRM, BPM** (Salesforce, monday.com, QuickBooks, Quickbase, HubSpot, Airtable, and more) — and scan their **data, configurations, and behaviors** into canonical **data models**, then generate your own **bespoke software** to replace them, with **compliance** baked in. Also landed in `1.0.4`: a **built-in Research MCP** (arXiv · Semantic Scholar · PubMed/PMC · Crossref + native PDF extraction + citation-grounded search) that grounds plans and skills in real sources with no download/build/Docker, plus console polish (native copy/paste, Claude's own TUI input restored). `1.0.3` — user experience, resiliency, the core **Default** blueprint + triage, and the parallel **run-on-any-model** `bsc-agent` pillar — is now **complete**. **Next up is `1.0.5` — the UI release:** an in-app, Claude-Design-like way to define pages, components, and animations with **iterative UI loops** (generate → live-preview → refine), rendered live. See the [Roadmap](#roadmap).

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

*A core feature of the platform.* A **Blueprint** is a reusable planning template — an ordered list of planning **stages** (context, repos, UI design, structure, permissions, …), each with its own prompt module, a declarative completion **gate**, and optional attached **skills / knowledge**. Pick one — built-ins span the project lifecycle: **greenfield** (Default, Complete), **transform** (Refactor & Cleanup, Split / Combine microservices, Migrate stack), **harden** (Harden security), and **data** (Data migration, Data collection) — searchable and filterable by category. It seeds every new project's planning session: which stages run, what Claude is told in each, and what happens to each stage's output. You can also **author your own blueprint** in the planner and publish it to a gist to share. Stages are gated and dependency-aware — a stage stays locked until its prerequisites are met, and the planning progress bar tracks the state.

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
- **Data models** *(landing — `1.0.4`)* — a canonical schema layer the data blueprints (migration, scraping) map into, for migrating off enterprise systems
- **Persist & restore** — workspace layout, pane names, and working directories survive restarts

### The app, screen by screen

Eight surfaces, reached from the left rail:

- **Console** — the execution surface where planned work runs. Tabbed workspaces, each a configurable grid of terminal panes; every pane is a real PTY running an agent, with swappable views for the terminal, files, branches, diffs, the session log, and live tokens/cost
- **Projects** — the flagship planner: pitch → staged plan → live UI preview → publish to GitHub → launch the fleet, alongside a live **Fleet** board (one worker per stream, coordinated by a director) and the canonical **Data Models** editor
- **Skills** — the injectable-context library: searchable skills and task groups, attachable per session, with invocation telemetry and per-project lessons
- **Automations** — cron-scheduled commands dispatched into console panes, with armed status and run history
- **MCP** — install, configure, and update Model Context Protocol servers (including built-in sidecars) and event-triggered hooks
- **GitHub** — organization and per-repo analytics plus the Projects v2 board: branches, the PR queue, CI status, and contributors, behind OAuth or a PAT
- **Security** — the least-privilege control room: a role and profile per session (tool allowlists, write-path scope, network), enforced at launch, with a live audit feed of every tool attempt
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

A snapshot of where the platform is and where it's headed. (Dates aren't promised; sequence is.)

**✅ Complete — `1.0.3` · user experience, resiliency & the core Default blueprint and its triage**

> Shipped, and the focus has moved on to `1.0.4`. The items below landed across the `1.0.3` line (including the parallel **run-on-any-model** pillar).

- **Run on any model** *(parallel pillar)* — a model-agnostic agent shell we own, **`bsc-agent`**: an `LlmProvider` layer (Anthropic, OpenAI, Gemini, local; `crates/llm`) plus a native agent runtime — tool use, native permission enforcement, telemetry + transcript, ancestor context + skills loading, and an MCP client — packaged as a sidecar and selected per session behind a `HarnessAdapter`. It emits the same contracts as Claude Code, which **stays the default until parity**
- **Simplicity** — a foolproof, trimmed **Default** blueprint (context → repos → deploy → features → UI → structure → permissions); the advanced stages (MCP servers, automations, skills) moved to a new **Complete** blueprint
- **Planner consolidation** — Blueprints folded into the planner page with the live render-preview; lifecycle categories, the drag-reorder editor with the Design-with-Claude assistant, attachable skills/knowledge, file intake, gist sharing, and authoring your own blueprint
- **Dependencies in Deploy** — the planner locks every repo's libraries (and their registries/sources) once; publish seeds each repo's `package.json` / `Cargo.toml` (+ `.npmrc` / `.cargo/config.toml`) and the role gate keeps workers from redefining them, so the parallel fleet stops colliding on deps
- **plan.db working store** — the plan's live state (context required-set, fleet + per-stream permissions, deploy, MCP, the authored blueprint, issues) moved into a per-project SQLite store, rehydratable from GitHub
- **Progress-gated triage** — relaunch reads issue status from plan.db, resumes from what changed, and **skips workers that already finished** so completed work doesn't restart
- **Resiliency** — **crash recovery** (unclean-shutdown detection + one-click session restore), faster/lazier boot (metrics + logging deferred off the startup path), durable per-project repo links, and **log management** (view / filter / limit / clear / export in Settings → Logs)
- **Richer publishing** — repos go out with a description, stack-derived topics, and a plan-driven README, plus the standard community-health files
- **Fleet model** — least-privilege workers in git worktrees coordinated by a director; workers build against planned contracts **in parallel** (no runtime dependency-wait) and don't spin up their own sub-agents
- Parallel **console** sessions, the **Skills** library, **GitHub** integration, **automations**, **MCP extensions**, the **Deploy** stage + pane, and the optional **mobile tunnel** (zero-knowledge Cloudflare relay, Noise IK E2E)

**🚧 Current — `1.0.4` · enterprise integration & migration**

> Released and in active development — we ship builds early and keep working `1.0.4` until its theme is complete.

- **Pull data from enterprise systems** — ERP, CRM, BPM, and other software solutions — into canonical **data models** via native + MCP connectors (Salesforce, monday.com, QuickBooks, Quickbase, HubSpot, Airtable), capturing **data, configurations, and behaviors** (automations, business processes), not just rows
- **Migrate off an existing solution to bespoke generated software** — the source scan dictates the app's schema + logic; map it into your own custom app, generated and run by the fleet
- **Compliance** — a user-updatable Compliance MCP server (regulations, accessibility, user-protection) integrated into the planner, so generated software is compliant by default
- **Research** — a **built-in** literature MCP server (arXiv · Semantic Scholar · PubMed/PMC · Crossref, native PDF extraction, citation-grounded search), so the planner can ground plans and skills in the latest real sources with no download, build, or Docker
- **Console polish** — native copy/paste (hotkeys scoped to the Console page) and Claude's own TUI input restored, with auto-redraw nudges for the CLI's jumbled-text bug

**🔧 In progress — codebase refactor & consolidation** *(on the `1.0.4` line, before `1.0.5`)*

> A refactor sweep with **no user-facing feature change** — paying down structural debt so the UI release builds on solid ground. Ships continuously to `develop`.

- **Feature-first frontend** — the React tree reorganized into vertical slices: `app/` (the shell) · `features/` (one folder per feature: UI + a pure React-free `lib/` + its store slice + a public `index.ts` barrel) · `shared/` (feature-agnostic) · `store/`, with a `@/…` path alias replacing deep relative imports
- **Shared UI primitives & a consistency sweep** — scattered, copy-pasted UI consolidated onto shared atoms: `BackButton`, `IconButton` (one close glyph), `StatusDot`, `ModalScrim`/`Dialog` (the single centered-overlay every modal builds on), `Toggle`, `Avatar`, `LabelChip`, the analytics charts, and promise-returning prompt/confirm dialogs replacing native `window.prompt`/`window.confirm`
- **Decomposition & dedup** — the ~3k-line `Planning.tsx` and `FocusedBodies.tsx` split into focused, colocated hooks and per-body files; `handlePublish` extracted into a React-free `publishSteps.ts`; reusable hooks (`usePoll`, `useGithubQuery`, `useCoordLog`) and `safeInvoke`/`fireInvoke` replacing hand-rolled boilerplate across the app
- **Rust consolidation** — a shared `bsc-cli-util` crate (CLI scaffolding for every `bsc-*` binary); blueprint + published-marker logic delegated to the Tauri-free `bsc-blueprint`/`bsc-project` crates; `src-tauri/prompts` renamed to `src-tauri/data`; **plan.db is now the sole fleet store** (the legacy `fleet.json` reader removed, stray files migrated in); the orphaned reference-context subsystem removed
- **Tests for security-critical surfaces** — coverage for the session env/permission builders and a role-table consistency guard that fails CI on drift

**🔜 Next — `1.0.5` · the UI release**
- An in-app, **Claude-Design-like** way to define each **page, component, and animation** — generate, preview, and iterate UI inside the planner (closing the external Claude Design round-trip), rendered live by the render-preview
- **UI loops** — iterative design loops that **generate → live-preview → refine** a UI in-app until it's right, the same tight loop the agent fleet runs for code

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
