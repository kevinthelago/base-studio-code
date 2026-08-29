//! `bsc plan change` — the local PR surface. Its own submodule for the same reason `cli/issues.rs`
//! is: the dispatch in [`super::run`] stays a one-line arm per noun and the verb logic lives with the
//! thing it acts on.
//!
//! The verbs split by ACTOR, deliberately, and that split is the point of the table:
//!   `new`    — the author states what the change is (content).
//!   `note`   — anyone appends a work note, while the reasoning is live.
//!   `gate`   — the gate records what it actually observed.
//!   `status` — the reviewer records the verdict and the merge commit.
//!   `link`   — a publish reports the identity GitHub assigned.
//! Folding these together would let one write clobber another's evidence, which is the whole failure
//! `issues`' upsert CONFLICT branch already guards against.

use super::{open_store, Args};
use crate::{default_issue_links, is_valid_change_status, render_change_markdown, Change, CHANGE_STATUSES};
use bsc_sqlite_util::{print_json, read_stdin_json_one};

pub(crate) fn cmd_change(args: &Args) -> Result<(), String> {
    let sub = args.positional.get(1).map(String::as_str).unwrap_or("list");
    match sub {
        "new" => cmd_new(args),
        "note" => cmd_note(args),
        "gate" => cmd_gate(args),
        "perf" => cmd_perf(args),
        "status" => cmd_status(args),
        "link" => cmd_link(args),
        "get" => cmd_get(args),
        "list" => cmd_list(args),
        "render" => cmd_render(args),
        "remove" => cmd_remove(args),
        other => Err(super::unknown_sub(args, "change", other)),
    }
}

/// `change new <ref>` — create/update the record. Content comes from flags, or a whole `Change` object
/// on stdin when `--json` input is more convenient than a flag soup.
fn cmd_new(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change new <ref> [--title T] [--note BODY] [--closes REF,REF] [--base B]")?;
    let s = open_store(&args.db)?;
    let existing = s.change_get(r).map_err(|e| e.to_string())?;
    let issues: Vec<String> = match args.fields.as_deref() {
        // `--closes a,b` reuses the shared comma-list flag rather than inventing a parser. An explicit
        // empty string is how a change with NO issue says so (a conversational slice, a follow-through).
        Some(list) => list.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect(),
        // Otherwise: the issue of the same name, but ONLY if it really exists — see `default_issue_links`.
        None => {
            let prior = existing.as_ref().map(|c| c.issues.clone()).unwrap_or_default();
            let exists = s.get(r).map_err(|e| e.to_string())?.is_some();
            default_issue_links(r, exists, &prior)
        }
    };
    let c = Change {
        r#ref: r.clone(),
        title: args.note.clone().or_else(|| existing.as_ref().map(|c| c.title.clone())).unwrap_or_else(|| r.clone()),
        body: args.description.clone().or_else(|| existing.as_ref().map(|c| c.body.clone())).unwrap_or_default(),
        issues,
        base: args.from.clone().unwrap_or_else(|| existing.as_ref().map(|c| c.base.clone()).unwrap_or_else(|| "develop".into())),
        head_sha: args.command.clone().unwrap_or_default(),
        ..Default::default()
    };
    s.change_upsert(&c).map_err(|e| e.to_string())?;
    if !args.json {
        println!("{r}");
    }
    Ok(())
}

/// `change note <ref> <text>` — append a work note. `--from` names the author.
fn cmd_note(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change note <ref> <text> [--from AUTHOR]")?;
    let text = args.positional.get(3).ok_or("usage: bsc plan change note <ref> <text> [--from AUTHOR]")?;
    let s = open_store(&args.db)?;
    let n = s.change_add_note(r, args.from.as_deref().unwrap_or(""), text).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no change with ref '{r}'"));
    }
    if !args.json {
        println!("{r} + note");
    }
    Ok(())
}

/// `change gate <ref> <gate> <result>` — record what a gate observed.
fn cmd_gate(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change gate <ref> <gate> <result>")?;
    let gate = args.positional.get(3).ok_or("usage: bsc plan change gate <ref> <gate> <result>")?;
    let result = args.positional.get(4).ok_or("usage: bsc plan change gate <ref> <gate> <result>")?;
    let s = open_store(&args.db)?;
    let n = s.change_set_gate(r, gate, result).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no change with ref '{r}'"));
    }
    if !args.json {
        println!("{r}: {gate} {result}");
    }
    Ok(())
}

/// `change perf <ref> <metric> <before> <after>` — record what the change cost.
///
/// The evidence half of an optimization, and the same discipline `gate` applies to correctness: "it's
/// faster" is not reviewable, `build 92s -> 74s` is. Both halves are required — an `after` with no
/// `before` is a reading, not a measurement, and cannot show that anything changed.
fn cmd_perf(args: &Args) -> Result<(), String> {
    const USAGE: &str = "usage: bsc plan change perf <ref> <metric> <before> <after> [--from WHO]";
    let r = args.positional.get(2).ok_or(USAGE)?;
    let metric = args.positional.get(3).ok_or(USAGE)?;
    let before = args.positional.get(4).ok_or(USAGE)?;
    let after = args.positional.get(5).ok_or(USAGE)?;
    let s = open_store(&args.db)?;
    let n = s
        .change_add_measure(r, metric, before, after, args.from.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no change with ref '{r}'"));
    }
    if !args.json {
        println!("{r}: {metric} {before} → {after}");
    }
    Ok(())
}

/// `change status <ref> <status> [--command SHA] [--from REVIEWER]` — the verdict write.
fn cmd_status(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change status <ref> <status> [--command SHA] [--from REVIEWER]")?;
    let st = args.positional.get(3).ok_or("usage: bsc plan change status <ref> <status>")?;
    if !is_valid_change_status(st) {
        return Err(format!("unknown change status '{st}' (expected one of {CHANGE_STATUSES:?})"));
    }
    let s = open_store(&args.db)?;
    let n = s
        .change_set_status(r, st, args.command.as_deref().unwrap_or(""), args.from.as_deref().unwrap_or(""))
        .map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no change with ref '{r}'"));
    }
    if !args.json {
        println!("{r} → {st}");
    }
    Ok(())
}

/// `change link <ref>` — record the GitHub identity, `{ghNumber, ghNodeId}` on stdin. Mirrors
/// `bsc plan link` down to rejecting a non-positive number: PR numbers start at 1, so a 0 can only be
/// a placeholder, and storing one would make an unpublished change claim an identity and be skipped
/// by every future sync.
fn cmd_link(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change link <ref>  (JSON {ghNumber, ghNodeId} on stdin)")?;
    let v: serde_json::Value = read_stdin_json_one("link JSON")?;
    let num = v
        .get("ghNumber")
        .or_else(|| v.get("gh_number"))
        .and_then(|n| n.as_i64())
        .ok_or("link needs a positive integer `ghNumber`")?;
    if num <= 0 {
        return Err(format!("ghNumber must be a positive PR number (got {num})"));
    }
    let node = v.get("ghNodeId").or_else(|| v.get("gh_node_id")).and_then(|n| n.as_str());
    let s = open_store(&args.db)?;
    let n = s.change_set_github_identity(r, num, node).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err(format!("no change with ref '{r}'"));
    }
    if !args.json {
        println!("{r} → #{num}");
    }
    Ok(())
}

fn cmd_get(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change get <ref>")?;
    let s = open_store(&args.db)?;
    let c = s.change_get(r).map_err(|e| e.to_string())?.ok_or_else(|| format!("no change with ref '{r}'"))?;
    if args.json {
        print_json(&serde_json::to_value(&c).unwrap_or_default(), args.pretty);
    } else {
        print!("{}", render_change_markdown(&c));
    }
    Ok(())
}

fn cmd_list(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    let rows = s.change_list(args.status.as_deref().unwrap_or("")).map_err(|e| e.to_string())?;
    if args.json {
        print_json(&serde_json::to_value(&rows).unwrap_or_default(), args.pretty);
    } else if rows.is_empty() {
        println!("(no changes)");
    } else {
        for c in &rows {
            let gh = c.gh_number.map(|n| format!("  #{n}")).unwrap_or_default();
            let gates = if c.gates.is_empty() { String::new() } else { format!("  [{} gate(s)]", c.gates.len()) };
            println!("{:<40} [{}]  {}{}{}", c.r#ref, c.status, c.title, gates, gh);
        }
    }
    Ok(())
}

/// `change render <ref>` — the markdown that serves as both PR body and CHANGELOG entry. Whole list
/// when no ref is given, so a release can render everything since the last cut in one call.
fn cmd_render(args: &Args) -> Result<(), String> {
    let s = open_store(&args.db)?;
    match args.positional.get(2) {
        Some(r) => {
            let c = s.change_get(r).map_err(|e| e.to_string())?.ok_or_else(|| format!("no change with ref '{r}'"))?;
            print!("{}", render_change_markdown(&c));
        }
        None => {
            for c in s.change_list(args.status.as_deref().unwrap_or("")).map_err(|e| e.to_string())? {
                println!("{}", render_change_markdown(&c));
            }
        }
    }
    Ok(())
}

fn cmd_remove(args: &Args) -> Result<(), String> {
    let r = args.positional.get(2).ok_or("usage: bsc plan change remove <ref>")?;
    let s = open_store(&args.db)?;
    s.change_remove(r).map_err(|e| e.to_string())?;
    if !args.json {
        println!("removed {r}");
    }
    Ok(())
}
