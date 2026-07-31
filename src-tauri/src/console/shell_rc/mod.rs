// bsc-* shell helpers (#199/#257/#406/#416/#734): the rc-file fragments installed into every session
// via BASH_ENV (extracted from lib.rs #758; moved into this dir-module #2092).
//
// The SHELL TEXT of every fragment is externalized to `data/shell/*.sh` (#2027 P1, #2092), loaded at
// rc-assembly time via `crate::platform::config::load_str` — so it is config-dir-overridable, ships in
// the config export bundle, and reads as real shell (syntax-highlighted, no Rust string-escaping). The
// ONE fragment that stays code is `bsc_defer_rc()`: it composes the Stop-hook shell wrapper around the
// externalized directive prose (`data/fleet/defer-directive.md`, #2145), JSON-embedding it.
//
// TWO invariants the assembly must preserve — both derived from the single ordered list `all_bsc_rc()`:
//  * #296 GLUE CONTRACT: every fragment MUST end in a trailing newline, or two helper functions glue
//    together (`}bsc-audit()`) and the whole rc breaks with a bash syntax error. `load_shell` enforces
//    it, and `full_bsc_rc_is_syntactically_valid_bash` guards the assembled body.
//  * ORDER: `data/shell/shared.sh` (the `__bsc_jstr`/`__bsc_now_ms`/`__bsc_logline` helpers, #2064) MUST
//    come first — every other fragment calls them.
//
// The `.sh` seeds are LF-pinned in `.gitattributes` so the `include_dir!` bytes are byte-identical on
// every platform (matching the rustc-normalized string literals they replaced). Per-helper contracts:
//  * shared.sh    — __bsc_jstr <ere> / __bsc_now_ms / __bsc_logline <file> <fmt> [args] (#2064): the JSON
//                   string-field extractor, portable epoch-ms, and mkdir+append log tail, defined once.
//  * checkpoint.sh— bsc-checkpoint (#199): overwrite the per-repo $BSC_CHECKPOINT_DOC from stdin.
//  * decisions.sh — bsc-note (#1039/#1167): append a provenance-tagged (`- [<pane>] …`) line to
//                   $BSC_DECISIONS_DOC (default $PWD/DECISIONS.md); a cross-session note is untrusted data.
//  * audit.sh     — bsc-audit (#257): PreToolUse tap; logs `ts·pane·tool·target` (name + short target
//                   ONLY, never file contents/secrets) to $BSC_AUDIT_LOG. Best-effort, always exits 0.
//  * skill.sh     — bsc-skill (#406/#1338/#1877): with args → `$BSC_BIN skill …` (global skills.db CLI);
//                   no args → Skill-tool telemetry to $BSC_SKILL_LOG. Argc discriminates.
//  * hook.sh      — bsc-hook (#867/#1743): wraps a USER hook — runs its command, logs
//                   `ts·pane·event·name·outcome` to $BSC_HOOK_LOG, PROPAGATES the exit code (block=exit 2).
//  * mcp.sh       — bsc-mcp (#879/#1743): Pre/PostToolUse MCP-call latency; logs
//                   `ts·pane·server·tool·outcome·ms·detail` to $BSC_MCP_LOG (fail/warn/ok). Non-MCP ignored.
//  * tokens.sh    — bsc-tokens (#416): Stop/SubagentStop tap; logs `ts·pane·session·transcript_path` to
//                   $BSC_TOKENS_LOG (the transcript is the only per-session token source).
//  * activity.sh  — bsc-activity run|idle (#1184): turn-boundary signal to $BSC_ACTIVITY_LOG; gates the
//                   console silence timer so a thinking worker doesn't false-idle. Authoritative idle = Stop.
//  * done.sh      — bsc-done (#1379): a worker self-reports its console done → $BSC_DONE_LOG (the frontend
//                   classifies the resting state from plan.db, not this say-so, then reaps the pane).
//  * perm.sh      — __bsc_perm (#1607): append a pane-tagged permission-denial row to $BSC_PERM_LOG
//                   (`ts·pane·gate·verdict·target·reason`); shared by the confine/scope deny hooks.
//  * confine.sh   — bsc-confine (#158/#1916): DEFAULT file-tool PreToolUse hook; return 2 when a path
//                   escapes $BSC_REPO_ROOT or targets the session's own .claude config. Mirrors fsConfine.ts.
//  * scope.sh     — bsc-scope (#1297): file-WRITE PreToolUse hook; return 2 when the path matches none of
//                   $BSC_SCOPE_GLOBS (the hard deny the role gate's allow-only rules lack). Mirrors sessionRoles.ts.
//  * deny.sh      — bsc-deny (#1916): Bash PreToolUse hook → `bsc hook bash-deny` (the dangerous-command
//                   floor + role/user denies that survive bypassPermissions). Backed by the bsc binary.
//  * supply.sh    — bsc-supply (#3799): Bash PreToolUse hook → `bsc hook bash-supply` (blocks a dependency
//                   ADD of a malicious/known-vulnerable package via OSV/`bsc cve`; fail-open). Gated panes only.
//  * taint.sh     — bsc-taint (#1167): tainted-turn gate; return 2 on outward/destructive Bash within
//                   $BSC_TAINT_WINDOW of ingesting untrusted input (WebFetch / curl / gh issue|pr view).
//  * coord-emit.sh— __bsc_coord(+_log) + bsc-landed/merged/closed/failed/wait/maintain/ask/answer/fork/issue/
//                   assign/brief (#199/#376/#2377): the coordination emitters to $BSC_COORD_LOG.
//                   bsc-brief is the PLANNER's runtime voice (planner→director/issuer); a coordination
//                   write only — no code/git escalation of the plan-only role gate.
//  * (defer)      — bsc-defer (#369/#2145): Stop-hook; keeps a worker going or defers to the director.
//  * fleet.sh     — bsc-fleet (#734): the director's roster view (joins fleet.roster.tsv + coord.log).
//  * bsc.sh       — bsc (#1877): the ONE umbrella-binary dispatcher; execs $BSC_BIN (bsc plan|skill|…).
//  * learned.sh   — bsc-learned (#1362): capture a self-correction CANDIDATE → `bsc plan lesson add`.

/// Load an externalized `bsc-*` shell fragment from `data/shell/<name>` (config-dir-overridable, #2027).
/// Normalizes CRLF→LF and GUARANTEES the #296 trailing-newline glue contract, so a Windows-edited config
/// override can neither inject `\r` into sourced bash nor drop the terminating newline that keeps each
/// helper on its own line in the concatenated rc. The embedded seed is LF (pinned in `.gitattributes`),
/// so for the shipped artifact both fixups are no-ops and the body stays byte-identical to the old inline
/// string-literal constants.
fn load_shell(name: &str) -> String {
    let mut s = crate::platform::config::load_str(&format!("shell/{name}")).replace('\r', "");
    if !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// The `bsc-defer` Stop hook (#369, rebuilt in #4021): fires when a fleet WORKER tries to end its turn.
///
/// It is now a ONE-LINE wrapper around `bsc hook stop-defer`, for the reason `bsc-deny` already gives:
/// the decision is backed by the binary rather than fragile shell JSON-parsing. And this decision needs
/// real inputs — it reads the stream's open issues from plan.db, checks whether the pane is already
/// blocked on a human, and keeps a bounce counter. None of that belongs in a `case` statement.
///
/// What CHANGED behaviourally: the old wrapper bounced exactly ONCE (`stop_hook_active`) and then let
/// the worker stop forever. Measured cost: 20 panes idle with work outstanding, unreachable by anything
/// in the app. The hook now bounces while work remains, and only releases a worker that is finished,
/// parked on a person, or genuinely stuck (and it announces that last one). See `crates/bsc/src/defer.rs`.
///
/// The DIRECTIVE prose stays externalized + config-overridable (#2145) and is passed through as env,
/// since the binary cannot resolve the user's config dir. Both directives are JSON/shell constrained
/// the same way as before: single line, no raw `'` (they are single-quoted here).
pub(crate) fn bsc_defer_rc() -> String {
    let keep = one_line_sq(&crate::platform::config::load_str("fleet/defer-directive.md"));
    let stuck = one_line_sq(&crate::platform::config::load_str("fleet/defer-stuck-directive.md"));
    format!("bsc-defer() {{ BSC_DEFER_DIRECTIVE='{keep}' BSC_DEFER_STUCK='{stuck}' bsc hook stop-defer; }}\n")
}

/// Flatten prose to ONE single-quotable shell line: newlines collapse to spaces and any raw `'` is
/// dropped. A stray quote would terminate the surrounding single-quoted string and break the whole rc
/// (#296 territory) — stripping is the safe direction, since the directive is guidance prose whose
/// exact punctuation is not load-bearing.
fn one_line_sq(s: &str) -> String {
    s.trim().replace(['\n', '\r'], " ").replace('\'', "")
}

/// The trusted native-build allowlist (#3795, epic #2433) — the packages whose install lifecycle
/// script IS legit — read from the embedded `data/permissions/build-allowlist.json`. Names are
/// filtered to a package-safe charset (`[A-Za-z0-9@/._-]`) so a malformed/hostile seed entry can
/// never inject shell metacharacters into the rendered `for` list. An unreadable/empty seed yields an
/// empty list (the helper is still defined, just a no-op).
fn build_allowlist() -> Vec<String> {
    #[derive(serde::Deserialize)]
    struct Allowlist {
        #[serde(default)]
        packages: Vec<String>,
    }
    let raw = crate::platform::config::load_str("permissions/build-allowlist.json");
    serde_json::from_str::<Allowlist>(&raw)
        .map(|a| a.packages)
        .unwrap_or_default()
        .into_iter()
        .filter(|p| {
            !p.is_empty() && p.bytes().all(|b| b.is_ascii_alphanumeric() || b"@/._-".contains(&b))
        })
        .collect()
}

/// The `bsc-build-allowed` helper (#3795, epic #2433). With `npm_config_ignore_scripts=true` the
/// supply-chain floor for every fleet install (`platform::pkgcache`), a session's `npm install` skips
/// ALL lifecycle scripts — so a trusted native package (esbuild, better-sqlite3, …) never builds.
/// After install, `bsc-build-allowed` runs `npm rebuild` for exactly the [`build_allowlist`] packages
/// that are PRESENT under `./node_modules`, re-enabling scripts for that one invocation only — nothing
/// off the allowlist ever runs a script. The allowlist is baked in at render time (like `bsc_defer_rc`).
/// The fragment keeps its mandatory trailing newline (#296) so it doesn't glue onto the next helper.
pub(crate) fn build_allowed_rc() -> String {
    let list = build_allowlist().join(" ");
    // Every name is charset-filtered above, so an unquoted `for` list is injection-safe. Each rebuild
    // re-enables scripts locally (`npm_config_ignore_scripts=false`) against the scripts-off default.
    // `return 0` so the helper always succeeds — else the loop's exit status is the LAST `[ -d ]` test,
    // which is falsey (non-zero) whenever the last allowlist entry isn't installed, making a clean run
    // look like a failure to any `$?` check (#3799: caught once the subshell test was actually run).
    format!(
        "bsc-build-allowed() {{ for p in {list}; do [ -d \"node_modules/$p\" ] && npm_config_ignore_scripts=false npm rebuild \"$p\"; done; return 0; }}\n"
    )
}

/// Every `bsc-*` rc fragment, in the EXACT sequence the rc file concatenates them. This is the single
/// source of truth for the concat order: the rc writer (`wire_bsc_env` → `bsc_rc_body`) and the
/// `full_bsc_rc_is_syntactically_valid_bash` syntax guard both derive from it, so a new helper (or a
/// reorder) lands in one place and can never silently fall out of lockstep. Every fragment is loaded from
/// `data/shell/*.sh` EXCEPT `bsc_defer_rc()`, whose shell wraps a config-loaded directive (#2145). Each
/// fragment ends in a trailing newline (`load_shell` enforces it), so `.concat()` keeps every helper on
/// its own line.
pub(crate) fn all_bsc_rc() -> Vec<String> {
    vec![
        load_shell("shared.sh"), // MUST be first — every helper below calls __bsc_jstr/__bsc_now_ms/__bsc_logline.
        load_shell("checkpoint.sh"),
        load_shell("decisions.sh"),
        load_shell("audit.sh"),
        load_shell("skill.sh"),
        load_shell("hook.sh"),
        load_shell("mcp.sh"),
        load_shell("tokens.sh"),
        load_shell("activity.sh"),
        load_shell("done.sh"),
        load_shell("perm.sh"),
        load_shell("confine.sh"),
        load_shell("scope.sh"),
        load_shell("deny.sh"),
        load_shell("supply.sh"),
        load_shell("taint.sh"),
        load_shell("coord-emit.sh"),
        bsc_defer_rc(),
        load_shell("fleet.sh"),
        build_allowed_rc(),
        load_shell("bsc.sh"),
        load_shell("learned.sh"),
    ]
}

/// The full bsc-* rc body that `pty_create` writes to `bsc-env.sh` — every fragment in `all_bsc_rc()`
/// concatenated in order. Byte-identical to the old inline `format!` of the string-literal constants.
pub(crate) fn bsc_rc_body() -> String {
    all_bsc_rc().concat()
}

#[cfg(test)]
mod tests;
