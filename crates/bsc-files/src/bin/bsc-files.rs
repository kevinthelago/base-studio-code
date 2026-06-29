//! `bsc-files` — the agent-facing filesystem/structure CLI. Standalone (usable from any terminal)
//! and installed per-session like the other `bsc-*` helpers (execed by absolute path from
//! `$BSC_FILES_BIN`). It gives a model a cheap, structured view of a codebase: the folder tree with
//! file **metrics** (sizes, line counts, language) and single-path `stat`.
//!
//! Help is per-command so a model loads only what it needs:
//!   bsc-files help            # compact menu (the small "what tools exist" prompt)
//!   bsc-files tree help       # detailed help for ONE command
//!   bsc-files <cmd> help      # same, after any command
//!
//! Root resolution is standalone-friendly: `--root <path>` wins, else the current working directory
//! (which, inside the app, is the session's repo/worktree — bash `cd`s there before launch).

use bsc_cli_util::CmdDoc;
use bsc_files::{build_tree, human_size, render_tree, stat, TreeOpts};
use std::path::PathBuf;
use std::process::ExitCode;

fn main() -> ExitCode {
    bsc_cli_util::cli_main("bsc-files", run)
}

const TAGLINE: &str = "folder structure with file metrics, for agents (read-only)";

/// The command catalog — drives both dispatch and the shared help system. One detailed `usage` block
/// per command keeps the overview tiny and the detail one-fetch-away.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "tree",
        summary: "folder structure with sizes, file counts, language",
        usage: "\
USAGE:
  bsc-files tree [subpath] [flags]

Prints the folder tree under the root (or root/<subpath>), with each directory's aggregate size +
file count and each file's size. Respects .gitignore and skips hidden/.git by default.

FLAGS:
  --depth <n>   only render <n> levels deep (deeper subtrees still show their aggregate)
  --lines       also count lines per text file (slower; reads each file)
  --hidden      include dotfiles/dot-dirs (still honors .gitignore)
  --all         include everything — gitignored + hidden (target/, node_modules/, …)
  --root <p>    treat <p> as the root (default: current directory)
  --json        emit the nested tree as compact JSON
  --pretty      emit the nested tree as indented JSON",
    },
    CmdDoc {
        name: "stat",
        summary: "size + language (+ lines) for one path",
        usage: "\
USAGE:
  bsc-files stat <path> [--lines] [--json|--pretty] [--root <p>]

Reports a single file or directory's size, language (by extension), last-modified epoch, and — with
--lines — its line count. <path> is resolved relative to the root.",
    },
];

/// Parsed flags + leftover positional args. Value-taking flags (`--root`, `--depth`) consume the
/// next token.
#[derive(Default)]
struct Args {
    json: bool,
    pretty: bool,
    all: bool,
    hidden: bool,
    lines: bool,
    root: Option<String>,
    depth: Option<usize>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args::default();
    let mut i = 0;
    while i < raw.len() {
        match raw[i].as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--all" => a.all = true,
            "--hidden" => a.hidden = true,
            "--lines" => a.lines = true,
            "--root" => {
                i += 1;
                a.root = Some(raw.get(i).ok_or("--root needs a path")?.clone());
            }
            "--depth" => {
                i += 1;
                let v = raw.get(i).ok_or("--depth needs a number")?;
                a.depth = Some(v.parse().map_err(|_| format!("--depth: not a number: {v}"))?);
            }
            // `-h`/`--help` route to the help command (anywhere on the line: `tree --help` ⇒ tree help).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(raw[i].clone()),
        }
        i += 1;
    }
    Ok(a)
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1).collect())?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util; returns Ok once help is printed.
    if bsc_cli_util::handle_help("bsc-files", TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "tree" => cmd_tree(&args),
        "stat" => cmd_stat(&args),
        other => Err(bsc_cli_util::unknown_command("bsc-files", TAGLINE, COMMANDS, other)),
    }
}

/// Resolve the tree root: `--root` if given, else the process working directory (the session's repo
/// when run inside the app, since bash `cd`s there first). Standalone runs just use the caller's cwd.
fn resolve_root(flag: &Option<String>) -> Result<PathBuf, String> {
    let root = match flag {
        Some(f) => PathBuf::from(f),
        None => std::env::current_dir().map_err(|e| format!("cannot resolve current directory: {e}"))?,
    };
    if !root.is_dir() {
        return Err(format!("not a directory: {}", root.display()));
    }
    Ok(root)
}

fn cmd_tree(args: &Args) -> Result<(), String> {
    let root = resolve_root(&args.root)?;
    // An optional positional subpath narrows the tree to root/<subpath>.
    let base = match args.positional.get(1) {
        Some(sub) => root.join(sub),
        None => root,
    };
    if !base.is_dir() {
        return Err(format!("not a directory: {}", base.display()));
    }
    let opts = TreeOpts { include_all: args.all, include_hidden: args.hidden, count_lines: args.lines };
    let node = build_tree(&base, &opts)?;
    bsc_cli_util::emit(args.pretty, args.json, &node, || {
        let mut s = render_tree(&node, args.depth);
        s.push_str(&format!("\n{} files, {}", node.files, human_size(node.size)));
        s
    });
    Ok(())
}

fn cmd_stat(args: &Args) -> Result<(), String> {
    let root = resolve_root(&args.root)?;
    let rel = args.positional.get(1).ok_or("usage: bsc-files stat <path>")?;
    let full = root.join(rel);
    let st = stat(&full, args.lines)?;
    bsc_cli_util::emit(args.pretty, args.json, &st, || st.lean());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_flags_values_and_positionals() {
        let a = parse_args(vec![
            "tree".into(), "src".into(), "--depth".into(), "2".into(),
            "--lines".into(), "--root".into(), "/repo".into(), "--json".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["tree", "src"]);
        assert_eq!(a.depth, Some(2));
        assert!(a.lines);
        assert_eq!(a.root.as_deref(), Some("/repo"));
        assert!(a.json);
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        // `tree --help` ⇒ positional ["help", "tree"] ⇒ per-command help for `tree`.
        let a = parse_args(vec!["tree".into(), "--help".into()]).unwrap();
        assert_eq!(a.positional, vec!["help", "tree"]);
    }

    #[test]
    fn parse_args_rejects_unknown_flag_and_missing_values() {
        assert!(parse_args(vec!["tree".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--depth".into()]).is_err()); // missing value
        assert!(parse_args(vec!["tree".into(), "--depth".into(), "x".into()]).is_err()); // non-numeric
    }
}
