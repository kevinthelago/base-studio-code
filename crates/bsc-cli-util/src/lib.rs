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

#[cfg(test)]
mod tests {
    use super::*;

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
    fn unknown_command_names_the_command_and_appends_the_overview() {
        let msg = unknown_command("bsc-x", "a test tool", DOCS, "bogus");
        assert!(msg.starts_with("unknown command 'bogus'"));
        // It carries the full compact overview so the message stays in sync with the catalog.
        assert_eq!(msg, format!("unknown command 'bogus'\n\n{}", help_overview("bsc-x", "a test tool", DOCS)));
        assert!(msg.contains("COMMANDS:"));
        assert!(msg.contains("tree"));
    }
}
