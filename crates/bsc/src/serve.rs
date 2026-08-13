//! `bsc serve` (#4152) — a WARM `bsc`: one long-lived process answering many requests.
//!
//! Every `bsc …` invoke from the desktop spawned a fresh process. Measured on the real staged binary:
//! `bsc help` (pure startup, no work) is 39ms and `bsc ui list --graph` is 49ms — so ~39ms of every call
//! is process launch, and the app makes ~1,500 of them in a session.
//!
//! ## The protocol
//!
//! Line-delimited JSON both ways, one request per line, one response per line:
//!
//! ```text
//! →  {"id":7,"args":["ui","list","--graph"]}
//! ←  {"id":7,"ok":true,"out":"[…]"}
//! ←  {"id":7,"ok":false,"err":"unknown flag '--nope'"}
//! ```
//!
//! Requests are answered STRICTLY IN ORDER on one thread. Serialization is not a compromise here: the
//! calls become ~10ms, so six serialized 10ms answers beat six concurrent 500ms spawns — and one thread
//! is what makes the thread-local output capture sound.
//!
//! ## Why output capture, and why an allow-list
//!
//! The dispatch writes to stdout, which is also the protocol channel. Each request therefore runs under
//! [`bsc_util::capture_output`], so the verb's output lands in the response instead of the stream. That
//! works for any verb whose output flows through the shared print helpers (`print_json`, `print_raw`) —
//! the hot read surface. A verb that writes to stdout by some other route would corrupt the stream, so
//! [`is_servable`] is an explicit allow-list rather than a guess, and the desktop falls back to a
//! one-shot spawn for everything else.
//!
//! ## What it deliberately does NOT do
//!
//! No per-request environment. `wire_bsc_stores` sets `BSC_PLAN_DB`/`BSC_DATA_DB` per call from the
//! project key, and env is process-global — so a warm child can only serve calls carrying NO project
//! key. That covers `bsc ui …` (the surface the Design Studio waits on) and the GLOBAL store lists —
//! persona, teams, skills, blueprints, project links + rows — which
//! #the-warm-bsc-answers-the-boot-reads-too added after `bsc perf spawns` caught the app launching
//! eighteen processes in one second on every page load, most of them exactly those reads. Per-project
//! reads like `plan list` stay one-shot.

use std::io::{BufRead, Write};

/// The commands a warm process may answer.
///
/// READ-ONLY and project-less, both load-bearing: a write would need per-request store env this process
/// cannot safely switch, and a verb not shown to funnel its output through the capture helpers would
/// write into the protocol stream instead of its own response.
/// May `args` be answered by a warm process? The ONE definition lives in `bsc_util` so this loop and
/// the desktop client that routes to it cannot drift — a client sending something the server refuses
/// would stall a call that should simply have been spawned.
pub fn is_servable(args: &[String]) -> bool {
    bsc_util::is_servable_warm(args)
}

/// One request line.
#[derive(serde::Deserialize)]
struct Request {
    id: u64,
    args: Vec<String>,
}

/// Run the serve loop until stdin closes.
///
/// Never fails the process on bad input: a malformed line is answered as a failed request, because a
/// warm process that exited on one bad line would take every subsequent call down with it.
pub fn run() -> Result<(), String> {
    let stdin = std::io::stdin();
    let mut out = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break }; // the pipe closed mid-read — the desktop is gone
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Request>(&line) {
            Ok(req) => answer(req),
            // No id to answer with, so report against a sentinel rather than staying silent — a client
            // waiting on a response must not hang because its line was unparseable.
            Err(e) => fail(0, &format!("bsc serve: malformed request: {e}")),
        };
        if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
            break; // the desktop closed the pipe
        }
    }
    Ok(())
}

/// Dispatch one request under output capture.
fn answer(req: Request) -> String {
    if !is_servable(&req.args) {
        // The desktop checks the same predicate before sending, so this is a contract breach rather
        // than a routine miss — say so instead of silently running it.
        return fail(req.id, "bsc serve: refused — this command is not servable warm");
    }
    let cmd = req.args[0].clone();
    let rest: Vec<String> = req.args[1..].to_vec();
    let (result, captured) = bsc_util::capture_output(|| crate::dispatch(&cmd, rest));
    match result {
        Ok(()) => {
            let mut o = serde_json::Map::new();
            o.insert("id".into(), req.id.into());
            o.insert("ok".into(), true.into());
            o.insert("out".into(), captured.into());
            serde_json::Value::Object(o).to_string()
        }
        Err(e) => fail(req.id, &e),
    }
}

fn fail(id: u64, err: &str) -> String {
    let mut o = serde_json::Map::new();
    o.insert("id".into(), id.into());
    o.insert("ok".into(), false.into());
    o.insert("err".into(), err.into());
    serde_json::Value::Object(o).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn only_project_less_read_verbs_are_servable() {
        assert!(is_servable(&a(&["ui", "list", "--full"])));
        assert!(is_servable(&a(&["ui", "kit", "list"])));
        assert!(is_servable(&a(&["ui", "theme", "list"])));
        // A WRITE is never servable — it would need per-request store env this process cannot switch.
        assert!(!is_servable(&a(&["ui", "set"])));
        assert!(!is_servable(&a(&["ui", "remove", "x"])));
        // Another command entirely: `plan` needs a project key, so it stays one-shot.
        assert!(!is_servable(&a(&["plan", "list"])));
        assert!(!is_servable(&a(&["graph", "dump"])));
        // Degenerate input falls back rather than panicking.
        assert!(!is_servable(&a(&[])));
        assert!(!is_servable(&a(&["ui"])));
    }

    #[test]
    fn the_boot_reads_are_servable() {
        // #the-warm-bsc-answers-the-boot-reads-too — the exact set `bsc perf spawns` caught the app
        // launching a process for, eighteen in one second, on every page load. Each was confirmed to
        // emit through the shared print helpers before landing here.
        for verb in [
            vec!["persona", "list", "--full"],
            vec!["teams", "list", "--full"],
            vec!["blueprint", "list", "--full"],
            vec!["skill", "list", "--full"],
            vec!["skill", "group", "list"],
            vec!["project", "link", "list", "--json"],
            vec!["project", "db", "list", "--json"],
        ] {
            assert!(is_servable(&a(&verb)), "{verb:?} should be answered warm");
        }
    }

    #[test]
    fn a_write_sitting_next_to_a_served_read_is_still_refused() {
        // The reason every entry is a COMPLETE verb path rather than a prefix. Each of these shares its
        // first tokens with something on the list, and every one of them is a write: matching on
        // ("skill","group") or ("project","link") would hand the warm child a mutation it must never
        // answer, with store env it cannot switch per request.
        for verb in [
            vec!["skill", "group", "add"],
            vec!["skill", "group", "remove", "x"],
            vec!["project", "link", "add", "a", "b", "uses"],
            vec!["project", "link", "remove", "l1"],
            vec!["project", "link", "set", "l1"],
            vec!["project", "db", "add", "k"],
            vec!["project", "db", "remove", "k"],
            vec!["project", "db", "state", "k", "open"],
            vec!["persona", "set"],
            vec!["persona", "rename", "x", "Y"],
            vec!["teams", "set"],
            vec!["blueprint", "set"],
        ] {
            assert!(!is_servable(&a(&verb)), "{verb:?} is a WRITE and must be spawned, never served");
        }
    }

    #[test]
    fn a_read_whose_output_was_not_verified_stays_off_the_list() {
        // `get` on a json-store noun prints through a plain `println!` on its non-`--raw` path, so it
        // would write into the protocol stream rather than the capture buffer. It is absent on purpose,
        // and this pins that — the list is verified, not guessed by shape.
        assert!(!is_servable(&a(&["persona", "get", "review-bot"])));
        assert!(!is_servable(&a(&["teams", "get", "core"])));
        assert!(!is_servable(&a(&["blueprint", "get", "default"])));
        // Sibling reads on the same commands that were never audited stay off too.
        assert!(!is_servable(&a(&["project", "list"])));
        assert!(!is_servable(&a(&["project", "progress"])));
        assert!(!is_servable(&a(&["skill", "get", "x"])));
    }

    #[test]
    fn a_prefix_alone_is_not_enough() {
        // A bare command, or a served verb's parent, is not itself servable.
        assert!(!is_servable(&a(&["persona"])));
        assert!(!is_servable(&a(&["skill", "group"])));
        assert!(!is_servable(&a(&["project", "link"])));
        assert!(!is_servable(&a(&["project", "db"])));
    }

    #[test]
    fn a_refused_request_is_answered_not_dropped() {
        // A client waiting on an id must always get that id back, or it hangs forever.
        let r = answer(Request { id: 9, args: a(&["plan", "list"]) });
        let v: serde_json::Value = serde_json::from_str(&r).unwrap();
        assert_eq!(v["id"], 9);
        assert_eq!(v["ok"], false);
        assert!(v["err"].as_str().unwrap().contains("not servable"));
    }

    #[test]
    fn an_uncapturable_verb_is_gated_before_dispatch() {
        // `help` is not in SERVABLE_SUBS, so it is refused rather than run — which is what keeps a verb
        // whose output does not funnel through the capture helpers off the protocol stream.
        let r = answer(Request { id: 1, args: a(&["ui", "help"]) });
        let v: serde_json::Value = serde_json::from_str(&r).unwrap();
        assert_eq!(v["ok"], false);
    }
}
