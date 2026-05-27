# Studio Code — Project Plan

> Consolidated plan for the **studio-code** product (GitHub Project [#16](https://github.com/users/kevinthelago/projects/16)).
> Two repos: **base-studio-code** (desktop host) and **mobile-studio-code** (mobile IDE).
> Maintained from the in-app planner; this file is the checked-in snapshot.

## Goal

Studio Code is a cross-device platform for running many AI coding agents in parallel against GitHub repositories.

**base-studio-code** is the desktop host (Tauri v2 + React 19) that spawns and orchestrates real Claude Code CLI sessions inside PTY-backed console panes — fleets of agents across multiple repos and tabs — with built-in GitHub integration, a reusable knowledge/document store, cron automations, and an in-app project planner. **mobile-studio-code** is a standalone mobile IDE (Expo / React Native) that drives an embedded Claude agent over the GitHub REST API, and can *optionally* pair into a running desktop session over a versioned WebSocket tunnel.

**Who it's for:** solo developers and small teams who direct fleets of coding agents and want to keep working — and supervising those agents — whether they're at a workstation or on a phone.

**Target platforms (v1.0):** desktop ships on **Windows, macOS, and Linux**; mobile ships on **iOS and Android** (Android is a new target — the app is iOS-only today).

**Measurable signal of success (v1.0):** a developer can (1) run N parallel `claude` agents on the desktop across repos with stable performance, (2) take a repo end-to-end from the phone standalone (clone → agent edit → commit → verify on GitHub) with the tunnel disabled, and (3) scan a QR code to pair phone ↔ desktop and mirror a console (view + input) with clean fallback to standalone — all delivered as signed, installable builds across every target platform.

## Roadmap

The finish line is **v1.0**. base-studio-code has shipped **v0.1.0 → v0.5.1**; the remaining versions each **complete one page/concern**, culminating in v1.0.0 GA. mobile-studio-code runs its **own parallel version line** (numbered independently) and ships v1.0 in lockstep. Milestones are versions — the old cross-cutting "Phase 1–6" model is retired.

### base-studio-code

| Version | Concern | Done when |
|---|---|---|
| **v0.6.0** | Knowledge Base | The KB page is genuinely usable: reworked UX (#140), T-layout with an embedded Claude console for block generation (#32), rethought doc-assignment UX (#51). Near-term docs cleanup rides along: branch convention (#45), README version roadmap (#151). |
| **v0.7.0** | Automations | The Automations page works end-to-end with real cron scheduling — define → schedule → fire → surface run history (#142). |
| **v0.8.0** | Extensions (MCP) | Agent tooling ships via an in-process MCP host: management page (#33), first-party Context + Checkpoint tools, `bsc-checkpoint` migration, hooks. |
| **v0.9.0** | Tunneling & mobile integration | Token-authed WebSocket server on base (#35), one versioned message schema exercised by a shared fixture test on both sides (#46), corrected docs (#44), and a paired mobile client mirroring a desktop console with clean fallback. |
| **v1.0.0** | First official release (GA) | Every page polished (#141, #135); console hardened (#36, #52, #77); desktop installers code-signed on Windows (#108), notarized on macOS (#119), packaged for Linux (#120) with per-OS shell/PTY correctness (#118); the release pipeline cuts a tagged, non-draft v1.0 across all desktop platforms (#121). |

### mobile-studio-code

| Version | Concern | Done when |
|---|---|---|
| **v0.1.0** | Standalone foundation | Standalone + optional-tunnel architecture documented (#12); standalone E2E passes on-device with the tunnel off (#13); a `jest-expo` runner is introduced and the `sha:null` new-file push path is unit-tested (#14). |
| **v0.2.0** | Tunnel & pairing *(↔ base v0.9.0)* | Tunnel client refactored against base's versioned schema with graceful fallback (#15); QR scan → pair → mirror a desktop console (view + input) → unpair with no local-state loss (#16). |
| **v0.3.0** | Android parity | Android Firebase/FCM wired (#21); EAS Android build + submit profiles (#22); real-device feature-parity pass across agent loop, tunnel, push, secure storage, file system, QR pairing (#23). |
| **v1.0.0** | First official release *(↔ base v1.0.0)* | iOS ships to TestFlight + App Store (#24); Android ships to the Play Store internal track (#25); v1.0 cut — version/runtimeVersion bumped, OTA channel published, release tagged (#26). |

## Scope

### In scope — the road to v1.0
Everything in the roadmap tables above. KB (v0.6.0), Automations (v0.7.0), and Extensions/MCP (v0.8.0) are each a release; the tunnel (v0.9.0) is the central new build; v1.0.0 GA folds in polish, console hardening, and all signing / cross-platform / release-pipeline work.

### Out of scope (post-1.0)
- **Additional agent-provider panes** beyond `claude` — Gemini CLI, OpenAI Codex CLI, Aider, Ollama, Amazon Q (base #38–#42).
- **Resizable panes** for planning/KB screens (base #43); **console auto-fit / readability** (base #68).
- **Multi-user / team accounts, cloud sync, or a hosted backend** — Studio Code stays local-first, single-user.
- **Desktop app-store distribution** (Microsoft Store / Mac App Store) — direct signed installers only.
- **Tablet / landscape layouts** on mobile; Android tablet.

## Architecture

Two local-first, single-user apps that operate independently and optionally connect over a WebSocket tunnel. **No shared backend or datastore** — each app persists locally.

**base-studio-code (Tauri v2):** a single `src-tauri/src/lib.rs` (no `crates/*` workspace) exposing Tauri commands — a **PTY manager** that spawns a real shell and auto-launches the **`claude` CLI** inside it (OSC 7 cwd tracking + a custom OSC 100 run/idle agent-state signal, output coalesced to ~one IPC event per frame); **git info**; a **folder picker**; **`kb_chat`** (the *only* direct Anthropic API call, `claude-sonnet-4-6`); a **GitHub proxy**; and a **workspace manager** (project hubs under `~/.base-studio-code/`, atomic mutex-guarded `~/.claude.json` repair/trust). The **WebSocket tunnel server is not yet built** (v0.9.0). Frontend: **React 19** + Vite 7, a pane system, screens for Console/Knowledge/GitHub/Automations/Planner/Settings, **Zustand** + `persist`, **xterm.js**.

**mobile-studio-code (Expo / RN):** expo-router stages (`setup → repo → tabs → settings`); core logic in `src/lib/` — `agent.ts` (tool loop), `anthropic.ts`, `contextOptimizer.ts`, `github.ts` (**all git as GitHub REST**: tree+blob clone, diff pull, `PUT /contents` push), `session.tsx`, `fs.ts`, `storage.ts`. The **tunnel client is already built** (`TunnelContext`, WS client) and awaits the server. Push via **Firebase Cloud Messaging**.

**Communication:** desktop UI → `pty_create` → shell → `claude` CLI, streamed back over Tauri events; mobile chat → `agent.ts` loop → Anthropic API → tool execution; either app ↔ GitHub (desktop via the Rust proxy, mobile via REST); the tunnel (target) is mobile WS **client** ⇄ desktop WS **server** with token auth + QR pairing, versioned JSON messages, mirror of a desktop console, and clean fallback to standalone.

## Per-repo detail

### base-studio-code — role & stack
The **authoritative desktop host**: owns the agent processes (real `claude` CLI in PTYs), the GitHub connection, the knowledge store, automations, the planner, and — at v1.0 — the WebSocket tunnel server. **Stack:** Tauri v2 (Rust, single `lib.rs`; `tauri`, `tauri-plugin-store`/`-log`, `reqwest`, `portable-pty`, `rfd`, `serde`) · React 19 + TypeScript + Vite 7 · Zustand v5 + persist · xterm.js v6 + portable-pty (ConPTY on Windows) · the external `claude` CLI per pane. **CI gate** (`ci.yml`): typecheck → lint → Vitest coverage; `cargo check` → `clippy -D warnings` → `cargo test`. Clippy `-D warnings` + green tests are the hard gates.

### mobile-studio-code — role & stack
A **standalone-first mobile IDE** that also acts as the remote view+input for a desktop console when paired; owns the mobile agent loop, the GitHub REST client, on-device secure storage, and the tunnel **client** (no server). **Stack:** Expo SDK 54 / React Native 0.81 (New Architecture) · expo-router v6 · `@anthropic-ai/sdk` · GitHub REST only · `expo-secure-store` + `expo-file-system` · Firebase Cloud Messaging · `expo-camera` (QR) · EAS Update/Build/Submit. **No automated test framework yet** — `tsc --noEmit` is the only gate; `jest-expo` is introduced in v0.1.0 (#14). **Android is scaffolded but non-functional** until v0.3.0.

## Risks

1. **Tunnel protocol drift** between an unbuilt server and the shipped mobile client (Med/High) — define the versioned schema first as one shared artifact (the v0.9.0 gate) + a shared fixture test on both sides.
2. **Android is a new target** with iOS-only assumptions (High/Med) — stand up an Android dev build early in mobile v0.3.0; test on a real device.
3. **Cross-platform desktop shell/PTY** assumptions on macOS/Linux (Med/Med) — add a CI build matrix (#118) and per-OS PTY smoke tests as part of v1.0.0.
4. **Signing identities are a cost/procurement gate** (High/High) — acquire Apple/Play/Windows-cert/notarization credentials in parallel with the v0.6.0–v0.9.0 work so lead time doesn't block release.
5. **Brittle coupling to the `claude` CLI and `~/.claude.json`** (Med/Med) — atomic-write + self-heal + lock already harden this; keep it unit-tested and pin a known-good `claude`.
6. **Memory/perf under fleets of agents** (Med/Med) — output coalescing is in place; land #52 in v1.0.0 hardening; document a realistic supported concurrency target.
7. **Finish-line gates rely on manual E2E** (Med/Med) — scripted manual checklists for the standalone (mobile v0.1.0) and pairing (v0.9.0 / mobile v0.2.0) gates, kept in-repo.
8. **Solo-maintainer bandwidth** across 2 repos × 5 platforms × a multi-version roadmap (High/Med) — single-concern-per-version sequencing keeps each release small; resist scope creep back into v1.0.

## Considered & skipped

No standalone sections for: **schema/api/auth** (local-first, single-user; no DB or server API — the only versioned contract is the v0.9.0 WS schema), **integrations/observability** (described in architecture; `tauri-plugin-log` + an `errorBus`, no external telemetry), **performance/infra/cicd** (folded into v1.0.0 release engineering and the per-repo testing sections), **data_lifecycle** (no collected data), **analytics** (out of scope for a local-first tool), **accessibility/cost** (revisit post-1.0; only spend is signing/store identities). The full record lives in the planner hub.
