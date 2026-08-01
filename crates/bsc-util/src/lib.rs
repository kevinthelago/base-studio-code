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

/// The canonical `bsc` subcommand registry — the unified umbrella binary's state CLIs (#1843/#1877,
/// ONE list shared by the agent's prompt block + the shell-helper drift guard) plus the `.mcp.json`
/// command sentinels for the two bundled MCP servers (now `bsc mcp <sub>` subcommands, #1848/#1877).
pub mod sidecars;
pub use sidecars::{Sidecar, CHANNEL_MOCK_MCP, COMPLIANCE_MCP, RESEARCH_MCP, SIDECARS};

/// The canonical observability log-stream registry (#1847) — ONE list shared by the app's env
/// staging (`wire_bsc_env`) and the unified `bsc-logs` reader (`crates/logs`).
pub mod log_streams;
pub use log_streams::{LogStream, LOG_STREAMS};

/// The canonical always-on dangerous-bash floor (#1844) — ONE list both the Claude harness
/// (`Bash(<glob>)` deny rules) and the bsc-agent runtime (substring match) render from.
pub mod dangerous;

/// Matching for the SESSION's bash deny patterns (#3483) — program-name entries match the PROGRAM,
/// not any substring of the command. Kept apart from [`dangerous`], whose substring semantics are
/// load-bearing and deliberately unchanged.
pub mod deny;

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
pub fn ui_activity_line(ts: &str, pane: &str, kind: &str, collection: &str, id: &str) -> String {
    format!("{ts}\t{pane}\t{kind}\t{collection}\t{id}\n")
}

/// Append a `ui-touch` activity line for `(collection, id)` to `$BSC_UI_ACTIVITY_LOG` (#2525) — the
/// designer session's live-focus signal, fired by the `bsc ui set/remove` mutation paths right after
/// the ui-scope gate passes and the store write lands. A **no-op when the env var is absent or empty**
/// (hand shells / non-designer sessions never write it), so it's safe to call unconditionally. The
/// pane column is `$BSC_AUDIT_PANE` (else `?`); the timestamp is [`now_ms`] → [`epoch_ms_to_iso8601`],
/// matching the `bsc-*` helpers' `date -u +%Y-%m-%dT%H:%M:%SZ`. Best-effort: a write failure is
/// swallowed (activity signalling must never break a store mutation).
pub fn emit_ui_activity(collection: &str, id: &str) {
    emit_ui_line("ui-touch", collection, id);
}

/// Append a `ui-focus` activity line for `(collection, id)` to `$BSC_UI_ACTIVITY_LOG` (#3545) — the
/// designer session's live-focus signal for a READ (`bsc ui get`/`preview-props`), so the Design Studio
/// preview follows the node Claude is INSPECTING, not only one it writes. Unlike [`emit_ui_activity`]
/// (`ui-touch`), the frontend drives this into focus WITHOUT re-hydrating the library — a read changed
/// nothing to reload. Same no-op-when-unwired + best-effort contract as [`emit_ui_activity`].
pub fn emit_ui_focus(collection: &str, id: &str) {
    emit_ui_line("ui-focus", collection, id);
}

/// Shared body of [`emit_ui_activity`] / [`emit_ui_focus`] — resolve the log path + pane and append one
/// line of the given `kind`. No-op when `$BSC_UI_ACTIVITY_LOG` is absent/empty (non-designer sessions).
fn emit_ui_line(kind: &str, collection: &str, id: &str) {
    let path = match std::env::var_os("BSC_UI_ACTIVITY_LOG") {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => return, // no activity stream wired — hand shell / non-designer session
    };
    let pane = std::env::var("BSC_AUDIT_PANE").ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "?".to_string());
    let line = ui_activity_line(&epoch_ms_to_iso8601(now_ms()), &pane, kind, collection, id);
    append_line(&path, &line);
}

/// Append `line` to `path`, creating the parent dir if needed. Best-effort (errors ignored).
fn append_line(path: &std::path::Path, line: &str) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard};

    // home_dir() reads process-wide env vars; serialize the tests that mutate them.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    struct EnvGuard {
        _lock: MutexGuard<'static, ()>,
        home: Option<std::ffi::OsString>,
        userprofile: Option<std::ffi::OsString>,
    }
    impl EnvGuard {
        fn take() -> Self {
            let lock = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let g = EnvGuard {
                _lock: lock,
                home: std::env::var_os("HOME"),
                userprofile: std::env::var_os("USERPROFILE"),
            };
            std::env::remove_var("HOME");
            std::env::remove_var("USERPROFILE");
            g
        }
    }
    impl Drop for EnvGuard {
        fn drop(&mut self) {
            match &self.home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match &self.userprofile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
        }
    }

    /// Pins the chosen precedence (#1646): on Windows `USERPROFILE` wins over `HOME`; on Unix
    /// only `HOME` is consulted. This is the regression guard for the latent split that had the
    /// app and the CLIs resolving different `~/.base-studio-code` dirs under Git Bash on Windows.
    #[test]
    fn home_dir_precedence_matches_the_app() {
        let _g = EnvGuard::take();

        // Both set: the platform-preferred var wins.
        std::env::set_var("USERPROFILE", "C:/Users/win");
        std::env::set_var("HOME", "/home/nix");
        if cfg!(windows) {
            assert_eq!(home_dir(), Some(PathBuf::from("C:/Users/win")));
        } else {
            assert_eq!(home_dir(), Some(PathBuf::from("/home/nix")));
        }

        // On Windows, an empty USERPROFILE falls through to HOME; on Unix HOME still wins.
        std::env::set_var("USERPROFILE", "");
        assert_eq!(home_dir(), Some(PathBuf::from("/home/nix")));

        // Nothing usable set ⇒ None, and bsc_base_dir is None too.
        std::env::remove_var("HOME");
        std::env::remove_var("USERPROFILE");
        assert_eq!(home_dir(), None);
        assert_eq!(bsc_base_dir(), None);
    }

    #[test]
    fn bsc_base_dir_appends_the_dotdir() {
        let _g = EnvGuard::take();
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        std::env::set_var(key, "/somewhere");
        assert_eq!(bsc_base_dir(), Some(PathBuf::from("/somewhere").join(".base-studio-code")));
    }

    #[test]
    fn iso8601_formats_known_epochs() {
        assert_eq!(epoch_ms_to_iso8601(0), "1970-01-01T00:00:00Z");
        assert_eq!(epoch_ms_to_iso8601(1_700_000_000_000), "2023-11-14T22:13:20Z");
        // Sub-second precision is dropped, not rounded.
        assert_eq!(epoch_ms_to_iso8601(1_999), "1970-01-01T00:00:01Z");
    }

    #[test]
    fn iso8601_parses_and_round_trips() {
        assert_eq!(iso8601_to_epoch_ms("1970-01-01T00:00:01Z"), Some(1_000));
        assert_eq!(iso8601_to_epoch_ms("2026-06-26T10:04:59Z"), Some(1_782_468_299_000));
        // The seconds field is optional.
        assert_eq!(iso8601_to_epoch_ms("1970-01-01T00:00"), Some(0));
        assert_eq!(iso8601_to_epoch_ms("not-a-time"), None);
        // Round-trips through both directions at second resolution.
        let ms = 1_782_468_299_000;
        assert_eq!(iso8601_to_epoch_ms(&epoch_ms_to_iso8601(ms)), Some(ms));
    }

    #[test]
    fn now_is_monotonic_ish_and_consistent() {
        assert!(now_secs() > 1_700_000_000);
        assert!(now_ms() >= now_secs() * 1_000);
    }

    // ── UI-activity emit (#2525) ─────────────────────────────────────────────────────────────────
    // `emit_ui_activity` reads the process-wide `BSC_UI_ACTIVITY_LOG`/`BSC_AUDIT_PANE` env; serialize
    // the tests that mutate it (bsc-util's other tests never touch these vars, so this lock alone
    // fully isolates them).
    static UI_ENV_LOCK: Mutex<()> = Mutex::new(());

    #[test]
    fn ui_activity_line_is_the_tsv_kind_shape() {
        assert_eq!(
            ui_activity_line("2026-07-07T00:00:00Z", "design-studio:designer", "ui-touch", "component", "button"),
            "2026-07-07T00:00:00Z\tdesign-studio:designer\tui-touch\tcomponent\tbutton\n",
        );
        // #3545: a read emits `ui-focus` (focus only, no re-hydrate).
        assert_eq!(
            ui_activity_line("2026-07-07T00:00:00Z", "design-studio:designer", "ui-focus", "component", "chip"),
            "2026-07-07T00:00:00Z\tdesign-studio:designer\tui-focus\tcomponent\tchip\n",
        );
    }

    #[test]
    fn emit_ui_activity_writes_when_the_env_is_set_and_is_a_no_op_when_absent() {
        let _lock = UI_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("bsc-util-uiact-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let file = dir.join("ui-activity.log");

        // Absent env ⇒ a pure no-op: nothing is created.
        std::env::remove_var("BSC_UI_ACTIVITY_LOG");
        std::env::remove_var("BSC_AUDIT_PANE");
        emit_ui_activity("component", "button");
        assert!(!file.exists(), "no activity file without the env var");

        // Env set ⇒ one TSV `ui-touch` line, with the pane from $BSC_AUDIT_PANE and the right cols.
        std::env::set_var("BSC_UI_ACTIVITY_LOG", &file);
        std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");
        emit_ui_activity("component", "button");
        emit_ui_activity("theme", "neon");
        let text = std::fs::read_to_string(&file).unwrap();
        let lines: Vec<&str> = text.lines().collect();
        assert_eq!(lines.len(), 2, "one line appended per call");
        let cols: Vec<&str> = lines[0].split('\t').collect();
        assert_eq!(cols[1], "design-studio:designer", "pane column is $BSC_AUDIT_PANE");
        assert_eq!(cols[2], "ui-touch");
        assert_eq!(cols[3], "component");
        assert_eq!(cols[4], "button");
        assert!(iso8601_to_epoch_ms(cols[0]).is_some(), "col0 is a parseable ISO-8601 timestamp");
        assert!(lines[1].ends_with("\ttheme\tneon"), "the second collection/id rides through");

        // #3545: emit_ui_focus writes a `ui-focus` line (a read), and is likewise a no-op when unwired.
        std::env::set_var("BSC_AUDIT_PANE", "design-studio:designer");
        emit_ui_focus("component", "chip");
        let last = std::fs::read_to_string(&file).unwrap().lines().last().unwrap().to_string();
        let fcols: Vec<&str> = last.split('\t').collect();
        assert_eq!(fcols[2], "ui-focus", "a read emits ui-focus, not ui-touch");
        assert_eq!((fcols[3], fcols[4]), ("component", "chip"));

        // Missing pane falls back to "?".
        std::env::remove_var("BSC_AUDIT_PANE");
        emit_ui_activity("kit", "react-ui");
        let text = std::fs::read_to_string(&file).unwrap();
        let last = text.lines().last().unwrap();
        assert_eq!(last.split('\t').nth(1), Some("?"), "no pane env ⇒ ? column");

        std::env::remove_var("BSC_UI_ACTIVITY_LOG");
        let _ = std::fs::remove_dir_all(&dir);
    }
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

#[cfg(test)]
mod folder_tests {
    use super::folder_from_src;

    #[test]
    fn strips_the_src_root_and_the_filename() {
        assert_eq!(folder_from_src("src/shared/ui/controls/Button.tsx").as_deref(), Some("shared/ui/controls"));
        assert_eq!(folder_from_src("shared/ui/d3/charts/Bar.tsx").as_deref(), Some("shared/ui/d3/charts"));
    }

    #[test]
    fn keeps_a_rust_crate_path_intact() {
        // #4107: an algorithm harvested from a crate has no `src/` ROOT to strip — the `src` segment is
        // interior. Only a LEADING one is dropped, so the crate path survives as the folder.
        assert_eq!(folder_from_src("crates/bsc-graph/src/extract.rs").as_deref(), Some("crates/bsc-graph/src"));
    }

    #[test]
    fn normalizes_windows_backslashes() {
        assert_eq!(folder_from_src(r"src\shared\ui\layout\Box.tsx").as_deref(), Some("shared/ui/layout"));
    }

    #[test]
    fn a_record_with_no_folder_is_unfoldered() {
        assert_eq!(folder_from_src("Button.tsx"), None);
        assert_eq!(folder_from_src("src/Widget.tsx"), None);
        assert_eq!(folder_from_src(""), None);
        assert_eq!(folder_from_src("   "), None);
    }

    #[test]
    fn an_already_clean_folder_path_is_a_fixed_point() {
        // Re-deriving from a path whose folder already equals it returns the same folder — so a
        // `regroup`/`refolder` pass is idempotent and only rewrites records that actually moved.
        assert_eq!(folder_from_src("shared/ui/data/KeyValueList.tsx").as_deref(), Some("shared/ui/data"));
    }
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

#[cfg(test)]
mod test_pairing_tests {
    use super::{test_display_name, test_path_for};

    #[test]
    fn pairs_a_module_with_its_colocated_test_and_prefers_tsx() {
        let dir = std::env::temp_dir().join("bsc-util-test-pairing");
        let sub = dir.join("shared/lib/algorithms");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("orderByRank.test.ts"), "describe('orderByRank', () => {});").unwrap();
        let p = test_path_for(&dir, "shared/lib/algorithms/orderByRank.ts").expect("paired");
        assert!(p.ends_with("orderByRank.test.ts"));
        // A directory-shaped src (no extension) pairs with nothing rather than guessing.
        assert!(test_path_for(&dir, "shared/lib/algorithms").is_none());
        // A Rust module never pairs by path — its tests are inline.
        assert!(test_path_for(&dir, "crates/bsc-graph/src/extract.rs").is_none());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn names_by_describe_title_else_the_basename() {
        let p = std::path::Path::new("a/b/orderByRank.test.ts");
        assert_eq!(test_display_name(p, "describe(\"orderByRank (#4091)\", () => {});"), "orderByRank (#4091)");
        assert_eq!(test_display_name(p, "describe('single quoted', () => {});"), "single quoted");
        // No describe ⇒ the basename, which is honest rather than empty.
        assert_eq!(test_display_name(p, "it('bare', () => {});"), "orderByRank.test.ts");
    }

    #[test]
    fn a_rust_impl_pairs_with_its_own_inline_test_module() {
        // #4146 — Rust keeps its tests in the SAME file, so there is no sibling to find. Looking for one
        // reported every Rust impl as untested and made the kit's coverage structurally dishonest.
        let dir = std::env::temp_dir().join(format!("bsc-util-4146-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("src")).unwrap();
        let tested = "pub fn f() {}
#[cfg(test)]
mod tests { #[test] fn t() {} }
";
        std::fs::write(dir.join("src/tested.rs"), tested).unwrap();
        assert_eq!(test_path_for(&dir, "src/tested.rs"), Some(dir.join("src/tested.rs")));

        // No test module at all -> unpaired. A self-pairing here would claim coverage that isn't there.
        std::fs::write(dir.join("src/bare.rs"), "pub fn f() {}
").unwrap();
        assert_eq!(test_path_for(&dir, "src/bare.rs"), None);

        // `#[cfg(test)]` WITHOUT a `#[test]` fn is a test-only helper/import, not a test.
        std::fs::write(dir.join("src/helper.rs"), "pub fn f() {}
#[cfg(test)]
use std::fmt;
").unwrap();
        assert_eq!(test_path_for(&dir, "src/helper.rs"), None);

        // A path that does not exist is never a pairing.
        assert_eq!(test_path_for(&dir, "src/missing.rs"), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn typescript_pairing_is_unchanged_by_the_rust_arm() {
        // The sibling lookup is the ONLY path for TS; #4146 must not have perturbed it.
        let dir = std::env::temp_dir().join(format!("bsc-util-4146-ts-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("ui")).unwrap();
        std::fs::write(dir.join("ui/Button.tsx"), "export const B = () => null;").unwrap();
        assert_eq!(test_path_for(&dir, "ui/Button.tsx"), None, "no sibling yet");
        std::fs::write(dir.join("ui/Button.test.tsx"), "describe('B', () => {});").unwrap();
        assert_eq!(test_path_for(&dir, "ui/Button.tsx"), Some(dir.join("ui/Button.test.tsx")));
        // A TS file is never self-paired, however much it looks like a test.
        std::fs::write(dir.join("ui/Odd.ts"), "// #[cfg(test)] #[test]").unwrap();
        assert_eq!(test_path_for(&dir, "ui/Odd.ts"), None);
        std::fs::remove_dir_all(&dir).ok();
    }
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
/// process cannot safely switch (env is process-global), and anything outside `bsc ui` either needs a
/// project key or has not been shown to funnel its output through the capture helpers.
///
/// Defined HERE so the serve loop and the desktop client that routes to it cannot disagree — a client
/// that sent something the server refuses would stall a call that should simply have been spawned.
pub fn is_servable_warm(args: &[String]) -> bool {
    const SUBS: &[&str] = &["list", "kit", "theme", "variants", "usage", "shapes", "get"];
    args.first().is_some_and(|c| c == "ui") && args.get(1).is_some_and(|s| SUBS.contains(&s.as_str()))
}
