# Model-agnostic agent shell (`bsc-agent`) — migration spec

**Epic:** [#1078](https://github.com/kevinthelago/base-studio-code/issues/1078). Make the app run on **any** LLM (Anthropic, OpenAI, Gemini, local/open-weight) by building our own model-agnostic agent runtime and migrating the Claude integrations behind pluggable seams.

## Governing principle: preserve the contract, swap the producer

The app consumes Claude Code through *contracts*, not a single API:

- the telemetry log files — `audit.log` / `coord.log` / `tokens.log` / `mcp.log` (`~/.base-studio-code/`),
- the **transcript** JSONL schema that `tokens.rs` parses for cost accounting,
- the **context files** (`CLAUDE.md` / `CLAUDE.local.md`),
- the **role / permission** model (`src/lib/session/sessionRoles.ts`),
- MCP config (`.mcp.json`).

If our runtime **emits those same contracts**, every existing reader and UI keeps working unchanged. So the migration builds a producer we own, makes it satisfy the contracts, and switches the producer per session behind an adapter. **Claude Code stays the default until parity.**

## The two seams

### 1. `LlmProvider` (API tier) — `crates/llm` (package `bsc-llm`)
A standalone, **Tauri-free** crate so any binary can depend on it. Normalizes provider differences:

- `complete()` — single-shot chat (used by `kb_chat` → planning autopilot, LLM grader, cleanup scan). Every provider maps its response into the shared `{ content: [{type:"text", text}], usage }` shape, so the frontend is provider-agnostic.
- `turn()` — **multi-turn tool use** (the agent loop). Normalized model:

  ```
  ToolDef { name, description, schema }      ToolCall { id, name, args }
  Msg = User | Assistant{text, tool_calls} | ToolResult{id, content}
  Turn { system, messages, tools, model, max_tokens } → turn() → TurnResult { text, tool_calls, usage, stop_reason }
  ```

  Per-provider mapping: **Anthropic** `tool_use`/`tool_result` blocks · **OpenAI** `tools`/`tool_calls`/`role:tool` · **Gemini** `functionDeclarations`/`functionCall`/`functionResponse` · **Local** reuses OpenAI mapping vs a configurable base URL (default Ollama).

Providers: `anthropic`, `openai`, `gemini`, `local`. Selection + per-provider keys + model + local base URL are configured in **Settings → Integrations**.

### 2. `HarnessAdapter` (runtime tier) — `src-tauri/src/harness/`
Abstracts how a session runtime is launched and set up, so `pty_create` doesn't hardcode `claude`. Methods (extracted incrementally — launch + pre-launch done):

`detect_history` · `launch_command` · `model_flag` · `shell_fn` · `is_harness_launch` · `prepare_config` · `trust_dir` · *(config/telemetry/usage methods co-evolve with the bsc-agent adapter)*.

- `ClaudeCodeAdapter` — the flagship impl; reproduces today's `claude` launch + `~/.claude.json` setup byte-for-byte.
- `BscAgentAdapter` *(future, P3)* — launches `bsc-agent`; many Claude-specific steps become no-ops (it enforces permissions + emits telemetry natively).

## `bsc-agent` — the runtime (`crates/bsc-agent`)

A **lean** binary (depends on `bsc-llm` + `serde_json` + `tokio`; **no Tauri**), shipped as a sidecar like `bsc-plan`.

- **Agent loop** (`run_agent<P: LlmProvider>`): build `Turn` (system from context files + conversation + tool defs) → `provider.turn()` → if `tool_calls`, gate + execute each, append `Assistant` + `ToolResult`, repeat; else return final text. Capped at `max_steps`; streams text + a `[tool]` trace to stdout (it runs in the PTY).
- **Tools:** `read_file`, `write_file`, `edit_file`, `bash` (grep/glob via `bash` for now). Each is a `ToolDef` + executor.
- **Permissions** (native): a `Permissions { deny_tools, deny_bash, write_globs }` loaded from `$BSC_AGENT_PERMS` (permissive default), checked before each tool runs; a denial is fed back as a `ToolResult` so the model adapts. This renders the generic role model **without** `.claude/settings.json`.
- **Telemetry + transcript** (native, *P2d*): emits `audit.log` (`ts⇥pane⇥tool⇥target`) + `tokens.log` (`ts⇥pane⇥session⇥transcript_path`) + a transcript JSONL whose assistant lines carry `message.model` + `message.usage{input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens}` — the exact shape `tokens.rs` parses. So the existing audit view + cost accounting light up unchanged.

Config from `BSC_AGENT_*` env (provider/model/key), mirroring the `bsc-plan` env pattern; task from argv/stdin; system prompt from cwd `CLAUDE.md`.

## Status

| Area | State |
|---|---|
| P1 — provider layer (Anthropic/OpenAI/Gemini/local) + config UI + local base URL + provider-neutral copy | ✅ merged |
| `bsc-plan` dev build + release `externalBin` sidecar + CI validation (mac universal + linux + windows) | ✅ merged & validated |
| P0a — `HarnessAdapter` launch seam · P0b — pre-launch (`~/.claude.json`) behind the adapter | ✅ merged |
| `crates/llm` — shared, Tauri-free provider crate | ✅ merged |
| P2a — tool-use `turn()` API + `bsc-agent` agent loop + `read_file` | ✅ merged |
| P2b — core tool set (`write_file`/`edit_file`/`bash`) | ✅ merged |
| P2c — native permission enforcement | 🔧 in progress |
| P2d — native telemetry + transcript | 📋 specced (#1110) |

## Remaining roadmap

- **P2d** — telemetry/transcript (contract above). Companion: extend `tokens.rs` `model_pricing` to OpenAI/Gemini families (**rates must be verified, not guessed**).
- **P3** — `BscAgentAdapter` + a `bsc-agent` `ConsoleProvider`; `bsc-agent` sidecar packaging (its own `externalBin`); MCP client; coordination emitters; resume; context-file + skills loading.
- **P4** — multi-provider/local runtime hardening (weaker tool-calling, no caching, smaller context).
- **P5** — fleet on `bsc-agent`: `fleetStartProject`/director/triage choose harness+provider per session; runtime provider config UX; parity test matrix.

## Top risks

1. **Tool-calling quality varies by model** — the #1 product risk; Claude Code's agent quality is what we re-create. Strict result parsing, retries, constrained protocol.
2. **Security is ours** — the role denies + FS confinement must be airtight in `bsc-agent`'s tool layer before any fleet runs on it (P2c).
3. **Contract drift** — keep the log/transcript schemas frozen as the integration boundary so the app side never forks per provider.
4. **Pricing accuracy** — don't hardcode unverified competitor rates.
