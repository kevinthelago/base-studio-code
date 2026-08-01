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
pub const VERBS: [&str; 11] =
    ["impl", "harvest", "curate", "dump", "doctor", "refolder", "relink", "tests", "used-by", "merge", "help"];

/// The `impl` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
pub const IMPL_SUBVERBS: [&str; 3] = ["set", "remove", "list"];

/// Every flag [`run`] reads, across all verbs — MUST match the `flag_value` / `args.iter()` reads below.
pub const FLAGS: [&str; 21] = [
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
    "--clear",
    "--tags",
    "--kind",
    "--viz-code",
    "--src",
    "--folder",
    "--composes",
    "--worthy-only",
    "--apply",
    "--fix",
    "--dry-run",
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
        //   impl get <id> | impl list [--tech <t>] [--role r] [--domain <d>]  # a language kit's implementations, optionally a domain collection (#3120)
        "impl" => match positional.get(1).copied() {
            Some("set") => {
                let id = flag_value(&args, "--id").ok_or("usage: bsc graph impl set --tech <lang> --id <id> --role primitive|algorithm --name <name> [--code <code>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate]")?;
                let tech = flag_value(&args, "--tech").ok_or("usage: bsc graph impl set … --tech <language>")?;
                let role = flag_value(&args, "--role").ok_or("usage: bsc graph impl set … --role primitive|algorithm")?;
                let name = flag_value(&args, "--name").ok_or("usage: bsc graph impl set … --name <name>")?;
                // #4154: `composes` is included ONLY when supplied. It used to default to `[]` on every
                // write, so a `--domain`-only edit blanked an impl's whole composes graph — the same
                // destructive-default class as the full-record overwrite `set_impl` no longer does.
                let mut im = serde_json::json!({ "id": id, "tech": tech, "role": role, "name": name });
                if let Some(c) = flag_value(&args, "--composes") {
                    im["composes"] = list_flag(Some(c.as_str()));
                }
                if let Some(s) = flag_value(&args, "--summary") { im["summary"] = Value::String(s); }
                // A primitive DESCRIBES a language built-in via `--ref` (std path), rather than re-coding it (#2972).
                if let Some(r) = flag_value(&args, "--ref") { im["ref"] = Value::String(r); }
                if let Some(code) = flag_value(&args, "--code") { im["code"] = Value::String(code); }
                // The domain facet (#3120) — additive: only written when supplied, so existing impls are untouched.
                if let Some(d) = flag_value(&args, "--domain") { im["domain"] = Value::String(d); }
                // #4107: settable directly, but normally DERIVED — pass `--src` and the folder follows,
                // so a hand-authored impl lands in the same tree a harvested one would.
                if let Some(sp) = flag_value(&args, "--src") {
                    if let Some(f) = bsc_util::folder_from_src(&sp) { im["folder"] = Value::String(f); }
                    im["src"] = Value::String(sp);
                }
                if let Some(f) = flag_value(&args, "--folder") { im["folder"] = Value::String(f); }
                // #4136: an ALGORITHM must declare its provenance, or explicitly declare it has none.
                //
                // The librarian curated 10 algorithms through this verb with no `--src`, so none could
                // sit in the folder tree the rail organizes by — it did exactly what its spec said, and
                // the CLI accepted a provenance-less record silently. Absence is now EXPLICIT: pass
                // `--src` (the folder derives from it), `--folder`, or `--no-src` for a canonical
                // algorithm that genuinely has no file in this repo. A PRIMITIVE is exempt by design —
                // it DESCRIBES a language built-in via `--ref` and is never re-coded (#2972).
                // #4154: with a merging write, a value can no longer be removed by omitting it — so
                // removal becomes EXPLICIT. `--clear a,b` drops those fields from the stored record.
                let cleared: Vec<String> = flag_value(&args, "--clear")
                    .map(|v| v.split(',').map(|f| f.trim().to_string()).filter(|f| !f.is_empty()).collect())
                    .unwrap_or_default();
                for f in &cleared {
                    im[f.as_str()] = Value::Null;
                }
                if !provenance_declared(&role, &im, args.iter().any(|a| a == "--no-src")) {
                    return Err(format!(
                        "impl set: algorithm '{id}' has no provenance — pass --src <path> (the folder                          derives from it), --folder <path>, or --no-src if it has no source in this repo.                          Without one it cannot be organized in the graph's folder tree (#4136)."
                    ));
                }
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
            // #4156 (designer request #47): read ONE impl by id. Without it, verifying a record before a
            // write meant dumping a whole language kit — 52.7KB for Rust — which overflows the shell,
            // gets truncated to a file OUTSIDE the session's confined FS roots, and so cannot be read
            // back at all. The designer skipped correcting several entries rather than write blind.
            Some("get") => {
                let id = positional.get(2).copied().ok_or("usage: bsc graph impl get <id>")?;
                match crate::implementations().into_iter().find(|im| im.get("id").and_then(Value::as_str) == Some(id)) {
                    Some(im) => emit(&im),
                    // `null` rather than an error: a miss is a normal answer to "does this exist?", and
                    // it keeps the output parseable by the same reader as a hit.
                    None => emit(&Value::Null),
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
            _ => Err("usage: bsc graph impl set … | impl remove <id> | impl get <id> | impl list [--tech <t>] [--role r] [--domain <d>]".to_string()),
        },
        // `harvest <dir> [--tech typescript|rust] [--worthy-only]` — the extract-to-harvest feeder
        // (#2745): parse a project's real code and lift each function into a CANDIDATE library
        // implementation (id/name/tech/role/composes/code), each CLASSIFIED library-worthy vs.
        // project-glue with a score + reasons (#2745 slice 2). `--worthy-only` keeps just the worthy
        // ones. Emits candidates ONLY — storing them into the library is the curation gate, never here.
        "harvest" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph harvest <dir-or-file> [--tech typescript|rust] [--worthy-only]")?;
            // #3475: a harvest hands back file CONTENTS, so it must honor the SAME boundary the
            // file tools do. `bsc-confine` only inspects Claude's file-tool payloads and is blind to
            // what this binary reads — without this, a confined studio session (the librarian is
            // limited to its own workspace) reads any path on disk through an allow-listed CLI.
            // `harvest help` asked for help, not for a directory named "help" — which the dir walk
            // dutifully found nothing in, printing an empty harvest as the answer to a help request.
            if *dir == "help" {
                print!("{}", help(prog));
                return Ok(());
            }
            let target = std::path::Path::new(dir);
            // A missing path must SAY so. Previously the dir walk's `read_dir` failed silently on
            // anything that was not a readable dir, so a typo and an empty tree were the same answer.
            if !target.exists() {
                return Err(format!("no such path: {dir}"));
            }
            bsc_cli_util::require_harvestable_root(target)?;
            let tech = flag_value(&args, "--tech");
            let worthy_only = args.iter().any(|a| a == "--worthy-only");
            // #4161: a FILE target harvests just that module — the route `bsc ui harvest <file>`
            // advertises. It used to fall into the dir walk and return a silent zero.
            let harvested = if target.is_file() {
                crate::extract::harvest_file(target)
            } else {
                crate::extract::harvest(target)
            };
            let candidates: Vec<Value> = harvested
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
                        // The COLOCATED test, carried at harvest time (#4126) — so a curate lands a
                        // node that already declares its tests, with no second pass.
                        "tests": c.tests.iter().map(|t| serde_json::json!({ "name": t.name, "src": t.src })).collect::<Vec<_>>(),
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
                    // `folder` (#4107) is derived from `src` by the SAME `bsc_util::folder_from_src`
                    // components use, so harvest is 1:1 — the library organizes exactly like the tree
                    // it came from. A candidate whose `src` yields no directory stays unfoldered rather
                    // than being bucketed under "".
                    let mut im = serde_json::json!({
                        "id": c.id, "tech": c.tech, "role": c.role, "name": c.name,
                        "composes": c.composes, "code": c.code,
                        "domain": c.domain, "src": c.src,
                        // #4126 — tests ride in with the curation, so `bsc graph tests harvest` is only
                        // ever needed for records curated before harvest carried them.
                        "tests": c.tests.iter().map(|t| serde_json::json!({ "name": t.name, "src": t.src })).collect::<Vec<_>>(),
                    });
                    if let Some(f) = bsc_util::folder_from_src(&c.src) {
                        im["folder"] = Value::String(f);
                    }
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
        // `refolder` (#4107) — re-derive every stored impl's `folder` from its `src`, mirroring
        // `bsc ui regroup`. The backfill for a library curated before the folder existed: `src` has
        // ridden along since #4091, so most records can be placed without a re-harvest. Idempotent —
        // `folder_from_src` is a fixed point on an already-clean path, so only records that actually
        // MOVED are rewritten, and a re-run reports zero.
        "refolder" => {
            let mut g = crate::load();
            let mut moved = Vec::new();
            let mut srcless = 0usize;
            for im in crate::implementations_of(&g) {
                let Some(src) = im.get("src").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                else {
                    // No provenance ⇒ nothing to derive from. Counted, not guessed at: inventing a
                    // folder here is exactly the curated-taxonomy step this deliberately defers.
                    srcless += 1;
                    continue;
                };
                let next_folder = bsc_util::folder_from_src(src);
                let cur = im.get("folder").and_then(Value::as_str);
                if cur == next_folder.as_deref() {
                    continue;
                }
                let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let mut next = im.clone();
                match &next_folder {
                    Some(f) => next["folder"] = Value::String(f.clone()),
                    None => {
                        next.as_object_mut().map(|o| o.remove("folder"));
                    }
                }
                crate::set_impl(&mut g, next)?;
                moved.push(serde_json::json!({ "id": id, "from": cur, "to": next_folder }));
            }
            if !moved.is_empty() {
                crate::save(&g)?;
            }
            emit(&serde_json::json!({ "moved": moved.len(), "srcless": srcless, "changes": moved }))
        }
        // `relink <dir>` (#4119) — recover `src` on impls curated before provenance existed, by matching
        // them against a fresh harvest of `<dir>`.
        //
        // This is the PREREQUISITE `refolder` is blocked on: `folder` derives from `src`, so an impl
        // without one is `srcless` and skipped, which is why a library curated before #4091 has no tree
        // at all rather than a stale one.
        //
        // AMBIGUITY IS NEVER GUESSED. A candidate id is `<kebab(name)>.<ext>`, and bare function names
        // collide freely across a real tree (`dismiss.ts`, `approve.ts`, `app.ts` all recur) — which is
        // exactly why the id cannot serve as identity and why `src` is needed in the first place. An id
        // matching more than one harvested file is reported and skipped; picking one would write a
        // provenance that is plausibly wrong, which is worse than none.
        //
        // Idempotent: an impl that already carries `src` is left alone, so a re-run reports zero.
        "relink" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph relink <dir> [--tech typescript|rust] [--dry-run] [--pretty]")?;
            let tech = flag_value(&args, "--tech");
            let dry = args.iter().any(|a| a == "--dry-run");

            // id -> the distinct srcs harvested under it. More than one ⇒ ambiguous.
            let mut by_id: std::collections::BTreeMap<String, std::collections::BTreeSet<String>> =
                std::collections::BTreeMap::new();
            for c in crate::extract::harvest(std::path::Path::new(dir)) {
                if tech.as_deref().is_some_and(|t| c.tech != t) {
                    continue;
                }
                if !c.src.trim().is_empty() {
                    by_id.entry(c.id).or_default().insert(c.src);
                }
            }

            let mut g = crate::load();
            let stored = crate::implementations_of(&g);
            let plan = crate::extract::relink_plan(&stored, &by_id);

            let by_stored_id: std::collections::BTreeMap<&str, &Value> = stored
                .iter()
                .map(|im| (im.get("id").and_then(Value::as_str).unwrap_or(""), im))
                .collect();
            let (mut linked, mut ambiguous, mut unmatched, mut had_src) = (Vec::new(), Vec::new(), 0usize, 0usize);
            let mut primitives = 0usize;
            for outcome in &plan {
                match outcome {
                    crate::extract::RelinkOutcome::Primitive { .. } => primitives += 1,
                    crate::extract::RelinkOutcome::AlreadyLinked { .. } => had_src += 1,
                    crate::extract::RelinkOutcome::Unmatched { .. } => unmatched += 1,
                    crate::extract::RelinkOutcome::Ambiguous { id, candidates } => {
                        ambiguous.push(serde_json::json!({ "id": id, "candidates": candidates }));
                    }
                    crate::extract::RelinkOutcome::Link { id, src, folder } => {
                        if !dry {
                            let Some(im) = by_stored_id.get(id.as_str()) else { continue };
                            let mut next = (*im).clone();
                            next["src"] = Value::String(src.clone());
                            // Derive the folder in the same breath, through the SAME shared helper the
                            // component library uses — so recovering provenance places the record in one
                            // pass rather than needing a `refolder` chaser.
                            if let Some(f) = folder {
                                next["folder"] = Value::String(f.clone());
                            }
                            crate::set_impl(&mut g, next)?;
                        }
                        linked.push(serde_json::json!({ "id": id, "src": src, "folder": folder }));
                    }
                }
            }
            if !dry && !linked.is_empty() {
                crate::save(&g)?;
            }
            emit(&serde_json::json!({
                "dryRun": dry,
                "linked": linked.len(),
                "ambiguous": ambiguous.len(),
                "unmatched": unmatched,
                "alreadyLinked": had_src,
                // Counted separately, never as a miss: a primitive has no source BY DESIGN (#2972).
                "primitives": primitives,
                "changes": linked,
                "ambiguousIds": ambiguous,
            }))
        }
        // `tests harvest <dir>` (#4126) — carry each impl's COLOCATED test file onto its node, the
        // algorithms twin of `bsc ui tests harvest` (#3907), pairing through the SAME
        // `bsc_util::test_path_for` so the two libraries cannot drift.
        //
        // MIRROR, not source. The files stay authoritative, checked in, and RUNNING. The graph cannot
        // execute a test today, so making it the source would stake the suite on an executor that does
        // not exist — a node's `tests` entry is inert metadata until `verify` lands (#4124). This buys
        // doctor honesty and a queryable graph at zero risk to coverage.
        //
        // ONE ENTRY PER FILE, VERBATIM. A test file's meaning lives partly outside its `it()` blocks —
        // imports, `beforeEach`, local helpers. Splitting per-`it` would silently drop that. A file that
        // covers SEVERAL impls (this repo's `graphAlgos.test.ts` covers five) is carried onto each of
        // them: the coverage is real for every one, and per-impl attribution is not recoverable from the
        // file.
        //
        // TypeScript only. A Rust impl's tests are an inline `#[cfg(test)] mod tests`, not a sibling
        // file, so path-pairing would report every Rust impl untested — see `bsc_util::test_path_for`.
        "tests" => {
            if positional.get(1).copied() != Some("harvest") {
                return Err("usage: bsc graph tests harvest <dir> [--dry-run] [--pretty]".to_string());
            }
            let dir = positional
                .get(2)
                .ok_or("usage: bsc graph tests harvest <dir> [--dry-run] [--pretty]")?;
            let dry = args.iter().any(|a| a == "--dry-run");
            let root = std::path::Path::new(dir);
            if !root.is_dir() {
                return Err(format!("no such directory: {dir}"));
            }
            // A harvest hands back file CONTENTS, so it honours the same boundary the file tools do
            // (#3475) — `bsc-confine` is blind to what this binary reads.
            bsc_cli_util::require_harvestable_root(root)?;

            let mut g = crate::load();
            let (mut paired, mut no_src, mut no_test) = (Vec::new(), 0usize, 0usize);
            for im in crate::implementations_of(&g) {
                let Some(src) = im.get("src").and_then(Value::as_str).filter(|s| !s.trim().is_empty())
                else {
                    // No provenance ⇒ nothing to pair against. `relink` (#4119) is the fix, not a guess.
                    no_src += 1;
                    continue;
                };
                let Some(path) = bsc_util::test_path_for(root, src) else {
                    no_test += 1;
                    continue;
                };
                let Ok(contents) = std::fs::read_to_string(&path) else {
                    no_test += 1;
                    continue;
                };
                let id = im.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let name = bsc_util::test_display_name(&path, &contents);
                let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
                if !dry {
                    let mut next = im.clone();
                    next["tests"] = serde_json::json!([{ "name": name, "src": contents }]);
                    crate::set_impl(&mut g, next)?;
                }
                paired.push(serde_json::json!({ "id": id, "name": name, "test": rel }));
            }
            if !dry && !paired.is_empty() {
                crate::save(&g)?;
            }
            emit(&serde_json::json!({
                "dryRun": dry,
                "paired": paired.len(),
                "noSrc": no_src,
                "noColocatedTest": no_test,
                "changes": paired,
            }))
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
/// Has an `impl set` DECLARED where its code comes from (#4136)?
///
/// An `algorithm` must carry `src` (the folder derives from it), a `folder`, or an explicit `--no-src`
/// for a canonical algorithm with no file in this repo. Absence must be stated rather than defaulted:
/// the librarian curated 10 algorithms through this verb with none, so none could sit in the folder tree
/// the rail organizes by, and nothing surfaced the omission.
///
/// A `primitive` is exempt BY DESIGN — it DESCRIBES a language built-in via `--ref` and is never
/// re-coded (#2972), so it has no source to point at. Pure, so the rule is testable without touching the
/// store (which `run` would otherwise write for real).
fn provenance_declared(role: &str, im: &Value, no_src: bool) -> bool {
    role != "algorithm" || no_src || im.get("src").is_some() || im.get("folder").is_some()
}

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
         {prog} impl get <id> | impl list [--tech <t>] [--role r] [--domain <d>]   # a language kit's implementations (#2863); --domain filters to a cross-language collection (#3120)\n  \
         {prog} dump [--pretty]                         # the whole store document (the implementations tier)\n  \
         {prog} harvest <dir-or-file> [--tech T] [--worthy-only] [--pretty]   # harvest a project's functions into candidate library implementations, each classified worthy vs. glue (#2745); a FILE target harvests just that module (#4161)\n  \
         {prog} curate <dir> [--tech T] [--apply] [--pretty]          # curate a project's WORTHY candidates into the library — add/optimize; --apply writes the runtime store (#2745)\n  \
         {prog} refolder [--pretty]                       # re-derive every impl's FOLDER from its `src` — the backfill mirroring `bsc ui regroup` (#4107)
  \
         {prog} relink <dir> [--tech t] [--dry-run] [--pretty]   # recover `src` (and the folder it derives) by matching stored impls to a fresh harvest (#4119)
  \n         {prog} tests harvest <dir> [--dry-run] [--pretty]   # carry each impl's COLOCATED test file onto its node — the algorithms twin of `bsc ui tests harvest` (#4126)
  \n         {prog} doctor [--fix] [--pretty]             # diagnose viz typing + coverage: untyped / invalid-kind / mistyped / missing-viz; --fix assigns the inferred kind to untyped impls (#3212)\n  \
         {prog} used-by <id> [--pretty] | used-by --all [--pretty]   # the composes-INVERSE usage: which impls compose <id>, or every impl ranked by usage — the measure step before a merge (#3594)\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate] [--viz-code <js>] [--src <path>] [--folder <p>] [--clear a,b]   # upsert a language-kit impl (#4154: a MERGE — unsupplied fields are PRESERVED, not deleted; --clear removes a field explicitly) (#2863/#2972); --domain/--tags #3120, --kind #3210 animation type, --viz-code #3218 JS trace-program, --src/--folder #4107 (a `--src` DERIVES the folder)\n  \
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
    fn impl_get_reads_one_record_and_answers_null_for_a_miss() {
        // #4156 / designer request #47: verifying a record before a write used to mean dumping a whole
        // language kit (52.7KB for Rust), which overflows the shell and lands in a file OUTSIDE the
        // session's confined roots — unreadable. The designer skipped corrections rather than write
        // blind, so a per-id read is what makes a safe edit possible at all.
        let seeded = crate::implementations();
        let known = seeded.first().and_then(|im| im.get("id").and_then(serde_json::Value::as_str));
        if let Some(id) = known {
            assert!(run(vec!["impl".into(), "get".into(), id.into()], "bsc graph").is_ok());
        }
        // A miss is a normal answer, not an error — `null` keeps it parseable by the same reader.
        assert!(run(vec!["impl".into(), "get".into(), "definitely-not-here.rs".into()], "bsc graph").is_ok());
        // A missing id is a usage error, since there is nothing to look up.
        assert!(run(vec!["impl".into(), "get".into()], "bsc graph").is_err());
    }

    #[test]
    fn impl_set_refuses_an_algorithm_with_no_provenance() {
        // #4136 — the librarian curated 10 algorithms through this verb with no `--src`, so none could
        // sit in the folder tree the rail organizes by. The CLI accepted them silently; now absence has
        // to be DECLARED. The error must name the fix, since the librarian reads it and retries.
        let base = |role: &str| vec![
            "impl".to_string(), "set".into(),
            "--tech".into(), "rust".into(),
            "--id".into(), "probe-4136.rs".into(),
            "--role".into(), role.into(),
            "--name".into(), "probe".into(),
            "--code".into(), "// x".into(),
        ];
        let err = run(base("algorithm"), "bsc graph").unwrap_err();
        assert!(err.contains("no provenance"), "{err}");
        assert!(err.contains("--src"), "names the flag to pass: {err}");
        assert!(err.contains("--no-src"), "names the explicit opt-out: {err}");
    }

    #[test]
    fn provenance_is_declared_by_src_folder_or_an_explicit_opt_out() {
        let bare = serde_json::json!({ "id": "x.rs" });
        let with_src = serde_json::json!({ "id": "x.rs", "src": "crates/x/src/lib.rs" });
        let with_folder = serde_json::json!({ "id": "x.rs", "folder": "crates/x/src" });

        // The refused shape — an algorithm with neither, and no opt-out.
        assert!(!provenance_declared("algorithm", &bare, false));
        // Each accepted shape, against the SAME record, so the rule is proven to turn on provenance
        // alone rather than on some other difference between the calls.
        assert!(provenance_declared("algorithm", &with_src, false));
        assert!(provenance_declared("algorithm", &with_folder, false));
        assert!(provenance_declared("algorithm", &bare, true)); // --no-src

        // A PRIMITIVE describes a built-in via `--ref` and has no source by design (#2972) — the gate
        // must never apply to it, or the whole primitive tier becomes unwritable.
        assert!(provenance_declared("primitive", &bare, false));
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
