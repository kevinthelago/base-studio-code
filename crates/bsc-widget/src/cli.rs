//! `bsc widget` — the verbs.

use crate::{known_ids, Action, Widget, WidgetRequest, WidgetResult, KIND, WIDGETS};
use bsc_cli_util::{args, CmdDoc};
use serde_json::json;

pub const TAGLINE: &str = "toggleable UI surfaces — one node per widget, and the stream it subscribes to";

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every widget node: what it is, and what feeds it",
        usage: "\
bsc widget list [--json|--pretty]

A widget is a NODE: one toggleable UI surface and the data stream it subscribes to.
This lists them, so an LLM or a person can see what exists before turning anything on.

A WIDGET WITH NO STREAM IS A REAL ANSWER, not a missing one. A static panel
legitimately subscribes to nothing, and that must stay distinguishable from a widget
whose stream is simply not arriving — the second is a fault, the first is a design.
Needs no running app.",
    },
    CmdDoc {
        name: "open",
        summary: "put a widget on screen in its own window",
        usage: "\
bsc widget open <id> [--timeout <ms>] [--json|--pretty]

Asks the RUNNING desktop app to open the widget's window.

IT REPORTS WHICH THING HAPPENED: opened, or already-open (the existing window is
focused rather than a second one created). With more than one widget, a bare success
is not an answer — the outcome names the widget it is about.

AN UNKNOWN ID IS REFUSED BY NAMING WHAT EXISTS, never by opening nothing and
reporting success. The id selects among a CLOSED set: it is user-controlled input, so
it can choose among widgets and can never choose a code path.

THE APP NOT RUNNING IS ITS OWN ANSWER, distinct from a failure to open — the two send
you to debug different things.",
    },
    CmdDoc {
        name: "close",
        summary: "take a widget off screen",
        usage: "bsc widget close <id> [--timeout <ms>] [--json|--pretty]\n\nThe inverse of `open`, reporting closed or already-closed.",
    },
    CmdDoc {
        name: "toggle",
        summary: "open a closed widget, close an open one — and say which",
        usage: "\
bsc widget toggle <id> [--timeout <ms>] [--json|--pretty]

For a caller that cannot know the current state. It reports which way it went, because
that is the thing a caller could not have known and now needs.",
    },
];

const DEFAULT_TIMEOUT_MS: i64 = 4_000;
const POLL_INTERVAL_MS: u64 = 40;
const STALE_MS: i64 = 60_000;

#[derive(Default)]
struct Args {
    json: bool,
    pretty: bool,
    timeout_ms: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, rest| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--timeout" => {
                a.timeout_ms = Some(
                    rest.value("--timeout needs a whole number of milliseconds")?
                        .parse()
                        .map_err(|_| "--timeout needs a whole number of milliseconds".to_string())?,
                );
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn cmd_list(a: &Args) -> Result<(), String> {
    let rows: Vec<_> = WIDGETS
        .iter()
        .map(|w: &Widget| {
            json!({ "id": w.id, "title": w.title, "stream": w.stream, "width": w.width, "height": w.height })
        })
        .collect();
    bsc_cli_util::emit(a.pretty, a.json, &json!({ "widgets": rows }), || {
        let mut s = String::new();
        for w in WIDGETS {
            s.push_str(&format!("  {:<12} {:<22} {}\n", w.id, w.title, w.stream.describe()));
        }
        s
    });
    Ok(())
}

/// Resolve the id a caller typed, refusing anything outside the closed set.
fn resolve(a: &Args) -> Result<&'static Widget, String> {
    let id = a
        .positional
        .get(1)
        .ok_or_else(|| format!("needs a widget id — one of: {}", known_ids().join(", ")))?;
    crate::find(id).ok_or_else(|| {
        // Naming what exists is the difference between an error a person can act
        // on and one they have to go looking for.
        format!("no widget {id:?} — the widgets are: {}", known_ids().join(", "))
    })
}

fn send(a: &Args, action: Action) -> Result<(), String> {
    let w = resolve(a)?;
    let chan = bsc_appchan::chan_dir()?;
    let now = now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS);
    let id = bsc_appchan::new_id(now);
    let req = WidgetRequest { action, id: w.id.to_string() };
    bsc_appchan::write_request(&chan, &id, KIND, now, &req)?;

    let timeout = a.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS);
    let reply = bsc_appchan::poll_reply(&chan, &id, timeout, POLL_INTERVAL_MS, || {
        format!(
            "the desktop app did not answer within {timeout}ms.\n\
             The request is at {}.\n\
             Is the app running? `bsc widget` asks a LIVE app to open a window; it cannot open one alone.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    let res: WidgetResult = bsc_appchan::take_payload(reply)?;

    bsc_cli_util::emit(a.pretty, a.json, &res, || {
        let mut s = res.outcome.describe(&res.title);
        if !res.outcome.changed() {
            s.push_str("  (nothing changed)");
        }
        s
    });
    Ok(())
}

pub fn run(argv: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(argv)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("list") => cmd_list(&a),
        Some("open") => send(&a, Action::Open),
        Some("close") => send(&a, Action::Close),
        Some("toggle") => send(&a, Action::Toggle),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(v: &[&str]) -> Args {
        parse_args(v.iter().map(|s| s.to_string()).collect()).unwrap()
    }

    #[test]
    fn every_command_is_documented_so_a_verb_cannot_be_added_silently() {
        let names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["list", "open", "close", "toggle"]);
        for c in COMMANDS {
            assert!(!c.summary.is_empty() && c.usage.contains(c.name), "{}", c.name);
        }
    }

    #[test]
    fn list_needs_no_running_app() {
        assert!(run(vec!["list".into(), "--json".into()], "bsc widget").is_ok());
    }

    #[test]
    fn an_unknown_id_is_refused_and_names_what_exists() {
        let e = resolve(&args_of(&["open", "nope"])).unwrap_err();
        assert!(e.contains("nope"), "the error must quote what was typed: {e}");
        assert!(e.contains("spectrum"), "and name what exists: {e}");
    }

    #[test]
    fn a_missing_id_lists_the_choices_rather_than_defaulting_to_one() {
        // Defaulting would open a window the caller did not ask for.
        let e = resolve(&args_of(&["open"])).unwrap_err();
        assert!(e.contains("spectrum"), "{e}");
    }

    #[test]
    fn a_traversal_shaped_id_selects_nothing() {
        // The id is user-controlled input; it chooses among a closed set or
        // nothing at all, and never reaches a path or an index.
        for bad in ["../etc/passwd", "spectrum/../x", "%2e%2e"] {
            assert!(resolve(&args_of(&["open", bad])).is_err(), "{bad}");
        }
    }

    #[test]
    fn help_renders_and_an_unknown_verb_is_refused() {
        assert!(run(vec!["help".into()], "bsc widget").is_ok());
        assert!(run(vec!["nope".into()], "bsc widget").unwrap_err().contains("nope"));
    }
}
