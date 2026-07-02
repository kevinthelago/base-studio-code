use crate::prelude::*;

// Base-level allowed commands are defined ONCE in the backend-owned `data/permissions/base.json`
// (#1880), embedded here at compile time — the SINGLE SOURCE OF TRUTH. The planner prompts
// (`data/planner/process.md`, `data/stages/streams.json` — the collapsed structure+permissions stage,
// #1914) re-state the same baseline so the
// planner authors only stack-specific extras on top, and the `baseline_drift_guard` tests below parse
// those data files and assert they match `base.json` (a CI-caught invariant, #1866 — the ALLOW-baseline
// sibling of #1844's deny-floor guard). Change `base.json` → the planner prose must follow or the build
// fails. Written as explicit `Bash(<cmd> *)` rules at launch because Claude Code does NOT honor a bare
// `Bash` allow as allow-all — every auto-runnable command must be enumerated.
//
// The three command tiers are scaled by a session's `bash_posture` (see `write_session_settings`):
//   - `mandatory` (gh/git/bsc) — ALWAYS allowed: the app's GitHub/plan workflow depends on them
//     (`gh` for triage/publish, `git` for every repo session, `bsc` (the unified CLI) for the autopilot plan store).
//   - `readonly`  — the safe inspection/navigation set (`ls`/`cat`/`grep`/…), added for the `ask` and
//     `allow` postures so ordinary work never prompts; destructive forms are still caught by the
//     shared dangerous-bash floor (`bsc_util::dangerous`).
//   - `build`     — the common build/test toolchains, added for the `allow` posture only (a doer —
//     worker/tester); an `ask` coordinator prompts before building, a `deny` agent gets neither tier.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BaseProfile {
    command_tiers: CommandTiers,
}
#[derive(serde::Deserialize)]
struct CommandTiers {
    mandatory: Vec<String>,
    readonly: Vec<String>,
    build: Vec<String>,
}
/// The parsed base profile (`permissions/base.json`) — the single definition of base-level allowed
/// commands. Loaded at runtime via [`crate::platform::config::load_str`] (#2027 P2): the user's copy
/// under the config dir if present, else the embedded seed. Parsed once; an invalid/renamed file is a
/// hard panic at first use (the seed is compiled in, so this can only fire on a developer-introduced
/// mistake or a user hand-editing the config file into invalid JSON).
fn base_profile() -> &'static BaseProfile {
    static BASE: std::sync::OnceLock<BaseProfile> = std::sync::OnceLock::new();
    BASE.get_or_init(|| {
        serde_json::from_str(&crate::platform::config::load_str("permissions/base.json"))
            .expect("permissions/base.json must be valid JSON matching BaseProfile")
    })
}
/// Commands guaranteed in every session regardless of posture (gh/git/bsc).
fn mandatory_bash() -> &'static [String] { &base_profile().command_tiers.mandatory }
/// The read-only inspection/navigation baseline (granted for the `ask` + `allow` postures).
fn baseline_readonly() -> &'static [String] { &base_profile().command_tiers.readonly }
/// The build/test toolchain baseline (granted for the `allow` posture only).
fn baseline_build() -> &'static [String] { &base_profile().command_tiers.build }
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
    bypass: Option<bool>,
) -> Result<(), String> {
    write_session_settings(
        &cwd, &allowed_commands, &denied_commands,
        &mcp_servers.unwrap_or_default(), &hooks.unwrap_or_default(),
        &allow_tool_rules.unwrap_or_default(), &deny_tool_rules.unwrap_or_default(),
        &ask_tool_rules.unwrap_or_default(),
        &skills.unwrap_or_default(),
        replace_permissions.unwrap_or(false),
        bash_posture.as_deref().unwrap_or("allow"),
        bypass.unwrap_or(false),
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
    bypass: bool,
) -> Result<(), String> {
    if cwd.is_empty() { return Ok(()); }
    // Normalize a git-bash drive path (`/c/Users/...`, the OSC-7 form the app persists and the frontend
    // passes here) back to native (`C:/Users/...`) so settings.json lands at the SAME directory
    // `pty_create` launches claude in — it calls `to_native_path` too (console/pty/mod.rs). Without this,
    // on Windows `PathBuf::from("/c/Users/...")` resolves to the bogus `C:\c\Users\...`: the real session
    // dir gets NO settings, so Claude Code treats it as untrusted and prompts on every command (the
    // triage `cargo test` permission prompts). No-op for already-native paths and off Windows.
    let root = std::path::PathBuf::from(crate::platform::shell::to_native_path(cwd));
    let settings_path = root.join(".claude").join("settings.json");

    let mut config = crate::platform::fsx::read_json_object_or_default(&settings_path);

    // Allow + deny rule assembly (posture-scaled): each list is built by a pure helper below,
    // then the verbatim tool-permission rules are folded in (they're shared between the two).
    let mut allow_rules = build_allow_rules(bash_posture, allowed_commands);
    let mut deny_rules = build_deny_rules(denied_commands);

    // Tool-permission rules (verbatim, NOT Bash-wrapped) — the role write-path guard
    // passes `Edit(<glob>)` / `Write` / … here to scope or deny the file-write tools.
    for r in allow_tool_rules { push_unique_trimmed(&mut allow_rules, r); }
    for r in deny_tool_rules { push_unique_trimmed(&mut deny_rules, r); }

    // Ask: rules that PROMPT the user before the command (Claude Code precedence
    // deny > ask > allow, so a specific ask overrides the broad Bash allow). The
    // flow's hard push-confirm gate (#297) passes `Bash(git push *)` / `Bash(gh pr
    // create *)` here so pushes/PRs require approval instead of auto-running.
    let mut ask_rules: Vec<String> = Vec::new();
    for r in ask_tool_rules { push_unique_trimmed(&mut ask_rules, r); }

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
    apply_permission_posture(&mut config, bypass, cwd);

    // Hooks → settings.json `hooks` (overwritten with the resolved set, so toggling
    // a hook extension off and relaunching drops it). MCP servers → `.mcp.json`,
    // auto-approved for autonomous sessions via `enabledMcpjsonServers` (exactly the
    // resolved set — servers not listed aren't trusted, which is how removal lands).
    write_session_hooks(&mut config, hooks);
    apply_enabled_mcp_servers(&mut config, mcp_servers);

    std::fs::create_dir_all(root.join(".claude")).str_err()?;
    crate::platform::fsx::atomic_write_json(&settings_path, &config).str_err()?;
    write_mcp_json(&root, mcp_servers)?;
    write_session_skills(&root, skills)?;
    // Attach-time usage counting (#A): bump each attached skill's global usage counter so the
    // `bsc-skill list --sort rank|uses` ordering + the Skills-page chart reflect real deployment,
    // uniformly across Claude + local-model sessions. Best-effort; never blocks the launch.
    crate::extensions::skills::record_skill_uses(skills);
    git_exclude(&root, ".claude/");
    git_exclude(&root, ".mcp.json");
    Ok(())
}
/// Assemble the posture-scaled ALLOW rules (before the verbatim tool rules are folded in).
///
/// Claude Code does NOT honor a bare `Bash` as allow-all — every auto-approved command must be an
/// explicit `Bash(<cmd> *)` rule — so the session's shell posture (`bash_posture`, from the agent
/// profile's bash tier) decides how generous the set is:
///   - "allow" (doers — worker/tester): the bare `Bash` (forward-compat / intent) + the
///     read-only AND build baselines.
///   - "ask"   (coordinators — director/reviewer): the read-only baseline only; build and
///     unlisted commands fall through to a prompt.
///   - "deny"  (sandboxed): neither baseline.
///
/// ALWAYS: mandatory gh/git/bsc + each per-stream granted command (`allowed_commands`).
fn build_allow_rules(bash_posture: &str, allowed_commands: &[String]) -> Vec<String> {
    let mut allow_rules: Vec<String> = Vec::new();
    let mut baseline: Vec<String> = Vec::new();
    match bash_posture {
        "deny" => {}
        "ask" => baseline.extend(baseline_readonly().iter().cloned()),
        _ /* "allow" */ => {
            allow_rules.push("Bash".to_string());
            baseline.extend(baseline_readonly().iter().cloned());
            baseline.extend(baseline_build().iter().cloned());
        }
    }
    // The app's own bsc-* coordination/checkpoint helpers (bsc-fleet, bsc-checkpoint, bsc-note,
    // bsc-wait, bsc-ask/answer, bsc-issue/assign, bsc-landed/merged/closed/failed, bsc-learned, …) are
    // shell FUNCTIONS installed in every session (bsc-env.sh) — NOT the `bsc` binary, so the mandatory
    // `Bash(bsc *)` rule never matches them (`bsc-fleet` has no space after `bsc`). Auto-approve the
    // whole family in EVERY posture: they're app-provided + safe (the dangerous floor + the bsc-deny
    // hook still gate the args), and they're how a session checkpoints + coordinates — the director runs
    // `bsc-fleet` (BARE) to see every worker's stream/repo/branch/role + STATE. A no-space glob so it
    // covers the bare form (`bsc-fleet`) AND arg forms (`bsc-checkpoint "…"`).
    allow_rules.push("Bash(bsc-*)".to_string());
    for c in baseline.into_iter()
        .chain(mandatory_bash().iter().cloned())
        .chain(allowed_commands.iter().map(|c| c.trim().to_string()))
    {
        if !c.is_empty() { push_unique_trimmed(&mut allow_rules, &bash_rule(&c)); }
    }
    allow_rules
}

/// Assemble the DENY rules (before the verbatim tool rules are folded in): the curated dangerous
/// defaults + the user/project `denied_commands` (deny > allow).
fn build_deny_rules(denied_commands: &[String]) -> Vec<String> {
    let mut deny_rules: Vec<String> = bsc_util::dangerous::claude_deny_rules().map(|s| s.to_string()).collect();
    for c in denied_commands {
        let c = c.trim();
        if !c.is_empty() { push_unique_trimmed(&mut deny_rules, &bash_rule(c)); }
    }
    deny_rules
}

/// Apply the permission posture (#1916): the user chooses between the DENY-LIST (bypass — sessions
/// auto-run, the PreToolUse hooks do the gating) and the ALLOW-LIST (Claude's `default` mode — the
/// enumerated allow/deny lists require approval). Default is the ALLOW-LIST (#2050 — the broad
/// base.json tiers keep it low-friction; bypass is the opt-in power posture in Settings → Security).
/// Either way the hooks (dangerous floor + role/user denies via bsc-deny, FS confinement + .claude via
/// bsc-confine, code:none/write-scope via bsc-scope) still fire+block — they survive bypass, where
/// `permissions.deny` is ignored — and `ask` (push-confirm) still prompts natively. The allow-list
/// machinery (base.json tiers, posture scaling) STAYS: it's the engine for allow-list mode. Applies to
/// EVERY pane (workers, director, triage, manual).
fn apply_permission_posture(config: &mut serde_json::Value, bypass: bool, cwd: &str) {
    if bypass {
        {
            let obj = config.as_object_mut().unwrap();
            let permissions = obj.entry("permissions").or_insert_with(|| serde_json::json!({}));
            crate::platform::fsx::ensure_object(permissions);
            permissions.as_object_mut().unwrap().insert(
                "defaultMode".into(),
                serde_json::Value::String("bypassPermissions".into()),
            );
        }
        config.as_object_mut().unwrap().insert("sandbox".into(), build_sandbox_block(cwd));
    } else {
        if let Some(perms) = config.get_mut("permissions").and_then(|p| p.as_object_mut()) {
            // Allow-list posture: drop any stale bypass left by a prior bypass launch so the toggle takes.
            perms.remove("defaultMode");
        }
        // Allow-list posture: prompts are the gate, so the OS sandbox isn't required — drop a stale block.
        config.as_object_mut().unwrap().remove("sandbox");
    }
}

/// Gate the resolved MCP servers via `enabledMcpjsonServers` — set to EXACTLY the resolved set
/// (servers not listed aren't trusted, which is how removal lands); an empty set drops the key.
fn apply_enabled_mcp_servers(config: &mut serde_json::Value, mcp_servers: &[McpServerCfg]) {
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

/// Wrap a bare command in the `Bash(<cmd> *)` prefix-match rule Claude Code auto-approves.
/// The command is trimmed; callers guard against an empty command before wrapping (an empty
/// command would otherwise yield the meaningless `Bash( *)`).
fn bash_rule(cmd: &str) -> String {
    format!("Bash({} *)", cmd.trim())
}

/// Append `rule` (trimmed) to `vec` unless it is empty or already present — the trim + dedup
/// step shared by all five allow/deny/ask rule-assembly sites. Order is preserved (first
/// occurrence wins), so deny > ask > allow precedence is untouched (each list is assembled
/// independently and merged separately).
fn push_unique_trimmed(vec: &mut Vec<String>, rule: &str) {
    let rule = rule.trim();
    if !rule.is_empty() && !vec.iter().any(|r| r == rule) {
        vec.push(rule.to_string());
    }
}

/// The bypass OS-sandbox block (#1916, Layer 4): under bypass, OS-confine the Bash subprocess
/// tree — the one tool a PreToolUse hook can't fully contain (macOS Seatbelt / Linux + WSL2
/// bubblewrap). On NATIVE Windows it warns + falls back to unsandboxed (`failIfUnavailable:
/// false`) — a safe no-op until a session runs in WSL2. The sandbox's default write boundary is
/// cwd + $TMPDIR; this WIDENS it or it breaks real work: the bsc state dir (`~/.base-studio-code`
/// — coord/audit logs, plan.db) and the cwd's MAIN git repo (a linked worktree's git data lives
/// in `<main>/.git/worktrees/<id>`, outside the cwd). Reads stay open (builds need system libs);
/// credential + read confinement is a follow-on.
fn build_sandbox_block(cwd: &str) -> serde_json::Value {
    let mut allow_write = vec![serde_json::Value::String(
        crate::platform::paths::bsc_base_dir().to_string_lossy().into_owned(),
    )];
    if let Some(main) = crate::session::claude_config::git_main_worktree(cwd) {
        allow_write.push(serde_json::Value::String(main));
    }
    serde_json::json!({
        "enabled": true,
        "failIfUnavailable": false,
        "filesystem": { "allowWrite": allow_write },
    })
}

#[cfg(test)]
mod baseline_drift_guard {
    //! Drift guard (#1866 / #1880) for the three baseline ALLOW tiers.
    //!
    //! `data/permissions/base.json` is the SINGLE canonical source. The planner data
    //! (`data/planner/process.md`, `data/stages/streams.json` — the collapsed structure+permissions
    //! stage, #1914) re-states the same baseline so the planner authors only stack-specific extras on
    //! top — a manual "keep in sync (#1817)" that these tests turn into a CI-caught invariant (the
    //! ALLOW-baseline sibling of #1844's deny-floor guard). All three data files are read EMBEDDED
    //! (`include_str!`), so this is a pure offline parse — no fixtures, no runtime. NB: the guard parses
    //! the embedded `base.json` DIRECTLY (not the runtime `base_profile()` accessor, which since #2027 P2
    //! reads the user config dir), so it always validates the SHIPPED artifacts. The session render path
    //! is untouched; these tests only pin that the planner-facing copies can't silently drift from
    //! `base.json`.
    use super::BaseProfile;

    const BASE_JSON: &str = include_str!("../../data/permissions/base.json");
    const PROCESS_MD: &str = include_str!("../../data/planner/process.md");
    const PERMISSIONS_JSON: &str = include_str!("../../data/stages/streams.json");

    /// Parse the EMBEDDED base.json (the shipped artifact), keeping the drift guard independent of any
    /// runtime config override.
    fn embedded_base() -> BaseProfile {
        serde_json::from_str(BASE_JSON).expect("embedded base.json parses into BaseProfile")
    }
    fn mandatory_bash() -> Vec<String> { embedded_base().command_tiers.mandatory }
    fn baseline_readonly() -> Vec<String> { embedded_base().command_tiers.readonly }
    fn baseline_build() -> Vec<String> { embedded_base().command_tiers.build }

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
        let blank = tail.find("\n\n").or_else(|| tail.find("\n\r\n")); // LF or CRLF blank line
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

    /// `base.json` itself must parse and carry non-empty tiers, with the mandatory set EXACTLY
    /// gh/git/bsc — a typo, an emptied tier, or a dropped mandatory command (any of which would
    /// silently widen or break every session's baseline) fails here, at the source.
    #[test]
    fn base_json_parses_with_populated_tiers_and_exact_mandatory() {
        assert_eq!(mandatory_bash().join("/"), "gh/git/bsc");
        assert!(!baseline_readonly().is_empty(), "base.json readonly tier is empty");
        assert!(!baseline_build().is_empty(), "base.json build tier is empty");
        // Spot-check a representative member of each scaled tier.
        assert!(baseline_readonly().iter().any(|c| c == "grep"));
        assert!(baseline_build().iter().any(|c| c == "cargo"));
    }

    /// `process.md` re-states the FULL baseline as three bullets (so the planner doesn't re-list it
    /// in a stream's `commands`). Each bullet must match its `base.json` tier EXACTLY — same commands,
    /// same order — so the planner's "do NOT re-list the baseline" instruction can never go stale.
    #[test]
    fn process_md_baseline_bullets_match_base_json_exactly() {
        assert_eq!(
            backtick_tokens(&bullet_from(PROCESS_MD, "**Navigation / inspection / text**")),
            baseline_readonly().to_vec(),
            "process.md read-only baseline drifted from base.json (readonly tier)",
        );
        assert_eq!(
            backtick_tokens(&bullet_from(PROCESS_MD, "**Build / test toolchains**")),
            baseline_build().to_vec(),
            "process.md build baseline drifted from base.json (build tier)",
        );
        assert_eq!(
            backtick_tokens(&bullet_from(PROCESS_MD, "**Always** (every agent)")),
            mandatory_bash().to_vec(),
            "process.md always baseline drifted from base.json (mandatory tier)",
        );
    }

    /// `permissions.json` lists illustrative SUBSETS of the read-only and build baselines (with a
    /// trailing `…`) inline in its directive prose. Every command it names must be a genuine member
    /// of the corresponding `base.json` tier — so an example can't outlive a base entry it was drawn
    /// from. The ALWAYS line is the full set, so it's asserted verbatim.
    #[test]
    fn permissions_json_baseline_examples_are_drawn_from_base_json() {
        let readonly = backtick_tokens(between(
            PERMISSIONS_JSON,
            "read-only navigation/inspection/text tools (",
            ")",
        ));
        assert!(!readonly.is_empty(), "permissions.json lists no read-only baseline examples");
        for cmd in &readonly {
            assert!(
                baseline_readonly().iter().any(|c| c == cmd),
                "permissions.json read-only example `{cmd}` is not in base.json (readonly tier)",
            );
        }

        let build = backtick_tokens(between(PERMISSIONS_JSON, "build/test toolchains (", ")"));
        assert!(!build.is_empty(), "permissions.json lists no build baseline examples");
        for cmd in &build {
            assert!(
                baseline_build().iter().any(|c| c == cmd),
                "permissions.json build example `{cmd}` is not in base.json (build tier)",
            );
        }

        // ALWAYS is the full mandatory set, not an example subset — pin it verbatim.
        let always = format!("ALWAYS `{}`", mandatory_bash().join("`/`"));
        assert!(
            PERMISSIONS_JSON.contains(&always),
            "permissions.json must state the full always-baseline as `{always}`",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_session_settings_merges_mandatory_and_custom_commands() {
        use crate::session::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-{}", std::process::id()));
        let settings = dir.join(".claude").join("settings.json");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        // Seed an existing setting that must be preserved (not clobbered).
        std::fs::write(
            &settings,
            r#"{"model":"claude-sonnet-4-6","permissions":{"allow":["Read"],"deny":["WebSearch"]}}"#,
        ).unwrap();

        write_session_settings(
            &dir.to_string_lossy(),
            &["cargo".into(), "git".into()],
            &["scp".into()],
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            false,
            "allow",
            true,
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        // THE FLIP (#1916 Step 4): every session is emitted in bypassPermissions — the PreToolUse
        // hooks (not the allow/deny lists) do the gating.
        assert_eq!(v["permissions"]["defaultMode"], "bypassPermissions");
        // Layer 4 OS sandbox (#1916): bypass also emits a sandbox block (enabled, fail-open) whose
        // write boundary is widened to the bsc state dir so coordination/plan.db writes aren't blocked.
        assert_eq!(v["sandbox"]["enabled"], true);
        assert_eq!(v["sandbox"]["failIfUnavailable"], false);
        let writes: Vec<String> = v["sandbox"]["filesystem"]["allowWrite"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(writes.iter().any(|w| w.contains(".base-studio-code")), "sandbox must allowWrite the bsc state dir, got {writes:?}");
        // Allow-list posture (#1916): bypass=false omits defaultMode (and clears a stale one), so Claude's
        // `default` mode enforces the enumerated allow/deny lists — the require-approval option we keep.
        write_session_settings(&dir.to_string_lossy(), &[], &[], &[], &[], &[], &[], &[], &[], false, "allow", false).unwrap();
        let v2: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(v2["permissions"]["defaultMode"].is_null(), "allow-list posture must omit defaultMode");
        assert!(v2["sandbox"].is_null(), "allow-list posture must omit the OS sandbox");
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Pre-existing entries are preserved (merged, not clobbered).
        assert!(allow.contains(&"Read".to_string()));
        assert!(deny.contains(&"WebSearch".to_string()));
        assert_eq!(v["model"], "claude-sonnet-4-6");
        // Bash is allowed broadly (start-and-go) plus explicit gh/git/custom rules.
        assert!(allow.contains(&"Bash".to_string()));
        assert!(allow.contains(&"Bash(gh *)".to_string()));
        assert!(allow.contains(&"Bash(git *)".to_string()));
        assert!(allow.contains(&"Bash(bsc *)".to_string())); // the unified bsc state CLI (#1877)
        assert!(allow.contains(&"Bash(cargo *)".to_string()));
        assert_eq!(allow.iter().filter(|r| *r == "Bash(git *)").count(), 1);
        // Curated dangerous defaults plus the user deny are present.
        assert!(deny.contains(&"Bash(sudo *)".to_string()));
        assert!(deny.contains(&"Bash(rm -rf /*)".to_string()));
        assert!(deny.contains(&"Bash(scp *)".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// #1572: bash_posture scales the auto-approve set — `allow` doers get the read-only AND
    /// build baselines + the bare `Bash`; `ask` coordinators get read-only only (build/unlisted
    /// prompt); `deny` gets neither baseline. The mandatory + per-stream granted commands are
    /// always present.
    #[test]
    fn write_session_settings_bash_posture_scales_the_baseline() {
        use crate::session::settings::write_session_settings;
        let base = std::env::temp_dir().join(format!("bsc-ess-posture-{}", std::process::id()));
        let read_allow = |dir: &std::path::Path| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
            v["permissions"]["allow"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
        };
        for (posture, want_ro, want_build, want_bare) in [
            ("allow", true, true, true),
            ("ask",   true, false, false),
            ("deny",  false, false, false),
        ] {
            let dir = base.join(posture);
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(dir.join(".claude")).unwrap();
            // Grant a project-specific command in every posture — it must ALWAYS be present.
            write_session_settings(&dir.to_string_lossy(), &["terraform".into()], &[],
                &[], &[], &[], &[], &[], &[], false, posture, true).unwrap();
            let allow = read_allow(&dir);
            assert_eq!(allow.contains(&"Bash(ls *)".to_string()), want_ro, "{posture}: read-only baseline");
            assert_eq!(allow.contains(&"Bash(cargo *)".to_string()), want_build, "{posture}: build baseline");
            assert_eq!(allow.contains(&"Bash".to_string()), want_bare, "{posture}: bare Bash");
            assert!(allow.contains(&"Bash(terraform *)".to_string()), "{posture}: granted command always present");
            assert!(allow.contains(&"Bash(git *)".to_string()), "{posture}: mandatory git always present");
            // The bsc-* coordination helpers (bsc-fleet/checkpoint/note/…) are auto-approved in EVERY
            // posture — they're shell functions the `Bash(bsc *)` mandatory rule can't match.
            assert!(allow.contains(&"Bash(bsc-*)".to_string()), "{posture}: bsc-* helpers always present");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Regression (triage `cargo test` permission prompts): write_session_settings must normalize a
    /// git-bash drive cwd (`/c/Users/...`, the OSC-7 form the frontend persists + passes) to native
    /// before resolving the path — so settings.json lands where `pty_create` launches claude (it
    /// normalizes too), NOT at the bogus `C:\c\Users\...`. Without it the real session dir has no
    /// settings, so Claude Code treats the workspace as untrusted and prompts on every command.
    #[test]
    #[cfg(windows)]
    fn write_session_settings_normalizes_a_git_bash_drive_cwd() {
        use crate::session::settings::write_session_settings;
        let native = std::env::temp_dir().join(format!("bsc-ess-gitbash-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&native);
        std::fs::create_dir_all(&native).unwrap();
        // The git-bash spelling of the native temp dir: `C:\…\x` → `/c/…/x`.
        let fwd = native.to_string_lossy().replace('\\', "/"); // C:/Users/…/x
        let git_bash = format!("/{}{}", fwd[..1].to_lowercase(), &fwd[2..]); // /c/Users/…/x
        write_session_settings(&git_bash, &[], &[], &[], &[], &[], &[], &[], &[], false, "allow", true).unwrap();
        // Lands at the NATIVE dir...
        assert!(native.join(".claude").join("settings.json").exists(),
            "settings.json must be written to the native dir, not a bogus C:\\c\\… path");
        // ...and NOT at the bogus literal `/c/…` path (`C:\c\…` on Windows).
        assert!(!std::path::PathBuf::from(&git_bash).join(".claude").join("settings.json").exists(),
            "must not write to the bogus literal `/c/…` path");
        let _ = std::fs::remove_dir_all(&native);
    }

    #[test]
    fn write_session_settings_writes_ask_tier_for_hard_push_gate() {
        use crate::session::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-ask-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // A hard push-confirm flow (#297) asks before push/PR: the rules land in
        // permissions.ask (deny > ask > allow), so they prompt under the broad Bash allow.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &[],
            &[],
            &["Bash(git push *)".into(), "Bash(gh pr create *)".into()],
            &[],
            false,
            "allow",
            true,
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let ask: Vec<String> = v["permissions"]["ask"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(ask.contains(&"Bash(git push *)".to_string()));
        assert!(ask.contains(&"Bash(gh pr create *)".to_string()));
        // Bash stays broadly allowed; ask only narrows the two push writes.
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(allow.contains(&"Bash".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_merges_verbatim_tool_rules() {
        use crate::session::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-tool-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The role write-path guard: deny every write tool (planner/director/triage),
        // and auto-approve a worker's boundary glob.
        write_session_settings(
            &dir.to_string_lossy(),
            &[],
            &[],
            &[],
            &[],
            &["Edit(src/auth/**)".into(), "Write(src/auth/**)".into()],
            &["Edit".into(), "Write".into(), "MultiEdit".into(), "NotebookEdit".into()],
            &[],
            &[],
            false,
            "allow",
            true,
        ).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Tool rules land verbatim — NOT wrapped in Bash(...).
        assert!(allow.contains(&"Edit(src/auth/**)".to_string()));
        assert!(allow.contains(&"Write(src/auth/**)".to_string()));
        assert!(!allow.iter().any(|r| r.contains("Bash(Edit")));
        assert!(deny.contains(&"Edit".to_string()));
        assert!(deny.contains(&"Write".to_string()));
        assert!(deny.contains(&"MultiEdit".to_string()));
        assert!(deny.contains(&"NotebookEdit".to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_replace_drops_removed_permissions() {
        use crate::session::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-replace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        let cwd = dir.to_string_lossy();
        let read = || -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
            v["permissions"]["allow"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect()
        };

        // First pass grants a custom command (merge mode). Use a command NOT in the baselines
        // (`terraform`) so the drop is observable — a baseline command would be re-added anyway.
        write_session_settings(&cwd, &["terraform".into()], &[], &[], &[], &[], &[], &[], &[], false, "allow", true).unwrap();
        assert!(read().contains(&"Bash(terraform *)".to_string()));

        // Re-apply with the command REMOVED — replace mode must drop it (merge would keep it).
        write_session_settings(&cwd, &[], &[], &[], &[], &[], &[], &[], &[], true, "allow", true).unwrap();
        let allow = read();
        assert!(!allow.contains(&"Bash(terraform *)".to_string()), "replace must drop the removed command (#799)");
        assert!(allow.contains(&"Bash".to_string()), "but the broad Bash allow is recomputed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_session_settings_writes_mcp_servers_and_hooks() {
        let dir = std::env::temp_dir().join(format!("bsc-ext-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let mcp = vec![
            McpServerCfg {
                name: "filesystem".into(), transport: "stdio".into(),
                command: Some("npx".into()), args: vec!["-y".into(), "@mcp/fs".into()],
                url: None, env: vec![("ROOT".into(), "/tmp".into())],
            },
            McpServerCfg {
                name: "sentry".into(), transport: "http".into(),
                command: None, args: vec![], url: Some("https://mcp.sentry.dev/sse".into()), env: vec![],
            },
        ];
        let hooks = vec![HookCfg {
            event: "PostToolUse".into(), matcher: "Write|Edit".into(), command: "format.sh".into(),
        }];
        write_session_settings(&dir.to_string_lossy(), &[], &[], &mcp, &hooks, &[], &[], &[], &[], false, "allow", true).unwrap();

        // .mcp.json carries both servers in the right transport shapes.
        let mcp_json: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".mcp.json")).unwrap()).unwrap();
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["command"], "npx");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["args"][1], "@mcp/fs");
        assert_eq!(mcp_json["mcpServers"]["filesystem"]["env"]["ROOT"], "/tmp");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["type"], "http");
        assert_eq!(mcp_json["mcpServers"]["sentry"]["url"], "https://mcp.sentry.dev/sse");

        // settings.json gates the servers + carries the hook grouped by event.
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let enabled: Vec<String> = settings["enabledMcpjsonServers"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(enabled.contains(&"filesystem".to_string()) && enabled.contains(&"sentry".to_string()));
        assert_eq!(settings["hooks"]["PostToolUse"][0]["matcher"], "Write|Edit");
        assert_eq!(settings["hooks"]["PostToolUse"][0]["hooks"][0]["command"], "format.sh");

        let _ = std::fs::remove_dir_all(&dir);
    }

}
