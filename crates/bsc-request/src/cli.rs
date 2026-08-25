//! The `bsc request` subcommand (#3295, epic #3260) — the designer→debug channel. A session confined to
//! `bsc ui` files an improvement request when the surface can't do what it needs (with the exact failing
//! command as the grounding); a full-capability debug session reads the open queue and resolves it. Each
//! request is a standalone contract — no conversation transcript is piped anywhere.
//!
//! The db is global (`~/.base-studio-code/requests.db`), located via `--db <path>` or `$BSC_REQUEST_DB`.
//! Reads are lean by default; `--json`/`--pretty` for machine-readable JSON. Help is per-command:
//! `bsc request help` · `bsc request <cmd> help`.

use crate::{Filter, NewRequest, Request, RequestNote, Store};
use bsc_cli_util::CmdDoc;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the improvement-request store — the designer→debug channel (#3295)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "new",
        summary: "file an improvement request; prints its id",
        usage: "\
USAGE:
  bsc request new \"<text>\" [--title T] [--surface S] [--cmd \"<failing command>\"] [--shot PATH] [--from WHO]

Files a request for something the tool surface can't do. Ground it — pass the EXACT command that failed
via --cmd (a request is observed, not narrated). --surface defaults to `bsc ui`. --shot attaches a PNG
(#3261). Prints the new request's id.

--title is a SHORT name for the request — it labels the request's node in the Glance graph. Omit it and
one is derived from <text>, so a label is never empty; pass it when the derivation would read badly.

WHO FILED IT IS STAMPED FOR YOU. The request records the filing session's pane id from $BSC_AUDIT_PANE —
you do not pass it, cannot forget it, and should not try to set it. That origin is what hangs the debug
session that works this request off YOUR node in the graph, so a request always traces back to the
session that hit the gap. --from overrides it for a request filed outside a session (a human at a shell);
with neither, the origin is recorded as absent rather than guessed.",
    },
    CmdDoc {
        name: "list",
        summary: "the request queue (lean TSV; newest first)",
        usage: "\
USAGE:
  bsc request list [--open] [--surface S] [--limit N] [--json|--pretty]

The requests, newest first. --open shows only UNCLAIMED ones — the queue `claim` draws from, so a
request another session is already holding is absent. It is NOT \"everything unresolved\": for that,
list without the flag, which is the triage view. --surface filters by tool. Lean TSV by default;
--json emits the full rows (with cmd + note).",
    },
    CmdDoc {
        name: "get",
        summary: "one request's full record",
        usage: "\
USAGE:
  bsc request get <id> [--json|--pretty]

One request's full record — the failing command + the resolve note the lean list omits.",
    },
    CmdDoc {
        name: "note",
        summary: "reply to a request WITHOUT closing it (append-only)",
        usage: "USAGE:
  bsc request note <id> \"<text>\" [--from <who>]

Appends a reply to the request's thread and leaves its STATUS ALONE. `resolve` is the only other way to
answer a request, and it asserts the thing is fixed — so a partial fix, a question, or a correction had
nowhere to go. Request #50 was resolved, the designer measured no change, and spent three probes filing
#52 to ask what \"resolved\" had meant; that is the gap this closes.

Notes are APPEND-ONLY: nothing edits or deletes one, so a thread is a record of what was said rather
than of what someone last thought. They ride their own table, NOT the single `--note` field `resolve`
stamps — a reply written there would overwrite the previous one.

An unknown id is an ERROR, not a silent no-op: a reply that goes nowhere is worse than a refusal.
Reading them: `bsc request get <id>`.",
    },
    CmdDoc {
        name: "resolve",
        summary: "mark a request resolved (the debug session, after fixing it)",
        usage: "\
USAGE:
  bsc request resolve <id> [--note \"<what changed>\"]

Marks the request resolved (drops it from `list --open`), stamping --note with what was fixed — the
built-in change log. Accepts an open OR a claimed request. A no-op (reported) for an unknown or
already-resolved id.",
    },
    CmdDoc {
        name: "claim",
        summary: "atomically take the oldest open request to work",
        usage: "\
USAGE:
  bsc request claim [--by <session>] [--json|--pretty]

Atomically claims the OLDEST open request (open → claimed) and prints it, or prints nothing (`null` in
--json) when the queue is empty. Race-free: two sessions claiming at once never take the same request,
so the standing debug session and the overflow pool can both self-serve the queue. --by records the
holder (its pane id). Work the printed request, then `bsc request resolve <id> --note`.",
    },
    CmdDoc {
        name: "unclaim",
        summary: "return a claimed request to the open queue",
        usage: "\
USAGE:
  bsc request unclaim <id>

Puts a claimed request back to open (clearing the holder) so it can be reclaimed — for a session that
abandoned it or crashed. A no-op (reported) for an unknown or not-claimed id.",
    },
    CmdDoc {
        name: "prune",
        summary: "remove resolved requests that carry no answer; prints the count",
        usage: "\
USAGE:
  bsc request prune [--dry-run] [--with-answers]

Collects resolved requests that carry NO answer. An open request, even a corrupted one, is left for
`remove`.

AN ANSWERED THREAD IS KEPT unless you ask twice. `request_notes` cascades on the request, so a prune
takes the whole discussion with it — and the answer is the durable half: why a reported behaviour was
or was not a bug lives nowhere else. Request #99 was answered with four notes on 2026-08-24, resolved,
and pruned within the hour by a routine tidy-up; nothing records that it was ever filed.

--dry-run reports what would go and deletes nothing. --with-answers also drops the answered ones,
thread and all — the escape hatch stays, it just stops being what a tidy-up does by accident. Either
way the counts are printed BEFORE anything is deleted.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete ONE request by id, any status",
        usage: "\
USAGE:
  bsc request remove <id>

Deletes exactly one request regardless of status — the escape hatch `prune` can't reach: a request
that will never be legitimately resolved (e.g. one whose text was corrupted at filing). A no-op
(reported) for an unknown id.",
    },
];

/// Parsed global flags + leftover positional args.
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    surface: Option<String>,
    cmd: Option<String>,
    shot: Option<String>,
    note: Option<String>,
    by: Option<String>,
    /// The author of a `note` (#bsc-request-gains-a-note-verb). Spelled `--from`, not `--by`, to match
    /// `bsc plan change note --from` — the same act in the other store. `--by` here stays what it
    /// already was: WHICH SESSION holds a `claim`, which is a different question about a different verb.
    from: Option<String>,
    /// A short name for a `new` request (#debug-request-carries-its-origin) — what labels its graph node.
    /// Absent ⇒ derived from the text by `Request::display_title`.
    title: Option<String>,
    open: bool,
    /// `prune --dry-run` — report what would go instead of deleting it.
    dry_run: bool,
    /// `prune --with-answers` — also drop resolved requests that carry a reply thread. Off by default:
    /// the answer is the durable half, and a routine tidy-up should not destroy it (see `add_note`).
    with_answers: bool,
    limit: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false,
        pretty: false,
        db: None,
        surface: None,
        cmd: None,
        shot: None,
        note: None,
        by: None,
        from: None,
        title: None,
        open: false,
        dry_run: false,
        with_answers: false,
        limit: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let mut val = |flag: &str| -> Result<String, String> { it.next().ok_or_else(|| format!("flag {flag} needs a value")) };
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--open" => a.open = true,
            "--dry-run" => a.dry_run = true,
            "--with-answers" => a.with_answers = true,
            "--db" => a.db = Some(val("--db")?),
            "--surface" => a.surface = Some(val("--surface")?),
            "--cmd" => a.cmd = Some(val("--cmd")?),
            "--shot" => a.shot = Some(val("--shot")?),
            "--note" => a.note = Some(val("--note")?),
            "--by" => a.by = Some(val("--by")?),
            "--from" => a.from = Some(val("--from")?),
            "--title" => a.title = Some(val("--title")?),
            "--limit" => a.limit = Some(val("--limit")?.parse().map_err(|_| "--limit needs an integer")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `request` subcommand entrypoint: `args` is everything after `bsc request`; `prog` is the display name.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "new" => cmd_new(&args),
        "list" => cmd_list(&args),
        "get" => cmd_get(&args),
        "note" => cmd_note(&args),
        "resolve" => cmd_resolve(&args),
        "claim" => cmd_claim(&args),
        "unclaim" => cmd_unclaim(&args),
        "prune" => cmd_prune(&args),
        "remove" => cmd_remove(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `new "<text>"` — file a request; prints its id.
fn cmd_new(args: &Args) -> Result<(), String> {
    let text = args.positional.get(1).ok_or("usage: bsc request new \"<text>\" [--cmd \"...\"]")?;
    let input = NewRequest {
        text: text.clone(),
        surface: args.surface.clone().unwrap_or_default(),
        cmd: args.cmd.clone(),
        shot_path: args.shot.clone(),
        ts: now_ms(),
        origin: resolve_origin(args.from.clone(), std::env::var("BSC_AUDIT_PANE").ok()),
        title: args.title.clone(),
    };
    let r = open_store(&args.db)?.create(&input).map_err(|e| format!("filing request: {e}"))?;
    println!("{}", r.id);
    Ok(())
}

/// Resolve who filed a request (#debug-request-carries-its-origin): the explicit `--from` first, then the
/// session's own pane from `$BSC_AUDIT_PANE`.
///
/// STAMPED, NOT TYPED. Every filing session already carries `$BSC_AUDIT_PANE` — the coord emitters read it
/// the same way (`__bsc_coord` uses `${BSC_AUDIT_PANE:-?}`) — so the CLI can take the filer's identity from
/// the environment instead of adding a flag to four `claude.md` charters and trusting each to fill it in.
/// That is the same reasoning `--surface` got wrong: it is free text a session types, and it names the TOOL
/// rather than the filer, so it could never resolve WHICH designer (`designer-studio:react` vs
/// `react-native`) hit the gap.
///
/// `?` is filtered out, not stored: the shell helpers write that literal when a pane is unknown, and a row
/// claiming to come from a session called "?" is worse than one that admits it has no origin. Pure so the
/// precedence is testable without touching the process environment.
///
/// Each candidate is cleaned BEFORE the fallback, not after: `--from ""` means "I passed nothing", so it
/// must fall through to the pane rather than short-circuiting the chain with a blank and discarding an
/// origin the environment was holding all along.
fn resolve_origin(from: Option<String>, audit_pane: Option<String>) -> Option<String> {
    let clean = |s: Option<String>| {
        s.map(|v| v.trim().to_string()).filter(|v| !v.is_empty() && v != "?")
    };
    clean(from).or_else(|| clean(audit_pane))
}

/// `list` — the request queue.
fn cmd_list(args: &Args) -> Result<(), String> {
    let filter = Filter { open_only: args.open, surface: args.surface.clone(), limit: args.limit };
    let requests = open_store(&args.db)?.list(&filter).map_err(|e| format!("listing requests: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &requests, || {
        if requests.is_empty() {
            "(no requests)".to_string()
        } else {
            requests.iter().map(request_line).collect::<Vec<_>>().join("\n")
        }
    });
    Ok(())
}

/// `get <id>` — one request's full record.
fn cmd_get(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let store = open_store(&args.db)?;
    let r = store
        .get(id)
        .map_err(|e| format!("reading request: {e}"))?
        .ok_or_else(|| format!("no request {id}"))?;
    // The thread rides along (#bsc-request-gains-a-note-verb) — this is where a designer re-reading its
    // own request finds out anything was said. A note nobody can read is the same as no note.
    let notes = store.notes(id).map_err(|e| format!("reading request notes: {e}"))?;
    let view = RequestView { request: &r, notes: &notes };
    bsc_cli_util::emit(args.pretty, args.json, &view, || {
        let mut out = request_block(&r);
        for n in &notes {
            out.push_str(&format!("

note ({}): {}", n.author.as_deref().unwrap_or("?"), n.body));
        }
        out
    });
    Ok(())
}

/// A request PLUS its thread, for `get`. Flattened so the JSON shape is the request's own with a `notes`
/// array added, and `notes` is omitted entirely when empty — a request with no replies serializes byte
/// for byte as it did before this verb existed, so nothing reading `--json` has to change.
#[derive(serde::Serialize)]
struct RequestView<'a> {
    #[serde(flatten)]
    request: &'a Request,
    #[serde(skip_serializing_if = "<[RequestNote]>::is_empty")]
    notes: &'a [RequestNote],
}

/// `resolve <id>` — mark a request resolved.
fn cmd_resolve(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let matched =
        open_store(&args.db)?.resolve(id, args.note.as_deref(), now_ms()).map_err(|e| format!("resolving request: {e}"))?;
    println!("{}", if matched { format!("resolved request {id}") } else { format!("no open request {id}") });
    Ok(())
}

/// `note <id> "<text>" [--from <who>]` — append a reply WITHOUT touching the status.
fn cmd_note(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let body = args
        .positional
        .get(2)
        .ok_or("usage: bsc request note <id> \"<text>\" [--from <who>]")?;
    // An unknown id ERRORS rather than printing a miss like `resolve` does. The two are not the same
    // shape: a resolve that finds nothing has changed nothing and the queue still reads correctly, while
    // a note that finds nothing has SWALLOWED a reply somebody wrote — and the whole point of the verb is
    // that a designer's answer reaches them.
    let ok = open_store(&args.db)?
        .add_note(id, body, args.from.as_deref(), now_ms())
        .map_err(|e| format!("noting request: {e}"))?;
    if !ok {
        return Err(format!("no request {id} — nothing to note (list them with `bsc request list`)"));
    }
    println!("noted request {id}");
    Ok(())
}

/// `claim` — atomically take the oldest open request; print it, or `null` / a message when none.
fn cmd_claim(args: &Args) -> Result<(), String> {
    let claimed =
        open_store(&args.db)?.claim(args.by.as_deref(), now_ms()).map_err(|e| format!("claiming request: {e}"))?;
    match claimed {
        Some(r) => bsc_cli_util::emit(args.pretty, args.json, &r, || format!("claimed request {}: {}", r.id, r.text)),
        // Empty queue is not an error: print a machine-checkable sentinel so a session can branch on it.
        None if args.json => println!("null"),
        None => println!("(no open requests to claim)"),
    }
    Ok(())
}

/// `unclaim <id>` — put a claimed request back to open.
fn cmd_unclaim(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let matched = open_store(&args.db)?.unclaim(id).map_err(|e| format!("unclaiming request: {e}"))?;
    println!("{}", if matched { format!("unclaimed request {id}") } else { format!("no claimed request {id}") });
    Ok(())
}

/// `prune` — remove all resolved requests; prints the count.
fn cmd_prune(args: &Args) -> Result<(), String> {
    let (with_answers, dry) = (args.with_answers, args.dry_run);
    let store = open_store(&args.db)?;
    let (bare, answered) = store.prune_preview().map_err(|e| format!("reading requests: {e}"))?;
    let going = if with_answers { bare + answered } else { bare };

    // SAY WHAT WILL GO, BEFORE IT GOES. `prune` deleted an unbounded set with no preview and no
    // confirmation, and its help mentioned only the requests — never the threads that cascade with them.
    println!(
        "{} {going} resolved request(s){}",
        if dry { "would prune" } else { "pruning" },
        if answered > 0 && !with_answers {
            format!("; KEEPING {answered} that carry an answer (--with-answers to drop those too)")
        } else if answered > 0 {
            format!(" — including {answered} with an answer, whose notes go with them")
        } else {
            String::new()
        },
    );
    if dry {
        return Ok(());
    }
    let n = store.prune_resolved(with_answers).map_err(|e| format!("pruning requests: {e}"))?;
    println!("pruned {n} resolved request{}", if n == 1 { "" } else { "s" });
    Ok(())
}

/// `remove <id>` — delete one request of any status.
fn cmd_remove(args: &Args) -> Result<(), String> {
    let id = positional_id(args)?;
    let matched = open_store(&args.db)?.remove(id).map_err(|e| format!("removing request: {e}"))?;
    println!("{}", if matched { format!("removed request {id}") } else { format!("no request {id}") });
    Ok(())
}

/// One lean TSV row: id, status, surface, origin, cmd?, text.
///
/// `origin` rides in the lean form (not only `--json`) because scanning the queue for "what has the
/// librarian been blocked on" is the question this field exists to answer, and a TSV column is how that
/// gets asked from a shell.
fn request_line(r: &Request) -> String {
    format!(
        "{}\t{}\t{}\t{}\t{}\t{}",
        r.id,
        r.status,
        r.surface,
        r.origin.as_deref().unwrap_or("-"),
        r.cmd.as_deref().unwrap_or("-"),
        r.text,
    )
}

/// The full one-request block for `get` (human form).
fn request_block(r: &Request) -> String {
    let mut s = format!("request {}  [{}]  ({})\n{}\n{}", r.id, r.status, r.surface, r.display_title, r.text);
    if let Some(origin) = &r.origin {
        s.push_str(&format!("\nfiled by: {origin}"));
    }
    if let Some(cmd) = &r.cmd {
        s.push_str(&format!("\nfailing command: {cmd}"));
    }
    if let Some(shot) = &r.shot_path {
        s.push_str(&format!("\nshot: {shot}"));
    }
    if let Some(note) = &r.note {
        s.push_str(&format!("\nresolved: {note}"));
    }
    s
}

/// Parse the request id from the first positional after the command word.
fn positional_id(args: &Args) -> Result<i64, String> {
    let raw = args.positional.get(1).ok_or("usage: bsc request <cmd> <id> …")?;
    raw.parse().map_err(|_| format!("request id must be an integer (got '{raw}')"))
}

/// Open the global requests.db (resolved from `--db` / `$BSC_REQUEST_DB` / `~/.base-studio-code/requests.db`).
fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

/// Resolve the requests.db path: `--db` → `$BSC_REQUEST_DB` → `~/.base-studio-code/requests.db`.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(f) = flag {
        return Ok(PathBuf::from(f));
    }
    bsc_sqlite_util::default_store_path("BSC_REQUEST_DB", &["requests.db"])
        .ok_or_else(|| "cannot locate requests.db (no home directory); pass --db <path>".to_string())
}

/// Current wall-clock in epoch milliseconds (0 if the clock is before the epoch — never panics).
fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(vec![
            "new".into(),
            "theme can't reach the scrollbar".into(),
            "--cmd".into(),
            "bsc ui theme set-token default --scrollbar x".into(),
            "--surface".into(),
            "bsc ui".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["new", "theme can't reach the scrollbar"]);
        assert_eq!(a.cmd.as_deref(), Some("bsc ui theme set-token default --scrollbar x"));
        assert_eq!(a.surface.as_deref(), Some("bsc ui"));
    }

    // ── #debug-request-carries-its-origin ───────────────────────────────────────────────────────────

    /// The precedence, and the reason this is a pure function: the real path reads a process-global env
    /// var, which parallel test threads cannot each own (#3382). Passing it in keeps the rule testable.
    #[test]
    fn origin_prefers_an_explicit_from_then_the_session_pane() {
        let s = |x: &str| Some(x.to_string());
        assert_eq!(resolve_origin(s("kevin"), s("designer-studio:react")).as_deref(), Some("kevin"), "--from wins");
        assert_eq!(
            resolve_origin(None, s("librarian-studio:typescript")).as_deref(),
            Some("librarian-studio:typescript"),
            "no flag ⇒ the session's own pane, with no session having to pass one",
        );
        assert_eq!(resolve_origin(None, None), None, "neither ⇒ absent, never invented");
    }

    /// `?` is what the shell helpers write for an unknown pane (`${BSC_AUDIT_PANE:-?}`). Storing it would
    /// put a request on the graph attributed to a session called "?" — worse than admitting no origin.
    #[test]
    fn origin_rejects_the_unknown_pane_sentinel_and_blanks() {
        assert_eq!(resolve_origin(None, Some("?".into())), None);
        assert_eq!(resolve_origin(None, Some("   ".into())), None);
        assert_eq!(resolve_origin(Some("".into()), Some("designer-studio:react".into())).as_deref(), Some("designer-studio:react"),
            "an empty --from falls through to the pane rather than blanking the origin");
    }

    /// End to end through the real handler: a request filed by a session carries that session, and shows
    /// it in the lean list — the form a shell actually reads the queue in.
    #[test]
    fn new_stamps_the_origin_and_the_lean_list_shows_it() {
        let dir = std::env::temp_dir().join(format!("bsc-request-origin-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();

        cmd_new(&args_for(vec!["new", "bsc graph impl list has no --domain filter"], |a| {
            a.db = Some(dbp.clone());
            a.from = Some("librarian-studio:typescript".into());
            a.title = Some("impl list needs --domain".into());
        }))
        .unwrap();

        let r = open_store(&Some(dbp.clone())).unwrap().get(1).unwrap().unwrap();
        assert_eq!(r.origin.as_deref(), Some("librarian-studio:typescript"));
        assert_eq!(r.display_title, "impl list needs --domain");
        let line = request_line(&r);
        assert!(line.contains("librarian-studio:typescript"), "the origin rides the lean TSV: {line}");
        // …and `get`'s human block names the filer in words, not just as a column.
        assert!(request_block(&r).contains("filed by: librarian-studio:typescript"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A request filed with neither flag nor pane still lists and still labels — the unattributed path
    /// must not produce an empty column or an empty title.
    #[test]
    fn an_unattributed_request_still_lists_and_labels() {
        let dir = std::env::temp_dir().join(format!("bsc-request-anon-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();

        cmd_new(&args_for(vec!["new", "the preview cannot mount a kit component."], |a| a.db = Some(dbp.clone()))).unwrap();
        let r = open_store(&Some(dbp.clone())).unwrap().get(1).unwrap().unwrap();
        assert_eq!(r.origin, None);
        assert_eq!(r.display_title, "the preview cannot mount a kit component");
        assert!(request_line(&r).contains("\t-\t"), "an absent origin renders as the '-' placeholder");
        assert!(!request_block(&r).contains("filed by:"), "and is not claimed in the human block");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_args_rejects_unknown_flag_and_missing_value() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--cmd".into()]).is_err(), "value-flag with no value");
        assert!(parse_args(vec!["--limit".into(), "abc".into()]).is_err(), "non-integer");
    }

    #[test]
    fn help_overview_and_per_command_help() {
        let ov = bsc_cli_util::help_overview("bsc request", TAGLINE, COMMANDS);
        for name in ["new", "list", "get", "resolve", "claim", "unclaim", "prune", "remove"] {
            assert!(ov.contains(name), "overview lists {name}");
        }
        let new = bsc_cli_util::help_for("bsc request", TAGLINE, COMMANDS, "new");
        assert!(new.contains("bsc request new"));
        assert!(new.contains("--cmd"), "documents the grounding flag");
        // The origin is stamped, and the help has to SAY so — a session that believes it must supply its
        // own identity will either invent a flag or hand-type a value that cannot resolve a technology.
        assert!(new.contains("BSC_AUDIT_PANE"), "names where the origin comes from");
        assert!(new.contains("--title"), "documents the label flag");
    }

    /// REGRESSION. `--open` filters `status = 'open'`, so a CLAIMED request is excluded — and the help
    /// said it "shows only unresolved". A claimed request IS unresolved, so the sentence promised the
    /// triage view and delivered the claimable queue. Read literally, an empty `--open` says the queue is
    /// clear while sessions are still holding work; two requests sat that way for hours. The behaviour is
    /// right (it is what `claim` draws from) — the word was not.
    #[test]
    fn the_open_flag_documents_what_it_actually_filters() {
        let list = bsc_cli_util::help_for("bsc request", TAGLINE, COMMANDS, "list");
        assert!(list.contains("UNCLAIMED"), "says which set it is: {list}");
        assert!(
            !list.contains("shows only unresolved"),
            "a claimed request is unresolved too, so this claim is false: {list}"
        );
    }

    #[test]
    fn end_to_end_new_list_resolve_over_a_temp_db() {
        let dir = std::env::temp_dir().join(format!("bsc-request-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        std::env::set_var("BSC_REQUEST_DB", &path);

        cmd_new(&args_for(vec!["new", "gap"], |a| a.cmd = Some("bsc ui foo".into()))).unwrap();
        let store = open_store(&None).unwrap();
        assert_eq!(store.list(&Filter { open_only: true, ..Default::default() }).unwrap().len(), 1);
        cmd_resolve(&args_for(vec!["resolve", "1"], |a| a.note = Some("added foo".into()))).unwrap();
        assert!(open_store(&None).unwrap().list(&Filter { open_only: true, ..Default::default() }).unwrap().is_empty());

        std::env::remove_var("BSC_REQUEST_DB");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_over_a_temp_db_replies_without_closing_and_refuses_an_unknown_id() {
        // Select the db via `--db`, never a global env var — cargo runs tests as parallel threads of one
        // process (#3382).
        let dir = std::env::temp_dir().join(format!("bsc-request-note-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let db = || Some(path.to_string_lossy().into_owned());

        cmd_new(&args_for(vec!["new", "the preview shows a stale overlay"], |a| a.db = db())).unwrap();
        cmd_note(&args_for(vec!["note", "1", "half fixed; the field-loss half is not"], |a| {
            a.db = db();
            a.from = Some("claude".into());
        }))
        .unwrap();

        let store = open_store(&db()).unwrap();
        assert_eq!(store.get(1).unwrap().unwrap().status, "open", "a reply must not close the request");
        let notes = store.notes(1).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].author.as_deref(), Some("claude"));

        // An unknown id is an ERROR — a reply that silently goes nowhere is worse than a refusal.
        let err = cmd_note(&args_for(vec!["note", "404", "into the void"], |a| a.db = db())).unwrap_err();
        assert!(err.contains("no request 404"), "{err}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_and_remove_over_a_temp_db() {
        // Select the db via `--db`, NEVER `std::env::set_var` — cargo runs tests as parallel threads of one
        // process, so a global env var races with any sibling test that also sets it (#3382). Threading the
        // path through `args.db` keeps it thread-local.
        let dir = std::env::temp_dir().join(format!("bsc-request-prune-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();
        let with_db = |positional: Vec<&str>| args_for(positional, |a| a.db = Some(dbp.clone()));
        let db = Some(dbp.clone());

        cmd_new(&with_db(vec!["new", "keep open"])).unwrap(); // id 1
        cmd_new(&with_db(vec!["new", "will resolve"])).unwrap(); // id 2
        cmd_new(&with_db(vec!["new", "corrupted"])).unwrap(); // id 3
        cmd_resolve(&with_db(vec!["resolve", "2"])).unwrap();

        cmd_prune(&with_db(vec!["prune"])).unwrap();
        let after_prune = open_store(&db).unwrap().list(&Filter::default()).unwrap();
        assert_eq!(after_prune.len(), 2, "resolved #2 gone; the two open ones remain");

        cmd_remove(&with_db(vec!["remove", "3"])).unwrap(); // the corrupted, still-open row
        let after_remove = open_store(&db).unwrap().list(&Filter::default()).unwrap();
        assert_eq!(after_remove.iter().map(|r| r.id).collect::<Vec<_>>(), vec![1], "only #1 left");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claim_and_unclaim_over_a_temp_db() {
        // --db, never set_var (#3382 — parallel test threads share the global env).
        let dir = std::env::temp_dir().join(format!("bsc-request-claim-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();
        let with_db = |positional: Vec<&str>| args_for(positional, |a| a.db = Some(dbp.clone()));
        let db = Some(dbp.clone());

        cmd_new(&with_db(vec!["new", "gap one"])).unwrap(); // id 1
        cmd_new(&with_db(vec!["new", "gap two"])).unwrap(); // id 2

        // Claim takes the oldest and removes it from `--open`.
        cmd_claim(&args_for(vec!["claim"], |a| { a.db = Some(dbp.clone()); a.by = Some("sess-x".into()); })).unwrap();
        let store = open_store(&db).unwrap();
        let claimed = store.get(1).unwrap().unwrap();
        assert!(claimed.is_claimed() && claimed.claimed_by.as_deref() == Some("sess-x"));
        assert_eq!(
            store.list(&Filter { open_only: true, ..Default::default() }).unwrap().iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![2],
            "only the unclaimed one is offered to --open",
        );

        // Unclaim returns it to the queue.
        cmd_unclaim(&with_db(vec!["unclaim", "1"])).unwrap();
        assert!(open_store(&db).unwrap().get(1).unwrap().unwrap().is_open(), "back to open after unclaim");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Build an `Args` for a handler test — the command word + positionals, then a mutator for flags.
    fn args_for(positional: Vec<&str>, set: impl FnOnce(&mut Args)) -> Args {
        let mut a = parse_args(positional.into_iter().map(String::from).collect()).unwrap();
        set(&mut a);
        a
    }
}
