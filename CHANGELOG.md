# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- ESLint + Prettier tooling with CI enforcement
- MIT license, README, CONTRIBUTING, SECURITY docs
- Dependabot for automated dependency updates

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
