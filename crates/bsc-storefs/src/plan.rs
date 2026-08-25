//! The plan store, projected as a read-only file tree at `/plan`.
//!
//! Layout:
//! ```text
//! items/<ref>/{status,title,body,acceptance,labels,dependsOn}
//! by-status/<status>/<ref>   contains the title — `ls` it to see what is in that state
//! README                     states the staleness where a reader meets it
//! ```
//!
//! Consumes the JSON `bsc plan list --FULL --json` emits. Plain `--json` is the LEAN summary
//! shape, where `acceptance` is a COUNT rather than an array and `body` is absent entirely — it
//! does not deserialize into [`PlanItem`] and fails at parse time.


use crate::{id_is_safe, lines, Tree};
use serde::Deserialize;
use std::collections::BTreeMap;

/// One plan item, in the shape `bsc plan get --json` emits.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct PlanItem {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default, rename = "dependsOn")]
    pub depends_on: Vec<String>,
}



/// Render the tree. `generated_at` is passed in rather than read from the clock so the projection
/// stays pure and its tests are deterministic.
pub fn project(items: &[PlanItem], generated_at: &str) -> Tree {
    let mut t = Tree::new();
    let mut by_status: BTreeMap<&str, Vec<&PlanItem>> = BTreeMap::new();

    for it in items.iter().filter(|i| id_is_safe(&i.reference)) {
        let base = format!("items/{}", it.reference);
        // Every field is always present, even when empty: a predictable shape means `cat` returns
        // nothing rather than failing, and an agent never has to test for a file's existence.
        t.insert(format!("{base}/status"), format!("{}\n", it.status));
        t.insert(format!("{base}/title"), format!("{}\n", it.title));
        t.insert(format!("{base}/body"), it.body.clone());
        t.insert(format!("{base}/acceptance"), lines(&it.acceptance));
        t.insert(format!("{base}/labels"), lines(&it.labels));
        t.insert(format!("{base}/dependsOn"), lines(&it.depends_on));
        by_status.entry(it.status.as_str()).or_default().push(it);
    }

    // `ls /plan/by-status/open` answers "what is available" without a query language.
    for (status, group) in &by_status {
        if status.is_empty() {
            continue;
        }
        for it in group {
            t.insert(
                format!("by-status/{}/{}", status, it.reference),
                format!("{}\n", it.title),
            );
        }
    }

    t.insert("README".into(), readme(items.len(), generated_at));
    // PREVENTION, the same way /ui and /coord do it: the write contract is readable, so a worker
    // can be right the first time rather than discovering the vocabulary by being refused.
    t.insert("schema".into(), write_schema());
    t
}

fn readme(count: usize, generated_at: &str) -> String {
    format!(
        "The plan store, as files.\n\
         \n\
         items/<ref>/status       open | in_progress | blocked | complete | verified | failed\n\
         items/<ref>/title\n\
         items/<ref>/body         markdown\n\
         items/<ref>/acceptance   one criterion per line\n\
         items/<ref>/labels       one per line\n\
         items/<ref>/dependsOn    one per line\n\
         by-status/<status>/<ref> contains the title — ls it to see what is in that state\n\
         \n\
         THIS IS A SNAPSHOT, NOT A LIVE VIEW.\n\
         {count} item(s), projected at {generated_at}. It does not change when the store does.\n\
         It is mounted read-only, so a write is refused by the mount rather than being lost.\n\
         \n\
         THERE IS NO `bsc` IN THIS SESSION. That is the point of the projection, not an oversight:\n\
         a read surface can exist here precisely because no writable database is bound into the\n\
         namespace. This snapshot is the whole of what you can read of the plan.\n\
         There is no plan WRITE path from inside the cage yet — no /plan/out to match /coord/out.\n\
         To raise something you cannot do from here, emit it on the coordination outbox\n\
         (bsc-ask); the host is what reaches the store.\n"
    )
}

// ── WRITES ──────────────────────────────────────────────────────────────────────────────────
//
// `/plan` is a read-only snapshot, so a worker cannot record into it. The write surface is a
// separate WRITABLE outbox at `/plan/out`, drained host-side through the bundled `bsc` CLI.
//
// This is what closes the worker hole. The protocol makes the change record the worker's PR —
// `bsc plan change new/note/gate`, then `bsc plan status <ref> complete` — and none of it can run
// in a cage: there is no `bsc`, and `/plan` is read-only by the MOUNT, so even a bound binary
// would fail. A caged worker could do its work and not record that it did, ending with a green
// gate, a commit on its branch, and an item still reading `in_progress`.
//
// ── A DIRECTORY, like /ui/out and unlike /coord/out ─────────────────────────────────────────
//
// `/coord/out` uses *filename = verb, contents = message*, which works because a coordination
// message is one short line. A change NOTE is not: it is the prose written while the reasoning
// was still live, and it is the whole reason the change table exists. Same for a description.
// Encoding either into a filename, or into a JSON blob that has to escape it, loses exactly the
// content that mattered — the trap CLAUDE.md names for source on a command line, in a new guise.
//
// So one directory per entry, one file per field, prose in its own file byte-for-byte:
//
//     mkdir -p /plan/out/note-1
//     echo note                     > /plan/out/note-1/verb
//     echo 4260-sandbox-by-default  > /plan/out/note-1/ref
//     cat                           > /plan/out/note-1/text     # the prose, verbatim
//
// ── The vocabulary is NARROWER than the CLI, on purpose ─────────────────────────────────────
//
// This is the security value of an outbox over a bound binary, and it is not a side effect: the
// outbox can accept a SUBSET of what `bsc plan` can do, where a bound CLI would hand over all of
// it. What a worker may append is here. What it may NOT do — and every one of these is a
// deliberate refusal, not an omission:
//
//   `status verified`      the REVIEWER's verdict. CLAUDE.md: "the actor that wrote the change
//                          does not get to declare it correct". An agent stamping its own work
//                          verified is precisely the failure the complete/verified split exists
//                          to prevent.
//   `change status merged` same actor problem, plus it claims a merge that may not have happened.
//   removing anything      `bsc plan remove` / `change remove` are not append operations, and an
//                          append-only surface cannot be used to erase evidence.
//
// So the cage does not merely stop an agent writing the store directly; it bounds WHICH writes an
// agent can ask for at all.

/// The verbs `/plan/out` accepts, each mapping to one `bsc plan …` invocation.
pub const WRITE_VERBS: &[&str] = &["change", "note", "gate", "status", "request"];

/// Item statuses a WORKER may set from inside the cage. `verified` is deliberately absent — see
/// the vocabulary note above.
pub const WRITABLE_STATUSES: &[&str] = &["open", "in_progress", "blocked", "complete", "failed"];

/// One accepted entry, already validated into the `bsc plan` call it becomes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanWrite {
    /// `bsc plan change new <ref> --note <title> --description <description>`
    Change { r#ref: String, title: String, description: String },
    /// `bsc plan change note <ref> <text> [--from <from>]`
    Note { r#ref: String, text: String, from: Option<String> },
    /// `bsc plan change gate <ref> <gate> <result>`
    Gate { r#ref: String, gate: String, result: String },
    /// `bsc plan status <ref> <status>`
    Status { r#ref: String, status: String },
    /// `bsc plan request new <text> [--command <command>] [--from <from>]`
    Request { text: String, command: Option<String>, from: Option<String> },
}

impl PlanWrite {
    /// The argv this entry becomes. Returned as an ARGV, never a shell string — there is no
    /// quoting layer to get wrong, so a note containing a backtick, a `$(…)` or a newline is
    /// passed through as data rather than becoming a command.
    pub fn argv(&self) -> Vec<String> {
        let s = |x: &str| x.to_string();
        match self {
            PlanWrite::Change { r#ref, title, description } => vec![
                s("plan"), s("change"), s("new"), r#ref.clone(),
                s("--note"), title.clone(), s("--description"), description.clone(),
            ],
            PlanWrite::Note { r#ref, text, from } => {
                let mut v = vec![s("plan"), s("change"), s("note"), r#ref.clone(), text.clone()];
                if let Some(f) = from {
                    v.extend([s("--from"), f.clone()]);
                }
                v
            }
            PlanWrite::Gate { r#ref, gate, result } => vec![
                s("plan"), s("change"), s("gate"), r#ref.clone(), gate.clone(), result.clone(),
            ],
            PlanWrite::Status { r#ref, status } => {
                vec![s("plan"), s("status"), r#ref.clone(), status.clone()]
            }
            PlanWrite::Request { text, command, from } => {
                let mut v = vec![s("plan"), s("request"), s("new"), text.clone()];
                if let Some(c) = command {
                    v.extend([s("--command"), c.clone()]);
                }
                if let Some(f) = from {
                    v.extend([s("--from"), f.clone()]);
                }
                v
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteRejection {
    UnsafeName(String),
    MissingVerb(String),
    UnknownVerb { entry: String, verb: String },
    MissingField { entry: String, verb: String, field: String },
    UnsafeRef { entry: String, r#ref: String },
    RefusedStatus { entry: String, status: String },
}

impl WriteRejection {
    /// The text written back beside the refused entry. It must NAME THE FIX — a rejection a
    /// worker cannot act on is a silent drop, only slower.
    pub fn fix(&self) -> String {
        match self {
            WriteRejection::UnsafeName(n) => format!(
                "rejected: {n:?} cannot be an entry name.\n\n\
                 fix: use only letters, digits, '-', '_' and '.', and do not start with '.'\n\
                 the name is yours to pick; it only has to be unique until the next drain:\n  \
                 mkdir -p /plan/out/note-1\n"
            ),
            WriteRejection::MissingVerb(entry) => format!(
                "rejected: {entry:?} has no verb.\n\n\
                 fix: every entry says what it is:\n  \
                 echo note > /plan/out/{entry}/verb\n\n\
                 accepted verbs: {}\n",
                WRITE_VERBS.join(" ")
            ),
            WriteRejection::UnknownVerb { entry, verb } => format!(
                "rejected: {verb:?} is not an accepted verb.\n\n\
                 fix: write one of these to /plan/out/{entry}/verb\n  {}\n\n\
                 read /plan/schema for the fields each one takes.\n",
                WRITE_VERBS.join(" ")
            ),
            WriteRejection::MissingField { entry, verb, field } => format!(
                "rejected: the {verb:?} entry {entry:?} has no {field:?}.\n\n\
                 fix: each field is its own file, so prose is never escaped:\n  \
                 cat > /plan/out/{entry}/{field}\n\n\
                 read /plan/schema for every field {verb:?} takes.\n"
            ),
            WriteRejection::UnsafeRef { entry, r#ref } => format!(
                "rejected: {ref:?} cannot be an item ref.\n\n\
                 fix: a ref is the item's own name — `ls /plan/items` to see them:\n  \
                 echo <ref> > /plan/out/{entry}/ref\n",
                r#ref = r#ref
            ),
            WriteRejection::RefusedStatus { entry, status } => format!(
                "rejected: a session may not set status {status:?} from here.\n\n\
                 you may set: {}\n\n\
                 `verified` is the REVIEWER's verdict, and the actor that wrote the change does not\n\
                 get to declare it correct. Mark it `complete` and say so:\n  \
                 echo complete > /plan/out/{entry}/status\n\
                 then raise it with a request or a coordination event.\n",
                WRITABLE_STATUSES.join(" ")
            ),
        }
    }
}

fn field(fields: &[(String, String)], k: &str) -> Option<String> {
    fields.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone())
}

/// A field that is PROSE: kept byte-for-byte except for the trailing newline `echo`/`cat` leaves.
/// A note's own leading whitespace and blank lines are the author's and survive.
fn prose(fields: &[(String, String)], k: &str) -> Option<String> {
    field(fields, k)
        .map(|v| v.strip_suffix('\n').map(str::to_string).unwrap_or(v))
        .filter(|v| !v.trim().is_empty())
}

/// A field that is a TOKEN: a ref, a verb, a status. Trimmed, since `echo` adds a newline.
fn token(fields: &[(String, String)], k: &str) -> Option<String> {
    field(fields, k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty())
}

/// Validate one outbox entry into the `bsc plan` call it becomes.
pub fn accept_write(entry: &str, fields: &[(String, String)]) -> Result<PlanWrite, WriteRejection> {
    if !id_is_safe(entry) {
        return Err(WriteRejection::UnsafeName(entry.to_string()));
    }
    let verb = token(fields, "verb")
        .ok_or_else(|| WriteRejection::MissingVerb(entry.to_string()))?;
    if !WRITE_VERBS.contains(&verb.as_str()) {
        return Err(WriteRejection::UnknownVerb { entry: entry.into(), verb });
    }
    let missing = |f: &str| WriteRejection::MissingField {
        entry: entry.to_string(),
        verb: verb.clone(),
        field: f.to_string(),
    };
    // Every verb but `request` names an item; a request is the lane for something with no item yet.
    let item_ref = |field_name: &str| -> Result<String, WriteRejection> {
        let r = token(fields, "ref").ok_or_else(|| WriteRejection::MissingField {
            entry: entry.to_string(),
            verb: field_name.to_string(),
            field: "ref".to_string(),
        })?;
        if !id_is_safe(&r) {
            return Err(WriteRejection::UnsafeRef { entry: entry.into(), r#ref: r });
        }
        Ok(r)
    };

    Ok(match verb.as_str() {
        "change" => PlanWrite::Change {
            r#ref: item_ref("change")?,
            title: prose(fields, "title").ok_or_else(|| missing("title"))?,
            description: prose(fields, "description").ok_or_else(|| missing("description"))?,
        },
        "note" => PlanWrite::Note {
            r#ref: item_ref("note")?,
            text: prose(fields, "text").ok_or_else(|| missing("text"))?,
            from: token(fields, "from"),
        },
        "gate" => PlanWrite::Gate {
            r#ref: item_ref("gate")?,
            gate: token(fields, "gate").ok_or_else(|| missing("gate"))?,
            result: token(fields, "result").ok_or_else(|| missing("result"))?,
        },
        "status" => {
            let r = item_ref("status")?;
            let status = token(fields, "status").ok_or_else(|| missing("status"))?;
            if !WRITABLE_STATUSES.contains(&status.as_str()) {
                return Err(WriteRejection::RefusedStatus { entry: entry.into(), status });
            }
            PlanWrite::Status { r#ref: r, status }
        }
        "request" => PlanWrite::Request {
            text: prose(fields, "text").ok_or_else(|| missing("text"))?,
            command: prose(fields, "command"),
            from: token(fields, "from"),
        },
        _ => unreachable!("verb was checked against WRITE_VERBS above"),
    })
}

/// One outbox entry as it sits on disk: the directory name the worker chose, and its
/// `(field-file, contents)` pairs.
pub type OutboxEntry = (String, Vec<(String, String)>);

/// An accepted write, still carrying the entry name it came from — see [`drain_writes`] for why
/// the name has to travel with it.
pub type AcceptedWrite = (String, PlanWrite);

/// A `(<name>.rejected, fix-text)` pair to write back beside the entry that earned it.
pub type Feedback = (String, String);

/// Drain an outbox: accepted writes each PAIRED WITH THE ENTRY THEY CAME FROM, and
/// `(name.rejected, fix-text)` pairs to write back.
///
/// The name travels with the write because the STORE can refuse what this layer accepted — a ref
/// that does not exist, an illegal transition — and that answer has to land beside the entry the
/// worker wrote, or it is a silent drop. `/ui/out` needs no such pairing: a component's id is part
/// of its write, where an entry name here is just a handle the worker picked.
pub fn drain_writes(entries: &[OutboxEntry]) -> (Vec<AcceptedWrite>, Vec<Feedback>) {
    let mut ok = Vec::new();
    let mut rejected = Vec::new();
    for (entry, fields) in entries {
        if entry.ends_with(".rejected") {
            continue; // our own feedback, not a new entry
        }
        match accept_write(entry, fields) {
            Ok(w) => ok.push((entry.clone(), w)),
            Err(r) => rejected.push((format!("{entry}.rejected"), r.fix())),
        }
    }
    (ok, rejected)
}

/// The readable contract, projected at `/plan/schema`. Prevention, so a worker can be right the
/// first time rather than learning the vocabulary by being refused.
pub fn write_schema() -> String {
    format!(
        "How to record what you did.\n\
         \n\
         /plan is a read-only snapshot; this is the write path. One DIRECTORY per entry under\n\
         /plan/out, one file per field. Prose goes in its own file so it is never escaped - a\n\
         backtick or a $(...) in a note survives byte-for-byte, and so do newlines.\n\
         \n\
         The entry name is yours to pick and only has to be unique until the next drain.\n\
         \n\
         open a change record (do this at the START, not the end):\n  \
         mkdir -p /plan/out/c1\n  \
         echo change      > /plan/out/c1/verb\n  \
         echo <ref>       > /plan/out/c1/ref\n  \
         echo \"<title>\" > /plan/out/c1/title\n  \
         cat              > /plan/out/c1/description\n\
         \n\
         append a note, while the reasoning is still live:\n  \
         mkdir -p /plan/out/n1\n  \
         echo note  > /plan/out/n1/verb\n  \
         echo <ref> > /plan/out/n1/ref\n  \
         cat        > /plan/out/n1/text\n  \
         echo <you> > /plan/out/n1/from        # optional\n\
         \n\
         record what a gate actually observed:\n  \
         mkdir -p /plan/out/g1\n  \
         echo gate      > /plan/out/g1/verb\n  \
         echo <ref>     > /plan/out/g1/ref\n  \
         echo typecheck > /plan/out/g1/gate\n  \
         echo pass      > /plan/out/g1/result   # a gate you skipped is recorded as skipped\n\
         \n\
         move the item:\n  \
         mkdir -p /plan/out/s1\n  \
         echo status   > /plan/out/s1/verb\n  \
         echo <ref>    > /plan/out/s1/ref\n  \
         echo complete > /plan/out/s1/status\n\
         \n\
         you may set: {statuses}\n\
         `verified` is NOT yours to set. The actor that wrote the change does not get to declare\n\
         it correct - that is the whole point of the complete/verified split.\n\
         \n\
         ask for something you cannot do from here (no item needed):\n  \
         mkdir -p /plan/out/r1\n  \
         echo request > /plan/out/r1/verb\n  \
         cat          > /plan/out/r1/text\n  \
         cat          > /plan/out/r1/command    # optional: the command that failed\n\
         \n\
         This is the lane for a component's source that /ui does not project, for a merge, for a\n\
         `verified`, and for anything else the cage cannot reach.\n\
         \n\
         verbs: {verbs}\n\
         A refused entry comes back as <name>.rejected, whose text names the fix.\n",
        statuses = WRITABLE_STATUSES.join(" "),
        verbs = WRITE_VERBS.join(" "),
    )
}

/// Parse the JSON array `bsc plan list --json` emits.
pub fn from_json(s: &str) -> Result<Vec<PlanItem>, serde_json::Error> {
    serde_json::from_str(s)
}


#[cfg(test)]
mod readme_tests {
    /// The README used to close with "For live reads or any write, use the bsc plan CLI" — in the
    /// only place this projection is ever mounted, there is no `bsc`. It is not bound on purpose:
    /// a writable store inside the namespace is the ambient authority the isolation exists to
    /// remove, which is the same reason the projection exists at all.
    #[test]
    fn the_readme_does_not_send_a_caged_reader_to_a_cli_it_lacks() {
        let readme = super::readme(3, "2026-01-01T00:00:00Z");
        assert!(
            readme.contains("NO `bsc` IN THIS SESSION"),
            "the reader must be told the CLI is absent: {readme}",
        );
        assert!(
            !readme.contains("use the bsc plan CLI"),
            "and must not be sent to it anyway: {readme}",
        );
        // The plan store has no /plan/out to match /coord/out, so the honest answer is the
        // coordination channel — not silence, and not a command that cannot run.
        assert!(readme.contains("bsc-ask"), "name the escalation that DOES work: {readme}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items() -> Vec<PlanItem> {
        vec![
            PlanItem {
                reference: "phase-1-linux-host".into(),
                title: "Delete the Windows tax".into(),
                status: "open".into(),
                body: "## Why\n\nBecause.\n".into(),
                acceptance: vec!["gate is green".into(), "no cfg(windows) remains".into()],
                labels: vec!["linux".into()],
                depends_on: vec!["phase-0".into()],
                },
            PlanItem {
                reference: "phase-0".into(),
                title: "Price the port".into(),
                status: "complete".into(),
                ..Default::default()
            },
        ]
    }

    #[test]
    fn every_field_is_a_file_even_when_empty() {
        // A predictable shape means an agent never tests for existence first.
        let t = project(&items(), "T");
        for f in ["status", "title", "body", "acceptance", "labels", "dependsOn"] {
            assert!(t.contains_key(&format!("items/phase-0/{f}")), "missing {f}");
        }
        assert_eq!(t["items/phase-0/acceptance"], "");
        assert_eq!(t["items/phase-0/labels"], "");
    }

    #[test]
    fn status_and_title_read_cleanly() {
        let t = project(&items(), "T");
        assert_eq!(t["items/phase-1-linux-host/status"], "open\n");
        assert_eq!(t["items/phase-1-linux-host/title"], "Delete the Windows tax\n");
    }

    #[test]
    fn acceptance_is_one_criterion_per_line() {
        let t = project(&items(), "T");
        assert_eq!(
            t["items/phase-1-linux-host/acceptance"],
            "gate is green\nno cfg(windows) remains\n"
        );
    }

    #[test]
    fn by_status_answers_what_is_available_without_a_query_language() {
        let t = project(&items(), "T");
        assert_eq!(
            t["by-status/open/phase-1-linux-host"],
            "Delete the Windows tax\n"
        );
        assert_eq!(t["by-status/complete/phase-0"], "Price the port\n");
        assert!(!t.contains_key("by-status/open/phase-0"));
    }

    #[test]
    fn paths_use_forward_slashes_on_every_host() {
        // These are GUEST paths in a Linux namespace. PathBuf would render with the host
        // separator, which is how Path::is_absolute() silently broke bsc-sandbox on Windows.
        let t = project(&items(), "T");
        assert!(t.keys().all(|k| !k.contains('\\')), "a key used a host separator");
        assert!(t.contains_key("items/phase-0/status"));
    }

    #[test]
    fn readme_states_the_staleness_where_a_reader_meets_it() {
        let t = project(&items(), "2026-08-20T00:00:00Z");
        let r = &t["README"];
        assert!(r.contains("SNAPSHOT, NOT A LIVE VIEW"));
        assert!(r.contains("2026-08-20T00:00:00Z"));
        assert!(r.contains("2 item(s)"));
    }

    #[test]
    fn a_ref_cannot_escape_its_directory() {
        let mut v = items();
        v.push(PlanItem { reference: "../../etc/passwd".into(), ..Default::default() });
        v.push(PlanItem { reference: ".hidden".into(), ..Default::default() });
        let t = project(&v, "T");
        assert!(t.keys().all(|k| !k.contains("..")), "a ref escaped its directory");
        assert!(t.keys().all(|k| !k.contains(".hidden")));
    }

    #[test]
    fn output_is_deterministic() {
        // A projection that reordered between runs would make any diff of it useless.
        assert_eq!(project(&items(), "T"), project(&items(), "T"));
    }

    #[test]
    fn parses_the_json_bsc_plan_emits() {
        let json = r#"[{"ref":"a","title":"A","status":"open","body":"b",
                        "acceptance":["x"],"labels":[],"dependsOn":[]}]"#;
        let v = from_json(json).unwrap();
        assert_eq!(v[0].reference, "a");
        assert_eq!(v[0].acceptance, vec!["x".to_string()]);
    }

    #[test]
    fn missing_optional_fields_are_tolerated() {
        // bsc omits empty arrays in some shapes; a projection must not fail on that.
        let v = from_json(r#"[{"ref":"a"}]"#).unwrap();
        assert_eq!(v[0].reference, "a");
        assert!(v[0].acceptance.is_empty());
    }
}

#[cfg(test)]
mod write_tests {
    use super::*;

    fn f(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn a_note_becomes_the_append_the_protocol_asks_for() {
        let w = accept_write("n1", &f(&[("verb", "note\n"), ("ref", "my-ref\n"), ("text", "what I learned\n"), ("from", "worker\n")]))
            .expect("accepted");
        assert_eq!(
            w.argv(),
            vec!["plan", "change", "note", "my-ref", "what I learned", "--from", "worker"],
        );
    }

    /// The reason prose gets its own FILE. A note is the reasoning captured while it was live, and
    /// a backtick, a `$(…)` or a newline in it is content — not something to escape away.
    #[test]
    fn prose_survives_byte_for_byte_including_shell_metacharacters() {
        let text = "tried `cargo build`\nthen $(which bsc) — neither works in the cage\n\n  indented tail";
        let w = accept_write("n2", &f(&[("verb", "note"), ("ref", "r"), ("text", &format!("{text}\n"))]))
            .expect("accepted");
        match &w {
            PlanWrite::Note { text: t, .. } => assert_eq!(t, text, "only the trailing newline is stripped"),
            other => panic!("expected a note, got {other:?}"),
        }
        // ...and it travels as ARGV, so there is no quoting layer for it to escape through.
        assert!(w.argv().contains(&text.to_string()));
    }

    #[test]
    fn a_gate_and_a_status_become_their_commands() {
        let g = accept_write("g1", &f(&[("verb", "gate"), ("ref", "r"), ("gate", "typecheck"), ("result", "pass")]))
            .expect("accepted");
        assert_eq!(g.argv(), vec!["plan", "change", "gate", "r", "typecheck", "pass"]);

        let s = accept_write("s1", &f(&[("verb", "status"), ("ref", "r"), ("status", "complete")]))
            .expect("accepted");
        assert_eq!(s.argv(), vec!["plan", "status", "r", "complete"]);
    }

    /// THE narrowing that justifies an outbox over a bound CLI. `verified` is the reviewer's
    /// verdict, and an agent stamping its own work is the failure the complete/verified split
    /// exists to prevent — so the vocabulary refuses it and the refusal names what to do instead.
    #[test]
    fn a_session_may_not_declare_its_own_work_verified() {
        let r = accept_write("s2", &f(&[("verb", "status"), ("ref", "r"), ("status", "verified")]))
            .expect_err("must be refused");
        assert_eq!(r, WriteRejection::RefusedStatus { entry: "s2".into(), status: "verified".into() });
        let fix = r.fix();
        assert!(fix.contains("complete"), "the refusal must name what IS allowed: {fix}");
        assert!(fix.contains("REVIEWER"), "...and why: {fix}");
        assert!(!WRITABLE_STATUSES.contains(&"verified"));
    }

    /// A request needs no item — it is the lane for something with no ref yet, and the fallback for
    /// everything the cage cannot reach.
    #[test]
    fn a_request_needs_no_ref_and_carries_the_command_that_failed() {
        let w = accept_write("r1", &f(&[("verb", "request"), ("text", "need the source of `card`"), ("command", "bsc ui get card")]))
            .expect("accepted");
        assert_eq!(
            w.argv(),
            vec!["plan", "request", "new", "need the source of `card`", "--command", "bsc ui get card"],
        );
    }

    #[test]
    fn an_unknown_verb_is_refused_and_the_rejection_names_the_vocabulary() {
        let r = accept_write("x", &f(&[("verb", "merge"), ("ref", "r")])).expect_err("refused");
        let fix = r.fix();
        for v in WRITE_VERBS {
            assert!(fix.contains(v), "the fix must list {v}: {fix}");
        }
        assert!(fix.contains("/plan/schema"), "and point at the contract: {fix}");
    }

    #[test]
    fn a_missing_field_names_the_file_to_write() {
        let r = accept_write("g2", &f(&[("verb", "gate"), ("ref", "r"), ("gate", "typecheck")]))
            .expect_err("refused");
        assert_eq!(r, WriteRejection::MissingField { entry: "g2".into(), verb: "gate".into(), field: "result".into() });
        assert!(r.fix().contains("/plan/out/g2/result"), "name the exact path: {}", r.fix());
    }

    /// A ref is interpolated into no shell, but it IS a store key, and traversal in an entry name
    /// would escape the outbox directory itself.
    #[test]
    fn traversal_is_refused_in_both_the_entry_name_and_the_ref() {
        assert!(matches!(
            accept_write("../../etc/passwd", &f(&[("verb", "note")])),
            Err(WriteRejection::UnsafeName(_)),
        ));
        assert!(matches!(
            accept_write("n", &f(&[("verb", "note"), ("ref", "../other-project"), ("text", "x")])),
            Err(WriteRejection::UnsafeRef { .. }),
        ));
    }

    #[test]
    fn drain_separates_accepted_from_refused_and_ignores_its_own_feedback() {
        let entries = vec![
            ("ok".to_string(), f(&[("verb", "note"), ("ref", "r"), ("text", "fine")])),
            ("bad".to_string(), f(&[("verb", "nonsense")])),
            ("ok.rejected".to_string(), f(&[("verb", "note")])),
        ];
        let (accepted, rejected) = drain_writes(&entries);
        assert_eq!(accepted.len(), 1);
        assert_eq!(accepted[0].0, "ok", "the entry name travels with the write, for store-side refusals");
        assert_eq!(rejected.len(), 1);
        assert_eq!(rejected[0].0, "bad.rejected");
    }

    /// The schema is PREVENTION, so it has to carry the whole vocabulary — a contract that omits a
    /// verb teaches the agent to discover it by being refused.
    #[test]
    fn the_schema_names_every_verb_and_the_status_it_refuses() {
        let s = write_schema();
        for v in WRITE_VERBS {
            assert!(s.contains(v), "the schema must document {v}: {s}");
        }
        assert!(s.contains("verified"), "and say plainly that verified is not the agent's to set");
        assert!(s.contains("/plan/out"), "and name the directory");
    }

    #[test]
    fn the_schema_is_projected_beside_the_snapshot() {
        let t = project(&[], "2026-01-01T00:00:00Z");
        assert_eq!(t["schema"], write_schema(), "readable at /plan/schema");
    }
}
