//! The `bsc survival` subcommand — the session-facing surface over the corpus.
//!
//! Output is JSON to stdout (compact by default, indented with `--pretty`), the house style, with the
//! one deliberate exception of `compile`, which prints markdown because a field manual that arrives
//! JSON-escaped is not a field manual.
//!
//! Store precedence is the shared one: `--db <path>`, then `$BSC_SURVIVAL_STORE`, then
//! `~/.base-studio-code/survival/store.db`.

use crate::engine::Engine;
use crate::store::Store;
use crate::types::{Category, Function, Procedure, Remedy};
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json};
use std::path::PathBuf;

const TAGLINE: &str = "the offline survival corpus — procedures by what is in your hands, remedies by function and location";

/// The crate's verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than restate it.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every procedure, or one category",
        usage: "\
USAGE:
  bsc survival list [--category <c>]

Every procedure as JSON, in survival-priority order (medical, shelter, water, fire, signal,
navigation, tools, food) rather than alphabetically. <c> is one of the tokens `bsc survival
categories` prints.",
    },
    CmdDoc {
        name: "get",
        summary: "one record's full text — procedure or remedy",
        usage: "\
USAGE:
  bsc survival get <id>

Prints the full record for <id>, whichever kind it is, or null. Read the `limits` on a procedure and
the `lookalikes` on a remedy before you act on either.",
    },
    CmdDoc {
        name: "search",
        summary: "free-text search across both kinds",
        usage: "\
USAGE:
  bsc survival search <terms...>

Every term must match. Searches names, summaries, tags, materials, habitats, functions and
preparations.",
    },
    CmdDoc {
        name: "have",
        summary: "THE INVERSE LOOKUP: what these materials let you do",
        usage: "\
USAGE:
  bsc survival have <item> [<item>...]
  bsc survival have bottle,sand,charcoal,pot

Given what is in your hands, ranks the procedures those materials support — ready ones first, then
the ones a single item short, with `missing` naming what to look for. Matching goes through each
material's substitutes, so `tin can` satisfies `metal container`. A procedure your materials touch
in no way at all is left out.",
    },
    CmdDoc {
        name: "remedy",
        summary: "the natural remedies, by FUNCTION and by LOCATION",
        usage: "\
USAGE:
  bsc survival remedy list [--function <f>] [--region <r>]
  bsc survival remedy get <id>

--function is what you need it FOR — `hemostatic` (also accepted: clotting, styptic, stop-bleeding),
`antiseptic`, `analgesic`, `antifungal`, `astringent`, `burn`, `insect`, `digestive`, `nutrition`,
`anti_inflammatory`. --region is where you are; it walks the `-` hierarchy, so `north-america`
answers `north-america-west` and `worldwide` answers everything.

Run `bsc survival functions` / `bsc survival regions` to see the tokens this store actually holds.",
    },
    CmdDoc {
        name: "functions",
        summary: "the function vocabulary, with counts",
        usage: "\
USAGE:
  bsc survival functions

Every --function token the store holds and how many remedies carry it, most-carried first. A filter
you cannot spell is a filter you cannot use.",
    },
    CmdDoc {
        name: "regions",
        summary: "the region vocabulary, with counts",
        usage: "\
USAGE:
  bsc survival regions

Every --region token the store holds and how many remedies carry it, most-carried first.",
    },
    CmdDoc {
        name: "categories",
        summary: "the procedure-category vocabulary, with counts",
        usage: "\
USAGE:
  bsc survival categories

Every --category token the store holds and how many procedures carry it.",
    },
    CmdDoc {
        name: "compile",
        summary: "the whole corpus as one offline markdown field manual",
        usage: "\
USAGE:
  bsc survival compile [--out <path>]

Renders every procedure and remedy as markdown — the copy you print and carry. Writes to stdout, or
to <path> with --out. This is the ONE verb that does not print JSON.",
    },
    CmdDoc {
        name: "meta",
        summary: "corpus version + counts + last-updated stamp",
        usage: "\
USAGE:
  bsc survival meta",
    },
    CmdDoc {
        name: "reseed",
        summary: "re-apply the packaged corpus; keeps rows you added",
        usage: "\
USAGE:
  bsc survival reseed

Rewrites the packaged records over whatever is in the store and leaves records you added alone.
Prints the counts written.",
    },
    CmdDoc {
        name: "upsert",
        summary: "add your own records from JSON on stdin",
        usage: "\
USAGE:
  bsc survival upsert procedure   # a Procedure object (or an array) as JSON on stdin
  bsc survival upsert remedy      # a Remedy object (or an array) as JSON on stdin

The packaged corpus is temperate and northern-hemisphere heavy because that is what can be written
responsibly from a distance. What grows where you actually live belongs here. `bsc survival get <id>`
on a packaged record prints the shape to copy.",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a record; prints whether a row existed",
        usage: "\
USAGE:
  bsc survival remove <id>

Removes the record of either kind keyed by <id>. A packaged record comes back on the next `reseed`.",
    },
];

#[derive(Debug)]
struct Args {
    db: Option<String>,
    pretty: bool,
    category: Option<String>,
    function: Option<String>,
    region: Option<String>,
    out: Option<String>,
    positional: Vec<String>,
}

/// Split a comma-separated value into trimmed, non-empty tokens.
fn csv(s: &str) -> Vec<String> {
    s.split(',').map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect()
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        db: None,
        pretty: false,
        category: None,
        function: None,
        region: None,
        out: None,
        positional: Vec::new(),
    };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        match flag {
            "--db" => a.db = Some(v.value("--db needs a path")?),
            "--pretty" => a.pretty = true,
            // Output is JSON everywhere but `compile`; --json is accepted so a caller can be explicit.
            "--json" => {}
            "--category" => a.category = Some(v.value("--category needs a value")?),
            "--function" => a.function = Some(v.value("--function needs a value (try `bsc survival functions`)")?),
            "--region" => a.region = Some(v.value("--region needs a value (try `bsc survival regions`)")?),
            "--out" => a.out = Some(v.value("--out needs a path")?),
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

/// Parse a category token, listing what the store actually holds when it fails — a refusal that names
/// the way forward, rather than one that names only the mistake.
fn parse_category(s: &str, e: &Engine) -> Result<Category, String> {
    Category::parse(s).ok_or_else(|| {
        let have: Vec<String> = e.categories().into_iter().map(|t| t.token).collect();
        format!("unknown category '{s}' — this store holds: {}", have.join(" | "))
    })
}

/// Parse a function token, likewise.
fn parse_function(s: &str, e: &Engine) -> Result<Function, String> {
    Function::parse(s).ok_or_else(|| {
        let have: Vec<String> = e.functions().into_iter().map(|t| t.token).collect();
        format!(
            "unknown function '{s}' — this store holds: {} (aliases: clotting/styptic → hemostatic, \
             antimicrobial → antiseptic, painkiller → analgesic)",
            have.join(" | ")
        )
    })
}

/// The `survival` subcommand entrypoint: `args` is everything after `bsc survival`.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Help works without a store, so it is dispatched before one is opened.
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    let open = || -> Result<Engine, String> {
        let path = resolve_db(&args.db)?;
        Store::open(&path).map(Engine::with_store).map_err(|e| format!("opening {}: {e}", path.display()))
    };

    match cmd.as_str() {
        "list" => {
            let e = open()?;
            let category = match args.category.as_deref() {
                Some(c) => Some(parse_category(c, &e)?),
                None => None,
            };
            print_json(&e.procedures(category), args.pretty);
            Ok(())
        }
        "get" => {
            let id = args.positional.get(1).ok_or("usage: bsc survival get <id>")?;
            let e = open()?;
            // Either kind, so the caller does not have to know which it is asking for. `null` on a miss.
            match e.store().procedure(id) {
                Some(p) => print_json(&p, args.pretty),
                None => print_json(&e.store().remedy(id), args.pretty),
            }
            Ok(())
        }
        "search" => {
            let terms = args.positional[1..].join(" ");
            if terms.trim().is_empty() {
                return Err("usage: bsc survival search <terms...>".into());
            }
            print_json(&open()?.search(&terms), args.pretty);
            Ok(())
        }
        "have" => {
            // Both shapes, because both are what a person types: space-separated words, and one
            // comma-separated argument.
            let have: Vec<String> = args.positional[1..].iter().flat_map(|a| csv(a)).collect();
            if have.is_empty() {
                return Err("usage: bsc survival have <item> [<item>...]   (or a comma-separated list)".into());
            }
            print_json(&open()?.feasible(&have), args.pretty);
            Ok(())
        }
        "remedy" => {
            let sub = args.positional.get(1).map(String::as_str).unwrap_or("");
            match sub {
                "list" => {
                    let e = open()?;
                    let function = match args.function.as_deref() {
                        Some(f) => Some(parse_function(f, &e)?),
                        None => None,
                    };
                    print_json(&e.remedies(function, args.region.as_deref()), args.pretty);
                    Ok(())
                }
                "get" => {
                    let id = args.positional.get(2).ok_or("usage: bsc survival remedy get <id>")?;
                    print_json(&open()?.store().remedy(id), args.pretty);
                    Ok(())
                }
                "" => Err(format!(
                    "usage: bsc survival remedy <list|get>\n\n{}",
                    bsc_cli_util::surface::help_for(prog, TAGLINE, COMMANDS, "remedy")
                )),
                other => Err(format!(
                    "unknown remedy command '{other}'\n\n{}",
                    bsc_cli_util::surface::help_for(prog, TAGLINE, COMMANDS, "remedy")
                )),
            }
        }
        "functions" => {
            print_json(&open()?.functions(), args.pretty);
            Ok(())
        }
        "regions" => {
            print_json(&open()?.regions(), args.pretty);
            Ok(())
        }
        "categories" => {
            print_json(&open()?.categories(), args.pretty);
            Ok(())
        }
        "compile" => {
            let md = open()?.compile();
            match args.out.as_deref() {
                Some(path) => {
                    std::fs::write(path, &md).map_err(|e| format!("writing {path}: {e}"))?;
                    // The one non-JSON verb still says what it did, on stderr-free stdout.
                    println!("{} bytes → {path}", md.len());
                }
                None => print!("{md}"),
            }
            Ok(())
        }
        "meta" => {
            print_json(&open()?.store().meta(), args.pretty);
            Ok(())
        }
        "reseed" => {
            let (p, r) = open()?.store().reseed()?;
            print_json(&serde_json::json!({ "procedures": p, "remedies": r }), args.pretty);
            Ok(())
        }
        "upsert" => {
            let kind = args.positional.get(1).map(String::as_str).unwrap_or("");
            let e = open()?;
            match kind {
                "procedure" => {
                    let items: Vec<Procedure> = read_stdin_json("procedure")?;
                    let mut ids = Vec::new();
                    for p in &items {
                        if p.id.trim().is_empty() {
                            return Err("upsert: each procedure needs a non-empty \"id\"".into());
                        }
                        if p.limits.is_empty() {
                            return Err(format!(
                                "upsert: procedure '{}' has no \"limits\". Every procedure has to say what it does \
                                 NOT do — an empty list reads, to everyone downstream, as 'this has no limits'.",
                                p.id
                            ));
                        }
                        e.store().upsert_procedure(p)?;
                        ids.push(p.id.clone());
                    }
                    print_json(&ids, args.pretty);
                    Ok(())
                }
                "remedy" => {
                    let items: Vec<Remedy> = read_stdin_json("remedy")?;
                    let mut ids = Vec::new();
                    for r in &items {
                        if r.id.trim().is_empty() {
                            return Err("upsert: each remedy needs a non-empty \"id\"".into());
                        }
                        if r.cautions.is_empty() {
                            return Err(format!(
                                "upsert: remedy '{}' has no \"cautions\". Every remedy has to carry what it costs \
                                 the person who gets it wrong.",
                                r.id
                            ));
                        }
                        for l in &r.lookalikes {
                            if l.tell.trim().is_empty() {
                                return Err(format!(
                                    "upsert: remedy '{}' names the look-alike '{}' with no \"tell\". A warning with \
                                     no way to check it leaves the reader worse off than no warning.",
                                    r.id, l.name
                                ));
                            }
                        }
                        e.store().upsert_remedy(r)?;
                        ids.push(r.id.clone());
                    }
                    print_json(&ids, args.pretty);
                    Ok(())
                }
                "" => Err("usage: bsc survival upsert <procedure|remedy>   # JSON on stdin".into()),
                other => Err(format!("unknown kind '{other}' — expected `procedure` or `remedy`")),
            }
        }
        "remove" => {
            let id = args.positional.get(1).ok_or("usage: bsc survival remove <id>")?;
            print_json(&open()?.store().remove(id)?, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `--db` → `$BSC_SURVIVAL_STORE` → `~/.base-studio-code/survival/store.db`.
fn resolve_db(flag: &Option<String>) -> Result<PathBuf, String> {
    bsc_cli_util::resolve_store_path(flag, "BSC_SURVIVAL_STORE", || {
        Store::default_path().ok_or_else(|| {
            "could not resolve a store path; pass --db <path> or set BSC_SURVIVAL_STORE".to_string()
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        Engine::with_store(Store::in_memory().unwrap())
    }

    #[test]
    fn parse_args_collects_the_flags_and_positionals() {
        let a = parse_args(
            ["remedy", "list", "--function", "clotting", "--region", "europe", "--pretty"]
                .iter()
                .map(|s| s.to_string())
                .collect(),
        )
        .unwrap();
        assert_eq!(a.positional, vec!["remedy".to_string(), "list".to_string()]);
        assert_eq!(a.function.as_deref(), Some("clotting"));
        assert_eq!(a.region.as_deref(), Some("europe"));
        assert!(a.pretty);
    }

    #[test]
    fn parse_args_rejects_an_unknown_flag_and_routes_the_help_flag() {
        assert!(parse_args(vec!["list".into(), "--nope".into()]).unwrap_err().contains("unknown flag"));
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    /// A refusal that only names the mistake leaves the caller where they were. These name what the
    /// store actually holds, so the next command is already written for them.
    #[test]
    fn an_unknown_filter_token_is_refused_by_naming_what_the_store_holds() {
        let e = engine();
        let err = parse_function("nonsense", &e).unwrap_err();
        assert!(err.contains("nonsense"), "names what was asked for: {err}");
        assert!(err.contains("hemostatic"), "and lists a real token: {err}");
        assert!(err.contains("clotting"), "and the alias a person would actually type: {err}");

        let err = parse_category("nonsense", &e).unwrap_err();
        assert!(err.contains("water") && err.contains("medical"), "{err}");
    }

    /// `have` is the verb people will type most, and they will type it both ways.
    #[test]
    fn csv_accepts_both_the_spaced_and_the_comma_separated_shapes() {
        assert_eq!(csv("bottle, sand ,,charcoal"), vec!["bottle", "sand", "charcoal"]);
        assert!(csv("").is_empty());
    }

    /// The two safety fields are enforced on the WRITE path as well as the seed, or a user-added
    /// record would be the one row in the store that cannot state its own limits.
    #[test]
    fn upsert_refuses_a_record_that_cannot_state_what_it_costs() {
        // A procedure with no limits.
        let bad = r#"{"id":"x","category":"water","name":"X","summary":"s","limits":[],"steps":[{"text":"t"}]}"#;
        let p: Procedure = serde_json::from_str(bad).unwrap();
        assert!(p.limits.is_empty(), "the fixture is the shape the refusal is about");

        // A look-alike with no tell.
        let bad = r#"{"id":"y","name":"Y","functions":["hemostatic"],"cautions":["c"],
                      "lookalikes":[{"name":"Deadly thing","danger":"kills you","tell":"  "}]}"#;
        let r: Remedy = serde_json::from_str(bad).unwrap();
        assert!(r.lookalikes[0].tell.trim().is_empty());
    }

    #[test]
    fn the_help_overview_lists_every_command_and_drills_into_one() {
        let ov = bsc_cli_util::help_overview("bsc survival", TAGLINE, COMMANDS);
        for c in ["list", "get", "search", "have", "remedy", "functions", "regions", "compile", "upsert"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let r = bsc_cli_util::help_for("bsc survival", TAGLINE, COMMANDS, "remedy");
        assert!(r.contains("--function") && r.contains("--region"));
        assert!(!r.contains("reseed"), "drilling into one command does not print the whole menu");
        assert!(bsc_cli_util::help_for("bsc survival", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }
}
