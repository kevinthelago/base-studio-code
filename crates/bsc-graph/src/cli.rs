//! `bsc graph` (#2761/#2853/#2961) — query AND curate the Algorithms knowledge library from a live
//! session. JSON out (compact by default; `--pretty` indents). The library is IMPL-ONLY (#2961): a node
//! IS its implementation — there is no abstract concept ontology. READ: `impl list` a language kit's
//! implementations, `dump` the whole store, `harvest`/`curate` a project's real code into candidates.
//! WRITE (#2853): `impl set`/`impl remove` curate the per-language kit tier (#2863) — implementations
//! carry a `role` (primitive | algorithm) and `compose` other same-tech impls. All persisted to the
//! on-disk store (`~/.base-studio-code/knowledge/algorithms.json`), so a read after a write reflects it.

use serde_json::Value;

/// The dispatcher's verb surface — MUST match the `match verb` arms in [`run`].
///
/// Exported so the packaged studio prose that TEACHES this CLI (the librarian spec,
/// `src-tauri/data/librarian/claude.md`) can be checked against the code rather than against a second
/// hand-written list (#3391). #2961 removed the concept ontology and its `list`/`neighbors`/`path`/
/// `link` verbs, but the spec kept teaching them and its test kept asserting them — spec and test
/// agreed with each other and both disagreed with the CLI. Deriving the expected surface from here
/// closes that loop: a verb renamed or removed drops out of this list, and the spec test fails on the
/// now-unknown verb its prose still names.
pub const VERBS: [&str; 8] = ["impl", "harvest", "curate", "dump", "doctor", "used-by", "merge", "help"];

/// The `impl` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
pub const IMPL_SUBVERBS: [&str; 3] = ["set", "remove", "list"];

/// Every flag [`run`] reads, across all verbs — MUST match the `flag_value` / `args.iter()` reads below.
pub const FLAGS: [&str; 17] = [
    "--pretty",
    "--all",
    "--id",
    "--tech",
    "--role",
    "--name",
    "--summary",
    "--ref",
    "--code",
    "--domain",
    "--tags",
    "--kind",
    "--viz-code",
    "--composes",
    "--worthy-only",
    "--apply",
    "--fix",
];

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let pretty = args.iter().any(|a| a == "--pretty");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let verb = positional.first().copied().unwrap_or("help");
    let emit = |v: &Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match verb {
        // `impl …` — read / curate the language-kit implementation tier (#2863/#2961/#2972/#3120):
        //   impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b]
        //     (algorithm: real --code; primitive: DESCRIBE a language built-in via --ref, e.g. std::vec::Vec — never re-coded, #2972)
        //   impl remove <id>                             # delete an implementation + scrub it from every composes
        //   impl list [--tech <t>] [--role r] [--domain <d>]  # a language kit's implementations, optionally a domain collection (#3120)
        "impl" => match positional.get(1).copied() {
            Some("set") => {
                let id = flag_value(&args, "--id").ok_or("usage: bsc graph impl set --tech <lang> --id <id> --role primitive|algorithm --name <name> [--code <code>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate]")?;
                let tech = flag_value(&args, "--tech").ok_or("usage: bsc graph impl set … --tech <language>")?;
                let role = flag_value(&args, "--role").ok_or("usage: bsc graph impl set … --role primitive|algorithm")?;
                let name = flag_value(&args, "--name").ok_or("usage: bsc graph impl set … --name <name>")?;
                let mut im = serde_json::json!({ "id": id, "tech": tech, "role": role, "name": name, "composes": list_flag(flag_value(&args, "--composes").as_deref()) });
                if let Some(s) = flag_value(&args, "--summary") { im["summary"] = Value::String(s); }
                // A primitive DESCRIBES a language built-in via `--ref` (std path), rather than re-coding it (#2972).
                if let Some(r) = flag_value(&args, "--ref") { im["ref"] = Value::String(r); }
                if let Some(code) = flag_value(&args, "--code") { im["code"] = Value::String(code); }
                // The domain facet (#3120) — additive: only written when supplied, so existing impls are untouched.
                if let Some(d) = flag_value(&args, "--domain") { im["domain"] = Value::String(d); }
                if let Some(t) = flag_value(&args, "--tags") { im["tags"] = list_flag(Some(t.as_str())); }
                // The kind facet (#3210) — the manipulation type that selects the live animation. Additive.
                if let Some(k) = flag_value(&args, "--kind") { im["kind"] = Value::String(k); }
                // The viz-code facet (#3218) — the algorithm's visualization as a JS trace-program. Additive.
                if let Some(v) = flag_value(&args, "--viz-code") { im["vizCode"] = Value::String(v); }
                let mut g = crate::load();
                let replaced = crate::set_impl(&mut g, im.clone())?;
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "action": if replaced { "updated" } else { "created" }, "impl": im }))
            }
            Some("remove") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl remove <id>")?;
                let mut g = crate::load();
                if crate::remove_impl(&mut g, id) {
                    crate::save(&g)?;
                    emit(&serde_json::json!({ "ok": true, "removed": id }))
                } else {
                    Err(format!("unknown implementation '{id}'"))
                }
            }
            Some("list") => {
                let tech = flag_value(&args, "--tech");
                let role = flag_value(&args, "--role");
                // The domain facet filter (#3120) — a cross-language domain collection ("all logistics algorithms").
                let domain = flag_value(&args, "--domain");
                let impls: Vec<Value> = crate::implementations()
                    .into_iter()
                    .filter(|im| tech.as_deref().is_none_or(|t| im.get("tech").and_then(Value::as_str) == Some(t)))
                    .filter(|im| role.as_deref().is_none_or(|r| im.get("role").and_then(Value::as_str) == Some(r)))
                    .filter(|im| domain.as_deref().is_none_or(|d| crate::impl_in_domain(im, d)))
                    .collect();
                emit(&Value::Array(impls))
            }
            _ => Err("usage: bsc graph impl set … | impl remove <id> | impl list [--tech <t>] [--role r] [--domain <d>]".to_string()),
        },
        // `harvest <dir> [--tech typescript|rust] [--worthy-only]` — the extract-to-harvest feeder
        // (#2745): parse a project's real code and lift each function into a CANDIDATE library
        // implementation (id/name/tech/role/composes/code), each CLASSIFIED library-worthy vs.
        // project-glue with a score + reasons (#2745 slice 2). `--worthy-only` keeps just the worthy
        // ones. Emits candidates ONLY — storing them into the library is the curation gate, never here.
        "harvest" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph harvest <dir> [--tech typescript|rust] [--worthy-only]")?;
            // #3475: a harvest hands back file CONTENTS, so it must honor the SAME boundary the
            // file tools do. `bsc-confine` only inspects Claude's file-tool payloads and is blind to
            // what this binary reads — without this, a confined studio session (the librarian is
            // limited to its own workspace) reads any path on disk through an allow-listed CLI.
            bsc_cli_util::require_harvestable_root(std::path::Path::new(dir))?;
            let tech = flag_value(&args, "--tech");
            let worthy_only = args.iter().any(|a| a == "--worthy-only");
            let candidates: Vec<Value> = crate::extract::harvest(std::path::Path::new(dir))
                .into_iter()
                .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                .filter(|c| !worthy_only || c.classification.worthy)
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "tech": c.tech,
                        "role": c.role,
                        "composes": c.composes,
                        "code": c.code,
                        // Provenance + facet (#4091) — a candidate you cannot trace to a file is not
                        // reviewable, and one with no domain is invisible once stored (#3607).
                        "src": c.src,
                        "domain": c.domain,
                        "worthy": c.classification.worthy,
                        "score": c.classification.score,
                        "reasons": c.classification.reasons,
                    })
                })
                .collect();
            emit(&serde_json::json!({ "candidates": candidates, "count": candidates.len() }))
        }
        // `curate <dir> [--tech t] [--apply]` — the curation + optimize gate (#2745 slice 3): harvest +
        // classify a project, keep only the WORTHY candidates, and plan each into the library — an `add`,
        // or an `optimize` when the store already holds that id (the harvested version replaces it).
        // `--apply` writes them to the runtime store (`impl set` semantics); without it, a dry-run plan.
        "curate" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph curate <dir> [--tech typescript|rust] [--apply]")?;
            // #3475: a harvest hands back file CONTENTS, so it must honor the SAME boundary the
            // file tools do. `bsc-confine` only inspects Claude's file-tool payloads and is blind to
            // what this binary reads — without this, a confined studio session (the librarian is
            // limited to its own workspace) reads any path on disk through an allow-listed CLI.
            bsc_cli_util::require_harvestable_root(std::path::Path::new(dir))?;
            let tech = flag_value(&args, "--tech");
            let apply = args.iter().any(|a| a == "--apply");
            let worthy: Vec<crate::extract::Candidate> =
                crate::extract::harvest(std::path::Path::new(dir))
                    .into_iter()
                    .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                    .filter(|c| c.classification.worthy)
                    .collect();
            let plan = crate::extract::curation_plan(&worthy, &crate::implementations());
            if apply {
                let mut g = crate::load();
                for item in &plan {
                    let c = &item.candidate;
                    // `domain` + `src` ride along (#4091). Without a domain the record does not
                    // surface in the graph UI at all (#3607), so a clean curate used to land work
                    // nobody could see; `src` is the provenance that makes a re-harvest dedupable
                    // and a record traceable to the file it came from.
                    let im = serde_json::json!({
                        "id": c.id, "tech": c.tech, "role": c.role, "name": c.name,
                        "composes": c.composes, "code": c.code,
                        "domain": c.domain, "src": c.src,
                    });
                    crate::set_impl(&mut g, im)?;
                }
                crate::save(&g)?;
            }
            let items: Vec<Value> = plan
                .iter()
                .map(|it| {
                    serde_json::json!({
                        "id": it.candidate.id,
                        "name": it.candidate.name,
                        "tech": it.candidate.tech,
                        "role": it.candidate.role,
                        "domain": it.candidate.domain,
                        "src": it.candidate.src,
                        "action": if it.replaces.is_some() { "optimize" } else { "add" },
                        "replaces": it.replaces,
                    })
                })
                .collect();
            emit(&serde_json::json!({ "applied": apply, "curated": items.len(), "plan": items }))
        }
        // `dump` — the whole graph document (the `implementations` tier), store-or-seed.
        "dump" => emit(&crate::load()),
        // `doctor [--fix]` (#3212) — diagnose the library's visualization typing + coverage: untyped /
        // invalid-kind / mistyped / missing-viz. `--fix` assigns the heuristic kind to UNTYPED-but-
        // classifiable impls (never overwriting an assigned kind), then re-diagnoses.
        "doctor" => {
            let fix = args.iter().any(|a| a == "--fix");
            let mut g = crate::load();
            if fix {
                let mut fixed = Vec::new();
                for im in crate::implementations_of(&g) {
                    if im.get("role").and_then(Value::as_str) != Some("algorithm") {
                        continue;
                    }
                    if im.get("kind").and_then(Value::as_str).is_none() {
                        if let Some(k) = crate::classify_kind(&im) {
                            let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                            let mut next = im.clone();
                            next["kind"] = Value::String(k.to_string());
                            crate::set_impl(&mut g, next)?;
                            fixed.push(serde_json::json!({ "id": id, "kind": k }));
                        }
                    }
                }
                if !fixed.is_empty() {
                    crate::save(&g)?;
                }
                let remaining = crate::doctor(&g);
                emit(&serde_json::json!({ "fixed": fixed, "remaining": remaining, "remaining_count": remaining.len() }))
            } else {
                let findings = crate::doctor(&g);
                emit(&serde_json::json!({ "findings": findings, "count": findings.len() }))
            }
        }
        // `used-by <id>` / `--all` (#3594) — the composes-inverse USAGE read (measure step of the optimize
        // loop; mirrors `bsc ui used-by`). A read.
        "used-by" => {
            let g = crate::load();
            let idx = crate::used_by_index(&g);
            if args.iter().any(|a| a == "--all") {
                let mut rows: Vec<Value> = crate::implementations_of(&g)
                    .iter()
                    .map(|im| {
                        let id = im.get("id").and_then(Value::as_str).unwrap_or("");
                        serde_json::json!({
                            "id": id,
                            "name": im.get("name").and_then(Value::as_str).unwrap_or(""),
                            "tech": im.get("tech").and_then(Value::as_str).unwrap_or(""),
                            "count": idx.get(id).map_or(0, Vec::len),
                        })
                    })
                    .collect();
                rows.sort_by(|a, b| {
                    b["count"].as_u64().cmp(&a["count"].as_u64()).then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
                });
                emit(&Value::Array(rows))
            } else {
                let id = positional.get(1).copied().ok_or("usage: bsc graph used-by <id>  |  bsc graph used-by --all")?;
                if !crate::implementations_of(&g).iter().any(|im| im.get("id").and_then(Value::as_str) == Some(id)) {
                    return Err(format!("unknown implementation '{id}'"));
                }
                let composers = idx.get(id).cloned().unwrap_or_default();
                emit(&serde_json::json!({ "id": id, "usedBy": composers, "count": composers.len() }))
            }
        }
        // `merge <from-id> <into-id>` (#3594) — the combine ACT (mirrors `bsc ui merge`): repoint every
        // impl's `composes` from→into, then remove `from`.
        "merge" => {
            let from = positional.get(1).copied().ok_or("usage: bsc graph merge <from-id> <into-id>")?;
            let into = positional.get(2).copied().ok_or("usage: bsc graph merge <from-id> <into-id> — the survivor id is required")?;
            let mut g = crate::load();
            let repointed = crate::merge_impls(&mut g, from, into)?;
            crate::save(&g)?;
            emit(&serde_json::json!({ "from": from, "into": into, "repointed": repointed, "removed": from }))
        }
        "help" | "-h" | "--help" => {
            print!("{}", help(prog));
            Ok(())
        }
        other => Err(format!("unknown graph command '{other}' — read: impl list | dump | harvest <dir> | curate <dir> | doctor | used-by; write: impl set | impl remove | merge\n\n{}", help(prog))),
    }
}

/// The value following a `--flag`, if present.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

/// Split a `--flag a,b,c` value into a JSON string array (empty when absent/blank) — for `--composes`
/// on `impl set` (#2863).
fn list_flag(s: Option<&str>) -> Value {
    Value::Array(
        s.unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(|x| Value::String(x.to_string()))
            .collect(),
    )
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the Algorithms knowledge library (#2761/#2853/#2961) — IMPL-ONLY (a node IS its implementation)\n\n\
         READ:\n  \
         {prog} impl list [--tech <t>] [--role r] [--domain <d>]   # a language kit's implementations (#2863); --domain filters to a cross-language collection (#3120)\n  \
         {prog} dump [--pretty]                         # the whole store document (the implementations tier)\n  \
         {prog} harvest <dir> [--tech T] [--worthy-only] [--pretty]   # harvest a project's functions into candidate library implementations, each classified worthy vs. glue (#2745)\n  \
         {prog} curate <dir> [--tech T] [--apply] [--pretty]          # curate a project's WORTHY candidates into the library — add/optimize; --apply writes the runtime store (#2745)\n  \
         {prog} doctor [--fix] [--pretty]               # diagnose viz typing + coverage: untyped / invalid-kind / mistyped / missing-viz; --fix assigns the inferred kind to untyped impls (#3212)\n  \
         {prog} used-by <id> [--pretty] | used-by --all [--pretty]   # the composes-INVERSE usage: which impls compose <id>, or every impl ranked by usage — the measure step before a merge (#3594)\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate] [--viz-code <js>]   # upsert a language-kit impl (#2863/#2972); --domain/--tags #3120, --kind #3210 animation type, --viz-code #3218 JS trace-program\n  \
         {prog} impl remove <id>                        # delete an implementation + scrub it from every composes\n  \
         {prog} merge <from-id> <into-id> [--pretty]    # fold a DUPLICATE into a survivor: repoint every impl's composes from→into (deduped), then remove `from` — the combine ACT (#3594)\n\n\
         Implementation roles (#2863): primitive (a LANGUAGE built-in — Vec, Iterator — DESCRIBED via `--ref`, not re-coded, #2972) · algorithm (real `--code` composing primitives up).\n\
         Implementation techs (#2770): typescript · rust — each `composes` other same-tech impls, rooted in the language's primitives.\n\
         The library is the per-language implementation tier; `harvest`/`curate` (#2745) mine a project's real code into candidate implementations.\n",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// [`VERBS`] is only trustworthy as a source of truth if it tracks the dispatcher, so pin it to
    /// the `match` (#3391): every listed verb must dispatch, and an unlisted one must be rejected.
    #[test]
    fn verbs_match_the_dispatcher() {
        for verb in VERBS {
            // `impl`/`harvest`/`curate` bail on their own usage error before touching the store;
            // `dump`/`doctor`/`help` read it. Either way, NONE may be an unknown-command rejection.
            let err = run(vec![verb.to_string()], "bsc graph").err().unwrap_or_default();
            assert!(
                !err.contains("unknown graph command"),
                "`{verb}` is in VERBS but the dispatcher rejects it: {err}",
            );
        }
        let err = run(vec!["neighbors".to_string()], "bsc graph").unwrap_err();
        assert!(
            err.contains("unknown graph command"),
            "a verb outside VERBS must be rejected — `neighbors` is one of the concept-ontology \
             verbs #2961 deleted; got: {err}",
        );
    }

    /// The help text is the CLI's own account of its surface, so every exported const must appear in
    /// it — a flag or subverb added to the `match` without reaching help (or this list) fails here.
    #[test]
    fn exported_surface_is_covered_by_the_help_text() {
        let help = help("bsc graph");
        for sub in IMPL_SUBVERBS {
            assert!(help.contains(&format!("impl {sub}")), "help omits `impl {sub}`");
        }
        for flag in FLAGS {
            assert!(help.contains(flag), "help omits `{flag}`");
        }
    }

    #[test]
    fn harvest_and_curate_refuse_a_target_outside_the_sessions_confinement_root() {
        // #3475, the algorithms twin: the librarian holds `bsc graph` (so `Bash(bsc graph *)` already
        // matches harvest) and is confined to its own workspace. The two harvests stay SEPARATE
        // implementations by design — only this boundary primitive is shared.
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").to_string_lossy().into_owned();
        let elsewhere = std::env::temp_dir().to_string_lossy().into_owned();
        for verb in ["harvest", "curate"] {
            let err = bsc_cli_util::with_repo_root(Some(&elsewhere), || {
                run(vec![verb.into(), fixtures.clone()], "bsc graph").unwrap_err()
            });
            assert!(err.contains("outside every root this session may harvest"), "{verb}: {err}");
        }
        // Unconfined (no root) stays unchanged — a direct CLI run is unaffected.
        assert!(bsc_cli_util::with_repo_root(None, || run(
            vec!["harvest".into(), fixtures],
            "bsc graph"
        ))
        .is_ok());
    }
}
