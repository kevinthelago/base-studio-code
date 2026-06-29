use crate::*;

// NOTE: the planner prompts (`data/planner/process.md`, `data/stages/permissions.json`) re-state
// this same baseline (MANDATORY_BASH + BASELINE_READONLY + BASELINE_BUILD) so the planner authors
// only stack-specific extras on top. These three consts are the SINGLE SOURCE OF TRUTH; the
// `baseline_drift_guard` tests below parse those data files and assert they match the consts, so the
// old "keep them in sync (#1817)" warning is now a CI-caught invariant (#1866, sibling of #1844's
// deny-floor drift guard). Change a const → the data files must follow or the build fails.
/// Shell commands every spawned repo/console session auto-approves regardless of
/// the user's allowlist — the app's GitHub workflow (triage, publish, repo ops)
/// depends on them. `gh` is required by triage; `git` by every repo session;
/// `bsc` is the unified state CLI (#1877) — `bsc plan` (the plan store, #plan-db) plus the
/// `skill`/`data`/`logs`/… subcommands the planner/director/workers drive — so it must never
/// prompt (the planner runs it under autopilot); a `Bash(bsc *)` allow covers every `bsc <sub>`.
pub(crate) const MANDATORY_BASH: &[&str] = &["gh", "git", "bsc"];
/// Safe read-only inspection / navigation commands auto-approved in every session whose
/// shell posture is not `deny`, so ordinary work (`ls`, `cat`, `grep`, …) never prompts.
/// Pure inspection + light scaffolding; the destructive forms are still caught by the shared
/// dangerous-bash floor (`bsc_util::dangerous`). Written as explicit `Bash(<cmd> *)` rules because Claude Code does NOT
/// honor a bare `Bash` allow as allow-all — every auto-runnable command must be enumerated.
pub(crate) const BASELINE_READONLY: &[&str] = &[
    "ls", "cat", "head", "tail", "grep", "rg", "find", "fd", "pwd", "cd", "echo", "wc",
    "sort", "uniq", "diff", "tree", "which", "env", "date", "file", "stat", "basename",
    "dirname", "cut", "sleep", "printf", "test", "sed", "awk", "jq", "tr", "mkdir", "touch",
];
/// Common build / test / run toolchains auto-approved for an `allow`-shell agent (a doer —
/// worker/tester). A coordinator (`ask` shell) does NOT get these (it prompts before
/// building); a `deny`-shell agent gets neither baseline. The planner grants project-specific
/// tools beyond this set per stream (the session's `allowed_commands`).
pub(crate) const BASELINE_BUILD: &[&str] = &[
    "cargo", "rustc", "rustup", "npm", "pnpm", "yarn", "npx", "node", "deno", "bun",
    "python", "python3", "pip", "pip3", "pytest", "make", "go", "tsc", "vite", "eslint",
    "prettier", "vitest", "jest", "docker", "mvn", "gradle", "dotnet", "ollama",
];
// Dangerous command patterns denied in every spawned session by default — the always-on floor, now
// the shared `bsc_util::dangerous` registry (#1844). The Claude harness renders the `Bash(<glob>)`
// deny rules (`claude_deny_rules`); the bsc-agent runtime renders the substring form from the SAME
// canonical list, so the two floors can't drift. The session allows Bash broadly so ordinary work
// (loops, `&&`/`|`) runs without a prompt; these guard the most catastrophic *direct* invocations
// (deny > allow in Claude Code; prefix matching can't catch a danger nested in a loop/pipe — an
// accident bar, not a sandbox). Users extend it via the per-session `denied_commands`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn ensure_session_settings(
    cwd: String,
    allowed_commands: Vec<String>,
    denied_commands: Vec<String>,
    mcp_servers: Option<Vec<McpServerCfg>>,
    hooks: Option<Vec<HookCfg>>,
    allow_tool_rules: Option<Vec<String>>,
    deny_tool_rules: Option<Vec<String>>,
    ask_tool_rules: Option<Vec<String>>,
    skills: Option<Vec<SkillCfg>>,
    replace_permissions: Option<bool>,
    bash_posture: Option<String>,
) -> Result<(), String> {
    write_session_settings(
        &cwd, &allowed_commands, &denied_commands,
        &mcp_servers.unwrap_or_default(), &hooks.unwrap_or_default(),
        &allow_tool_rules.unwrap_or_default(), &deny_tool_rules.unwrap_or_default(),
        &ask_tool_rules.unwrap_or_default(),
        &skills.unwrap_or_default(),
        replace_permissions.unwrap_or(false),
        bash_posture.as_deref().unwrap_or("allow"),
    )
}
/// Synchronous core of [`ensure_session_settings`] (testable without a runtime).
///
/// Security model: Claude Code does NOT honor a bare `Bash` allow as allow-all, so the set
/// of auto-runnable commands is enumerated as explicit `Bash(<cmd> *)` rules, scaled by the
/// session's `bash_posture` (the agent profile's bash tier): `allow` doers get the bare
/// `Bash` + the read-only AND build baselines; `ask` coordinators get the read-only baseline
/// only (build/unlisted commands prompt); `deny` agents get neither. Always added: the
/// mandatory gh/git/bsc and the per-stream `allowed_commands` the planner granted. A
/// curated default deny-list (`bsc_util::dangerous::claude_deny_rules`) plus any user/project `denied_commands`
/// block the most dangerous direct invocations (deny wins over allow). Merges into existing
/// settings rather than clobbering; `.claude/` stays out of the repo's `git status`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn write_session_settings(
    cwd: &str,
    allowed_commands: &[String],
    denied_commands: &[String],
    mcp_servers: &[McpServerCfg],
    hooks: &[HookCfg],
    allow_tool_rules: &[String],
    deny_tool_rules: &[String],
    ask_tool_rules: &[String],
    skills: &[SkillCfg],
    replace_permissions: bool,
    bash_posture: &str,
) -> Result<(), String> {
    if cwd.is_empty() { return Ok(()); }
    let root = std::path::PathBuf::from(cwd);
    let settings_path = root.join(".claude").join("settings.json");

    let mut config = crate::platform::fsx::read_json_object_or_default(&settings_path);

    // Allow. Claude Code does NOT honor a bare `Bash` as allow-all — every auto-approved
    // command must be an explicit `Bash(<cmd> *)` rule — so the session's shell posture
    // (`bash_posture`, from the agent profile's bash tier) decides how generous the set is:
    //   - "allow" (doers — worker/tester): the bare `Bash` (forward-compat / intent) + the
    //     read-only AND build baselines.
    //   - "ask"   (coordinators — director/reviewer): the read-only baseline only; build and
    //     unlisted commands fall through to a prompt.
    //   - "deny"  (sandboxed): neither baseline.
    // ALWAYS: mandatory gh/git/bsc + each per-stream granted command (`allowed_commands`).
    let mut allow_rules: Vec<String> = Vec::new();
    let mut baseline: Vec<&str> = Vec::new();
    match bash_posture {
        "deny" => {}
        "ask" => baseline.extend_from_slice(BASELINE_READONLY),
        _ /* "allow" */ => {
            allow_rules.push("Bash".to_string());
            baseline.extend_from_slice(BASELINE_READONLY);
            baseline.extend_from_slice(BASELINE_BUILD);
        }
    }
    for c in baseline.iter().map(|s| (*s).to_string())
        .chain(MANDATORY_BASH.iter().map(|s| (*s).to_string()))
        .chain(allowed_commands.iter().map(|c| c.trim().to_string()))
    {
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !allow_rules.contains(&r) { allow_rules.push(r); }
        }
    }

    // Deny: curated dangerous defaults + user/project denies (deny > allow).
    let mut deny_rules: Vec<String> = bsc_util::dangerous::claude_deny_rules().map(|s| s.to_string()).collect();
    for c in denied_commands {
        let c = c.trim();
        if !c.is_empty() {
            let r = format!("Bash({} *)", c);
            if !deny_rules.contains(&r) { deny_rules.push(r); }
        }
    }

    // Tool-permission rules (verbatim, NOT Bash-wrapped) — the role write-path guard
    // passes `Edit(<glob>)` / `Write` / … here to scope or deny the file-write tools.
    for r in allow_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !allow_rules.contains(&r) { allow_rules.push(r); }
    }
    for r in deny_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !deny_rules.contains(&r) { deny_rules.push(r); }
    }

    // Ask: rules that PROMPT the user before the command (Claude Code precedence
    // deny > ask > allow, so a specific ask overrides the broad Bash allow). The
    // flow's hard push-confirm gate (#297) passes `Bash(git push *)` / `Bash(gh pr
    // create *)` here so pushes/PRs require approval instead of auto-running.
    let mut ask_rules: Vec<String> = Vec::new();
    for r in ask_tool_rules {
        let r = r.trim().to_string();
        if !r.is_empty() && !ask_rules.contains(&r) { ask_rules.push(r); }
    }

    // Replace mode (#799): drop the existing allow/deny/ask lists first, so the freshly
    // computed role+profile set is AUTHORITATIVE. Without this, merge only UNIONS — a
    // permission the user removed from a profile would linger across relaunches. Used when
    // re-applying after a profile/permission edit.
    if replace_permissions {
        if let Some(perms) = config.get_mut("permissions").and_then(|p| p.as_object_mut()) {
            for k in ["allow", "deny", "ask"] { perms.remove(k); }
        }
    }
    merge_permission_list(&mut config, "allow", &allow_rules);
    merge_permission_list(&mut config, "deny", &deny_rules);
    merge_permission_list(&mut config, "ask", &ask_rules);

    // Hooks → settings.json `hooks` (overwritten with the resolved set, so toggling
    // a hook extension off and relaunching drops it). MCP servers → `.mcp.json`,
    // auto-approved for autonomous sessions via `enabledMcpjsonServers` (exactly the
    // resolved set — servers not listed aren't trusted, which is how removal lands).
    write_session_hooks(&mut config, hooks);
    {
        let obj = config.as_object_mut().unwrap();
        if mcp_servers.is_empty() {
            obj.remove("enabledMcpjsonServers");
        } else {
            obj.insert(
                "enabledMcpjsonServers".into(),
                serde_json::Value::Array(
                    mcp_servers.iter().map(|m| serde_json::Value::String(m.name.clone())).collect(),
                ),
            );
        }
    }

    std::fs::create_dir_all(root.join(".claude")).map_err(|e| e.to_string())?;
    crate::platform::fsx::atomic_write_json(&settings_path, &config).map_err(|e| e.to_string())?;
    write_mcp_json(&root, mcp_servers)?;
    write_session_skills(&root, skills)?;
    // Attach-time usage counting (#A): bump each attached skill's global usage counter so the
    // `bsc skill list --sort rank|uses` ordering + the Skills-page chart reflect real deployment,
    // uniformly across Claude + local-model sessions. Best-effort; never blocks the launch.
    crate::extensions::skills::record_skill_uses(skills);
    git_exclude(&root, ".claude/");
    git_exclude(&root, ".mcp.json");
    Ok(())
}
/// Merge `rules` into `config.permissions.<key>` (an array), preserving existing
/// entries and order, deduped. Creates the objects/array as needed.
pub(crate) fn merge_permission_list(config: &mut serde_json::Value, key: &str, rules: &[String]) {
    let obj = config.as_object_mut().unwrap();
    let permissions = obj.entry("permissions").or_insert_with(|| serde_json::json!({}));
    crate::platform::fsx::ensure_object(permissions);
    let perm_obj = permissions.as_object_mut().unwrap();
    let list = perm_obj.entry(key).or_insert_with(|| serde_json::json!([]));
    if !list.is_array() { *list = serde_json::json!([]); }
    let arr = list.as_array_mut().unwrap();
    let mut seen: std::collections::HashSet<String> =
        arr.iter().filter_map(|v| v.as_str().map(str::to_string)).collect();
    for r in rules {
        if seen.insert(r.clone()) { arr.push(serde_json::Value::String(r.clone())); }
    }
}

#[cfg(test)]
mod baseline_drift_guard {
    //! Drift guard (#1866) for the three baseline ALLOW lists.
    //!
    //! `MANDATORY_BASH` / `BASELINE_READONLY` / `BASELINE_BUILD` are the SINGLE canonical source.
    //! The planner data (`data/planner/process.md`, `data/stages/permissions.json`) re-states the
    //! same baseline so the planner authors only stack-specific extras on top — a manual "keep in
    //! sync (#1817)" that these tests turn into a CI-caught invariant (the ALLOW-baseline sibling of
    //! #1844's deny-floor guard). The data files are embedded at compile time, so this is a pure
    //! offline parse — no fixtures, no runtime. The session render path is untouched; these tests
    //! only pin that the planner-facing copies can't silently drift from the runtime consts.
    use super::{BASELINE_BUILD, BASELINE_READONLY, MANDATORY_BASH};

    const PROCESS_MD: &str = include_str!("../../data/planner/process.md");
    const PERMISSIONS_JSON: &str = include_str!("../../data/stages/permissions.json");

    /// The backtick-quoted tokens in `s`, in order: "`ls`, `cat`" → ["ls", "cat"].
    fn backtick_tokens(s: &str) -> Vec<String> {
        let mut out = Vec::new();
        let mut rest = s;
        while let Some(open) = rest.find('`') {
            let after = &rest[open + 1..];
            match after.find('`') {
                Some(close) => {
                    out.push(after[..close].to_string());
                    rest = &after[close + 1..];
                }
                None => break,
            }
        }
        out
    }

    /// The slice of `md` from `marker` to the end of that markdown bullet — i.e. up to the next
    /// `\n- ` list item or the next blank line, whichever comes first (continuation lines are
    /// indented, so they don't terminate the bullet).
    fn bullet_from(md: &str, marker: &str) -> String {
        let start = md
            .find(marker)
            .unwrap_or_else(|| panic!("process.md missing baseline bullet marker: {marker}"));
        let tail = &md[start..];
        let next_item = tail.get(1..).and_then(|t| t.find("\n- ")).map(|i| i + 1);
        let blank = tail.find("\n\n");
        let end = [next_item, blank].into_iter().flatten().min().unwrap_or(tail.len());
        tail[..end].to_string()
    }

    /// The text of `s` after `open` up to the first following `close`.
    fn between<'a>(s: &'a str, open: &str, close: &str) -> &'a str {
        let a = s
            .find(open)
            .unwrap_or_else(|| panic!("permissions.json missing marker: {open}"))
            + open.len();
        let rest = &s[a..];
        let b = rest
            .find(close)
            .unwrap_or_else(|| panic!("permissions.json missing close `{close}` after `{open}`"));
        &rest[..b]
    }

    fn owned(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| (*s).to_string()).collect()
    }

    /// `process.md` re-states the FULL baseline as three bullets (so the planner doesn't re-list it
    /// in a stream's `commands`). Each bullet must match its const EXACTLY — same commands, same
    /// order — so the planner's "do NOT re-list the baseline" instruction can never go stale.
    #[test]
    fn process_md_baseline_bullets_match_the_consts_exactly() {
        assert_eq!(
            backtick_tokens(&bullet_from(PROCESS_MD, "**Navigation / inspection / text**")),
            owned(BASELINE_READONLY),
            "process.md read-only baseline drifted from BASELINE_READONLY",
        );
        assert_eq!(
            backtick_tokens(&bullet_from(PROCESS_MD, "**Build / test toolchains**")),
            owned(BASELINE_BUILD),
            "process.md build baseline drifted from BASELINE_BUILD",
        );
        assert_eq!(
            backtick_tokens(&bullet_from(PROCESS_MD, "**Always** (every agent)")),
            owned(MANDATORY_BASH),
            "process.md always baseline drifted from MANDATORY_BASH",
        );
    }

    /// `permissions.json` lists illustrative SUBSETS of the read-only and build baselines (with a
    /// trailing `…`) inline in its directive prose. Every command it names must be a genuine member
    /// of the corresponding const — so an example can't outlive a const entry it was drawn from.
    /// The ALWAYS line is the full set, so it's asserted verbatim.
    #[test]
    fn permissions_json_baseline_examples_are_drawn_from_the_consts() {
        let readonly = backtick_tokens(between(
            PERMISSIONS_JSON,
            "read-only navigation/inspection/text tools (",
            ")",
        ));
        assert!(!readonly.is_empty(), "permissions.json lists no read-only baseline examples");
        for cmd in &readonly {
            assert!(
                BASELINE_READONLY.contains(&cmd.as_str()),
                "permissions.json read-only example `{cmd}` is not in BASELINE_READONLY",
            );
        }

        let build = backtick_tokens(between(PERMISSIONS_JSON, "build/test toolchains (", ")"));
        assert!(!build.is_empty(), "permissions.json lists no build baseline examples");
        for cmd in &build {
            assert!(
                BASELINE_BUILD.contains(&cmd.as_str()),
                "permissions.json build example `{cmd}` is not in BASELINE_BUILD",
            );
        }

        // ALWAYS is the full mandatory set, not an example subset — pin it verbatim.
        let always = format!("ALWAYS `{}`", MANDATORY_BASH.join("`/`"));
        assert!(
            PERMISSIONS_JSON.contains(&always),
            "permissions.json must state the full always-baseline as `{always}`",
        );
    }
}
