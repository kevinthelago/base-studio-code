//! `bsc-util` (#1646) — the tiny, dependency-free home for the few primitives that were
//! copy-pasted (with subtly divergent behavior) across the desktop app and the `bsc-*` CLIs:
//!
//!   - [`home_dir`] / [`bsc_base_dir`] — resolve the user's home and the
//!     `~/.base-studio-code` base dir. **ONE precedence**, so the app and every CLI agree on
//!     which store they read/write (see the latent Windows bug fixed below).
//!   - [`now_secs`] / [`now_ms`] — the epoch clock (formerly re-implemented in
//!     `compliance`, `research`, `bsc-agent`, `perf`).
//!   - [`epoch_ms_to_iso8601`] / [`iso8601_to_epoch_ms`] — the civil-date pair (Howard
//!     Hinnant's algorithm, no `chrono`/`time` dep), formerly split between
//!     `logs::days_from_civil` and `bsc-agent`'s `epoch_to_iso8601`.
//!
//! Pure (no I/O beyond reading env vars), std-only, so it links into the leanest CLI for free.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

pub use sidecars::{Sidecar, CHANNEL_MOCK_MCP, COMPLIANCE_MCP, RESEARCH_MCP, SIDECARS};

/// **This app's own project key** — the hub its own faults and plan live under.
///
/// base-studio-code is developed as a project of itself: `projects/studio-code/` is a real hub with a
/// real plan store, and the repo's whole workflow is written against that name. So when the app files
/// a fault ABOUT ITSELF — a build that failed, a boot that never mounted — this is the project it
/// belongs to, which is also what makes the existing pipeline carry it: Glance renders a project
/// node's health from its unresolved faults, with no new machinery (#4008).
///
/// It is a constant rather than a literal because two independent producers write it — the boot
/// watchdog in Rust and the `--project` flag in `package.json`'s wrapped build commands — and a
/// disagreement between them would split the app's own faults across two stores, each looking empty
/// from the other. `the_self_project_key_matches_the_wired_npm_scripts` pins them together.
///
/// OPEN QUESTION, deliberately not settled here: on an END USER's machine this mints a hub named
/// `studio-code` for a project they never created. The fault is genuinely about the app, so it has to
/// live somewhere; whether that somewhere should be a project node they can see is a product decision,
/// not a mechanical one. Recorded on `epic-a-build-or-launch-failure-leaves-no-record`.
pub const SELF_PROJECT_KEY: &str = "studio-code";

pub use divergence::{divergence_line, emit_divergence, emit_divergence_to, DIVERGENCE_ENV};
pub use log_streams::{LogStream, LOG_STREAMS};

pub use models::{is_model_id, model_alias, model_id_list, model_ids, ModelTier, MODEL_TIERS};










/// The user's home directory, resolved WITHOUT a `dirs`/`home` crate.
///
/// # Precedence (the fix for #1646)
/// On Windows: `USERPROFILE`, then `HOME`. On Unix: `HOME`.
///
/// This deliberately matches what the **desktop app** (`platform/paths.rs`) has always
/// resolved, because real installs already persist `~/.base-studio-code` under that path. The
/// `bsc-*` CLIs previously resolved `HOME`-first on every platform, so under **Git Bash on
/// Windows** (which sets `HOME` to an MSYS path) the app and the CLIs landed on *different*
/// `~/.base-studio-code` dirs and silently read/wrote separate stores. Unifying on the app's
/// order keeps every process pointed at the one store users already have data in — choosing the
/// CLIs' order instead would orphan that data. Empty values are treated as unset (so an empty
/// `USERPROFILE` falls through to `HOME` on Windows).
///
/// Returns `None` when no usable home variable is set.
pub fn home_dir() -> Option<PathBuf> {
    let pick = |key: &str| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    };
    if cfg!(windows) {
        pick("USERPROFILE").or_else(|| pick("HOME"))
    } else {
        pick("HOME")
    }
}

/// The `~/.base-studio-code` base directory — the root of every app/CLI on-disk store
/// (projects, logs, skills.db, compliance, research cache, …). `None` when [`home_dir`] is unset.
pub fn bsc_base_dir() -> Option<PathBuf> {
    home_dir().map(|h| h.join(".base-studio-code"))
}

/// The file `bsc say` publishes a speaking deadline into, so `bsc ear` can decline to record it.
///
/// It lives here rather than in either crate because BOTH need it and neither should depend on the
/// other: the ear would drag ONNX Runtime into its build for a path, and the mouth would drag ALSA
/// into its own. A shared constant is the cheapest thing that keeps them agreeing.
///
/// The contents are a single Unix-millisecond deadline. A deadline rather than a lock, because a
/// crashed or killed speaker must not leave the ear deaf forever — an expired deadline simply
/// stops mattering, where a lock file would have to be cleaned up by the process least able to.
pub fn speaking_flag_path() -> Option<PathBuf> {
    bsc_base_dir().map(|b| b.join("say-speaking"))
}

/// Current Unix time in **seconds** (0 if the clock is before the epoch).
pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Current Unix time in **milliseconds** (0 if the clock is before the epoch).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Epoch **milliseconds** → `YYYY-MM-DDTHH:MM:SSZ` (UTC, second resolution), no external crate.
///
/// Uses Howard Hinnant's civil-from-days algorithm so timestamps match the `bsc-*` helpers'
/// `date -u +%Y-%m-%dT%H:%M:%SZ` output. Sub-second precision is dropped (the format has none).
pub fn epoch_ms_to_iso8601(ms: i64) -> String {
    let secs = ms.div_euclid(1_000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (h, mi, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// `YYYY-MM-DDTHH:MM:SSZ` (UTC) → epoch **milliseconds**, the inverse of [`epoch_ms_to_iso8601`].
/// Returns `None` on a malformed value. (The seconds field defaults to `00` if absent; a trailing
/// `Z` is optional.)
pub fn iso8601_to_epoch_ms(ts: &str) -> Option<i64> {
    let ts = ts.trim();
    let (date, time) = ts.split_once('T')?;
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    let time = time.trim_end_matches('Z');
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let s: i64 = t.next().unwrap_or("0").parse().ok()?;
    let days = days_from_civil(y, mo, da);
    Some((days * 86_400 + h * 3_600 + mi * 60 + s) * 1_000)
}

/// Format one UI-activity TSV line (#2525/#3545) — the pure, testable core of [`emit_ui_activity`] /
/// [`emit_ui_focus`]. Columns: `ts \t pane \t <kind> \t <collection> \t <id>\n` where `kind` is
/// `ui-touch` (a WRITE — drives focus + re-hydrate) or `ui-focus` (a READ — drives focus only). The same
/// `ts·pane·kind·…` shape the coord emitters write, so `bsc logs tail ui` reads it uniformly. Trailing
/// newline included.
/// `kit` is the OPTIONAL 6th column (#live-focus-is-kit-filtered): the kit the touched record belongs
/// to. Empty ⇒ the column is omitted entirely rather than written blank, so a line for a collection
/// that has no kit (theme / variant / the kits themselves) keeps its historical 5-column shape and the
/// file stays uniform. The reader's length check is `>= 5`, so both widths parse and an existing
/// `ui-activity.log` is not orphaned by this column appearing.
///
/// It rides the LINE rather than being resolved by the reader because the reader's lookup misses
/// exactly the newest work: a record written moments ago is not in the app's hydrated copy yet, and
/// that is precisely the touch worth following.
pub fn ui_activity_line(ts: &str, pane: &str, kind: &str, collection: &str, id: &str, kit: &str) -> String {
    if kit.is_empty() {
        format!("{ts}\t{pane}\t{kind}\t{collection}\t{id}\n")
    } else {
        format!("{ts}\t{pane}\t{kind}\t{collection}\t{id}\t{kit}\n")
    }
}

/// Append a `ui-touch` activity line for `(collection, id)` to `$BSC_UI_ACTIVITY_LOG` (#2525) — the
/// designer session's live-focus signal, fired by the `bsc ui set/remove` mutation paths right after
/// the ui-scope gate passes and the store write lands. A **no-op when the env var is absent or empty**
/// (hand shells / non-designer sessions never write it), so it's safe to call unconditionally. The
/// pane column is `$BSC_AUDIT_PANE` (else `?`); the timestamp is [`now_ms`] → [`epoch_ms_to_iso8601`],
/// matching the `bsc-*` helpers' `date -u +%Y-%m-%dT%H:%M:%SZ`. Best-effort: a write failure is
/// swallowed (activity signalling must never break a store mutation).
pub fn emit_ui_activity(collection: &str, id: &str) {
    emit_ui_line("ui-touch", collection, id, "");
}

/// [`emit_ui_activity`] carrying the record's KIT — the activity line's 6th column. Use this wherever
/// the kit is known at the write site; the Design Studio follows it to show work in a kit other than
/// the one on screen, including for a record it has not hydrated yet.
pub fn emit_ui_activity_in(collection: &str, id: &str, kit: &str) {
    emit_ui_line("ui-touch", collection, id, kit);
}

/// Append a `ui-focus` activity line for `(collection, id)` to `$BSC_UI_ACTIVITY_LOG` (#3545) — the
/// designer session's live-focus signal for a READ (`bsc ui get`/`preview-props`), so the Design Studio
/// preview follows the node Claude is INSPECTING, not only one it writes. Unlike [`emit_ui_activity`]
/// (`ui-touch`), the frontend drives this into focus WITHOUT re-hydrating the library — a read changed
/// nothing to reload. Same no-op-when-unwired + best-effort contract as [`emit_ui_activity`].
pub fn emit_ui_focus(collection: &str, id: &str) {
    emit_ui_line("ui-focus", collection, id, "");
}

/// [`emit_ui_focus`] carrying the record's KIT — see [`emit_ui_activity_in`].
pub fn emit_ui_focus_in(collection: &str, id: &str, kit: &str) {
    emit_ui_line("ui-focus", collection, id, kit);
}

/// Shared body of [`emit_ui_activity`] / [`emit_ui_focus`] — resolve the log path + pane and append one
/// line of the given `kind`. No-op when `$BSC_UI_ACTIVITY_LOG` is absent/empty (non-designer sessions).
fn emit_ui_line(kind: &str, collection: &str, id: &str, kit: &str) {
    let path = match std::env::var_os("BSC_UI_ACTIVITY_LOG") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => return, // no activity stream wired — hand shell / non-designer session
    };
    let pane = std::env::var("BSC_AUDIT_PANE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "?".to_string());
    let line = ui_activity_line(&epoch_ms_to_iso8601(now_ms()), &pane, kind, collection, id, kit);
    append_line(&path, &line);
}

/// Append `line` to `path`, creating the parent dir if needed. Best-effort (errors ignored).
pub fn append_line(path: &std::path::Path, line: &str) {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = f.write_all(line.as_bytes());
    }
}

/// Days since the Unix epoch for a civil (y, m, d) date — Howard Hinnant's algorithm (no deps).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Derive a record's FOLDER — a nested, `/`-delimited path — from the source file it was harvested
/// from (#3579 for components, #4107 for algorithms).
///
/// Both libraries organize like a real project's folders (`shared/ui/controls`, `features/github`), and
/// both derive that from the same input, so this is ONE definition rather than two that can drift. It
/// lives here for exactly the reason this crate exists: it was about to be copy-pasted into a second
/// crate. `bsc-component` (harvest + `bsc ui regroup`) and `bsc-graph` (`curate` + `bsc graph refolder`)
/// both call it, so a component and an algorithm harvested from the same tree land in the same folder.
///
/// Normalizes `\` to `/`, drops the filename, and strips a leading `src/` root (harvested paths carry
/// it, some kits' don't) for a consistent tree. Returns `None` when `src` has no usable directory — a
/// bare filename, an empty string, or a file directly under the `src/` root — so such a record is left
/// UNFOLDERED rather than bucketed under `""`.
///
/// Examples:
/// - `src/shared/ui/controls/Button.tsx` → `Some("shared/ui/controls")`
/// - `crates/bsc-graph/src/extract.rs`   → `Some("crates/bsc-graph/src")`
/// - `src/Widget.tsx` / `Widget.tsx` / `""` → `None`
pub fn folder_from_src(src: &str) -> Option<String> {
    let norm = src.trim().replace('\\', "/");
    let (dir, _file) = norm.rsplit_once('/')?; // no directory ⇒ unfoldered
    let segs: Vec<&str> = dir.split('/').filter(|s| !s.is_empty()).collect();
    let start = usize::from(segs.first() == Some(&"src")); // strip a leading `src/` root segment
    let path = segs[start..].join("/");
    if path.is_empty() { None } else { Some(path) }
}

// ── colocated test pairing (#4126) — SHARED by both libraries ─────────────────────────────────
// Moved here from `bsc_ui::tests_harvest` (#3907) when the algorithms library needed the same
// pairing, for the reason `folder_from_src` lives here: two libraries deriving the same thing from
// the same input must not drift. `bsc_ui::tests_harvest` delegates rather than keeping a copy.

/// The colocated test path for a root-relative module `src`, if one exists under `root`.
///
/// `shared/lib/algorithms/orderByRank.ts` → `…/orderByRank.test.ts`. `None` for a `src` with no known
/// extension (a DIRECTORY-shaped path — the #3892 harvest defect) or when no sibling test is on disk.
///
/// RUST pairs with ITSELF (#4146). Its tests are an INLINE `#[cfg(test)] mod tests` in the SAME file, so
/// there is no sibling to find — and looking for one reported every Rust impl as untested, which made the
/// Rust kit's coverage structurally dishonest (it could not tell "untested" from "tested where we do not
/// look"). All 18 Rust impls carrying a `src` had an inline test module and none could ever pair.
///
/// The pointer form, not extraction: `tests` is a POINTER to where the tests live, and for Rust that is
/// this file. `src == the impl's own src` is exactly what tells a reader the tests are inline, so the
/// record stays honest without teaching this crate to parse Rust test blocks.
pub fn test_path_for(root: &std::path::Path, src: &str) -> Option<std::path::PathBuf> {
    if src.ends_with(".rs") {
        let p = root.join(src);
        return has_inline_rust_tests(&p).then_some(p);
    }
    let (stem, _) =
        [".tsx", ".ts", ".jsx", ".js"].iter().find_map(|e| src.strip_suffix(*e).map(|s| (s, *e)))?;
    for ext in [".test.tsx", ".test.ts"] {
        let p = root.join(format!("{stem}{ext}"));
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

/// Does `path` contain a real inline Rust test (#4146)?
///
/// BOTH markers are required. `#[cfg(test)]` alone also covers test-only `use` statements and helper
/// modules, so keying on it would pair files that contain no test; `#[test]` is the marker of an actual
/// test function. An unreadable file is not a test — never a pairing on a guess.
fn has_inline_rust_tests(path: &std::path::Path) -> bool {
    std::fs::read_to_string(path)
        .map(|c| c.contains("#[cfg(test)]") && c.contains("#[test]"))
        .unwrap_or(false)
}

/// The carried `ext` facet for a test read from `path` (#148): the file's REAL extension, in the
/// `.ts`/`.tsx`/`.js`/`.jsx` form the emitter's `ext` field expects (`scripts/emit-records.mjs`
/// `extFor`/its `/^\.[jt]sx?$/` validator).
///
/// A writer that reads a test's `src` from an actual file already knows this for free — the path it
/// just read is right there — so it should never leave the emitter to GUESS from the body. The guess
/// (`extFor`) treats any `<Tag>`-shaped substring as JSX, and an ordinary TypeScript generic like
/// `<T>(a: readonly T[])` matches that just as well as a real element: the test is re-emitted as
/// `.tsx` and vitest runs it in the `dom` project instead of `node` — still green, silently ~35x
/// slower. `None` for a path with no extension or one the emitter does not model, so a caller falls
/// back to the emitter's guess exactly as it did before this field existed.
pub fn test_source_ext(path: &std::path::Path) -> Option<String> {
    let ext = path.extension()?.to_str()?;
    matches!(ext, "ts" | "tsx" | "js" | "jsx").then(|| format!(".{ext}"))
}

/// A test file's display name: its FIRST top-level `describe("…")` title, else the file's basename.
///
/// The title is what a reader recognises; the basename is the honest fallback for a file that opens
/// straight into `it(…)`.
pub fn test_display_name(path: &std::path::Path, contents: &str) -> String {
    if let Some(title) = first_describe_title(contents) {
        return title;
    }
    path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

/// The string literal of the first `describe(` call — single, double, or backtick quoted.
fn first_describe_title(src: &str) -> Option<String> {
    let at = src.find("describe(")?;
    let rest = &src[at + "describe(".len()..];
    let mut chars = rest.char_indices().skip_while(|(_, c)| c.is_whitespace());
    let (start, quote) = chars.next().filter(|(_, c)| matches!(c, '"' | '\'' | '`'))?;
    let body = &rest[start + quote.len_utf8()..];
    // A backslash escapes the next char, so an escaped quote does not close the literal.
    let mut out = String::new();
    let mut it = body.chars();
    while let Some(c) = it.next() {
        match c {
            '\\' => {
                if let Some(n) = it.next() {
                    out.push(n);
                }
            }
            c if c == quote => return Some(out),
            c => out.push(c),
        }
    }
    None
}

// ── CLI output capture (#4152) ──────────────────────────────────────────────────────────────────
//
// A WARM `bsc` has to hand each request its own output, but the CLI writes straight to stdout in ~311
// places. Refactoring every one onto an injectable sink would be enormous — and unnecessary, because the
// hot reads all funnel through a handful of SHARED helpers (`print_json` alone has 62 callers). Those
// helpers route through here instead, so a verb becomes servable without touching its own code.
//
// THREAD-LOCAL on purpose. The capture must never leak between concurrent callers: a serve loop
// capturing on its own thread cannot swallow output another thread is writing, and a normal one-shot run
// (no sink set) prints exactly as it always did — byte for byte, which is what makes the two paths
// interchangeable.

use std::cell::RefCell;

thread_local! {
    /// The active capture buffer for THIS thread, or `None` when output goes to stdout as usual.
    static OUT_SINK: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Emit `s` followed by a newline — to the active capture sink, else stdout. The `println!` of the
/// shared print helpers.
pub fn emit_line(s: &str) {
    emit_with(s, true);
}

/// Emit `s` with NO trailing newline — to the active capture sink, else stdout. The `print!` of the
/// shared helpers (`print_raw`, whose whole point is byte-exact output for `$( )` capture).
pub fn emit(s: &str) {
    emit_with(s, false);
}

fn emit_with(s: &str, newline: bool) {
    let captured = OUT_SINK.with(|sink| {
        let mut sink = sink.borrow_mut();
        if let Some(buf) = sink.as_mut() {
            buf.push_str(s);
            if newline {
                buf.push('\n');
            }
            true
        } else {
            false
        }
    });
    if !captured {
        use std::io::Write;
        let mut out = std::io::stdout();
        let _ = if newline { writeln!(out, "{s}") } else { write!(out, "{s}") };
    }
}

/// Run `f` with this thread's print-helper output captured, returning its result and everything emitted.
///
/// NESTS correctly: an inner capture takes only its own output and the outer buffer is restored intact,
/// so a served verb that internally captures cannot swallow the request's own output. The sink is
/// restored even if `f` panics only insofar as the guard runs — callers that catch panics should treat a
/// captured buffer as undefined rather than partial.
pub fn capture_output<R>(f: impl FnOnce() -> R) -> (R, String) {
    let prev = OUT_SINK.with(|s| s.replace(Some(String::new())));
    let result = f();
    let captured = OUT_SINK.with(|s| s.replace(prev)).unwrap_or_default();
    (result, captured)
}

/// Is output currently being captured on this thread? Lets a caller refuse to serve a verb it cannot
/// capture, rather than letting stray output corrupt a protocol stream.
pub fn is_capturing() -> bool {
    OUT_SINK.with(|s| s.borrow().is_some())
}

/// Commands a WARM `bsc serve` process may answer (#4152).
///
/// READ-ONLY and PROJECT-LESS, both load-bearing: a write would need per-request store env a warm
/// process cannot safely switch (env is process-global), and a served verb's output must funnel through
/// the shared print helpers or it would corrupt the protocol stream it shares with stdout.
///
/// Defined HERE so the serve loop and the desktop client that routes to it cannot disagree — a client
/// that sent something the server refuses would stall a call that should simply have been spawned.
///
/// # Why FULL verb paths, never a prefix
///
/// A read sits directly beside its writes: `skill group list` next to `skill group add`, `project link
/// list` next to `project link remove`, `project db list` next to `project db state`. Matching on
/// `("skill", "group")` would hand the warm child a write it must never answer. So every entry names the
/// COMPLETE verb, and a request matches only when it leads with exactly those tokens.
///
/// # Why each entry was ADDED, not assumed
///
/// #the-warm-bsc-answers-the-boot-reads-too widened this from `bsc ui` alone after `bsc perf spawns`
/// found the app issuing EIGHTEEN process launches in one second on every page load, most of them
/// project-less store lists that this loop already knew how to answer at ~10ms. Each verb below was
/// confirmed by reading its owning crate:
///
/// - `persona list` · `teams list` · `blueprint list` — the shared `bsc-json-store` CLI, whose `list`
///   branch emits via `print_json`. Its `get` branch does NOT (a plain `println!` on the non-`--raw`
///   path), which is exactly why `get` is absent here.
/// - `skill list` · `skill group list` — `skilldb`'s CLI prints only through `print_json`.
/// - `project db list` — already on `bsc_sqlite_util::print_json`.
/// - `project link list` — was raw `println!` on both its JSON and human branches; moved onto the
///   shared helpers in the same change that added it here.
/// - `ui scan-cache get` — the last spawn left at boot once the burst went warm
///   (#the-scan-cache-read-is-the-last-boot-spawn). Same story: raw `println!`, moved onto
///   `print_json` in the change that listed it. Its `put`/`clear` siblings are writes and stay off.
/// - `request list` — `bsc-request`'s store is GLOBAL (`requests.db` via `$BSC_REQUEST_DB`), so there
///   is no per-project env for a warm child to switch. Its `list` emitted through
///   `bsc_cli_util::emit`, which was a raw `println!`; that helper moved onto `bsc_util::emit_line` in
///   the same change that listed this verb — the third time this exact fix has been needed, which is
///   why it was fixed in the SHARED helper rather than in one more crate. Measured at 312 spawns /
///   94.4s in one session (#request-list-cannot-be-warm-served-until-it-stops-using-println). Its
///   `resolve`/`note`/`claim`/`prune`/`remove` siblings are writes and stay off.
///
/// Adding a verb without reading its crate is the one mistake that breaks the warm child for every
/// later request on it, so the list is deliberately tedious to extend.
pub fn is_servable_warm(args: &[String]) -> bool {
    /// `bsc ui` keeps its own sub-list: every one of these is a read, and `get` there (unlike the
    /// json-store `get`) is capture-safe.
    const UI_SUBS: &[&str] = &["list", "kit", "theme", "variants", "usage", "shapes", "get"];
    /// Complete verb paths — see the note above on why these are not prefixes.
    const SERVABLE: &[&[&str]] = &[
        &["persona", "list"],
        &["teams", "list"],
        &["blueprint", "list"],
        &["skill", "list"],
        &["skill", "group", "list"],
        &["project", "link", "list"],
        &["project", "db", "list"],
        &["request", "list"],
        // The command-surface catalog (`epic-command-surfaces-are-nodes`). The strongest warm candidate
        // in the table: it reads no store at all — the catalog is a `const` compiled into this binary —
        // so it is project-less by construction and cannot go stale within a process's life. Glance asks
        // for it on every graph build, which is exactly the shape #4152 exists for.
        &["surface", "list"],
        // A `ui` verb one level deeper than `UI_SUBS` can express
        // (#the-scan-cache-read-is-the-last-boot-spawn). The COMPLETE three tokens, never
        // `["ui","scan-cache"]`: the bare form defaults to `get`, but a two-token entry would also
        // match `ui scan-cache put` — a write, and the highest-volume call in the whole log.
        &["ui", "scan-cache", "get"],
    ];

    // The full-path table is consulted FIRST so a `ui` verb can be named by its complete path. This
    // used to early-return on `ui`, which meant the two mechanisms could not compose and
    // `ui scan-cache get` was inexpressible — the sub-list would answer for the whole command and
    // reject it. The `ui` sub-list is now the FALLBACK, so its existing surface is unchanged.
    if SERVABLE
        .iter()
        .any(|verb| args.len() >= verb.len() && args.iter().zip(verb.iter()).all(|(a, v)| a == v))
    {
        return true;
    }
    args.first().is_some_and(|c| c == "ui") && args.get(1).is_some_and(|s| UI_SUBS.contains(&s.as_str()))
}

/// The OWNERSHIP baseline — the group everything may depend on, in BOTH graphs.
pub const FEATURE_CORE: &str = "core";

/// The app SHELL's own group: it composes every feature and belongs to none.
///
/// Separate from [`FEATURE_CORE`] on purpose. The shell may depend on features (it mounts them), which
/// is exactly what the baseline may not do — folding the two together would make that legal for `core`
/// and lose the one asymmetry the ownership rule rests on.
pub const FEATURE_SHELL: &str = "shell";

/// Derive which FEATURE owns a record from its folder path, or `None` when the folder does not say.
///
/// ONE definition, shared by both graphs — the components store (`bsc ui features`) and the algorithms
/// store (`bsc graph features`) — for the same reason [`folder_from_src`] is shared: two copies of a
/// derivation are two answers waiting to disagree. Both stores organize by the same tree, measured:
/// components under `shared/ui/controls`, `features/glance`; impls under `shared/lib/fleet`,
/// `features/designs/lib`, `app/console/lib`.
///
/// - `shared/**`, `components/**`, `src/components/**` → [`FEATURE_CORE`] — usable anywhere
/// - `app/**`                                          → [`FEATURE_SHELL`]
/// - `features/<x>/**`                                 → `<x>`
///
/// `None` for anything else, INCLUDING an empty folder — and that is the important half. Records with
/// no folder exist in both stores (44 hollow components; 36 impls), and bucketing them under a default
/// would hide a data-quality question inside a migration. An unplaced record is reported, never guessed.
pub fn feature_from_folder(folder: &str) -> Option<String> {
    let f = folder.trim().trim_start_matches("./").replace('\\', "/");
    let f = f.trim_start_matches('/');
    if f.is_empty() {
        return None;
    }
    // `src/` is a root, not a segment: `src/components/ui` is the same place as `components/ui`.
    let f = f.strip_prefix("src/").unwrap_or(f);
    let mut segs = f.split('/').filter(|s| !s.is_empty());
    match segs.next()? {
        "shared" | "components" => Some(FEATURE_CORE.to_string()),
        "app" => Some(FEATURE_SHELL.to_string()),
        // `store/**` is a top-level architectural directory beside app/features/shared — the Zustand
        // COMPOSITION layer (`store/slices`, `store/types`). It is not `core` (features depend on it,
        // but it also composes their slices) and not `shell` (it is state, not chrome), so it owns
        // itself. 22 impls sat unplaced until this line, which is how it was found: by running the
        // backfill and reading what it could not place.
        "store" => Some("store".to_string()),
        // `features/<x>` — the feature IS the second segment. `features` alone names no feature, so it
        // is unplaced rather than a feature called "features".
        "features" => segs.next().map(str::to_owned),
        _ => None,
    }
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/feature_rule.rs, src/required_by.rs, src/sidecars.rs, src/divergence.rs, src/log_streams.rs, src/models.rs, src/dangerous.rs, src/deny.rs, src/scope.rs, src/bash_gate.rs, src/packaged.rs, src/filelock.rs, src/pane_id.rs, src/pane_status.rs, src/pane_activity.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-util--<module>.rs
//     bsc graph impl set --id bsc-util--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-util--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc-util--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));
