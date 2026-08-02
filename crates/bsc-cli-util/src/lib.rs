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
//! - [`emit`] — the lean-text-vs-JSON output dispatch (`--pretty` ⇒ indented JSON, `--json` ⇒ compact
//!   JSON, neither ⇒ the caller's lean/TSV rendering).
//!
//! Deliberately **NOT** in `bsc-sqlite-util`: `bsc-data` is DuckDB and `bsc-project` is plain fs, so
//! the scaffold can't live in a SQLite-named crate. Tauri-free and dependency-light (`serde` /
//! `serde_json`) so the small CLIs stay small.

/// The vendored-file provenance contract (#4192) — the stamp + hash + `sync` verdicts shared by every
/// `emit` surface, so `bsc ui emit` and `bsc graph emit` cannot drift into two look-alike formats.
pub mod vendored;

use serde::Serialize;
use std::path::PathBuf;
use std::process::ExitCode;

/// The byte-identical `main` of every `bsc-*` CLI: run `run`, mapping `Ok(())` to
/// [`ExitCode::SUCCESS`] and `Err(e)` to `<prog>: <e>` on stderr + [`ExitCode::FAILURE`]. `prog` is
/// the binary name printed in the error — passed once here rather than re-typed in each bin's
/// `eprintln!` (which is how they drifted out of sync with their actual binary name).
///
/// ```ignore
/// fn main() -> std::process::ExitCode {
///     bsc_cli_util::cli_main("bsc-plan", run)
/// }
/// ```
pub fn cli_main(prog: &str, run: impl FnOnce() -> Result<(), String>) -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("{prog}: {e}");
            ExitCode::FAILURE
        }
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
    if pretty {
        println!("{}", serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".into()));
    } else if json {
        println!("{}", serde_json::to_string(value).unwrap_or_else(|_| "null".into()));
    } else {
        println!("{}", lean());
    }
}

/// Collapse every carriage return into a line feed so raw output is **LF-only**: `\r\n` → `\n` and a
/// lone `\r` → `\n`. The first half of the `--raw` contract (#3166) — a store value that picked up
/// Windows line endings can't inject a stray `\r` into a `$( )`-captured value or split a `while read`
/// loop on a phantom line.
fn normalize_lf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
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

/// A per-thread override of one session env var. Outer `None` = no override in force (read the real
/// env); `Some(inner)` = use `inner`, where `None` means "the var is unset".
type EnvOverride = std::cell::RefCell<Option<Option<String>>>;

thread_local! {
    /// The scope-doc override — see [`with_scopes`].
    static SCOPES_OVERRIDE: EnvOverride = const { std::cell::RefCell::new(None) };
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

/// A git-bash drive path (`/c/Users/…`) back to a native one (`C:/Users/…`) so Windows fs APIs can
/// resolve it. The session writes `$BSC_REPO_ROOT` in BASH form, so comparing it against a native
/// target would never match — the gate would refuse everything. Deliberately a local copy of
/// src-tauri's `to_native_path`: that one is `pub(crate)` and the dependency direction runs
/// src-tauri → crates, so it cannot be imported here.
fn to_native_path(p: &str) -> String {
    #[cfg(windows)]
    {
        let b = p.as_bytes();
        if b.len() >= 3 && b[0] == b'/' && b[2] == b'/' && (b[1] as char).is_ascii_alphabetic() {
            let drive = (b[1] as char).to_ascii_uppercase();
            return format!("{drive}:/{}", &p[3..]);
        }
        p.to_string()
    }
    #[cfg(not(windows))]
    p.to_string()
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
            to_native_path(root_raw.trim())
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
    PathBuf::from(to_native_path(r)).canonicalize().ok()
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
#[derive(Clone, Copy)]
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
        match positional.get(1) {
            Some(name) => print!("{}", help_for(prog, tagline, cmds, name)),
            None => print!("{}", help_overview(prog, tagline, cmds)),
        }
        return true;
    }
    if positional.get(1).map(String::as_str) == Some("help") {
        print!("{}", help_for(prog, tagline, cmds, cmd));
        return true;
    }
    false
}

/// The shared **unknown-command** error string: the offending `cmd` plus the compact
/// [`help_overview`] — the exact text each `CmdDoc`-driven bin builds in its dispatch fallthrough
/// (#1862), so the message stays uniform (and in sync with the command catalog) across the CLIs.
pub fn unknown_command(prog: &str, tagline: &str, cmds: &[CmdDoc], cmd: &str) -> String {
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

#[cfg(test)]
mod tests {
    use super::*;

    // ── the `--raw` byte-clean output contract (#3166) ──────────────────────────────────────────────

    #[test]
    fn raw_line_strips_cr_and_forces_exactly_one_trailing_lf() {
        // CRLF poisoning is neutralized: every `\r\n` and lone `\r` collapses to `\n` — no carriage
        // return survives into a captured value.
        assert!(!raw_line("a\r\nb").contains('\r'));
        assert_eq!(raw_line("a\r\nb"), "a\nb\n");
        assert_eq!(raw_line("a\rb"), "a\nb\n");
        // A value with no line ending gets exactly one trailing LF...
        assert_eq!(raw_line("solo"), "solo\n");
        // ...and one that already ends in newline(s) (incl. CRLF) is collapsed to a single LF, never
        // doubled — so `$( )` capture isn't polluted by a blank trailing line.
        assert_eq!(raw_line("x\n"), "x\n");
        assert_eq!(raw_line("x\n\n\n"), "x\n");
        assert_eq!(raw_line("x\r\n"), "x\n");
    }

    #[test]
    fn raw_line_preserves_non_ascii_utf8_verbatim() {
        // The cp1252 trap: non-ASCII must ride through untouched (bytes-direct on the print side).
        assert_eq!(raw_line("café — ✓ 日本語"), "café — ✓ 日本語\n");
    }

    #[test]
    fn raw_line_carries_no_json_envelope_or_quoting() {
        // Raw is the value itself — no wrapping array/quotes a JSON envelope would add.
        let out = raw_line("plain-id");
        assert!(!out.contains('"'), "no quoting: {out:?}");
        assert!(!out.contains('[') && !out.contains(']'), "no array envelope: {out:?}");
        assert_eq!(out, "plain-id\n");
    }

    #[test]
    fn raw_lines_prints_one_item_per_lf_terminated_line() {
        // The `list --raw` shape: one id per line, LF-only, no quotes/brackets, empty ⇒ "".
        let out = raw_lines(["button", "chip", "card"]);
        assert_eq!(out, "button\nchip\ncard\n");
        assert!(!out.contains('\r'));
        assert!(!out.contains('"') && !out.contains('[') && !out.contains(']'));
        // Line count == item count (no phantom split from a stray CR in an item).
        assert_eq!(raw_lines(["a\r", "b"]).lines().count(), 2);
        assert_eq!(raw_lines::<[&str; 0], &str>([]), "");
    }

    #[test]
    fn cli_main_maps_ok_and_err_to_exit_codes() {
        // Ok ⇒ SUCCESS; Err ⇒ FAILURE (the stderr line is a side effect we don't capture here).
        assert_eq!(format!("{:?}", cli_main("bsc-x", || Ok(()))), format!("{:?}", ExitCode::SUCCESS));
        assert_eq!(
            format!("{:?}", cli_main("bsc-x", || Err("boom".into()))),
            format!("{:?}", ExitCode::FAILURE)
        );
    }

    #[test]
    fn resolve_store_path_flag_wins_verbatim() {
        // The flag beats both the env var and the default, and is taken as-is (not trimmed).
        std::env::set_var("BSC_CLI_UTIL_TEST_A", "/from/env");
        let got = resolve_store_path(&Some(" /from/flag ".into()), "BSC_CLI_UTIL_TEST_A", || {
            Err("default not reached".into())
        })
        .unwrap();
        assert_eq!(got, PathBuf::from(" /from/flag "));
        std::env::remove_var("BSC_CLI_UTIL_TEST_A");
    }

    #[test]
    fn resolve_store_path_env_is_used_and_trimmed() {
        std::env::set_var("BSC_CLI_UTIL_TEST_B", "  /from/env  ");
        let got = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_B", || Err("default not reached".into())).unwrap();
        assert_eq!(got, PathBuf::from("/from/env"), "the env value is trimmed");
        std::env::remove_var("BSC_CLI_UTIL_TEST_B");
    }

    #[test]
    fn resolve_store_path_empty_or_whitespace_env_falls_through_to_default() {
        // Both an empty and a whitespace-only env var are treated as unset → the default runs.
        std::env::set_var("BSC_CLI_UTIL_TEST_C", "   ");
        let got = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_C", || Ok(PathBuf::from("/default"))).unwrap();
        assert_eq!(got, PathBuf::from("/default"));
        std::env::set_var("BSC_CLI_UTIL_TEST_C", "");
        let got = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_C", || Ok(PathBuf::from("/default"))).unwrap();
        assert_eq!(got, PathBuf::from("/default"));
        std::env::remove_var("BSC_CLI_UTIL_TEST_C");
    }

    #[test]
    fn resolve_store_path_propagates_the_default_error() {
        // With no flag + no env, the default's Err is returned (the bsc-plan / bsc-data shape).
        std::env::remove_var("BSC_CLI_UTIL_TEST_D");
        let err = resolve_store_path(&None, "BSC_CLI_UTIL_TEST_D", || Err("no store".into())).unwrap_err();
        assert_eq!(err, "no store");
    }

    const DOCS: &[CmdDoc] = &[
        CmdDoc { name: "tree", summary: "folder structure with sizes", usage: "USAGE:\n  prog tree [path]" },
        CmdDoc { name: "stat", summary: "metrics for one path", usage: "USAGE:\n  prog stat <path>" },
    ];

    #[test]
    fn help_overview_lists_every_command_compactly() {
        let s = help_overview("bsc-x", "a test tool", DOCS);
        assert!(s.contains("bsc-x — a test tool"));
        assert!(s.contains("tree"));
        assert!(s.contains("folder structure with sizes"));
        assert!(s.contains("stat"));
        // The overview points at the per-command help (the small-context contract).
        assert!(s.contains("<command> help"));
        // It is the SUMMARY, not the full usage — detail is deferred.
        assert!(!s.contains("prog tree [path]"));
    }

    #[test]
    fn help_for_returns_one_commands_detail_or_falls_back_to_the_menu() {
        let one = help_for("bsc-x", "a test tool", DOCS, "tree");
        assert!(one.contains("bsc-x tree"));
        assert!(one.contains("prog tree [path]")); // the detailed usage block
        assert!(!one.contains("stat")); // only the asked-for command
        // An unknown command shows the overview rather than nothing.
        let miss = help_for("bsc-x", "a test tool", DOCS, "nope");
        assert!(miss.contains("COMMANDS:"));
        assert!(miss.contains("tree"));
    }

    fn pos(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn handle_help_claims_the_help_forms_and_passes_real_commands_through() {
        // No command (bare invocation) → the overview is printed and the caller returns.
        assert!(handle_help("bsc-x", "t", DOCS, &pos(&[])));
        // `help` and `help <name>` → handled.
        assert!(handle_help("bsc-x", "t", DOCS, &pos(&["help"])));
        assert!(handle_help("bsc-x", "t", DOCS, &pos(&["help", "tree"])));
        // The trailing `<cmd> help` form → handled (even for an unknown <cmd>, mirroring the inlined
        // block: `help_for` falls back to the overview for an unknown name).
        assert!(handle_help("bsc-x", "t", DOCS, &pos(&["tree", "help"])));
        assert!(handle_help("bsc-x", "t", DOCS, &pos(&["nope", "help"])));
        // A real command → NOT handled, so the caller dispatches it.
        assert!(!handle_help("bsc-x", "t", DOCS, &pos(&["tree"])));
        assert!(!handle_help("bsc-x", "t", DOCS, &pos(&["stat", "src/x"])));
    }

    #[test]
    fn scope_allows_write_in_is_unrestricted_without_a_scope_doc() {
        // Absent env (hand shells, pre-#2470 launches) ⇒ unrestricted — the back-compat contract.
        assert!(scope_allows_write_in(None, "ui"));
        // Absent KEY ⇒ unrestricted (stores adopt incrementally; an unlisted store is ungated).
        assert!(scope_allows_write_in(Some(r#"{}"#), "ui"));
        assert!(scope_allows_write_in(Some(r#"{"plan":"read"}"#), "ui"));
    }

    #[test]
    fn scope_allows_write_in_refuses_read_and_none_tiers_only() {
        assert!(!scope_allows_write_in(Some(r#"{"ui":"read"}"#), "ui"));
        assert!(!scope_allows_write_in(Some(r#"{"ui":"none"}"#), "ui"));
        assert!(scope_allows_write_in(Some(r#"{"ui":"write"}"#), "ui"));
        // The doc gates PER store: ui read-only doesn't touch another store's writes.
        assert!(scope_allows_write_in(Some(r#"{"ui":"read","skill":"write"}"#), "skill"));
    }

    #[test]
    fn scope_allows_write_in_treats_malformed_docs_as_unrestricted() {
        // Malformed JSON, a non-object doc, and a non-string tier all fall open (guards accidents,
        // never breaks a session on garbage — the launch-time deny rules are the boundary).
        assert!(scope_allows_write_in(Some("not json"), "ui"));
        assert!(scope_allows_write_in(Some(""), "ui"));
        assert!(scope_allows_write_in(Some(r#"["ui"]"#), "ui"));
        assert!(scope_allows_write_in(Some(r#"{"ui":5}"#), "ui"));
    }

    // #3382: these cases used to own the real $BSC_SCOPES env var, with a comment explaining that
    // splitting them across tests would race the shared process environment. The override is
    // thread-local, so that constraint is gone — each case is independent and they run in parallel.
    #[test]
    fn a_read_scope_refuses_the_write_and_names_why() {
        with_scopes(Some(r#"{"ui":"read"}"#), || {
            assert!(!scope_allows_write("ui"));
            assert!(scope_allows_write("plan")); // unlisted store stays unrestricted
            let err = require_write_scope("ui").unwrap_err();
            assert!(err.contains("'ui'"), "refusal names the scope: {err}");
            assert!(err.contains("BSC_SCOPES"), "refusal names the env doc: {err}");
            assert!(err.contains("read-only"), "refusal states the tier semantics: {err}");
        });
    }

    #[test]
    fn a_write_scope_permits_the_write() {
        with_scopes(Some(r#"{"ui":"write"}"#), || {
            assert!(scope_allows_write("ui"));
            assert!(require_write_scope("ui").is_ok());
        });
    }

    #[test]
    fn an_absent_scope_doc_is_unrestricted() {
        with_scopes(None, || {
            assert!(scope_allows_write("ui"), "absent doc is unrestricted (back-compat)");
            assert!(require_write_scope("ui").is_ok());
        });
    }

    #[test]
    fn with_scopes_does_not_leak_into_a_sibling_thread() {
        // THE #3382 REGRESSION GUARD. With process env this assertion was impossible to make: a
        // read-only doc set by one test was visible to every other test in the process, which is
        // exactly how an unrelated write verb started failing. A sibling thread must see its own
        // unrestricted default while THIS thread is scoped read-only.
        with_scopes(Some(r#"{"ui":"read"}"#), || {
            assert!(!scope_allows_write("ui"), "this thread is scoped read-only");
            let sibling = std::thread::spawn(|| scope_allows_write("ui"));
            assert!(
                sibling.join().unwrap(),
                "a concurrently-running thread must be unaffected by this thread's scope override",
            );
        });
    }

    #[test]
    fn with_scopes_restores_the_previous_state_including_on_panic() {
        with_scopes(Some(r#"{"ui":"read"}"#), || {
            // Nested: the inner override wins, then the outer one is restored on exit.
            with_scopes(Some(r#"{"ui":"write"}"#), || assert!(scope_allows_write("ui")));
            assert!(!scope_allows_write("ui"), "the outer read scope is restored");
            // A panicking assertion is the NORMAL failure mode of a test — it must not leak the
            // override into whatever runs next on this thread.
            let boom = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                with_scopes(Some(r#"{"ui":"none"}"#), || panic!("a failing assertion"));
            }));
            assert!(boom.is_err(), "the panic propagated");
            assert!(!scope_allows_write("ui"), "the outer read scope survived the unwind");
        });
    }

    // ── `--file` scratch resolution (#3373) — the traversal defence ────────────────────────────────

    #[test]
    fn bare_filenames_are_accepted() {
        for ok in ["payload.json", "studio-kit.json", "a", "kit.v2.json", "UPPER.JSON", "with space.json"] {
            assert!(is_bare_filename(ok), "{ok} should be a bare filename");
        }
    }

    /// Every shape that could escape the scratch dir. This is the security boundary of #3373: an
    /// unrestricted `--file` would let a write-confined session READ any file on the machine through a
    /// command its allow-list permits, so each of these must be unrepresentable, not merely unlikely.
    #[test]
    fn every_path_shaped_name_is_rejected() {
        for bad in [
            "", ".", "..",
            "../secret.json", "../../etc/passwd", "a/../../b",
            "sub/payload.json", "/etc/passwd", "/tmp/x",
            r"..\secret.json", r"sub\payload.json", r"C:\Windows\x", r"\\server\share\x",
            "C:payload.json",       // drive-relative
            "payload.json:stream",  // NTFS alternate data stream
            "pay\0load.json",       // embedded NUL
        ] {
            assert!(!is_bare_filename(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn resolve_scratch_file_joins_a_bare_name_onto_the_scratch_dir() {
        with_scratch(Some("/tmp/bsc-scratch-test"), || {
            let p = resolve_scratch_file("payload.json").unwrap();
            assert_eq!(p, std::path::Path::new("/tmp/bsc-scratch-test").join("payload.json"));
        });
    }

    #[test]
    fn resolve_scratch_file_refuses_a_path_and_says_why() {
        with_scratch(Some("/tmp/bsc-scratch-test"), || {
            let err = resolve_scratch_file("../../etc/passwd").unwrap_err();
            assert!(err.contains("BARE FILENAME"), "refusal names the rule: {err}");
            assert!(err.contains("--file payload.json"), "refusal shows the correct form: {err}");
        });
    }

    #[test]
    fn resolve_scratch_out_mirrors_the_file_side_defences_for_the_output_flag() {
        // #3713: the WRITE twin — same bare-name join, same traversal refusal, same fail-closed, worded
        // for --out.
        with_scratch(Some("/tmp/bsc-scratch-test"), || {
            assert_eq!(
                resolve_scratch_out("src.tsx").unwrap(),
                std::path::Path::new("/tmp/bsc-scratch-test").join("src.tsx"),
                "a bare name joins onto the scratch dir"
            );
            let err = resolve_scratch_out("../../etc/passwd").unwrap_err();
            assert!(err.contains("BARE FILENAME") && err.contains("--out"), "refusal names the rule + flag: {err}");
        });
        with_scratch(None, || {
            let err = resolve_scratch_out("src.tsx").unwrap_err();
            assert!(err.contains(BSC_SCRATCH_ENV), "fails closed, naming the env var: {err}");
        });
    }

    /// FAIL CLOSED: with no scratch dir the flag is refused outright. It must never resolve against the
    /// process cwd — the session does not control that, and a relative read there would sidestep the
    /// whole confinement.
    #[test]
    fn resolve_scratch_file_fails_closed_when_the_scratch_env_is_unset_or_blank() {
        with_scratch(None, || {
            let err = resolve_scratch_file("payload.json").unwrap_err();
            assert!(err.contains(BSC_SCRATCH_ENV), "refusal names the env var: {err}");
            assert!(err.contains("stdin"), "refusal points at the alternative: {err}");
        });
        with_scratch(Some("   "), || {
            assert!(resolve_scratch_file("payload.json").is_err(), "a blank scratch dir is still closed");
        });
    }

    /// `--file` is exactly "stdin, from a sealed file": a payload read through it must be byte-identical
    /// to the bytes on disk — including the multi-line content that cannot survive a heredoc.
    #[test]
    fn read_payload_from_a_file_is_byte_identical() {
        let dir = std::env::temp_dir().join(format!("bsc-scratch-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        // The shape a heredoc would have carried: real source, newlines, quotes, backslashes.
        let payload = "{\"id\":\"k/btn\",\"srcText\":\"export function B(){\\n  return <b c='x'/>;\\n}\"}";
        std::fs::write(dir.join("payload.json"), payload).unwrap();

        with_scratch(dir.to_str(), || {
            let got = read_payload(Some("payload.json")).unwrap();
            assert_eq!(got, payload, "--file must not transform the bytes");
        });
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_payload_reports_a_missing_scratch_file_with_its_resolved_path() {
        let dir = std::env::temp_dir().join(format!("bsc-scratch-missing-{}", std::process::id()));
        with_scratch(dir.to_str(), || {
            let err = read_payload(Some("nope.json")).unwrap_err();
            assert!(err.contains("cannot read --file"), "names the failure: {err}");
            assert!(err.contains("nope.json"), "names the file: {err}");
        });
    }

    #[test]
    fn unknown_command_names_the_command_and_appends_the_overview() {
        let msg = unknown_command("bsc-x", "a test tool", DOCS, "bogus");
        assert!(msg.starts_with("unknown command 'bogus'"));
        // It carries the full compact overview so the message stays in sync with the catalog.
        assert_eq!(msg, format!("unknown command 'bogus'\n\n{}", help_overview("bsc-x", "a test tool", DOCS)));
        assert!(msg.contains("COMMANDS:"));
        assert!(msg.contains("tree"));
    }

    // ── FS confinement for caller-named directories (#3475/#158) ────────────────────────────────────
    /// A unique, EMPTY scratch root. Named with the pid AND a counter, and removed first: pids are
    /// recycled, and a fixture that inherits a previous run's directory is exactly the #3382 flake.
    fn tmp_root(tag: &str) -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let d = std::env::temp_dir().join(format!(
            "bsc-confine-{}-{}-{tag}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn an_absent_or_empty_root_leaves_the_session_unconfined() {
        // Back-compat: a plain console and a direct CLI run set no root and must be unchanged.
        with_repo_root(None, || assert!(require_harvestable_root(&tmp_root("unset")).is_ok()));
        with_repo_root(Some(""), || assert!(require_harvestable_root(&tmp_root("empty")).is_ok()));
        with_repo_root(Some("   "), || assert!(require_harvestable_root(&tmp_root("blank")).is_ok()));
    }

    #[test]
    fn a_target_inside_the_root_is_allowed_including_the_root_itself() {
        let root = tmp_root("inside");
        let child = root.join("a").join("b");
        std::fs::create_dir_all(&child).unwrap();
        with_repo_root(Some(&root.to_string_lossy()), || {
            assert!(require_harvestable_root(&root).is_ok(), "the root itself");
            assert!(require_harvestable_root(&child).is_ok(), "a nested dir");
        });
    }

    #[test]
    fn a_target_outside_the_root_is_refused_and_the_error_names_both_paths() {
        let root = tmp_root("root");
        let outside = tmp_root("outside");
        with_repo_root(Some(&root.to_string_lossy()), || {
            let err = require_harvestable_root(&outside).unwrap_err();
            assert!(err.contains("outside every root this session may harvest"), "{err}");
            assert!(err.contains("#158"), "cites the confinement: {err}");
        });
    }

    #[test]
    fn session_env_snapshot_surfaces_the_harvest_roots_a_confined_session_cannot_otherwise_see() {
        // #3571: the whole point — a designer session cwd'd in its own workspace learns the app source
        // tree (its granted extra root) from this, then harvests it.
        with_scratch(Some("C:/ws/scratch"), || {
            with_scopes(Some(r#"{"ui":"read"}"#), || {
                with_repo_root(Some("C:/ws/design-studio"), || {
                    with_harvest_roots(Some("C:/src/base-studio-code\nC:/src/other"), || {
                        let s = session_env_snapshot();
                        assert_eq!(s.scratch.as_deref(), Some("C:/ws/scratch"));
                        assert_eq!(s.scopes.as_deref(), Some(r#"{"ui":"read"}"#));
                        assert_eq!(s.repo_root.as_deref(), Some("C:/ws/design-studio"));
                        assert_eq!(
                            s.harvest_roots,
                            vec!["C:/src/base-studio-code".to_string(), "C:/src/other".to_string()],
                        );
                        // Gate order: the confinement root first, then the extra harvest roots.
                        assert_eq!(
                            s.harvestable_roots(),
                            vec!["C:/ws/design-studio", "C:/src/base-studio-code", "C:/src/other"],
                        );
                        let report = format_session_env("bsc ui");
                        assert!(report.contains("C:/src/base-studio-code"), "names the app root:\n{report}");
                        // The closing hint gives the exact verb + prefers the app tree (an extra root).
                        assert!(
                            report.contains("bsc ui harvest C:/src/base-studio-code"),
                            "actionable hint:\n{report}",
                        );
                    });
                });
            });
        });
    }

    #[test]
    fn session_env_report_reads_gracefully_when_unconfined() {
        // A plain console / direct CLI run sets none of these; the report says so rather than erroring.
        with_scratch(None, || {
            with_scopes(None, || {
                with_repo_root(None, || {
                    with_harvest_roots(None, || {
                        let s = session_env_snapshot();
                        assert!(s.scratch.is_none() && s.scopes.is_none());
                        assert!(s.repo_root.is_none() && s.harvest_roots.is_empty());
                        assert!(s.harvestable_roots().is_empty());
                        let report = format_session_env("bsc ui");
                        assert!(report.contains("unconfined"), "{report}");
                    });
                });
            });
        });
    }

    #[test]
    fn dotdot_cannot_walk_out_of_the_root() {
        // THE bypass that matters: without canonicalizing, `<root>/sub/../..` compares as a prefix of
        // the root string and would sail straight through.
        let root = tmp_root("dotdot");
        let sub = root.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        with_repo_root(Some(&root.to_string_lossy()), || {
            assert!(require_harvestable_root(&sub.join("..").join("..")).is_err(), "escaped via ..");
            assert!(require_harvestable_root(&sub.join("..")).is_ok(), "..-back-to-root is still inside");
        });
    }

    #[test]
    fn a_root_that_cannot_be_resolved_fails_closed() {
        // A misconfigured confinement must NOT silently degrade into no confinement at all.
        let target = tmp_root("failclosed");
        with_repo_root(Some("/no/such/confinement/root/anywhere"), || {
            let err = require_harvestable_root(&target).unwrap_err();
            assert!(err.contains("cannot be resolved"), "{err}");
        });
    }

    #[test]
    fn the_repo_root_override_does_not_leak_into_a_sibling_thread() {
        // The #3382 guarantee, restated for this seam: parallel test threads must not see each other's
        // override. Impossible to assert against process env, which is why the seam is thread-local.
        let root = tmp_root("thread");
        let outside = tmp_root("thread-outside");
        let probe = outside.clone();
        with_repo_root(Some(&root.to_string_lossy()), || {
            assert!(require_harvestable_root(&outside).is_err(), "this thread is confined");
            let sibling = std::thread::spawn(move || require_harvestable_root(&probe).is_ok());
            assert!(sibling.join().unwrap(), "a sibling thread must be unconfined");
        });
    }

    // ── READ-only harvest roots, separate from the write confinement (#3509) ───────────────────────
    #[test]
    fn a_listed_harvest_root_is_allowed_even_though_it_is_outside_the_confinement_root() {
        // THE point of #3509. The designer's root is its studio dir, which holds no source, so tying
        // harvest to the WRITE root left it unable to mine anything. Harvest is a READ; this grants it
        // without touching where the session may write.
        let root = tmp_root("hr-root");
        let elsewhere = tmp_root("hr-elsewhere");
        with_repo_root(Some(&root.to_string_lossy()), || {
            assert!(require_harvestable_root(&elsewhere).is_err(), "refused before it is listed");
            with_harvest_roots(Some(&elsewhere.to_string_lossy()), || {
                assert!(require_harvestable_root(&elsewhere).is_ok(), "allowed once listed");
            });
        });
    }

    #[test]
    fn a_target_outside_both_is_still_refused_and_the_error_names_every_allowed_root() {
        let root = tmp_root("hr2-root");
        let listed = tmp_root("hr2-listed");
        let other = tmp_root("hr2-other");
        with_repo_root(Some(&root.to_string_lossy()), || {
            with_harvest_roots(Some(&listed.to_string_lossy()), || {
                let err = require_harvestable_root(&other).unwrap_err();
                assert!(err.contains("outside every root this session may harvest"), "{err}");
                assert!(err.contains("$BSC_HARVEST_ROOTS"), "points at the remedy: {err}");
            });
        });
    }

    #[test]
    fn several_roots_are_newline_separated_and_each_grants_its_own_subtree() {
        let root = tmp_root("hr3-root");
        let a = tmp_root("hr3-a");
        let b = tmp_root("hr3-b");
        let nested = b.join("deep").join("er");
        std::fs::create_dir_all(&nested).unwrap();
        let list = format!("{}
{}", a.display(), b.display());
        with_repo_root(Some(&root.to_string_lossy()), || {
            with_harvest_roots(Some(&list), || {
                assert!(require_harvestable_root(&a).is_ok());
                assert!(require_harvestable_root(&nested).is_ok(), "a subtree of a listed root");
            });
        });
    }

    #[test]
    fn an_unresolvable_harvest_entry_grants_nothing_rather_than_widening_access() {
        // An ALLOW-list only ever widens, so a junk entry must be SKIPPED — that is its fail-closed
        // direction. (The CONFINEMENT root is the opposite: unresolvable there is a hard error.)
        let root = tmp_root("hr4-root");
        let outside = tmp_root("hr4-outside");
        with_repo_root(Some(&root.to_string_lossy()), || {
            with_harvest_roots(Some("/no/such/root

   "), || {
                assert!(require_harvestable_root(&outside).is_err(), "junk grants nothing");
                assert!(require_harvestable_root(&root).is_ok(), "the real root still works");
            });
        });
    }

    #[test]
    fn dotdot_cannot_escape_a_listed_harvest_root_either() {
        let root = tmp_root("hr5-root");
        let listed = tmp_root("hr5-listed");
        let sub = listed.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        with_repo_root(Some(&root.to_string_lossy()), || {
            with_harvest_roots(Some(&listed.to_string_lossy()), || {
                assert!(require_harvestable_root(&sub).is_ok());
                assert!(require_harvestable_root(&sub.join("..").join("..")).is_err(), "escaped via ..");
            });
        });
    }

    #[test]
    fn harvest_roots_do_not_touch_the_write_gate() {
        // The whole proposal is read-only. Listing a root must not make a read-only scope writable.
        let listed = tmp_root("hr6-listed");
        with_harvest_roots(Some(&listed.to_string_lossy()), || {
            with_scopes(Some(r#"{"ui":"read"}"#), || {
                assert!(!scope_allows_write("ui"), "still read-only");
                assert!(require_write_scope("ui").is_err());
            });
        });
    }

    #[test]
    fn the_harvest_override_does_not_leak_into_a_sibling_thread() {
        let root = tmp_root("hr7-root");
        let listed = tmp_root("hr7-listed");
        let probe = listed.clone();
        let root_s = root.to_string_lossy().into_owned();
        let root_for_sibling = root_s.clone();
        with_repo_root(Some(&root_s), || {
            with_harvest_roots(Some(&listed.to_string_lossy()), || {
                assert!(require_harvestable_root(&listed).is_ok(), "this thread may harvest it");
                let sibling = std::thread::spawn(move || {
                    with_repo_root(Some(&root_for_sibling), || require_harvestable_root(&probe).is_err())
                });
                assert!(sibling.join().unwrap(), "a sibling thread must NOT inherit the allow-list");
            });
        });
    }
}
