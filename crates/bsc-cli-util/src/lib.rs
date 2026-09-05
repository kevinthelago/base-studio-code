//! Shared CLI scaffold for the `bsc-*` state CLIs (#1762). The seven binaries
//! (`bsc-plan` / `bsc-data` / `bsc-skill` / `bsc-compliance` / `bsc-logs` / `bsc-blueprint` /
//! `bsc-project`) all copy-pasted the same three tiny pieces of scaffolding; this crate is their
//! single home so the copies don't drift:
//!
//! - [`cli_main`] — the byte-identical `main() -> ExitCode` wrapper (`Ok ⇒ SUCCESS`, `Err(e) ⇒ print
//!   `<prog>: <e>` to stderr + `FAILURE`). Each bin's `main()` becomes one line, and the program name
//!   in the error is passed once (fixing the "wrong binary name in the error" footgun).
//! - [`resolve_store_path`] — the `--flag` → `$ENV` → default precedence every store-backed CLI
//!   repeats. The env value is trimmed and an empty/whitespace value falls through to the default.
//! - [`args::walk`] — the argument walk itself: `-h`/`--help` to the `help` verb, the `unknown flag
//!   '--x'` refusal, positionals in order, and the next argument handed to a flag that takes a value.
//! - [`emit`] — the lean-text-vs-JSON output dispatch (`--pretty` ⇒ indented JSON, `--json` ⇒ compact
//!   JSON, neither ⇒ the caller's lean/TSV rendering).
//!
//! Deliberately **NOT** in `bsc-sqlite-util`: `bsc-data` is DuckDB and `bsc-project` is plain fs, so
//! the scaffold can't live in a SQLite-named crate. Tauri-free and dependency-light (`serde` /
//! `serde_json`) so the small CLIs stay small.


use serde::Serialize;
use std::path::PathBuf;
use std::process::ExitCode;



pub fn cli_main(prog: &str, run: impl FnOnce() -> Result<(), String>) -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{prog}: {e}");
            if names_something_unknown(&e) {
                eprintln!("{}", stale_binary_hint());
            }
            ExitCode::FAILURE
        }
    }
}

/// Does `err` report a verb or flag this binary does not have? The one error class that reads the same
/// whether the feature was never written or merely never staged.
///
/// Matches the shapes the CLIs actually emit — `unknown command 'x'`, `unknown flag '--x'`, and the
/// qualified `unknown emit command '--x'` — by requiring the message to OPEN with `unknown` and name one
/// of the two. Anything else is an ordinary error and gets no hint: a store miss or a bad argument is
/// not ambiguous about which build you are on.
fn names_something_unknown(err: &str) -> bool {
    err.starts_with("unknown ") && (err.contains("command") || err.contains("flag"))
}

/// When this binary was built, and how to replace it — appended to an unknown-verb error.
///
/// Designer request #92 filed a suspected false resolution: two fixes were merged and verified, the
/// reporter retested, and got `unknown flag '--shape'`. The fixes were real; the binary was not. Agent
/// sessions exec the STAGED sidecar at `~/.base-studio-code/bin/`, which `stage_dev_sidecars` refreshes
/// from `target/{debug,release}` only at APP BOOT — so a merge that lands mid-session is invisible until
/// a restart. Nothing in the session could distinguish that from the feature never existing, so the only
/// move left was to file a regression report.
///
/// The build time comes from the running executable's own mtime rather than a compile-time constant: it
/// needs no build script, and it is the same signal `stale_sidecars` compares, so the two agree.
fn stale_binary_hint() -> String {
    let built = std::env::current_exe()
        .and_then(|p| std::fs::metadata(&p).map(|m| (p, m)))
        .ok()
        .and_then(|(p, m)| m.modified().ok().map(|t| (p, t)))
        .map(|(p, t)| format!("{} (built {})", p.display(), format_stamp(t)))
        .unwrap_or_else(|| "an unknown build".to_string());
    // When the tree can be compared, say what IS as well as what may be — a definite answer is what
    // turns "maybe rebuild?" into an action. ADDED to the message, never instead of it: the mechanism
    // sentence is the useful half in both cases, and swapping it out made this text machine-dependent.
    let verdict = match behind_the_tree() {
        Some(v) => format!("\n      {v}"),
        None => String::new(),
    };
    format!(
        "      note: this binary is {built}.{verdict}\n      \
         If you expected a newer verb it may just not be STAGED — the app copies \
         `target/{{debug,release}}` into ~/.base-studio-code/bin at boot, so: `npm run build:plan`, then restart the app."
    )
}

/// The newest source mtime in the cargo workspace `start` sits inside — the tree this binary is
/// supposed to BE. `None` outside a workspace, so a release install or an arbitrary cwd degrades to
/// silence rather than a guess.
///
/// Walks up for the workspace root (`Cargo.toml` containing `[workspace]`), then stats every `.rs`
/// under `crates/` and `src-tauri/src/`. Bounded and cheap — a few thousand `stat` calls — and only
/// ever run by `version` and by an unknown-verb error, never on the hot path.
pub fn newest_workspace_source(start: &std::path::Path) -> Option<std::time::SystemTime> {
    let root = workspace_root(start)?;
    let mut newest: Option<std::time::SystemTime> = None;
    for sub in ["crates", "src-tauri/src"] {
        let mut stack = vec![root.join(sub)];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            for e in entries.flatten() {
                let p = e.path();
                if p.is_dir() {
                    // `target/` is build OUTPUT — it is newer than everything and says nothing about
                    // whether the SOURCE moved, which is the question being asked.
                    if e.file_name() != "target" {
                        stack.push(p);
                    }
                } else if p.extension().and_then(|x| x.to_str()) == Some("rs") {
                    if let Ok(t) = e.metadata().and_then(|m| m.modified()) {
                        if newest.is_none_or(|n| t > n) {
                            newest = Some(t);
                        }
                    }
                }
            }
        }
    }
    newest
}

/// The cargo workspace root at or above `start` — the directory whose `Cargo.toml` declares
/// `[workspace]`. `None` when there is none, which is the ordinary case for an installed binary.
fn workspace_root(start: &std::path::Path) -> Option<std::path::PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let manifest = d.join("Cargo.toml");
        if std::fs::read_to_string(&manifest).is_ok_and(|t| t.contains("[workspace]")) {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// How far `built` trails `newest`, or `None` when it does not meaningfully trail it at all.
///
/// Split out from [`behind_the_tree`] so the THRESHOLD is testable without a real clock, a real exe or
/// a real tree — the three things that made the first cut of this fail silently in exactly one way.
///
/// The floor is jitter tolerance, NOT a judgement about how stale is too stale: a binary that predates
/// its sources at all is behind them. It compares the DURATION rather than `as_secs()`, which is the
/// bug it exists to pin — a 0.2s gap truncates to 0, and the verdict vanished with nothing to say why.
fn behind_by(
    built: std::time::SystemTime,
    newest: std::time::SystemTime,
) -> Option<std::time::Duration> {
    let gap = newest.duration_since(built).ok()?;
    (gap >= std::time::Duration::from_secs(2)).then_some(gap)
}

/// Is this binary BEHIND the tree it is invoked in — and by how much?
///
/// THE QUESTION A SESSION ACTUALLY NEEDS, and the one nothing answered. On 2026-08-24 a designer
/// session ran for hours against a `bsc` built two days earlier. Three fixes had landed that day and
/// none were in it; it acted on findings all three exist to stop producing and orphaned 34 specifiers.
/// The guarded binary was in `target/debug/` five minutes before the damage — only the copy into
/// `~/.base-studio-code/bin` (which happens at APP BOOT) had never run.
///
/// Neither existing check could fire. [`stale_binary_hint`] needs an unknown-verb ERROR, and the
/// session never hit one — `bsc ui merge` existed, it just behaved like the old code. `stale_sidecars`
/// compares the sidecar to the app at BOOT, where it was current; the tree moved afterwards.
///
/// Returns `None` when the answer is unknowable (no workspace, unreadable exe) or when the binary is
/// current — a healthy build reports nothing, because a line printed every time is one nobody reads.
pub fn behind_the_tree() -> Option<String> {
    let exe = std::env::current_exe().ok()?;
    let built = std::fs::metadata(&exe).and_then(|m| m.modified()).ok()?;
    let cwd = std::env::current_dir().ok()?;
    let newest = newest_workspace_source(&cwd)?;
    let gap = behind_by(built, newest)?;
    // THE FACT ONLY — no instruction. Each caller already ends with its own way out, and a hint that
    // says "run build:plan" twice reads as boilerplate. It also keeps this string ADDITIVE: replacing a
    // caller's message meant the message changed shape depending on the machine, which made an existing
    // assertion on `stale_binary_hint` fail the moment develop moved under a stale test binary.
    Some(format!(
        "BEHIND: this binary was built {}, and sources in this workspace changed {} later ({}).",
        format_stamp(built),
        humanize(gap),
        format_stamp(newest),
    ))
}

/// A duration as the coarsest unit that still says something — "2 days", "3 hours", "7 minutes". The
/// point is the ORDER OF MAGNITUDE: "2 days" is what makes a reader stop, and seconds would not.
fn humanize(d: std::time::Duration) -> String {
    let s = d.as_secs();
    let (n, unit) = match s {
        0..=119 => (s, "second"),
        120..=7199 => (s / 60, "minute"),
        7200..=172_799 => (s / 3600, "hour"),
        _ => (s / 86_400, "day"),
    };
    format!("{n} {unit}{}", if n == 1 { "" } else { "s" })
}

/// A `SystemTime` as `YYYY-MM-DD HH:MM:SS` UTC — enough to compare against "when did that land?" without
/// pulling a date crate into every CLI.
fn format_stamp(t: std::time::SystemTime) -> String {
    let secs = match t.duration_since(std::time::UNIX_EPOCH) {
        Ok(d) => d.as_secs() as i64,
        Err(_) => return "an unknown time".to_string(),
    };
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    // Civil-from-days (Howard Hinnant's algorithm) — no crate, no leap-second pretence.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02} {h:02}:{mi:02}:{s:02} UTC")
}

/// An epoch-millisecond instant in the SAME `YYYY-MM-DD HH:MM:SS UTC` form `bsc version` prints.
///
/// Exposed so a stored build time (`bsc request`'s `bsc_built_at`, the mtime of the executable that
/// filed a request) renders identically to the `built …` line the same binary reports — one formatter,
/// so the two cannot drift into disagreeing about the build they both describe.
///
/// A negative input clamps to the epoch rather than panicking: `Duration` is unsigned, and a store
/// holding a pre-1970 timestamp is corrupt, not a reason to abort a read.
pub fn format_epoch_ms(ms: i64) -> String {
    format_stamp(std::time::UNIX_EPOCH + std::time::Duration::from_millis(ms.max(0) as u64))
}

/// The running binary's identity — `bsc version` (#92). Public so each `bsc-*` entry point can answer
/// "which build am I?" without reimplementing the stamp.
pub fn version_line(prog: &str) -> String {
    let (path, built) = std::env::current_exe()
        .and_then(|p| std::fs::metadata(&p).map(|m| (p, m)))
        .ok()
        .and_then(|(p, m)| m.modified().ok().map(|t| (p.display().to_string(), format_stamp(t))))
        .unwrap_or_else(|| ("<unknown>".to_string(), "an unknown time".to_string()));
    let base = format!("{prog} {}\n  built {built}\n  path  {path}", env!("CARGO_PKG_VERSION"));
    // The comparison is the whole value: reporting a build time and stopping short leaves the reader to
    // remember to check, which is exactly what did not happen.
    match behind_the_tree() {
        Some(verdict) => format!(
            "{base}\n  {verdict} Run `npm run build:plan`, then restart the app to re-stage it."
        ),
        None => base,
    }
}

/// Resolve a store path by the shared `--flag` → `$ENV` → `default` precedence:
///
/// 1. an explicit `flag` (e.g. `--db <path>`) wins, taken verbatim;
/// 2. else the `env` var, **trimmed** — an empty/whitespace value is treated as unset;
/// 3. else the caller's `default` (a hard `Err` for the CLIs with no default location — `bsc-plan`
///    / `bsc-data` — or a computed path like `~/.base-studio-code/skills.db` for the ones that have
///    one).
///
/// Trimming the env value + falling through on empty unifies a split the bins had: `bsc-blueprint`
/// already treated an empty env as unset, `bsc-compliance` trimmed it, and the others used it
/// verbatim. The flag is never trimmed (an explicit path is taken as given).
///
/// # Errors
/// Whatever `default` returns when neither the flag nor the env var supplies a path.
pub fn resolve_store_path(
    flag: &Option<String>,
    env: &str,
    default: impl FnOnce() -> Result<PathBuf, String>,
) -> Result<PathBuf, String> {
    if let Some(p) = flag {
        return Ok(PathBuf::from(p));
    }
    if let Ok(p) = std::env::var(env) {
        let p = p.trim();
        if !p.is_empty() {
            return Ok(PathBuf::from(p));
        }
    }
    default()
}

/// Print `value` per the output flags, falling back to the caller's lean text. The shared
/// **`--pretty` ⇒ JSON** rule (#1762): `--pretty` always forces indented JSON, `--json` selects
/// compact JSON, and with neither the caller's `lean` rendering (a human line / TSV table) is
/// printed. So `--pretty` implies JSON output — the `bsc-data` / `bsc-logs` semantics, now the one
/// rule for every CLI with a lean text mode. (The JSON-only CLIs without a lean form — `bsc-plan`'s
/// blob reads, `bsc-skill`, `bsc-compliance`, `bsc-blueprint` — use `bsc_sqlite_util::print_json`
/// directly, where the same precedence holds with no `lean` branch.)
///
/// A serialization failure prints `null` rather than erroring (an embedded read never aborts on it).
pub fn emit<T: Serialize>(pretty: bool, json: bool, value: &T, lean: impl FnOnce() -> String) {
    // Through `bsc_util::emit_line`, the shared helpers' `println!` — NOT `println!` itself
    // (#request-list-cannot-be-warm-served-until-it-stops-using-println).
    //
    // The warm server (#4152) answers a request by running the verb under `bsc_util::capture_output`,
    // a THREAD-LOCAL sink that only the shared helpers consult. A `println!` here writes straight to
    // stdout, which for a warm request IS the protocol stream — so every verb emitting this way was
    // structurally unservable, and `is_servable_warm` had to leave it off. `serve.rs`'s own audit test
    // records exactly that reasoning for the `get` verbs.
    //
    // `emit_line` is defined to be identical to `println!` when nothing is capturing, so one-shot CLI
    // output is unchanged byte for byte; it only differs inside a capture, which is the case that was
    // broken. 15 crates emit through here, so this makes all of them servable-ELIGIBLE at once —
    // eligible, not served: each verb still has to be audited onto the allow-list by hand.
    let out = if pretty {
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into())
    } else if json {
        serde_json::to_string(value).unwrap_or_else(|_| "null".into())
    } else {
        lean()
    };
    bsc_util::emit_line(&out);
}

/// Collapse every carriage return into a line feed so raw output is **LF-only**: `\r\n` → `\n` and a
/// lone `\r` → `\n`. The first half of the `--raw` contract (#3166) — a store value that picked up
/// Windows line endings can't inject a stray `\r` into a `$( )`-captured value or split a `while read`
/// loop on a phantom line.
fn normalize_lf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// Render a stored path to a GENERATED artifact, stating plainly when the file is no longer there.
///
/// # Why a bare path is a bug, not a shortcut
///
/// A `bsc shot` capture is TRANSIENT — the shots dir is held to a fixed window, so a path recorded in a
/// durable store (`loop.turns.shot_path`, `requests.shot_path`) outlives the pixels it names, by design.
/// Printing that path unchanged tells the reader a file is there. It reads as live, it is not, and the
/// only way to find out is to try to open it — which is exactly the silent-wrong answer this repo keeps
/// paying for. The durable record is the analysis stored ALONGSIDE the path; the image was only ever the
/// thing that produced it.
///
/// A missing file is therefore reported, never treated as an error: `(reaped)` is the expected end state
/// of a capture, not a fault to repair.
pub fn artifact_ref(path: &str) -> String {
    if std::path::Path::new(path).exists() {
        path.to_string()
    } else {
        format!("{path} (reaped)")
    }
}

/// The exact bytes [`print_raw`] emits for `s`: CR-normalized to LF, then trailing newlines collapsed
/// to **exactly one** `\n`. Pure (no I/O) so the byte-clean contract is unit-testable without capturing
/// stdout — the printer just writes this to the stdout handle. See [`print_raw`] for the hazards it
/// neutralizes.
pub fn raw_line(s: &str) -> String {
    let normalized = normalize_lf(s);
    format!("{}\n", normalized.trim_end_matches('\n'))
}

/// The exact bytes [`print_raw_lines`] emits for `lines`: each item passed through [`raw_line`]
/// (CR-normalized, trailing newlines collapsed to one) and concatenated in order — the "one clean id
/// per line" shape (`bsc <noun> list --raw`, #3166). Per-item collapsing means a CRLF-poisoned item
/// (`"id\r"`) yields ONE clean line, never a phantom blank one. Empty iterator ⇒ `""`. Pure → testable.
pub fn raw_lines<I, S>(lines: I) -> String
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut out = String::new();
    for line in lines {
        out.push_str(&raw_line(line.as_ref()));
    }
    out
}

/// Write `s` to stdout as raw UTF-8 bytes, LF-only, with exactly one trailing newline — the byte-clean
/// `--raw` read (#3166). Safe for `VALUE=$(bsc <noun> get <id> --raw)` capture on every platform.
///
/// Two hazards this neutralizes, the pair that broke `while read` audits (one silently ran on zero rows
/// and reported success):
/// - **CRLF poisoning** — every `\r` is normalized away ([`normalize_lf`]), so a value carrying Windows
///   line endings can't leak a carriage return into the captured string.
/// - **the cp1252 print trap** — bytes are written straight to the stdout handle via `write_all` (no
///   `println!`/locale layer), so non-ASCII UTF-8 is emitted verbatim, and a closed/broken pipe is
///   swallowed rather than panicking.
pub fn print_raw(s: &str) {
    write_stdout_bytes(raw_line(s).as_bytes());
}

/// Write each item of `lines` on its own LF-terminated line, raw UTF-8, bytes-direct — the shared
/// "one clean id per line" output every store's `list --raw` uses (#3166). Same CRLF + cp1252
/// neutralization as [`print_raw`]; an empty iterator prints nothing at all.
pub fn print_raw_lines<I, S>(lines: I)
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    write_stdout_bytes(raw_lines(lines).as_bytes());
}

/// Write `bytes` straight to the locked stdout handle — no `println!`, no locale/code-page layer — and
/// flush, swallowing any error (a broken pipe must not panic an embedded read). The single I/O sink
/// [`print_raw`]/[`print_raw_lines`] share.
fn write_stdout_bytes(bytes: &[u8]) {
    // #4152: when a warm serve loop is capturing on this thread, the bytes go to its buffer instead of
    // the real handle. `emit` takes a &str, and these bytes are UTF-8 by construction (`raw_line`
    // normalizes a Rust String), so the lossy path is unreachable in practice — but it is lossy rather
    // than a panic, because corrupting one response must never take the warm process down.
    if bsc_util::is_capturing() {
        bsc_util::emit(&String::from_utf8_lossy(bytes));
        return;
    }
    use std::io::Write;
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(bytes);
    let _ = out.flush();
}

/// The env var carrying a session's per-store access scopes (#2470) — a JSON object of store name →
/// access tier, e.g. `{"ui":"read"}`, rendered from the session's ROLE by the desktop at launch
/// (`sessionScopes` in `sessionLaunch.ts`) and injected into `pty_create`'s env.
pub const BSC_SCOPES_ENV: &str = "BSC_SCOPES";

/// Whether the current session's `$BSC_SCOPES` doc permits WRITING the named store (#2470).
///
/// **NOT a security boundary** — a session owns its own environment and can unset the var. This is
/// defense-in-depth against *accidents* (an agent absent-mindedly redefining a shared kit) and a
/// consistent guard for non-Claude runtimes (`bsc-agent`, raw hand shells); the launch-time
/// command-deny rules (`roleDeniedCommands` → `permissions.deny` / `$BSC_DENY_BASH`) are the
/// enforcement boundary.
///
/// Back-compat is deliberately permissive: an absent env var, malformed JSON, an absent store key,
/// or a non-string tier all mean **unrestricted** (`true`) — a hand shell with no scope doc keeps
/// working. Only an explicit `"read"` or `"none"` tier refuses the write.
///
/// A store CLI adopts it by guarding its mutating verb handlers, e.g. in `bsc skill`'s `remove`:
/// ```ignore
/// bsc_cli_util::require_write_scope("skill")?; // Err → stderr + nonzero exit via cli_main
/// ```
pub fn scope_allows_write(scope: &str) -> bool {
    scope_allows_write_in(session_env(&SCOPES_OVERRIDE, BSC_SCOPES_ENV).as_deref(), scope)
}

/// The env var naming the FEATURES a session may write records in
/// (`a-worker-writes-only-its-own-feature`) — whitespace/comma separated, stamped at launch from the
/// worker's stream's feature.
///
/// The fine half of the pair. `$BSC_SCOPES` answers "may this session write this STORE at all";
/// this answers "which RECORDS in it". Both must pass, and they are separate because they fail for
/// different reasons and want different messages.
pub const BSC_FEATURES_ENV: &str = "BSC_FEATURES";

/// The features this session may write, or `None` when it is UNCONFINED.
///
/// `None` and `Some(empty)` are deliberately different, and the difference is the whole safety story:
/// absent means no confinement was configured (a hand shell, a librarian, every existing test) and
/// everything is writable, while an explicitly empty list would mean "write nothing". Conflating them
/// would either brick every ungated session or silently un-confine every worker.
pub fn session_features() -> Option<Vec<String>> {
    let raw = session_env(&FEATURES_OVERRIDE, BSC_FEATURES_ENV)?;
    let list: Vec<String> = raw
        .split([',', ' ', '\t', '\n'])
        .map(str::trim)
        .filter(|f| !f.is_empty())
        .map(str::to_string)
        .collect();
    // A var set to whitespace is a MISCONFIGURATION, not a statement that the session writes nothing.
    // Reading it as the latter would brick a worker on a launch bug, so it reads as unconfined and the
    // coarse store gate still applies.
    if list.is_empty() { None } else { Some(list) }
}

/// Whether this session may WRITE a record owned by `feature`.
///
/// `feature` is the record's own ownership axis; an EMPTY one (a record that carries none) is refused
/// under confinement, because "owned by nobody" must not read as "owned by everybody" — that is the
/// hole a confinement exists to close.
///
/// **NOT a security boundary**, for the reason [`scope_allows_write`] states: a session owns its
/// environment. It is defense-in-depth against the accident — a worker fixing its own bug by editing
/// the shared record every other feature composes.
pub fn may_write_feature(feature: &str) -> bool {
    match session_features() {
        None => true,
        Some(allowed) => {
            let f = feature.trim();
            !f.is_empty() && allowed.iter().any(|a| a == f)
        }
    }
}

/// [`may_write_feature`] as a `Result` for the verb handlers, with the refusal a reader can act on.
///
/// It names the record, ITS feature and the session's — three facts, because the common cause is not
/// "you may not write" but "you are in the wrong lane", and a message without both sides cannot say
/// which. The reserved tiers get their own sentence: `core` is not a lane anyone is assigned to, so
/// pointing a worker at its own feature would be advice it cannot follow.
pub fn require_feature_write(record: &str, feature: &str) -> Result<(), String> {
    if may_write_feature(feature) {
        return Ok(());
    }
    let mine = session_features().unwrap_or_default().join(", ");
    let owner = if feature.trim().is_empty() { "(no feature)" } else { feature.trim() };
    let hint = match owner {
        "core" | "reference" | "shell" | "store" => {
            "that is a SHARED tier every feature builds on, so it is not any one worker's to change —              route it through your director with `bsc plan request new`"
        }
        "(no feature)" => {
            "a record owned by no feature cannot be written under confinement — give it one with              `--feature <slug>`, or ask your director which lane it belongs to"
        }
        _ => "route it through your director with `bsc plan request new`",
    };
    Err(format!(
        "'{record}' belongs to feature '{owner}', and this session writes only: {mine}.
  {hint}
           (reads are unaffected — `get`/`list`/`dupes`/`doctor` see every record)"
    ))
}

/// A per-thread override of one session env var. Outer `None` = no override in force (read the real
/// env); `Some(inner)` = use `inner`, where `None` means "the var is unset".
type EnvOverride = std::cell::RefCell<Option<Option<String>>>;

thread_local! {
    /// The scope-doc override — see [`with_scopes`].
    static SCOPES_OVERRIDE: EnvOverride = const { std::cell::RefCell::new(None) };
    /// The feature-confinement override — see [`with_features`].
    static FEATURES_OVERRIDE: EnvOverride = const { std::cell::RefCell::new(None) };
    /// The scratch-dir override — see [`with_scratch`].
    static SCRATCH_OVERRIDE: EnvOverride = const { std::cell::RefCell::new(None) };
    /// The confinement-root override — see [`with_repo_root`].
    static REPO_ROOT_OVERRIDE: EnvOverride = const { std::cell::RefCell::new(None) };
    /// The harvest-roots override — see [`with_harvest_roots`].
    static HARVEST_ROOTS_OVERRIDE: EnvOverride = const { std::cell::RefCell::new(None) };
}

/// The value of a session env var for THIS thread: the thread-local override when one is in force,
/// else the real process environment. The single funnel [`with_scopes`] and [`with_scratch`] hang
/// off, so a test seam can never disagree with the production read.
fn session_env(cell: &'static std::thread::LocalKey<EnvOverride>, var: &str) -> Option<String> {
    match cell.with(|c| c.borrow().clone()) {
        Some(v) => v,
        None => std::env::var(var).ok(),
    }
}

/// Run `f` with `cell`'s override set to `doc`, restoring the previous value on drop — including
/// while unwinding from a failed assertion. The shared body of [`with_scopes`] / [`with_scratch`].
fn with_env_override<T>(
    cell: &'static std::thread::LocalKey<EnvOverride>,
    doc: Option<&str>,
    f: impl FnOnce() -> T,
) -> T {
    struct Restore(&'static std::thread::LocalKey<EnvOverride>, Option<Option<String>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            let prev = self.1.take();
            self.0.with(|c| *c.borrow_mut() = prev);
        }
    }
    let prev = cell.with(|c| c.borrow_mut().replace(doc.map(str::to_owned)));
    let _restore = Restore(cell, prev);
    f()
}

/// Run `f` with the session scope doc forced to `doc` **for the calling thread only** (#3382).
///
/// A TEST SEAM, and the reason it exists is worth stating plainly: `cargo test` runs a crate's tests
/// as parallel THREADS OF ONE PROCESS, so `std::env::set_var(BSC_SCOPES_ENV, …)` is shared mutable
/// state. A test that scoped `ui` read-only raced every concurrently-running test that called a write
/// verb, and whichever lost saw a scope doc no one wrote for it — surfacing as an intermittent "this
/// session's 'ui' scope is read-only" panic in an unrelated test (reproduced at ~5 runs in 12). A
/// serializing mutex does NOT fix that: it orders the tests that TAKE it, while every test that merely
/// reads the env stays exposed.
///
/// Thread-local removes the category rather than scheduling around it — each test thread sees exactly
/// the doc it asked for, tests keep running in parallel, and no lock is needed. Production never sets
/// an override, so [`scope_allows_write`] falls through to the real environment unchanged.
///
/// ```ignore
/// bsc_cli_util::with_scopes(Some(r#"{"ui":"read"}"#), || {
///     let err = run(vec!["remove".into(), "x".into()], "bsc ui").unwrap_err();
///     assert!(err.contains("read-only"));
/// });
/// ```
pub fn with_scopes<T>(doc: Option<&str>, f: impl FnOnce() -> T) -> T {
    with_env_override(&SCOPES_OVERRIDE, doc, f)
}

/// Run `f` with `$BSC_FEATURES` forced to `list` for the calling thread only — the test seam for
/// [`may_write_feature`], and the reason its tests mutate no process-global state.
pub fn with_features<T>(list: Option<&str>, f: impl FnOnce() -> T) -> T {
    with_env_override(&FEATURES_OVERRIDE, list, f)
}

/// Run `f` with `$BSC_SCRATCH` forced to `dir` **for the calling thread only** (#3382) — the scratch
/// twin of [`with_scopes`], and the same disease: tests that `set_var`/`remove_var` this path raced
/// each other, so `read_payload`'s "missing file" case intermittently saw "no scratch dir" because a
/// sibling test had just cleared it. Pass `None` to assert the unset case hermetically.
pub fn with_scratch<T>(dir: Option<&str>, f: impl FnOnce() -> T) -> T {
    with_env_override(&SCRATCH_OVERRIDE, dir, f)
}

/// The env var naming the session's FS-confinement root (#158) — the repo root the `bsc-confine`
/// PreToolUse hook checks Claude's file-tool paths against. `pty_create` sets it on EVERY pane, in
/// BASH form on Windows (`/c/Users/…`), which is why [`require_harvestable_root`] normalizes before
/// resolving.
pub const BSC_REPO_ROOT_ENV: &str = "BSC_REPO_ROOT";

/// Extra roots this session may HARVEST (read) from, beyond its confinement root (#3509) —
/// newline-separated. READ-ONLY: it widens what `bsc ui harvest` / `bsc graph harvest` may scan and
/// touches no write path, so a session can mine a repo it may not write to.
pub const BSC_HARVEST_ROOTS_ENV: &str = "BSC_HARVEST_ROOTS";

/// Run `f` with the confinement root forced to `root` **for the calling thread only** (#3475) — the
/// repo-root twin of [`with_scopes`], and thread-local for exactly the same reason (#3382): `cargo
/// test` runs a crate's tests as parallel threads of one process, so a `set_var` seam would race
/// every sibling test. Pass `None` to assert the unconfined case hermetically.
pub fn with_repo_root<T>(root: Option<&str>, f: impl FnOnce() -> T) -> T {
    with_env_override(&REPO_ROOT_OVERRIDE, root, f)
}

/// Run `f` with `$BSC_HARVEST_ROOTS` forced to `roots` (newline-separated) **for the calling thread
/// only** (#3509) — the harvest-allow-list twin of [`with_repo_root`], thread-local for the same #3382
/// reason: `cargo test` runs a crate's tests as parallel threads of one process.
pub fn with_harvest_roots<T>(roots: Option<&str>, f: impl FnOnce() -> T) -> T {
    with_env_override(&HARVEST_ROOTS_OVERRIDE, roots, f)
}

/// Refuse a path outside the session's FS-confinement root (#3475/#158) — the CLI twin of the
/// `bsc-confine` PreToolUse hook.
///
/// WHY THIS EXISTS: `bsc-confine` reads `file_path` out of the hook payload, so it gates Claude's FILE
/// TOOLS and is structurally blind to what a spawned binary reads. A verb that takes a directory and
/// returns file CONTENTS — `bsc ui harvest`, `bsc graph harvest` — therefore hands a deliberately
/// confined session (the designer and librarian are limited to their studio workspace, and CANNOT
/// `Read` a repo file) a read of any path on disk, laundered through an allow-listed CLI. The grant was
/// never the gap; the missing boundary was. Every verb that reads a caller-named directory should call
/// this.
///
/// An UNSET or empty root means an unconfined session — a plain console, or a direct CLI run — and is
/// allowed unchanged, so this is fully back-compatible. When the root IS set, both sides are resolved
/// with `canonicalize` before comparing, so `..` segments and symlinks cannot walk out of it. A root
/// that cannot itself be resolved FAILS CLOSED: a misconfigured confinement must not silently degrade
/// into no confinement at all.
pub fn require_harvestable_root(target: &std::path::Path) -> Result<(), String> {
    let Some(root_raw) = session_env(&REPO_ROOT_OVERRIDE, BSC_REPO_ROOT_ENV) else { return Ok(()) };
    if root_raw.trim().is_empty() {
        return Ok(());
    }
    // The CONFINEMENT root fails closed when unresolvable: a misconfigured confinement must never
    // silently degrade into no confinement.
    let root_real = resolved_root(&root_raw).ok_or_else(|| {
        format!(
            "the session's confinement root ({}) cannot be resolved — refusing to read outside it              ($BSC_REPO_ROOT, #158)",
            root_raw.trim()
        )
    })?;
    let target_real = target
        .canonicalize()
        .map_err(|e| format!("cannot resolve '{}': {e}", target.display()))?;
    if within(&target_real, &root_real) {
        return Ok(());
    }
    let extra = harvest_roots();
    if extra.iter().any(|r| within(&target_real, r)) {
        return Ok(());
    }
    let mut allowed = vec![root_real.display().to_string()];
    allowed.extend(extra.iter().map(|r| r.display().to_string()));
    Err(format!(
        "blocked: '{}' is outside every root this session may harvest ({}) — #158 FS confinement.          Add it to $BSC_HARVEST_ROOTS to grant READ-only harvest access, or run this from a session          whose root covers that path.",
        target_real.display(),
        allowed.join(", "),
    ))
}

/// Is `target` the root itself or inside it? Both sides are already canonical.
fn within(target: &std::path::Path, root: &std::path::Path) -> bool {
    target == root || target.starts_with(root)
}

/// Canonicalize one root string, or `None` when it is blank or cannot be resolved. Callers decide what
/// `None` means: for the confinement root it is a hard error, for an ALLOW-LIST entry it simply grants
/// nothing — which is the fail-closed direction for a list that only ever widens access.
fn resolved_root(raw: &str) -> Option<PathBuf> {
    let r = raw.trim();
    if r.is_empty() {
        return None;
    }
    PathBuf::from(r).canonicalize().ok()
}

/// The EXTRA roots this session may HARVEST from (#3509) — `$BSC_HARVEST_ROOTS`, newline-separated.
///
/// Newline, not the OS path separator, for the same reason `$BSC_DENY_BASH` uses it: a Windows path
/// contains `;` and a `:`-bearing drive letter, so any single-character separator that also occurs in
/// paths would split them wrongly.
fn harvest_roots() -> Vec<PathBuf> {
    session_env(&HARVEST_ROOTS_OVERRIDE, BSC_HARVEST_ROOTS_ENV)
        .unwrap_or_default()
        .lines()
        .filter_map(resolved_root)
        .collect()
}

/// A read-only view of the session-scoped environment a confined CLI session runs under (#3571) — the
/// data behind `bsc ui env`. A restricted studio session (designer/librarian) is cwd'd in its own
/// sealed workspace, NOT the repo, so it cannot see its scratch dir, its write scopes, or — the reason
/// this exists — the roots it may HARVEST. `harvest` refused every guessed path with only a terse "outside
/// every root" message, leaving the session no way to DISCOVER where the app's UI actually lives. This
/// surfaces all of it. Every field is read through the same `session_env` accessor the gates use, so the
/// thread-local test overrides ([`with_scratch`]/[`with_scopes`]/[`with_repo_root`]/[`with_harvest_roots`])
/// apply.
pub struct SessionEnvSnapshot {
    /// `$BSC_SCRATCH` — the sealed dir a `--file` payload is staged in. `None` ⇒ no scratch dir.
    pub scratch: Option<String>,
    /// `$BSC_SCOPES` — the write-scope doc (`{"ui":"read"}`). `None` ⇒ unconfined (full write access).
    pub scopes: Option<String>,
    /// `$BSC_REPO_ROOT` — the FS-confinement root, which is also the session's own harvestable root.
    /// `None` ⇒ an unconfined session (a plain console / a direct CLI run).
    pub repo_root: Option<String>,
    /// `$BSC_HARVEST_ROOTS` — the EXTRA read-only trees this session may harvest (e.g. the app's own
    /// source tree granted to the designer), already split and trimmed. Empty ⇒ none beyond `repo_root`.
    pub harvest_roots: Vec<String>,
}

impl SessionEnvSnapshot {
    /// The roots `harvest` will accept a directory under — the confinement root plus every extra harvest
    /// root, in the order [`require_harvestable_root`] checks them.
    pub fn harvestable_roots(&self) -> Vec<&str> {
        self.repo_root.as_deref().into_iter().chain(self.harvest_roots.iter().map(String::as_str)).collect()
    }
}

fn nonblank(o: Option<String>) -> Option<String> {
    o.filter(|s| !s.trim().is_empty())
}

/// Snapshot the session-scoped env ([`SessionEnvSnapshot`]) — what `bsc ui env` reports so a confined
/// session can discover its scratch dir, scopes, and harvestable roots.
pub fn session_env_snapshot() -> SessionEnvSnapshot {
    SessionEnvSnapshot {
        scratch: nonblank(session_env(&SCRATCH_OVERRIDE, BSC_SCRATCH_ENV)),
        scopes: nonblank(session_env(&SCOPES_OVERRIDE, BSC_SCOPES_ENV)),
        repo_root: nonblank(session_env(&REPO_ROOT_OVERRIDE, BSC_REPO_ROOT_ENV)),
        harvest_roots: session_env(&HARVEST_ROOTS_OVERRIDE, BSC_HARVEST_ROOTS_ENV)
            .unwrap_or_default()
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .collect(),
    }
}

/// Render [`session_env_snapshot`] as the human-readable `bsc ui env` report. `prog` is the command
/// surface (`"bsc ui"`) so the closing hint names the real harvest verb the session should run.
pub fn format_session_env(prog: &str) -> String {
    let s = session_env_snapshot();
    let mut out = String::new();
    out.push_str(&format!(
        "scratch dir:  {}\n",
        s.scratch.as_deref().unwrap_or("(none — this session has no scratch dir)")
    ));
    out.push_str(&format!(
        "write scopes: {}\n",
        s.scopes.as_deref().unwrap_or("(unconfined — full write access)")
    ));
    out.push_str(&format!(
        "confinement:  {}\n",
        s.repo_root.as_deref().unwrap_or("(unconfined — no FS confinement)")
    ));
    let harvestable = s.harvestable_roots();
    out.push_str("harvest roots (READ-only — the trees `harvest` may scan):\n");
    if harvestable.is_empty() {
        out.push_str("  (unconfined — harvest may scan any path)\n");
    } else {
        for r in &harvestable {
            out.push_str(&format!("  {r}\n"));
        }
    }
    // Point at the app's own source tree (an EXTRA root) when granted, else the session's own root.
    if let Some(target) = s.harvest_roots.first().or(s.repo_root.as_ref()) {
        out.push_str(&format!("\nMine a tree's components with:  {prog} harvest {target}\n"));
    }
    out
}

/// The pure core of [`scope_allows_write`]: `doc` is the raw `$BSC_SCOPES` value (or `None` when the
/// var is unset). Split out so the tier logic is testable without touching the process environment.
pub fn scope_allows_write_in(doc: Option<&str>, scope: &str) -> bool {
    let Some(doc) = doc else { return true };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(doc) else { return true };
    !matches!(v.get(scope).and_then(serde_json::Value::as_str), Some("read") | Some("none"))
}

/// [`scope_allows_write`] as a `Result` for the CLI verb handlers: `Err` carries the refusal message
/// (naming the scope + the env doc that imposed it), which `cli_main` prints to stderr with a nonzero
/// exit. See [`scope_allows_write`] for the semantics and the non-boundary caveat.
pub fn require_write_scope(scope: &str) -> Result<(), String> {
    if scope_allows_write(scope) {
        Ok(())
    } else {
        Err(format!(
            "this session's '{scope}' scope is read-only ($BSC_SCOPES) — mutating verbs are \
             disabled. Read verbs still work; route the change through a session whose role \
             grants '{scope}' write access."
        ))
    }
}

/// One command's documentation for the shared help system. `name` is the subcommand word, `summary`
/// is the single line shown in the compact overview, and `usage` is the detailed block shown by
/// `<prog> <name> help`. The split is deliberate: the overview stays tiny (cheap context for a model
/// to load), and full detail is fetched one command at a time on demand. `Copy` (all fields are
/// `&'static str`) so a CLI that MOUNTS another CLI's verbs can compose the two catalogs into one
/// merged help tree (`bsc ui` + the component-library verbs, #2469).
#[derive(Clone, Copy, Debug)]
pub struct CmdDoc {
    pub name: &'static str,
    pub summary: &'static str,
    pub usage: &'static str,
}

/// The COMPACT overview: the program tagline, the invocation shape, and one aligned line per command.
/// Small on purpose — this is the "just enough to know what exists" surface (a model loads it once,
/// then drills into a single command's `help`). Pure → unit-testable.
pub fn help_overview(prog: &str, tagline: &str, cmds: &[CmdDoc]) -> String {
    let w = cmds.iter().map(|c| c.name.len()).max().unwrap_or(0);
    let mut s = format!(
        "{prog} — {tagline}\n\nUSAGE:\n  {prog} <command> [args] [--json|--pretty]\n  {prog} <command> help    # detailed help for ONE command (keeps context small)\n\nCOMMANDS:\n",
    );
    for c in cmds {
        s.push_str(&format!("  {:<w$}  {}\n", c.name, c.summary, w = w));
    }
    s.push_str(&format!("\nRun `{prog} <command> help` for the args of a single command.\n"));
    s
}

/// ONE command's detailed help (`name` matched against `cmds`), falling back to the [`help_overview`]
/// when `name` isn't a known command — so `<prog> help <typo>` shows the menu rather than nothing.
/// Pure → unit-testable.
pub fn help_for(prog: &str, tagline: &str, cmds: &[CmdDoc], name: &str) -> String {
    match cmds.iter().find(|c| c.name == name) {
        Some(c) => format!("{prog} {} — {}\n\n{}\n", c.name, c.summary, c.usage),
        None => help_overview(prog, tagline, cmds),
    }
}

/// The shared top-level + per-command **help dispatch** every `CmdDoc`-driven `bsc-*` CLI runs at the
/// top of `run()` (#1862). Returns `true` when it printed help — the caller then `return Ok(())`s —
/// or `false` when `positional[0]` is a real command to dispatch on. `positional` is the parsed
/// leftover-args vector (verb + subcommands), with `-h`/`--help` already folded to a leading `help`
/// token by each bin's arg parser.
///
/// The contract is byte-for-byte what the bins inlined:
/// - no command, or `help` → the compact [`help_overview`]; `help <name>` → that command's detail;
/// - `<cmd> help` → that command's detail (`help_for` falls back to the overview for an unknown name).
///
/// Help is resolved **before** any store is opened, so `<prog> help` works without a db/dir. CLIs
/// whose help semantics differ — a bare invocation that defaults to a verb (`bsc-logs`), or a
/// hand-rolled menu (`bsc-plan`) — keep their own block rather than route through this.
pub fn handle_help(prog: &str, tagline: &str, cmds: &[CmdDoc], positional: &[String]) -> bool {
    let cmd = positional.first().map(String::as_str).unwrap_or("");
    if cmd.is_empty() || cmd == "help" {
        // Resolved HERE and not at the top, so a real command never pays the record read. See the
        // note in `surface` on why this is the seam every CmdDoc-driven CLI shares.
        let (tagline, cmds) = surface::resolve_surface(prog, tagline, cmds);
        match positional.get(1) {
            Some(name) => print!("{}", help_for(prog, tagline, cmds, name)),
            None => print!("{}", help_overview(prog, tagline, cmds)),
        }
        return true;
    }
    if positional.get(1).map(String::as_str) == Some("help") {
        let (tagline, cmds) = surface::resolve_surface(prog, tagline, cmds);
        print!("{}", help_for(prog, tagline, cmds, cmd));
        return true;
    }
    false
}

/// The shared **unknown-command** error string: the offending `cmd` plus the compact
/// [`help_overview`] — the exact text each `CmdDoc`-driven bin builds in its dispatch fallthrough
/// (#1862), so the message stays uniform (and in sync with the command catalog) across the CLIs.
pub fn unknown_command(prog: &str, tagline: &str, cmds: &[CmdDoc], cmd: &str) -> String {
    // The error path shows the SAME catalog help does, record included — a user who just typed a verb
    // that does not exist is the reader most likely to act on the list they are handed.
    let (tagline, cmds) = surface::resolve_surface(prog, tagline, cmds);
    format!("unknown command '{cmd}'\n\n{}", help_overview(prog, tagline, cmds))
}

// ── `--file <name>`: the sealed scratch payload channel (#3373) ─────────────────────────────────────
//
// WHY THIS EXISTS. A restricted studio session (designer / librarian / architect / sound-designer) is
// confined to ONE store CLI by an allow-list of Bash rules. Claude Code treats NEWLINES as command
// separators, so the natural authoring form — a heredoc piping JSON into `bsc ui set` — is split into
// pseudo-subcommands (the JSON body, the terminating `EOF`) that match no rule and cannot be expressed
// by any rule, because the body is unpredictable by definition. Passing the payload as an ARGUMENT
// instead is allow-listable but caps out at the OS command-line limit (~32 KB on Windows) and forces
// the model through shell-quoting on top of JSON escaping. A FILE is the only shell-shaped channel that
// is both single-line (hence allow-listable) and unbounded, and it needs no escaping at all — the
// session writes it with the Write tool, which handles multi-line content natively.
//
// WHY BARE NAMES ONLY. An unrestricted `--file <path>` would turn a write-confined session into an
// ARBITRARY-FILE READER: `bsc ui set --file ~/.ssh/id_rsa` is an allowed command by the letter of
// `Bash(bsc ui *)`, and it would pull those bytes into the store. Accepting only a bare filename makes
// traversal UNREPRESENTABLE rather than defended-against — there is no path to canonicalize, no prefix
// comparison to get subtly wrong, and no symlink to follow because there is nowhere to point one from.
//
// The file is DATA, never code: it is read and JSON-parsed by the caller. Nothing here execs, sources,
// or shells out, and that is a contract of this module, not an accident of the current implementation.

/// Env var naming the session's sealed scratch directory. Set per-pane by `pty_create`, exactly as
/// `$BSC_PLAN_DB` and `$BSC_BIN` are. Absent ⇒ `--file` is refused outright (fail closed) — it must
/// NEVER fall back to the process cwd, which the session does not control.
pub const BSC_SCRATCH_ENV: &str = "BSC_SCRATCH";

/// Whether `name` is a bare filename: no path separator, no parent-dir escape, no drive letter, not
/// empty and not a dot-entry. The whole traversal defence, kept in one place so every store shares it.
pub fn is_bare_filename(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.contains(':')       // rejects `C:` drive-relative and NTFS alternate data streams
        && !name.contains('\0')
}

/// Resolve `--file <name>` to an absolute path inside the session's scratch dir.
///
/// Refuses, with a message that says which rule was broken:
///  * a name that is not bare (see [`is_bare_filename`]) — the traversal defence;
///  * an unset/empty `$BSC_SCRATCH` — fail closed rather than resolving against the cwd.
pub fn resolve_scratch_file(name: &str) -> Result<std::path::PathBuf, String> {
    if !is_bare_filename(name) {
        return Err(format!(
            "--file takes a BARE FILENAME inside the session scratch dir, not a path: '{name}' is not \
             allowed (no '/', '\\', '..' or ':'). Write the payload to ${BSC_SCRATCH_ENV} and pass just \
             its name, e.g. --file payload.json"
        ));
    }
    let dir = session_env(&SCRATCH_OVERRIDE, BSC_SCRATCH_ENV).unwrap_or_default();
    if dir.trim().is_empty() {
        return Err(format!(
            "--file needs ${BSC_SCRATCH_ENV} to be set (this session has no scratch dir); pipe the \
             payload on stdin instead"
        ));
    }
    Ok(std::path::Path::new(&dir).join(name))
}

/// Resolve `--out <name>` to an absolute path inside the session scratch dir — the WRITE-side twin of
/// [`resolve_scratch_file`] (#3713). Same traversal defence ([`is_bare_filename`]) and same
/// fail-closed-on-unset-`$BSC_SCRATCH`, worded for the output flag. Lets a READ verb spill a large value
/// into a confinement-allowed path the session can then Read/Grep, instead of relying on stdout — which a
/// restricted studio session truncates (and spills OUT of the confinement, unreadable) for large output.
pub fn resolve_scratch_out(name: &str) -> Result<std::path::PathBuf, String> {
    if !is_bare_filename(name) {
        return Err(format!(
            "--out takes a BARE FILENAME inside the session scratch dir, not a path: '{name}' is not \
             allowed (no '/', '\\', '..' or ':'). Pass just a name, e.g. --out srcText.tsx"
        ));
    }
    let dir = session_env(&SCRATCH_OVERRIDE, BSC_SCRATCH_ENV).unwrap_or_default();
    if dir.trim().is_empty() {
        return Err(format!(
            "--out needs ${BSC_SCRATCH_ENV} to be set (this session has no scratch dir); drop --out to \
             print to stdout instead"
        ));
    }
    Ok(std::path::Path::new(&dir).join(name))
}

/// The payload for a write verb: the contents of `--file <name>` when given, else stdin.
///
/// This is the ONE place the two channels converge, so every store's write verb accepts both with
/// identical semantics — `--file` is exactly "stdin, from a sealed file" and nothing more.
pub fn read_payload(file: Option<&str>) -> Result<String, String> {
    match file {
        Some(name) => {
            let path = resolve_scratch_file(name)?;
            std::fs::read_to_string(&path)
                .map_err(|e| format!("cannot read --file {}: {e}", path.display()))
        }
        None => {
            use std::io::Read;
            let mut raw = String::new();
            std::io::stdin().read_to_string(&mut raw).map_err(|e| format!("cannot read stdin: {e}"))?;
            Ok(raw)
        }
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/args.rs, src/feature_confinement_tests.rs, src/session.rs, src/surface.rs, src/surface_tests.rs, src/tests.rs, src/vendored.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-cli-util--<module>.rs
//     bsc graph impl set --id bsc-cli-util--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-cli-util--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-cli-util--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));