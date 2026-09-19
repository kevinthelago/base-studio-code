//! `bsc jobs` — the verbs.

use crate::{parse_period, parse_source, Entry, EntryPatch, Jobs, Kind, Profile, ProfilePatch, Status};
use bsc_cli_util::{args, CmdDoc};
use serde::Serialize;
use std::path::PathBuf;

pub const TAGLINE: &str =
    "job applications: the experience bank every resume and cover letter is drawn from, and the contact profile";

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "bank",
        summary: "the experience bank: list · get · set · confirm · remove",
        usage: "\
bsc jobs bank list [--kind K] [--drafts|--usable] [--tag T] [--db PATH] [--json|--pretty]
bsc jobs bank get <id> [--db PATH] [--json|--pretty]
bsc jobs bank set <id> [--kind K] [--title T] [--org O] [--start YYYY[-MM]] [--end YYYY[-MM]|present]
                       [--body TEXT | --body-file F] [--tags a,b] [--parent ID] [--source SRC] [--confirm]
                       [--db PATH] [--json|--pretty]
bsc jobs bank confirm <id>[,<id>…] [--db PATH] [--json|--pretty]
bsc jobs bank remove <id> [--db PATH] [--json|--pretty]

Every true fact a resume or cover letter may draw on. Kinds: experience, project, result, skill, story,
education, certification. A result, story or skill may belong to an experience, project or education
through --parent.

EVERY ENTRY SAYS WHERE IT CAME FROM. --source is `manual` (the default: the user typed it), or what it was
read out of: resume:<path>, note:<image of a handwritten note>, memory:<bsc memory id>.

CONFIRMED MEANS THE USER SAW THIS TEXT. A new entry is a DRAFT, and only confirmed entries are usable in a
document (`list --usable` is what a drafting agent reads). Changing a confirmed entry's content returns it
to draft. --confirm, and `bank confirm`, are the USER's act: an agent importing a resume or transcribing a
note writes drafts and never passes them.

`set` is a MERGE: a flag you leave out keeps its value; an empty value (--org \"\") clears one.
`remove` refuses an entry others belong to, naming them.",
    },
    CmdDoc {
        name: "profile",
        summary: "the contact header every document carries: show · set",
        usage: "\
bsc jobs profile [show] [--db PATH] [--json|--pretty]
bsc jobs profile set [--name N] [--headline H] [--email E] [--phone P] [--location L] [--links url,url]
                     [--db PATH] [--json|--pretty]

A MERGE, like `bank set`. --links replaces the list, in the order the documents show it.",
    },
];

#[derive(Default)]
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    kind: Option<String>,
    title: Option<String>,
    org: Option<String>,
    start: Option<String>,
    end: Option<String>,
    body: Option<String>,
    body_file: Option<String>,
    tags: Option<String>,
    tag: Option<String>,
    parent: Option<String>,
    source: Option<String>,
    confirm: bool,
    drafts: bool,
    usable: bool,
    name: Option<String>,
    headline: Option<String>,
    email: Option<String>,
    phone: Option<String>,
    location: Option<String>,
    links: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, rest| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--confirm" => a.confirm = true,
            "--drafts" => a.drafts = true,
            "--usable" => a.usable = true,
            "--db" => a.db = Some(rest.value("--db needs a path to a jobs.db")?),
            "--kind" => a.kind = Some(rest.value("--kind needs one of experience, project, result, skill, story, education, certification")?),
            "--title" => a.title = Some(rest.value("--title needs a value")?),
            "--org" => a.org = Some(rest.value("--org needs a value (\"\" clears it)")?),
            "--start" => a.start = Some(rest.value("--start needs YYYY or YYYY-MM (\"\" clears it)")?),
            "--end" => a.end = Some(rest.value("--end needs YYYY, YYYY-MM or present (\"\" clears it)")?),
            "--body" => a.body = Some(rest.value("--body needs text (\"\" clears it)")?),
            "--body-file" => a.body_file = Some(rest.value("--body-file needs a file, or - for stdin")?),
            "--tags" => a.tags = Some(rest.value("--tags needs a comma-separated list (\"\" clears them)")?),
            "--tag" => a.tag = Some(rest.value("--tag needs a tag to filter by")?),
            "--parent" => a.parent = Some(rest.value("--parent needs an entry id (\"\" clears it)")?),
            "--source" => a.source = Some(rest.value("--source needs manual, resume:<path>, note:<image> or memory:<id>")?),
            "--name" => a.name = Some(rest.value("--name needs a value (\"\" clears it)")?),
            "--headline" => a.headline = Some(rest.value("--headline needs a value (\"\" clears it)")?),
            "--email" => a.email = Some(rest.value("--email needs a value (\"\" clears it)")?),
            "--phone" => a.phone = Some(rest.value("--phone needs a value (\"\" clears it)")?),
            "--location" => a.location = Some(rest.value("--location needs a value (\"\" clears it)")?),
            "--links" => a.links = Some(rest.value("--links needs a comma-separated list (\"\" clears them)")?),
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

fn db_path(a: &Args) -> Result<PathBuf, String> {
    match &a.db {
        Some(p) => Ok(PathBuf::from(p)),
        None => Jobs::default_path().ok_or_else(|| "no home directory — pass --db PATH".to_string()),
    }
}

/// Open for READING: a missing store is an empty bank, never created by a read.
fn open_read(a: &Args) -> Result<Option<Jobs>, String> {
    let p = db_path(a)?;
    if !p.exists() {
        return Ok(None);
    }
    Jobs::open(&p).map(Some)
}

fn open_write(a: &Args) -> Result<Jobs, String> {
    Jobs::open(&db_path(a)?)
}

pub fn run(argv: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(argv)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("bank") => cmd_bank(&a),
        Some("profile") => cmd_profile(&a),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}

fn cmd_bank(a: &Args) -> Result<(), String> {
    match a.positional.get(1).map(String::as_str) {
        None | Some("list") => bank_list(a),
        Some("get") => bank_get(a),
        Some("set") => bank_set(a),
        Some("confirm") => bank_confirm(a),
        Some("remove") => bank_remove(a),
        Some(other) => Err(format!("`bank {other}` is not a verb — list, get, set, confirm or remove")),
    }
}

/// What `bank list` prints: the entries asked for, and how many drafts are waiting on the user either way.
#[derive(Serialize, Default)]
pub struct BankListing {
    pub entries: Vec<Entry>,
    pub drafts_waiting: usize,
}

fn bank_list(a: &Args) -> Result<(), String> {
    if a.drafts && a.usable {
        return Err("--drafts and --usable are opposites — pass one".into());
    }
    let kind = a.kind.as_deref().map(Kind::parse).transpose()?;
    let all = match open_read(a)? {
        Some(jobs) => jobs.entries()?,
        None => Vec::new(),
    };
    let drafts_waiting = all.iter().filter(|e| !e.usable()).count();
    let entries = all
        .into_iter()
        .filter(|e| kind.is_none_or(|k| e.kind == k))
        .filter(|e| !a.drafts || e.status == Status::Draft)
        .filter(|e| !a.usable || e.usable())
        .filter(|e| a.tag.as_ref().is_none_or(|t| e.tags.iter().any(|x| x == t)))
        .collect();
    let l = BankListing { entries, drafts_waiting };
    bsc_cli_util::emit(a.pretty, a.json, &l, || render_listing(&l));
    Ok(())
}

pub fn render_listing(l: &BankListing) -> String {
    let mut s = format!("{} entr{}", l.entries.len(), if l.entries.len() == 1 { "y" } else { "ies" });
    if l.drafts_waiting > 0 {
        s.push_str(&format!(" · {} draft(s) waiting for you to read and confirm", l.drafts_waiting));
    }
    s.push('\n');
    let mut kind = None;
    for e in &l.entries {
        if kind != Some(e.kind) {
            kind = Some(e.kind);
            s.push_str(&format!("\n  {}\n", e.kind.as_str().to_uppercase()));
        }
        let mark = if e.usable() { " " } else { "?" };
        s.push_str(&format!("  {mark} {:<28} {}{}{}\n", e.id, e.title, org_part(e), period_part(e)));
    }
    if l.entries.is_empty() {
        s.push_str("\n  the bank is empty — `bsc jobs bank set <id> --kind experience --title …`\n");
    } else if l.drafts_waiting > 0 {
        s.push_str("\n  ? = draft: not used in any document until confirmed\n");
    }
    s
}

fn org_part(e: &Entry) -> String {
    e.org.as_ref().map(|o| format!(" · {o}")).unwrap_or_default()
}

fn period_part(e: &Entry) -> String {
    match (&e.start, &e.end) {
        (Some(s), Some(t)) => format!(" · {s} – {t}"),
        (Some(s), None) => format!(" · {s}"),
        (None, Some(t)) => format!(" · until {t}"),
        (None, None) => String::new(),
    }
}

pub fn render_entry(e: &Entry, children: &[String]) -> String {
    let mut s = format!("{}  [{} · {}]\n", e.id, e.kind.as_str(), e.status.as_str());
    s.push_str(&format!("  {}{}{}\n", e.title, org_part(e), period_part(e)));
    if let Some(b) = &e.body {
        for line in b.lines() {
            s.push_str(&format!("    {line}\n"));
        }
    }
    if !e.tags.is_empty() {
        s.push_str(&format!("  tags    {}\n", e.tags.join(", ")));
    }
    if let Some(p) = &e.parent {
        s.push_str(&format!("  part of {p}\n"));
    }
    if !children.is_empty() {
        s.push_str(&format!("  holds   {}\n", children.join(", ")));
    }
    s.push_str(&format!("  source  {}\n", e.source));
    if !e.usable() {
        s.push_str("  DRAFT — not used in any document until you confirm it: `bsc jobs bank confirm <id>`\n");
    }
    s
}

fn bank_get(a: &Args) -> Result<(), String> {
    let id = a.positional.get(2).ok_or("bank get needs an entry id")?;
    let jobs = open_read(a)?.ok_or_else(|| format!("the bank is empty — no entry `{id}`"))?;
    let e = jobs.entry(id)?.ok_or_else(|| format!("no entry `{id}`"))?;
    let children = jobs.children(id)?;
    bsc_cli_util::emit(a.pretty, a.json, &e, || render_entry(&e, &children));
    Ok(())
}

fn opt(v: &Option<String>) -> Option<Option<String>> {
    v.as_ref().map(|s| if s.trim().is_empty() { None } else { Some(s.trim().to_string()) })
}

fn list(v: &Option<String>) -> Option<Vec<String>> {
    v.as_ref().map(|s| s.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect())
}

fn period(v: &Option<String>, allow_present: bool) -> Result<Option<Option<String>>, String> {
    match opt(v) {
        Some(Some(p)) => parse_period(&p, allow_present).map(|p| Some(Some(p))),
        other => Ok(other),
    }
}

fn body(a: &Args) -> Result<Option<Option<String>>, String> {
    match (&a.body, &a.body_file) {
        (Some(_), Some(_)) => Err("pass --body or --body-file, not both".into()),
        (Some(_), None) => Ok(opt(&a.body)),
        (None, Some(f)) => {
            let text = if f == "-" {
                std::io::read_to_string(std::io::stdin()).map_err(|e| format!("read stdin: {e}"))?
            } else {
                std::fs::read_to_string(f).map_err(|e| format!("read {f}: {e}"))?
            };
            Ok(opt(&Some(text)))
        }
        (None, None) => Ok(None),
    }
}

fn bank_set(a: &Args) -> Result<(), String> {
    let id = a.positional.get(2).ok_or("bank set needs an entry id")?;
    let patch = EntryPatch {
        kind: a.kind.as_deref().map(Kind::parse).transpose()?,
        title: a.title.clone(),
        org: opt(&a.org),
        start: period(&a.start, false)?,
        end: period(&a.end, true)?,
        body: body(a)?,
        tags: list(&a.tags),
        parent: opt(&a.parent),
        source: a.source.as_deref().map(parse_source).transpose()?,
        confirm: a.confirm,
    };
    let jobs = open_write(a)?;
    let e = jobs.set_entry(id, &patch)?;
    let children = jobs.children(id)?;
    bsc_cli_util::emit(a.pretty, a.json, &e, || render_entry(&e, &children));
    Ok(())
}

fn bank_confirm(a: &Args) -> Result<(), String> {
    let ids: Vec<String> = a.positional[2..]
        .iter()
        .flat_map(|s| s.split(','))
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if ids.is_empty() {
        return Err("bank confirm needs at least one entry id".into());
    }
    let confirmed = open_write(a)?.confirm(&ids)?;
    bsc_cli_util::emit(a.pretty, a.json, &confirmed, || format!("confirmed {} entr{}\n", confirmed.len(), if confirmed.len() == 1 { "y" } else { "ies" }));
    Ok(())
}

fn bank_remove(a: &Args) -> Result<(), String> {
    let id = a.positional.get(2).ok_or("bank remove needs an entry id")?;
    let e = open_write(a)?.remove(id)?;
    bsc_cli_util::emit(a.pretty, a.json, &e, || format!("removed {}\n", e.id));
    Ok(())
}

fn cmd_profile(a: &Args) -> Result<(), String> {
    match a.positional.get(1).map(String::as_str) {
        None | Some("show") => {
            let p = match open_read(a)? {
                Some(jobs) => jobs.profile()?,
                None => Profile::default(),
            };
            bsc_cli_util::emit(a.pretty, a.json, &p, || render_profile(&p));
            Ok(())
        }
        Some("set") => {
            let patch = ProfilePatch {
                name: opt(&a.name),
                headline: opt(&a.headline),
                email: opt(&a.email),
                phone: opt(&a.phone),
                location: opt(&a.location),
                links: list(&a.links),
            };
            let p = open_write(a)?.set_profile(&patch)?;
            bsc_cli_util::emit(a.pretty, a.json, &p, || render_profile(&p));
            Ok(())
        }
        Some(other) => Err(format!("`profile {other}` is not a verb — show or set")),
    }
}

pub fn render_profile(p: &Profile) -> String {
    let mut s = String::new();
    for (k, v) in [("name", &p.name), ("headline", &p.headline), ("email", &p.email), ("phone", &p.phone), ("location", &p.location)] {
        s.push_str(&format!("  {k:<9} {}\n", v.as_deref().unwrap_or("-")));
    }
    s.push_str(&format!("  {:<9} {}\n", "links", if p.links.is_empty() { "-".into() } else { p.links.join(", ") }));
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(tag: &str) -> String {
        let dir = std::env::temp_dir().join(format!("bsc-jobs-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("jobs.db");
        let _ = std::fs::remove_file(&db);
        db.display().to_string()
    }

    fn argv(parts: &[&str], db: &str) -> Vec<String> {
        let mut v: Vec<String> = parts.iter().map(|s| s.to_string()).collect();
        v.extend(["--db".to_string(), db.to_string()]);
        v
    }

    fn role(jobs: &Jobs, id: &str) -> Entry {
        jobs.set_entry(id, &EntryPatch { kind: Some(Kind::Experience), title: Some("Engineer".into()), ..Default::default() }).unwrap()
    }

    #[test]
    fn a_new_entry_is_a_draft_and_not_usable() {
        let jobs = Jobs::open_in_memory().unwrap();
        let e = role(&jobs, "acme");
        assert_eq!(e.status, Status::Draft);
        assert!(!e.usable(), "an unconfirmed entry must never reach a document");
    }

    #[test]
    fn confirming_makes_an_entry_usable() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        let c = jobs.confirm(&["acme".into()]).unwrap();
        assert!(c[0].usable());
    }

    #[test]
    fn editing_confirmed_content_returns_it_to_draft() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        jobs.confirm(&["acme".into()]).unwrap();
        let e = jobs.set_entry("acme", &EntryPatch { title: Some("Senior Engineer".into()), ..Default::default() }).unwrap();
        assert_eq!(e.status, Status::Draft, "the user confirmed the OLD title, not this one");
    }

    #[test]
    fn a_write_that_changes_nothing_printable_keeps_the_confirmation() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        jobs.confirm(&["acme".into()]).unwrap();
        let src = parse_source("resume:/home/me/cv.pdf").unwrap();
        let e = jobs.set_entry("acme", &EntryPatch { source: Some(src), ..Default::default() }).unwrap();
        assert_eq!(e.status, Status::Confirmed, "provenance is not content");
    }

    #[test]
    fn set_with_confirm_confirms_the_new_words_in_one_step() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        let e = jobs.set_entry("acme", &EntryPatch { title: Some("Lead".into()), confirm: true, ..Default::default() }).unwrap();
        assert!(e.usable());
    }

    #[test]
    fn confirm_with_an_unknown_id_confirms_nothing() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        let err = jobs.confirm(&["acme".into(), "typo".into()]).unwrap_err();
        assert!(err.contains("typo"), "{err}");
        assert!(!jobs.entry("acme").unwrap().unwrap().usable(), "a refused batch must leave no half-confirmed list");
    }

    #[test]
    fn a_new_entry_needs_kind_and_title() {
        let jobs = Jobs::open_in_memory().unwrap();
        let err = jobs.set_entry("x", &EntryPatch { title: Some("t".into()), ..Default::default() }).unwrap_err();
        assert!(err.contains("--kind"), "{err}");
        let err = jobs.set_entry("x", &EntryPatch { kind: Some(Kind::Skill), ..Default::default() }).unwrap_err();
        assert!(err.contains("--title"), "{err}");
    }

    #[test]
    fn a_parent_must_exist_and_be_a_place_work_happened() {
        let jobs = Jobs::open_in_memory().unwrap();
        let orphan = EntryPatch { kind: Some(Kind::Result), title: Some("Cut p99 by 40%".into()), parent: Some(Some("nope".into())), ..Default::default() };
        assert!(jobs.set_entry("r1", &orphan).unwrap_err().contains("not in the bank"));
        jobs.set_entry("rust", &EntryPatch { kind: Some(Kind::Skill), title: Some("Rust".into()), ..Default::default() }).unwrap();
        let under_skill = EntryPatch { parent: Some(Some("rust".into())), ..orphan.clone() };
        assert!(jobs.set_entry("r1", &under_skill).unwrap_err().contains("is a skill"));
        role(&jobs, "acme");
        let ok = EntryPatch { parent: Some(Some("acme".into())), ..orphan };
        assert_eq!(jobs.set_entry("r1", &ok).unwrap().parent.as_deref(), Some("acme"));
    }

    #[test]
    fn removing_an_entry_others_belong_to_is_refused_by_name() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        let r = EntryPatch { kind: Some(Kind::Result), title: Some("Shipped".into()), parent: Some(Some("acme".into())), ..Default::default() };
        jobs.set_entry("r1", &r).unwrap();
        let err = jobs.remove("acme").unwrap_err();
        assert!(err.contains("r1"), "{err}");
        jobs.remove("r1").unwrap();
        jobs.remove("acme").unwrap();
    }

    #[test]
    fn a_source_other_than_manual_must_name_what_it_came_from() {
        assert!(parse_source("resume").unwrap_err().contains("no reference"));
        assert!(parse_source("fax:x").unwrap_err().contains("not a source"));
        assert_eq!(parse_source("memory:abc").unwrap().to_string(), "memory:abc");
        assert_eq!(parse_source("manual").unwrap(), crate::Source::manual());
    }

    #[test]
    fn periods_are_year_or_year_month_and_only_an_end_may_be_present() {
        assert_eq!(parse_period("2024-03", false).unwrap(), "2024-03");
        assert_eq!(parse_period("2024", false).unwrap(), "2024");
        assert_eq!(parse_period("Present", true).unwrap(), "present");
        assert!(parse_period("present", false).is_err());
        assert!(parse_period("2024-13", false).is_err());
        assert!(parse_period("24-01", false).is_err());
        assert!(parse_period("March 2024", false).is_err());
    }

    #[test]
    fn ids_are_slugs() {
        assert!(crate::valid_id("acme-2024"));
        assert!(!crate::valid_id("Acme"));
        assert!(!crate::valid_id("-acme"));
        assert!(!crate::valid_id(""));
    }

    #[test]
    fn the_profile_merges_and_clears() {
        let jobs = Jobs::open_in_memory().unwrap();
        jobs.set_profile(&ProfilePatch { name: Some(Some("K".into())), email: Some(Some("k@x".into())), ..Default::default() }).unwrap();
        let p = jobs.set_profile(&ProfilePatch { email: Some(None), links: Some(vec!["https://a".into()]), ..Default::default() }).unwrap();
        assert_eq!(p.name.as_deref(), Some("K"));
        assert_eq!(p.email, None);
        assert_eq!(jobs.profile().unwrap().links, vec!["https://a".to_string()]);
    }

    #[test]
    fn the_cli_round_trips_an_entry_through_a_real_store() {
        let db = tmp_db("roundtrip");
        run(argv(&["bank", "set", "acme", "--kind", "experience", "--title", "Engineer", "--org", "Acme", "--start", "2021-04", "--end", "present", "--tags", "rust, infra"], &db), "bsc jobs").unwrap();
        let jobs = Jobs::open(std::path::Path::new(&db)).unwrap();
        let e = jobs.entry("acme").unwrap().unwrap();
        assert_eq!((e.org.as_deref(), e.end.as_deref(), e.tags.len()), (Some("Acme"), Some("present"), 2));
        assert_eq!(e.status, Status::Draft);
        run(argv(&["bank", "confirm", "acme"], &db), "bsc jobs").unwrap();
        assert!(jobs.entry("acme").unwrap().unwrap().usable());
        run(argv(&["bank", "set", "acme", "--org", ""], &db), "bsc jobs").unwrap();
        let e = jobs.entry("acme").unwrap().unwrap();
        assert_eq!(e.org, None, "an empty value clears the field");
        assert_eq!(e.status, Status::Draft);
    }

    #[test]
    fn the_cli_refuses_a_malformed_period_before_writing() {
        let db = tmp_db("period");
        let err = run(argv(&["bank", "set", "x", "--kind", "project", "--title", "T", "--start", "spring"], &db), "bsc jobs").unwrap_err();
        assert!(err.contains("not a period"), "{err}");
        assert!(Jobs::open(std::path::Path::new(&db)).unwrap().entry("x").unwrap().is_none());
    }

    #[test]
    fn a_read_does_not_create_the_store() {
        let db = tmp_db("read");
        run(argv(&["bank", "list"], &db), "bsc jobs").unwrap();
        run(argv(&["profile"], &db), "bsc jobs").unwrap();
        assert!(!std::path::Path::new(&db).exists());
    }

    #[test]
    fn the_listing_marks_drafts() {
        let jobs = Jobs::open_in_memory().unwrap();
        role(&jobs, "acme");
        let l = BankListing { drafts_waiting: 1, entries: jobs.entries().unwrap() };
        let out = render_listing(&l);
        assert!(out.contains("? acme"), "{out}");
        assert!(out.contains("waiting for you"), "{out}");
    }
}
