# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

> **Versioning:** the `0.x` series is a development preview. **`1.0.0` will be the
> first official, general-availability release.** Until then, versions are bumped
> conservatively so `1.0.0` stays a meaningful milestone.

## [Unreleased]

### Added
- ESLint + Prettier tooling with CI enforcement
- MIT license, README, CONTRIBUTING, SECURITY docs
- Dependabot for automated dependency updates

## [0.6.0] — 2026-05-27

### Added
- Extensions screen (mock): manage MCP servers (first-party + third-party) and hooks — Installed/Catalog views, Global/Project/Console scope, per-project matrix, and a config drawer (#33)
- Automations screen rebuilt (mock): Schedules list + deep editor (when/target/action/guard/history) and a filterable cross-schedule History tab; the old Commands tab folds into a schedule's action (#142)
- Resizable panes on the Knowledge Base screen — drag the document-list width and the preview height above the terminal (#43)

## [0.5.1] — 2026-05-27

### Fixed
- `bsc-checkpoint` is now reachable from agent shells, not just the interactive console
  pane. Claude's Bash tool runs commands in non-interactive `bash -c` subprocesses that
  never saw the interactive shell's functions, so triage sessions couldn't persist their
  "where we left off" checkpoint. The helper is now installed via an rc file + `BASH_ENV`
  (the hyphenated name can't be `export -f`'d), so every agent subshell can run it (#148).

## [0.2.0] — 2026-05-23

### Added
- PTY terminal in every console pane (xterm.js + portable-pty / ConPTY)
- Native directory picker (`rfd`) with folder button in pane header
- OSC 7 cwd tracking — repo/branch auto-detected from shell working directory
- `git_info` Tauri command for repo/branch/dirty-state detection
- Hotkey overhaul: Ctrl+1–9 for tab navigation, Ctrl+Shift+1–9 for pane focus/fullscreen
- Auto-focus-on-interrupt setting (Settings → Integrations)
- Pane status count in status bar now sums all tabs
- View selector collapsed to icon-only with full detail in pane menu
- Persist pane cwds and names across restarts

### Changed
- Replaced mock console chat UI with real bash PTY session
- PTY sessions survive tab switches (idempotent `pty_create`)
- Ctrl+L used on PTY reconnect instead of `\n` to repaint prompt cleanly
- Shell uses `printf` for ANSI clear instead of `clear` (works in Git Bash)

## [0.1.0] — 2026-05-22

### Added
- Initial Tauri v2 + React 18 + TypeScript scaffold
- CSS design token system (`src/styles/tokens.css`)
- Chrome: Titlebar, Rail, Tabstrip, StatusBar
- Pane system: PaneShell, ViewTabs, PaneMenu with portal rendering
- Console screen with CSS grid layout (1×1, 2×2, 3×3)
- Knowledge Store screen
- GitHub screen (connect flow, Overview, Actions, Hooks)
- Automations screen (Schedules, Commands)
- Settings screen (GitHub, Integrations)
- Zustand store with `tauri-plugin-store` persistence
- Live titlebar breadcrumb and status bar indicators
- Tab add/close with confirmation dialog
- Lucide icons throughout
