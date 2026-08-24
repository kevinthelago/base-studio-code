//! `bsc atlas` — read the product feature-inventory corpus, scoped.
//!
//! Every verb narrows. There is deliberately no `dump`: the corpus is ~6,000 rows and the reason it
//! left `docs/enterprise-atlas.md` is that a 48k-token file cannot be read selectively. A surface
//! that hands back everything would rebuild the problem in a new place.

use crate::{capabilities, carriers, domains, meta, open, product, products, seed, default_path};

const TAGLINE: &str = "product feature inventories — domains · products · capabilities (read-only corpus)";

const HELP: &str = "\
bsc atlas — {TAGLINE}

USAGE:
  bsc atlas <command> [args] [--json|--pretty] [--db <path>]

COMMANDS:
  domains                                every domain + its product count
  products [--domain <d>]                products, optionally within one domain
  product <id>                           ONE product in full — capabilities, detail, features
  capabilities [--domain d] [--product p] [--shared]
                                         capability labels + how many products carry each;
                                         --shared keeps only those carried by MORE THAN ONE,
                                         which is the market-expectation axis
  carriers <capability-slug>             which products carry a capability — 'who else does this?'
  meta                                   corpus totals
  reseed                                 re-apply the packaged corpus; prints the product count

Scoping is the point. `capabilities --domain crm-customer-relationship-management --shared` answers
\"what does every CRM ship?\" as a join. The same question against the source document was a read of
the whole file.
";

fn print_help(prog: &str) {
    println!("{}", HELP.replace("{TAGLINE}", TAGLINE).replace("bsc atlas", prog));
}

/// Pull `--flag <value>` out of the positional stream.
fn flag(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

fn positionals(args: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    let mut skip = false;
    for (i, a) in args.iter().enumerate() {
        if skip {
            skip = false;
            continue;
        }
        if a == "--db" || a == "--domain" || a == "--product" {
            skip = true;
            continue;
        }
        if a.starts_with("--") || i == 0 {
            continue;
        }
        out.push(a.clone());
    }
    out
}

fn emit(v: &serde_json::Value, pretty: bool) {
    println!(
        "{}",
        if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) }
            .unwrap_or_else(|e| format!("{{\"error\":\"{e}\"}}"))
    );
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let cmd = args.first().cloned().unwrap_or_default();
    if cmd.is_empty() || cmd == "help" || cmd == "--help" {
        print_help(prog);
        return Ok(());
    }
    let pretty = args.iter().any(|a| a == "--pretty");
    let path = match flag(&args, "--db") {
        Some(p) => std::path::PathBuf::from(p),
        None => default_path()?,
    };
    let conn = open(&path)?;
    let pos = positionals(&args);
    let domain = flag(&args, "--domain");
    let prod = flag(&args, "--product");

    match cmd.as_str() {
        "domains" => emit(&serde_json::to_value(domains(&conn)?).map_err(|e| e.to_string())?, pretty),
        "products" => emit(
            &serde_json::to_value(products(&conn, domain.as_deref())?).map_err(|e| e.to_string())?,
            pretty,
        ),
        "product" => {
            let id = pos.first().ok_or_else(|| format!("usage: {prog} product <id>"))?;
            // `null` rather than an error for an absent id: the same shape every other store's `get`
            // returns, so a caller can test for it without parsing an error string.
            emit(&serde_json::to_value(product(&conn, id)?).map_err(|e| e.to_string())?, pretty);
        }
        "capabilities" => {
            let shared = args.iter().any(|a| a == "--shared");
            emit(
                &serde_json::to_value(capabilities(&conn, domain.as_deref(), prod.as_deref(), shared)?)
                    .map_err(|e| e.to_string())?,
                pretty,
            );
        }
        "carriers" => {
            let cap = pos.first().ok_or_else(|| format!("usage: {prog} carriers <capability-slug>"))?;
            emit(&serde_json::to_value(carriers(&conn, cap)?).map_err(|e| e.to_string())?, pretty);
        }
        "meta" => emit(&meta(&conn)?, pretty),
        "reseed" => {
            let n = seed(&conn)?;
            println!("reseeded {n} product(s)");
        }
        other => {
            return Err(format!(
                "{prog}: unknown command '{other}' — try `{prog} help`"
            ))
        }
    }
    Ok(())
}
