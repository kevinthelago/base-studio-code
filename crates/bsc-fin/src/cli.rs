//! The `bsc fin` verbs.
//!
//! READ-ONLY SO FAR, and deliberately: `parse` proves the ingest against a file and prints what it
//! found without writing anything. A store lands next, and it lands after the parse is trustworthy —
//! a store filled by a parser nobody has checked is a confident wrong answer that persists.
use crate::statement;

pub const COMMANDS: &[bsc_cli_util::CmdDoc] = &[bsc_cli_util::CmdDoc {
    name: "parse",
    summary: "read a statement export and report what it found — and every row it could NOT read",
    usage: "bsc fin parse <file.csv> [--json]",
}];

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let json = args.iter().any(|a| a == "--json");
    let positional: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    match positional.first().map(|s| s.as_str()) {
        Some("parse") => {
            let path = positional
                .get(1)
                .ok_or_else(|| format!("usage: {prog} parse <file.csv> [--json]"))?;
            let text = std::fs::read_to_string(path).map_err(|e| format!("cannot read {path}: {e}"))?;
            let p = statement::parse_csv(&text)?;
            if json {
                let rows: Vec<serde_json::Value> = p
                    .txns
                    .iter()
                    .map(|t| serde_json::json!({ "date": t.date, "description": t.description, "minor": t.minor }))
                    .collect();
                let rejected: Vec<serde_json::Value> = p
                    .rejected
                    .iter()
                    .map(|r| serde_json::json!({ "line": r.line, "reason": r.reason }))
                    .collect();
                println!(
                    "{}",
                    serde_json::json!({
                        "institution": p.institution.name(),
                        "profile": p.profile,
                        "transactions": rows,
                        "rejected": rejected,
                    })
                );
            } else {
                println!("{} · {}", p.institution.name(), p.profile);
                println!("  {} transaction(s)", p.txns.len());
                let net: i64 = p.txns.iter().map(|t| t.minor).sum();
                println!("  net {}", crate::money::format_minor(net));
                if p.rejected.is_empty() {
                    println!("  every row read");
                } else {
                    // Loud, and never a summary count alone: an unread row is a wrong balance.
                    println!("  {} row(s) NOT read:", p.rejected.len());
                    for r in &p.rejected {
                        println!("    line {}: {}", r.line, r.reason);
                    }
                }
            }
            Ok(())
        }
        Some(other) => Err(format!("{prog}: unknown command `{other}` — try `{prog} parse`")),
        None => Err(format!("usage: {prog} parse <file.csv> [--json]")),
    }
}
