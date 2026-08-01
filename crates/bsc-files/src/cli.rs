//! The `bsc files` subcommand (#1877) — the agent-facing filesystem/structure CLI. Standalone
//! (usable from any terminal) and installed per-session like the other `bsc-*` helpers (execed by
//! absolute path from `$BSC_FILES_BIN`). It gives a model a cheap, structured view of a codebase:
//! the folder tree with file **metrics** (sizes, line counts, language) and single-path `stat`.
//!
//! Extracted from the old `bsc-files` binary so the unified `bsc` umbrella dispatches into it via
//! [`run`]; the per-command help is unchanged:
//!   bsc files help            # compact menu (the small "what tools exist" prompt)
//!   bsc files tree help       # detailed help for ONE command
//!   bsc files <cmd> help      # same, after any command
//!
//! Root resolution is standalone-friendly: `--root <path>` wins, else the current working directory
//! (which, inside the app, is the session's repo/worktree — bash `cd`s there before launch).

use crate::{build_tree, human_size, read, refs, render_refs, render_tree, stat, TreeOpts};
use bsc_cli_util::CmdDoc;
use std::path::PathBuf;

const TAGLINE: &str = "folder structure with file metrics, for agents (read-only)";

/// The command catalog — drives both dispatch and the shared help system. One detailed `usage` block
/// per command keeps the overview tiny and the detail one-fetch-away.
const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "tree",
        summary: "folder structure with sizes, file counts, language",
        usage: "\
USAGE:
  bsc files tree [subpath] [flags]

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
  bsc files stat <path> [--lines] [--json|--pretty] [--root <p>]

Reports a single file or directory's size, language (by extension), last-modified epoch, and — with
--lines — its line count. <path> is resolved relative to the root.",
    },
    CmdDoc {
        name: "read",
        summary: "one file's text (the whole file, or a line window)",
        usage: "\
USAGE:
  bsc files read <path> [--from <n>] [--to <n>] [--json|--pretty] [--root <p>]

Prints a file's text. The counterpart to `stat`: `stat` says how big a file is, this hands back what is
in it — for reading a module NO harvest lifts, chiefly const/type modules (a STATUS_META table, a shared
types file). `bsc ui harvest` skips those (not components) and `bsc graph harvest` skips them (not
functions), so without this there is no way to see their content and vendor a component that imports
them (#4161).

FLAGS:
  --from <n>   first line to return (1-indexed, inclusive; default 1)
  --to <n>     last line to return (1-indexed, inclusive; default: end of file)
  --json       emit { path, lang, lines, from, to, windowed, text }
  --pretty     the same, indented
  --root <p>   resolve <path> against <p> (default: current directory)

READ-ONLY and root-confined: the path must sit inside a root this session may read (the ones `bsc ui
env` reports). A path outside every root is REFUSED with a stated error, never a silent empty read.

`lines` is the total in the FILE, not in the returned window, and `windowed` is true whenever the window
omits part of it — so a slice can never be mistaken for the whole file. A binary or non-UTF-8 file is
refused rather than dumped.",
    },
    CmdDoc {
        name: "refs",
        summary: "cross-file impact map (siblings, importers, usages, CSS) for one file",
        usage: "\
USAGE:
  bsc files refs <path> [symbol] [--json|--pretty] [--root <p>]

Cross-file dependency/impact finder: given a source file (and an OPTIONAL symbol/export/method),
returns a grouped, line-numbered impact map — the \"what dies / breaks if I change this\" set. With no
symbol it's file-level (the whole module); with a symbol it narrows importers + usages to that
identifier.

GROUPS (each hit is path:line):
  Siblings       files sharing the basename (Foo.css, Foo.module.css, Foo.test.tsx) — the
                 probably-dies-with-it set; test files are called out separately.
  Importers      every file importing this module (or the named symbol) → the import line.
  Symbol usages  every occurrence of the symbol across the tree (only when a symbol is given).
  Style links    the className / CSS-module classes the component uses and where each is defined in
                 .css/.scss, both directions — the \"find all the respective CSS\" case.

HEURISTIC: matching is textual/regex-free and language-aware for TS/TSX/JS/JSX/CSS/SCSS/Rust; it may
OVER-report — the safe bias for a deletion-impact tool (a spurious candidate with a line number beats
a missed dangling reference). Honors .gitignore, skips node_modules/target/.git, never follows
symlinks.

<path> is resolved relative to the root.",
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
    from: Option<u64>,
    to: Option<u64>,
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
            "--from" => {
                i += 1;
                let v = raw.get(i).ok_or("--from needs a line number")?;
                a.from = Some(v.parse().map_err(|_| format!("--from: not a number: {v}"))?);
            }
            "--to" => {
                i += 1;
                let v = raw.get(i).ok_or("--to needs a line number")?;
                a.to = Some(v.parse().map_err(|_| format!("--to: not a number: {v}"))?);
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

/// The `files` subcommand entrypoint: `args` is everything after `bsc files`; `prog` is the display
/// name for help/errors (`"bsc files"` from the umbrella, `"bsc-files"` from the legacy shim).
/// Handles help (no command / `help` / `help <cmd>` / `<cmd> help`) before any work.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help (no command / `help` / `help <cmd>` / `<cmd> help`) — the shared
    // dispatch in bsc-cli-util; returns Ok once help is printed.
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "tree" => cmd_tree(&args),
        "stat" => cmd_stat(&args),
        "read" => cmd_read(&args),
        "refs" => cmd_refs(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
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
    let rel = args.positional.get(1).ok_or("usage: bsc files stat <path>")?;
    let full = root.join(rel);
    let st = stat(&full, args.lines)?;
    bsc_cli_util::emit(args.pretty, args.json, &st, || st.lean());
    Ok(())
}

/// `bsc files read <path>` — a file's text, optionally windowed.
///
/// Root-confined the same way the harvests are (#3475): this binary hands back file CONTENTS, and
/// `bsc-confine` only inspects Claude's file-tool payloads — it is blind to what an allow-listed CLI
/// reads. Without the gate, `read` would be a way for a confined session to read any path on disk.
fn cmd_read(args: &Args) -> Result<(), String> {
    let root = resolve_root(&args.root)?;
    let rel = args.positional.get(1).ok_or("usage: bsc files read <path> [--from n] [--to n]")?;
    let full = root.join(rel);
    if !full.exists() {
        return Err(format!("no such file: {}", full.display()));
    }
    bsc_cli_util::require_harvestable_root(&full)?;
    let f = read(&full, args.from, args.to)?;
    // Default output is the RAW text — a read whose plain form was a JSON blob would have to be
    // unescaped by hand before it was usable as source.
    bsc_cli_util::emit(args.pretty, args.json, &f, || f.text.clone());
    Ok(())
}

fn cmd_refs(args: &Args) -> Result<(), String> {
    let root = resolve_root(&args.root)?;
    let path = args.positional.get(1).ok_or("usage: bsc files refs <path> [symbol]")?;
    let symbol = args.positional.get(2).map(String::as_str);
    let r = refs(&root, path, symbol)?;
    bsc_cli_util::emit(args.pretty, args.json, &r, || render_refs(&r));
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
    fn parse_args_accepts_refs_path_and_optional_symbol() {
        let a = parse_args(vec!["refs".into(), "Foo.tsx".into(), "handleClick".into(), "--json".into()]).unwrap();
        assert_eq!(a.positional, vec!["refs", "Foo.tsx", "handleClick"]);
        assert!(a.json);
        // The symbol is optional.
        let b = parse_args(vec!["refs".into(), "Foo.tsx".into()]).unwrap();
        assert_eq!(b.positional, vec!["refs", "Foo.tsx"]);
    }

    #[test]
    fn refs_help_routes_to_per_command_detail() {
        let one = bsc_cli_util::help_for("bsc files", TAGLINE, COMMANDS, "refs");
        assert!(one.contains("bsc files refs"));
        assert!(one.contains("Siblings"));
        assert!(one.contains("HEURISTIC"));
    }

    #[test]
    fn run_refs_json_emits_ok() {
        // End-to-end CLI path: a tiny fixture, `refs Foo.tsx --json` returns Ok (emits typed JSON).
        let root = std::env::temp_dir().join(format!("bsc-files-cli-refs-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("Foo.tsx"), "export default function Foo() { return null; }\n").unwrap();
        std::fs::write(root.join("Bar.tsx"), "import Foo from './Foo';\n").unwrap();
        let res = run(
            vec!["refs".into(), "Foo.tsx".into(), "--json".into(), "--root".into(), root.to_string_lossy().into()],
            "bsc files",
        );
        assert!(res.is_ok());
        // A missing file surfaces as an Err through the CLI.
        let miss = run(
            vec!["refs".into(), "Nope.tsx".into(), "--root".into(), root.to_string_lossy().into()],
            "bsc files",
        );
        assert!(miss.is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn parse_args_reads_the_read_line_window() {
        let a = parse_args(vec![
            "read".into(), "a.ts".into(), "--from".into(), "10".into(), "--to".into(), "20".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["read", "a.ts"]);
        assert_eq!((a.from, a.to), (Some(10), Some(20)));
        assert!(parse_args(vec!["read".into(), "a.ts".into(), "--from".into()]).is_err());
        assert!(parse_args(vec!["read".into(), "a.ts".into(), "--to".into(), "x".into()]).is_err());
    }

    #[test]
    fn run_read_is_confined_to_the_sessions_roots() {
        // #4161: `read` hands back file CONTENTS, so it honors the same boundary the harvests do —
        // `bsc-confine` inspects Claude's file-tool payloads and is blind to what this binary reads.
        let base = std::env::temp_dir().join(format!("bsc-files-cli-read-{}", std::process::id()));
        let inside = base.join("repo");
        let outside = base.join("elsewhere");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&inside).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(inside.join("a.ts"), "export const A = 1;\n").unwrap();
        std::fs::write(outside.join("secret.ts"), "export const SECRET = 1;\n").unwrap();
        let root_arg = inside.to_string_lossy().into_owned();

        // Confined to `inside`: a file within it reads…
        bsc_cli_util::with_repo_root(Some(&root_arg), || {
            assert!(run(vec!["read".into(), "a.ts".into(), "--root".into(), root_arg.clone()], "bsc files").is_ok());
            // …and one outside every root is REFUSED with a stated error, not a silent empty read.
            let out_arg = outside.to_string_lossy().into_owned();
            let err = run(
                vec!["read".into(), "secret.ts".into(), "--root".into(), out_arg],
                "bsc files",
            )
            .unwrap_err();
            assert!(err.contains("blocked"), "confinement must state the refusal: {err}");
        });

        // A missing path is an error, never an empty read.
        assert!(run(vec!["read".into(), "nope.ts".into(), "--root".into(), root_arg], "bsc files").is_err());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn read_help_names_the_gap_it_closes() {
        let one = bsc_cli_util::help_for("bsc files", TAGLINE, COMMANDS, "read");
        assert!(one.contains("bsc files read"));
        assert!(one.contains("--from"));
        // The whole point: it is the verb for what NEITHER harvest lifts.
        assert!(one.contains("harvest"), "help must say why this exists:\n{one}");
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

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc files", TAGLINE, COMMANDS);
        assert!(ov.contains("tree"));
        assert!(ov.contains("stat"));
        // Per-command help shows that one command's detail.
        let one = bsc_cli_util::help_for("bsc files", TAGLINE, COMMANDS, "tree");
        assert!(one.contains("bsc files tree"));
        assert!(one.contains("--depth"));
        assert!(!one.contains("size + language"));
        // An unknown command falls back to the overview.
        let miss = bsc_cli_util::help_for("bsc files", TAGLINE, COMMANDS, "nope");
        assert!(miss.contains("COMMANDS:"));
    }
}
