//! The coordination log, projected at `/coord`.
//!
//! **This is the module that tests whether the projection model generalizes**, because a coord
//! log is not records — it is an append-only stream. It projects as one chronological file plus
//! index directories whose files hold the matching *lines*. Same interface, different shape.
//!
//! ```text
//! log                    every event, chronological, one per line
//! latest                 the most recent events (a bounded tail)
//! by-pane/<pane>         that pane's events
//! by-verb/<verb>         every event of that verb (ask, answer, landed, …)
//! malformed              lines that did not parse, kept rather than dropped
//! README
//! ```
//!
//! The wire format is TSV: `timestamp \t pane \t verb \t message \t actor`.
//!
//! Why an isolated agent needs this at all: the namespace binds its own worktree and the store
//! projections, and nothing else. Without `/coord` a sandboxed agent has **no way to see the
//! coordination stream** — not a slow way, no way.

use crate::{slug, Tree};
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Event {
    pub ts: String,
    pub pane: String,
    pub verb: String,
    pub message: String,
    pub actor: String,
}

/// How many events `latest` holds. Bounded because the whole point of a tail is that it fits in
/// a glance — an unbounded one is just `log` again.
pub const LATEST: usize = 50;

/// Parse the TSV wire format. Lines with fewer than three fields are returned separately rather
/// than dropped: a malformed line is evidence about the writer, and silently discarding it makes
/// the projection lie about what the log contains.
pub fn parse(raw: &str) -> (Vec<Event>, Vec<String>) {
    let mut events = Vec::new();
    let mut malformed = Vec::new();
    for l in raw.lines() {
        if l.trim().is_empty() {
            continue;
        }
        let f: Vec<&str> = l.split('\t').collect();
        if f.len() < 3 {
            malformed.push(l.to_string());
            continue;
        }
        events.push(Event {
            ts: f[0].trim().to_string(),
            pane: f[1].trim().to_string(),
            verb: f[2].trim().to_string(),
            message: f.get(3).unwrap_or(&"").trim().to_string(),
            actor: f.get(4).unwrap_or(&"").trim().to_string(),
        });
    }
    (events, malformed)
}

fn render(e: &Event) -> String {
    format!("{}\t{}\t{}\t{}\t{}", e.ts, e.pane, e.verb, e.message, e.actor)
}

pub fn project(events: &[Event], malformed: &[String], generated_at: &str) -> Tree {
    let mut t = Tree::new();
    let mut by_pane: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_verb: BTreeMap<String, Vec<String>> = BTreeMap::new();

    let mut all = String::new();
    for e in events {
        let r = render(e);
        all.push_str(&r);
        all.push('\n');
        by_pane.entry(slug(&e.pane)).or_default().push(r.clone());
        by_verb.entry(slug(&e.verb)).or_default().push(r);
    }
    t.insert("log".into(), all);

    let tail: Vec<String> = events.iter().rev().take(LATEST).rev().map(render).collect();
    t.insert("latest".into(), crate::lines(&tail));

    for (k, v) in by_pane {
        t.insert(format!("by-pane/{k}"), crate::lines(&v));
    }
    for (k, v) in by_verb {
        t.insert(format!("by-verb/{k}"), crate::lines(&v));
    }

    // Always present, even when empty — a predictable shape means an agent never has to test for
    // a file's existence before reading it.
    t.insert("malformed".into(), crate::lines(malformed));
    t.insert("schema".into(), schema());
    t.insert("README".into(), readme(events.len(), malformed.len(), generated_at));
    t
}

fn readme(events: usize, malformed: usize, generated_at: &str) -> String {
    format!(
        "The coordination log, as files. Tab-separated: ts, pane, verb, message, actor.\n\
         \n\
         log                every event, chronological\n\
         latest             the most recent {LATEST}\n\
         by-pane/<pane>     that pane's events\n\
         by-verb/<verb>     every event of that verb\n\
         malformed          lines that did not parse ({malformed})\n\
         \n\
         Index names are SLUGGED — a pane id like design-studio:designer-react becomes\n\
         design-studio-designer-react, because ':' and '/' cannot be one path segment.\n\
         \n\
         THIS IS A SNAPSHOT, NOT A LIVE VIEW.\n\
         {events} event(s), projected at {generated_at}. It does not grow as the log does.\n"
    )
}


// ── WRITES ──────────────────────────────────────────────────────────────────────────────────
//
// A projection is read-only and a snapshot, so an agent cannot emit by writing into it. The
// write surface is a separate, WRITABLE outbox bound at `/coord/out`, drained host-side.
//
// The shape is deliberately the most echo-native one available: **the FILENAME is the verb and
// the CONTENTS are the message.**
//
//     echo "Which branch should I target?" > /coord/out/ask
//     echo "stream-3 landed on develop"    > /coord/out/landed.42
//
// A `<verb>.<suffix>` form lets one agent emit several events of the same verb before a drain.
//
// ── The tension this has to answer ──────────────────────────────────────────────────────────
//
// Filesystems are BAD AT TYPED ERRORS. `echo bogus > /coord/out/nonsense` fails with an errno, or
// worse succeeds and is dropped later — and that correction loop is precisely what substitutes
// for training data on an unfamiliar surface. Without FUSE a write cannot return a typed error,
// so the loop is supplied in two other places instead:
//
//   PREVENTION  `/coord/schema` is readable and names every accepted verb, so an agent can be
//               right the first time rather than discovering the vocabulary by failing.
//   CORRECTION  a rejected entry is written back as `<name>.rejected` whose text NAMES THE FIX.
//               Asynchronous, and honestly so — but it closes the loop.

/// The verbs the log accepts.
///
/// This is the OBSERVED vocabulary (every verb present in the real 447-event log) unioned with
/// the emitters CLAUDE.md documents but which had not fired yet — `merged`, `closed`, `failed`.
/// Deriving it from the data alone would have silently refused three documented verbs the first
/// time one was used.
pub const VERBS: &[&str] = &[
    "answer", "ask", "assign", "brief", "closed", "commission", "deliver", "failed", "fork",
    "issue", "landed", "maintain", "merged", "request", "request-resolved", "waiting", "woke",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Rejection {
    UnknownVerb(String),
    EmptyMessage(String),
}

impl Rejection {
    /// The text written to `<name>.rejected`. It must NAME THE FIX — a rejection an agent cannot
    /// act on is the same as a silent drop, only slower.
    pub fn fix(&self) -> String {
        match self {
            Rejection::UnknownVerb(v) => format!(
                "rejected: {v:?} is not an accepted verb.

fix: rename the file to one of:
  {}

the verb is the part of the filename before the first dot, so
  echo \"...\" > /coord/out/ask
and for several of the same verb
  echo \"...\" > /coord/out/ask.2
",
                VERBS.join(" ")
            ),
            Rejection::EmptyMessage(v) => format!(
                "rejected: the {v:?} entry has no message.

fix: the FILENAME is the verb and the CONTENTS are the message:
  echo \"what you want to say\" > /coord/out/{v}
"
            ),
        }
    }
}

/// The verb is the filename up to the first dot, so `landed.42` and `landed` are both `landed`.
fn verb_of(filename: &str) -> &str {
    filename.split('.').next().unwrap_or(filename)
}

/// Whitespace in a message is NORMALIZED rather than rejected: the log is TSV, so an embedded tab
/// or newline would corrupt a record, but blocking an agent over whitespace it cannot see would
/// be hostile. The normalization is stated in `/coord/schema`, so it is documented rather than
/// silent. A wrong VERB, by contrast, is a hard rejection — that one an agent must know about.
fn normalize(msg: &str) -> String {
    msg.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Validate one outbox entry into an event.
pub fn accept(filename: &str, contents: &str, pane: &str, ts: &str, actor: &str) -> Result<Event, Rejection> {
    let verb = verb_of(filename);
    if !VERBS.contains(&verb) {
        return Err(Rejection::UnknownVerb(verb.to_string()));
    }
    let message = normalize(contents);
    if message.is_empty() {
        return Err(Rejection::EmptyMessage(verb.to_string()));
    }
    Ok(Event {
        ts: ts.to_string(),
        pane: pane.to_string(),
        verb: verb.to_string(),
        message,
        actor: actor.to_string(),
    })
}

/// Drain an outbox: accepted events to append, and `(name.rejected, fix-text)` pairs to write back.
///
/// Entries are processed in the order given; the caller sorts, so a drain is deterministic.
pub fn drain(
    entries: &[(String, String)],
    pane: &str,
    ts: &str,
    actor: &str,
) -> (Vec<Event>, Vec<(String, String)>) {
    let mut ok = Vec::new();
    let mut rejected = Vec::new();
    for (name, contents) in entries {
        if name.ends_with(".rejected") {
            continue; // our own feedback, not a new entry
        }
        match accept(name, contents, pane, ts, actor) {
            Ok(e) => ok.push(e),
            Err(r) => rejected.push((format!("{name}.rejected"), r.fix())),
        }
    }
    (ok, rejected)
}

/// The readable contract, projected at `/coord/schema`. Prevention, so an agent can be right the
/// first time instead of learning the vocabulary by being refused.
pub fn schema() -> String {
    // Built as a joined line list rather than one multi-line literal: a backslash line
    // continuation is easy to get wrong (this text shipped once with every line indented by
    // nine spaces), and a contract an agent READS should not be the place that happens.
    let mut out: Vec<String> = [
        "How to emit a coordination event.",
        "",
        "The FILENAME is the verb. The CONTENTS are the message.",
        "",
        "  echo \"Which branch should I target?\" > /coord/out/ask",
        "  echo \"stream-3 landed on develop\"    > /coord/out/landed.42",
        "",
        "Use <verb>.<suffix> to emit several of the same verb before a drain.",
        "",
        "ACCEPTED VERBS",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    out.push(format!("  {}", VERBS.join(" ")));
    out.extend(
        [
            "",
            "Whitespace in a message is collapsed to single spaces - the log is tab-separated, so",
            "an embedded tab or newline would corrupt the record. An unknown VERB is refused.",
            "",
            "A refused entry comes back as <name>.rejected, whose text names the fix. That feedback",
            "is ASYNCHRONOUS: it appears after the next drain, not when you write.",
            "",
            "/coord/out is the only writable path here. Everything else under /coord is a read-only",
            "snapshot and writing to it will fail.",
            "",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    out.join("
")
}

#[cfg(test)]
mod tests {
    use super::*;

    const RAW: &str = "2026-08-17T22:29:48Z\tdesign-studio:designer-react\tfork\tMerge cards\tgeneral-purpose\n\
                       2026-08-20T14:42:24Z\tstudio-code:director\task\tWhich branch?\tdirector\n\
                       2026-08-20T15:05:38Z\tdesign-studio:designer-react\tfork\tPull details\tfork\n\
                       broken-line-without-tabs\n";

    fn parsed() -> (Vec<Event>, Vec<String>) {
        parse(RAW)
    }

    #[test]
    fn parses_the_tsv_wire_format() {
        let (e, bad) = parsed();
        assert_eq!(e.len(), 3);
        assert_eq!(e[1].pane, "studio-code:director");
        assert_eq!(e[1].verb, "ask");
        assert_eq!(e[1].message, "Which branch?");
        assert_eq!(bad, vec!["broken-line-without-tabs".to_string()]);
    }

    #[test]
    fn malformed_lines_are_kept_not_dropped() {
        // Silently discarding them would make the projection lie about what the log contains.
        let (e, bad) = parsed();
        let t = project(&e, &bad, "T");
        assert_eq!(t["malformed"], "broken-line-without-tabs\n");
    }

    #[test]
    fn malformed_is_present_even_when_empty() {
        let (e, bad) = parse("2026-01-01T00:00:00Z\tp\tv\tm\ta\n");
        let t = project(&e, &bad, "T");
        assert_eq!(t["malformed"], "");
    }

    #[test]
    fn log_holds_every_event_chronologically() {
        let (e, bad) = parsed();
        let t = project(&e, &bad, "T");
        assert_eq!(t["log"].lines().count(), 3);
        assert!(t["log"].lines().next().unwrap().starts_with("2026-08-17"));
    }

    #[test]
    fn indexes_group_by_pane_and_verb_with_slugged_names() {
        let (e, bad) = parsed();
        let t = project(&e, &bad, "T");
        // ':' cannot be one path segment, so the index name is slugged.
        assert_eq!(t["by-pane/design-studio-designer-react"].lines().count(), 2);
        assert_eq!(t["by-pane/studio-code-director"].lines().count(), 1);
        assert_eq!(t["by-verb/fork"].lines().count(), 2);
        assert_eq!(t["by-verb/ask"].lines().count(), 1);
    }

    #[test]
    fn latest_is_a_bounded_tail_in_chronological_order() {
        let many: String = (0..120)
            .map(|i| format!("2026-01-01T00:00:{:02}Z\tp\tv\tm{i}\ta\n", i % 60))
            .collect();
        let (e, bad) = parse(&many);
        let t = project(&e, &bad, "T");
        assert_eq!(t["latest"].lines().count(), LATEST);
        // Still oldest-first within the tail, so it reads like the log rather than backwards.
        let first = t["latest"].lines().next().unwrap();
        assert!(first.contains(&format!("m{}", 120 - LATEST)));
    }

    #[test]
    fn paths_use_forward_slashes_on_every_host() {
        let (e, bad) = parsed();
        let t = project(&e, &bad, "T");
        assert!(t.keys().all(|k| !k.contains('\\')));
    }

    #[test]
    fn output_is_deterministic() {
        let (e, bad) = parsed();
        assert_eq!(project(&e, &bad, "T"), project(&e, &bad, "T"));
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;

    #[test]
    fn filename_is_the_verb_and_contents_are_the_message() {
        let e = accept("ask", "Which branch?\n", "p1", "T", "worker").unwrap();
        assert_eq!(e.verb, "ask");
        assert_eq!(e.message, "Which branch?");
        assert_eq!(e.pane, "p1");
        assert_eq!(e.actor, "worker");
    }

    #[test]
    fn a_suffix_lets_several_of_one_verb_queue() {
        // `landed.42` and `landed` must both be `landed`, or an agent cannot emit twice.
        assert_eq!(accept("landed.42", "done", "p", "T", "a").unwrap().verb, "landed");
        assert_eq!(accept("landed", "done", "p", "T", "a").unwrap().verb, "landed");
    }

    #[test]
    fn an_unknown_verb_is_refused_and_the_rejection_names_the_fix() {
        // A rejection an agent cannot act on is a silent drop, only slower.
        let r = accept("nonsense", "hi", "p", "T", "a").unwrap_err();
        assert_eq!(r, Rejection::UnknownVerb("nonsense".into()));
        let fix = r.fix();
        assert!(fix.contains("not an accepted verb"));
        assert!(fix.contains("fix:"));
        assert!(fix.contains("ask"), "the fix must list the accepted verbs");
        assert!(fix.contains("/coord/out/ask"), "the fix must show the form");
    }

    #[test]
    fn an_empty_message_is_refused_with_the_form_spelled_out() {
        for body in ["", "   ", "\n\n"] {
            let r = accept("ask", body, "p", "T", "a").unwrap_err();
            assert_eq!(r, Rejection::EmptyMessage("ask".into()));
            assert!(r.fix().contains("FILENAME is the verb"));
        }
    }

    #[test]
    fn whitespace_is_normalized_because_the_log_is_tsv() {
        // An embedded tab or newline would corrupt a TSV record. Blocking an agent over
        // whitespace it cannot see would be hostile, so this normalizes and says so in the schema.
        let e = accept("ask", "line one\nline\ttwo   spaced\n", "p", "T", "a").unwrap();
        assert_eq!(e.message, "line one line two spaced");
        assert!(!e.message.contains('\t'));
        assert!(!e.message.contains('\n'));
    }

    #[test]
    fn drain_splits_accepted_from_rejected() {
        let entries = vec![
            ("ask".to_string(), "q?".to_string()),
            ("bogus".to_string(), "x".to_string()),
            ("landed.1".to_string(), "ok".to_string()),
        ];
        let (ok, bad) = drain(&entries, "p", "T", "a");
        assert_eq!(ok.len(), 2);
        assert_eq!(ok[0].verb, "ask");
        assert_eq!(ok[1].verb, "landed");
        assert_eq!(bad.len(), 1);
        assert_eq!(bad[0].0, "bogus.rejected");
        assert!(bad[0].1.contains("not an accepted verb"));
    }

    #[test]
    fn drain_ignores_its_own_feedback_files() {
        // Otherwise every drain would reject its own rejections, forever.
        let entries = vec![("bogus.rejected".to_string(), "rejected: ...".to_string())];
        let (ok, bad) = drain(&entries, "p", "T", "a");
        assert!(ok.is_empty());
        assert!(bad.is_empty());
    }

    #[test]
    fn every_documented_verb_is_accepted() {
        // The observed vocabulary unioned with the emitters CLAUDE.md documents. merged/closed/
        // failed had never fired in the real log; deriving VERBS from data alone would have
        // refused them the first time one was used.
        for v in ["ask", "answer", "landed", "merged", "closed", "failed", "brief", "assign"] {
            assert!(accept(v, "m", "p", "T", "a").is_ok(), "{v} must be accepted");
        }
    }

    #[test]
    fn schema_is_projected_so_an_agent_can_be_right_first_time() {
        let (e, bad) = parse("");
        let t = project(&e, &bad, "T");
        let s = &t["schema"];
        assert!(s.contains("FILENAME is the verb"));
        assert!(s.contains("ACCEPTED VERBS"));
        assert!(s.contains("ASYNCHRONOUS"));
        assert!(s.contains("/coord/out is the only writable path"));
        for v in VERBS {
            assert!(s.contains(v), "schema must list {v}");
        }
    }

    #[test]
    fn a_drained_event_round_trips_back_through_the_parser() {
        // The write surface must produce something the read surface can parse, or the log grows
        // entries that /coord itself would bucket as malformed.
        let (ok, _) = drain(&[("ask".into(), "q?".into())], "pane:1", "2026-01-01T00:00:00Z", "worker");
        let line = format!("{}\t{}\t{}\t{}\t{}", ok[0].ts, ok[0].pane, ok[0].verb, ok[0].message, ok[0].actor);
        let (back, bad) = parse(&line);
        assert!(bad.is_empty(), "a drained event must never parse as malformed");
        assert_eq!(back[0], ok[0]);
    }
}
