//! `bsc-agent` — the model-agnostic agent runtime (epic #1078, P2). A lean CLI that
//! runs a tool-using agent loop against any provider in `bsc-llm`. Configured by env
//! (so the app can launch it like `bsc-plan`): `BSC_AGENT_PROVIDER` (default
//! `anthropic`), `BSC_AGENT_MODEL`, `BSC_AGENT_API_KEY`. The task comes from argv (or
//! stdin); the system prompt is the global `~/.claude/CLAUDE.md` user memory + the `CLAUDE.md`
//! chain (cwd + ancestors) + `CLAUDE.local.md`, matching Claude Code's context loading. Output goes to
//! stdout — it runs inside the PTY like `claude` does.

mod agent;
mod mcp;
mod permissions;
mod telemetry;
mod tools;

use agent::{run_agent, Tool};
use tools::{bsc_cli_tool, default_tools};
use llm::{LlmProvider, Msg};
use permissions::Permissions;
use std::io::Read;
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
    compose_system_inner(start, home_dir().as_deref())
}

/// The pure core of [`compose_system`], with the home dir injected so it's testable without touching
/// process env. `home` supplies the global `~/.claude/CLAUDE.md` user memory.
fn compose_system_inner(start: &Path, home: Option<&Path>) -> String {
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
    if let Ok(c) = std::fs::read_to_string(start.join("CLAUDE.local.md")) {
        if !c.trim().is_empty() {
            parts.push(c);
        }
    }
    let skills = compose_skills(start);
    if !skills.is_empty() {
        parts.push(format!("# Skills\n\n{skills}"));
    }
    parts.join("\n\n")
}

/// Concatenate the project's skills — every `<start>/.claude/skills/<slug>/SKILL.md`, sorted by
/// slug for determinism — so a bsc-agent session has the same skill context Claude Code discovers.
/// Returns "" when there's no skills dir. (#1078 P3 parity)
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

#[tokio::main]
async fn main() {
    let provider = std::env::var("BSC_AGENT_PROVIDER").unwrap_or_else(|_| "anthropic".into());
    let model = std::env::var("BSC_AGENT_MODEL").unwrap_or_default();
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
        "\x1b[2m▸ bsc-agent · provider={provider} · model={} · context={} chars\x1b[0m",
        if model.is_empty() { "<default>" } else { &model },
        system.len(),
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
    let base_url = std::env::var("BSC_AGENT_BASE_URL").ok().filter(|s| !s.trim().is_empty());
    let num_ctx_cap = std::env::var("BSC_AGENT_NUM_CTX").ok().and_then(|s| s.trim().parse::<u64>().ok());
    let ollama_profile = if matches!(kind, llm::ProviderKind::Ollama) {
        let base = base_url.as_deref().unwrap_or(llm::DEFAULT_LOCAL_BASE_URL);
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
    std::env::set_var("BSC_AGENT_CONTEXT_BUDGET", provider.context_budget_tokens().to_string());
    let result = run_with_provider(provider, &api_key, &model, &system, &task, mcp_tools, &perms, &tele, &prior, session_path).await;

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
    // The root session runs in a PTY, so it's INTERACTIVE: after the initial task settles it keeps
    // the session alive and reads further user turns from stdin (Claude-REPL parity), instead of the
    // process exiting after one response and ending the pane. (#1078 interactive mode)
    run_agent(&*provider, api_key, model, system, task, &tools, perms, tele, prior, session_path, 20, true).await
}

#[cfg(test)]
mod tests {
    use super::{available_clis, compose_system_inner, render_clis_block};
    use std::fs;

    /// Compose with NO global home memory, so a real `~/.claude/CLAUDE.md` on the dev machine can't
    /// leak into these structural assertions. The global layer has its own test below.
    fn compose_system(start: &std::path::Path) -> String {
        compose_system_inner(start, None)
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

        let s = compose_system_inner(&proj, Some(home.as_path()));
        let (gi, pi) = (s.find("GLOBAL-MEMORY"), s.find("PROJECT-SPEC"));
        assert!(gi.is_some() && pi.is_some(), "both global + project present: {s}");
        assert!(gi < pi, "global memory is least-specific (appears first): {s}");

        // With no home, the global layer is simply absent (best-effort) — not an error.
        let none = compose_system_inner(&proj, None);
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
            vec!["plan", "data", "skill", "logs", "compliance", "blueprint", "project", "files"],
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
        // $BSC_BIN staged AND both project stores (BSC_PLAN_DB + BSC_DATA_DB) present → no "needs a
        // project context" caveat on either project-scoped subcommand.
        let is_set = |k: &str| ["BSC_BIN", "BSC_PLAN_DB", "BSC_DATA_DB"].contains(&k);
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
