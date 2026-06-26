# Backend reference

A map of the Rust/Tauri backend and the workspace crates for someone new to the codebase. This is
the navigational companion to the terse operating manual in [`CLAUDE.md`](../CLAUDE.md) — where they
disagree, **this doc follows the actual code** (CLAUDE.md has lagged behind a couple of moves; see
[Gotchas](#8-gotchas)). For the React side, see [`docs/frontend.md`](./frontend.md).

---

## 1. Overview & stack

`base-studio-code` is a **Tauri v2** desktop app: a Rust backend (the authoritative host — it owns
the agent PTYs, GitHub auth, the plan/skills stores, and the mobile relay client) paired with a
React/TypeScript WebView frontend. The Rust side is the focus of this document.

| Layer | Choice |
|---|---|
| Shell / IPC | Tauri v2 (`tauri = "2"`), `#[tauri::command]` functions invoked from the WebView |
| Async runtime | `tokio` (multi-thread) for the commands + the mobile relay transport |
| PTY | `portable-pty` (each console session is a real shell running `claude` / `bsc-agent`) |
| Storage | SQLite via `rusqlite` (bundled) — plan store, skills store, perf time-series, research cache; DuckDB via `duckdb` (bundled) — the canonical Data Model |
| Mobile crypto | `snow` (Noise IK), `tokio-tungstenite` + `rustls`/`ring` (relay dial over TLS) |
| Secrets | `keyring` (OS keychain — Windows Credential Manager / macOS Keychain) for source connectors |
| Push | `jsonwebtoken` + `reqwest` (FCM v1 service-account flow) |

**The organizing principle: the folder tree *is* the architecture.** Every subsystem is one folder
under `src-tauri/src/`. The crate root [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) is *only*
module declarations plus a block of `pub(crate) use` re-exports that preserve the pre-restructure
`crate::<name>` paths (so the invoke handler and sibling modules resolve unchanged after the #1300
restructure). [`src-tauri/src/main.rs`](../src-tauri/src/main.rs) is a 6-line entry point that calls
`base_studio_code_lib::run()`.

The workspace root is [`src-tauri/Cargo.toml`](../src-tauri/Cargo.toml); the Tauri-free, separately
spawnable libraries/CLIs live under [`crates/`](../crates/).

---

## 2. `src-tauri/src/` subsystems

`run()` (in [`app/run.rs`](../src-tauri/src/app/run.rs)) builds the Tauri app, registers plugins,
`manage()`s the shared state objects (`PtyState`, `TunnelState`, `PerfState`, `LogState`,
`UncleanShutdown`), and registers **every** command in one `tauri::generate_handler![...]` block —
that block is the canonical index of the backend's command surface.

| Folder | Owns | Key files |
|---|---|---|
| [`platform/`](../src-tauri/src/platform/) | OS primitives shared by every domain; no domain deps | `paths.rs` (every `~/.base-studio-code` location), `git.rs` (`git_lines`/`git_output`), `shell.rs` (shell resolution + bash⇄native path/quote conversion), `process.rs` (`no_window` — suppress console flashes), `fsx.rs` (`sanitize_project_key`, `worktree_slug`, safe-relpath, section-file ingest), `docstore.rs` (document library) |
| [`app/`](../src-tauri/src/app/) | The Tauri shell + lifecycle | `run.rs` (`run()` — plugins, state, the invoke handler, exit cleanup), `state.rs`, `recovery.rs` (`.session-lock` crash detection, #1041), `single_instance.rs` (#1303), `dialog.rs` (native pickers) |
| [`console/`](../src-tauri/src/console/) | The interactive PTY execution surface | `pty.rs` (`pty_create` + the `pty_*` commands, process-tree kill, the session env), `ledger.rs` (boot-time orphan reaping), `discovery.rs` (durable session discovery), `settings.rs` (`ensure_session_settings` → `.claude/settings.json`, the role gate, `DEFAULT_DENY`/`MANDATORY_BASH`), `shell_rc.rs` (the `bsc-*` shell-helper rc constants) |
| [`agent/`](../src-tauri/src/agent/) | How an agent runtime is launched/resumed in a PTY | `harness.rs` (`HarnessAdapter` seam — `ClaudeCodeAdapter` vs `BscAgentAdapter`), `launch.rs` (`claude_launch`, model flags, history probes), `claude_config.rs` (read/write + self-heal `~/.claude.json` trust state) |
| [`project/`](../src-tauri/src/project/) | The on-disk project hub + plan store | `hub.rs` (hub lifecycle, `list_local_projects`, `mark_published`, `delete_project_dir`), `plan_db.rs` (the `plan_*` command wrappers over `crates/plandb`), `plan_files.rs` (read/clear plan sections), `blueprints.rs` (list/write/delete), `inspect.rs` (dead-code scan, UI skeleton) |
| [`planner/`](../src-tauri/src/planner/) | The planning session | `workspace.rs` (`setup_workspaces` — builds the hub), `prompts.rs` (the planner CLAUDE.md template + `PLANNING_*` intros), `directives.rs` (`planner_intro_prompt`, per-stage directives) |
| [`fleet/`](../src-tauri/src/fleet/) | The parallel worker fleet | `worktree.rs` (`ensure_worktree` — per-agent git worktree + `CLAUDE.local.md`), `teardown.rs` (`teardown_worktree`, `reclaim_worktrees`, build-artifact excludes), `director.rs` (`ensure_director_protocol`), `protocols.rs` (the injected worker/injection-resistance MD consts + the idempotent `append_section_once` helper), `staging.rs` (read/write project files) |
| [`github/`](../src-tauri/src/github/) | GitHub integration & auth | `api.rs` (REST/GraphQL/gist proxy — `github_request`, `github_graphql`, `github_post/put/patch`), `oauth.rs` (device flow), `repos.rs` (`clone_repo`), `readiness.rs` (`gh`/`git`/`gh auth` preflight probe), `git_hooks.rs` (hook inspection) |
| [`sources/`](../src-tauri/src/sources/) | Migration data sources / the "Source pane" | `data.rs` (CSV + platform-scan + infer/persist Data Model commands → `crates/data`), `oauth.rs` (PKCE loopback OAuth), `credentials.rs` (OS-keychain connector secrets) |
| [`extensions/`](../src-tauri/src/extensions/) | MCP servers, hooks, skills | `mcp.rs` (`mcp_clone`/`mcp_build`/`mcp_status`, `write_mcp_json`), `hooks.rs` (`write_session_hooks`), `skills.rs` (`write_session_skills` → `.claude/skills/<slug>/SKILL.md`), `skill_store.rs` (the `skill_store_*`/`skill_group_*` commands over `crates/skilldb`), `cfg.rs` (`McpServerCfg`/`HookCfg`/`SkillCfg`) |
| [`observability/`](../src-tauri/src/observability/) | Logs, metrics, accounting | `logs.rs` (managed log streams, caps), `perf.rs` (`PerfState`, the background sampler, `PerfSpan`), `tokens.rs` (`read_token_usage` — parses + prices the transcript), `audit.rs` (read the app-wide TSV logs — audit/skill/hook/mcp/coord; worktree changes/commits/branch) |
| [`mobile/`](../src-tauri/src/mobile/) | The paired mobile companion | `push.rs` (FCM v1 delivery), `tunnel/mod.rs` (`TunnelState` bus + the `tunnel_*` commands + wire protocol), `tunnel/protocol.rs` (serde wire types — matches mobile's `types.ts`), `tunnel/noise.rs` (Noise IK handshake), `tunnel/transport.rs` (relay dial-out + pump) |
| [`llm.rs`](../src-tauri/src/llm.rs) | The single `llm_complete` command | provider-agnostic one-shot completion, dispatches through `crates/llm` |
| [`tests.rs`](../src-tauri/src/tests.rs) / `testutil.rs` | Cross-cutting integration tests + the shared test harness (`temp_home`, `ENV_LOCK`, `write_file`) | — |

---

## 3. Workspace `crates/`

Everything in [`crates/`](../crates/) is **Tauri-free** — it depends on neither `tauri` nor
`src-tauri`. That keeps two things possible: (a) the heavy logic (SQLite/DuckDB stores, the LLM
layer, the research/compliance sources) compiles + unit-tests without dragging the whole desktop app
in, and (b) the CLIs/MCP servers spawn **cheaply per session** (a worker's shell execs `bsc-plan`
thousands of times — it can't pay for a Tauri process each time). The desktop app depends on several
of these crates and exposes thin command wrappers over them.

| Crate | Lib | Binary | Purpose |
|---|---|---|---|
| [`plandb`](../crates/plandb/) | `plandb` | **`bsc-plan`** | Per-project plan store (SQLite). The single source of truth for issues, features, phases, repos, the fleet, deps, deploy, MCP, context required-set, triage runs, and self-correction "lessons". The desktop's `plan_*` commands and the session-side `bsc-plan` CLI share it; sessions point at their project's DB via `$BSC_PLAN_DB`. |
| [`data`](../crates/data/) (`bsc-data`) | `bsc_data` | **`bsc-data`** (needs `duckdb-store`) | Canonical Data Model store (DuckDB) + the connector framework + runtime REST presets (#1235). Schema/DDL/connector/coercion logic compiles under `--no-default-features` (no DuckDB); the planner reads the per-project model/scan via `bsc-data model get` / `bsc-data scan get`. |
| [`llm`](../crates/llm/) (`bsc-llm`) | `llm` | — | The model-agnostic `LlmProvider` abstraction (Anthropic / OpenAI / Gemini / Local-Ollama). Shared by `llm_complete` and `bsc-agent` so neither depends on the other. |
| [`skilldb`](../crates/skilldb/) | `skilldb` | **`bsc-skill`** | Global skills + task-groups store (SQLite, #1338). ONE global `skills.db` (`$BSC_SKILL_DB`, default `~/.base-studio-code/skills.db`) shared by the desktop Skills library and every live session. |
| [`research`](../crates/research/) | `research` | **`bsc-research-mcp`** | Literature research (arXiv · Semantic Scholar · PubMed/PMC · Crossref) + native PDF extraction + citation-grounded semantic search, with an on-disk SQLite cache. Shipped as a bundled stdio MCP server (Tauri `externalBin`) so the planner can ground plans/skills in real sources with no download/build/Docker. |
| [`compliance`](../crates/compliance/) | `compliance` | **`bsc-compliance-mcp`** | User-updatable store of current compliance standards (WCAG 2.2, GDPR, CCPA, SOC 2, …) in SQLite. Bundled stdio MCP server so the planner bakes the right requirements in, refreshable without an app release. |
| [`bsc-agent`](../crates/bsc-agent/) | — | **`bsc-agent`** | The model-agnostic agent *runtime* (epic #1078, P2): a lean tokio binary over the `llm` crate. The alternative harness to Claude Code, selected per-console by provider id; runs the agent loop + tools (incl. a `webfetch` on a dedicated thread). |

> The MCP-server crates (`research`, `compliance`) and the CLI crates (`plandb`/`bsc-plan`,
> `skilldb`/`bsc-skill`, `data`/`bsc-data`) are the two extra crates and several extra binaries that
> CLAUDE.md's structure tree does not enumerate — see [Gotchas](#8-gotchas).

---

## 4. Key flows, end to end

### Console / PTY launch — `pty_create` ([`console/pty.rs`](../src-tauri/src/console/pty.rs))

1. **Reconnect-or-create:** if a `PtySession` already exists for the `pane_id` (tab switch), return
   `Ok(false)` instead of respawning.
2. **Open the PTY** with `portable-pty` and resolve the user's interactive shell (`bash` is the
   default and keeps the full `bsc-*` experience; PowerShell/cmd run degraded).
3. **Pick the harness:** `provider_id == "bsc-agent"` → `BscAgentAdapter`, else `ClaudeCodeAdapter`.
   `harness.prepare_config()` self-heals a corrupt `~/.claude.json`; `harness.trust_dir(cwd)`
   pre-accepts Claude Code's folder-trust prompt.
4. **CWD hardening (#367/#979):** a missing configured cwd is *not* silently replaced by `$HOME` —
   the session starts in the nearest existing ancestor and surfaces the gap loudly. Git-bash drive
   paths (`/c/...`) are normalized back to native (`C:/...`) so a restored worktree isn't seen as
   "missing".
5. **Session env:** terminal-type defaults + caller env, then it writes `~/.base-studio-code/bsc-env.sh`
   (the concatenated `bsc-*` rc constants) and points `BASH_ENV` at it so the agent's
   *non-interactive* `bash -c` subshells get the helpers too. It sets the per-pane env vars the
   helpers read: the app-wide TSV log paths (`BSC_AUDIT_LOG`, `BSC_SKILL_LOG`, `BSC_HOOK_LOG`,
   `BSC_MCP_LOG`, `BSC_TOKENS_LOG`, `BSC_ACTIVITY_LOG`, `BSC_DONE_LOG`, `BSC_COORD_LOG`), the pane id
   (`BSC_AUDIT_PANE`), the repo root (`BSC_REPO_ROOT`), the per-project plan DB + CLI
   (`BSC_PLAN_DB`/`BSC_PLAN_BIN`, only for sessions under a project hub), and the global skills DB +
   CLI (`BSC_SKILL_DB`/`BSC_SKILL_BIN`, unconditional).
6. **Process-tree ownership:** each session gets a kill-on-close **Windows Job Object** (or, on Unix,
   the shell's **process-group id** via `setsid` + `killpg`) so dropping the session on `pty_kill` /
   app exit reaps the whole tree (shell → `claude` → any `gh`/`git`/MCP child) instead of leaking
   ~28 orphans holding cwd locks (#52/#118).

Reader/output is teed to the frontend (Tauri events) **and** to the `TunnelState` bus for mobile.
On boot, `app/run.rs` reaps PTY children leaked by a prior unclean run via `pty_ledger::reconcile_on_boot()`.

### Session settings & the role gate — `ensure_session_settings` ([`console/settings.rs`](../src-tauri/src/console/settings.rs))

Writes the session's `.claude/settings.json`. The model: **allow Bash broadly** (so loops / pipes /
`&&` chains run without prompts — "start and go") but layer a curated `DEFAULT_DENY` (sudo, `rm -rf /`,
`dd`, force-push, `curl … | sh`, …) plus any per-session `denied_commands` on top. `MANDATORY_BASH`
(`gh`, `git`, `bsc-plan`) is always auto-approved. Claude Code precedence is **deny > ask > allow**.
The role gate (planner / worker / director / triage / tester / reviewer / conductor) maps to the
allow/deny/ask tool rules and write-path scoping the frontend passes in; the `ask` tier is the hard
push-confirm gate.

### Fleet & git worktrees — `ensure_worktree` ([`fleet/worktree.rs`](../src-tauri/src/fleet/worktree.rs))

Idempotently creates one git worktree per fleet agent at
**`~/.base-studio-code/worktrees/<key>/<repoShort>--<agentSlug>`** — note this is **outside** the
project hub (#844; see `worktrees_dir` in [`platform/paths.rs`](../src-tauri/src/platform/paths.rs)),
so the planner spec at `projects/<key>/CLAUDE.md` is *not* an ancestor of a worker's cwd (Claude Code
walks `CLAUDE.md` up every parent, which previously leaked the ~52KB planning spec into every worker).
The branch is named after the agent's stream id (reused if it already exists). The agent's focused
`scope_md` (owned globs, issues, deps) is written as the lead of the worktree's `CLAUDE.local.md`;
build artifacts (`target/`, `node_modules/`) are git-excluded and marked app-owned scratch so the
warden never quarantines a worker for an artifact it didn't author. The director runs at the hub
itself and merges the branches via PRs.

### Planner workspace — `setup_workspaces` ([`planner/workspace.rs`](../src-tauri/src/planner/workspace.rs))

Builds the project hub at `~/.base-studio-code/projects/<key>/` (slugified by `sanitize_project_key`;
an empty key is refused). It creates `.claude/`, `prompts/`, `contracts/` (one doc per feature seam,
director-owned), and — only when the blueprint has a context stage — `context/`. It writes the
planner CLAUDE.md spec (from `prompts.rs` + the per-stage directives in `directives.rs`), the
permissions, and clones linked repos in as subdirs. The hub **never moves**: published-ness is the
in-place `.published` marker file (#922), not a directory location, so the planner's cwd (and Claude's
cwd-keyed `--continue` history) stays stable.

### Mobile tunnel — Noise IK over a zero-knowledge relay ([`mobile/tunnel/`](../src-tauri/src/mobile/tunnel/))

Both peers dial *out* to a Cloudflare relay (`relay/`); the relay forwards only opaque
`{ room, ciphertext }`. The payload is an end-to-end **Noise IK** session
(`Noise_IK_25519_ChaChaPoly_BLAKE2s`, [`noise.rs`](../src-tauri/src/mobile/tunnel/noise.rs)) — the
desktop is the **responder** with a long-lived static keypair; the mobile is the **initiator** and
learns the desktop's static public key from the **QR**. `TunnelState`
([`mod.rs`](../src-tauri/src/mobile/tunnel/mod.rs)) is the in-process bus that tees PTY output, holds
pane/session metadata + plan-sync caches, and gates input (every pairing starts **view-only** until
the desktop grants input). `transport.rs` dials the relay over `rustls` TLS, runs the handshake, and
pumps the bus (chunking PTY output under the 64KB Noise frame cap). The wire types in `protocol.rs`
mirror mobile's `types.ts` — breaking changes need coordinated PRs in both repos (and the contract
fixtures, resolved by filename via `find_fixture`, must stay byte-exact).

### Extensions / MCP ([`extensions/`](../src-tauri/src/extensions/))

`mcp_clone` downloads a catalog MCP server into `~/.base-studio-code/mcp/<name>` (slugified, can't
escape the root); `write_mcp_json` registers servers (incl. the bundled `bsc-research-mcp` /
`bsc-compliance-mcp`) into a session's `.mcp.json`. `write_session_hooks` writes the user's hooks
(wrapped through `bsc-hook` for telemetry); `write_session_skills` materializes attached skills as
real `.claude/skills/<slug>/SKILL.md` files. The `skill_store_*` / `skill_group_*` commands are the
desktop's thin wrapper over the global `crates/skilldb` store.

---

## 5. Tauri command conventions

A backend command is an `async`/sync `fn` annotated `#[tauri::command]`, made `pub(crate)`, and
listed in the `tauri::generate_handler![...]` block in [`app/run.rs`](../src-tauri/src/app/run.rs).
Shared state is injected via `State<'_, T>` (e.g. `State<'_, PtyState>`), the app handle via
`AppHandle`. Commands return `Result<T, String>` (the `Err` string surfaces to the frontend) or a
plain serializable value; errors are typically mapped with `.map_err(|e| e.to_string())`.

### The casing gotcha (still live)

> Tauri **auto-renames command *arguments* to snake_case** (the frontend calls
> `invoke('pty_create', { paneId, ... })` and Rust receives `pane_id`), **but it does *not* touch
> *return values***. A returned struct is serialized by serde **as-is**.

So a struct with plain Rust fields serializes as snake_case and the frontend must read snake_case —
e.g. `WorkspacePaths { planning_dir }` ([`planner/workspace.rs`](../src-tauri/src/planner/workspace.rs))
and `WorktreeCommit { hash, subject, author, date }`
([`observability/audit.rs`](../src-tauri/src/observability/audit.rs)) are read as `planning_dir`,
`hash`, … on the frontend. When a struct should present camelCase to the frontend, it carries
`#[serde(rename_all = "camelCase")]` explicitly — this is widespread (the tunnel protocol, source
data, perf/log configs, …). **Mismatched casing reads `undefined` silently** (#789), so match the
exact field name a command actually returns; don't assume camelCase.

---

## 6. The `bsc-*` runtime CLIs + shell helpers

Two distinct mechanisms, both reachable from any live session's own shell — this is the #1325 runtime
surface (live sessions can read/drive app state from their own bash).

**Compiled sidecar CLIs** (real binaries, execed by their absolute path via an env var so there are
no PATH changes; bundled with the app and rebuilt with `npm run build:plan`):

| Command | Crate | Pointed at | Role |
|---|---|---|---|
| `bsc-plan` | `plandb` | `$BSC_PLAN_DB` (per-project), `$BSC_PLAN_BIN` | The plan store CLI — planner writes; workers/director read + drive issue status. |
| `bsc-skill` | `skilldb` | `$BSC_SKILL_DB` (global), `$BSC_SKILL_BIN` | The global skills/task-groups CLI (with a subcommand). With *no* args it's the Skill-tool telemetry hook instead — argc is the discriminator. |
| `bsc-data` | `data` | `$BSC_DATA_BIN` | Read the per-project Data Model + PlatformScan (`bsc-data model get` / `bsc-data scan get`). |
| `bsc-research-mcp` | `research` | (stdio MCP) | Literature research tools for the planner/fleet. |
| `bsc-compliance-mcp` | `compliance` | (stdio MCP) | Current compliance standards for the planner. |
| `bsc-agent` | `bsc-agent` | (per-console harness) | The model-agnostic agent runtime, when a console's provider is `bsc-agent`. |

**Pure-shell helpers** ([`console/shell_rc.rs`](../src-tauri/src/console/shell_rc.rs)) — rc-file
fragments concatenated into `~/.base-studio-code/bsc-env.sh` and sourced via `BASH_ENV`. They have
hyphenated names (so they can't be `export -f`'d and must be *defined* in each subshell). Each one is
best-effort and exits 0 (or `return 2` for a deny) so it never wedges a tool or kills the shell:

- `bsc-checkpoint` — overwrite the triage "where we left off" doc (`$BSC_CHECKPOINT_DOC`).
- `bsc-note` — append a provenance-tagged decision to `DECISIONS.md`.
- `bsc-audit` (#257) — PreToolUse hook: append a redacted `ts·pane·tool·target` line (never file
  contents/secrets) to `audit.log`.
- `bsc-skill` (no args, #406) — Skill-tool telemetry to `skills.log`.
- `bsc-hook` (#867) — wraps each *user* hook, runs it, logs `ts·event·name·outcome` (propagating the
  exit code so a PreToolUse `exit 2` block still takes effect).
- `bsc-mcp` (#879) — Pre+PostToolUse hook for MCP tools: logs round-trip latency + outcome.
- `bsc-tokens` (#416) — Stop/SubagentStop hook: logs `session_id` + `transcript_path` (the transcript
  is the only per-message usage source; `read_token_usage` prices it).
- `bsc-activity` (#1184) — turn-boundary signal (`run`/`idle`) that gates the console status dot's
  silence timer so a working-but-silent worker doesn't false-idle.
- `bsc-done` (#1379) — a finished worker self-closes; the frontend reaps the pane.
- `bsc-confine` (#158) — PreToolUse file-tool hook: block writes that escape `$BSC_REPO_ROOT`.
- `bsc-scope` (#1297) — PreToolUse write-tool hook: hard-deny writes outside the pane's
  `$BSC_SCOPE_GLOBS` (the deny the role gate's allow-only rules lack).
- `bsc-taint` (#1167) — tainted-turn gate: block outward/destructive Bash (exfil, force-push,
  `gh repo delete`, raw `nc`) within `$BSC_TAINT_WINDOW` of ingesting untrusted input.
- `bsc-defer` (#369) — worker Stop hook: don't stop; keep driving owned issues to `develop`, or defer
  a genuine question to the director via `bsc-ask`.
- `bsc-fleet` (#734) — the director's roster view, joining `fleet.roster.tsv` with `coord.log`.
- Coordination emitters (#199/#376) on `coord.log`: `bsc-landed`/`bsc-merged`/`bsc-closed`/`bsc-failed`
  (satisfy/fail a dep), `bsc-wait` (paused for the user), `bsc-ask`/`bsc-answer` (worker↔director Q&A),
  `bsc-issue`/`bsc-assign` (capture/route work).
- `bsc-learned` (#1362) — record a self-correction *candidate* (delegates to `bsc-plan lesson add`),
  queued for the user to confirm/discard — never an auto-committed skill.

> The `bsc-blocked` dependency-wait helper was **removed** (#1039): workers build against the planned
> contract in parallel rather than parking on an upstream. CLAUDE.md's older copy still mentions it.

---

## 7. Testing

- **Where:** unit tests live in a `#[cfg(test)]` module inside the owning domain file (e.g. the rc
  syntax-validity tests in `shell_rc.rs`, the planner-template tests in `planner/mod.rs`).
  Cross-cutting integration tests live in [`src-tauri/src/tests.rs`](../src-tauri/src/tests.rs), with
  shared helpers (`temp_home`, `ENV_LOCK`, `write_file`) in `testutil.rs`.
- **Crates** test independently (`research`/`compliance`/`data` against in-memory or recorded fixtures
  with no live network; much of `data` compiles + tests without DuckDB via `--no-default-features`).
- **Commands** (mirror CI exactly):
  ```bash
  cargo check --workspace
  cargo clippy --workspace --all-targets -- -D warnings   # the gate — see below
  cargo test --workspace                                  # or -p <crate> to scope a slow build
  ```
- **The clippy gate:** CI runs `clippy --all-targets -D warnings`. `--all-targets` matters —
  `--lib` alone misses test-target lints (unused imports, `items_after_test_module`), so verify with
  `--all-targets` before pushing any Rust.

A new Rust command needs a unit test in its module's `#[cfg(test)]` block; a bug fix needs a
regression test in the same branch.

---

## 8. Gotchas

- **Worktrees moved out of the hub (#844).** They live at `~/.base-studio-code/worktrees/<key>/…`,
  **not** `projects/<key>/.worktrees/` as CLAUDE.md's "Workspace layout" still says. Trust
  `worktrees_dir` in [`platform/paths.rs`](../src-tauri/src/platform/paths.rs).
- **Two crates / several binaries CLAUDE.md's tree omits:** `crates/compliance` (`bsc-compliance-mcp`)
  and `crates/skilldb` (`bsc-skill`), plus the `bsc-data` binary. The full set is in
  [`crates/`](../crates/) and section [3](#3-workspace-crates) above.
- **rc constants must end with a trailing newline.** In `shell_rc.rs`, every helper constant ends in
  `"\n"` (or `concat!(…, "\n")`) — otherwise the concatenated functions glue together and the whole
  `bsc-env.sh` breaks with a bash syntax error (#296). The `full_bsc_rc_is_syntactically_valid_bash`
  test guards this; preserve it when adding a helper.
- **Return-value casing** — see [section 5](#5-tauri-command-conventions). A camelCase frontend read
  of a snake_case return is `undefined`, silently.
- **rustls needs an explicit CryptoProvider.** `run()` installs `ring` as the process default before
  any TLS, or the relay dial's first handshake panics the tunnel thread (rustls 0.23 can't
  auto-select one at runtime).
- **Process-tree cleanup is load-bearing.** The Windows Job Object / Unix process-group reaping in
  `pty.rs` (and the `RunEvent::Exit` drain in `run.rs`) is what stops orphaned `claude`/`gh`/`git`
  children from holding cwd locks on `~/.base-studio-code`.
- **Windows release toolchain:** the DuckDB/SQLite `bundled` C/C++ builds pin the Windows CI leg to a
  specific MSVC image — see the project's release notes if a bundled-store build fails.

---

For the React frontend (feature-first vertical slices, the store, the pane system, the planner UI),
see [`docs/frontend.md`](./frontend.md).
