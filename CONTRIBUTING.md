# Contributing to base-studio-code

## Development Setup

### Prerequisites

- Node.js 20+
- Rust stable (`rustup update stable`)
- [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/) for your platform

### Install dependencies

```bash
npm install
```

### Run in development

```bash
npm run tauri -- dev   # Native window with hot-reload
npm run dev            # Frontend-only (no Rust backend)
```

## Workflow

1. **Open or claim a GitHub Issue** — confirm scope and acceptance criteria before writing code.
2. **Create a branch** from the issue using the Development panel: `{issue-number}-{short-description}`.
3. **Implement the minimum changes** required to close the issue.
4. **Run checks locally** before pushing:
   ```bash
   npm run typecheck
   npm run lint
   cargo test
   ```
5. **Open a PR** targeting `develop`. Reference the issue with `Closes #N`. CI must pass before merge.

## Code Style

- **TypeScript**: enforced via ESLint + `typescript-eslint`. Run `npm run lint` to check.
- **Formatting**: Prettier. Run `npm run format` to auto-fix.
- **Rust**: `cargo fmt` + `cargo clippy --all-targets -- -D warnings`.
- Inline styles are used throughout the React frontend (intentional — see `src/styles/tokens.css`).

### Frontend layout & shared primitives

The frontend is **feature-first vertical slices** — `app/` (the shell) · `features/<x>/` (UI + pure `lib/` + `store.ts` + `index.ts` barrel) · `shared/` (feature-agnostic) · `store/`. Import with the `@/…` alias (→ `src/…`), never deep `../../..` relatives. A feature owns everything it needs; `shared/` is imported by features but imports none.

Before hand-rolling common plumbing, reach for the shared primitive — these exist so the same logic isn't re-implemented per file:

- **Polling** (`useEffect` + `setInterval` + cancel-guard) → `usePoll(fn, ms, deps?, { immediate? })` (`@/shared/hooks/usePoll`)
- **Tauri error handling** → `safeInvoke(cmd, args, fallback)` / `fireInvoke(cmd, args?)` (`@/shared/lib/core/safeInvoke`) instead of ad-hoc `invoke(...).catch(...)`
- **GitHub fetch** (`{ data, loading, error }` + token gate) → `useGithubQuery(fetcher, deps, enabled?)` (`@/features/github/lib/useGithubQuery`)
- **Coordination log** → `useCoordLog()` / `readCoordState()` (`@/shared/lib/fleet/useCoordLog`)
- **GitHub display** (avatar colors, time/number formatters, `Gh*` types) → `@/shared/lib/github/*` + `@/shared/lib/core/format`; small UI atoms (`Avatar`, `LabelChip`, charts) → `@/shared/ui/*`

## Commit Messages

Use a short imperative subject line: `feat: add X`, `fix: Y`, `docs: Z`, `refactor: ...`.

## Branch Strategy

```
{issue-number}-short-description  →  develop  →  main
```

- Feature/fix branches target `develop`.
- `develop → main` is a separate PR merged only when `develop` is stable.
- Never push directly to `main` or `develop`.

## Contributing Blueprints & Extensions

Authoring and sharing a **blueprint** is a first-class contribution — no code required. A blueprint is a reusable planning template: an ordered set of stages, each with its prompt and completion gate, plus the **capabilities it attaches** — **skills** (reusable knowledge) and **MCP servers** (tools the planner / fleet can call). A good one lets anyone generate a whole class of app with the right knowledge and tools prepackaged. Skills and MCP servers are the two attachable capability types; there is no separate "pipeline" concept (see #897).

### Create one

In the app: **Projects → Blueprints**. Start from a built-in, reorder / toggle stages, edit each stage's prompt, **attach skills and MCP servers** to a stage (or the whole blueprint), and name it. It saves locally and seeds new projects when set active.

### The shareable unit

Everything shareable is wrapped in a small, versioned **extension manifest** — a JSON envelope (`kind`, `id`, `name`, `version`, optional `capabilities` / `integrity`, and a `payload`). Blueprints serialize into it losslessly; the app validates the envelope on import and refuses any manifest newer than it understands. One envelope is the contract for every kind, so a blueprint, a skill, and an MCP server install the same way.

A shared blueprint aims to be **turnkey**: its **skills travel as embedded content** (the share fully contains them), while its **MCP servers travel by reference** — a name + git link the app registers on import and clones/builds on first use (so those repos must be public). Bundling the attached skills + MCP refs into the shared unit is in progress (#897).

### Share it (works today)

From a blueprint's library card:

- **Export** copies a **share code** (a single string) — send it to anyone; they paste it into **Import**. Works offline, no account.
- Or export to a **`.json`** file and share it however you like.
- **Publish to Gist** creates a secret gist and copies its URL (requires connecting GitHub). Recipients **Import** from the URL.

Import accepts a share code, a `.json` file, a gist URL, or raw manifest JSON.

### Make it discoverable — federated sources

Discovery is **federated**: the app searches across a configurable list of **sources**, each an *existing* service (a community `index.json`, a GitHub topic query, etc.). There is **no central registry to host and no lock-in** — publish your blueprint wherever you like (a gist, a repo, any static URL) and list it in a source the app reads. To run your own source, publish an `index.json` (`[{ name, author, kind, url }]`) and add its URL in the app's extension settings; the app aggregates and searches across all configured sources.

> The discovery UI and the default community source are in progress (#598). Until they ship, share via code / file / gist as above.

## Design Reference

`design/` contains the full browser-rendered prototype. Match the design exactly when implementing UI screens — do not modify files under `design/`.
