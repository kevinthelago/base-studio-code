//! The `bsc news` subcommand — the session-facing CLI over the low-trust news layer.
//!
//! Four verbs: `outlets` (the roster + what each has actually delivered), `poll` (fetch every feed
//! and append any changed version), `brief` (the digest for one event), and `history` (every stored
//! version of one URL — the stealth-edit view).
//!
//! Lean text by default, JSON with `--json`/`--pretty`, following the `bsc cve` house style. The
//! store is located via `--db` → `$BSC_NEWS_DB` → the default.

use crate::engine;
use crate::http::Http;
use crate::outlets;
use crate::store::Store;
use bsc_cli_util::CmdDoc;
use bsc_util::now_secs;

const TAGLINE: &str =
    "the low-trust news layer — poll outlets, retain every version, and compute the framing signals (NOT `bsc research`, which is for citable sources)";

/// Default brief window: articles first seen in the last 24 hours.
const DEFAULT_WINDOW_SECS: i64 = 24 * 60 * 60;

/// The crate's verb catalog. `pub` so `bsc surface verbs` can PROJECT it rather than restate it.
pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "outlets",
        summary: "the roster: twelve institutions, three per bloc, one wire agency each",
        usage: "\
USAGE:
  bsc news outlets [--bloc <US|UK|RU|CN>]

Prints each outlet with its bloc, kind (agency vs outlet), feed format, how many versions the store
holds for it, and when it was last fetched.

A `STALE` marker means the feed is KNOWN to be abandoned upstream while still answering 200 — read
that outlet's zero as `no feed`, never as `covered nothing`. HTTP status is not liveness.",
    },
    CmdDoc {
        name: "poll",
        summary: "fetch every feed, appending a version wherever the text changed",
        usage: "\
USAGE:
  bsc news poll [<outlet-id> …]

Fetches each outlet's feed and records what it found. An article whose text is byte-identical to the
last stored version writes NOTHING; one whose title or summary changed appends a NEW version, so the
earlier wording survives and a stealth edit stays observable.

One failing feed never fails the poll — the outlet's row carries the error and the rest continue.
Name one or more outlet ids to poll only those.",
    },
    CmdDoc {
        name: "brief",
        summary: "the digest for one event: corroboration, framing, agency deletion",
        usage: "\
USAGE:
  bsc news brief <query…> [--since <secs>] [--evidence]

Selects stored articles whose text contains EVERY query term, then reports three computed signals:

  • CORROBORATION — distinct text lineages, not outlet headcount. Reprints of one wire story are ONE
    source and N echoes. A lineage's origin is its wire agency when present (a wire reaches
    subscribers before it is public, so observation order alone crowns the fastest subscriber).
  • FRAMING — which contested word each outlet chose for the same referent (militant/terrorist,
    regime/government, detained/kidnapped). Axes where the outlets agree are not reported as findings.
  • AGENCY DELETION — passives with no actor (`a building was struck`), contrasted per outlet. A
    HEURISTIC over a grammatical form, which is why every hit is quoted: check them and discard what
    does not hold.

Also lists which roster outlets were SILENT on the event — omission is a finding, and it exists only
because the roster is a closed, known set.

`--since` is a window in seconds (default 86400, i.e. the last day); `--evidence` prints the located
spans behind every number. Selection is a KEYWORD FILTER, not cross-lingual event clustering — that
is deliberately deferred until the digest has proven worth reading.",
    },
    CmdDoc {
        name: "find",
        summary: "articles about a person, a place or a circumstance",
        usage: "\
USAGE:
  bsc news find [--person <name>] [--place <key>] [--circumstance <key|family>]
                [--outlet <id>] [--bloc <US|UK|RU|CN>] [--since <secs>] [<query…>]

Every filter is AND-ed; repeat one to widen it. They are distinct kinds on purpose — a bare keyword
cannot tell the person Putin from a coincidence, and matches nothing you cannot already name.

  --person        matched against EXTRACTED names, not raw text. Substring on the canonical key, so
                  `putin` finds `Putin’s`. Covers both cue-confirmed people and unconfirmed
                  proper-noun runs (organisations, events), because you want the article either way.
  --place         a gazetteer KEY, which also matches the demonym and major cities: `--place russia`
                  hits `Russian`, `Moscow` and `Russia`. Demonyms outnumber country names in
                  headlines, so this is most of the value.
  --circumstance  a key (`flood`) OR a family (`disaster`), which expands to every member — so
                  `what disasters is anyone covering` is answerable without naming one.

Run `bsc news entities` first if you do not know what to filter on. Each hit prints the mentions
that put it there.",
    },
    CmdDoc {
        name: "entities",
        summary: "what is IN the corpus: people, places and circumstances, ranked",
        usage: "\
USAGE:
  bsc news entities [--kind person|place|circumstance] [--since <secs>] [--limit <n>]

The discovery half of `find`. A filter you can only use once you already know the answer is not a
filter, so this ranks what the store actually holds — most-covered first, ties broken by how many
distinct OUTLETS mention it, because a thing five outlets name is a better handle than one an outlet
repeated five times.

A `person` row marked `cue` was confirmed by a role, an attribution verb or a wire byline; an
unmarked one is a proper-noun run, which may be an organisation or an event rather than a person.
That distinction is reported rather than guessed at.",
    },
    CmdDoc {
        name: "history",
        summary: "every stored version of one article URL — the stealth-edit view",
        usage: "\
USAGE:
  bsc news history <url>

Prints each retained version oldest-first with the time THIS poller fetched it. Version 1 is the
first sighting; any later version is text that changed after publication.

The feed's own claimed publication date is shown but never used for ordering: upstream timestamps are
routinely wrong or backdated, so first-seen is ours and is the only one trusted.",
    },
];

#[derive(Debug)]
struct Args {
    db: Option<String>,
    pretty: bool,
    json: bool,
    evidence: bool,
    bloc: Option<String>,
    since: i64,
    kind: Option<String>,
    limit: usize,
    person: Vec<String>,
    place: Vec<String>,
    circumstance: Vec<String>,
    outlet: Vec<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let a = Args {
        db: None,
        pretty: false,
        json: false,
        evidence: false,
        bloc: None,
        since: DEFAULT_WINDOW_SECS,
        kind: None,
        limit: 40,
        person: Vec::new(),
        place: Vec::new(),
        circumstance: Vec::new(),
        outlet: Vec::new(),
        positional: Vec::new(),
    };
    let (mut a, positional) = bsc_cli_util::args::walk(raw, a, |flag, a: &mut Args, v| {
        match flag {
            "--db" => a.db = Some(v.value("--db needs a path")?),
            "--pretty" => a.pretty = true,
            "--json" => a.json = true,
            "--evidence" => a.evidence = true,
            "--bloc" => a.bloc = Some(v.value("--bloc needs a code (US|UK|RU|CN)")?),
            "--kind" => a.kind = Some(v.value("--kind needs person|place|circumstance")?),
            "--person" => a.person.push(v.value("--person needs a name")?),
            "--place" => a.place.push(v.value("--place needs a gazetteer key (try `bsc news entities --kind place`)")?),
            "--circumstance" => a.circumstance.push(v.value("--circumstance needs a key or family")?),
            "--outlet" => a.outlet.push(v.value("--outlet needs an outlet id")?),
            "--limit" => {
                let l = v.value("--limit needs a number")?;
                a.limit = l.parse::<usize>().map_err(|_| format!("--limit expects a number, got '{l}'"))?;
            }
            "--since" => {
                let s = v.value("--since needs a number of seconds")?;
                a.since = s.parse::<i64>().map_err(|_| format!("--since expects seconds, got '{s}'"))?;
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

fn open(args: &Args) -> Result<Store, String> {
    let path = bsc_cli_util::resolve_store_path(&args.db, "BSC_NEWS_DB", || {
        Store::default_path().ok_or_else(|| "cannot resolve the default news store path".to_string())
    })?;
    Store::open(&path)
}

/// The `news` subcommand entrypoint: `args` is everything after `bsc news`.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    let verb = args.positional.first().cloned().unwrap_or_default();
    let rest: Vec<String> = args.positional.iter().skip(1).cloned().collect();
    match verb.as_str() {
        "outlets" => cmd_outlets(&args),
        "poll" => cmd_poll(&args, &rest),
        "brief" => cmd_brief(&args, &rest),
        "find" => cmd_find(&args, &rest),
        "entities" => cmd_entities(&args),
        "history" => cmd_history(&args, &rest),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

fn cmd_outlets(args: &Args) -> Result<(), String> {
    let store = open(args)?;
    let want = match &args.bloc {
        Some(b) => Some(
            crate::types::Bloc::parse(b).ok_or_else(|| format!("unknown bloc '{b}' (expected US|UK|RU|CN)"))?,
        ),
        None => None,
    };
    let rows: Vec<_> = outlets::roster()
        .into_iter()
        .filter(|o| want.is_none_or(|w| o.bloc == w))
        .map(|o| {
            let (versions, last) = store.outlet_freshness(&o.id);
            serde_json::json!({
                "id": o.id, "name": o.name, "bloc": o.bloc.code(),
                "kind": o.kind, "feed_kind": o.feed_kind, "feed": o.feed,
                "versions": versions, "last_fetch": last, "known_stale": o.known_stale,
            })
        })
        .collect();
    bsc_cli_util::emit(args.pretty, args.json, &rows, || {
        let mut s = String::new();
        for r in &rows {
            let stale = if r["known_stale"].is_null() { "" } else { "  STALE" };
            s.push_str(&format!(
                "{:<12} {:<26} {:<3} {:<7} {:<14} versions={:<5}{}\n",
                r["id"].as_str().unwrap_or(""),
                r["name"].as_str().unwrap_or(""),
                r["bloc"].as_str().unwrap_or(""),
                r["kind"].as_str().unwrap_or(""),
                r["feed_kind"].as_str().unwrap_or(""),
                r["versions"].as_i64().unwrap_or(0),
                stale
            ));
        }
        // Say WHY a stale outlet reads zero, right where the zero is, rather than in a doc nobody opens.
        for r in &rows {
            if let Some(why) = r["known_stale"].as_str() {
                s.push_str(&format!("\n{} STALE: {why}\n", r["id"].as_str().unwrap_or("")));
            }
        }
        s
    });
    Ok(())
}

fn cmd_poll(args: &Args, only: &[String]) -> Result<(), String> {
    let store = open(args)?;
    let http = Http::new()?;
    let results = engine::poll(&store, &http, only, now_secs());
    bsc_cli_util::emit(args.pretty, args.json, &results, || {
        let mut s = String::new();
        for r in &results {
            match &r.error {
                Some(e) => s.push_str(&format!("{:<12} {:<3} ERROR  {e}\n", r.outlet_id, r.bloc)),
                None => s.push_str(&format!(
                    "{:<12} {:<3} items={:<4} new={:<4} revised={:<3} unchanged={}\n",
                    r.outlet_id, r.bloc, r.items, r.new, r.revised, r.unchanged
                )),
            }
        }
        let (new, revised) = (results.iter().map(|r| r.new).sum::<usize>(), results.iter().map(|r| r.revised).sum::<usize>());
        s.push_str(&format!("\n{new} new · {revised} revised across {} outlets\n", results.len()));
        s
    });
    Ok(())
}

fn filter_from(args: &Args, terms: &[String]) -> engine::Filter {
    engine::Filter {
        query: terms.join(" "),
        person: args.person.clone(),
        place: args.place.clone(),
        circumstance: args.circumstance.clone(),
        outlet: args.outlet.clone(),
        bloc: args.bloc.iter().cloned().collect(),
    }
}

fn cmd_brief(args: &Args, terms: &[String]) -> Result<(), String> {
    let filter = filter_from(args, terms);
    if filter.is_empty() {
        return Err("brief needs a query or a filter (e.g. `bsc news brief port strike`, or `--place nepal`)".into());
    }
    let store = open(args)?;
    let b = engine::brief(&store, &filter, now_secs() - args.since)?;
    let evidence = args.evidence;
    bsc_cli_util::emit(args.pretty, args.json, &b, || render_brief(&b, evidence));
    Ok(())
}

/// The lean rendering — the thing a person actually reads.
fn render_brief(b: &engine::Brief, evidence: bool) -> String {
    let mut s = format!("EVENT  {}\n{} article(s) across {} outlet(s)\n\n", b.query, b.matched, b.outlets.len());

    let c = &b.corroboration;
    s.push_str(&format!(
        "CORROBORATION  {} independent source(s), {} echo(es) — NOT {} reports\n",
        c.independent_sources, c.echoes, c.articles
    ));
    // Never let a headline-only comparison pass itself off as body-text evidence.
    if c.basis == crate::signals::corroborate::Basis::HeadlineOnly {
        s.push_str(
            "               [headline-only: some outlets ship no summary, so the echo count is a FLOOR]\n",
        );
    }
    for l in &c.lineages {
        s.push_str(&format!(
            "  {} [{}] {}\n",
            l.origin.outlet_id,
            l.origin_basis,
            l.origin.title
        ));
        for e in &l.echoes {
            s.push_str(&format!("    ↳ {:<12} {:.0}% overlap  {}\n", e.outlet_id, e.overlap * 100.0, e.title));
            if evidence {
                if let Some(sp) = &e.shared {
                    s.push_str(&format!("       shared: \"{}\"\n", sp.text));
                }
            }
        }
    }

    if b.framing.contested.is_empty() {
        s.push_str("\nFRAMING  no contested vocabulary\n");
    } else {
        s.push_str("\nFRAMING  contested: ");
        s.push_str(&b.framing.contested.join(", "));
        s.push('\n');
        for axis in &b.framing.contested {
            s.push_str(&format!("  {axis}\n"));
            for (outlet, cell) in &b.framing.axes[axis] {
                let picks: Vec<String> =
                    cell.terms.iter().map(|(t, n)| if *n > 1 { format!("{t}×{n}") } else { t.clone() }).collect();
                s.push_str(&format!("    {:<12} {}\n", outlet, picks.join(", ")));
            }
        }
    }

    s.push_str("\nAGENCY DELETION  (heuristic — every hit is quoted so you can discard it)\n");
    for (outlet, t) in &b.agency_deletion {
        s.push_str(&format!("  {:<12} deleted={} attributed={}\n", outlet, t.deleted, t.attributed));
        if evidence {
            for sp in &t.spans {
                s.push_str(&format!("       \"{}\"  {}\n", sp.text, sp.url));
            }
        }
    }

    if !b.silent.is_empty() {
        s.push_str(&format!("\nSILENT  {}\n", b.silent.join(", ")));
    }
    s
}

fn cmd_find(args: &Args, terms: &[String]) -> Result<(), String> {
    let filter = filter_from(args, terms);
    if filter.is_empty() {
        return Err(
            "find needs at least one filter — try `--place nepal`, `--person putin`, `--circumstance disaster`, \
             or `bsc news entities` to see what is in the store"
                .into(),
        );
    }
    let store = open(args)?;
    let hits = engine::find(&store, &filter, now_secs() - args.since)?;
    bsc_cli_util::emit(args.pretty, args.json, &hits, || {
        if hits.is_empty() {
            return format!(
                "no articles match {} in the last {}s\ntry `bsc news entities` to see what IS in the store\n",
                engine::describe(&filter),
                args.since
            );
        }
        let mut s = format!("{} — {} article(s)\n\n", engine::describe(&filter), hits.len());
        for h in &hits {
            s.push_str(&format!("{:<12} {:<3} {}\n", h.outlet_id, h.bloc, h.title));
            if args.evidence {
                let why: Vec<String> =
                    h.matched.iter().map(|m| format!("{:?}:{}", m.kind, m.surface)).collect();
                s.push_str(&format!("             {}\n             {}\n", why.join(", "), h.url));
            }
        }
        s
    });
    Ok(())
}

fn cmd_entities(args: &Args) -> Result<(), String> {
    let kind = match args.kind.as_deref() {
        None => None,
        Some("person") | Some("people") => Some(crate::entities::Kind::Person),
        Some("place") | Some("places") => Some(crate::entities::Kind::Place),
        Some("circumstance") | Some("circumstances") => Some(crate::entities::Kind::Circumstance),
        Some(other) => return Err(format!("unknown kind '{other}' (expected person|place|circumstance)")),
    };
    let store = open(args)?;
    let rows: Vec<_> =
        engine::entity_index(&store, now_secs() - args.since, kind)?.into_iter().take(args.limit).collect();
    bsc_cli_util::emit(args.pretty, args.json, &rows, || {
        if rows.is_empty() {
            return "the store holds nothing in that window — run `bsc news poll` first\n".to_string();
        }
        let mut s = String::new();
        for r in &rows {
            let cue = if r.confirmed { " cue" } else { "" };
            s.push_str(&format!(
                "{:<14} {:<28} articles={:<4} outlets={}{}\n",
                format!("{:?}", r.kind).to_lowercase(),
                r.key,
                r.articles,
                r.outlets,
                cue
            ));
        }
        s
    });
    Ok(())
}

fn cmd_history(args: &Args, rest: &[String]) -> Result<(), String> {
    let url = rest.first().ok_or("history needs a url")?;
    let store = open(args)?;
    let versions = store.history(url)?;
    bsc_cli_util::emit(args.pretty, args.json, &versions, || {
        if versions.is_empty() {
            return format!("no stored versions for {url}\n");
        }
        let mut s = format!("{url}\n{} version(s)\n\n", versions.len());
        for v in &versions {
            s.push_str(&format!(
                "  v{}  first_seen={}  claimed={}\n      {}\n",
                v.seq,
                v.fetched_at,
                v.published_claim.as_deref().unwrap_or("-"),
                v.title
            ));
        }
        if versions.len() > 1 {
            s.push_str("\nThe text changed after publication; v1 holds the original wording.\n");
        }
        s
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(query: &str) -> engine::Filter {
        engine::Filter { query: query.into(), ..Default::default() }
    }

    #[test]
    fn help_lists_every_verb() {
        let ov = bsc_cli_util::help_overview("bsc news", TAGLINE, COMMANDS);
        for v in ["outlets", "poll", "brief", "history"] {
            assert!(ov.contains(v), "the overview must advertise {v}");
        }
    }

    #[test]
    fn each_command_has_a_usage_block() {
        for c in COMMANDS {
            let h = bsc_cli_util::help_for("bsc news", TAGLINE, COMMANDS, c.name);
            assert!(h.contains("USAGE:"), "{} needs a usage block", c.name);
        }
    }

    #[test]
    fn the_tagline_says_this_is_not_the_research_surface() {
        // The trust split is the crate's reason to exist, so it belongs where a session reads first.
        assert!(TAGLINE.contains("research"), "help must warn that news is not a citable source");
    }

    #[test]
    fn an_unknown_verb_is_refused_with_the_catalog() {
        let e = run(vec!["nope".into()], "bsc news").unwrap_err();
        assert!(e.contains("COMMANDS:"));
    }

    #[test]
    fn brief_without_a_query_refuses_rather_than_briefing_everything() {
        let e = run(vec!["brief".into(), "--db".into(), ":memory:".into()], "bsc news").unwrap_err();
        assert!(e.contains("needs a query"));
    }

    #[test]
    fn an_unknown_bloc_is_refused_by_name() {
        let e = run(vec!["outlets".into(), "--bloc".into(), "XX".into(), "--db".into(), ":memory:".into()], "bsc news")
            .unwrap_err();
        assert!(e.contains("XX"), "the refusal must name what was passed");
    }

    #[test]
    fn since_rejects_a_non_number() {
        let e = parse_args(vec!["brief".into(), "--since".into(), "yesterday".into()]).unwrap_err();
        assert!(e.contains("yesterday"));
    }

    #[test]
    fn a_brief_renders_the_cascade_as_text() {
        let store = Store::in_memory().unwrap();
        let wire = "Officials said two people were killed and eleven wounded when a missile hit the \
                    southern port early on Thursday, according to the emergency service.";
        let it = |u: &str, t: &str| crate::types::FeedItem {
            url: u.into(),
            title: t.into(),
            summary: wire.into(),
            published_claim: None,
        };
        store.record("ap", &it("ap/1", "Strike on port kills two"), 100).unwrap();
        store.record("bbc", &it("bbc/1", "Two killed in port strike"), 140).unwrap();
        let b = engine::brief(&store, &q("port"), 0).unwrap();
        let text = render_brief(&b, true);
        assert!(text.contains("1 independent source"), "the headline number is sources, not articles");
        assert!(text.contains("NOT 2 reports"), "and it says plainly what the raw count would have claimed");
        assert!(text.contains("↳ bbc"), "the echo is attributed to its origin");
        assert!(text.contains("shared:"), "--evidence quotes the reprinted run");
        assert!(text.contains("SILENT"), "outlets that ran nothing are named");
    }

    #[test]
    fn history_of_an_unknown_url_says_so_rather_than_printing_nothing() {
        let store = Store::in_memory().unwrap();
        let out = store.history("nope").unwrap();
        assert!(out.is_empty());
    }
}
