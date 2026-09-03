//! The `bsc request` subcommand (#3295, epic #3260) — the designer→debug channel. A session confined to
//! `bsc ui` files an improvement request when the surface can't do what it needs (with the exact failing
//! command as the grounding); a full-capability debug session reads the open queue and resolves it. Each
//! request is a standalone contract — no conversation transcript is piped anywhere.
//!
//! The db is global (`~/.base-studio-code/requests.db`), located via `--db <path>` or `$BSC_REQUEST_DB`.
//! Reads are lean by default; `--json`/`--pretty` for machine-readable JSON. Help is per-command:
//! `bsc request help` · `bsc request <cmd> help`.

use crate::provenance;
use crate::{FilingContext, Filter, NewRequest, OriginKind, Request, RequestNote, Store};
use bsc_cli_util::CmdDoc;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

const TAGLINE: &str = "the improvement-request store — the designer→debug channel (#3295)";

/// The crate's own verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than
/// restate it — a generated catalog cannot drift, a second list does.
pub const COMMANDS: &[CmdDoc] = &[
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
you do not pass it, cannot forget it, and should not try to set it. That pane is what hangs the debug
session that works this request off YOUR node in the graph, so a request always traces back to the
session that hit the gap. --from names an ACTOR instead, for a request filed outside a session (a human
or a lane at a shell). They no longer compete: a session that also passes --from records BOTH, and with
neither the origin is recorded as absent rather than guessed.

THE FILING CONTEXT IS STAMPED TOO — the working tree, its repository and branch, the cwd, the `bsc`
build that was running, and the agent harness/model/session when the environment says. None of it is
typed and none of it is guessed: anything that cannot be resolved is recorded as ABSENT, because a
plausible cwd or an invented repo reads exactly like a measured one. Read it back with
`bsc request get <id>`; `list` stays lean.",
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

One request's full record — the failing command, the resolve note, and the FILING CONTEXT the lean list
omits: who filed it (a session pane and/or a named actor, each labelled so neither is mistaken for the
other), the working tree / repository / branch / cwd it was filed from, the `bsc` build that was
running, and the harness / model / session driving it. Anything that could not be resolved is shown as
absent rather than filled in.",
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
        name: "pause",
        summary: "stop the app auto-spawning a debug session per claimed request",
        usage: "\
USAGE:
  bsc request pause
  bsc request pause --off      # same as `bsc request resume`

The app starts ONE debug session per CLAIMED request, and claims every open one itself to do it — so
there is no way to quieten it from the queue short of resolving real work as if it were fixed. This is
the switch that used to be a Settings toggle and was removed with it.

While paused the app starts nothing AND closes the debug sessions it already has; the queue is
untouched, so every request keeps its status and its thread. Persisted in requests.db beside the queue,
so a pause set from a shell is seen by the running app.",
    },
    CmdDoc {
        name: "sessions",
        summary: "the GLOBAL off switch for debug sessions — policy, not a pause",
        usage: "\
USAGE:
  bsc request sessions            # enabled | disabled
  bsc request sessions off        # this machine runs NO debug sessions
  bsc request sessions on
  bsc request sessions --json     # {\"enabled\": bool}

THE STRONGER SIBLING OF `pause`, and the difference matters:

  pause     a STATE — \"not right now\". Temporary, and `resume` undoes it.
  sessions  a POLICY — \"this machine does not run debug sessions\". `resume` cannot lift it.

That asymmetry is the point. `resume` is reached for routinely, and a policy a routine command can
silently undo is not a policy. With sessions OFF the app starts nothing and closes what it has, no
matter what `pause` says; the queue is untouched either way, so every request keeps its status and
its thread.

Defaults to ENABLED — the behaviour every existing install already has. Turning it off is a
deliberate act and stays off until someone turns it back on.",
    },
    CmdDoc {
        name: "resume",
        summary: "let the app auto-spawn debug sessions again",
        usage: "\
USAGE:
  bsc request resume

The inverse of `bsc request pause`. Sessions come back for every claimed request on the app's next
poll — nothing was lost while paused, because pausing never touched the queue.",
    },
    CmdDoc {
        name: "paused",
        summary: "is auto-spawn paused? (the state the app reads)",
        usage: "\
USAGE:
  bsc request paused [--json]

Prints `paused` or `active`. `--json` emits {\"paused\": bool} — this is what the app polls, so it is a
read verb with no side effect. An unreadable or absent setting reports ACTIVE: a pause has to have been
asked for to be true, and a missing row must never silently stop the debug fleet.",
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
    /// `pause --off`, the spelling that mirrors `resume` for a caller that already built an argv.
    off: bool,
    /// `prune --with-answers` — also drop resolved requests that carry a reply thread. Off by default:
    /// the answer is the durable half, and a routine tidy-up should not destroy it (see `add_note`).
    with_answers: bool,
    limit: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        json: false,
        pretty: false,
        off: false,
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
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        // The refusal wording is the one this CLI already produced — `flag --db needs a value`.
        let mut val = |f: &str| -> Result<String, String> { v.value(&format!("flag {f} needs a value")) };
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--open" => a.open = true,
            "--dry-run" => a.dry_run = true,
            "--off" => a.off = true,
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
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
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
        "sessions" => cmd_sessions(&args),
        "pause" => cmd_pause(&args, !args.off),
        "resume" => cmd_pause(&args, false),
        "paused" => cmd_paused(&args),
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
        context: capture_context(args.from.clone(), &|k| std::env::var(k).ok()),
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

/// Observe the filing context (`a-request-records-where-it-actually-came-from`) — who, where, and
/// which build — from the environment and the working directory.
///
/// `--from` and `$BSC_AUDIT_PANE` NO LONGER COMPETE. They answer different questions — "which actor"
/// and "which session" — and putting them in one field is why the live queue holds `claude`,
/// `lane-c4` and `studio-code:director` under one name with nothing to tell them apart. Here they go
/// to their own columns, so a session that also passes `--from` records BOTH rather than one
/// overwriting the other. [`resolve_origin`] is unchanged and still writes the merged `origin`: 39
/// rows and every existing reader depend on it, and rewriting evidence to fit a new schema is not a
/// migration.
///
/// Everything else is STAMPED, NOT TYPED, and every unresolvable field is left absent — see the
/// module docs on `provenance` for why a plausible default is worse than a blank here.
fn capture_context(from: Option<String>, env: &dyn Fn(&str) -> Option<String>) -> FilingContext {
    let tree = std::env::current_dir().map(|d| provenance::locate_tree(&d)).unwrap_or_default();
    let f = provenance::filer(env);
    let (bsc_version, bsc_built_at) = provenance::build_stamp(std::env::current_exe().ok().as_deref());
    FilingContext {
        origin_pane: provenance::clean(env("BSC_AUDIT_PANE")),
        origin_actor: provenance::clean(from),
        cwd: tree.cwd,
        repo: tree.repo,
        worktree: tree.worktree,
        branch: tree.branch,
        bsc_version,
        bsc_built_at,
        harness: f.harness,
        model: f.model,
        session_id: f.session_id,
    }
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

/// `sessions [on|off]` — the GLOBAL off switch (`debug-sessions-have-a-global-off-switch`).
///
/// Reads with no argument, writes with one. A read verb that could change the thing it reports is one
/// nobody can use to diagnose, so the write is only ever the explicit `on`/`off` token — never a flag
/// that could be typo'd into a mutation.
fn cmd_sessions(args: &Args) -> Result<(), String> {
    let store = open_store(&args.db)?;
    // positional[0] is the verb itself; the setting is the one after it.
    let want = args.positional.get(1).cloned();
    let enabled = match want.as_deref() {
        None => store.sessions_enabled().map_err(|e| format!("reading the sessions flag: {e}"))?,
        Some("on") => store.set_sessions_enabled(true).map_err(|e| format!("setting it: {e}"))?,
        Some("off") => store.set_sessions_enabled(false).map_err(|e| format!("setting it: {e}"))?,
        Some(other) => {
            return Err(format!(
                "bsc request sessions: expected `on` or `off`, got '{other}'\n  \
                 (with no argument it REPORTS the current setting)"
            ))
        }
    };
    if args.json {
        // ONE READ, ONE ANSWER. `allowed` is the question the app actually asks — may I start a
        // session? — resolved HERE so the precedence (a policy outranks a pause) exists once, in
        // Rust, rather than being restated by every caller that has to combine two booleans.
        let paused = store.is_paused().map_err(|e| format!("reading the pause flag: {e}"))?;
        println!(
            "{}",
            serde_json::json!({ "enabled": enabled, "paused": paused, "allowed": enabled && !paused })
        );
    } else if enabled {
        println!("enabled — the app may start a debug session per claimed request");
    } else {
        println!(
            "disabled — this machine runs NO debug sessions. The queue is untouched; \
             `bsc request sessions on` re-enables."
        );
    }
    Ok(())
}

/// `pause` / `resume` — the auto-spawn switch (`auto-spawn-has-no-off-switch`).
///
/// One fn for both directions so the two can never disagree about what "paused" means. It reports the
/// value it READ BACK, not the one it asked for, so a write that silently did nothing cannot print
/// success.
fn cmd_pause(args: &Args, paused: bool) -> Result<(), String> {
    let now = open_store(&args.db)?
        .set_paused(paused)
        .map_err(|e| format!("setting the pause flag: {e}"))?;
    println!(
        "{}",
        if now {
            "auto-spawn PAUSED — the app starts no debug sessions and closes the ones it has. \
             The queue is untouched; `bsc request resume` turns it back on."
        } else {
            "auto-spawn ACTIVE — the app starts one debug session per claimed request."
        }
    );
    Ok(())
}

/// `paused` — the read the app polls. No side effect, deliberately: a status verb that could change
/// the thing it reports is one nobody can use to diagnose.
fn cmd_paused(args: &Args) -> Result<(), String> {
    let paused = open_store(&args.db)?.is_paused().map_err(|e| format!("reading the pause flag: {e}"))?;
    if args.json {
        println!("{}", serde_json::json!({ "paused": paused }));
    } else {
        println!("{}", if paused { "paused" } else { "active" });
    }
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

/// WHO filed a request, with the KIND named rather than implied
/// (`a-request-records-where-it-actually-came-from`).
///
/// The kind is printed because the two are not interchangeable and the reader cannot infer which is
/// which: `studio-code:director` is a session the graph can edge to, `lane-c4` is a person or a lane
/// that it cannot, and both are plausible strings for either. It comes from the STORE's classification
/// ([`OriginKind`]), so this function never inspects the string it is printing.
///
/// The two absences are stated, not omitted. `absent` means nobody said, and `unknown` means the row
/// predates the split and nothing recorded which kind its origin was — a reader who sees a bare name
/// with no qualifier would take it for a measured one.
fn filed_by(r: &Request) -> String {
    match r.origin_kind {
        OriginKind::Pane => format!("{} (session pane)", r.origin_pane.as_deref().unwrap_or("-")),
        OriginKind::Actor => format!("{} (actor)", r.origin_actor.as_deref().unwrap_or("-")),
        OriginKind::Both => format!(
            "{} (session pane) · {} (actor)",
            r.origin_pane.as_deref().unwrap_or("-"),
            r.origin_actor.as_deref().unwrap_or("-"),
        ),
        OriginKind::Unknown => format!(
            "{} (kind not recorded — filed before pane and actor were separate)",
            r.origin.as_deref().unwrap_or("-"),
        ),
        OriginKind::Absent => "(not recorded — no session pane and no --from)".to_string(),
    }
}

/// The full one-request block for `get` (human form).
fn request_block(r: &Request) -> String {
    let mut s = format!("request {}  [{}]  ({})\n{}\n{}", r.id, r.status, r.surface, r.display_title, r.text);
    s.push_str(&format!("\nfiled by: {}", filed_by(r)));
    // WHERE, on its own line and only when something was measured. The worktree leads because it is the
    // thing that differs between two otherwise identical reports; the repository is context for it.
    // The cwd is dropped when it IS the working tree, which is the common case — repeating the same
    // path twice on one line trains a reader to skip the line, and the whole point of it is to be read.
    // It survives whenever it differs (a filing from a subdirectory), which is when it says something.
    let cwd = r.cwd.as_deref().filter(|c| Some(*c) != r.worktree.as_deref()).map(str::to_string);
    let where_bits: Vec<String> = [("repo", &r.repo), ("branch", &r.branch), ("cwd", &cwd)]
        .into_iter()
        .filter_map(|(k, v)| v.as_deref().map(|v| format!("{k} {v}")))
        .collect();
    if r.worktree.is_some() || !where_bits.is_empty() {
        let tree = r.worktree.as_deref().unwrap_or("(no working tree)");
        s.push_str(&format!("\nfiled in: {tree}"));
        if !where_bits.is_empty() {
            s.push_str(&format!("  ({})", where_bits.join(", ")));
        }
    }
    // WHICH BUILD — the version alone dates nothing (it has been 0.1.0 throughout), so the build time
    // is the half that answers "is this report still about the current behaviour?".
    if r.bsc_version.is_some() || r.bsc_built_at.is_some() {
        let v = r.bsc_version.as_deref().unwrap_or("(unknown version)");
        let built = r
            .bsc_built_at
            .map(|ms| format!(", built {}", bsc_cli_util::format_epoch_ms(ms)))
            .unwrap_or_default();
        s.push_str(&format!("\nfiled by bsc: {v}{built}"));
    }
    // WHO WAS DRIVING. Each half is independently absent, so the line appears with whichever half was
    // actually observed rather than being suppressed because the other was not.
    let driver: Vec<String> = [&r.harness, &r.model]
        .into_iter()
        .filter_map(|v| v.as_deref().map(str::to_string))
        .chain(r.session_id.as_deref().map(|s| format!("session {s}")))
        .collect();
    if !driver.is_empty() {
        s.push_str(&format!("\ndriven by: {}", driver.join(" · ")));
    }
    if let Some(cmd) = &r.cmd {
        s.push_str(&format!("\nfailing command: {cmd}"));
    }
    if let Some(shot) = &r.shot_path {
        // Through `artifact_ref`: a capture is transient (the shots dir is a fixed window), so a path
        // recorded here outlives its pixels by design. Printing it bare reads as live when it is not.
        s.push_str(&format!("\nshot: {}", bsc_cli_util::artifact_ref(shot)));
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

    /// Serializes tests that mutate `$BSC_AUDIT_PANE`, a process-global env var `cargo test` threads
    /// share within one binary (#3382's disease, same fix bsc-persona's `PACKAGED_ENV_LOCK` and
    /// bsc-util's `UI_ENV_LOCK` already apply). nextest forks per test and would not need it, but the
    /// gate runs both.
    static AUDIT_PANE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

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
        // The pane is forced ABSENT under the lock (the #184 pattern, one test below). It used not to
        // matter here because `--from` won outright and the block printed only the merged value; since
        // `a-request-records-where-it-actually-came-from` a session that ALSO passes `--from` records
        // BOTH, so an ambient `$BSC_AUDIT_PANE` — real in a debug-studio pane, or left behind by a
        // sibling test in the same process — changes what this asserts. Pinning it is the fix; reading
        // whatever the environment happens to hold is what made it a coin flip.
        let _guard = AUDIT_PANE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_pane = std::env::var("BSC_AUDIT_PANE").ok();
        std::env::remove_var("BSC_AUDIT_PANE");

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
        // …and `get`'s human block names the filer in words, not just as a column — and says WHAT KIND
        // it is, which a bare name cannot.
        assert!(request_block(&r).contains("filed by: librarian-studio:typescript (actor)"));

        let _ = std::fs::remove_dir_all(&dir);
        if let Some(p) = prev_pane {
            std::env::set_var("BSC_AUDIT_PANE", p);
        }
    }

    /// A request filed with neither flag nor pane still lists and still labels — the unattributed path
    /// must not produce an empty column or an empty title.
    #[test]
    fn an_unattributed_request_still_lists_and_labels() {
        // #184: `cmd_new` resolves origin from the REAL `$BSC_AUDIT_PANE` (line 245 above), not
        // through a testable seam — so this test, which asserts the no-pane case, spuriously failed
        // when run from a debug-studio pane whose shell genuinely carries that var. Force it absent
        // for the duration, same pattern as `whatami_with_no_pane_to_infer_says_so_rather_than_guessing`
        // in bsc-persona.
        let _guard = AUDIT_PANE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_pane = std::env::var("BSC_AUDIT_PANE").ok();
        std::env::remove_var("BSC_AUDIT_PANE");

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
        // CHANGED by `a-request-records-where-it-actually-came-from`: the block now STATES the absence
        // instead of omitting the line. The guard is the same in substance — nothing may be CLAIMED as
        // the filer — but an omitted field is indistinguishable from one the reader skimmed past, and
        // "nobody said" is precisely the answer this store now exists to be able to give out loud.
        let block = request_block(&r);
        assert!(block.contains("filed by: (not recorded"), "the absence is STATED, not omitted: {block}");

        let _ = std::fs::remove_dir_all(&dir);
        if let Some(p) = prev_pane {
            std::env::set_var("BSC_AUDIT_PANE", p);
        }
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

    // ── `a-request-records-where-it-actually-came-from` ─────────────────────────────────────────────

    /// THE GUARD THE ITEM ASKS FOR: an app-pane filing and a shell filing are told apart by the STORE,
    /// not by a heuristic in the reader.
    ///
    /// Both requests are filed through the real `cmd_new`, one with `$BSC_AUDIT_PANE` set and no
    /// `--from` (a session in an app pane, whose charter forbids the flag) and one with `--from` and no
    /// pane (a dev session at a shell, which CLAUDE.md tells to pass it). The assertion is on
    /// `origin_kind` and on which COLUMN is populated — it never looks at the strings, which is the
    /// whole point: the old single field could only be classified by hunting for a `:`, and that
    /// heuristic calls `lane-c4` a pane. Note the two values are deliberately chosen to DEFEAT it —
    /// the shell actor here contains a colon and the pane id does not.
    #[test]
    fn the_store_tells_an_app_pane_filing_from_a_shell_filing() {
        let _guard = AUDIT_PANE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_pane = std::env::var("BSC_AUDIT_PANE").ok();

        let dir = std::env::temp_dir().join(format!("bsc-request-kind-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();

        // 1 — an APP PANE. The pane id is deliberately colon-free, so a shape heuristic would miss it.
        std::env::set_var("BSC_AUDIT_PANE", "designstudio");
        cmd_new(&args_for(vec!["new", "the preview cannot mount a kit component"], |a| a.db = Some(dbp.clone())))
            .unwrap();
        // 2 — a SHELL. The actor deliberately CONTAINS a colon, so a shape heuristic would call it a pane.
        std::env::remove_var("BSC_AUDIT_PANE");
        cmd_new(&args_for(vec!["new", "impl history errors for a committed-only record"], |a| {
            a.db = Some(dbp.clone());
            a.from = Some("lane-c4: princess-bubblegum".into());
        }))
        .unwrap();

        let store = open_store(&Some(dbp.clone())).unwrap();
        let (pane_filed, shell_filed) = (store.get(1).unwrap().unwrap(), store.get(2).unwrap().unwrap());

        assert_eq!(pane_filed.origin_kind, OriginKind::Pane, "a session filing is a PANE origin");
        assert_eq!(pane_filed.origin_pane.as_deref(), Some("designstudio"));
        assert_eq!(pane_filed.origin_actor, None, "and it names no actor, because nobody typed one");

        assert_eq!(shell_filed.origin_kind, OriginKind::Actor, "a shell filing is an ACTOR origin");
        assert_eq!(shell_filed.origin_actor.as_deref(), Some("lane-c4: princess-bubblegum"));
        assert_eq!(shell_filed.origin_pane, None, "no session, so no pane — even though the actor has a colon");

        // The two disagree on kind, and neither test above read a character of the values to decide.
        assert_ne!(pane_filed.origin_kind, shell_filed.origin_kind);
        assert!(pane_filed.origin_kind.names_a_pane(), "only the pane one can be edged to a graph node");
        assert!(!shell_filed.origin_kind.names_a_pane());

        // The merged `origin` is written EXACTLY as before, so the 39 rows and every reader of it are
        // untouched — the split is additive.
        assert_eq!(pane_filed.origin.as_deref(), Some("designstudio"));
        assert_eq!(shell_filed.origin.as_deref(), Some("lane-c4: princess-bubblegum"), "--from still wins there");

        let _ = std::fs::remove_dir_all(&dir);
        match prev_pane {
            Some(p) => std::env::set_var("BSC_AUDIT_PANE", p),
            None => std::env::remove_var("BSC_AUDIT_PANE"),
        }
    }

    /// A session that ALSO passes `--from` records BOTH — one no longer overwrites the other, which is
    /// what the single field forced.
    #[test]
    fn a_session_that_also_names_an_actor_records_both() {
        let _guard = AUDIT_PANE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let prev_pane = std::env::var("BSC_AUDIT_PANE").ok();
        std::env::set_var("BSC_AUDIT_PANE", "studio-code:director");

        let dir = std::env::temp_dir().join(format!("bsc-request-both-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("requests.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();
        cmd_new(&args_for(vec!["new", "bsc teams cannot rename a position"], |a| {
            a.db = Some(dbp.clone());
            a.from = Some("kevin".into());
        }))
        .unwrap();
        let r = open_store(&Some(dbp.clone())).unwrap().get(1).unwrap().unwrap();
        assert_eq!(r.origin_kind, OriginKind::Both);
        assert_eq!(r.origin_pane.as_deref(), Some("studio-code:director"), "the session is still known");
        assert_eq!(r.origin_actor.as_deref(), Some("kevin"), "and so is who was driving it");
        let block = request_block(&r);
        assert!(block.contains("studio-code:director (session pane)") && block.contains("kevin (actor)"), "{block}");

        let _ = std::fs::remove_dir_all(&dir);
        match prev_pane {
            Some(p) => std::env::set_var("BSC_AUDIT_PANE", p),
            None => std::env::remove_var("BSC_AUDIT_PANE"),
        }
    }

    /// THE LEAN LIST STAYS LEAN. `list` is a TSV a session reads from a shell; the filing context goes
    /// on `get`. A column added here silently breaks every `cut -f` reading the queue, so the shape is
    /// pinned by count rather than described in a comment.
    #[test]
    fn the_lean_list_line_gains_no_columns() {
        let store = Store::open_in_memory().unwrap();
        let r = store
            .create(&NewRequest {
                text: "x".into(),
                ts: 1,
                context: FilingContext {
                    origin_pane: Some("designstudio".into()),
                    cwd: Some("/w/wt-131".into()),
                    repo: Some("/w".into()),
                    branch: Some("develop".into()),
                    harness: Some("claude-code".into()),
                    ..Default::default()
                },
                ..Default::default()
            })
            .unwrap();
        let line = request_line(&r);
        assert_eq!(line.split('\t').count(), 6, "still id/status/surface/origin/cmd/text: {line}");
        for absent in ["/w/wt-131", "develop", "claude-code"] {
            assert!(!line.contains(absent), "the context does NOT ride the lean list: {line}");
        }
        // …and every one of them IS on `get`, which is where the detail was moved to, not dropped.
        let block = request_block(&r);
        for present in ["/w/wt-131", "develop", "claude-code"] {
            assert!(block.contains(present), "get carries the context: {block}");
        }
    }

    /// The cwd is shown only when it ADDS something. Repeating the working tree's path twice on one
    /// line is how a reader learns to skip the line.
    #[test]
    fn the_cwd_is_omitted_when_it_is_the_working_tree_and_kept_when_it_is_not() {
        let store = Store::open_in_memory().unwrap();
        let same = FilingContext {
            worktree: Some("/w/wt-131".into()),
            cwd: Some("/w/wt-131".into()),
            repo: Some("/w".into()),
            ..Default::default()
        };
        let r = store.create(&NewRequest { text: "a".into(), ts: 1, context: same, ..Default::default() }).unwrap();
        let b = request_block(&r);
        assert!(b.contains("filed in: /w/wt-131"), "{b}");
        assert!(!b.contains("cwd "), "the cwd said nothing the tree had not already: {b}");

        let deeper = FilingContext {
            worktree: Some("/w/wt-131".into()),
            cwd: Some("/w/wt-131/crates/bsc-request".into()),
            ..Default::default()
        };
        let r2 = store.create(&NewRequest { text: "b".into(), ts: 2, context: deeper, ..Default::default() }).unwrap();
        assert!(request_block(&r2).contains("cwd /w/wt-131/crates/bsc-request"), "a subdirectory DOES say something");
    }

    /// A filing genuinely records WHERE it happened — this test runs inside a git worktree, so the
    /// discovery has a real tree to find and the assertion is that it found one rather than that it
    /// found a particular one (which would pin the test to a machine).
    #[test]
    fn a_real_filing_records_the_tree_and_the_build_that_made_it() {
        let ctx = capture_context(None, &|_| None);
        assert!(ctx.cwd.is_some(), "the cwd is always measurable");
        assert_eq!(ctx.repo.is_some(), ctx.branch.is_some(), "repo and branch resolve together or not at all");
        if let (Some(repo), Some(wt)) = (&ctx.repo, &ctx.worktree) {
            assert!(wt.starts_with(repo), "a working tree lives under its repository: {wt} / {repo}");
        }
        assert_eq!(ctx.bsc_version.as_deref(), Some(provenance::BSC_VERSION), "which build filed it");
        // The env lookup said nothing, so nothing about the driver is recorded — not a default.
        assert_eq!((ctx.harness, ctx.model, ctx.session_id), (None, None, None));
    }

    /// A row filed BEFORE the split says so, and is not reclassified by looking at its text. This is
    /// the state all 39 live rows are in, and the one a shape heuristic gets wrong.
    #[test]
    fn a_legacy_merged_origin_reads_as_unknown_rather_than_being_guessed_at() {
        for legacy in ["lane-c4", "studio-code:director", "princess-bubblegum (dev session)"] {
            let k = OriginKind::of(None, None, Some(legacy));
            assert_eq!(k, OriginKind::Unknown, "'{legacy}' predates the split — the kind was never recorded");
            assert!(!k.names_a_pane(), "so it is not asserted to be a node either");
        }
        assert_eq!(OriginKind::of(None, None, None), OriginKind::Absent, "and nothing at all is ABSENT");
        assert_eq!(OriginKind::of(None, None, Some("   ")), OriginKind::Absent, "blank is nothing, not something");
    }

    /// Build an `Args` for a handler test — the command word + positionals, then a mutator for flags.
    fn args_for(positional: Vec<&str>, set: impl FnOnce(&mut Args)) -> Args {
        let mut a = parse_args(positional.into_iter().map(String::from).collect()).unwrap();
        set(&mut a);
        a
    }
}
