//! The argument walk every `bsc` CLI shares (`one-cli-argument-parser-is-written-in-every-crate`).
//!
//! **What is shared is the WALK, not the flags.** Each CLI knows its own flag set and its own refusal
//! wording; what seventeen of them had each written by hand is the loop around that set — route
//! `-h`/`--help` to the `help` verb, refuse an unrecognised `--flag`, collect everything else as a
//! positional, and hand a flag its following argument.
//!
//! MEASURED before the extraction: seventeen copies, and they had already drifted. **Five carried no
//! `-h`/`--help` arm at all**, so `bsc mem -h` answered `unknown command '-h'` while `bsc logs -h`
//! printed help — a difference nobody chose, in the one flag a person reaches for when they are already
//! lost. That is the cost this module exists to stop paying, and it is why the walk owns the help arm
//! rather than leaving it to each caller to remember.
//!
//! ```ignore
//! fn parse_args(raw: Vec<String>) -> Result<Args, String> {
//!     let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, v| {
//!         match flag {
//!             "--json" => a.json = true,
//!             "--db" => a.db = Some(v.value("--db needs a path")?),
//!             _ => return Ok(false),   // not mine — the walk refuses it
//!         }
//!         Ok(true)
//!     })?;
//!     a.positional = positional;
//!     Ok(a)
//! }
//! ```

/// The rest of the command line, handed to a flag that takes a value.
///
/// [`value`](Values::value) takes the whole REFUSAL, not the flag name, because the refusals are the
/// part each CLI is entitled to keep: `--roster needs a path` and `--file needs a bare filename in
/// $BSC_SCRATCH` say something a generic `--file needs a value` cannot.
pub struct Values {
    it: std::vec::IntoIter<String>,
}

impl Values {
    /// The next argument, or `refusal` if the line ended.
    pub fn value(&mut self, refusal: &str) -> Result<String, String> {
        self.it.next().ok_or_else(|| refusal.to_string())
    }
}

/// Walk `raw`, letting `flag` claim the flags it knows.
///
/// `flag` returns `Ok(true)` for a flag it handled and `Ok(false)` for one it does not know — an
/// unknown `--flag` is then refused with `unknown flag '<it>'`, the wording every hand-written copy
/// already produced. Returns the accumulated `A` and the positionals, in order.
///
/// **A single-dash argument is a POSITIONAL, and that is deliberately preserved.** Only `--` prefixes
/// are refused, so `bsc logs -j` passes `-j` through as a verb rather than erroring. Every copy behaved
/// this way; the extraction changes no behaviour it did not set out to change, and a single shared
/// decision is now a thing that CAN be revisited once, rather than seventeen that cannot.
pub fn walk<A>(
    raw: Vec<String>,
    mut acc: A,
    mut flag: impl FnMut(&str, &mut A, &mut Values) -> Result<bool, String>,
) -> Result<(A, Vec<String>), String> {
    let mut rest = Values { it: raw.into_iter() };
    let mut positional: Vec<String> = Vec::new();
    while let Some(arg) = rest.it.next() {
        // `-h` FIRST, and it wins over the caller's flags: no CLI declares it, and the five that had
        // simply forgotten it are the reason this is not left to the caller.
        if arg == "-h" || arg == "--help" {
            positional.insert(0, "help".into());
            continue;
        }
        if flag(arg.as_str(), &mut acc, &mut rest)? {
            continue;
        }
        if arg.starts_with("--") {
            return Err(format!("unknown flag '{arg}'"));
        }
        positional.push(arg);
    }
    Ok((acc, positional))
}

/// [`walk`] over a BORROWED slice — the shape every per-SUBCOMMAND parser has.
///
/// The top-level parser owns its `Vec<String>` and fills an `Args` struct. A subcommand parser is
/// handed `&[String]` and fills a tuple of locals, which is why the top-level extraction could not
/// reach them: MEASURED 2026-09-01 there are 54 of these (bsc-component 34, bsc-ui 13, bsc-persona 4,
/// bsc-ui/tests_harvest 3), and they have drifted in their REFUSAL rather than their help arm —
/// `bsc persona set foo` refuses a bare word as a "flag" while `bsc ui list foo` accepts it silently.
///
/// The rule is [`walk`]'s, unchanged: only a `--`-prefixed unknown is refused, `-h`/`--help` routes to
/// the help verb, everything else is a positional. A subcommand that genuinely takes no positionals
/// checks that itself, where the fact lives — a walk cannot know it.
pub fn walk_ref<A>(
    raw: &[String],
    acc: A,
    flag: impl FnMut(&str, &mut A, &mut Values) -> Result<bool, String>,
) -> Result<(A, Vec<String>), String> {
    walk(raw.to_vec(), acc, flag)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default, PartialEq, Debug)]
    struct A {
        json: bool,
        db: Option<String>,
        repos: Vec<String>,
    }

    fn parse(raw: &[&str]) -> Result<(A, Vec<String>), String> {
        walk(raw.iter().map(|s| (*s).to_string()).collect(), A::default(), |f, a: &mut A, v| {
            match f {
                "--json" => a.json = true,
                "--db" => a.db = Some(v.value("--db needs a path")?),
                "--repo" => a.repos.push(v.value("--repo needs an owner/name")?),
                _ => return Ok(false),
            }
            Ok(true)
        })
    }

    #[test]
    fn a_flag_takes_the_argument_after_it_and_the_rest_are_positional() {
        let (a, pos) = parse(&["list", "--db", "/tmp/x.db", "open", "--json"]).unwrap();
        assert_eq!(a, A { json: true, db: Some("/tmp/x.db".into()), repos: vec![] });
        assert_eq!(pos, vec!["list", "open"]);
    }

    #[test]
    fn a_repeated_flag_accumulates() {
        let (a, _) = parse(&["--repo", "a/b", "--repo", "c/d"]).unwrap();
        assert_eq!(a.repos, vec!["a/b", "c/d"]);
    }

    #[test]
    fn the_callers_refusal_is_what_a_missing_value_reports() {
        // The whole reason `value` takes the message rather than the flag name: this wording is the
        // caller's, and a shared "--db needs a value" would have been a downgrade at every call site.
        assert_eq!(parse(&["--db"]).unwrap_err(), "--db needs a path");
    }

    #[test]
    fn an_unknown_double_dash_flag_is_refused_in_the_wording_every_copy_used() {
        assert_eq!(parse(&["--nope"]).unwrap_err(), "unknown flag '--nope'");
    }

    #[test]
    fn help_routes_to_the_help_verb_from_anywhere_on_the_line() {
        // The drift this module was written to end: five of the seventeen copies had no such arm, so
        // `bsc mem -h` answered `unknown command '-h'`. Both spellings, and NOT only in first position.
        for spelling in ["-h", "--help"] {
            let (_, pos) = parse(&["list", spelling]).unwrap();
            assert_eq!(pos, vec!["help", "list"], "{spelling} did not route to help");
        }
    }

    #[test]
    fn a_single_dash_argument_stays_a_positional() {
        // Preserved on purpose — every hand-written copy refused only `--` prefixes, so this is
        // existing behaviour, now stated in one place where it can be reconsidered as one decision.
        let (_, pos) = parse(&["-j"]).unwrap();
        assert_eq!(pos, vec!["-j"]);
    }

    /// The borrowed shape answers identically — one rule, whichever form a caller has.
    #[test]
    fn walk_ref_answers_exactly_as_walk_does() {
        let raw: Vec<String> = ["list", "--db", "/tmp/x", "extra"].iter().map(|s| s.to_string()).collect();
        let borrowed = walk_ref(&raw, A::default(), |f, a: &mut A, v| {
            match f {
                "--db" => a.db = Some(v.value("--db needs a path")?),
                _ => return Ok(false),
            }
            Ok(true)
        })
        .unwrap();
        assert_eq!(borrowed.0.db.as_deref(), Some("/tmp/x"));
        assert_eq!(borrowed.1, vec!["list", "extra"]);
        // A BARE word is a positional here, as it is at the top level. `bsc persona set foo` used to
        // refuse it as a "flag", which is both inconsistent with its siblings and inaccurate about
        // what it found.
        let (_, pos) = walk_ref(&["foo".to_string()], A::default(), |_, _: &mut A, _| Ok(false)).unwrap();
        assert_eq!(pos, vec!["foo"]);
    }

    #[test]
    fn a_value_is_taken_verbatim_even_when_it_looks_like_a_flag() {
        // `--note --json` means the note IS "--json". The walk must not re-inspect a consumed value,
        // or a legitimate `--note '--dry-run means something'` becomes an unknown-flag refusal.
        let (a, pos) = parse(&["--db", "--json"]).unwrap();
        assert_eq!(a.db, Some("--json".into()));
        assert!(!a.json);
        assert!(pos.is_empty());
    }
}
