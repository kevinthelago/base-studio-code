//! `bsc hook superseded` (#4240) — tell a fleet worker that the issue it is editing for was already
//! finished by someone else.
//!
//! ## The gap this closes
//! Two actors can land the same issue: a director closes one directly, a worker picks up something
//! already in flight, two streams overlap. The second worker finds out at MERGE time, if at all — it
//! keeps writing, opens a PR, and a human discovers the conflict.
//!
//! Nothing told it, and that is the odd part: the fact was already written down. `coord.log` records
//! every completion (`bsc-landed` / `bsc-merged` / `bsc-closed`), each tagged with the pane that emitted
//! it, and the director's inbox reads that channel. But the channel is read by the APP and never
//! delivered back into a running session, so a worker cannot learn a fact the system already knows.
//!
//! ## What it derives, from what already exists
//! No schema change and no new emitter — the three inputs are all present at launch:
//!
//! ```text
//! $BSC_COORD_LOG   ts ⇥ pane ⇥ landed|merged|closed ⇥ <ref> ⇥ ""
//! $BSC_PLAN_DB     issues(ref, stream, status, …)   — scoped by $BSC_STREAM
//! $BSC_AUDIT_PANE  who I am
//! ```
//!
//! A ref in BOTH sets, completed by a pane that is not me ⇒ I am working on finished work.
//!
//! ## Why it blocks, and why exactly once
//! Exit 2 on the one tool call, naming the ref, the finisher and the time. Blocking is the right verb:
//! continuing to edit for a landed issue produces a conflicting PR, which costs far more than one
//! interrupted call. But it blocks ONCE PER REF (latched in a marker file, mirroring `defer/`'s
//! counter) and then never again for that ref — the worker is informed and proceeds under its own
//! judgement. A hook that blocked forever would trap a worker whose stream still holds real work,
//! which is the failure `stop-defer`'s "never trap a finished worker" rule exists to prevent.
//!
//! This is a NOTIFICATION, not a dependency-wait: #1039 removed runtime parking, and nothing here
//! parks. The worker is told a fact and keeps its own counsel.
//!
//! ## Fail-open throughout
//! No coord log, no plan store, no stream, an unreadable file, a malformed line — every uncertain path
//! ALLOWS the call. The asymmetry is the one `stop-defer` documents: wrongly allowing costs some
//! duplicated work a human already catches today, while wrongly blocking stops a working agent dead.

/// Statuses that mean an issue is DONE — the same set `defer` uses, deliberately: the two hooks must
/// not disagree about what "finished" means.
const DONE: &[&str] = &["complete", "verified"];

/// The `coord.log` kinds that report a completed issue. `failed` is NOT here — a failed issue is not
/// finished, and telling a worker its issue is done because someone else failed at it would be a lie.
const COMPLETION_KINDS: &[&str] = &["landed", "merged", "closed"];

/// One completion read off the coordination log.
#[derive(Debug, Clone, PartialEq)]
pub struct Completion {
    /// The issue ref the emitter reported finishing.
    pub r#ref: String,
    /// The pane that emitted it — the whole point: this is how "someone else" is decided.
    pub pane: String,
    /// The event timestamp, verbatim from the log.
    pub at: String,
    /// `landed` | `merged` | `closed`.
    pub kind: String,
}

/// Parse the completion events out of a `coord.log` body.
///
/// The log is TSV `ts ⇥ pane ⇥ kind ⇥ arg1 ⇥ arg2` and is APPEND-ONLY from many shells at once, so a
/// torn or malformed line is expected rather than exceptional — those are skipped, never fatal.
pub fn parse_completions(log: &str) -> Vec<Completion> {
    log.lines()
        .filter_map(|line| {
            let mut f = line.split('\t');
            let at = f.next()?;
            let pane = f.next()?;
            let kind = f.next()?;
            let r#ref = f.next()?.trim();
            if !COMPLETION_KINDS.contains(&kind) || r#ref.is_empty() {
                return None;
            }
            Some(Completion {
                r#ref: r#ref.to_string(),
                pane: pane.to_string(),
                at: at.to_string(),
                kind: kind.to_string(),
            })
        })
        .collect()
}

/// What the hook decides for this tool call.
#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// Nothing to say — let the call through.
    Allow,
    /// Block this one call and tell the worker; then latch `ref` so it is never blocked again.
    Announce(Completion),
}

/// Decide whether this worker should be told about a finished issue.
///
/// `mine` is the set of refs assigned to this worker's stream, `me` its pane, `announced` the refs it
/// has already been told about.
///
/// The three refusals, each load-bearing:
/// - a completion emitted by ME is not news (a worker that just ran `bsc-landed` knows);
/// - a ref outside MY stream is someone else's business entirely;
/// - a ref already announced must never fire twice, or the worker is trapped.
pub fn decide(
    completions: &[Completion],
    mine: &std::collections::BTreeSet<String>,
    me: &str,
    announced: &std::collections::BTreeSet<String>,
) -> Verdict {
    for c in completions {
        if c.pane == me || !mine.contains(&c.r#ref) || announced.contains(&c.r#ref) {
            continue;
        }
        return Verdict::Announce(c.clone());
    }
    Verdict::Allow
}

/// The message the worker sees. States the observed fact and the decision it now owns — it does not
/// instruct, because the hook cannot know whether the worker's remaining work is related.
pub fn reason(c: &Completion) -> String {
    format!(
        "{} was already {} by {} at {}.\n\
         You are editing for an issue another session finished. Continuing produces a conflicting PR.\n\
         Check `bsc plan issue get {}` and the branch state before writing more; if your remaining work \
         belongs to a different issue, carry on — this fires once per issue and will not block you again.",
        c.r#ref, c.kind, c.pane, c.at, c.r#ref
    )
}

/// The refs this worker's stream owns. `None` when there is no plan store or no stream to scope to —
/// a non-fleet session, where this hook has no business blocking anything.
///
/// DONE issues are excluded: this asks "what am I supposed to be working on", and an issue already
/// marked finished in the plan store is not it. Without that filter the hook would announce a
/// completion the worker's own store already agrees with.
fn stream_refs(db: &str, stream: &str) -> Option<std::collections::BTreeSet<String>> {
    if db.is_empty() || stream.is_empty() {
        return None;
    }
    let store = plandb::Store::open(std::path::Path::new(db)).ok()?;
    let issues = store.list(None, Some(stream)).ok()?;
    Some(
        issues
            .iter()
            .filter(|i| !DONE.contains(&i.status.as_str()))
            .map(|i| i.r#ref.clone())
            .collect(),
    )
}

/// Where this pane's already-announced refs are latched. Sibling of `defer/`, same sanitising, for the
/// same reason: a pane id is not a safe filename.
fn latch_path(pane: &str) -> Option<std::path::PathBuf> {
    let safe: String = pane
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    Some(bsc_util::bsc_base_dir()?.join("superseded").join(format!("{safe}.txt")))
}

fn read_latch(pane: &str) -> std::collections::BTreeSet<String> {
    let Some(p) = latch_path(pane) else { return Default::default() };
    // An unreadable latch reads as EMPTY, which risks re-announcing — deliberately the safe direction:
    // the alternative (treating it as "everything announced") would silently disable the hook forever.
    std::fs::read_to_string(&p)
        .map(|raw| raw.lines().map(str::trim).filter(|l| !l.is_empty()).map(str::to_string).collect())
        .unwrap_or_default()
}

fn append_latch(pane: &str, r#ref: &str) {
    let Some(p) = latch_path(pane) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let mut set = read_latch(pane);
    set.insert(r#ref.to_string());
    let _ = std::fs::write(&p, set.into_iter().collect::<Vec<_>>().join("\n"));
}

/// `bsc hook superseded`: exit 2 to block ONE edit when this worker's issue was finished elsewhere.
pub fn superseded() -> Result<(), String> {
    // The tool JSON is drained but unused: the hook's answer does not depend on WHICH file is being
    // edited, only on whether this worker's issue is still live. Draining anyway keeps the hook a
    // well-behaved stdin consumer — a hook that leaves the pipe unread can make the caller block.
    let mut input = String::new();
    let _ = std::io::Read::read_to_string(&mut std::io::stdin(), &mut input);

    let me = std::env::var("BSC_AUDIT_PANE").unwrap_or_default();
    let db = std::env::var("BSC_PLAN_DB").unwrap_or_default();
    let stream = std::env::var("BSC_STREAM").unwrap_or_default();
    let log_path = std::env::var("BSC_COORD_LOG").unwrap_or_default();
    if me.is_empty() || log_path.is_empty() {
        return Ok(()); // cannot tell self from other, or nothing to read — allow
    }
    let Some(mine) = stream_refs(&db, &stream) else { return Ok(()) };
    if mine.is_empty() {
        return Ok(());
    }
    let Ok(log) = std::fs::read_to_string(&log_path) else { return Ok(()) };

    let announced = read_latch(&me);
    match decide(&parse_completions(&log), &mine, &me, &announced) {
        Verdict::Allow => Ok(()),
        Verdict::Announce(c) => {
            // Latch BEFORE blocking: if the process died between the two, the worker would be blocked
            // on the same ref every call — trapped by the hook meant to inform it.
            append_latch(&me, &c.r#ref);
            eprintln!("{}", reason(&c));
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    const LOG: &str = "2026-08-02T01:00:00Z\tproj:beta\tlanded\t#77\t\n\
                       2026-08-02T01:05:00Z\tproj:director\tmerged\t#88\t\n\
                       2026-08-02T01:06:00Z\tproj:beta\tfailed\t#99\tbroke\n";

    #[test]
    fn parses_only_the_completion_kinds() {
        let c = parse_completions(LOG);
        assert_eq!(c.len(), 2, "failed is not a completion");
        assert_eq!(c[0], Completion {
            r#ref: "#77".into(), pane: "proj:beta".into(),
            at: "2026-08-02T01:00:00Z".into(), kind: "landed".into(),
        });
        assert_eq!(c[1].kind, "merged");
    }

    /// A `failed` event means the issue is NOT finished. Announcing on it would tell a worker its work
    /// is done because someone else could not do it.
    #[test]
    fn a_failure_is_never_a_completion() {
        assert!(parse_completions("2026-08-02T01:00:00Z\tp\tfailed\t#1\tx\n").is_empty());
    }

    /// The log is appended from many shells at once, so torn lines are routine, not exceptional.
    #[test]
    fn malformed_lines_are_skipped_not_fatal() {
        let torn = format!("garbage\n\t\t\n2026-01-01T00:00:00Z\tp\tlanded\t\t\n{LOG}");
        assert_eq!(parse_completions(&torn).len(), 2, "the empty ref is skipped too");
    }

    #[test]
    fn announces_an_issue_another_pane_finished() {
        let v = decide(&parse_completions(LOG), &set(&["#77"]), "proj:alpha", &BTreeSet::new());
        assert!(matches!(v, Verdict::Announce(c) if c.r#ref == "#77" && c.pane == "proj:beta"));
    }

    /// The director closing an issue directly is the case that motivated this.
    #[test]
    fn a_director_completion_reaches_the_worker() {
        let v = decide(&parse_completions(LOG), &set(&["#88"]), "proj:alpha", &BTreeSet::new());
        assert!(matches!(v, Verdict::Announce(c) if c.pane == "proj:director"));
    }

    /// A worker that just ran `bsc-landed` does not need telling.
    #[test]
    fn my_own_completion_is_not_news() {
        assert_eq!(decide(&parse_completions(LOG), &set(&["#77"]), "proj:beta", &BTreeSet::new()), Verdict::Allow);
    }

    #[test]
    fn a_ref_outside_my_stream_is_not_my_business() {
        assert_eq!(decide(&parse_completions(LOG), &set(&["#12"]), "proj:alpha", &BTreeSet::new()), Verdict::Allow);
    }

    /// THE anti-trap guard. Without the latch the hook blocks every single edit forever, which strands
    /// a worker whose stream still holds real work — the failure `stop-defer` names explicitly.
    #[test]
    fn an_announced_ref_never_fires_again() {
        let c = parse_completions(LOG);
        let mine = set(&["#77", "#88"]);
        assert!(matches!(decide(&c, &mine, "proj:alpha", &BTreeSet::new()), Verdict::Announce(_)));
        // #77 announced — the NEXT call moves on to #88 rather than repeating itself…
        let v = decide(&c, &mine, "proj:alpha", &set(&["#77"]));
        assert!(matches!(v, Verdict::Announce(ref x) if x.r#ref == "#88"));
        // …and once both are announced, the worker is left alone.
        assert_eq!(decide(&c, &mine, "proj:alpha", &set(&["#77", "#88"])), Verdict::Allow);
    }

    #[test]
    fn the_reason_names_the_ref_the_finisher_and_the_time() {
        let r = reason(&parse_completions(LOG)[0]);
        assert!(r.contains("#77") && r.contains("proj:beta") && r.contains("2026-08-02T01:00:00Z"));
        assert!(r.contains("fires once"), "the worker must know it is not trapped");
    }

    #[test]
    fn an_empty_log_says_nothing() {
        assert_eq!(decide(&parse_completions(""), &set(&["#77"]), "proj:alpha", &BTreeSet::new()), Verdict::Allow);
    }
}
