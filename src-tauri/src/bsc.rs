// bsc-* shell helpers (#199/#257/#406/#416/#734): the rc-file fragments installed
// into every session via BASH_ENV (extracted from lib.rs, #758).
//
// WARNING: each rc constant MUST end with a trailing newline or the concatenated
// helper functions glue together and the whole rc breaks with a bash syntax error
// (#296) — the full_bsc_rc_is_syntactically_valid_bash test guards this.

/// The `bsc-checkpoint` helper: reads stdin and overwrites the per-repo checkpoint
/// doc named by `$BSC_CHECKPOINT_DOC` (creating its parent dir). Installed via an rc
/// file + `BASH_ENV` so it's reachable from the agent's non-interactive `bash -c`
/// subshells, not just the interactive PTY shell. The hyphenated name can't be
/// `export -f`'d — bash refuses to import functions whose names aren't valid
/// identifiers (post-Shellshock) — so it must be *defined* in each subshell.
pub(crate) const BSC_CHECKPOINT_RC: &str =
    "bsc-checkpoint() { mkdir -p \"$(dirname \"$BSC_CHECKPOINT_DOC\")\" 2>/dev/null; cat > \"$BSC_CHECKPOINT_DOC\"; }\n";

/// The `bsc-note` / `bsc-blocked` helpers: append a one-line entry read from stdin
/// to the assume-and-log journal named by `$BSC_DECISIONS_DOC` (default: a
/// `DECISIONS.md` in the session's cwd, creating its parent dir). Fleet workers use
/// these to record a reversible decision (note) or a genuine stop (blocked) and keep
/// moving instead of stalling on a human. Same rc + `BASH_ENV` install path as
/// bsc-checkpoint, so the agent's non-interactive Bash subshells can call them.
pub(crate) const BSC_DECISIONS_RC: &str = concat!(
    // `printf '%s' '- '` (not `printf '- '`): a format starting with `-` is parsed as
    // an option flag and the prefix is silently dropped.
    "bsc-note() { d=\"${BSC_DECISIONS_DOC:-$PWD/DECISIONS.md}\"; mkdir -p \"$(dirname \"$d\")\" 2>/dev/null; { printf '%s' '- '; cat; printf '\\n'; } >> \"$d\"; }\n",
    // bsc-blocked also accepts `--on <ref[,ref]>` (+ optional `--checkpoint <ref>`):
    // when present it appends a structured `blocked` event to $BSC_COORD_LOG (#199),
    // tagged with the pane id, alongside the human note. No --on => note only.
    // A ref is `#42` | `contract:Name` | `file:path` | `predicate:expr` | `session:<paneId>`
    // ("blocked until that pane finishes" — the form the runtime uses to detect wait-for
    // cycles between sessions; see detectDeadlocks in src/lib/coordination.ts).
    r#"bsc-blocked() { on=""; cp=""; while [ $# -gt 0 ]; do case "$1" in --on) on="$2"; shift 2 ;; --checkpoint) cp="$2"; shift 2 ;; *) shift ;; esac; done; d="${BSC_DECISIONS_DOC:-$PWD/DECISIONS.md}"; mkdir -p "$(dirname "$d")" 2>/dev/null; m="$(cat)"; { printf '%s' '- BLOCKED: '; printf '%s' "$m"; [ -n "$on" ] && printf '%s' " (on $on)"; printf '\n'; } >> "$d"; l="${BSC_COORD_LOG:-}"; if [ -n "$on" ] && [ -n "$l" ]; then ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\tblocked\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$on" "$cp" >> "$l"; fi; }"#,
    "\n",
);

/// The `bsc-audit` helper (#257): the PreToolUse hook on a gated pane pipes Claude
/// Code's tool JSON into this; it extracts ONLY the tool name + a short target field
/// (never `content`/`new_string`, so file contents / secrets aren't written) and
/// appends one TAB-separated line — `ts \t pane \t toolName \t target` — to the
/// app-wide `$BSC_AUDIT_LOG`, tagged with `$BSC_AUDIT_PANE`. Best-effort + always exits
/// 0 so it never blocks a tool. A raw string keeps the embedded quotes/regex readable.
pub(crate) const BSC_AUDIT_RC: &str = concat!(
    r#"bsc-audit() { l="${BSC_AUDIT_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat)"; tn="$(printf '%s' "$j" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"; tg="$(printf '%s' "$j" | grep -oE '"(command|file_path|notebook_path|url|query|pattern|path|description)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | tr '\t\n' '  ' | cut -c1-160)"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$tn" "$tg" >> "$l"; return 0; }"#,
    "\n",
);

/// The `bsc-skill` helper (#406): a PreToolUse/PostToolUse hook for the Skill tool on a
/// gated pane pipes Claude Code's hook JSON into this; it extracts ONLY the skill name
/// (`skill_name`) and the hook event (`hook_event_name`) and appends one TAB-separated
/// line — `ts \t pane \t event \t skill` — to the app-wide `$BSC_SKILL_LOG`, tagged with
/// `$BSC_AUDIT_PANE`. The name/event are sanitized like bsc-audit's target (strip tabs/
/// newlines, cap length) so a stray char can't corrupt the TSV. Best-effort + always
/// exits 0 so it never blocks a tool. A raw string keeps the embedded quotes/regex readable.
pub(crate) const BSC_SKILL_RC: &str = concat!(
    r#"bsc-skill() { l="${BSC_SKILL_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat)"; sn="$(printf '%s' "$j" | tr '\t\n' '  ' | grep -oE '"skill_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | cut -c1-120)"; ev="$(printf '%s' "$j" | tr '\t\n' '  ' | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | cut -c1-120)"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$ev" "$sn" >> "$l"; return 0; }"#,
    "\n",
);

/// The `bsc-hook` wrapper (#867 follow-up — hook-fire logging): a USER hook (configured in
/// the Hooks UI) is written to settings.json wrapped as `bsc-hook '<name>' '<command>'` (the
/// frontend `toHookPayload` does the single-quote escaping). It reads Claude Code's hook JSON
/// from stdin, RUNS the user's command (re-piping that JSON to it), captures its exit code,
/// and appends one TAB line — `ts \t event \t name \t outcome` — to `$BSC_HOOK_LOG` for the
/// Hook Analytics tab. `ts` is epoch ms (matches `hookTelemetry.parseHookLog`). `outcome` is
/// "block" when a PreToolUse command exits 2 (Claude Code's deny convention), "allow"
/// otherwise for PreToolUse, "ok" for other events. The user's exit code is PROPAGATED so a
/// block still takes effect. Only USER hooks are wrapped; the security hooks (bsc-confine /
/// bsc-audit) are never routed through here. A raw string keeps the embedded quotes readable.
pub(crate) const BSC_HOOK_RC: &str = concat!(
    r#"bsc-hook() { nm="$1"; cmd="$2"; j="$(cat)"; printf '%s' "$j" | sh -c "$cmd"; code=$?; l="${BSC_HOOK_LOG:-}"; if [ -n "$l" ]; then ev="$(printf '%s' "$j" | tr '\t\n' '  ' | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | cut -c1-60)"; [ -z "$ev" ] && ev="?"; oc="ok"; if [ "$ev" = "PreToolUse" ]; then if [ "$code" -eq 2 ]; then oc="block"; else oc="allow"; fi; fi; nm="$(printf '%s' "$nm" | tr '\t\n' '  ' | cut -c1-80)"; ts="$(date -u +%s)000"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\t%s\t%s\n' "$ts" "$ev" "$nm" "$oc" >> "$l"; fi; exit "$code"; }"#,
    "\n",
);

/// The `bsc-mcp` helper (#879 PR 2 — MCP-call logging): a PreToolUse + PostToolUse hook on a
/// gated pane, matched to MCP tools (`mcp__<server>__<tool>`). It measures the round-trip
/// latency of each MCP call and logs one TAB line — `ts \t server \t tool \t outcome \t ms \t
/// detail` — to `$BSC_MCP_LOG` for the MCP Analytics tab. `ts` is epoch ms (matches
/// `mcpTelemetry.parseMcpLog`). PreToolUse stamps a start time keyed by pane+tool under a temp
/// dir; PostToolUse reads it back, computes `ms = now − start`, derives the outcome (`fail` when
/// the tool response carries `isError/is_error: true`, `warn` when rate-limited or slower than
/// `$BSC_MCP_SLOW_MS` (default 2000ms), else `ok`), and appends the line. Non-MCP tools are
/// ignored. Best-effort + always returns 0 so it never blocks a tool. A raw string keeps the
/// embedded quotes/regex readable.
pub(crate) const BSC_MCP_RC: &str = concat!(
    r#"bsc-mcp() { l="${BSC_MCP_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat | tr '\t\n' '  ')"; now="$(date +%s%3N 2>/dev/null)"; case "$now" in ''|*[!0-9]*) now="$(( $(date -u +%s) * 1000 ))" ;; esac; tn="$(printf '%s' "$j" | grep -oE '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"; case "$tn" in mcp__*) ;; *) return 0 ;; esac; ev="$(printf '%s' "$j" | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"; rest="${tn#mcp__}"; server="${rest%%__*}"; tool="${rest#*__}"; d="${TMPDIR:-/tmp}/bsc-mcp"; mkdir -p "$d" 2>/dev/null; key="$(printf '%s_%s' "${BSC_AUDIT_PANE:-x}" "$tn" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-150)"; if [ "$ev" = "PreToolUse" ]; then printf '%s' "$now" > "$d/$key" 2>/dev/null; return 0; fi; start="$(cat "$d/$key" 2>/dev/null)"; rm -f "$d/$key" 2>/dev/null; ms=0; case "$start" in *[0-9]*) ms=$(( now - start )) ;; esac; [ "$ms" -lt 0 ] && ms=0; oc="ok"; detail=""; if printf '%s' "$j" | grep -qE '"(is_error|isError)"[[:space:]]*:[[:space:]]*true'; then oc="fail"; detail="$(printf '%s' "$j" | grep -oE '"(text|message|error)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | cut -c1-100)"; [ -z "$detail" ] && detail="error"; elif printf '%s' "$j" | grep -qiE 'rate.?limit'; then oc="warn"; detail="rate-limited"; elif [ "$ms" -gt "${BSC_MCP_SLOW_MS:-2000}" ]; then oc="warn"; detail="slow"; fi; server="$(printf '%s' "$server" | cut -c1-60)"; tool="$(printf '%s' "$tool" | cut -c1-60)"; detail="$(printf '%s' "$detail" | cut -c1-120)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "$server" "$tool" "$oc" "$ms" "$detail" >> "$l"; return 0; }"#,
    "\n",
);

/// The `bsc-tokens` helper (#416): a Stop / SubagentStop hook on a gated pane pipes
/// Claude Code's hook JSON into this; it extracts the `session_id` and `transcript_path`
/// (Claude Code's hooks carry these but NOT token usage, so the transcript is the only
/// per-session source) and appends one TAB-separated line — `ts \t pane \t session_id \t
/// transcript_path` — to the app-wide `$BSC_TOKENS_LOG`, tagged with `$BSC_AUDIT_PANE`.
/// The session id is sanitized like bsc-skill's fields (strip tabs/newlines, cap length);
/// the transcript path is left verbatim (a JSON-escaped native path) for `read_token_usage`
/// to decode + parse. Best-effort + always exits 0 so it never blocks a stop. A raw string
/// keeps the embedded quotes/regex readable.
pub(crate) const BSC_TOKENS_RC: &str = concat!(
    r#"bsc-tokens() { l="${BSC_TOKENS_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat | tr '\t\n' '  ')"; sid="$(printf '%s' "$j" | grep -oE '"session_id"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/' | cut -c1-120)"; tp="$(printf '%s' "$j" | grep -oE '"transcript_path"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1 | sed -E 's/^"transcript_path"[[:space:]]*:[[:space:]]*"(.*)"$/\1/')"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; mkdir -p "$(dirname "$l")" 2>/dev/null; printf '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$sid" "$tp" >> "$l"; return 0; }"#,
    "\n",
);

/// The `bsc-confine` helper (#158): a PreToolUse hook for the file tools on a gated
/// pane. It reads Claude Code's tool JSON, extracts the target `file_path` /
/// `notebook_path`, and BLOCKS (return 2 + stderr) when the path escapes the session's
/// repo root (`$BSC_REPO_ROOT`) — any `..` segment, or an absolute path not under the
/// root. Mirrors `src/lib/fsConfine.ts` (the unit-tested decision). String-based + no
/// realpath so it's portable; `return 2` (not `exit`) so it never kills a shell that
/// sources it. Covers the AI's file tools only — Bash needs OS-level sandboxing.
pub(crate) const BSC_CONFINE_RC: &str = concat!(
    r#"bsc-confine() { local root="${BSC_REPO_ROOT:-}"; [ -z "$root" ] && return 0; local j fp; j="$(cat)"; fp="$(printf '%s' "$j" | grep -oE '"(file_path|notebook_path)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/.*"([^"]*)"$/\1/')"; [ -z "$fp" ] && return 0; fp="${fp//\\//}"; fp="$(printf '%s' "$fp" | tr -s '/')"; case "$fp" in ..|../*|*/../*|*/..) echo "blocked: '$fp' leaves the repo root ($root) — #158 FS confinement" >&2; return 2 ;; esac; case "$fp" in /*|~*|[A-Za-z]:*) case "$fp" in "$root"|"$root"/*) return 0 ;; *) echo "blocked: '$fp' is outside the repo root ($root) — #158 FS confinement" >&2; return 2 ;; esac ;; esac; return 0; }"#,
    "\n",
);

/// Satisfy / failure emitters for $BSC_COORD_LOG (#199): the director (or a producer
/// session) marks a dependency done (landed/merged/closed) or failed so parked
/// waiters can be woken. One TSV line per call, tagged with the pane id -- symmetric
/// to `bsc-blocked --on`. Quote `#`-refs (`bsc-merged '#42'`) so the shell doesn't
/// treat them as comments; a bare number works too. `bsc-failed` reads the reason
/// from stdin. A real newline separates each function inside the raw string.
///
/// The issuer flow (#376) adds two emitters that carry MORE than the 2-payload
/// `__bsc_coord` shape, so they build their own TSV line (a low-level
/// `__bsc_coord_log` helper appends a pre-tab-joined payload):
/// - `bsc-issue --title <t> [--suggested <repo|stream>] [--id <id>]` (body on stdin) —
///   the issuer captures a shaped issue; emits `issue \t <title> \t <body> \t
///   <suggested> \t <id>` for the director's intake list. `parseCoordLine` reads
///   `rest[0..3]` as title/body/suggested/id.
/// - `bsc-assign <target> [--issue <id>] [--title <t>]` (body on stdin) — the director
///   routes an issue to a worker; emits `assign \t <target> \t <body> \t <issueId> \t
///   <title>`, which resumes that worker and injects the work. `parseCoordLine` reads
///   `rest[0..3]` as target/body/issueId/title.
/// Multi-word values come through flags (not positionals), and embedded tabs/newlines
/// are squashed to spaces so the TSV stays single-line and column-aligned.
pub(crate) const BSC_COORD_EMIT_RC: &str = r#"__bsc_coord() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; mkdir -p "$(dirname "$l")" 2>/dev/null; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf '%s\t%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1" "$2" "$3" >> "$l"; }
__bsc_coord_log() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; mkdir -p "$(dirname "$l")" 2>/dev/null; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; printf '%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1" >> "$l"; }
bsc-landed() { __bsc_coord landed "$1" ""; }
bsc-merged() { __bsc_coord merged "$1" ""; }
bsc-closed() { __bsc_coord closed "$1" ""; }
bsc-failed() { r="$(cat)"; __bsc_coord failed "$1" "$r"; }
bsc-wait() { r="$(cat)"; __bsc_coord waiting "$r" "${BSC_CHECKPOINT_DOC:-}"; }
bsc-ask() { r="$(cat | tr '\t\n' '  ')"; __bsc_coord ask "$r" "${BSC_CHECKPOINT_DOC:-}"; }
bsc-answer() { tgt="$1"; a="$(cat | tr '\t\n' '  ')"; __bsc_coord answer "$tgt" "$a"; }
bsc-issue() { t=""; s=""; id=""; while [ $# -gt 0 ]; do case "$1" in --title) t="$2"; shift 2 ;; --suggested) s="$2"; shift 2 ;; --id) id="$2"; shift 2 ;; *) shift ;; esac; done; t="$(printf '%s' "$t" | tr '\t\n' '  ')"; s="$(printf '%s' "$s" | tr '\t\n' '  ')"; id="$(printf '%s' "$id" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "issue	$t	$b	$s	$id"; }
bsc-assign() { tgt="$1"; [ $# -gt 0 ] && shift; id=""; t=""; while [ $# -gt 0 ]; do case "$1" in --issue) id="$2"; shift 2 ;; --title) t="$2"; shift 2 ;; *) shift ;; esac; done; tgt="$(printf '%s' "$tgt" | tr '\t\n' '  ')"; id="$(printf '%s' "$id" | tr '\t\n' '  ')"; t="$(printf '%s' "$t" | tr '\t\n' '  ')"; b="$(cat | tr '\t\n' '  ')"; __bsc_coord_log "assign	$tgt	$b	$id	$t"; }
"#;

/// The `bsc-defer` Stop hook (#369): fires when a fleet WORKER tries to end its turn.
/// If it has already been re-prompted once (`stop_hook_active`), it allows the stop;
/// otherwise it returns a `block` decision that pushes the worker to keep going or defer
/// a real question to the director via `bsc-ask` -- never to sit waiting on the user.
pub(crate) const BSC_DEFER_RC: &str = concat!(
    r#"bsc-defer() { j="$(cat)"; case "$j" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) return 0 ;; esac; printf '%s' '{"decision":"block","reason":"Do not stop. Drive every owned issue to DONE and onto develop yourself: implement it, run the full local gate, then under the default self-merge policy fetch and rebase onto develop, re-run the gate, push develop, and pipe the issue into bsc-landed -- then immediately pick up your next owned issue. Keep going until EVERY owned issue is integrated into develop with the gate green and nothing remains; do not wait on the user, on CI, or on the director to merge for you. For a decision you genuinely cannot make yourself, pipe a one-line question into bsc-ask so the director answers and resumes you."}'; }"#,
    "\n",
);

/// `bsc-fleet` (#734): the director's roster view. Reads `fleet.roster.tsv` (written at fleet
/// launch into the project hub -- the director's cwd) and joins it with `coord.log` to print
/// every session's console id (PANE), stream, repo, branch, role, and current STATE (blocked /
/// waiting / ask / active / idle, with what it's blocked on / asking). The PANE id is the
/// `<session>` argument the director feeds to bsc-answer / bsc-assign -- so this is how it
/// knows which worker to reach. State comes from each session's latest OWN-state coord event.
pub(crate) const BSC_FLEET_RC: &str = concat!(
    r#"bsc-fleet() { r="${BSC_FLEET_ROSTER:-$PWD/fleet.roster.tsv}"; l="${BSC_COORD_LOG:-}"; if [ ! -f "$r" ]; then echo "bsc-fleet: no roster at $r (run from the project hub while a fleet is live)"; return 1; fi; printf 'PANE   STREAM             REPO                       BRANCH           ROLE     STATE\n'; awk -F'\t' -v LOG="$l" 'BEGIN { if (LOG != "") { while ((getline ln < LOG) > 0) { split(ln, a, "\t"); k=a[3]; if (k=="blocked"||k=="waiting"||k=="ask"||k=="woke") { st[a[2]]=k; on[a[2]]=(k=="blocked"||k=="ask")?a[4]:"" } } close(LOG) } } { s=st[$1]; if (s=="") s="idle"; if (s=="woke") s="active"; ex=(on[$1]!="")?" -> " on[$1]:""; printf "%-6s %-18s %-26s %-16s %-8s %s%s\n", $1, $2, $3, $4, $5, s, ex }' "$r"; }"#,
    "\n",
);

#[cfg(test)]
mod tests {

    #[test]
    fn bsc_checkpoint_rc_defines_hyphenated_helper_reading_the_doc_var() {
        // The helper keeps its hyphenated, user-facing name (so it can't be exported
        // into subshells — it must be *defined* via the rc file) and writes whatever
        // it gets on stdin to the doc named by $BSC_CHECKPOINT_DOC.
        let rc = super::BSC_CHECKPOINT_RC;
        assert!(rc.contains("bsc-checkpoint()"), "rc must define the hyphenated helper");
        assert!(rc.contains("$BSC_CHECKPOINT_DOC"), "rc must target the doc env var");
        assert!(rc.contains("mkdir -p"), "rc must create the doc's parent dir");
    }

    #[test]
    fn bsc_checkpoint_helper_runs_in_a_fresh_non_interactive_subshell() {
        // Regression: the helper was only defined in the interactive PTY shell, so the
        // agent's own `bash -c` subprocesses (Claude's Bash tool) couldn't find it.
        // The rc file + BASH_ENV mechanism must make a fresh, non-interactive bash able
        // to run `bsc-checkpoint` and write the doc. Skips where bash isn't on PATH.
        use std::io::Write;
        use std::process::{Command, Stdio};

        // Resolve the SAME shell the PTY launches (Git Bash on Windows, never the WSL
        // System32 stub — which can't read a /c/... BASH_ENV path). A bare `bash` would
        // resolve via PATH and may hit that stub, failing for reasons unrelated to the fix.
        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_checkpoint subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-ckpt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_CHECKPOINT_RC).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the doc's parent.
        let doc = dir.join("nested").join("checkpoint.md");

        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let doc_bash = crate::to_bash_path(&doc.to_string_lossy());

        let mut child = Command::new(&shell)
            .arg("-c")
            .arg("bsc-checkpoint")
            .env("BASH_ENV", &rc_bash)
            .env("BSC_CHECKPOINT_DOC", &doc_bash)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        child.stdin.take().unwrap().write_all(b"left off: step 3\n").unwrap();
        assert!(child.wait().unwrap().success(), "bsc-checkpoint should run in the subshell");

        assert_eq!(std::fs::read_to_string(&doc).unwrap(), "left off: step 3\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_decisions_rc_defines_note_and_blocked_helpers() {
        // The fleet assume-and-log helpers keep their hyphenated names (defined via the
        // rc file, like bsc-checkpoint) and append to the doc named by the env var.
        let rc = super::BSC_DECISIONS_RC;
        assert!(rc.contains("bsc-note()"), "rc must define bsc-note");
        assert!(rc.contains("bsc-blocked()"), "rc must define bsc-blocked");
        assert!(rc.contains("BSC_DECISIONS_DOC"), "helpers must target the decisions doc env var");
    }

    #[test]
    fn bsc_coord_emit_rc_defines_issuer_helpers() {
        // The issuer flow (#376) adds two emitters to the coord-emit rc; they carry more
        // columns than `__bsc_coord`, so they go through `__bsc_coord_log` with a
        // pre-tab-joined payload. coordination.ts `parseCoordLine` reads them back.
        let rc = super::BSC_COORD_EMIT_RC;
        assert!(rc.contains("bsc-issue()"), "rc must define bsc-issue");
        assert!(rc.contains("bsc-assign()"), "rc must define bsc-assign");
        assert!(rc.contains("__bsc_coord_log()"), "rc must define the multi-column log helper");
    }

    #[test]
    fn bsc_issue_and_assign_emit_tab_aligned_coord_lines() {
        // bsc-issue / bsc-assign must run from the agent's own `bash -c` subshells (rc +
        // BASH_ENV) and append ONE tab-separated line to $BSC_COORD_LOG whose columns match
        // what coordination.ts parseCoordLine expects:
        //   issue:  ts \t pane \t issue  \t title  \t body \t suggested \t id
        //   assign: ts \t pane \t assign \t target \t body \t issueId   \t title
        // Multi-word values arrive via flags; the body is read from stdin. Skips where bash
        // isn't on PATH (same gating as the other helper-run tests).
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc issuer-emit subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-issuer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_COORD_EMIT_RC).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the log's parent.
        let log = dir.join("nested").join("coord.log");

        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let log_bash = crate::to_bash_path(&log.to_string_lossy());

        let run = |cmd: &str, body: &str| {
            let mut child = Command::new(&shell)
                .arg("-c").arg(cmd)
                .env("BASH_ENV", &rc_bash)
                .env("BSC_COORD_LOG", &log_bash)
                .env("BSC_AUDIT_PANE", "t0p3")
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            child.stdin.take().unwrap().write_all(body.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success(), "{cmd} should run in the subshell");
        };
        run("bsc-issue --title 'Retry uploads' --suggested owner/web --id 412", "add a retry to the upload path");
        run("bsc-assign t0p1 --issue 412 --title 'Retry uploads'", "do the retry work");

        let text = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<&str> = text.lines().filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2, "expected one line per emitter, got: {text:?}");

        let issue: Vec<&str> = lines[0].split('\t').collect();
        assert_eq!(issue[1], "t0p3", "pane column");
        assert_eq!(&issue[2..], &["issue", "Retry uploads", "add a retry to the upload path", "owner/web", "412"]);

        let assign: Vec<&str> = lines[1].split('\t').collect();
        assert_eq!(assign[1], "t0p3", "pane column");
        assert_eq!(&assign[2..], &["assign", "t0p1", "do the retry work", "412", "Retry uploads"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_fleet_joins_roster_with_coord_state() {
        // bsc-fleet (#734): the director's roster view. Joins fleet.roster.tsv with each
        // session's latest own-state event in coord.log → PANE/stream/repo/branch/role/STATE.
        use std::process::{Command, Stdio};
        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc-fleet test: no usable bash ({shell})");
            return;
        }
        let dir = std::env::temp_dir().join(format!("bsc-fleet-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_FLEET_RC).unwrap();
        let roster = dir.join("fleet.roster.tsv");
        std::fs::write(&roster,
            "t0p0\tdirector\t-\t-\tdirector\n\
             t0p1\tplanner-ux\to/r\tplanner-ux\tworker\n\
             t0p2\tpty-readiness\to/r\tpty-readiness\tworker\n\
             t0p3\textensions\to/r\textensions\tworker\n").unwrap();
        let log = dir.join("coord.log");
        std::fs::write(&log,
            "2026-01-01T00:00:00Z\tt0p1\tblocked\tcontract:Auth\tcp\n\
             2026-01-01T00:01:00Z\tt0p2\task\tshould I merge?\tcp\n\
             2026-01-01T00:02:00Z\tt0p3\twoke\n").unwrap();

        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let roster_bash = crate::to_bash_path(&roster.to_string_lossy());
        let log_bash = crate::to_bash_path(&log.to_string_lossy());

        let out = Command::new(&shell).arg("-c").arg("bsc-fleet")
            .env("BASH_ENV", &rc_bash)
            .env("BSC_FLEET_ROSTER", &roster_bash)
            .env("BSC_COORD_LOG", &log_bash)
            .stdin(Stdio::null()).output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "bsc-fleet should run: {text}");
        // a blocked worker shows blocked + what it's blocked on
        let l1 = text.lines().find(|l| l.starts_with("t0p1")).unwrap_or("");
        assert!(l1.contains("blocked") && l1.contains("contract:Auth"), "blocked: {l1:?}");
        // an asking worker shows ask + the question
        let l2 = text.lines().find(|l| l.starts_with("t0p2")).unwrap_or("");
        assert!(l2.contains("ask") && l2.contains("should I merge?"), "ask: {l2:?}");
        // a freshly-woken worker reads as active; a session with no events is idle
        assert!(text.lines().find(|l| l.starts_with("t0p3")).unwrap_or("").contains("active"), "woke→active: {text}");
        assert!(text.lines().find(|l| l.starts_with("t0p0")).unwrap_or("").contains("idle"), "director idle: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_bsc_rc_is_syntactically_valid_bash() {
        // Regression for the rc-glue bug: every rc constant must end with a newline so the
        // bsc-env.sh that pty_create writes keeps each helper on its own line. A missing
        // trailing newline glues two functions (`}bsc-audit()`) and bash reports "unexpected
        // end of file", breaking every agent subshell. `bash -n` over the FULL concatenation
        // (the exact format! pty_create uses) catches it; per-constant tests do not.
        use std::process::{Command, Stdio};
        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping full-rc syntax test: no usable bash ({shell})");
            return;
        }
        let rc_body = format!(
            "{}{}{}{}{}{}{}{}{}{}{}",
            super::BSC_CHECKPOINT_RC,
            super::BSC_DECISIONS_RC,
            super::BSC_AUDIT_RC,
            super::BSC_SKILL_RC,
            super::BSC_HOOK_RC,
            super::BSC_MCP_RC,
            super::BSC_TOKENS_RC,
            super::BSC_CONFINE_RC,
            super::BSC_COORD_EMIT_RC,
            super::BSC_DEFER_RC,
            super::BSC_FLEET_RC,
        );
        let dir = std::env::temp_dir().join(format!("bsc-rc-syntax-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, &rc_body).unwrap();
        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let out = Command::new(&shell).arg("-n").arg(&rc_bash).stderr(Stdio::piped()).output().unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            out.status.success(),
            "generated bsc-env.sh has a bash syntax error:
{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    #[test]
    fn bsc_note_appends_bulleted_lines_in_a_fresh_non_interactive_subshell() {
        // Like bsc-checkpoint, bsc-note must work from the agent's own `bash -c`
        // subshells via the rc file + BASH_ENV. Each call APPENDS one bulleted line read
        // from stdin to $BSC_DECISIONS_DOC. Skips where bash isn't on PATH.
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_note subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-note-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        // The installed rc is the checkpoint + decisions helpers concatenated.
        std::fs::write(&rc, format!("{}{}", super::BSC_CHECKPOINT_RC, super::BSC_DECISIONS_RC)).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the doc's parent.
        let doc = dir.join("nested").join("DECISIONS.md");

        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let doc_bash = crate::to_bash_path(&doc.to_string_lossy());

        let run = |msg: &str| {
            let mut child = Command::new(&shell)
                .arg("-c").arg("bsc-note")
                .env("BASH_ENV", &rc_bash)
                .env("BSC_DECISIONS_DOC", &doc_bash)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            child.stdin.take().unwrap().write_all(msg.as_bytes()).unwrap();
            assert!(child.wait().unwrap().success(), "bsc-note should run in the subshell");
        };
        run("chose cursor pagination");
        run("used JWT for auth");

        assert_eq!(
            std::fs::read_to_string(&doc).unwrap(),
            "- chose cursor pagination\n- used JWT for auth\n",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_skill_helper_appends_a_usage_line() {
        // Like bsc-audit, bsc-skill must work from the agent's own `bash -c` subshells via
        // the rc file + BASH_ENV. It reads the Skill hook JSON on stdin and appends one
        // TSV line — `ts \t pane \t event \t skill` — to $BSC_SKILL_LOG. Skips where bash
        // isn't on PATH (same gating as the other helper-run tests).
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_skill subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-skill-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_SKILL_RC).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the log's parent.
        let log = dir.join("nested").join("skills.log");

        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let log_bash = crate::to_bash_path(&log.to_string_lossy());

        let mut child = Command::new(&shell)
            .arg("-c").arg("bsc-skill")
            .env("BASH_ENV", &rc_bash)
            .env("BSC_SKILL_LOG", &log_bash)
            .env("BSC_AUDIT_PANE", "t0p1")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        child.stdin.take().unwrap()
            .write_all(br#"{"hook_event_name":"PreToolUse","tool_name":"Skill","tool_input":{"skill_name":"open-a-clean-pr","prompt":"..."}}"#)
            .unwrap();
        assert!(child.wait().unwrap().success(), "bsc-skill should run in the subshell");

        let line = std::fs::read_to_string(&log).unwrap();
        let line = line.trim_end();
        let fields: Vec<&str> = line.split('\t').collect();
        assert_eq!(fields.len(), 4, "expected 4 TAB-separated fields, got: {line:?}");
        assert_eq!(fields[1], "t0p1", "pane field should be the BSC_AUDIT_PANE tag");
        assert_eq!(fields[2], "PreToolUse", "event field should be hook_event_name");
        assert_eq!(fields[3], "open-a-clean-pr", "skill field should be skill_name");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_hook_runs_the_command_logs_outcome_and_propagates_exit() {
        // bsc-hook wraps a USER hook: it runs the command, logs `ts \t event \t name \t
        // outcome` to $BSC_HOOK_LOG, and propagates the command's exit code so a PreToolUse
        // block (exit 2) still takes effect. Skips where bash isn't on PATH.
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_hook subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-hook-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_HOOK_RC).unwrap();
        let log = dir.join("nested").join("hooks.log");
        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let log_bash = crate::to_bash_path(&log.to_string_lossy());

        // Run a helper: a PreToolUse hook whose command exits with `code`, fed JSON on stdin.
        let run = |code: i32, event: &str| -> std::process::ExitStatus {
            let mut child = Command::new(&shell)
                .arg("-c").arg(format!("bsc-hook 'Block PII' 'exit {code}'"))
                .env("BASH_ENV", &rc_bash)
                .env("BSC_HOOK_LOG", &log_bash)
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            child.stdin.take().unwrap()
                .write_all(format!(r#"{{"hook_event_name":"{event}","tool_name":"Write"}}"#).as_bytes())
                .unwrap();
            child.wait().unwrap()
        };

        // PreToolUse + exit 2 → propagated exit 2, outcome "block".
        let st = run(2, "PreToolUse");
        assert_eq!(st.code(), Some(2), "exit code must propagate so the block takes effect");
        // PreToolUse + exit 0 → outcome "allow".
        assert!(run(0, "PreToolUse").success());
        // PostToolUse → outcome "ok" regardless of code semantics.
        assert!(run(0, "PostToolUse").success());

        let body = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<Vec<&str>> = body.lines().map(|l| l.split('\t').collect()).collect();
        assert_eq!(lines.len(), 3, "one line per fire: {body:?}");
        // Each line: ts(epoch-ms) \t event \t name \t outcome.
        assert!(lines[0][0].chars().all(|c| c.is_ascii_digit()), "ts is epoch ms: {:?}", lines[0][0]);
        assert_eq!((lines[0][1], lines[0][2], lines[0][3]), ("PreToolUse", "Block PII", "block"));
        assert_eq!(lines[1][3], "allow");
        assert_eq!(lines[2][3], "ok");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_mcp_pairs_pre_post_and_logs_latency_and_outcome() {
        // bsc-mcp logs one line per MCP call: PreToolUse stamps a start; PostToolUse computes
        // `ms` and the outcome and appends `ts \t server \t tool \t outcome \t ms \t detail`.
        // Non-MCP tools and a lone PreToolUse write nothing. Skips where bash isn't on PATH.
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_mcp subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_MCP_RC).unwrap();
        let log = dir.join("nested").join("mcp.log");
        let tmp = dir.join("tmp");
        std::fs::create_dir_all(&tmp).unwrap();
        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let log_bash = crate::to_bash_path(&log.to_string_lossy());
        let tmp_bash = crate::to_bash_path(&tmp.to_string_lossy());

        // Feed one hook-JSON payload to bsc-mcp.
        let fire = |json: &str| {
            let mut child = Command::new(&shell)
                .arg("-c").arg("bsc-mcp")
                .env("BASH_ENV", &rc_bash)
                .env("BSC_MCP_LOG", &log_bash)
                .env("TMPDIR", &tmp_bash)
                .env("BSC_AUDIT_PANE", "t0p0")
                .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
                .spawn().unwrap();
            child.stdin.take().unwrap().write_all(json.as_bytes()).unwrap();
            child.wait().unwrap();
        };

        // A non-MCP tool is ignored entirely.
        fire(r#"{"hook_event_name":"PreToolUse","tool_name":"Write"}"#);
        // A full MCP call: Pre then Post (success).
        fire(r#"{"hook_event_name":"PreToolUse","tool_name":"mcp__github__list_issues"}"#);
        fire(r#"{"hook_event_name":"PostToolUse","tool_name":"mcp__github__list_issues","tool_response":{"isError":false}}"#);
        // A failed MCP call (isError true) → outcome "fail".
        fire(r#"{"hook_event_name":"PreToolUse","tool_name":"mcp__playwright__navigate"}"#);
        fire(r#"{"hook_event_name":"PostToolUse","tool_name":"mcp__playwright__navigate","tool_response":{"isError":true,"content":[{"type":"text","text":"spawn npx ENOENT"}]}}"#);

        let body = std::fs::read_to_string(&log).unwrap();
        let lines: Vec<Vec<&str>> = body.lines().map(|l| l.split('\t').collect()).collect();
        assert_eq!(lines.len(), 2, "only the two completed MCP calls log (lone Pre + non-MCP write nothing): {body:?}");
        // ts(epoch-ms) \t server \t tool \t outcome \t ms \t detail
        assert!(lines[0][0].chars().all(|c| c.is_ascii_digit()), "ts is epoch ms: {:?}", lines[0][0]);
        assert_eq!((lines[0][1], lines[0][2]), ("github", "list_issues"));
        // A non-error response is a success — "ok", or "warn" if the measured round-trip (which
        // here includes cold subprocess-spawn overhead in the test harness) crossed the slow
        // threshold. Never "fail" without an error response.
        assert!(matches!(lines[0][3], "ok" | "warn"), "success outcome: {:?}", lines[0][3]);
        assert!(lines[0][4].chars().all(|c| c.is_ascii_digit()), "ms is numeric: {:?}", lines[0][4]);
        assert_eq!((lines[1][1], lines[1][2], lines[1][3]), ("playwright", "navigate", "fail"));
        assert_eq!(lines[1][5], "spawn npx ENOENT", "fail detail pulled from the response text");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn bsc_tokens_helper_appends_a_session_line() {
        // Like bsc-skill, bsc-tokens must work from the agent's own `bash -c` subshells
        // via the rc file + BASH_ENV. It reads the Stop-hook JSON on stdin and appends one
        // TSV line — `ts \t pane \t session_id \t transcript_path` — to $BSC_TOKENS_LOG.
        // The transcript path is preserved VERBATIM (JSON-escaped) so read_token_usage can
        // decode it. Skips where bash isn't on PATH (same gating as the other helper tests).
        use std::io::Write;
        use std::process::{Command, Stdio};

        let shell = crate::shell::resolve_shell();
        let usable = Command::new(&shell).arg("--version").output().map(|o| o.status.success()).unwrap_or(false);
        if !usable {
            eprintln!("skipping bsc_tokens subshell test: no usable bash ({shell})");
            return;
        }

        let dir = std::env::temp_dir().join(format!("bsc-tokens-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let rc = dir.join("bsc-env.sh");
        std::fs::write(&rc, super::BSC_TOKENS_RC).unwrap();
        // Nested path exercises the helper's `mkdir -p` of the log's parent.
        let log = dir.join("nested").join("tokens.log");

        let rc_bash = crate::to_bash_path(&rc.to_string_lossy());
        let log_bash = crate::to_bash_path(&log.to_string_lossy());

        let mut child = Command::new(&shell)
            .arg("-c").arg("bsc-tokens")
            .env("BASH_ENV", &rc_bash)
            .env("BSC_TOKENS_LOG", &log_bash)
            .env("BSC_AUDIT_PANE", "t1p2")
            .stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null())
            .spawn().unwrap();
        // A Windows-style transcript path with JSON-escaped backslashes — the helper must
        // keep them verbatim for read_token_usage's json_unescape_path to decode.
        child.stdin.take().unwrap()
            .write_all(br#"{"hook_event_name":"Stop","session_id":"abc-123","transcript_path":"C:\\Users\\k\\.claude\\projects\\p\\abc-123.jsonl","cwd":"C:\\repo"}"#)
            .unwrap();
        assert!(child.wait().unwrap().success(), "bsc-tokens should run in the subshell");

        let line = std::fs::read_to_string(&log).unwrap();
        let line = line.trim_end();
        let fields: Vec<&str> = line.split('\t').collect();
        assert_eq!(fields.len(), 4, "expected 4 TAB-separated fields, got: {line:?}");
        assert_eq!(fields[1], "t1p2", "pane field should be the BSC_AUDIT_PANE tag");
        assert_eq!(fields[2], "abc-123", "session_id field should be parsed");
        assert_eq!(
            fields[3], r"C:\\Users\\k\\.claude\\projects\\p\\abc-123.jsonl",
            "transcript_path should be preserved verbatim (still JSON-escaped)"
        );
        // And the verbatim field decodes to a native Windows path.
        assert_eq!(
            crate::tokens::json_unescape_path(fields[3]),
            r"C:\Users\k\.claude\projects\p\abc-123.jsonl",
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}

