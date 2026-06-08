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

Authoring and sharing a **blueprint** is a first-class contribution — no code required. (As the pipeline work lands, the same applies to other **extensions**.) A blueprint is a reusable planning template: an ordered set of stages, each with its prompt, completion gate, and pipelines. A good one helps everyone start projects faster.

### Create one

In the app: **Projects → Blueprints**. Start from a built-in, reorder / toggle stages, edit each stage's prompt, attach pipelines, and name it. It saves locally and seeds new projects when set active.

### The shareable unit

Everything shareable is wrapped in a small, versioned **extension manifest** — a JSON envelope (`kind`, `id`, `name`, `version`, optional `capabilities` / `integrity`, and a `payload`). Blueprints serialize into it losslessly; the app validates the envelope on import and refuses any manifest newer than it understands. This one envelope is the contract for every kind, so a blueprint today and a pipeline tomorrow install the same way.

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
