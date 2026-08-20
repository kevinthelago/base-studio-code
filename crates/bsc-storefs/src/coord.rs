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
