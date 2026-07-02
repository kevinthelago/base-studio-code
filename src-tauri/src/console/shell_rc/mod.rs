// bsc-* shell helpers (#199/#257/#406/#416/#734): the rc-file fragments installed
// into every session via BASH_ENV (extracted from lib.rs, #758).
//
// WARNING: each rc constant MUST end with a trailing newline or the concatenated
// helper functions glue together and the whole rc breaks with a bash syntax error
// (#296) — the full_bsc_rc_is_syntactically_valid_bash test guards this.

/// Shared sh helper fragments (#2064): the three fragile shell fragments the `bsc-*`
/// helpers repeated (the JSON string-field extractor ~12×, the epoch-ms timestamp
/// fallback verbatim 4×, and the `mkdir -p` + append-line log tail ~10×) — defined ONCE
/// here and prepended as the FIRST entry of `ALL_BSC_RC`, so every helper below calls
/// them instead of re-inlining the fragment (a drift used to be caught only by eye):
/// * `__bsc_jstr <field-ere>` — reads a JSON blob on stdin and prints the value of the
///   first `"<field>": "…"` string field (the `grep -oE … | head -1 | sed -E …` core).
///   `<field-ere>` is an ERE alternation, so `__bsc_jstr 'command|file_path|…'` works.
/// * `__bsc_now_ms` — prints epoch-milliseconds with the portable `date +%s%3N` →
///   `date -u +%s` × 1000 fallback (for platforms whose `date` lacks `%3N`).
/// * `__bsc_logline <file> <printf-fmt> [args…]` — makes the file's parent dir and
///   appends the `printf`-formatted line (the `mkdir -p "$(dirname …)"; printf … >> "$f"`
///   tail). The format is a literal passed by the caller, so data still flows through
///   `%s` exactly as before. Each helper keeps its own inline log-GUARD
///   (`[ -z "$l" ] && return 0`) since a function can't `return` from its caller.
///
/// A raw string keeps the embedded quotes/regex readable; the mandatory trailing `"\n"`
/// (#296) after the last function keeps the concat one-function-per-line. Because the
/// helpers below now depend on these, a per-helper subshell test that installs a single
/// `BSC_*_RC` fragment must also install this one (see the tests).
pub(crate) const BSC_SHARED_RC: &str = concat!(
    r#"__bsc_jstr() { grep -oE "\"($1)\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -1 | sed -E 's/.*"([^"]*)"$/\1/'; }
__bsc_now_ms() { n="$(date +%s%3N 2>/dev/null)"; case "$n" in ''|*[!0-9]*) n="$(( $(date -u +%s) * 1000 ))" ;; esac; printf '%s' "$n"; }
__bsc_logline() { f="$1"; fmt="$2"; shift 2; mkdir -p "$(dirname "$f")" 2>/dev/null; printf "$fmt" "$@" >> "$f"; }"#,
    "\n",
);

/// The `bsc` shell helper (#1877): the ONE compiled-binary helper. The app ships a single umbrella
/// binary that dispatches every state CLI as a subcommand (`bsc plan …`, `bsc skill …`, `bsc logs …`,
/// `bsc data …`, `bsc compliance …`, `bsc blueprint …`, `bsc project …`, `bsc files …`, `bsc mcp …`).
/// This function execs the absolute-path binary in `$BSC_BIN` (set per-session in `pty_create`,
/// alongside the per-store env like `$BSC_PLAN_DB`/`$BSC_DATA_DB`) — no PATH changes, no copies. It
/// errors `127` on a missing/0-byte staged stub and otherwise execs `$BSC_BIN`, falling back to a bare
/// `bsc` on PATH when the var is unset (e.g. the test target where the sidecar isn't staged). The
/// mandatory trailing `"\n"` is the #296 glue contract. Replaced the eight per-CLI `bsc-*` helpers
/// (`bsc-plan`/`bsc-data`/… each execing its own `$BSC_*_BIN`) that #1843 had funneled through a macro.
pub(crate) const BSC_RC: &str =
    "bsc() { if [ -n \"${BSC_BIN:-}\" ] && [ ! -s \"$BSC_BIN\" ]; then echo \"bsc: BSC_BIN ($BSC_BIN) is missing or a 0-byte stub; rebuild the sidecars with 'npm run build:plan'\" >&2; return 127; fi; \"${BSC_BIN:-bsc}\" \"$@\"; }\n";

/// The `bsc-checkpoint` helper: reads stdin and overwrites the per-repo checkpoint
/// doc named by `$BSC_CHECKPOINT_DOC` (creating its parent dir). Installed via an rc
/// file + `BASH_ENV` so it's reachable from the agent's non-interactive `bash -c`
/// subshells, not just the interactive PTY shell. The hyphenated name can't be
/// `export -f`'d — bash refuses to import functions whose names aren't valid
/// identifiers (post-Shellshock) — so it must be *defined* in each subshell.
pub(crate) const BSC_CHECKPOINT_RC: &str =
    "bsc-checkpoint() { mkdir -p \"$(dirname \"$BSC_CHECKPOINT_DOC\")\" 2>/dev/null; cat > \"$BSC_CHECKPOINT_DOC\"; }\n";

/// The `bsc-note` helper: append a one-line entry read from stdin to the assume-and-log journal
/// named by `$BSC_DECISIONS_DOC` (default: a `DECISIONS.md` in the session's cwd, creating its
/// parent dir). Fleet workers use it to record a reversible decision and keep moving instead of
/// stalling on a human. Same rc + `BASH_ENV` install path as bsc-checkpoint, so the agent's
/// non-interactive Bash subshells can call it.
///
/// (#1039) The `bsc-blocked --on <ref>` dependency-WAIT helper was removed: planning already defines
/// the integration contracts/seams between streams, so a worker builds against the contract IN
/// PARALLEL rather than parking until an upstream lands. A worker that genuinely needs a decision
/// defers to the director via `bsc-ask` (which is answered + resumes it); it never blocks on a dep.
pub(crate) const BSC_DECISIONS_RC: &str =
    // Provenance (#1167): tag each entry with the writing session (`- [<pane>] …`) so a note from
    // ANOTHER agent is attributable and a reader can treat a cross-session note as untrusted data,
    // not an instruction (the internal injection channel). `printf '%s' "…"` (not `printf "- …"`):
    // a format starting with `-` is parsed as an option flag and the prefix is silently dropped.
    "bsc-note() { d=\"${BSC_DECISIONS_DOC:-$PWD/DECISIONS.md}\"; mkdir -p \"$(dirname \"$d\")\" 2>/dev/null; { printf '%s' \"- [${BSC_AUDIT_PANE:-?}] \"; cat; printf '\\n'; } >> \"$d\"; }\n";

/// The `bsc-audit` helper (#257): the PreToolUse hook on a gated pane pipes Claude
/// Code's tool JSON into this; it extracts ONLY the tool name + a short target field
/// (never `content`/`new_string`, so file contents / secrets aren't written) and
/// appends one TAB-separated line — `ts \t pane \t toolName \t target` — to the
/// app-wide `$BSC_AUDIT_LOG`, tagged with `$BSC_AUDIT_PANE`. Best-effort + always exits
/// 0 so it never blocks a tool. A raw string keeps the embedded quotes/regex readable.
pub(crate) const BSC_AUDIT_RC: &str = concat!(
    r#"bsc-audit() { l="${BSC_AUDIT_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat)"; tn="$(printf '%s' "$j" | __bsc_jstr tool_name)"; tg="$(printf '%s' "$j" | __bsc_jstr 'command|file_path|notebook_path|url|query|pattern|path|description' | tr '\t\n' '  ' | cut -c1-160)"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$tn" "$tg"; return 0; }"#,
    "\n",
);

/// The `bsc-skill` helper — one name, two roles, dispatched on argument count:
///
/// * **With a subcommand** (`bsc-skill list` / `add` / `group …` / `resolve …`, #1338): the global
///   skills-library CLI. Execs the unified `bsc` binary's `skill` subcommand (`"$BSC_BIN" skill …`,
///   an absolute path — invoking it directly, NOT the bare name, so it never recurses into this
///   function) against the one global skills.db (`$BSC_SKILL_DB`). This is the #1325 runtime surface:
///   any live session can read/author skills + task-groups from its own shell. If `$BSC_BIN` is unset
///   (no sidecar staged) it errors rather than falling back to a bare `bsc-skill` (which would
///   re-enter this function). (#1877: one `bsc` binary replaced the per-CLI `$BSC_SKILL_BIN`; this
///   `bsc-skill` name is kept as the no-arg telemetry hook + a back-compat alias for `bsc skill`.)
/// * **With no arguments** (#406): the original Skill-tool telemetry hook. A PreToolUse/PostToolUse
///   hook pipes Claude Code's hook JSON into this on stdin; it extracts ONLY the skill name
///   (`skill_name`) + the hook event (`hook_event_name`) and appends one TAB-separated line —
///   `ts \t pane \t event \t skill` — to the app-wide `$BSC_SKILL_LOG`, tagged with `$BSC_AUDIT_PANE`.
///   The name/event are sanitized like bsc-audit's target (strip tabs/newlines, cap length) so a
///   stray char can't corrupt the TSV. Best-effort + always exits 0 so it never blocks a tool.
///
/// Claude Code always fires the hook with NO args (data arrives on stdin), so argc is a reliable
/// discriminator. A raw string keeps the embedded quotes/regex readable.
pub(crate) const BSC_SKILL_RC: &str = concat!(
    r#"bsc-skill() { if [ "$#" -gt 0 ]; then b="${BSC_BIN:-}"; if [ -n "$b" ]; then "$b" skill "$@"; return $?; fi; echo "bsc-skill: library CLI unavailable (BSC_BIN unset)" >&2; return 127; fi; l="${BSC_SKILL_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat)"; sn="$(printf '%s' "$j" | tr '\t\n' '  ' | __bsc_jstr skill_name | cut -c1-120)"; ev="$(printf '%s' "$j" | tr '\t\n' '  ' | __bsc_jstr hook_event_name | cut -c1-120)"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$ev" "$sn"; return 0; }"#,
    "\n",
);

/// The `bsc-hook` wrapper (#867 follow-up — hook-fire logging): a USER hook (configured in
/// the Hooks UI) is written to settings.json wrapped as `bsc-hook '<name>' '<command>'` (the
/// frontend `toHookPayload` does the single-quote escaping). It reads Claude Code's hook JSON
/// from stdin, RUNS the user's command (re-piping that JSON to it), captures its exit code,
/// and appends one TAB line — `ts \t pane \t event \t name \t outcome` — to `$BSC_HOOK_LOG` for
/// the Hook Analytics tab, tagged with `$BSC_AUDIT_PANE` so the fire attributes to its session
/// (#1743). `ts` is epoch ms (matches `hookTelemetry.parseHookLog`). `outcome` is
/// "block" when a PreToolUse command exits 2 (Claude Code's deny convention), "allow"
/// otherwise for PreToolUse, "ok" for other events. The user's exit code is PROPAGATED so a
/// block still takes effect. Only USER hooks are wrapped; the security hooks (bsc-confine /
/// bsc-audit) are never routed through here. A raw string keeps the embedded quotes readable.
pub(crate) const BSC_HOOK_RC: &str = concat!(
    r#"bsc-hook() { nm="$1"; cmd="$2"; j="$(cat)"; printf '%s' "$j" | sh -c "$cmd"; code=$?; l="${BSC_HOOK_LOG:-}"; if [ -n "$l" ]; then ev="$(printf '%s' "$j" | tr '\t\n' '  ' | __bsc_jstr hook_event_name | cut -c1-60)"; [ -z "$ev" ] && ev="?"; oc="ok"; if [ "$ev" = "PreToolUse" ]; then if [ "$code" -eq 2 ]; then oc="block"; else oc="allow"; fi; fi; nm="$(printf '%s' "$nm" | tr '\t\n' '  ' | cut -c1-80)"; ts="$(date -u +%s)000"; __bsc_logline "$l" '%s\t%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$ev" "$nm" "$oc"; fi; exit "$code"; }"#,
    "\n",
);

/// The `bsc-mcp` helper (#879 PR 2 — MCP-call logging): a PreToolUse + PostToolUse hook on a
/// gated pane, matched to MCP tools (`mcp__<server>__<tool>`). It measures the round-trip
/// latency of each MCP call and logs one TAB line — `ts \t pane \t server \t tool \t outcome \t
/// ms \t detail` — to `$BSC_MCP_LOG` for the MCP Analytics tab, tagged with `$BSC_AUDIT_PANE` so
/// the call attributes to its session (#1743). `ts` is epoch ms (matches
/// `mcpTelemetry.parseMcpLog`). PreToolUse stamps a start time keyed by pane+tool under a temp
/// dir; PostToolUse reads it back, computes `ms = now − start`, derives the outcome (`fail` when
/// the tool response carries `isError/is_error: true`, `warn` when rate-limited or slower than
/// `$BSC_MCP_SLOW_MS` (default 2000ms), else `ok`), and appends the line. Non-MCP tools are
/// ignored. Best-effort + always returns 0 so it never blocks a tool. A raw string keeps the
/// embedded quotes/regex readable.
pub(crate) const BSC_MCP_RC: &str = concat!(
    r#"bsc-mcp() { l="${BSC_MCP_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat | tr '\t\n' '  ')"; now="$(__bsc_now_ms)"; tn="$(printf '%s' "$j" | __bsc_jstr tool_name)"; case "$tn" in mcp__*) ;; *) return 0 ;; esac; ev="$(printf '%s' "$j" | __bsc_jstr hook_event_name)"; rest="${tn#mcp__}"; server="${rest%%__*}"; tool="${rest#*__}"; d="${TMPDIR:-/tmp}/bsc-mcp"; mkdir -p "$d" 2>/dev/null; key="$(printf '%s_%s' "${BSC_AUDIT_PANE:-x}" "$tn" | tr -c 'A-Za-z0-9_-' '_' | cut -c1-150)"; if [ "$ev" = "PreToolUse" ]; then printf '%s' "$now" > "$d/$key" 2>/dev/null; return 0; fi; start="$(cat "$d/$key" 2>/dev/null)"; rm -f "$d/$key" 2>/dev/null; ms=0; case "$start" in *[0-9]*) ms=$(( now - start )) ;; esac; [ "$ms" -lt 0 ] && ms=0; oc="ok"; detail=""; if printf '%s' "$j" | grep -qE '"(is_error|isError)"[[:space:]]*:[[:space:]]*true'; then oc="fail"; detail="$(printf '%s' "$j" | __bsc_jstr 'text|message|error' | cut -c1-100)"; [ -z "$detail" ] && detail="error"; elif printf '%s' "$j" | grep -qiE 'rate.?limit'; then oc="warn"; detail="rate-limited"; elif [ "$ms" -gt "${BSC_MCP_SLOW_MS:-2000}" ]; then oc="warn"; detail="slow"; fi; server="$(printf '%s' "$server" | cut -c1-60)"; tool="$(printf '%s' "$tool" | cut -c1-60)"; detail="$(printf '%s' "$detail" | cut -c1-120)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$now" "${BSC_AUDIT_PANE:-?}" "$server" "$tool" "$oc" "$ms" "$detail"; return 0; }"#,
    "\n",
);

/// The `bsc-tokens` helper (#416): a Stop / SubagentStop hook on a gated pane pipes
/// Claude Code's hook JSON into this; it extracts the `session_id` and `transcript_path`
/// (Claude Code's hooks carry these but NOT token usage, so the transcript is the only
/// per-session source) and appends one TAB-separated line — `ts \t pane \t session_id \t
/// transcript_path` — to the app-wide `$BSC_TOKENS_LOG`, tagged with `$BSC_AUDIT_PANE`.
/// The session id is sanitized like bsc-skill's fields (strip tabs/newlines, cap length);
/// the transcript path is left verbatim (a JSON-escaped native path) for the token-usage reader
/// (`bsc logs cost`) to decode + parse. Best-effort + always exits 0 so it never blocks a stop. A raw string
/// keeps the embedded quotes/regex readable.
pub(crate) const BSC_TOKENS_RC: &str = concat!(
    r#"bsc-tokens() { l="${BSC_TOKENS_LOG:-}"; [ -z "$l" ] && return 0; j="$(cat | tr '\t\n' '  ')"; sid="$(printf '%s' "$j" | __bsc_jstr session_id | cut -c1-120)"; tp="$(printf '%s' "$j" | grep -oE '"transcript_path"[[:space:]]*:[[:space:]]*"([^"\\]|\\.)*"' | head -1 | sed -E 's/^"transcript_path"[[:space:]]*:[[:space:]]*"(.*)"$/\1/')"; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$sid" "$tp"; return 0; }"#,
    "\n",
);

/// The `bsc-activity` helper (#1184): turn-boundary signal for the console status dot. Wired as
/// two hooks on every claude-launching pane — `bsc-activity run` on `UserPromptSubmit` (a turn
/// opens) and `bsc-activity idle` on `Stop` / `SubagentStop` (the turn closes). It drains the hook
/// JSON from stdin (so the hook never blocks on an unread pipe), then appends one TAB-separated
/// line — `ts \t pane \t state` — to the app-wide `$BSC_ACTIVITY_LOG`, tagged with `$BSC_AUDIT_PANE`.
/// `ts` is epoch ms (so `bsc logs pane-activity` orders prompt-vs-stop without timezone parsing). The
/// frontend polls the latest state per pane and GATES the silence timer: a pane whose last event is
/// `run` (turn still open) does not false-idle while a worker is thinking / running a long silent
/// tool call / backing off. Authoritative idle only ever comes from `Stop`. The state arg is
/// constrained to `run`/`idle` so a stray value can't corrupt the TSV (any other arg is dropped).
/// Best-effort + always exits 0 so it never blocks a prompt or a stop. A raw string keeps the
/// embedded quotes readable.
pub(crate) const BSC_ACTIVITY_RC: &str = concat!(
    r#"bsc-activity() { st="$1"; cat >/dev/null 2>&1; l="${BSC_ACTIVITY_LOG:-}"; [ -z "$l" ] && return 0; case "$st" in run|idle) ;; *) return 0 ;; esac; ts="$(__bsc_now_ms)"; __bsc_logline "$l" '%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$st"; return 0; }"#,
    "\n",
);

/// The `bsc-done` helper (#1379): a fleet WORKER calls this to CLOSE its own console once its owned
/// work is complete (the close-nudge tells it to). It appends one line — `ts \t pane` — to the
/// app-wide `$BSC_DONE_LOG`, tagged with `$BSC_AUDIT_PANE`. The frontend polls it (`bsc logs done-panes`)
/// and, for a worker that self-reported done, classifies the resting state from plan.db (NOT this
/// say-so) and reaps the pane (`markPaneEnded` + `pty_kill`). Drains stdin so a piped reason can't
/// block; best-effort + always exits 0.
pub(crate) const BSC_DONE_RC: &str = concat!(
    r#"bsc-done() { cat >/dev/null 2>&1; l="${BSC_DONE_LOG:-}"; [ -z "$l" ] && return 0; ts="$(__bsc_now_ms)"; __bsc_logline "$l" '%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}"; return 0; }"#,
    "\n",
);

/// The `bsc-confine` helper (#158/#1916): the DEFAULT PreToolUse hook for the file tools on every
/// claude-launching pane. It reads Claude Code's tool JSON, extracts the target `file_path` /
/// `notebook_path`, and BLOCKS (return 2 + stderr) when the path (1) escapes the session's repo root
/// (`$BSC_REPO_ROOT`) — any `..` segment, or an absolute path not under the root — or (2) is the
/// session's own `.claude/` config (the hook list + permissions): an in-repo path the escape check
/// passes, but one an agent must never edit to disable confinement, so it's blocked too (#1916
/// config-protection, the hook form of the `permissions.deny` rule that `bypassPermissions` ignores).
/// Mirrors `isPathConfined` / `isConfigProtected` in `src/shared/lib/session/fsConfine.ts` (the
/// unit-tested decision). String-based + no realpath so it's portable; `return 2` (not `exit`) so it
/// never kills a shell that sources it. Covers the AI's file tools only — Bash needs OS-level sandboxing.
/// The `__bsc_perm` helper (#1607 slice 2): appends one pane-tagged permission-denial row —
/// `ts·pane·gate·verdict·target·reason` — to the app-wide `$BSC_PERM_LOG`, so a block by the deny
/// hooks (`bsc-confine`/`bsc-scope` here; the Rust `bsc hook bash-deny` writes the same shape) is
/// visible to `bsc logs perm`/`session` and joinable to its session. Best-effort + always returns 0
/// (a failed log must never change the hook's block verdict). `$1`=gate `$2`=target `$3`=reason.
pub(crate) const BSC_PERM_RC: &str = concat!(
    r#"__bsc_perm() { l="${BSC_PERM_LOG:-}"; [ -z "$l" ] && return 0; ts="$(__bsc_now_ms)"; t="$(printf '%s' "$2" | tr '\t\n' '  ' | cut -c1-160)"; r="$(printf '%s' "$3" | tr '\t\n' '  ' | cut -c1-160)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1" "block" "$t" "$r"; return 0; }"#,
    "\n",
);

pub(crate) const BSC_CONFINE_RC: &str = concat!(
    r#"bsc-confine() { local root="${BSC_REPO_ROOT:-}"; [ -z "$root" ] && return 0; local j fp rel; j="$(cat)"; fp="$(printf '%s' "$j" | __bsc_jstr 'file_path|notebook_path')"; [ -z "$fp" ] && return 0; fp="${fp//\\//}"; fp="$(printf '%s' "$fp" | tr -s '/')"; rel="${fp#"$root"/}"; rel="${rel#./}"; case "$rel" in .claude|.claude/*) __bsc_perm confine "$fp" "config-protection (.claude)"; echo "blocked: '$fp' is the session's .claude config — #1916 config-protection" >&2; return 2 ;; esac; case "$fp" in ..|../*|*/../*|*/..) __bsc_perm confine "$fp" "leaves the repo root"; echo "blocked: '$fp' leaves the repo root ($root) — #158 FS confinement" >&2; return 2 ;; esac; case "$fp" in /*|~*|[A-Za-z]:*) case "$fp" in "$root"|"$root"/*) return 0 ;; *) __bsc_perm confine "$fp" "outside the repo root"; echo "blocked: '$fp' is outside the repo root ($root) — #158 FS confinement" >&2; return 2 ;; esac ;; esac; return 0; }"#,
    "\n",
);

/// The `bsc-scope` helper (#1297): a PreToolUse hook for the file-WRITE tools on a bounded-glob
/// pane. It reads Claude Code's tool JSON, extracts the target `file_path` / `notebook_path`, makes
/// it relative to the session root (`$BSC_REPO_ROOT`), and BLOCKS (return 2 + stderr) when the path
/// matches NONE of the pane's write globs (`$BSC_SCOPE_GLOBS`, space-separated). This is the hard
/// deny the role gate's allow-only `roleWriteRules` lacks: the planner (writeGlobs = plan files
/// only) can no longer be coaxed into writing `src/App.tsx` — that write is denied outright rather
/// than falling through to a prompt. Self-gating: an empty `$BSC_SCOPE_GLOBS` is a no-op, so it's
/// harmless to install on every gated pane. Mirrors `canWritePath` / `matchGlob` in
/// `src/lib/session/sessionRoles.ts`. `set -f` keeps `for g in $globs` from glob-expanding the
/// patterns against the cwd; `return 2` (not `exit`) so it never kills a shell that sources it.
/// Covers the AI's WRITE tools only (Read is unrestricted — the planner must read for context).
pub(crate) const BSC_SCOPE_RC: &str = concat!(
    r#"bsc-scope() { local globs="${BSC_SCOPE_GLOBS:-}"; [ "$globs" = "__bsc_deny_all__" ] && { __bsc_perm scope "" "code:none — no write scope"; echo "blocked: this session is code:none (no write scope) -- file writes are denied (#1916)" >&2; return 2; }; [ -z "$globs" ] && return 0; local root="${BSC_REPO_ROOT:-}"; local j fp g; j="$(cat)"; fp="$(printf '%s' "$j" | __bsc_jstr 'file_path|notebook_path')"; [ -z "$fp" ] && return 0; fp="${fp//\\//}"; fp="$(printf '%s' "$fp" | tr -s '/')"; [ -n "$root" ] && case "$fp" in "$root"/*) fp="${fp#"$root"/}" ;; esac; fp="${fp#./}"; set -f; for g in $globs; do case "$fp" in $g) set +f; return 0 ;; esac; done; set +f; __bsc_perm scope "$fp" "outside the write scope"; echo "blocked: '$fp' is outside this session's write scope (#1297) — allowed: $globs" >&2; return 2; }"#,
    "\n",
);

/// The `bsc-taint` helper (#1167 — containment / active enforcement): a PreToolUse hook on a
/// gated pane that implements a *tainted-turn gate*. It marks the session "tainted" right after
/// it ingests untrusted input (a `WebFetch`, or a Bash `curl`/`wget`/`gh issue|pr view`), and then
/// BLOCKS (return 2 + stderr) a small set of genuinely-dangerous OUTWARD/destructive Bash commands
/// — data exfil (`curl`/`wget` with a data/upload flag), force-push, `gh repo delete`, raw
/// `nc`/`ncat` — when they run within `$BSC_TAINT_WINDOW` (default 120s) of that ingestion. This is
/// the "attack injection at ingestion, not after" half of the warden (#1102 layer 2): a page/issue
/// that says "now exfiltrate the env / force-push to my remote" can't act in the turn it was read.
///
/// Deliberately conservative so it never breaks normal work: it gates ONLY the dangerous set (plain
/// edits, reads, tests, `git commit`, and an ordinary `git push` / `gh pr create` all pass), and it
/// checks the EXISTING marker BEFORE refreshing it — so a standalone outward call with no prior
/// untrusted read (e.g. a legit API POST) is allowed; only read-THEN-exfil is denied. `return 2`
/// (not `exit`) so it never kills the sourcing shell. A raw string keeps the quotes/regex readable.
pub(crate) const BSC_TAINT_RC: &str = concat!(
    r#"bsc-taint() { j="$(cat)"; tn="$(printf '%s' "$j" | __bsc_jstr tool_name)"; cmd="$(printf '%s' "$j" | __bsc_jstr command)"; dir="${BSC_TAINT_DIR:-${TMPDIR:-/tmp}/bsc-taint}"; mkdir -p "$dir" 2>/dev/null; mark="$dir/${BSC_AUDIT_PANE:-x}"; win="${BSC_TAINT_WINDOW:-120}"; danger=0; printf '%s' "$cmd" | grep -qE '(curl|wget).*(--data|--form|--upload-file|--post-file|--post-data|--body-data|--body-file| -d | -F | -T )' && danger=1; printf '%s' "$cmd" | grep -qE 'git[[:space:]]+push.*(--force|--force-with-lease|[[:space:]]-f([[:space:]]|$))' && danger=1; printf '%s' "$cmd" | grep -qE 'gh[[:space:]]+repo[[:space:]]+delete' && danger=1; printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_])(nc|ncat)[[:space:]]' && danger=1; if [ "$danger" = 1 ] && [ -f "$mark" ]; then ts="$(cat "$mark" 2>/dev/null)"; now="$(date +%s)"; if [ -n "$ts" ] && [ $((now - ts)) -lt "$win" ]; then echo "blocked: outward/destructive command within ${win}s of reading untrusted input (possible prompt injection) -- #1167. Split it from the read, or wait out the taint window." >&2; l="${BSC_TAINT_LOG:-}"; if [ -n "$l" ]; then __bsc_logline "$l" '%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${BSC_AUDIT_PANE:-?}" "$cmd"; fi; return 2; fi; fi; if [ "$tn" = WebFetch ] || printf '%s' "$cmd" | grep -qE '(^|[^[:alnum:]_])(curl|wget)([^[:alnum:]_]|$)|gh[[:space:]]+(issue|pr)[[:space:]]+view'; then date +%s > "$mark" 2>/dev/null; fi; return 0; }"#,
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
pub(crate) const BSC_COORD_EMIT_RC: &str = r#"__bsc_coord() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1" "$2" "$3"; }
__bsc_coord_log() { l="${BSC_COORD_LOG:-}"; [ -z "$l" ] && return 0; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; __bsc_logline "$l" '%s\t%s\t%s\n' "$ts" "${BSC_AUDIT_PANE:-?}" "$1"; }
bsc-landed() { __bsc_coord landed "$1" ""; }
bsc-merged() { __bsc_coord merged "$1" ""; }
bsc-closed() { __bsc_coord closed "$1" ""; }
bsc-failed() { r="$(cat)"; __bsc_coord failed "$1" "$r"; }
bsc-wait() { r="$(cat)"; __bsc_coord waiting "$r" "${BSC_CHECKPOINT_DOC:-}"; }
bsc-maintain() { r="$(cat | tr '\t\n' '  ')"; __bsc_coord maintain "$r" "${BSC_CHECKPOINT_DOC:-}"; }
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
    r#"bsc-defer() { j="$(cat)"; case "$j" in *'"stop_hook_active":true'*|*'"stop_hook_active": true'*) return 0 ;; esac; printf '%s' '{"decision":"block","reason":"Do not stop. Drive every owned issue to its open PR yourself: implement it, run the full local gate, then -- under the default auto-pr policy -- push your branch and open a PR to develop, pipe the issue into bsc-landed, and immediately pick up your next owned issue. The DIRECTOR reviews, merges, and closes your PR; never run gh pr merge or gh pr close on it yourself, and never wait on the user, on CI, or on the director. Keep going until EVERY owned issue has its work pushed and its PR open with the gate green. THEN, when nothing remains, do NOT end -- enter MAINTENANCE: pipe a one-line standing note into bsc-maintain (it parks you alive and ready) and stay available; the director will dispatch new or regressed work in your lane and resume you. For a decision you genuinely cannot make yourself, pipe a one-line question into bsc-ask so the director answers and resumes you."}'; }"#,
    "\n",
);

/// `bsc-fleet` (#734): the director's roster view. Reads `fleet.roster.tsv` (written at fleet
/// launch into the project hub -- the director's cwd) and joins it with `coord.log` to print
/// every session's console id (PANE), stream, repo, branch, role, and current STATE (blocked /
/// waiting / ask / active / idle, with what it's blocked on / asking). The PANE id is the
/// `<session>` argument the director feeds to bsc-answer / bsc-assign -- so this is how it
/// knows which worker to reach. State comes from each session's latest OWN-state coord event.
pub(crate) const BSC_FLEET_RC: &str = concat!(
    r#"bsc-fleet() { r="${BSC_FLEET_ROSTER:-$PWD/fleet.roster.tsv}"; l="${BSC_COORD_LOG:-}"; if [ ! -f "$r" ]; then echo "bsc-fleet: no roster at $r (run from the project hub while a fleet is live)"; return 1; fi; printf 'PANE   STREAM             REPO                       BRANCH           ROLE     STATE\n'; awk -F'\t' -v LOG="$l" 'BEGIN { if (LOG != "") { while ((getline ln < LOG) > 0) { split(ln, a, "\t"); k=a[3]; if (k=="blocked"||k=="waiting"||k=="ask"||k=="woke"||k=="maintain") { st[a[2]]=k; on[a[2]]=(k=="blocked"||k=="ask")?a[4]:"" } } close(LOG) } } { s=st[$1]; if (s=="") s="idle"; if (s=="woke") s="active"; if (s=="maintain") s="maintenance"; ex=(on[$1]!="")?" -> " on[$1]:""; printf "%-6s %-18s %-26s %-16s %-8s %s%s\n", $1, $2, $3, $4, $5, s, ex }' "$r"; }"#,
    "\n",
);

/// The `bsc-learned` capture helper (#1362): the session-facing front door for self-correction. When
/// an agent catches a mistake mid-session it records it as a reviewable CANDIDATE — never an
/// auto-committed skill. `bsc-learned "<what went wrong>" --rule "<corrective rule>" [--cause "<why>"]`
/// tags the lesson with the session's provenance ($BSC_AUDIT_PANE + $BSC_REPO_ROOT) and delegates to
/// `bsc plan lesson add`, which stores + de-dupes it in THIS project's plan.db (so it's queued for the
/// user to confirm/discard). A thin wrapper over the unified `bsc` helper — no new env, no PATH
/// changes. Only meaningful in a project/fleet session (one with a $BSC_PLAN_DB); elsewhere `bsc plan`
/// reports no plan store. A raw string keeps the embedded quotes readable. (#1877: `bsc-plan` → `bsc plan`.)
pub(crate) const BSC_LEARNED_RC: &str = concat!(
    r#"bsc-learned() { m="$1"; shift 2>/dev/null; r=""; c=""; while [ "$#" -gt 0 ]; do case "$1" in --rule) r="${2:-}"; shift 2 2>/dev/null || shift ;; --cause) c="${2:-}"; shift 2 2>/dev/null || shift ;; *) shift ;; esac; done; if [ -z "$m" ] && [ -z "$r" ]; then echo 'bsc-learned: usage: bsc-learned "<mistake>" --rule "<rule>" [--cause "<why>"]' >&2; return 2; fi; p="pane ${BSC_AUDIT_PANE:-?}"; [ -n "${BSC_REPO_ROOT:-}" ] && p="$p, repo ${BSC_REPO_ROOT}"; bsc plan lesson add "$m" --rule "$r" --cause "$c" --from "$p"; }"#,
    "\n",
);

/// The `bsc-deny` helper (#1916): a PreToolUse hook for the Bash tool. It pipes Claude Code's tool
/// JSON to `bsc hook bash-deny`, which exits 2 (block) when the command hits the always-on
/// dangerous-command floor (`bsc_util::dangerous`) or a `$BSC_DENY_BASH` pattern (the session's
/// role/user denies). This is the deny enforcement that survives `bypassPermissions` — where
/// `permissions.deny` is ignored but PreToolUse hooks still fire AND block. Backed by the `bsc`
/// binary (via the `bsc()` helper), not fragile shell JSON-parsing, so the floor never drifts.
pub(crate) const BSC_DENY_RC: &str = concat!(
    r#"bsc-deny() { bsc hook bash-deny; }"#,
    "\n",
);

/// The ordered list of every `BSC_*_RC` fragment, in the EXACT sequence the rc file
/// concatenates them. This is the single source of truth for the concat order: the rc
/// writer (`wire_bsc_env`) and the `full_bsc_rc_is_syntactically_valid_bash` syntax
/// guard both derive from it, so a new helper (or a reorder) lands in one place and can
/// never silently fall out of lockstep between the two. Each fragment already ends in a
/// trailing newline (#296), so `.concat()` keeps every helper on its own line.
pub(crate) const ALL_BSC_RC: &[&str] = &[
    // The shared sh helpers (#2064) MUST come first — every `bsc-*` helper below calls them.
    BSC_SHARED_RC,
    BSC_CHECKPOINT_RC,
    BSC_DECISIONS_RC,
    BSC_AUDIT_RC,
    BSC_SKILL_RC,
    BSC_HOOK_RC,
    BSC_MCP_RC,
    BSC_TOKENS_RC,
    BSC_ACTIVITY_RC,
    BSC_DONE_RC,
    BSC_PERM_RC,
    BSC_CONFINE_RC,
    BSC_SCOPE_RC,
    BSC_DENY_RC,
    BSC_TAINT_RC,
    BSC_COORD_EMIT_RC,
    BSC_DEFER_RC,
    BSC_FLEET_RC,
    BSC_RC,
    BSC_LEARNED_RC,
];

/// The full bsc-* rc body that `pty_create` writes to `bsc-env.sh` — every fragment in
/// `ALL_BSC_RC` concatenated in order. Byte-identical to the old inline `format!`.
pub(crate) fn bsc_rc_body() -> String {
    ALL_BSC_RC.concat()
}

#[cfg(test)]
mod tests;
