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

## Design Reference

`design/` contains the full browser-rendered prototype. Match the design exactly when implementing UI screens — do not modify files under `design/`.
