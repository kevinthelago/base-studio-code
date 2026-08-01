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
//! key. That is all of `bsc ui …`, which is the surface the Design Studio waits on.

use std::io::{BufRead, Write};

/// The commands a warm process may answer.
///
/// READ-ONLY and project-less, both load-bearing: a write would need per-request store env this process
/// cannot safely switch, and anything outside `bsc ui` either needs a project key or has not been shown
/// to funnel its output through the capture helpers.
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
