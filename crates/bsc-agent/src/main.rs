//! `bsc-agent` — the model-agnostic agent runtime (epic #1078, P2). A lean CLI that
//! runs a tool-using agent loop against any provider in `bsc-llm`. Configured by env
//! (so the app can launch it like `bsc-plan`): `BSC_AGENT_PROVIDER` (default
//! `anthropic`), `BSC_AGENT_MODEL`, `BSC_AGENT_API_KEY`. The task comes from argv (or
//! stdin); the system prompt is the global `~/.claude/CLAUDE.md` user memory + the `CLAUDE.md`
//! chain (cwd + ancestors) + `CLAUDE.local.md`, matching Claude Code's context loading. Output goes to
//! stdout — it runs inside the PTY like `claude` does.


use agent::{run_agent, Tool};
use tools::{bsc_cli_tool, default_tools};
use llm::{LlmProvider, Msg};
use permissions::Permissions;
use std::io::Read;
use std::io::IsTerminal;
use std::path::Path;
use std::sync::Arc;
use telemetry::Telemetry;

/// The user's home directory (for the global `~/.claude` memory), from the platform env. `None` when
/// neither var is set — then global user memory is simply skipped, like any other absent file.
fn home_dir() -> Option<std::path::PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(std::path::PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
}

/// Compose the system prompt the way Claude Code does: the global user memory (`~/.claude/CLAUDE.md`)
/// FIRST as the least-specific layer, then every `CLAUDE.md` from the filesystem root down to `start`
/// (most-specific last), then `start/CLAUDE.local.md` (the plan / local overrides copied into worker
/// worktrees), then skills. Absent/empty files are skipped. (#1078 P3 context parity)
fn compose_system(start: &Path) -> String {
    compose_system_inner(start, home_dir().as_deref(), std::env::var("BSC_AGENT_SKILLS").ok().as_deref())
}

/// The pure core of [`compose_system`], with the home dir AND the skills payload injected so it's
/// testable without touching process env. `home` supplies the global `~/.claude/CLAUDE.md` user
/// memory; `skills_json` is `$BSC_AGENT_SKILLS` (see [`compose_skills_from`] for the precedence rule).
fn compose_system_inner(start: &Path, home: Option<&Path>, skills_json: Option<&str>) -> String {
    let mut parts: Vec<String> = Vec::new();
    // Global user memory: Claude Code loads `~/.claude/CLAUDE.md` into EVERY session, and the app
    // writes it as its "global" target (the Settings global instructions — agent/claude_config.rs).
    // It is NOT an ancestor of a project hub / worktree, so the ancestor walk below would miss it —
    // read it FIRST (least-specific), so a bsc-agent session gets the same global context, overridden
    // by the project/local files that follow. (#parity)
    if let Some(home) = home {
        if let Ok(c) = std::fs::read_to_string(home.join(".claude").join("CLAUDE.md")) {
            if !c.trim().is_empty() {
                parts.push(c);
            }
        }
    }
    let mut dirs: Vec<&Path> = start.ancestors().collect();
    dirs.reverse(); // root first, `start` last — the most-specific CLAUDE.md appears last
    for d in dirs {
        if let Ok(c) = std::fs::read_to_string(d.join("CLAUDE.md")) {
            if !c.trim().is_empty() {
                parts.push(c);
            }
        }
    }
    // DE-DUPLICATE BY CONTENT, keeping the LAST (most-specific) copy.
    //
    // A worktree in this repo is NESTED under the repo root, so the ancestor walk finds the identical
    // `CLAUDE.md` twice — once at the root and once in the worktree, which is a checkout of the same
    // file. MEASURED: 105,928 bytes each, byte-identical, inside a system prompt that came to 215,175
    // characters (~54k tokens) before the task. The duplicate is pure loss: it doubles the largest
    // document in the prompt and teaches the model nothing the first copy did not.
    //
    // Keeping the LAST copy rather than the first preserves the precedence this loop exists to
    // establish — least-specific first, most-specific last, so a project file overrides a global one.
    // Dropping the later copy would silently invert that for any duplicated document.
    let mut seen: Vec<String> = Vec::new();
    let mut deduped: Vec<String> = Vec::new();
    for part in parts.into_iter().rev() {
        let key = part.trim().to_string();
        if !seen.contains(&key) {
            seen.push(key);
            deduped.push(part);
        }
    }
    deduped.reverse();
    let mut parts = deduped;
    if let Ok(c) = std::fs::read_to_string(start.join("CLAUDE.local.md")) {
        if !c.trim().is_empty() {
            parts.push(c);
        }
    }
    let skills = compose_skills_from(skills_json, start);
    if !skills.is_empty() {
        parts.push(format!("# Skills\n\n{skills}"));
    }
    parts.join("\n\n")
}

/// The skills this session runs with, from whichever channel supplied them.
///
/// **`$BSC_AGENT_SKILLS` wins outright when set** — it is the app's RESOLVED set for this pane
/// (session overrides + skill groups + the persona's own skills), and it arrives the same way the
/// runtime already receives `$BSC_AGENT_MCP` and `$BSC_AGENT_PERMS`, so all of a session's
/// configuration comes down one channel rather than two.
///
/// Why it does not MERGE with the filesystem scan: a bsc-agent session can run in a worktree where an
/// earlier Claude launch left a `.claude/skills` tree behind, and merging would mean the session
/// silently carrying a skill the app never resolved for it. The scan therefore serves exactly the case
/// the env cannot — a bare run outside the app, or a tree Claude Code populated — and only when
/// nothing was handed to us.
///
/// The env is the pane's whole skill set, so a parse failure is NOT silently swallowed: it is reported
/// and the session continues without skills, which is visible, rather than falling through to a
/// filesystem tree that would look like success. Pure → testable without touching process env.
fn compose_skills_from(env_json: Option<&str>, start: &Path) -> String {
    match env_json.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => match serde_json::from_str::<Vec<EnvSkill>>(raw) {
            Ok(skills) => render_env_skills(&skills),
            Err(e) => {
                eprintln!("\x1b[33m▸ BSC_AGENT_SKILLS parse error: {e} — running with NO skills\x1b[0m");
                String::new()
            }
        },
        None => compose_skills(start),
    }
}

/// One skill as the app hands it over. Mirrors the `SkillCfg` the Claude path writes into a
/// `SKILL.md`, so both harnesses are fed from the same resolved payload. Unknown fields are ignored,
/// so adding one on the app side cannot break a session launched by an older runtime.
#[derive(serde::Deserialize)]
struct EnvSkill {
    #[serde(default)]
    name: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    prompt: String,
}

/// Render env-supplied skills into the same shape the filesystem ones arrive in: a heading per skill
/// so the model can tell them apart, then the body. Sorted by name for determinism (the FS path sorts
/// by slug for the same reason — a prompt that reorders between launches is a prompt that cannot be
/// cached or compared). Skills with an empty body contribute nothing. Pure.
fn render_env_skills(skills: &[EnvSkill]) -> String {
    let mut rendered: Vec<String> = skills
        .iter()
        .filter(|s| !s.prompt.trim().is_empty())
        .map(|s| {
            let head = if s.description.trim().is_empty() {
                format!("## {}", s.name.trim())
            } else {
                format!("## {}\n\n{}", s.name.trim(), s.description.trim())
            };
            format!("{head}\n\n{}", s.prompt.trim())
        })
        .collect();
    rendered.sort();
    rendered.join("\n\n")
}

/// A one-line description of how many skills this session has and where they came from, for the
/// startup banner. Reports `none` explicitly rather than staying quiet — see the call site for why
/// that distinction is the whole point. Pure.
fn skills_origin(env_json: Option<&str>, start: &Path) -> String {
    match env_json.map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw) => match serde_json::from_str::<Vec<EnvSkill>>(raw) {
            Ok(s) => {
                let n = s.iter().filter(|s| !s.prompt.trim().is_empty()).count();
                format!("{n} from the app")
            }
            Err(_) => "NONE (BSC_AGENT_SKILLS unparseable)".to_string(),
        },
        None => {
            let n = start.join(".claude").join("skills");
            match std::fs::read_dir(&n) {
                Ok(e) => format!("{} from .claude/skills", e.flatten().filter(|d| d.path().is_dir()).count()),
                Err(_) => "none".to_string(),
            }
        }
    }
}

/// Concatenate the project's skills — every `<start>/.claude/skills/<slug>/SKILL.md`, sorted by
/// slug for determinism — so a bsc-agent session has the same skill context Claude Code discovers.
/// Returns "" when there's no skills dir. (#1078 P3 parity)
///
/// The FALLBACK path now (see [`compose_skills_from`]): it serves a bare run outside the app, or a
/// tree Claude Code populated, and is skipped whenever the app supplied this session's skills.
fn compose_skills(start: &Path) -> String {
    let dir = start.join(".claude").join("skills");
    let Ok(entries) = std::fs::read_dir(&dir) else { return String::new() };
    let mut slugs: Vec<std::path::PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .collect();
    slugs.sort();
    let mut out: Vec<String> = Vec::new();
    for slug in slugs {
        if let Ok(c) = std::fs::read_to_string(slug.join("SKILL.md")) {
            if !c.trim().is_empty() {
                out.push(c);
            }
        }
    }
    out.join("\n\n")
}

// The `bsc` subcommand set is the canonical `bsc_util::SIDECARS` registry (#1843/#1877) — ONE list
// shared by the shell helper (`console/shell_rc`) and the prompt block below. The app stages ONE
// umbrella binary as $BSC_BIN; every state CLI is a subcommand (`bsc plan …`, `bsc skill …`).

/// The subcommands available this session: the advertised registry when the unified `bsc` binary is
/// staged ($BSC_BIN set), else none. The two project-scoped ones note when their per-project store
/// env is absent (so the model isn't told to use `bsc plan` with no plan.db).
fn available_clis(is_set: &impl Fn(&str) -> bool) -> Vec<&'static bsc_util::Sidecar> {
    if !is_set("BSC_BIN") {
        return Vec::new();
    }
    bsc_util::SIDECARS.iter().filter(|c| c.advertise).collect()
}

/// Render the "Project CLIs available this session" system-prompt block from the available `clis`, or
/// "" when none are wired (a bare run outside the app — keeps the prompt clean). Each line names the
/// `bsc <sub>` invocation plus its purpose, and flags a project-scoped subcommand whose store env is
/// missing. The help-first protocol of `bsc <sub> help` is taught once in `AGENT_INSTRUCTIONS`; this
/// block is the live inventory.
fn render_clis_block(clis: &[&bsc_util::Sidecar], is_set: &impl Fn(&str) -> bool) -> String {
    if clis.is_empty() {
        return String::new();
    }
    let lines: Vec<String> = clis
        .iter()
        .map(|c| {
            let ctx = match c.context_env {
                Some(env) if !is_set(env) => "  (no project store in this session — needs a project context)",
                _ => "",
            };
            format!("- `bsc {}` — {}{}", c.name, c.blurb, ctx)
        })
        .collect();
    format!(
        "# Project CLIs available this session\n\
         The unified `bsc` CLI is wired into this session; each subcommand below is also available as a \
         TOOL you can call DIRECTLY by name — e.g. call the `bsc-plan` tool with `args: \"summary\"` — or \
         run it via the `bash` tool as `bsc <sub> …`. Each subcommand has a `help` command: run \
         `bsc <sub> help` for the command menu, then `bsc <sub> <command> help` for one command's args. \
         Check help before guessing.\n\n{}",
        lines.join("\n"),
    )
}

/// What a bare `bsc-agent` prints before it blocks reading its first task from a terminal.
///
/// Names the key that ENDS the input, because `read_to_string` waits for EOF rather than a newline —
/// a user who types a task and presses Enter sees nothing happen and concludes it is broken.
pub fn waiting_hint() -> &'static str {
    "\u{25b8} bsc-agent ready \u{2014} type a task, then press Ctrl-D to send it."
}

#[tokio::main]
async fn main() {
    // WHAT THIS SESSION IS, resolved from `.claude/session.json` up the tree, with an explicit
    // environment variable still winning (#a-session-outside-the-app-can-discover-itself-…).
    //
    // Inside the app every field arrives as an env var and this changes nothing. OUTSIDE it — a plain
    // terminal at a project — none of them do, and before this the session silently assumed
    // `anthropic`, advertised none of the `bsc` tools, and died on
    // `401 x-api-key header is required` against a service the user was not running.
    let cfg = bsc_cli_util::session::resolve(&std::env::current_dir().unwrap_or_default());
    // DISCOVER THE `bsc` BINARY when the app did not hand one over.
    //
    // `available_clis` gates the whole `bsc` tool surface on `$BSC_BIN`, so an external terminal saw
    // 10 tools instead of 32 — no `bsc-plan`, no `bsc-fleet`, no way to reach the project's own state.
    // The binary is a staged sidecar and is on no PATH, but its location IS structural
    // (`<base>/bin/bsc`), which is exactly the kind of fact discovery should supply.
    //
    // Set only when absent, so an app-launched session keeps the path the app chose — and only when
    // the file actually EXISTS, because advertising 22 tools backed by nothing is worse than
    // advertising none.
    if std::env::var("BSC_BIN").map(|v| v.trim().is_empty()).unwrap_or(true) {
        if let Some(base) = bsc_util::bsc_base_dir() {
            let bin = base.join("bin").join(if cfg!(windows) { "bsc.exe" } else { "bsc" });
            if bin.is_file() {
                std::env::set_var("BSC_BIN", &bin);
            }
        }
    }
    // `--context` prints the whole resolution and exits: what resolved, from where, and what did not.
    // The absent half is the useful half, and it is the answer to "why does my fresh machine behave
    // differently" in one step rather than an afternoon.
    if std::env::args().any(|a| a == "--context") {
        print!("{}", bsc_cli_util::session::render_report(&cfg));
        return;
    }
    // NO SILENT DEFAULT. A provider nobody chose is what produced the 401, and that error named
    // neither the cause nor the fix. Refusing costs one line and answers both.
    let Some(provider) = cfg.get("provider").map(str::to_string) else {
        eprintln!("bsc-agent: no provider resolved for this session.");
        eprintln!("  Set $BSC_AGENT_PROVIDER, or write one into `.claude/session.json`:");
        eprintln!("    ~/.claude/session.json          a machine default");
        eprintln!("    <project>/.claude/session.json  for one project");
        eprintln!("    {{ \"provider\": \"ollama\", \"model\": \"<your model>\" }}");
        eprintln!("  `bsc-agent --context` shows what resolved, from where, and what did not.");
        std::process::exit(2);
    };
    let model = cfg.get("model").unwrap_or_default().to_string();
    let api_key = std::env::var("BSC_AGENT_API_KEY").unwrap_or_default();

    // Task: argv (joined) if given, else stdin. A leading `--continue`/`-c` flag
    // requests resuming the prior conversation for this cwd (see $BSC_AGENT_SESSION),
    // mirroring `claude --continue`.
    let mut argv: Vec<String> = std::env::args().skip(1).collect();
    let resume = argv.first().map(|a| a == "--continue" || a == "-c").unwrap_or(false);
    if resume {
        argv.remove(0);
    }
    let task = if argv.is_empty() {
        // SAY SO BEFORE BLOCKING. `read_to_string` waits for EOF, and on a PTY that is silent — a
        // pane showing a bare `bsc-agent` waiting for a task looks exactly like a crashed session.
        // That is how a director came up as a blank screen: its kickoff pointer was lost, so it was
        // launched with no task, and it sat here saying nothing. Only on a terminal — piped input
        // (the fleet's normal path) must keep stdout/stderr clean.
        if std::io::stdin().is_terminal() {
            eprintln!("\x1b[2m{}\x1b[0m", waiting_hint());
        }
        let mut s = String::new();
        let _ = std::io::stdin().read_to_string(&mut s);
        s.trim().to_string()
    } else {
        argv.join(" ")
    };
    if task.is_empty() {
        eprintln!("usage: bsc-agent <task>   (or pipe the task on stdin)");
        std::process::exit(2);
    }

    // System prompt = the CLAUDE.md chain (ancestors + cwd) + CLAUDE.local.md (the plan),
    // matching Claude Code's context loading so a bsc-agent worker sees the same context.
    let mut system = compose_system(&std::env::current_dir().unwrap_or_default());

    // Append the live inventory of `bsc-*` state CLIs wired into THIS session (Part B): probe which
    // sidecars are staged ($BSC_*_BIN set) and tell the model exactly which it can run + that each has
    // a `help` command. Done before the banner so the reported `context=` size includes it.
    let env_set = |k: &str| std::env::var(k).map(|v| !v.trim().is_empty()).unwrap_or(false);
    let clis = available_clis(&env_set);
    let cli_block = render_clis_block(&clis, &env_set);
    if !cli_block.is_empty() {
        system = format!("{system}\n\n{cli_block}");
    }

    // Startup banner (to the PTY): the launch command + screen-clear scrolls the baked task out of
    // view, so echo what THIS session is actually running — provider, model, context size, and a task
    // preview — so the user can see it started and isn't staring at a silent, seemingly-hung screen.
    eprintln!(
        "\x1b[2m▸ bsc-agent · provider={provider} · model={} · context={} chars · skills: {}\x1b[0m",
        if model.is_empty() { "<default>" } else { &model },
        system.len(),
        // Say where the skills came from, and say it even when there are none. This bug's whole shape
        // was SILENCE: a session ran with zero skills and every visible surface looked identical to
        // one that had them, so nothing distinguished "none attached" from "never delivered". A count
        // plus its source is the smallest thing that tells those two apart at a glance.
        skills_origin(std::env::var("BSC_AGENT_SKILLS").ok().as_deref(), &std::env::current_dir().unwrap_or_default()),
    );
    let preview: String = task.chars().take(160).collect();
    eprintln!("\x1b[2m▸ task: {preview}{}\x1b[0m", if task.chars().count() > 160 { "…" } else { "" });
    // Echo the project CLIs wired this session (Part B): the model is told what's available + that each
    // has a `help` command, so it reaches for `bsc plan` etc. instead of never discovering them.
    if !clis.is_empty() {
        let names: Vec<String> = clis.iter().map(|c| format!("bsc {}", c.name)).collect();
        eprintln!(
            "\x1b[2m▸ project CLIs ({}): {} — run `bsc <sub> help` for commands\x1b[0m",
            names.len(),
            names.join(", "),
        );
    }
    // The native tool set (read/write/edit/bash/grep/glob/webfetch + the `task` sub-agent
    // tool) is built per-provider by `default_tools` once the provider is resolved below, so
    // the `task` tool can capture the live provider. MCP tools are collected up front here.
    //
    // MCP tools ($BSC_AGENT_MCP, a JSON array of server cfgs) — connect each (best-effort: a
    // failed server is logged + skipped), add its tools (namespaced mcp__<server>__<tool>), and
    // keep the clients alive for the session so the child processes aren't dropped.
    let mut mcp_tools: Vec<Tool> = Vec::new();
    let mut _mcp_clients = Vec::new();
    if let Ok(raw) = std::env::var("BSC_AGENT_MCP") {
        if !raw.trim().is_empty() {
            match serde_json::from_str::<Vec<mcp::McpServerCfg>>(&raw) {
                Ok(cfgs) => {
                    if !cfgs.is_empty() {
                        eprintln!("\x1b[2m▸ connecting {} MCP server(s)…\x1b[0m", cfgs.len());
                    }
                    for cfg in &cfgs {
                        match mcp::connect(cfg).await {
                            Ok((client, mut mtools)) => {
                                eprintln!("\x1b[2m  ✓ {} ({} tool(s))\x1b[0m", cfg.name, mtools.len());
                                mcp_tools.append(&mut mtools);
                                _mcp_clients.push(client);
                            }
                            // A failed/timed-out server is skipped, not fatal — the session still runs.
                            Err(e) => eprintln!("\x1b[33m  ✗ mcp '{}' skipped: {e}\x1b[0m", cfg.name),
                        }
                    }
                }
                Err(e) => eprintln!("bsc-agent: BSC_AGENT_MCP parse error: {e}"),
            }
        }
    }
    // First-class tools for the project CLIs wired this session (#qwen): a local model calls `bsc-plan`
    // as a TOOL (not via the `bash` tool), then bounces off "unknown tool" and gives up — so register
    // each staged CLI by its real name. They ride alongside the MCP tools into the loop (and show in
    // the tool-visibility banner). Gated on the same availability probe as the system-prompt block.
    for c in &clis {
        mcp_tools.push(bsc_cli_tool(c.name));
    }
    // Least-privilege gate ($BSC_AGENT_PERMS); permissive when unset.
    let perms = permissions::Permissions::from_env();
    // Native telemetry: audit.log + tokens.log + transcript ($BSC_AUDIT_LOG / $BSC_TOKENS_LOG);
    // no-op when those aren't set. Emits the contracts the app's readers already consume.
    let tele = telemetry::Telemetry::from_env();

    // Provider headroom ($BSC_RATELIMIT_LOG): install the process-wide observer so every response's
    // rate-limit position is RECORDED, not merely parsed. `crates/llm` reports each snapshot on the
    // request path; nothing persisted them, so "how much budget does this fleet have left" had no
    // answer and could only be found by hitting the limit. A no-op when the env var is unset (a hand
    // shell, a one-off CLI run) — and `bsc mem headroom` reports an absent stream as UNKNOWN rather
    // than as plenty, so recording nothing never reads as having room.
    llm::ratelimit::install_rate_limit_log();

    // Resume: the app hands us the per-cwd conversation file via $BSC_AGENT_SESSION. We persist
    // the conversation there on exit (so a later launch can resume), and with `--continue` seed
    // the loop from it. Absent/empty path ⇒ no persistence and always a fresh conversation.
    let session_path = std::env::var("BSC_AGENT_SESSION")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .map(std::path::PathBuf::from);
    let prior: Vec<Msg> = match (resume, &session_path) {
        (true, Some(p)) => agent::load_conversation(p),
        _ => Vec::new(),
    };
    let session_path = session_path.as_deref();

    let kind = match llm::resolve_provider(&provider) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("bsc-agent: {e}");
            std::process::exit(2);
        }
    };

    eprintln!("\x1b[2m▸ contacting the model — the first local response can take a while (model load + context)…\x1b[0m");
    // Build the provider once via the shared factory (#1845) instead of a 5-arm match. The Ollama
    // tool-using path first detects the model's `/api/show` profile — tool capability, stop tokens,
    // and context length — so tools are advertised/parsed correctly and num_ctx is sized from the real
    // context (#1829: the native /api/chat turn path sets num_ctx; without it Ollama silently truncates
    // a long agent prompt to its ~4096 default). Other providers ignore base_url + profile.
    // $BSC_AGENT_BASE_URL is the app-supplied local/ollama endpoint (default Ollama when unset/empty);
    // $BSC_AGENT_NUM_CTX is the user's per-agent (VRAM-bound) context-window cap.
    // Both through the SAME resolution as provider/model, so a terminal session reaches the endpoint
    // and the context cap the machine is configured for instead of guessing at defaults.
    let base_url = cfg.get("baseUrl").map(str::to_string);
    let num_ctx_cap = cfg.get("numCtx").and_then(|s| s.trim().parse::<u64>().ok());
    let ollama_profile = if matches!(kind, llm::ProviderKind::Ollama) {
        let base = base_url.as_deref().unwrap_or(llm::DEFAULT_LOCAL_BASE_URL);
        // #176: the app's own defaulting can hand us a model name this Ollama doesn't have — the
        // packaged `qwen3-coder` default, on a machine that never pulled it. Left unchecked, that
        // reached the real `/api/chat` call and died on a bare 404 with no hint the MODEL NAME was
        // the problem. Check against what's actually installed and fail with a clear, actionable
        // message BEFORE spending a turn on it. Best-effort: `list_models` failing means the
        // endpoint itself is unreachable, which is a connectivity problem, not a verdict that the
        // model is absent — skip the check and let the (already reachable-endpoint-shaped) error
        // from the real request explain that instead.
        if let Ok(installed) = llm::list_models(base).await {
            if !llm::model_is_installed(&model, &installed) {
                eprintln!("bsc-agent: {}", llm::model_not_installed_error(&model, base, &installed));
                std::process::exit(2);
            }
        }
        let profile = llm::detect_ollama_profile(base, &model).await;
        eprintln!(
            "\x1b[2m▸ ollama model '{model}': tools={}, {} stop token(s), model ctx={}\x1b[0m",
            profile.supports_tools,
            profile.stop.len(),
            profile.context_length.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
        );
        Some(profile)
    } else {
        None
    };
    let provider = llm::build_provider(kind, base_url, ollama_profile, num_ctx_cap);
    // Tell the agent loop the model's context budget so it can compact older turns to fit (#1831).
    let context_budget = provider.context_budget_tokens();
    std::env::set_var("BSC_AGENT_CONTEXT_BUDGET", context_budget.to_string());
    let result = run_with_provider(provider, &api_key, &model, &system, &task, mcp_tools, &perms, &tele, &prior, session_path, context_budget).await;

    if let Err(e) = result {
        eprintln!("bsc-agent: {e}");
        std::process::exit(1);
    }
}

/// Build the full tool set for `provider` (the native `default_tools` — which captures an
/// `Arc<provider>` so the `task` tool can spawn child loops — plus the connected MCP tools)
/// and run the root agent loop. Generic over the provider so each [`llm::ProviderKind`] arm
/// shares one path. `mcp_tools` is moved in (only the matched arm runs).
#[allow(clippy::too_many_arguments)]
async fn run_with_provider<P: LlmProvider + Send + Sync + 'static>(
    provider: P,
    api_key: &str,
    model: &str,
    system: &str,
    task: &str,
    mcp_tools: Vec<Tool>,
    perms: &Permissions,
    tele: &Telemetry,
    prior: &[Msg],
    session_path: Option<&Path>,
    context_budget: usize,
) -> Result<String, String> {
    let provider = Arc::new(provider);
    let mut tools = default_tools(
        Arc::clone(&provider),
        api_key.to_string(),
        model.to_string(),
        system.to_string(),
        perms.clone(),
        0,
    );
    tools.extend(mcp_tools);
    // Tool-visibility banner (to the PTY): list every tool the model actually has this session —
    // the native verbs plus the namespaced `mcp__<server>__<tool>` entries — so the user can see
    // what's wired up (the per-server counts above don't name the tools, and the native set was
    // never echoed at all). Dim, like the rest of the startup banner.
    let tool_names: Vec<&str> = tools.iter().map(|t| t.def.name.as_str()).collect();
    eprintln!("\x1b[2m▸ {} tool(s) available: {}\x1b[0m", tool_names.len(), tool_names.join(", "));
    // Context-fit check — the ONE place a silent truncation becomes visible.
    //
    // Done HERE, after the tools exist, because the tool schemas are part of the fixed prompt and
    // counting them as free is half of how this was missed. The other half is that the loss is
    // invisible: Ollama truncates an over-window prompt to HALF the window and answers normally, so
    // the session looks fine while the model has lost its CLAUDE.md. Nothing downstream can detect
    // that, which is why the check has to happen before the first request rather than be inferred
    // from a bad answer later. Not fatal — a truncated session still runs, and refusing to start
    // would be worse than starting with a warning the user can act on.
    let tool_defs: Vec<llm::ToolDef> = tools.iter().map(|t| t.def.clone()).collect();
    let fixed_tokens = llm::estimate_tokens(system) + llm::estimate_tool_tokens(&tool_defs);
    if let Some(o) = llm::check_context_fit(fixed_tokens, context_budget) {
        eprintln!(
            "\x1b[33m▸ WARNING: this session's context does not fit its window — ~{} tokens of system \
             prompt + tool schemas against a {}-token window.\x1b[0m",
            o.prompt_tokens, o.window,
        );
        eprintln!(
            "\x1b[33m  The runtime will keep only the LAST ~{} tokens and DISCARD the head — which is \
             where CLAUDE.md is. Expect the model not to know the project.\x1b[0m",
            o.kept_tokens,
        );
        eprintln!(
            "\x1b[33m  Fix: raise the per-agent context cap (Settings → LLM provider, or \
             $BSC_AGENT_NUM_CTX) above ~{}, or trim the session's CLAUDE.md / skills.\x1b[0m",
            o.prompt_tokens,
        );
    }
    // The root session runs in a PTY, so it's INTERACTIVE: after the initial task settles it keeps
    // the session alive and reads further user turns from stdin (Claude-REPL parity), instead of the
    // process exiting after one response and ending the pane. (#1078 interactive mode)
    // The step budget. 20 was a hardcoded positional literal here, with no way to change it and
    // nothing naming it — which made "we hit the 20-step limit" a fact nobody could act on. It is a
    // per-MODEL number: a 35B MoE finishes work a 9B abandons, and the right budget follows the
    // model rather than the harness. Kept at 20 by default so nothing changes unasked.
    let max_steps: usize = std::env::var("BSC_AGENT_MAX_STEPS")
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .filter(|n| *n > 0)
        .unwrap_or(20);
    run_agent(&*provider, api_key, model, system, task, &tools, perms, tele, prior, session_path, max_steps, true).await
}

#[cfg(test)]
mod tests {

    /// A bare `bsc-agent` must SAY it is waiting before it blocks.
    ///
    /// `read_to_string` waits for EOF, and on a PTY that is silent — a pane showing a bare
    /// `bsc-agent` waiting for a task is indistinguishable from a crashed session. That is exactly
    /// how a director came up as a blank screen: its kickoff pointer was lost, so it launched with
    /// no task and sat there saying nothing.
    #[test]
    fn a_bare_agent_announces_that_it_is_waiting_for_input() {
        let hint = super::waiting_hint();
        assert!(!hint.trim().is_empty(), "silence is what made this look like a crash");
        // It must name the key that ENDS the input. `read_to_string` waits for EOF, not a newline,
        // so a user who types a task and presses Enter sees nothing happen.
        assert!(hint.contains("Ctrl-D"), "the hint must say how to send: {hint}");
        assert!(hint.contains("bsc-agent"), "and which program is waiting: {hint}");
    }

    /// ...and only on a TERMINAL. The fleet pipes a kickoff in; a banner on that path would land in
    /// the agent's own stdout/stderr stream and be read as output.
    #[test]
    fn the_waiting_hint_is_gated_on_stdin_being_a_terminal() {
        let src = include_str!("main.rs");
        let body = &src[..src.find("#[cfg(test)]").unwrap_or(src.len())];
        let at = body.find("waiting_hint()").and_then(|_| body.find("eprintln!(\"\\x1b[2m{}"));
        assert!(at.is_some(), "the hint is printed somewhere");
        let before = &body[..at.unwrap()];
        assert!(
            before.rfind("is_terminal()").is_some_and(|g| g > before.len().saturating_sub(400)),
            "the print must sit behind an `is_terminal()` guard",
        );
    }

    use super::{available_clis, compose_skills_from, compose_system_inner, render_clis_block, skills_origin};
    use std::fs;

    /// Compose with NO global home memory and NO app-supplied skills, so neither a real
    /// `~/.claude/CLAUDE.md` on the dev machine nor an inherited `$BSC_AGENT_SKILLS` can leak into
    /// these structural assertions. Both layers have their own tests below.
    /// A NESTED worktree finds the identical CLAUDE.md twice, and it is the largest document in the
    /// prompt (#a-local-session-is-never-told-where-it-is-or-who-it-is).
    ///
    /// MEASURED before the fix: 105,928 bytes each, byte-identical, in a system prompt of 215,175
    /// characters (~54k tokens) before the task. The duplicate is pure loss.
    #[test]
    fn an_identical_ancestor_document_is_loaded_once() {
        let base = std::env::temp_dir().join(format!("bsc-dedupe-{}", std::process::id()));
        let nested = base.join("wt-x");
        std::fs::create_dir_all(&nested).unwrap();
        let doc = "# PROJECT SPEC
the one document
";
        std::fs::write(base.join("CLAUDE.md"), doc).unwrap();
        std::fs::write(nested.join("CLAUDE.md"), doc).unwrap();

        let s = compose_system_inner(&nested, None, None);
        assert_eq!(s.matches("# PROJECT SPEC").count(), 1, "loaded once, not twice:\n{s}");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// ...and de-duplication must not disturb PRECEDENCE, which is the whole reason the walk is
    /// ordered least-specific first. Keeping the earlier copy of a duplicate would silently move a
    /// project-level document up to where a global one sits.
    #[test]
    fn de_duplication_keeps_the_most_specific_copy() {
        // THREE levels, so ordering is observable: a UNIQUE document at the top, then the same
        // document twice below it. With only a duplicated pair there is nothing to be ordered
        // against, and the assertion would prove nothing.
        let base = std::env::temp_dir().join(format!("bsc-dedupe-order-{}", std::process::id()));
        let mid = base.join("mid");
        let leaf = mid.join("leaf");
        std::fs::create_dir_all(&leaf).unwrap();
        std::fs::write(base.join("CLAUDE.md"), "ROOT-ONLY\n").unwrap();
        std::fs::write(mid.join("CLAUDE.md"), "SHARED\n").unwrap();
        std::fs::write(leaf.join("CLAUDE.md"), "SHARED\n").unwrap();

        let s = compose_system_inner(&leaf, None, None);
        assert_eq!(s.matches("SHARED").count(), 1, "the duplicate is dropped:\n{s}");
        assert!(s.contains("ROOT-ONLY"), "the unique ancestor survives");
        // Precedence is the whole reason the walk is ordered least-specific first: keeping the
        // EARLIER copy of a duplicate would move a project document up to where a global one sits.
        assert!(
            s.find("ROOT-ONLY") < s.find("SHARED"),
            "least-specific still first after de-duplication:\n{s}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// A document that merely SHARES a prefix is not a duplicate.
    #[test]
    fn two_different_documents_both_survive() {
        let base = std::env::temp_dir().join(format!("bsc-dedupe-diff-{}", std::process::id()));
        let nested = base.join("wt-x");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(base.join("CLAUDE.md"), "ROOT RULES
").unwrap();
        std::fs::write(nested.join("CLAUDE.md"), "WORKTREE RULES
").unwrap();
        let s = compose_system_inner(&nested, None, None);
        assert!(s.contains("ROOT RULES") && s.contains("WORKTREE RULES"));
        assert!(s.find("ROOT RULES") < s.find("WORKTREE RULES"), "least-specific first");
        let _ = std::fs::remove_dir_all(&base);
    }

    fn compose_system(start: &std::path::Path) -> String {
        compose_system_inner(start, None, None)
    }

    #[test]
    fn global_user_memory_is_injected_first_then_overridden_by_project_files() {
        // Mirrors Claude Code: ~/.claude/CLAUDE.md (the app's "global" target) loads into every
        // session as the LEAST-specific layer. bsc-agent must inject it too (it's not an ancestor of
        // the project hub / worktree, so the ancestor walk alone misses it). (#parity)
        let base = std::env::temp_dir().join(format!("bsc-agent-global-{}", std::process::id()));
        let home = base.join("home");
        let proj = base.join("proj"); // a sibling of home — NOT under it, like a real project hub
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(&proj).unwrap();
        fs::write(home.join(".claude").join("CLAUDE.md"), "GLOBAL-MEMORY").unwrap();
        fs::write(proj.join("CLAUDE.md"), "PROJECT-SPEC").unwrap();

        let s = compose_system_inner(&proj, Some(home.as_path()), None);
        let (gi, pi) = (s.find("GLOBAL-MEMORY"), s.find("PROJECT-SPEC"));
        assert!(gi.is_some() && pi.is_some(), "both global + project present: {s}");
        assert!(gi < pi, "global memory is least-specific (appears first): {s}");

        // With no home, the global layer is simply absent (best-effort) — not an error.
        let none = compose_system_inner(&proj, None, None);
        assert!(!none.contains("GLOBAL-MEMORY"));
        assert!(none.contains("PROJECT-SPEC"));

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn available_clis_filters_to_staged_bins_and_block_flags_missing_context() {
        // #1877: staging is binary-level — the unified `bsc` is staged ($BSC_BIN), so EVERY advertised
        // subcommand is available. Here no project store is present (BSC_PLAN_DB / BSC_DATA_DB absent).
        let is_set = |k: &str| k == "BSC_BIN";
        let clis = available_clis(&is_set);
        let names: Vec<&str> = clis.iter().map(|c| c.name).collect();
        assert_eq!(
            names,
            vec!["plan", "fleet", "request", "errors", "usage", "todo", "data", "skill", "logs", "compliance", "blueprint", "persona", "teams", "secret", "component", "ui", "project", "files", "graph", "mem", "perf", "publish"],
            "lists every advertised subcommand, in order, once $BSC_BIN is staged",
        );

        let block = render_clis_block(&clis, &is_set);
        assert!(block.contains("# Project CLIs available this session"));
        assert!(block.contains("bsc plan"));
        assert!(block.contains("bsc files"));
        // The help-first protocol is referenced (as `bsc <sub> help`) so the model self-serves detail.
        assert!(block.contains("bsc <sub> help"));
        // bsc plan + bsc data are project-scoped and their stores are absent → flagged.
        assert!(block.contains("needs a project context"));
    }

    #[test]
    fn render_clis_block_is_empty_when_nothing_is_staged() {
        // A bare run outside the app (no $BSC_BIN) injects nothing — the prompt stays clean.
        let none = |_k: &str| false;
        assert!(available_clis(&none).is_empty());
        assert!(render_clis_block(&[], &none).is_empty());
    }

    #[test]
    fn project_cli_with_its_store_present_is_not_flagged() {
        // $BSC_BIN staged AND every project store present → no "needs a project context" caveat on
        // any project-scoped subcommand. The store list derives from SIDECARS so adding a new
        // project-scoped sidecar can't silently rot this test again (#2414: `errors` did exactly that).
        let stores: Vec<&'static str> = bsc_util::SIDECARS.iter().filter_map(|s| s.context_env).collect();
        let is_set = move |k: &str| k == "BSC_BIN" || stores.contains(&k);
        let clis = available_clis(&is_set);
        let block = render_clis_block(&clis, &is_set);
        assert!(block.contains("bsc plan"));
        assert!(!block.contains("needs a project context"));
    }

    #[test]
    fn composes_ancestor_chain_then_local() {
        let base = std::env::temp_dir().join(format!("bsc-agent-ctx-{}", std::process::id()));
        let inner = base.join("repo").join("worktree");
        fs::create_dir_all(&inner).unwrap();
        fs::write(base.join("repo").join("CLAUDE.md"), "OUTER").unwrap();
        fs::write(inner.join("CLAUDE.md"), "INNER").unwrap();
        fs::write(inner.join("CLAUDE.local.md"), "LOCAL").unwrap();

        let s = compose_system(&inner);
        let (oi, ii, li) = (s.find("OUTER"), s.find("INNER"), s.find("LOCAL"));
        assert!(oi.is_some() && ii.is_some() && li.is_some(), "all present: {s}");
        // ancestor CLAUDE.md before cwd CLAUDE.md before CLAUDE.local.md
        assert!(oi < ii && ii < li, "ordering: {s}");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn includes_local_even_without_cwd_claude_md() {
        let dir = std::env::temp_dir().join(format!("bsc-agent-local-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("CLAUDE.local.md"), "PLAN-ONLY-MARKER").unwrap();
        assert!(compose_system(&dir).contains("PLAN-ONLY-MARKER"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// THE REGRESSION. A bsc-agent pane got NO skills, and the reason it went unnoticed is that the
    /// only writer of `.claude/skills` is `write_session_skills`, reached from
    /// `ensure_session_settings`, which `TerminalView` calls only for a CLAUDE pane. So the runtime
    /// scanned a directory nothing had ever created for it and found nothing — which is
    /// indistinguishable, from every visible surface, from a session that legitimately has no skills.
    ///
    /// The app now hands the pane's RESOLVED set over directly. This asserts on a tree with NO
    /// `.claude/skills` at all, which is the real shape of the bug: before the change this composed to
    /// a prompt with no Skills section no matter what the app had resolved.
    #[test]
    fn the_apps_resolved_skills_reach_a_session_with_no_skills_directory() {
        let dir = std::env::temp_dir().join(format!("bsc-agent-envskills-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        assert!(!dir.join(".claude").join("skills").exists(), "the bug's shape: no skills tree exists");

        let payload = r#"[
            {"id":"open-pr","name":"Open a PR","description":"how this repo opens PRs","prompt":"PR-BODY-MARKER"}
        ]"#;
        let s = compose_system_inner(&dir, None, Some(payload));
        assert!(s.contains("# Skills"), "the section is present: {s}");
        assert!(s.contains("PR-BODY-MARKER"), "the skill's BODY is what the model needs: {s}");
        assert!(s.contains("Open a PR"), "named, so the model can tell skills apart: {s}");
        assert!(s.contains("how this repo opens PRs"), "the description rides along too: {s}");

        // Without the payload — the state before this change — the same tree yields nothing at all.
        assert!(!compose_system_inner(&dir, None, None).contains("# Skills"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_apps_skills_win_over_a_tree_claude_left_behind() {
        // A bsc-agent session can run in a worktree an earlier Claude launch populated. Merging the
        // two would mean silently carrying a skill the app did not resolve for THIS pane, so the env
        // is authoritative and the scan is skipped entirely.
        let dir = std::env::temp_dir().join(format!("bsc-agent-skillprec-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let stale = dir.join(".claude").join("skills").join("leftover");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("SKILL.md"), "STALE-CLAUDE-SKILL").unwrap();

        let payload = r#"[{"id":"a","name":"Current","description":"","prompt":"CURRENT-SKILL"}]"#;
        let s = compose_system_inner(&dir, None, Some(payload));
        assert!(s.contains("CURRENT-SKILL"), "the app's set is used: {s}");
        assert!(!s.contains("STALE-CLAUDE-SKILL"), "the leftover tree is NOT merged in: {s}");

        // With no payload the same tree is still readable — that fallback is what serves a bare run.
        assert!(compose_system_inner(&dir, None, None).contains("STALE-CLAUDE-SKILL"));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unparseable_skills_payload_is_reported_rather_than_silently_falling_back() {
        // The env IS this pane's whole skill set. Falling through to a filesystem tree on a parse
        // error would produce a session that looks correct while running someone else's skills —
        // the same class of silent substitution this whole item is about.
        let dir = std::env::temp_dir().join(format!("bsc-agent-skillbad-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let stale = dir.join(".claude").join("skills").join("leftover");
        fs::create_dir_all(&stale).unwrap();
        fs::write(stale.join("SKILL.md"), "STALE-CLAUDE-SKILL").unwrap();

        let s = compose_system_inner(&dir, None, Some("{not json"));
        assert!(!s.contains("STALE-CLAUDE-SKILL"), "a bad payload must not fall back to the tree: {s}");
        assert!(!s.contains("# Skills"), "and must not invent a Skills section: {s}");
        assert_eq!(skills_origin(Some("{not json"), &dir), "NONE (BSC_AGENT_SKILLS unparseable)");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn env_skills_render_deterministically_and_drop_empty_bodies() {
        // Determinism: a prompt that reorders between launches cannot be cached or diffed, which is
        // why the filesystem path sorts by slug. The env path sorts too, regardless of array order.
        let payload = r#"[
            {"id":"z","name":"Zebra","description":"","prompt":"Z-BODY"},
            {"id":"a","name":"Alpha","description":"","prompt":"A-BODY"},
            {"id":"e","name":"Empty","description":"has no body","prompt":"   "}
        ]"#;
        let out = compose_skills_from(Some(payload), std::path::Path::new("/nonexistent"));
        let (a, z) = (out.find("A-BODY"), out.find("Z-BODY"));
        assert!(a.is_some() && z.is_some() && a < z, "sorted by name, not array order: {out}");
        assert!(!out.contains("Empty"), "a skill with no body contributes nothing: {out}");
    }

    #[test]
    fn skills_origin_names_the_channel_and_says_none_out_loud() {
        // The banner has to distinguish "none attached" from "never delivered" — those looked
        // identical for the entire life of this bug.
        let empty = std::env::temp_dir().join(format!("bsc-agent-origin-{}", std::process::id()));
        let _ = fs::remove_dir_all(&empty);
        fs::create_dir_all(&empty).unwrap();
        assert_eq!(skills_origin(None, &empty), "none");
        assert_eq!(
            skills_origin(Some(r#"[{"id":"a","name":"A","description":"","prompt":"B"}]"#), &empty),
            "1 from the app",
        );
        fs::create_dir_all(empty.join(".claude").join("skills").join("one")).unwrap();
        assert_eq!(skills_origin(None, &empty), "1 from .claude/skills");
        let _ = fs::remove_dir_all(&empty);
    }

    #[test]
    fn folds_in_skills_sorted_by_slug() {
        let dir = std::env::temp_dir().join(format!("bsc-agent-skills-{}", std::process::id()));
        let skills = dir.join(".claude").join("skills");
        fs::create_dir_all(skills.join("aaa")).unwrap();
        fs::create_dir_all(skills.join("bbb")).unwrap();
        fs::write(skills.join("aaa").join("SKILL.md"), "SKILL-AAA").unwrap();
        fs::write(skills.join("bbb").join("SKILL.md"), "SKILL-BBB").unwrap();

        let s = compose_system(&dir);
        assert!(s.contains("# Skills"), "skills header: {s}");
        let (a, b) = (s.find("SKILL-AAA"), s.find("SKILL-BBB"));
        assert!(a.is_some() && b.is_some() && a < b, "sorted by slug: {s}");

        // No skills dir ⇒ no Skills section.
        let bare = std::env::temp_dir().join(format!("bsc-agent-noskills-{}", std::process::id()));
        fs::create_dir_all(&bare).unwrap();
        assert!(!compose_system(&bare).contains("# Skills"));

        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&bare);
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/agent.rs, src/mcp.rs, src/permissions.rs, src/telemetry.rs, src/tools.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-agent--<module>.rs
//     bsc graph impl set --id bsc-agent--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-agent--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));