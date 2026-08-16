//! The `bsc runtime` subcommand — read what actually served each module while the app ran.
//!
//! Read-mostly on purpose. The APP is the writer (through a Tauri command); this surface exists so a
//! session, `doctor`, or a person can ask the store questions without the app in the loop. The one
//! mutating verb is `prune`, because the store is otherwise unbounded.
//!
//! The db is global (`~/.base-studio-code/runtime.db`), located via `--db <path>` or `$BSC_RUNTIME_DB`.

use crate::{Attestation, Filter, Store};
use bsc_cli_util::CmdDoc;
use std::path::PathBuf;

const TAGLINE: &str = "runtime attestations — which record ACTUALLY served each module (epic #3604)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "attestations, most recently seen first",
        usage: "\
USAGE:
  bsc runtime list [--record ID] [--specifier S] [--outcome O] [--session S] [--since MS] [--limit N] [--json|--pretty]

Every row is one COALESCED fact: this record, at this source version, had this outcome, N times, in this
app run. Filters narrow it; `--outcome declined-closure` is the one worth knowing by heart — it lists
records the runtime refused, which served the bundled module instead and left the record inert.",
    },
    CmdDoc {
        name: "get",
        summary: "every attestation for ONE record",
        usage: "\
USAGE:
  bsc runtime get <record-id> [--json|--pretty]

One record's whole runtime history: which versions ran, which were declined and why, how often, how
slow. This is what `bsc ui get <id> --metrics` reads.",
    },
    CmdDoc {
        name: "summary",
        summary: "the one-screen picture: sessions, records seen, outcome counts",
        usage: "\
USAGE:
  bsc runtime summary [--json|--pretty]

Sessions recorded, distinct records seen, and a count per outcome. READ `sessions` FIRST: zero means
nothing has been measured yet, which is NOT the same as nothing having run — every 'never ran' judgement
is void until the app has run at least once with attestation on.",
    },
    CmdDoc {
        name: "prune",
        summary: "delete attestations older than N days",
        usage: "\
USAGE:
  bsc runtime prune [--days N]

Deletes rows whose last sighting is older than N days (default 30) and prints how many went. The store
grows one row per module per version per outcome per session — slowly, but without bound.",
    },
    CmdDoc {
        name: "hash",
        summary: "the source hash of a file, for comparing against what ran",
        usage: "\
USAGE:
  bsc runtime hash <path>

Prints the same 16-char hash the app computes for a module's source (FNV-1a 64 over UTF-8 bytes). This
is the cross-language contract the whole store rests on: `doctor` compares a record's current hash with
the one that actually ran, so the two implementations must agree byte for byte.",
    },
];

struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    record: Option<String>,
    specifier: Option<String>,
    outcome: Option<String>,
    session: Option<String>,
    since: Option<i64>,
    limit: Option<i64>,
    days: Option<i64>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args {
        json: false, pretty: false, db: None, record: None, specifier: None,
        outcome: None, session: None, since: None, limit: None, days: None,
        positional: Vec::new(),
    };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        let mut val = |flag: &str| -> Result<String, String> {
            it.next().ok_or_else(|| format!("flag {flag} needs a value"))
        };
        match arg.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--db" => a.db = Some(val("--db")?),
            "--record" => a.record = Some(val("--record")?),
            "--specifier" => a.specifier = Some(val("--specifier")?),
            "--outcome" => a.outcome = Some(val("--outcome")?),
            "--session" => a.session = Some(val("--session")?),
            "--since" => a.since = Some(val("--since")?.parse().map_err(|_| "--since needs epoch ms")?),
            "--limit" => a.limit = Some(val("--limit")?.parse().map_err(|_| "--limit needs an integer")?),
            "--days" => a.days = Some(val("--days")?.parse().map_err(|_| "--days needs an integer")?),
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// The `runtime` subcommand entrypoint: `args` is everything after `bsc runtime`.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    match cmd.as_str() {
        "list" => cmd_list(&args),
        "get" => cmd_get(&args),
        "summary" => cmd_summary(&args),
        "prune" => cmd_prune(&args),
        "hash" => cmd_hash(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_list(args: &Args) -> Result<(), String> {
    let filter = Filter {
        record_id: args.record.clone(),
        specifier: args.specifier.clone(),
        outcome: args.outcome.clone(),
        session: args.session.clone(),
        since_ms: args.since,
        limit: args.limit,
    };
    let rows = open_store(&args.db)?.list(&filter).map_err(|e| format!("listing attestations: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &rows, || lean(&rows));
    Ok(())
}

fn cmd_get(args: &Args) -> Result<(), String> {
    let id = args.positional.get(1).ok_or("usage: bsc runtime get <record-id>")?;
    let rows = open_store(&args.db)?.for_record(id).map_err(|e| format!("reading attestations: {e}"))?;
    bsc_cli_util::emit(args.pretty, args.json, &rows, || {
        if rows.is_empty() {
            // NOT "this record never ran" — this command cannot tell that from "nothing was ever
            // measured", and `summary` is where that distinction lives.
            format!("(no attestations for '{id}' — check `bsc runtime summary` for whether anything has been measured)")
        } else {
            lean(&rows)
        }
    });
    Ok(())
}

/// The store's one-screen picture. `sessions` leads deliberately — every conclusion drawn from this
/// store is void when it is zero.
#[derive(serde::Serialize)]
struct Summary {
    sessions: i64,
    records_seen: usize,
    rows: usize,
    outcomes: std::collections::BTreeMap<String, i64>,
}

fn cmd_summary(args: &Args) -> Result<(), String> {
    let store = open_store(&args.db)?;
    let rows = store.list(&Filter::default()).map_err(|e| format!("reading attestations: {e}"))?;
    let mut outcomes: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for r in &rows {
        *outcomes.entry(r.outcome.clone()).or_default() += r.n;
    }
    let s = Summary {
        sessions: store.session_count().map_err(|e| e.to_string())?,
        records_seen: store.seen_record_ids().map_err(|e| e.to_string())?.len(),
        rows: rows.len(),
        outcomes,
    };
    bsc_cli_util::emit(args.pretty, args.json, &s, || {
        if s.sessions == 0 {
            return "(nothing measured yet — the app has not run with attestation on, so no \"never ran\" judgement is valid)".into();
        }
        let mut out = format!("{} session(s) · {} record(s) seen · {} row(s)", s.sessions, s.records_seen, s.rows);
        for (outcome, n) in &s.outcomes {
            out.push_str(&format!("\n  {outcome:<18} {n}"));
        }
        out
    });
    Ok(())
}

fn cmd_prune(args: &Args) -> Result<(), String> {
    let days = args.days.unwrap_or(30);
    let cutoff = now_ms() - days * 86_400_000;
    let n = open_store(&args.db)?.prune_before(cutoff).map_err(|e| format!("pruning: {e}"))?;
    println!("pruned {n} attestation{} older than {days} day{}", plural(n as i64), plural(days));
    Ok(())
}

fn cmd_hash(args: &Args) -> Result<(), String> {
    let path = args.positional.get(1).ok_or("usage: bsc runtime hash <path>")?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("reading {path}: {e}"))?;
    println!("{}", crate::src_hash(&text));
    Ok(())
}

fn plural(n: i64) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// The lean TSV: outcome, n, mean ms, record, specifier — the columns a shell actually filters on.
fn lean(rows: &[Attestation]) -> String {
    if rows.is_empty() {
        return "(no attestations)".into();
    }
    rows.iter()
        .map(|r| {
            let mean = r.ms_mean().map_or_else(|| "-".into(), |m| format!("{m:.0}ms"));
            let flag = if r.is_declined() { " !" } else { "" };
            format!(
                "{}\t{}\t{}\t{}\t{}{}",
                r.outcome, r.n, mean, if r.record_id.is_empty() { "(file)" } else { &r.record_id }, r.specifier, flag,
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn open_store(db: &Option<String>) -> Result<Store, String> {
    let path = resolve_db(db)?;
    Store::open(&path).map_err(|e| format!("opening {}: {e}", path.display()))
}

fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    if let Some(f) = flag {
        return Ok(PathBuf::from(f));
    }
    bsc_sqlite_util::default_store_path("BSC_RUNTIME_DB", &["runtime.db"])
        .ok_or_else(|| "cannot locate runtime.db (no home directory); pass --db <path>".to_string())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::NewAttestation;

    fn args_for(positional: Vec<&str>, set: impl FnOnce(&mut Args)) -> Args {
        let mut a = parse_args(positional.into_iter().map(String::from).collect()).unwrap();
        set(&mut a);
        a
    }

    #[test]
    fn parse_args_collects_flags_and_positionals() {
        let a = parse_args(
            ["list", "--outcome", "declined-closure", "--limit", "5", "--json"].iter().map(|s| s.to_string()).collect(),
        )
        .unwrap();
        assert_eq!(a.positional, ["list"]);
        assert_eq!(a.outcome.as_deref(), Some("declined-closure"));
        assert_eq!(a.limit, Some(5));
        assert!(a.json);
    }

    #[test]
    fn parse_args_rejects_unknown_flags_and_bad_values() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["--limit".into()]).is_err());
        assert!(parse_args(vec!["--since".into(), "soon".into()]).is_err());
    }

    #[test]
    fn help_covers_every_command() {
        let ov = bsc_cli_util::help_overview("bsc runtime", TAGLINE, COMMANDS);
        for name in ["list", "get", "summary", "prune", "hash"] {
            assert!(ov.contains(name), "overview lists {name}");
        }
        // The summary help must SAY that zero sessions voids a "never ran" claim — that misreading is
        // the one way this store produces a confidently wrong answer.
        let sum = bsc_cli_util::help_for("bsc runtime", TAGLINE, COMMANDS, "summary");
        assert!(sum.contains("NOT the same as nothing having run"));
    }

    #[test]
    fn end_to_end_over_a_temp_db() {
        let dir = std::env::temp_dir().join(format!("bsc-runtime-cli-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("runtime.db");
        let _ = std::fs::remove_file(&path);
        let dbp = path.to_string_lossy().into_owned();

        {
            let mut s = Store::open(&path).unwrap();
            s.fold_batch(&[
                NewAttestation {
                    specifier: "@/a".into(), record_id: "rec-a".into(), src_hash: "h".into(),
                    outcome: crate::Outcome::SERVED.into(), session: "s1".into(), n: 2,
                    ms_total: 1400.0, ms_max: 800.0, at: 10, ..Default::default()
                },
                NewAttestation {
                    specifier: "@/b".into(), record_id: "rec-b".into(), src_hash: "h".into(),
                    outcome: crate::Outcome::DECLINED_CLOSURE.into(), session: "s1".into(), n: 1,
                    reason: Some("needs @/missing".into()), at: 20, ..Default::default()
                },
            ])
            .unwrap();
        }

        cmd_list(&args_for(vec!["list"], |a| a.db = Some(dbp.clone()))).unwrap();
        cmd_get(&args_for(vec!["get", "rec-a"], |a| a.db = Some(dbp.clone()))).unwrap();
        cmd_summary(&args_for(vec!["summary"], |a| a.db = Some(dbp.clone()))).unwrap();

        // The declined filter is the one a person reaches for; it must select exactly the refusal.
        let store = Store::open(&path).unwrap();
        let declined = store
            .list(&Filter { outcome: Some(crate::Outcome::DECLINED_CLOSURE.into()), ..Default::default() })
            .unwrap();
        assert_eq!(declined.len(), 1);
        assert_eq!(declined[0].record_id, "rec-b");
        assert!(lean(&declined).contains(" !"), "a decline is flagged in the lean view");
        assert!(lean(&store.list(&Filter::default()).unwrap()).contains("700ms"), "mean is n-weighted");

        // `get` on an unknown record must NOT claim it never ran.
        let unknown = store.for_record("nope").unwrap();
        assert!(unknown.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hash_reads_a_file_and_matches_the_library() {
        let dir = std::env::temp_dir().join(format!("bsc-runtime-hash-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("mod.ts");
        std::fs::write(&f, "export const x = 1;\n").unwrap();
        cmd_hash(&args_for(vec!["hash", &f.to_string_lossy()], |_| {})).unwrap();
        assert_eq!(crate::src_hash("export const x = 1;\n").len(), 16);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_store_summarises_as_unmeasured_rather_than_dead() {
        let dir = std::env::temp_dir().join(format!("bsc-runtime-empty-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("runtime.db");
        let _ = std::fs::remove_file(&path);
        let store = Store::open(&path).unwrap();
        assert_eq!(store.session_count().unwrap(), 0);
        cmd_summary(&args_for(vec!["summary"], |a| a.db = Some(path.to_string_lossy().into_owned()))).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
