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
/// The inputs to [`write_session_settings`], grouped so its callers (the Tauri adapter plus the
/// settings tests) read by field name instead of by position. Borrows every list field — the
/// caller owns the backing storage. Built from the [`ensure_session_settings`] command's owned
/// `Option<…>` inputs, or by a test (see [`SessionSettingsSpec::for_dir`]).
pub(crate) struct SessionSettingsSpec<'a> {
    /// The session's launch cwd (git-bash `/c/…` or native form; normalized inside).
    pub cwd: &'a str,
    /// Per-stream commands the planner granted; always allowed on top of the posture baselines.
    pub allowed_commands: &'a [String],
    /// User/project commands to deny, folded into the dangerous-command floor.
    pub denied_commands: &'a [String],
    pub mcp_servers: &'a [McpServerCfg],
    pub hooks: &'a [HookCfg],
    /// Verbatim (non-`Bash`-wrapped) allow tool-rules — e.g. the role write-path `Edit(<glob>)` scope.
    pub allow_tool_rules: &'a [String],
    pub deny_tool_rules: &'a [String],
    /// Verbatim ask tool-rules that PROMPT before running (e.g. the flow's push-confirm gate).
    pub ask_tool_rules: &'a [String],
    pub skills: &'a [SkillCfg],
    /// Replace (vs merge) the existing allow/deny/ask lists so the computed set is authoritative (#799).
    pub replace_permissions: bool,
    /// Shell posture tier (`allow`/`ask`/`deny`) scaling the command baselines.
    pub bash_posture: &'a str,
    /// `bypassPermissions` mode (hooks-only gating) vs the allow-list `default` mode.
    pub bypass: bool,
    /// Restricted allow-list (#2471): when true, the ALLOW rules are EXACTLY the passed
    /// `allowed_commands` (each as `Bash(<cmd> *)`) — no bare `Bash`, no mandatory gh/git/bsc tier,
    /// no readonly/build baselines, no `Bash(bsc-*)` helpers. Deny-wins means a broad `bsc` deny
    /// could never re-allow `bsc ui`, so a tightly-scoped session (the Design Studio's designer)
    /// instead SUPPRESSES the baselines and enumerates its whole surface. Denies (the dangerous
    /// floor + user/role denies) and the verbatim tool rules still apply on top; the always-on
    /// PreToolUse hook floor is separate machinery and unaffected.
    pub restricted_allow: bool,
}

#[cfg(test)]
impl<'a> SessionSettingsSpec<'a> {
    /// A spec for `cwd` with every list empty, the `allow` posture, and `bypass` on — the common
    /// test shape. Tests override the fields they exercise via struct-update syntax
    /// (`SessionSettingsSpec { allowed_commands: &[…], ..SessionSettingsSpec::for_dir(&cwd) }`).
    pub(crate) fn for_dir(cwd: &'a str) -> Self {
        SessionSettingsSpec {
            cwd,
            allowed_commands: &[],
            denied_commands: &[],
            mcp_servers: &[],
            hooks: &[],
            allow_tool_rules: &[],
            deny_tool_rules: &[],
            ask_tool_rules: &[],
            skills: &[],
            replace_permissions: false,
            bash_posture: "allow",
            bypass: true,
            restricted_allow: false,
        }
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // wire contract: the frontend passes these as named invoke args.
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
    // JS `restrictedAllow` — Tauri renames invoke ARGS camelCase → snake_case (#2471).
    restricted_allow: Option<bool>,
    // THE ROLE ITSELF, so Rust can derive the gate instead of only recording it
    // (`epic-frontend-logic-over-backend-resources-belongs-in-rust`). Optional because a role-less
    // ad-hoc console has nothing to derive, and because an older frontend must keep working.
    role_capability: Option<crate::session::role_gate::RoleCapability>,
    // The `bsc` surface CATALOG, raw. It used to arrive already filtered as `activeSurfaces`, which
    // was the frontend answering a question Rust has the ported rule for
    // (`denies::deniable_surface_names`) — the same shape as the flow's push policy below. The
    // filter is not cosmetic: a DEPRECATED alias serves the same store as its live surface, so
    // leaving it out of the complement keeps a side door open into a store the declaration closed.
    surface_catalog: Option<Vec<crate::session::denies::SurfaceRow>>,
    // THE PROFILE ITSELF, so Rust can derive the bridge it currently only obeys
    // (`the-launch-derives-the-profile-settings-instead-of-receiving-them`). Optional for the same
    // two reasons as `role_capability`: a pane with no profile assigned has nothing to derive, and an
    // older frontend must keep working.
    agent_profile: Option<crate::session::profile_settings::AgentProfile>,
    // The pane's FLOW push policy (`auto-pr` / `push-confirm` / `local` / …), and the user's OWN
    // global denylist — the two inputs the deny composition cannot derive
    // (`the-launch-composes-its-own-denies-instead-of-receiving-them`).
    //
    // The POLICY replaced an earlier `flowGrantedCommands` list: `denies::flow_granted_push_commands`
    // is the ported rule, so receiving its output was receiving a computed answer, and the
    // absent-flow default belongs in ONE place. It used to be `auto-pr`, which meant a fleet on
    // untouched defaults pushed branches regardless of intent — a second copy is where that returns.
    flow_push: Option<String>,
    // The user's list is the one source that is not derived from anything, which is why it must
    // arrive: the composition would otherwise silently drop it.
    user_denied_commands: Option<Vec<String>>,
    // The pane ID, the flow's GATE, and the user's global bypass toggle — the last three inputs the
    // permission block needs and could not derive
    // (`the-launch-composes-its-own-tool-rules-instead-of-receiving-them`). The pane id is what
    // `is_full_capability_session` reads: the debug studio is always bypass, by definition.
    pane_id: Option<String>,
    flow_gate: Option<String>,
    global_bypass: Option<bool>,
    // The persona's OWN hooks, resolved, so the launch can compose the rest of the chain around them
    // (`the-launch-composes-its-own-hook-chain-instead-of-receiving-it`). A fact: persona resolution
    // is the renderer's, the same way the surface catalog and the studio registry are.
    persona_hooks: Option<Vec<HookCfg>>,
    // Whether `hooks` above is the SANDBOXED substitution rather than the ordinary chain. The
    // caller owns that swap (the sandbox cluster has its own items), so the launch must be told
    // rather than compose over it and silently undo it.
    namespace_hooks: Option<bool>,
) -> Result<(), String> {
    // Bind the unwrapped Options to locals so the borrowed spec can reference them.
    let mcp_servers = mcp_servers.unwrap_or_default();
    let hooks = hooks.unwrap_or_default();
    let allow_tool_rules = allow_tool_rules.unwrap_or_default();
    let deny_tool_rules = deny_tool_rules.unwrap_or_default();
    let ask_tool_rules = ask_tool_rules.unwrap_or_default();
    let skills = skills.unwrap_or_default();
    let bash_posture = bash_posture.unwrap_or_else(|| "allow".to_string());
    // DERIVE THE ROLE DENIES HERE, rather than trusting the ones the renderer computed.
    //
    // Rust already ENFORCED this gate (`deny_matches`) and WROTE it; it just never computed it, so a
    // security boundary was decided in a process that has been seen to die under memory pressure. The
    // reconciliation UNIONS rather than replaces — see `reconcile_role_denies` — so the cutover can
    // only strengthen the gate, never weaken it while both copies exist.
    // An EMPTY catalog denies nothing extra BY DESIGN — the poll may not have resolved, or may have
    // failed, and "unavailable" is indistinguishable from "no surfaces exist" here. Complementing
    // against an empty list is the safe direction: the alternative bricks every session the moment
    // that read fails.
    let surfaces = crate::session::denies::deniable_surface_names(
        &surface_catalog.unwrap_or_default(),
    );
    let recon = crate::session::denies::reconcile_session_denies(
        denied_commands,
        &user_denied_commands.unwrap_or_default(),
        role_capability.as_ref(),
        &surfaces,
        flow_push.as_deref(),
        // A profile deliberately supplies no command denies — the role gate claims that field and the
        // two must not both claim it. Threaded through rather than dropped so the composition still
        // reads as the three sources it is.
        &[],
    );
    if !recon.missing.is_empty() {
        // The ONE direction that is a defect: Rust derived a deny the frontend omitted. Extra on the
        // frontend side is expected (the user's own denies ride in the same list) and says nothing.
        log::warn!(
            "session settings[{cwd}]: the frontend's deny list was MISSING {} pattern(s) the launch \
             composed — added: {:?}. Under the BYPASS posture the bsc-deny hook reading these is the \
             ONLY enforcement, so a missing one is a command that runs on a session that auto-runs \
             everything — not a difference of opinion.",
            recon.missing.len(),
            recon.missing,
        );
    }
    let denied_commands = recon.merged;
    // THE WHOLE PERMISSION BLOCK, COMPOSED HERE. This supersedes the two narrower reconciliations
    // that stood here — the role's tool rules and the profile's bridge — because
    // `session_tool_rules` composes the same fields from the same inputs plus the flow and the pane,
    // and three overlapping reconciliations of one block is one more than the block can explain.
    //
    // The LISTS union, frontend order first. The SCALARS do not, and each is decided on what its two
    // failure directions cost rather than by one rule — see `reconcile_session_tool_rules`. `bypass`
    // is the sharp one: it decides whether `permissions.deny` is honoured AT ALL, so a permissive
    // error there stops every deny in this block applying at once.
    let derived_tools = crate::session::tool_rules::session_tool_rules(
        role_capability.as_ref(),
        agent_profile
            .as_ref()
            .map(crate::session::profile_settings::resolve_profile_settings)
            .as_ref(),
        flow_push.as_deref(),
        flow_gate.as_deref(),
        pane_id.as_deref().unwrap_or_default(),
        global_bypass.unwrap_or(false),
    );
    let tools = crate::session::tool_rules::reconcile_session_tool_rules(
        crate::session::tool_rules::SessionToolRules {
            allowed_commands,
            allow_tool_rules,
            deny_tool_rules,
            ask_tool_rules,
            bash_posture,
            restricted_allow: restricted_allow.unwrap_or(false),
            bypass: bypass.unwrap_or(false),
        },
        derived_tools,
        role_capability.is_some(),
    );
    if !tools.missing.is_empty() {
        let detail = tools
            .missing
            .iter()
            .map(|(field, values)| format!("{field}={values:?}"))
            .collect::<Vec<_>>()
            .join(" ");
        log::warn!(
            "session settings[{cwd}]: the permission block was MISSING values the launch composed —              {detail}. Added. The frontend legitimately carries more (the user's own lists ride              along), so only this direction is a defect."
        );
    }
    if let Some(d) = &tools.bypass {
        log::warn!(
            "session settings[{cwd}]: bypass disagreed — the frontend sent {}, the launch composed              {}; the RESTRICTIVE `false` wins. bypass decides whether permissions.deny is honoured at              all, so prompting less than intended is a hole while prompting more is a complaint.",
            d.from_frontend,
            d.derived,
        );
    }
    if let Some(d) = &tools.posture {
        log::warn!(
            "session settings[{cwd}]: bash_posture disagreed — the frontend sent `{}`, the launch              composed `{}`; the NARROWER `{}` wins.",
            d.from_frontend,
            d.derived,
            d.chosen,
        );
    }
    if let Some(d) = &tools.restricted_allow {
        log::warn!(
            "session settings[{cwd}]: restricted_allow disagreed — the frontend sent {}, the launch              composed {}; {} wins. It is a pure function of the role's own command surface, so with a              capability in hand the composition is simply right.",
            d.from_frontend,
            d.derived,
            d.chosen,
        );
    }
    let crate::session::tool_rules::SessionToolRules {
        allowed_commands,
        allow_tool_rules,
        deny_tool_rules,
        ask_tool_rules,
        bash_posture,
        restricted_allow,
        bypass,
    } = tools.merged;
    // THE HOOK CHAIN, COMPOSED HERE. Rust supplies every one of these gates — `bsc-deny` reads the
    // env this function just derived, `bsc-scope` and `bsc-confine` are its binaries — and could not
    // decide which of them run. The failure mode is SILENCE: an unregistered hook does not error, it
    // simply never fires, which is how the turn-accounting pair went missing twice.
    //
    // Skipped entirely under the namespace substitution: that swap belongs to the sandbox cluster and
    // composing over it would silently undo it.
    let hooks = if namespace_hooks.unwrap_or(false) {
        hooks
    } else {
        let to_hook = |h: &HookCfg| crate::session::hook_chain::SessionHook {
            event: h.event.clone(),
            matcher: h.matcher.clone(),
            command: h.command.clone(),
        };
        let chain = crate::session::hook_chain::reconcile_hook_chain(
            hooks.iter().map(to_hook).collect(),
            &persona_hooks.unwrap_or_default().iter().map(to_hook).collect::<Vec<_>>(),
            // GATED is capability OR profile, not "has a role". A pane carrying only a profile is
            // gated, and collapsing this to the capability alone would silently un-gate it.
            role_capability.is_some() || agent_profile.is_some(),
            role_capability.as_ref().is_some_and(|c| c.role == "worker"),
            !skills.is_empty(),
        );
        if !chain.missing_from_derivation.is_empty() {
            log::warn!(
                "session settings[{cwd}]: the composed hook chain was MISSING {:?}, which the frontend \
                 registered — appended. A hook that is not installed fires nothing and reports nothing \
                 on its own, so this is a gate that stopped running, not a difference of opinion.",
                chain.missing_from_derivation,
            );
        }
        chain
            .merged
            .into_iter()
            .map(|h| HookCfg { event: h.event, matcher: h.matcher, command: h.command })
            .collect()
    };
    write_session_settings(&SessionSettingsSpec {
        cwd: &cwd,
        allowed_commands: &allowed_commands,
        denied_commands: &denied_commands,
        mcp_servers: &mcp_servers,
        hooks: &hooks,
        allow_tool_rules: &allow_tool_rules,
        deny_tool_rules: &deny_tool_rules,
        ask_tool_rules: &ask_tool_rules,
        skills: &skills,
        replace_permissions: replace_permissions.unwrap_or(false),
        bash_posture: &bash_posture,
        // Both come from the reconciled block above, already resolved — the `unwrap_or` that stood
        // here belonged to the raw arguments, which are now inputs to the composition rather than
        // the answer.
        bypass,
        restricted_allow,
    })
}
/// Synchronous core of [`ensure_session_settings`] (testable without a runtime), taking a
/// [`SessionSettingsSpec`].
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
pub(crate) fn write_session_settings(spec: &SessionSettingsSpec) -> Result<(), String> {
    // Destructure into the field names the body already uses (every field is Copy).
    let SessionSettingsSpec {
        cwd,
        allowed_commands,
        denied_commands,
        mcp_servers,
        hooks,
        allow_tool_rules,
        deny_tool_rules,
        ask_tool_rules,
        skills,
        replace_permissions,
        bash_posture,
        bypass,
        restricted_allow,
    } = *spec;
    if cwd.is_empty() { return Ok(()); }
    // Paths are POSIX throughout (phase-1-linux-host-remove-windows-tax). This used to translate a
    // git-bash drive path back to a native one so settings.json landed in the SAME directory that
    // `pty_create` launches into. On Windows the untranslated form resolved to a bogus path, the real
    // session dir got no settings, and Claude Code treated it as untrusted and prompted on every
    // command. With one path grammar there is nothing left to reconcile.
    let root = std::path::PathBuf::from(cwd);
    let settings_path = root.join(".claude").join("settings.json");

    let mut config = crate::platform::fsx::read_json_object_or_default(&settings_path);

    // Allow + deny rule assembly (posture-scaled): each list is built by a pure helper below,
    // then the verbatim tool-permission rules are folded in (they're shared between the two).
    let mut allow_rules = build_allow_rules(bash_posture, allowed_commands, restricted_allow);
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

    // ORDER IS LOAD-BEARING: the `.mcp.json` is written FIRST, then the trust record is computed from
    // the merged file. The other way round reads the PREVIOUS launch's file, so a server added on this
    // launch would be on disk and unlisted — the same modal, one launch later.
    std::fs::create_dir_all(root.join(".claude")).str_err()?;
    write_mcp_json(&root, mcp_servers)?;
    apply_enabled_mcp_servers(&mut config, &enabled_mcp_names(&root, mcp_servers));
    crate::platform::fsx::atomic_write_json(&settings_path, &config).str_err()?;
    write_session_skills(&root, skills)?;
    // Attach-time usage counting (#A): bump each attached skill's global usage counter so the
    // `bsc-skill list --sort rank|uses` ordering + the Skills-page chart reflect real deployment,
    // uniformly across Claude + local-model sessions. Best-effort; never blocks the launch.
    crate::extensions::skills::record_skill_uses(skills);
    git_exclude(&root, ".claude/");
    git_exclude(&root, ".mcp.json");
    Ok(())
}
/// Does this settings blob install a hook that only resolves INSIDE a mount namespace?
///
/// The namespace hook list points every PreToolUse gate at [`bsc_sandbox::HOOK_GUEST_PATH`], a
/// read-only bind that exists nowhere else. Read off the written config rather than inferred from a
/// launch flag, because the config is what Claude Code actually obeys and it is DURABLE — it outlives
/// the launch that wrote it, which is the whole failure mode below.
pub(crate) fn uses_guest_hooks(config: &serde_json::Value) -> bool {
    config
        .get("hooks")
        .map(|h| h.to_string().contains(bsc_sandbox::HOOK_GUEST_PATH))
        .unwrap_or(false)
}

/// A session whose PreToolUse floor cannot run. `None` when the hooks and the cage agree.
///
/// **Why this needs checking at all, when one decision is supposed to drive both.** `sandboxPlanFor`
/// derives the hook list and the cage from a single backend, and `sessionLaunch`'s own comment says
/// they must not disagree. That holds WITHIN one launch. It does not hold ACROSS launches, and
/// `settings.json` is durable on disk:
///
///   - a session spawned uncaged and re-mounted later, while a namespace has since become available,
///     has its settings rewritten with the guest path — but the running process keeps the cage it was
///     spawned with, which is none;
///   - a launch that asked for a cage and was REFUSED (see `sandbox_refusal`) already prints a pane
///     notice, but the settings it runs under still name the guest path, so its gates are dead too;
///   - `ensure_session_settings` is skipped entirely for a non-Claude pane and for a Claude pane with
///     an empty cwd, so a stale namespace-shaped file can simply persist.
///
/// OBSERVED as `Failed with non-blocking status code: /bin/sh: 1: /bsc-hook: not found` in a live
/// director. NON-BLOCKING is the sharp edge: the tool call proceeds, so the session runs with no
/// write-scope gate and no dangerous-command floor — the exact guarantee the hooks exist to make.
///
/// And it was INVISIBLE. That string appeared only as transient text in a session transcript; no app
/// log recorded it. A gate that is not running looks, from every durable surface, identical to a gate
/// that is running and permitting. That is what this function is for.
///
/// Pure over `(config, caged)` so both directions are testable without a launch.
pub(crate) fn hook_floor_mismatch(config: &serde_json::Value, caged: bool) -> Option<String> {
    match (uses_guest_hooks(config), caged) {
        (true, false) => Some(format!(
            "this session's PreToolUse hooks point at {} — a path that exists only inside a mount \
             namespace — but it is NOT running in one. Every gate will fail to execute, and it fails \
             NON-BLOCKING, so the session runs with no write-scope gate and no dangerous-command floor.",
            bsc_sandbox::HOOK_GUEST_PATH,
        )),
        // The inverse is a real loss too, and quieter: inside a namespace there is no `bsc` binary and
        // no `BASH_ENV`, so a shell-based gate cannot run either. It is not reported here because a
        // caged session legitimately reaches this state during the launch that is about to write the
        // guest list; flagging it would fire on every correct launch.
        _ => None,
    }
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
///
/// EXCEPT under `restricted_allow` (#2471): the rules are EXACTLY the wrapped `allowed_commands`
/// — no bare `Bash`, no posture baselines, no mandatory tier, no `Bash(bsc-*)` — so a
/// tightly-scoped session's entire auto-runnable surface is what its launcher enumerated.
///
/// A restricted command is granted in BOTH invocation forms (#3359): `Bash(<cmd>)` for the bare
/// call and `Bash(<cmd> *)` for the call with arguments. The trailing ` *` enforces a WORD
/// BOUNDARY, so `Bash(bsc ui *)` matches `bsc ui schema` but NOT a bare `bsc ui` — and the bare
/// call is exactly what an agent reaches for first to discover a command's subcommands. Emitting
/// only the arg form left the designer prompting on the one command it exists to run. This is
/// scoped to the restricted branch on purpose: `bash_rule` is shared with `build_deny_rules`, so
/// widening it there would change deny semantics. The surface itself does NOT grow — the same
/// enumerated commands, now matchable however they are invoked.
fn build_allow_rules(bash_posture: &str, allowed_commands: &[String], restricted_allow: bool) -> Vec<String> {
    let mut allow_rules: Vec<String> = Vec::new();
    if restricted_allow {
        for c in allowed_commands {
            let c = c.trim();
            if !c.is_empty() {
                push_unique_trimmed(&mut allow_rules, &bare_bash_rule(c));
                push_unique_trimmed(&mut allow_rules, &bash_rule(c));
            }
        }
        return allow_rules;
    }
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

/// The names to list in `enabledMcpjsonServers` for a session at `root`.
///
/// # Why this reads the FILE and not just the resolved list
///
/// Claude Code's approval modal is driven by the `.mcp.json` ON DISK, so the trust record has to
/// describe that file. The two halves of the write used to disagree about what an EMPTY resolved list
/// means: [`write_mcp_json`] returns early and LEAVES the existing file alone, while this function
/// removed the key. A second launch with nothing resolved therefore deleted the trust record and left
/// the servers in place — and Claude, finding servers it had no answer for, blocked on
///
/// ```text
/// 2 new MCP servers found in this project
///   [x] Compliance   [x] Research      Space to select · Esc to reject all
/// ```
///
/// BEFORE submitting the session's baked startup prompt. The session came up, parked on a modal
/// nobody was watching, and its kickoff never ran. Measured on every per-technology studio
/// (`design-studio/react`, `algorithms-studio/typescript`, `teams-studio`): `.mcp.json` present, key
/// missing. Removing the key does not make a server untrusted — it makes it ASK.
///
/// # Why only the app's OWN servers
///
/// `write_mcp_json` deliberately PRESERVES repo-authored entries, so a user project's `.mcp.json` can
/// name a third-party server the app knows nothing about. Auto-enabling everything in the file would
/// silently trust that. So the union is restricted to servers the app itself put there — the ones
/// whose command is the bundled `bsc` binary. A third-party entry stays unlisted and still prompts,
/// which is the property worth keeping.
fn enabled_mcp_names(root: &std::path::Path, mcp_servers: &[McpServerCfg]) -> Vec<String> {
    enabled_mcp_names_from(
        &mcp_json_docs_from(root),
        mcp_servers,
        crate::console::pty::bsc_bin_path().as_deref(),
    )
}

/// Every `.mcp.json` a session at `root` is subject to — its OWN, then each ancestor's, nearest first.
///
/// # Why ancestors
///
/// Claude discovers `.mcp.json` by walking UP from the cwd, and the trust record has to cover what it
/// will actually find. The first version of this fix read only `root/.mcp.json` and so computed
/// NOTHING for a session whose directory has no file of its own — which is precisely the case that
/// was broken. Measured: `algorithms-studio/python` has no `.mcp.json`, its parent
/// `algorithms-studio/.mcp.json` holds exactly `[Compliance, Research]`, and those are the two names
/// Claude's approval modal listed in that cwd. The per-technology studios split off their parent and
/// four of them (`algorithms-studio/{python,rust}`, `sound-studio`, `integration-studio`) inherit
/// rather than own.
///
/// # Why the walk is unbounded
///
/// It stops at the filesystem root and reads nothing else, because the DEPTH is not what makes this
/// safe — [`app_managed_mcp_server`] is. Only a server whose command is the bundled `bsc` binary is
/// ever trusted, so a stranger's `.mcp.json` twelve levels up contributes nothing no matter how far
/// the walk goes. Bounding it by directory instead would be a second, weaker rule that has to be kept
/// in step with the first.
fn mcp_json_docs_from(root: &std::path::Path) -> Vec<serde_json::Value> {
    let mut docs = Vec::new();
    let mut dir = Some(root);
    while let Some(d) = dir {
        let p = d.join(".mcp.json");
        if p.is_file() {
            docs.push(crate::platform::fsx::read_json_object_or_default(&p));
        }
        dir = d.parent();
    }
    docs
}

/// The pure half — the decision, with the two things it reads from the world injected.
///
/// `app_bin` is the bundled `bsc` path; `None` means no sidecar is staged, so nothing on disk can be
/// app-managed. Split out because the effectful version can only be exercised where a sidecar happens
/// to exist, and a test that quietly does nothing when it does not is exactly the green-gate-that-
/// sees-less this repo keeps getting caught by — the first draft of that test skipped silently and it
/// took an explicit `eprintln!` to notice.
fn enabled_mcp_names_from(
    docs: &[serde_json::Value],
    mcp_servers: &[McpServerCfg],
    app_bin: Option<&std::path::Path>,
) -> Vec<String> {
    let mut names: Vec<String> = mcp_servers.iter().map(|m| m.name.clone()).collect();
    // NEAREST FILE WINS, which is why this is a first-seen union rather than a merge: a name defined
    // in both the session's own file and an ancestor's is ONE server as far as Claude is concerned, and
    // listing it twice would be a second answer to the same question.
    for doc in docs {
        let Some(on_disk) = doc.get("mcpServers").and_then(|v| v.as_object()) else { continue };
        for (name, cfg) in on_disk {
            if names.iter().any(|n| n == name) {
                continue;
            }
            if app_managed_mcp_server(cfg, app_bin) {
                names.push(name.clone());
            }
        }
    }
    names
}

/// Whether a `.mcp.json` entry is one the APP wrote — its command is the bundled `bsc` binary.
///
/// `mcp_server_value` rewrites every built-in marker to that absolute path at write time, so this is
/// the same fact the writer already established, read back off the file rather than restated.
fn app_managed_mcp_server(cfg: &serde_json::Value, app_bin: Option<&std::path::Path>) -> bool {
    let (Some(cmd), Some(bin)) = (cfg.get("command").and_then(|v| v.as_str()), app_bin) else {
        return false;
    };
    std::path::Path::new(cmd) == bin
}

/// Gate the MCP servers via `enabledMcpjsonServers` — see [`enabled_mcp_names`] for what goes in it.
/// An empty set drops the key, which is correct only when the file names nothing either.
fn apply_enabled_mcp_servers(config: &mut serde_json::Value, names: &[String]) {
    let obj = config.as_object_mut().unwrap();
    if names.is_empty() {
        obj.remove("enabledMcpjsonServers");
    } else {
        obj.insert(
            "enabledMcpjsonServers".into(),
            serde_json::Value::Array(names.iter().cloned().map(serde_json::Value::String).collect()),
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

/// Wrap a bare command in the EXACT-match rule `Bash(<cmd>)` — the no-argument invocation, which
/// [`bash_rule`]'s trailing ` *` deliberately excludes (it enforces a word boundary requiring at
/// least one argument). Paired with `bash_rule` under `restricted_allow` (#3359) so a granted
/// command auto-runs however it is invoked. Same empty-command guard contract as `bash_rule`.
fn bare_bash_rule(cmd: &str) -> String {
    format!("Bash({})", cmd.trim())
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

    /// The exact settings shape the live director was running under, read off disk.
    fn namespace_hooks() -> serde_json::Value {
        serde_json::json!({ "hooks": { "PreToolUse": [
            { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
              "hooks": [{ "type": "command", "command": "/bsc-hook scope" }] },
            { "matcher": "Bash",
              "hooks": [{ "type": "command", "command": "/bsc-hook bash-deny" }] },
        ]}})
    }

    /// THE REPORTED FAILURE. A live director logged
    /// `Failed with non-blocking status code: /bin/sh: 1: /bsc-hook: not found` on every PreToolUse.
    ///
    /// `/bsc-hook` is a bwrap bind and resolves nowhere else — verified absent on the host — while
    /// THREE project hubs carried settings naming it. Non-blocking is the sharp edge: the tool call
    /// proceeds, so the session ran with no write-scope gate and no dangerous-command floor.
    #[test]
    fn hooks_that_only_resolve_in_a_cage_are_reported_when_there_is_no_cage() {
        let msg = hook_floor_mismatch(&namespace_hooks(), false)
            .expect("an uncaged session with guest hooks has no floor and must say so");
        // The message has to name the path AND the consequence — "hook failed" alone reads like a
        // transient blip, which is precisely how this went unnoticed.
        assert!(msg.contains("/bsc-hook"), "names the unreachable path: {msg}");
        assert!(msg.contains("NON-BLOCKING"), "says the call PROCEEDS: {msg}");
    }

    #[test]
    fn a_caged_session_with_guest_hooks_is_correct_and_silent() {
        // The normal namespace launch. Reporting here would fire on every correct launch and train
        // the reader to ignore the message that matters.
        assert_eq!(hook_floor_mismatch(&namespace_hooks(), true), None);
    }

    #[test]
    fn an_uncaged_session_with_shell_hooks_is_correct_and_silent() {
        // The host path: `bsc-scope` / `bsc-deny` run through BASH_ENV and resolve fine uncaged.
        let shell_hooks = serde_json::json!({ "hooks": { "PreToolUse": [
            { "matcher": "Bash", "hooks": [{ "type": "command", "command": "bsc-deny" }] },
        ]}});
        assert_eq!(hook_floor_mismatch(&shell_hooks, false), None);
        assert!(!uses_guest_hooks(&shell_hooks));
        // A session with no hooks at all is not this bug — it has no floor to lose.
        assert_eq!(hook_floor_mismatch(&serde_json::json!({}), false), None);
    }

    #[test]
    fn the_guest_path_is_the_one_the_sandbox_actually_binds() {
        // Two sides hard-code this path — the cage that binds it and the settings that invoke it —
        // and a mismatch is a gate that silently never fires, which is the failure class above.
        assert!(uses_guest_hooks(&namespace_hooks()));
        assert_eq!(bsc_sandbox::HOOK_GUEST_PATH, "/bsc-hook");
    }

    /// The TOOL-rule half, driven through the real command.
    ///
    /// Denies UNION and are added; allows PASS THROUGH and are only reported against. This test
    /// asserted the opposite — that an allow the derivation does not back "must NOT be granted" — and
    /// that assertion encoded a live defect: the frontend's allow list carries the profile's grants
    /// and the restricted-role surface as well as the role's own, so "not backed by the role" never
    /// meant "should not be there". It was discarding a designer's `Read` and every profile path.
    ///
    /// The premise also overstated what an allow rule can do. `settings.json` is not the containment
    /// boundary: `bsc-confine` is an always-on PreToolUse floor that refuses an out-of-root path and
    /// fires under BOTH permission postures, so an `Edit(/etc/**)` rule does not let a session write
    /// `/etc`. Rust can only intersect against a set it fully derives; once it derives the PROFILE
    /// too (`the-launch-derives-the-profile-settings-instead-of-receiving-them`) a meaningful
    /// intersect against role ∪ profile becomes possible.
    #[test]
    fn the_launch_derives_the_tool_rules_and_tightens_both_ways() {
        let _g = crate::testutil::ENV_LOCK.lock();
        let home = crate::testutil::temp_home("role-gate-tools");
        let cwd = home.join("repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let cap = crate::session::role_gate::RoleCapability {
            role: "worker".into(),
            github: crate::session::role_gate::Tier::Read,
            git: crate::session::role_gate::Tier::Write,
            code: crate::session::role_gate::Tier::Write,
            net: crate::session::role_gate::Tier::None, // ⇒ WebFetch/WebSearch denied
            ui: crate::session::role_gate::Tier::Read,
            write_globs: vec!["src/**".into()],
            allow: vec![],
            surfaces: None,
            harvest_roots: Vec::new(),
        };
        super::ensure_session_settings(
            cwd.to_string_lossy().to_string(),
            vec![],
            vec![],
            None,
            None,
            // An allow the derivation backs, and one it does not.
            Some(vec!["Edit(src/**)".to_string(), "Edit(/etc/**)".to_string()]),
            Some(vec![]),
            // ask_tool_rules · skills · replace_permissions · bash_posture · bypass · restricted_allow
            None, None, None, None, None, None,
            Some(cap),
            Some(vec![]),
            // agent_profile — this test is about the ROLE half; no profile to derive.
            None,
            // flow_push · user_denied_commands — no flow (so the role's denies stand unlifted) and
            // no user denylist.
            None,
            None,
            // pane_id · flow_gate · global_bypass — no pane identity, no gate, toggle off.
            None,
            None,
            None,
            // persona_hooks · namespace_hooks — no persona, ordinary (non-caged) chain.
            None,
            None,
        )
        .expect("settings written");

        let w = std::fs::read_to_string(cwd.join(".claude/settings.json")).expect("settings.json");
        assert!(w.contains("Edit(src/**)"), "the backed allow survives:\n{w}");
        // PASS-THROUGH: what the frontend sent is what is written. Dropping this was the regression.
        assert!(
            w.contains("Edit(/etc/**)"),
            "an allow the ROLE does not derive still passes through — the list is not role-only, and \
             out-of-root containment is `bsc-confine`, not this file:\n{w}"
        );
        for derived in ["Task", "WebFetch", "WebSearch"] {
            assert!(w.contains(derived), "`{derived}` must be derived even though the frontend omitted it:\n{w}");
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The launch path DERIVES the gate now, it does not just record what the renderer sent.
    ///
    /// THE CALL SITE for the hook chain, on both ends the item names. `session::hook_chain`'s own
    /// tests stay green if `ensure_session_settings` never calls it — they compose directly. This
    /// drives the real command and reads the `settings.json` it wrote, which is the file the gates are
    /// actually installed from.
    ///
    /// The failure this guards is SILENCE. An unregistered hook does not error; it never fires and the
    /// thing it was gating proceeds. Nothing downstream would report a shorter chain.
    #[test]
    fn the_launch_composes_the_hook_chain_and_never_a_shorter_one() {
        let _g = crate::testutil::ENV_LOCK.lock();
        let home = crate::testutil::temp_home("hook-chain-launch");

        let commands_at = |dir: &std::path::Path| -> Vec<String> {
            let v: serde_json::Value = serde_json::from_str(
                &std::fs::read_to_string(dir.join(".claude/settings.json")).expect("settings.json"),
            )
            .unwrap();
            // Every `hooks.<event>[].hooks[].command`, flattened — the shape Claude Code reads.
            let mut out = Vec::new();
            if let Some(events) = v["hooks"].as_object() {
                for (_, entries) in events {
                    for e in entries.as_array().into_iter().flatten() {
                        for h in e["hooks"].as_array().into_iter().flatten() {
                            if let Some(c) = h["command"].as_str() {
                                out.push(c.to_string());
                            }
                        }
                    }
                }
            }
            out
        };

        // END ONE: an UNGATED ad-hoc pane. No role, no profile — and it still gets the floor.
        let bare = home.join("bare");
        std::fs::create_dir_all(&bare).unwrap();
        super::ensure_session_settings(
            bare.to_string_lossy().to_string(),
            vec![], vec![],
            None, None, None, None, None, None, None, None, None, None,
            None, None, None, None, None, None, None, None, None, None,
        )
        .expect("settings written");
        let bare_cmds = commands_at(&bare);
        for floor in ["bsc-confine", "bsc-deny", "bsc-tokens"] {
            assert!(
                bare_cmds.iter().any(|c| c.contains(floor)),
                "the floor is unconditional — an ungated pane still gets {floor}: {bare_cmds:?}"
            );
        }
        // …and the GATED-only hooks are absent, so this is a floor rather than the whole chain.
        assert!(!bare_cmds.iter().any(|c| c.contains("bsc-audit")), "{bare_cmds:?}");

        // END TWO: a WORKER. Gated, so it adds the audit set, and `bsc-superseded` on top.
        let worker_dir = home.join("worker");
        std::fs::create_dir_all(&worker_dir).unwrap();
        let cap = crate::session::role_gate::RoleCapability {
            role: "worker".into(),
            github: crate::session::role_gate::Tier::Read,
            git: crate::session::role_gate::Tier::Write,
            code: crate::session::role_gate::Tier::Write,
            net: crate::session::role_gate::Tier::Read,
            ui: crate::session::role_gate::Tier::Read,
            write_globs: vec!["src/**".into()],
            allow: vec![],
            surfaces: None,
            harvest_roots: Vec::new(),
        };
        super::ensure_session_settings(
            worker_dir.to_string_lossy().to_string(),
            vec![], vec![],
            // The renderer sends NO hooks at all — the #3455 shape, where a launch path passed an
            // empty list and every gate silently vanished. The composition must not reproduce it.
            None, Some(vec![]), None, None, None, None, None, None, None, None,
            Some(cap),
            Some(vec![]),
            None, None, None, None, None, None, None, None,
        )
        .expect("settings written");
        let worker_cmds = commands_at(&worker_dir);
        for expected in ["bsc-audit", "bsc-scope", "bsc-superseded", "bsc-confine", "bsc-deny"] {
            assert!(
                worker_cmds.iter().any(|c| c.contains(expected)),
                "a worker's chain must carry {expected} even though the frontend sent none: \
                 {worker_cmds:?}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// THE REGRESSION SWITCHING THE WIRE ON WOULD HAVE CAUSED, driven through the real command.
    ///
    /// A worker is `github: read`, so the role gate denies `gh pr create`. An `auto-pr` flow is what
    /// lets it open its own PR, and #304 makes the FLOW the authority over `git push` / `gh pr create`
    /// specifically — the renderer already subtracts them from the role denies before sending.
    ///
    /// Union the UNFILTERED derived set instead and both come straight back, so every auto-pr worker
    /// stops being able to push. That is the union's "it can only tighten" property turning into a
    /// regression: tightening past a deliberate grant is not safety, and nothing downstream reports it
    /// — the worker simply fails at push time, one step from where the cause is.
    #[test]
    fn the_flows_push_grant_survives_the_role_reconciliation() {
        let _g = crate::testutil::ENV_LOCK.lock();
        let home = crate::testutil::temp_home("flow-grant-launch");
        let cwd = home.join("repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let cap = crate::session::role_gate::RoleCapability {
            role: "worker".into(),
            github: crate::session::role_gate::Tier::Read,
            git: crate::session::role_gate::Tier::Write,
            code: crate::session::role_gate::Tier::Write,
            net: crate::session::role_gate::Tier::Read,
            ui: crate::session::role_gate::Tier::Read,
            write_globs: vec!["src/**".into()],
            allow: vec![],
            surfaces: None,
            harvest_roots: Vec::new(),
        };
        // Exactly what the renderer sends for an auto-pr worker: the role denies MINUS the two the
        // flow grants back.
        let sent: Vec<String> = crate::session::role_gate::role_denied_commands(&cap, &[])
            .into_iter()
            .filter(|d| d != "gh pr create" && d != "git push")
            .collect();
        assert!(
            !sent.contains(&"gh pr create".to_string()),
            "the fixture is wrong if the frontend list still carries it"
        );

        super::ensure_session_settings(
            cwd.to_string_lossy().to_string(),
            vec![],
            sent,
            None, None, None, None, None, None, None, None, None, None,
            Some(cap),
            Some(vec![]),
            None,
            // The flow POLICY now, not the derived list — see `denies::flow_granted_push_commands`.
            Some("auto-pr".to_string()),
            // user_denied_commands · pane_id · flow_gate · global_bypass · persona_hooks ·
            // namespace_hooks — this test is about the flow's push GRANT and nothing else.
            None, None, None, None, None, None,
        )
        .expect("settings written");

        let written: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(cwd.join(".claude/settings.json")).expect("settings.json"),
        )
        .unwrap();
        let deny: Vec<String> = written["permissions"]["deny"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect();

        // EXACT RULES, not substrings. The dangerous floor legitimately denies `Bash(git push --force*)`
        // and `Bash(git push -f *)` on every session, and those have nothing to do with the role gate —
        // a `contains("git push")` test reads them as the regression and fails on correct behaviour.
        // (It did, on the first run of this test.)
        for granted in ["Bash(git push *)", "Bash(gh pr create *)"] {
            assert!(
                !deny.iter().any(|d| d == granted),
                "the flow GRANTED `{granted}` and the reconciliation put it back — an auto-pr worker \
                 cannot open its PR: {deny:?}"
            );
        }
        // The floor is untouched by any of this, and saying so keeps the assertion above honest about
        // what it is and is not claiming.
        assert!(
            deny.iter().any(|d| d == "Bash(git push --force*)"),
            "the dangerous-command floor is not what the flow lifts: {deny:?}"
        );
        // …and everything the role denies that the flow did NOT grant is still denied, so this is a
        // carve-out rather than the gate being switched off.
        assert!(
            deny.iter().any(|d| d == "Bash(gh pr merge *)"),
            "only the two granted commands are lifted; the rest of the role gate stands: {deny:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A frontend that omitted a role deny — because it crashed mid-compute, because it is an older
    /// build, or because someone called the command directly — must not produce a session that is
    /// more permissive than the role allows. Written through the real command so the wiring is
    /// pinned, not just `reconcile_role_denies` in isolation.
    #[test]
    fn the_launch_derives_role_denies_the_frontend_omitted() {
        let _g = crate::testutil::ENV_LOCK.lock();
        let home = crate::testutil::temp_home("role-gate-launch");
        let cwd = home.join("repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let cap = crate::session::role_gate::RoleCapability {
            role: "worker".into(),
            github: crate::session::role_gate::Tier::Read,
            git: crate::session::role_gate::Tier::Write,
            code: crate::session::role_gate::Tier::Write,
            net: crate::session::role_gate::Tier::Read,
            ui: crate::session::role_gate::Tier::Read,
            write_globs: vec!["src/**".into()],
            allow: vec![],
            surfaces: None,
            harvest_roots: Vec::new(),
        };
        // The frontend sends NOTHING but its own user deny — every role deny omitted.
        super::ensure_session_settings(
            cwd.to_string_lossy().to_string(),
            vec![],
            vec!["curl".to_string()],
            None, None, None, None, None, None, None, None, None, None,
            Some(cap),
            Some(vec![]),
            // agent_profile — this test is about the ROLE half; no profile to derive.
            None,
            // flow_push · user_denied_commands — no flow (so the role's denies stand unlifted) and
            // no user denylist.
            None,
            None,
            // pane_id · flow_gate · global_bypass — no pane identity, no gate, toggle off.
            None,
            None,
            None,
            // persona_hooks · namespace_hooks — no persona, ordinary (non-caged) chain.
            None,
            None,
        )
        .expect("settings written");

        let written =
            std::fs::read_to_string(cwd.join(".claude/settings.json")).expect("settings.json");
        assert!(written.contains("curl"), "the user's own deny survives: {written}");
        // Role denies Rust derived and the frontend never sent.
        for expected in ["bsc request", "gh pr merge"] {
            assert!(
                written.contains(expected),
                "the launch must derive `{expected}` even though the frontend omitted it:\n{written}"
            );
        }
        let _ = std::fs::remove_dir_all(&home);
    }

    /// THE CALL SITE, not the helper. `reconcile_profile_settings`'s own tests all stay green if this
    /// wiring is reverted to ignore `agent_profile` — they call it directly. This one drives the real
    /// command and reads the `settings.json` it wrote, so trusting the renderer again fails it.
    ///
    /// The frontend here sends a profile-shaped payload with EVERYTHING the profile grants left out,
    /// and the posture set to the widest value — which is precisely what a renderer that lost the
    /// profile produces, since `buildSessionSettings` defaults `bashPosture` to `"allow"` when `prof`
    /// is null.
    #[test]
    fn the_launch_derives_profile_settings_the_frontend_omitted() {
        let _g = crate::testutil::ENV_LOCK.lock();
        let home = crate::testutil::temp_home("profile-settings-launch");
        let cwd = home.join("repo");
        std::fs::create_dir_all(&cwd).unwrap();
        let profile: crate::session::profile_settings::AgentProfile = serde_json::from_value(
            serde_json::json!({
                "id": "probe",
                "commands": ["cargo test"],
                "tools": { "read": "allow", "web": "deny", "bash": "ask" },
                "paths": { "allow": ["src/**"], "deny": ["**/*.env"] },
            }),
        )
        .unwrap();

        super::ensure_session_settings(
            cwd.to_string_lossy().to_string(),
            vec![],
            vec![],
            None, None, None, None, None, None, None,
            // The widest posture — what the renderer sends when it has no profile in hand.
            Some("allow".to_string()),
            None, None, None, None,
            Some(profile),
            // flow_push · user_denied_commands · pane_id · flow_gate · global_bypass ·
            // persona_hooks · namespace_hooks — this test is about the PROFILE half; none apply.
            None, None, None, None, None, None, None,
        )
        .expect("settings written");

        let written: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(cwd.join(".claude/settings.json")).expect("settings.json"),
        )
        .unwrap();
        let list = |k: &str| -> Vec<String> {
            written["permissions"][k]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        };
        let (allow, deny) = (list("allow"), list("deny"));

        for expected in ["Read", "Edit(src/**)", "Bash(cargo test *)"] {
            assert!(
                allow.contains(&expected.to_string()),
                "the launch must derive `{expected}` from the profile even though the frontend \
                 omitted it: {allow:?}"
            );
        }
        for expected in ["WebFetch", "WebSearch", "Edit(**/*.env)"] {
            assert!(
                deny.contains(&expected.to_string()),
                "the launch must derive the deny `{expected}` from the profile: {deny:?}"
            );
        }
        // THE SCALAR. `ask` grants the read-only baseline only; `allow` also emits a BARE `Bash`
        // (allow-all) plus the build tier. The narrower posture winning is the whole reason this
        // reconciliation is not a plain union, so assert the widening did NOT happen.
        assert!(
            !allow.contains(&"Bash".to_string()),
            "the profile's `ask` posture must beat the frontend's `allow` — a bare Bash allow is the \
             widening this tie-break exists to prevent: {allow:?}"
        );
        assert!(
            allow.contains(&"Bash(ls *)".to_string()),
            "`ask` still grants the read-only baseline, so this is a narrowing and not a blackout: \
             {allow:?}"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

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

        write_session_settings(&SessionSettingsSpec {
            allowed_commands: &["cargo".into(), "git".into()],
            denied_commands: &["scp".into()],
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();

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
        write_session_settings(&SessionSettingsSpec {
            bypass: false,
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();
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

    #[test]
    fn gh_credential_floor_applies_even_for_a_role_that_denies_no_gh() {
        // #3793: a `github: "write"` role (e.g. director) contributes NO gh denies (its GH_WRITE_DENY is
        // empty), yet the always-on dangerous floor still blocks the gh credential/CI-abuse subcommands —
        // via build_deny_rules, NOT the role gate. So no role, in any posture, can exfiltrate the token
        // (`gh auth token`) or seed CI (`gh workflow run`).
        let deny = super::build_deny_rules(&[]); // as a github:write role: no role-supplied gh denies
        for rule in ["Bash(gh auth token*)", "Bash(gh secret *)", "Bash(gh ssh-key add*)", "Bash(gh workflow run*)"] {
            assert!(deny.contains(&rule.to_string()), "floor must deny {rule} regardless of role, got {deny:?}");
        }
        // The read plane is NOT floored — a legit `gh pr view` still runs.
        assert!(!deny.contains(&"Bash(gh pr view*)".to_string()));
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
            write_session_settings(&SessionSettingsSpec {
                allowed_commands: &["terraform".into()],
                bash_posture: posture,
                ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
            }).unwrap();
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

    /// #2471: `restricted_allow` suppresses EVERY baseline tier — the allow list is exactly the
    /// wrapped granted commands. No bare `Bash`, no mandatory gh/git/bsc, no readonly/build
    /// baselines, no `Bash(bsc-*)` helpers. Denies (dangerous floor + user denies) and the verbatim
    /// tool rules still land on top (deny > allow).
    #[test]
    fn write_session_settings_restricted_allow_emits_only_the_granted_commands() {
        use crate::session::settings::write_session_settings;
        let dir = std::env::temp_dir().join(format!("bsc-ess-restricted-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join(".claude")).unwrap();

        // The designer shape (#2471): bsc ui + the deprecated bsc component alias, git/gh denied by
        // the role's `none` tiers, the write tools + web tools denied outright.
        write_session_settings(&SessionSettingsSpec {
            allowed_commands: &["bsc ui".into(), "bsc component".into()],
            denied_commands: &["git".into(), "gh".into()],
            deny_tool_rules: &["Edit".into(), "Write".into(), "WebFetch".into(), "WebSearch".into()],
            restricted_allow: true,
            replace_permissions: true,
            bypass: false,
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();

        let v: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();

        // The granted commands are the ONLY Bash allows — in BOTH invocation forms (#3359).
        assert!(allow.contains(&"Bash(bsc ui *)".to_string()));
        assert!(allow.contains(&"Bash(bsc component *)".to_string()));
        // #3359 regression: the BARE form. `Bash(bsc ui *)`'s trailing ` *` enforces a word
        // boundary, so it does NOT match a no-argument `bsc ui` — the very call an agent makes to
        // discover a command's subcommands. Without these the designer prompts on the one command
        // its role exists to run (restricted roles are the only sessions forced off bypass, so they
        // are the only ones where a missing allow rule actually surfaces).
        assert!(allow.contains(&"Bash(bsc ui)".to_string()), "restricted: bare form must be granted, got {allow:?}");
        assert!(allow.contains(&"Bash(bsc component)".to_string()), "restricted: bare form must be granted, got {allow:?}");
        // No bare Bash, no mandatory tier, no posture baselines, no bsc-* helper family.
        assert!(!allow.contains(&"Bash".to_string()), "restricted: no bare Bash, got {allow:?}");
        for absent in ["Bash(git *)", "Bash(gh *)", "Bash(bsc *)", "Bash(bsc-*)", "Bash(ls *)", "Bash(cargo *)"] {
            assert!(!allow.contains(&absent.to_string()), "restricted: {absent} must be absent, got {allow:?}");
        }
        // Denies still layer on top: the dangerous floor + the role's git/gh denies + the tool denies.
        assert!(deny.contains(&"Bash(sudo *)".to_string()));
        assert!(deny.contains(&"Bash(git *)".to_string()));
        assert!(deny.contains(&"Bash(gh *)".to_string()));
        for t in ["Edit", "Write", "WebFetch", "WebSearch"] {
            assert!(deny.contains(&t.to_string()), "restricted: tool deny {t} must land verbatim");
        }

        // Contrast: the SAME spec with restricted_allow OFF re-grows the baselines (mandatory tier
        // + bare Bash under the `allow` posture) — proving the flag is what suppressed them.
        write_session_settings(&SessionSettingsSpec {
            allowed_commands: &["bsc ui".into()],
            replace_permissions: true,
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();
        let v2: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow2: Vec<String> = v2["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert!(allow2.contains(&"Bash".to_string()));
        assert!(allow2.contains(&"Bash(git *)".to_string()));
        assert!(allow2.contains(&"Bash(bsc-*)".to_string()));
        assert!(allow2.contains(&"Bash(bsc ui *)".to_string()));
        // ...and the bare-form pairing stays EXCLUSIVE to the restricted branch (#3359): the normal
        // path already carries the allow-all `Bash` under this posture, so pairing there would add
        // noise, and `bash_rule` is shared with the DENY assembly where a bare rule changes meaning.
        assert!(!allow2.contains(&"Bash(bsc ui)".to_string()), "unrestricted: no bare pairing, got {allow2:?}");
        let _ = std::fs::remove_dir_all(&dir);
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
        write_session_settings(&SessionSettingsSpec::for_dir(&git_bash)).unwrap();
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
        write_session_settings(&SessionSettingsSpec {
            ask_tool_rules: &["Bash(git push *)".into(), "Bash(gh pr create *)".into()],
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();

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
        // Example rules use the corrected model (#3534): a path-scoped file rule is `Edit(<glob>)`
        // (covers every file-editing tool), and a whole-tool write deny lists the real bare tools
        // (Edit/Write/NotebookEdit — no MultiEdit, a removed tool). The writer is generic; this
        // asserts it lands whatever tool rules it is handed VERBATIM (not Bash-wrapped).
        write_session_settings(&SessionSettingsSpec {
            allow_tool_rules: &["Edit(src/auth/**)".into()],
            deny_tool_rules: &["Edit".into(), "Write".into(), "NotebookEdit".into()],
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();

        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        let allow: Vec<String> = v["permissions"]["allow"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        let deny: Vec<String> = v["permissions"]["deny"].as_array().unwrap()
            .iter().map(|x| x.as_str().unwrap().to_string()).collect();
        // Tool rules land verbatim — NOT wrapped in Bash(...).
        assert!(allow.contains(&"Edit(src/auth/**)".to_string()));
        assert!(!allow.iter().any(|r| r.contains("Bash(Edit")));
        assert!(deny.contains(&"Edit".to_string()));
        assert!(deny.contains(&"Write".to_string()));
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
        write_session_settings(&SessionSettingsSpec {
            allowed_commands: &["terraform".into()],
            ..SessionSettingsSpec::for_dir(&cwd)
        }).unwrap();
        assert!(read().contains(&"Bash(terraform *)".to_string()));

        // Re-apply with the command REMOVED — replace mode must drop it (merge would keep it).
        write_session_settings(&SessionSettingsSpec {
            replace_permissions: true,
            ..SessionSettingsSpec::for_dir(&cwd)
        }).unwrap();
        let allow = read();
        assert!(!allow.contains(&"Bash(terraform *)".to_string()), "replace must drop the removed command (#799)");
        assert!(allow.contains(&"Bash".to_string()), "but the broad Bash allow is recomputed");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// THE REGRESSION. A launch with an EMPTY resolved list used to delete `enabledMcpjsonServers`
    /// while `write_mcp_json` left the servers sitting in `.mcp.json` — so Claude found servers it had
    /// no answer for and blocked on its approval modal BEFORE submitting the session's baked startup
    /// prompt. The session came up, parked on a dialog nobody was watching, and its kickoff never ran.
    ///
    /// Measured on every per-technology studio: `.mcp.json` present, key missing. It is the reason
    /// `bsc session ask` looked like it "only started the session" — delivery was correct the whole
    /// time (the prompt was in argv), and the agent never reached a prompt to receive it.
    ///
    /// Written against the PURE half so it runs everywhere. Its first draft went through
    /// `write_session_settings` and needed a staged `bsc` sidecar to mean anything — without one it
    /// returned early and passed, having asserted nothing.
    #[test]
    fn a_launch_with_no_resolved_servers_keeps_trusting_what_the_app_put_on_disk() {
        let bin = std::path::Path::new("/opt/bsc/bin/bsc");
        let doc = serde_json::json!({ "mcpServers": {
            "Compliance": { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "compliance"] },
            "Research":   { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "research"] },
            "ThirdParty": { "command": "npx", "args": ["-y", "@someone/else"] },
        }});

        // The launch that used to break it: nothing resolved, so the old code removed the key.
        let names = enabled_mcp_names_from(std::slice::from_ref(&doc), &[], Some(bin));

        assert!(
            names.contains(&"Compliance".to_string()) && names.contains(&"Research".to_string()),
            "a server the app itself put in .mcp.json must stay trusted, or its next launch blocks on \
             the approval modal instead of running its prompt: {names:?}",
        );
        // ...and the boundary that keeps this from being a silent widening. `write_mcp_json` preserves
        // repo-authored entries, so auto-enabling everything in the file would trust a server the app
        // knows nothing about.
        assert!(
            !names.contains(&"ThirdParty".to_string()),
            "a repo-authored server must NOT be auto-trusted — it still prompts: {names:?}",
        );
    }

    /// With no sidecar staged, NOTHING on disk can be proven to be the app's — so nothing is trusted.
    /// Failing open here would auto-enable a repo-authored server on exactly the installs least able
    /// to vouch for it.
    #[test]
    fn without_a_bundled_binary_nothing_on_disk_is_app_managed() {
        let doc = serde_json::json!({ "mcpServers": {
            "Compliance": { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "compliance"] },
        }});
        assert!(enabled_mcp_names_from(std::slice::from_ref(&doc), &[], None).is_empty());
    }

    /// The resolved list still leads, and a server in BOTH is listed once — the enabled set is a
    /// union, not a concatenation, and a duplicate would be a second answer to the same question.
    #[test]
    fn the_resolved_list_and_the_file_union_without_duplicating() {
        let bin = std::path::Path::new("/opt/bsc/bin/bsc");
        let doc = serde_json::json!({ "mcpServers": {
            "Compliance": { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "compliance"] },
        }});
        let resolved = vec![McpServerCfg {
            name: "Compliance".into(), transport: "stdio".into(),
            command: Some("/opt/bsc/bin/bsc".into()), args: vec![], url: None, env: vec![],
        }];
        assert_eq!(enabled_mcp_names_from(std::slice::from_ref(&doc), &resolved, Some(bin)), vec!["Compliance".to_string()]);
    }

    /// THE HOLE IN THE FIRST FIX, and the reason the modal survived it. Claude walks UP for
    /// `.mcp.json`, so a session whose own directory has none is still subject to its parent's — and
    /// the first version read only the session's own file, computing NOTHING for exactly that case.
    ///
    /// Measured: `algorithms-studio/python` has no `.mcp.json`; its parent's holds
    /// `[Compliance, Research]`; those are the two names Claude's modal listed in that cwd. Four of
    /// the per-technology studios inherit rather than own.
    #[test]
    fn a_session_with_no_file_of_its_own_still_trusts_its_ancestors() {
        let bin = std::path::Path::new("/opt/bsc/bin/bsc");
        // Nearest first, exactly as the walk yields them: the session's own dir (nothing), then the
        // parent that actually declares the servers.
        let docs = vec![
            serde_json::json!({}),
            serde_json::json!({ "mcpServers": {
                "Compliance": { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "compliance"] },
                "Research":   { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "research"] },
            }}),
        ];
        let names = enabled_mcp_names_from(&docs, &[], Some(bin));
        assert!(
            names.contains(&"Compliance".to_string()) && names.contains(&"Research".to_string()),
            "an inherited server must be trusted too, or the studios that own no file keep blocking on \
             the approval modal: {names:?}",
        );
    }

    /// A name in both the session's file and an ancestor's is ONE server to Claude, so it is listed
    /// once. A duplicate would be a second answer to the same question.
    #[test]
    fn a_server_declared_at_two_levels_is_listed_once() {
        let bin = std::path::Path::new("/opt/bsc/bin/bsc");
        let entry = serde_json::json!({ "mcpServers": {
            "Compliance": { "command": "/opt/bsc/bin/bsc", "args": ["mcp", "compliance"] },
        }});
        let docs = vec![entry.clone(), entry];
        assert_eq!(enabled_mcp_names_from(&docs, &[], Some(bin)), vec!["Compliance".to_string()]);
    }

    /// The walk being unbounded is safe because DEPTH is not what gates it — `app_managed_mcp_server`
    /// is. A stranger's `.mcp.json` any number of levels up contributes nothing.
    #[test]
    fn an_ancestors_third_party_server_is_never_trusted_however_far_up_it_is() {
        let bin = std::path::Path::new("/opt/bsc/bin/bsc");
        let docs = vec![
            serde_json::json!({}),
            serde_json::json!({ "mcpServers": { "Evil": { "command": "npx", "args": ["-y", "@x/y"] } } }),
            serde_json::json!({ "mcpServers": { "AlsoEvil": { "command": "/usr/bin/sh" } } }),
        ];
        assert!(enabled_mcp_names_from(&docs, &[], Some(bin)).is_empty());
    }

    /// Removal still lands. The fix must not turn `enabledMcpjsonServers` into an append-only list —
    /// a server genuinely dropped from `.mcp.json` has to leave the trust record with it.
    #[test]
    fn a_server_no_longer_on_disk_leaves_the_trust_record() {
        let dir = std::env::temp_dir().join(format!("bsc-mcp-drop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();

        // No `.mcp.json` at all, and nothing resolved ⇒ nothing to trust, and the key goes.
        write_session_settings(&SessionSettingsSpec { mcp_servers: &[], ..SessionSettingsSpec::for_dir(&cwd) }).unwrap();
        let settings: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(".claude").join("settings.json")).unwrap()).unwrap();
        assert!(
            settings.get("enabledMcpjsonServers").is_none(),
            "with nothing on disk and nothing resolved the key must be absent, not an empty relic",
        );

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
        write_session_settings(&SessionSettingsSpec {
            mcp_servers: &mcp,
            hooks: &hooks,
            ..SessionSettingsSpec::for_dir(&dir.to_string_lossy())
        }).unwrap();

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
