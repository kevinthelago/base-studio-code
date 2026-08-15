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
pub const VERBS: [&str; 14] =
    ["impl", "edge", "test", "harvest", "curate", "dump", "doctor", "refolder", "relink", "tests", "used-by", "merge", "emit", "help"];

/// The `impl` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
pub const IMPL_SUBVERBS: [&str; 7] = ["set", "remove", "list", "suppress", "unsuppress", "history", "revert"];

/// The `edge` subverbs — MUST match the `match positional.get(1)` arms in [`run`].
pub const EDGE_SUBVERBS: [&str; 4] = ["set", "get", "list", "remove"];

/// The flags that take NO value. Needed by `reject_unknown_flags` to walk the argv correctly: a
/// value-taking flag consumes the next token, so `--summary "--x"` must not read as the flag `--x`.
pub const BOOL_FLAGS: [&str; 8] =
    ["--pretty", "--all", "--worthy-only", "--apply", "--fix", "--dry-run", "--no-src", "--run"];

/// Every flag [`run`] reads, across all verbs — MUST match the `flag_value` / `args.iter()` reads below.
pub const FLAGS: [&str; 34] = [
    "--pretty",
    // #71 — names WHAT replaced a suppressed algorithm, stored on the tombstone.
    "--superseded-by",
    // #72 — the revision `impl revert` restores to, and who to attribute the write to.
    "--to",
    "--by",
    // #72 — the WHY, recorded on the history entry alongside the who and the when.
    "--note",
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
    "--provides",
    "--module-state",
    "--reads",
    "--writes",
    "--module",
    "--composes",
    "--worthy-only",
    "--apply",
    "--fix",
    "--dry-run",
    "--no-src",
    "--members",
    "--out",
    "--run",
];

/// Materialize ONE record into `out` and, when `run`, execute its paired tests there.
///
/// Shared by `test <id>` and `test --all` so there is a single answer to "what does a record's
/// filesystem contain" — two materializers would drift the moment one learned something.
fn single_record_test(id: &str, out: &str, run: bool, g: &Value) -> Result<Value, String> {

            let id = &id;
            let out = out.to_string();
                        let im = crate::implementations_of(g)
                .into_iter()
                .find(|x| x.get("id").and_then(Value::as_str) == Some(*id))
                .ok_or_else(|| format!("no implementation '{id}'"))?;
            let tests = im.get("tests").and_then(Value::as_array).cloned().unwrap_or_default();
            if tests.is_empty() {
                // A vacuous pass is worse than a refusal: it would report "green" for a record nothing
                // checks, which is exactly the reading this whole tier exists to make impossible.
                return Err(format!(
                    "'{id}' has no paired test — nothing to run. An integration test lives on an edge                      (`bsc graph edge list`), not on the record."
                ));
            }
            let code = im.get("code").and_then(Value::as_str).unwrap_or_default();
            // The module's ORIGINAL basename, not the record id: the paired test imports it the way it
            // always did (`./usePlanGates`), and `use-plan-gates` would not resolve.
            let stem = im
                .get("src")
                .and_then(Value::as_str)
                .and_then(|p| p.rsplit('/').next())
                .map(|f| f.trim_end_matches(".tsx").trim_end_matches(".ts").to_string())
                .unwrap_or_else(|| id.to_string());
            let dir = std::path::Path::new(&out);
            std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {out}: {e}"))?;
            let module_file = dir.join(format!("{stem}.ts"));
            std::fs::write(&module_file, code).map_err(|e| format!("cannot write the module: {e}"))?;
            let mut written = vec![module_file.to_string_lossy().into_owned()];
            for (i, t) in tests.iter().enumerate() {
                let src = t.get("src").and_then(Value::as_str).unwrap_or_default();
                let name = if i == 0 { format!("{stem}.test.ts") } else { format!("{stem}.{i}.test.ts") };
                let p = dir.join(&name);
                std::fs::write(&p, src).map_err(|e| format!("cannot write {name}: {e}"))?;
                written.push(p.to_string_lossy().into_owned());
            }
            // The record's filesystem declares HOW it is tested. Without a config here, vitest walks UP
            // and finds the repo's — which pulls in `src/test/setup.ts` and every alias, so the run would
            // silently borrow the very context isolation is meant to withhold. (It fails loudly:
            // "Cannot find module .../src/test/setup.ts".)
            //
            // `environment` follows the test itself: a record that renders needs a DOM, one that computes
            // does not, and forcing jsdom on every record would make the run slower and less honest about
            // what the record actually requires.
            let needs_dom = tests.iter().any(|t| {
                t.get("src").and_then(Value::as_str).is_some_and(|src| src.contains("@testing-library"))
            });
            let env = if needs_dom { "jsdom" } else { "node" };
            std::fs::write(
                dir.join("vitest.config.ts"),
                format!(
                    "// Generated by `bsc graph test` — the record's own test contract.
                     // Present so vitest does NOT walk up and load the repo's config, which would lend
                     // this record the aliases and setup file that isolation exists to withhold.
                     import {{ defineConfig }} from \"vitest/config\";
                     export default defineConfig({{ test: {{ environment: \"{env}\", include: [\"*.test.ts\"] }} }});
"
                ),
            )
            .map_err(|e| format!("cannot write the test config: {e}"))?;
            written.push(dir.join("vitest.config.ts").to_string_lossy().into_owned());

            let mut result = serde_json::json!({
                "id": id, "dir": out, "written": written, "tests": tests.len(), "environment": env, "ran": false,
            });
            if run {
                // `npx vitest run` in the materialized dir. The dir has no config and no node_modules of
                // its own, so resolution walks UP — which is why the directory's location is the whole
                // isolation story, and why the sealed distro is the eventual home.
                // `.cmd` on Windows: `Command` resolves an exact filename and does not consult PATHEXT,
                // so a bare "npx" is simply "program not found" there.
                let npx = if cfg!(windows) { "npx.cmd" } else { "npx" };
                // `--root .` with no config in the directory is the ISOLATION: package imports resolve
                // (node walks up to a node_modules), while `@/…` app imports do NOT, because the alias
                // lives in the repo's vitest config and this run never loads it. A record whose test
                // reached sideways therefore FAILS here rather than passing on borrowed context — which
                // is the same contract the sealed image gives, reached by config absence instead of a
                // filesystem seal.
                let output = std::process::Command::new(npx)
                    .args(["vitest", "run", "--root", "."])
                    .current_dir(dir)
                    .output()
                    .map_err(|e| format!("cannot run vitest: {e}"))?;
                let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
                let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
                result["ran"] = Value::Bool(true);
                result["passed"] = Value::Bool(output.status.success());
                result["output"] = Value::String(if stdout.trim().is_empty() { stderr } else { stdout });
            }
            Ok(result)
        }

/// Every entity id in the GLOBAL data graph, for the surface-restriction check
/// (the-data-graph-a-global-third-pillar). Best-effort: an unreadable or absent store yields an EMPTY
/// list, which SKIPS the check rather than condemning every declaration — a machine that has never
/// written an entity must not be told all of its nodes are wrong.
fn entity_ids() -> Vec<String> {
    bsc_data::entity::open(None)
        .map(|s| bsc_data::entity::list(&s).into_iter().map(|e| e.id).collect())
        .unwrap_or_default()
}

/// A record's `src` reduced to the module it names, so two spellings of one path compare equal.
///
/// The store holds both conventions — `src/shared/ui/registry.tsx` and `app/console/lib/focusQueue.ts` —
/// because records arrived from different eras of the harvest, and Windows contributes backslashes on top.
/// Comparing the raw strings made the stem-collision guard fire on a record whose `src` is the SAME FILE,
/// which is the worst possible failure for a guard: it refused the honest case (re-harvesting a module
/// over its own stale record) while still catching nothing the normalization misses. Six modules were
/// blocked this way — `focusQueue`, `jumbleProbe`, `hashString`, `sort`, `selectionNeighborhood` — each
/// reported as "already names a DIFFERENT module" against itself.
fn same_module_path(src: &str) -> String {
    let unix = src.replace('\\', "/");
    let trimmed = unix.trim_start_matches("./");
    trimmed.strip_prefix("src/").unwrap_or(trimmed).to_string()
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    // Before anything reads a flag: an unknown one is an ERROR, never a silent no-op (#4154).
    reject_unknown_flags(&args)?;
    let pretty = args.iter().any(|a| a == "--pretty");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let verb = positional.first().copied().unwrap_or("help");
    let emit = |v: &Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match verb {
        // `test <id> --out <dir> [--run]` (run-a-records-paired-test-in-isolation) — materialize ONE
        // record into an empty directory and, optionally, run its paired tests there.
        //
        // Materializing exactly one record is what makes the run mean something: a suite that passes in
        // a directory containing only the record has PROVED the record is self-contained, which no run
        // inside the repo can prove — there, every import resolves whether the record declares it or not.
        "test" if args.iter().any(|a| a == "--all") => {
            // EVERY record carrying a paired test, each in its OWN directory. Sharing one would let a
            // record's test import a sibling record's file and pass on it — the cross-contamination the
            // single-record materializer exists to prevent.
            let out = flag_value(&args, "--out").ok_or("usage: bsc graph test --all --out <dir> [--run]")?;
            let run = args.iter().any(|a| a == "--run");
            let g = crate::load();
            let mut results = Vec::new();
            let (mut passed, mut failed, mut skipped) = (0usize, 0usize, 0usize);
            for im in crate::implementations_of(&g) {
                let Some(id) = im.get("id").and_then(Value::as_str) else { continue };
                if im.get("tests").and_then(Value::as_array).is_none_or(|t| t.is_empty()) {
                    // Counted, never hidden: a total that silently omits untested records reads as full
                    // coverage of a library most of which nothing checks.
                    skipped += 1;
                    continue;
                }
                let dir = std::path::Path::new(&out).join(id);
                // Reuse the single-record path rather than a second materializer — one implementation
                // of "what a record's filesystem contains" is the point.
                match single_record_test(id, &dir.to_string_lossy(), run, &g) {
                    Ok(v) => {
                        let ok = v.get("passed").and_then(Value::as_bool).unwrap_or(!run);
                        if run && !ok { failed += 1 } else { passed += 1 }
                        results.push(v);
                    }
                    Err(e) => {
                        failed += 1;
                        results.push(serde_json::json!({ "id": id, "error": e }));
                    }
                }
            }
            emit(&serde_json::json!({
                "records": results.len(), "passed": passed, "failed": failed,
                "skippedNoTest": skipped, "ran": run, "results": results,
            }))?;
            // A runner nothing can fail is not a gate.
            if failed > 0 {
                return Err(format!("{failed} record(s) failed their paired tests"));
            }
            Ok(())
        }
        "test" => {
            let id = positional.get(1).ok_or("usage: bsc graph test <id> --out <dir> [--run]")?;
            let out = flag_value(&args, "--out").ok_or("usage: bsc graph test <id> --out <dir> [--run]")?;
            let run = args.iter().any(|a| a == "--run");
            let g = crate::load();
            emit(&single_record_test(id, &out, run, &g)?)
        }
        // `edge …` (integration-tests-become-graph-edges) — the RELATIONSHIP tier. A test spanning two
        // records is evidence about the edge between them, not a property of either node, so it lives
        // here rather than being forced onto one of them or deleted.
        //   edge set --id <id> --members a,b [--src <test-file>]   # --src is READ, so a large test never
        //                                                          # has to fit through argv
        //   edge list | edge get <id> | edge remove <id>
        "edge" => match positional.get(1).copied() {
            Some("set") => {
                let id = flag_value(&args, "--id").ok_or("usage: bsc graph edge set --id <id> --members a,b [--src <test-file>]")?;
                let members = list_flag(flag_value(&args, "--members").as_deref());
                let mut e = serde_json::json!({ "id": id, "members": members });
                // The test source is READ from the file rather than passed: an integration test is
                // routinely larger than the argv limit, which is the same wall `impl set --code` hit.
                if let Some(p) = flag_value(&args, "--src") {
                    let path = std::path::Path::new(&p);
                    bsc_cli_util::require_harvestable_root(path)?;
                    let contents = std::fs::read_to_string(path).map_err(|err| format!("cannot read {p}: {err}"))?;
                    let name = bsc_util::test_display_name(path, &contents);
                    e["tests"] = serde_json::json!([{ "name": name, "src": contents }]);
                    e["src"] = Value::String(p.replace(crate::extract::BACKSLASH, "/"));
                }
                let mut g = crate::load();
                let updated = crate::set_edge(&mut g, e)?;
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "updated": updated }))
            }
            Some("remove") => {
                let id = positional.get(2).ok_or("usage: bsc graph edge remove <id>")?;
                let mut g = crate::load();
                let removed = crate::remove_edge(&mut g, id);
                crate::save(&g)?;
                emit(&serde_json::json!({ "removed": removed }))
            }
            Some("get") => {
                let id = positional.get(2).ok_or("usage: bsc graph edge get <id>")?;
                let g = crate::load();
                let found = crate::edges_of(&g).into_iter().find(|e| e.get("id").and_then(Value::as_str) == Some(*id));
                emit(&found.unwrap_or(Value::Null))
            }
            Some("list") | None => emit(&Value::Array(crate::edges_of(&crate::load()))),
            Some(other) => Err(format!("unknown edge subverb '{other}' — want one of: {}", EDGE_SUBVERBS.join(" | "))),
        },
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
                // The `@/…` specifier this impl SATISFIES — what a component's import matches on, the
                // same field the component store already carries. Additive like `--domain`: written only
                // when supplied, so no existing impl gains one by accident.
                if let Some(p) = flag_value(&args, "--provides") { im["provides"] = Value::String(p); }
                // The module's own STATE, comma-separated. A module harvest sets this itself, but an
                // impl written through THIS verb could not carry it at all — which stranded 27 of the
                // 58 stateful modules with no record of what they hold, precisely because a colliding
                // id forced them down the `impl set` path instead of `--apply`.
                //
                // SETS only. `im` is the MERGE payload (#4154), so dropping a key here means "leave it
                // alone", never "remove it" — clearing is what `--clear moduleState` is for, and having
                // two ways to clear one field is how they drift apart.
                // THE SURFACE RESTRICTION (the-data-graph-a-global-third-pillar). A node declares the
                // data-graph entities it is responsible for, and is held to it — the algorithm↔data
                // leg, which was the one edge of the three-pillar model with no mechanism at all.
                // Declared here rather than inferred, because the point is to BOUND a node's reach:
                // an inferred set can only ever describe what the code already does.
                for (flag, key) in [("--reads", "reads"), ("--writes", "writes")] {
                    if let Some(v) = flag_value(&args, flag) {
                        let names: Vec<Value> = v
                            .split(',')
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| Value::String(s.to_string()))
                            .collect();
                        if !names.is_empty() {
                            im[key] = Value::Array(names);
                        }
                    }
                }
                if let Some(ms) = flag_value(&args, "--module-state") {
                    let names: Vec<Value> = ms
                        .split(',')
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| Value::String(s.to_string()))
                        .collect();
                    if !names.is_empty() {
                        im["moduleState"] = Value::Array(names);
                    }
                }
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
                // Load BEFORE the gate (#4154): the check must see the STORED record. It used to inspect
                // only this write's flags, so editing a record that ALREADY had `src`/`folder` was
                // rejected unless the caller resupplied them — pushing every routine `--domain`/`--kind`
                // edit into restating provenance, which is the exact shape that caused the loss the
                // merge now prevents. It blocked 14 TypeScript + 3 fleet entries (designer request #52).
                let mut g = crate::load();
                let stored = crate::implementations_of(&g)
                    .into_iter()
                    .find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str()));
                if !provenance_declared(&role, &im, stored.as_ref(), args.iter().any(|a| a == "--no-src")) {
                    return Err(format!(
                        "impl set: algorithm '{id}' has no provenance — pass --src <path> (the folder                          derives from it), --folder <path>, or --no-src if it has no source in this repo.                          Without one it cannot be organized in the graph's folder tree (#4136)."
                    ));
                }
                if let Some(t) = flag_value(&args, "--tags") { im["tags"] = list_flag(Some(t.as_str())); }
                // The kind facet (#3210) — the manipulation type that selects the live animation. Additive.
                if let Some(k) = flag_value(&args, "--kind") { im["kind"] = Value::String(k); }
                // The viz-code facet (#3218) — the algorithm's visualization as a JS trace-program. Additive.
                if let Some(v) = flag_value(&args, "--viz-code") { im["vizCode"] = Value::String(v); }
                let replaced = crate::set_impl_by(&mut g, im.clone(), &bsc_record::resolve_writer(flag_value(&args, "--by").as_deref()), flag_value(&args, "--note").as_deref())?;
                crate::save(&g)?;
                // Report the STORED record, not the write payload (#4154). Echoing `im` showed only the
                // fields this call restated, so a `--domain`-only edit answered without `src`, `summary`
                // or `tests` — which reads as "they were deleted". That is what the merge fix was
                // measured against and judged still broken across three separate probes (request #52):
                // the data was intact the whole time and the ACK was lying about it.
                let saved = crate::implementations_of(&g)
                    .into_iter()
                    .find(|x| x.get("id").and_then(Value::as_str) == Some(id.as_str()))
                    .unwrap_or(im);
                emit(&serde_json::json!({ "ok": true, "action": if replaced { "updated" } else { "created" }, "impl": saved }))
            }
            Some("remove") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl remove <id>")?;
                // A SEEDED id cannot be removed — the seed reconcile re-adds it by design, so reporting
                // `removed` would be a lie the caller discovers on their next read (request #71). Refuse
                // and name the verb that does work, rather than succeeding at nothing.
                if crate::is_seeded(id) {
                    return Err(format!(
                        "'{id}' is a PACKAGED algorithm — a plain remove re-seeds on the next load. Use                          `bsc graph impl suppress {id}` to retire it durably (add `--superseded-by <new-id>`                          when something replaces it), or `impl unsuppress` to bring it back."
                    ));
                }
                let mut g = crate::load();
                if crate::remove_impl(&mut g, id) {
                    crate::save(&g)?;
                    emit(&serde_json::json!({ "ok": true, "removed": id }))
                } else {
                    Err(format!("unknown implementation '{id}'"))
                }
            }
            // #71 — RETIRE a packaged algorithm durably. Mirrors `bsc ui suppress` (#3725): a
            // `{ id, suppressed: true }` tombstone OCCUPIES the id, so the seed reconcile's absent-id
            // check finds it present and stops re-adding the packaged impl. `--superseded-by` records
            // what replaced it, on the tombstone because that is the one record the reconcile never
            // overwrites — a consolidation is otherwise unauditable a month later.
            // #72 — READ the write log. `impl set` stamps rev/by/at/changed through the same
            // `bsc-record` the component store uses, so this reads like `bsc ui log <id>` on purpose:
            // one vocabulary across both stores rather than two dialects a reader has to translate.
            Some("history") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl history <id>")?;
                let g = crate::load();
                let rec = crate::implementations_of(&g)
                    .into_iter()
                    .find(|im| im.get("id").and_then(Value::as_str) == Some(*id))
                    .ok_or_else(|| format!("unknown implementation '{id}'"))?;
                emit(&bsc_record::log_value(id, &rec))
            }
            // #72 — restore a previous `code`. REFUSES rather than landing on a nearer revision: the
            // rung is retained for only the most recent few source-moving writes, so a silent
            // approximation would hand back code the caller never asked for and call it a revert.
            Some("revert") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl revert <id> [--to <rev>]")?;
                let mut g = crate::load();
                let rec = crate::implementations_of(&g)
                    .into_iter()
                    .find(|im| im.get("id").and_then(Value::as_str) == Some(*id))
                    .ok_or_else(|| format!("unknown implementation '{id}'"))?;
                let revertible = bsc_record::revertible_revs(&rec);
                // Default: the revision immediately before this one — "undo the last write".
                let want = match flag_value(&args, "--to") {
                    Some(v) => v.parse::<i64>().map_err(|_| format!("--to: not a revision number: {v}"))?,
                    None => *revertible.last().ok_or_else(|| format!(
                        "'{id}' has no retained code to revert to — its history holds no source-moving write"
                    ))?,
                };
                let code = bsc_record::src_at_rev_of(&rec, want, "code").ok_or_else(|| format!(
                    "'{id}' cannot be reverted to rev {want} — that revision's code is not retained.                      Revertible: {}",
                    if revertible.is_empty() { "(none)".into() } else {
                        revertible.iter().map(i64::to_string).collect::<Vec<_>>().join(", ")
                    }
                ))?;
                let mut next = rec.clone();
                next["code"] = Value::String(code);
                let writer = bsc_record::resolve_writer(flag_value(&args, "--by").as_deref());
                crate::set_impl_by(&mut g, next, &writer, Some(&format!("revert to rev {want}")))?;
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "reverted": id, "to": want }))
            }
            Some("suppress") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl suppress <id> [--superseded-by <new-id>]")?;
                let mut g = crate::load();
                let live: Vec<Value> = crate::implementations_of(&g);
                let known = |x: &str| live.iter().any(|im| im.get("id").and_then(Value::as_str) == Some(x));
                if !known(id) && !crate::is_seeded(id) {
                    return Err(format!("unknown implementation '{id}'"));
                }
                let mut tomb = serde_json::json!({ "id": id, "suppressed": true });
                if let Some(new_id) = flag_value(&args, "--superseded-by") {
                    // REFUSED, not stored, on a dangling or self pointer — the tombstone is durable, so a
                    // pointer naming something nobody can open outlives everyone who could correct it.
                    if new_id == *id {
                        return Err(format!("'{id}' cannot supersede itself"));
                    }
                    if !known(&new_id) {
                        return Err(format!(
                            "--superseded-by '{new_id}' is not a live implementation — author it first, or omit the flag"
                        ));
                    }
                    tomb["supersededBy"] = Value::String(new_id);
                }
                crate::remove_impl(&mut g, id);
                crate::ensure_array(&mut g, "implementations").push(tomb.clone());
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "suppressed": id, "supersededBy": tomb.get("supersededBy") }))
            }
            Some("unsuppress") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl unsuppress <id>")?;
                let mut g = crate::load();
                let is_tomb = crate::raw_implementations_of(&g).iter().any(|im| {
                    im.get("id").and_then(Value::as_str) == Some(*id) && crate::is_tombstone(im)
                });
                // REFUSES on a live impl: a real record goes through `remove`, never this. Otherwise
                // `unsuppress` becomes a second, quieter delete.
                if !is_tomb {
                    return Err(format!("'{id}' is not a suppression tombstone — nothing to restore"));
                }
                crate::remove_impl(&mut g, id);
                let reseeded = crate::reconcile_seed(&mut g);
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "unsuppressed": id, "reseeded": reseeded }))
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
                .ok_or("usage: bsc graph harvest <dir-or-file> [--tech typescript|rust] [--worthy-only] [--module [--apply]]")?;
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
            // `--module` lifts the file as ONE module-shaped candidate instead of one per function —
            // the shape a runtime loader can vendor, and the only shape that can carry `provides`.
            // Directory targets keep the function granularity the reusable library is built on.
            let module_mode = args.iter().any(|a| a == "--module");
            let harvested = if module_mode {
                if !target.is_file() {
                    return Err("--module harvests ONE file; pass a file, not a directory".to_string());
                }
                let root = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
                crate::extract::harvest_module(target, &root).into_iter().collect()
            } else if target.is_file() {
                crate::extract::harvest_file(target)
            } else {
                crate::extract::harvest(target)
            };
            // `--apply` WRITES the harvest instead of only reporting it (harvest-module-can-persist).
            // Module mode only, and that is a guard rather than a limitation: a directory harvest would
            // write every function in the tree into the library as a side effect of asking what is there,
            // which is the curation decision `curate --apply` exists to make deliberately. One file, one
            // record, one specifier is the only shape where apply is unambiguous.
            //
            // It exists because `impl set --code <literal>` is the only other write path, and code on the
            // command line does not scale: two of the modules this migration lifts are 71 KB and 42 KB,
            // past the Windows `CreateProcess` argv limit, so they could not be written at all.
            let apply = args.iter().any(|a| a == "--apply");
            if apply && !module_mode {
                return Err(
                    "--apply writes ONE module as ONE record — pass --module with a file. \
                     A directory harvest would write every function it found; use `curate --apply` for that."
                        .to_string(),
                );
            }
            let picked: Vec<crate::extract::Candidate> = harvested
                .into_iter()
                .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                .filter(|c| !worthy_only || c.classification.worthy)
                .collect();
            if apply {
                let mut g = crate::load();
                // A module id is derived from the file STEM, so two `registry.tsx` in different
                // directories produce one id — and `impl set` is a MERGE by id, so the second harvest
                // silently REPLACED the first. One command, one record lost, no warning. Refuse the
                // write instead. A guard rather than a new id scheme on purpose: path-derived ids would
                // rename every module record already migrated and break the specifiers pointing at them.
                let existing = crate::implementations_of(&g);
                for c in &picked {
                    // AN ABSENT `src` IS NOT PROOF OF SAMENESS. This used to require a non-empty `src`
                    // before it would call anything a clash, so a CURATED library algorithm — which has
                    // no `src` by design (`--no-src`, #4136) — could never trigger it, and a module
                    // harvest merged straight over it. `sort.ts` was exactly that: the packaged
                    // insertion-sort generator, silently replaced by `viz/examples/sort.ts`, with the
                    // only symptom a duplicate id in the seed two steps later. Unknown provenance is a
                    // reason to REFUSE and make the author say which record they mean, not to proceed.
                    let clash = existing.iter().find(|im| {
                        im.get("id").and_then(Value::as_str) == Some(c.id.as_str())
                            && match im.get("src").and_then(Value::as_str) {
                                Some(s) if !s.is_empty() => {
                                    same_module_path(s) != same_module_path(&c.src)
                                }
                                _ => true, // no provenance: cannot prove it is the same module
                            }
                    });
                    if let Some(im) = clash {
                        let other = match im.get("src").and_then(Value::as_str) {
                            Some(s) if !s.is_empty() => s,
                            _ => "a record with NO src (a curated algorithm, or provenance never recorded)",
                        };
                        return Err(format!(
                            "'{}' already names a DIFFERENT module: {other}\n\
                             This harvest would overwrite it, because a module id comes from the file \
                             stem and `impl set` merges by id.\n\
                             Rename one of the files, or write the record deliberately with \
                             `bsc graph impl set --id <a-distinct-id>`.",
                            c.id
                        ));
                    }
                }
                for c in &picked {
                    // The same field set `curate --apply` writes — `domain` (invisible without it,
                    // #3607), `src` provenance (#4091), the `folder` derived from it (#4107), and the
                    // colocated tests (#4126) — PLUS `provides`, which is the whole point here: a module
                    // record the loader cannot match by specifier is a record nothing resolves through.
                    let mut im = serde_json::json!({
                        "id": c.id, "tech": c.tech, "role": c.role, "name": c.name,
                        "composes": c.composes, "code": c.code,
                        "domain": c.domain, "src": c.src,
                    });
                    // Only when NON-EMPTY. `tests: []` is not "no tests recorded" — it is a key the
                    // additive contract omits, so writing it made every migrated record fail the seed
                    // round-trip against its own typed model.
                    if !c.tests.is_empty() {
                        im["tests"] = Value::Array(
                            c.tests.iter().map(|t| serde_json::json!({ "name": t.name, "src": t.src })).collect(),
                        );
                    }
                    if let Some(f) = bsc_util::folder_from_src(&c.src) {
                        im["folder"] = Value::String(f);
                    }
                    // The module's own STATE, named on the record. Only when NON-EMPTY, like
                    // `tests`: the additive contract omits an absent key rather than writing one.
                    if !c.module_state.is_empty() {
                        im["moduleState"] = Value::Array(
                            c.module_state.iter().map(|n| Value::String(n.clone())).collect(),
                        );
                    }
                    // Set only when present. `impl set` is a MERGE (#4154), so writing an explicit null
                    // would CLEAR a specifier a previous run established rather than leaving it alone.
                    if let Some(p) = &c.provides {
                        im["provides"] = Value::String(p.clone());
                    }
                    crate::set_impl(&mut g, im)?;
                    // ROUTE THE INTEGRATION TEST (edges-fill-themselves-at-retirement). A colocated test
                    // that reaches other modules is not paired onto the node — but it must not be left
                    // behind either, because the file it lives in goes when the module retires. It
                    // becomes an EDGE: this record plus the specifiers it reaches.
                    //
                    // Those specifiers are usually still FILES at this moment, which is why a member may
                    // be a specifier rather than a record id — `doctor` reports them as PENDING and they
                    // resolve as the migration reaches them.
                    if let Some(t) = &c.edge_test {
                        let mut members = vec![Value::String(c.id.clone())];
                        members.extend(c.edge_members.iter().map(|m| Value::String(m.clone())));
                        crate::set_edge(
                            &mut g,
                            serde_json::json!({
                                // Keyed on the module, so a re-harvest UPDATES this edge rather than
                                // adding a second one for the same test file.
                                "id": format!("{}~integration", c.id),
                                "members": members,
                                // The TEST's path, not the module's — the edge is about the test.
                                "src": c.edge_src,
                                "tests": [{ "name": t.name, "src": t.src }],
                            }),
                        )?;
                    }
                }
                crate::save(&g)?;
            }
            let candidates: Vec<Value> = picked
                .iter()
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
                        // Present only under `--module`: the specifier a component's import matches on.
                        // Omitted entirely at function granularity, where it would always be null and
                        // would read as "this impl has no specifier yet" rather than "cannot have one".
                        "provides": c.provides,
                        // The integration test routed to an edge, if any — visible in a dry harvest so
                        // the routing can be inspected before it is applied.
                        "edgeMembers": c.edge_members,
                        // The module's own STATE. `--apply` already stored this, but the printed
                        // candidate omitted it — so a DRY harvest could not show the one property that
                        // decides whether vendoring the record equals importing the module, and any
                        // script reading the output saw a stateful module as stateless.
                        "moduleState": c.module_state,
                    })
                })
                .collect();
            emit(&serde_json::json!({ "applied": apply, "candidates": candidates, "count": candidates.len() }))
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
                let remaining = crate::doctor_with_entities(&g, &entity_ids());
                emit(&serde_json::json!({ "fixed": fixed, "remaining": remaining, "remaining_count": remaining.len() }))
            } else {
                let findings = crate::doctor_with_entities(&g, &entity_ids());
                // EDGE COVERAGE (integration-tests-become-graph-edges). `composes` says A builds on B;
                // an edge says someone CHECKED. Reporting the gap makes coverage a property of the
                // graph rather than of a file tree — the first question the node tier could never ask.
                let (missing_edges, dangling_edges, pending_edges) = crate::edge_findings(&g);
                emit(&serde_json::json!({
                    "findings": findings,
                    "count": findings.len(),
                    "missingEdges": missing_edges,
                    "missingEdgeCount": missing_edges.len(),
                    // Separate, and worse: a MISSING edge is honestly empty, a DANGLING one reads as
                    // covered while naming a record that is gone.
                    "danglingEdges": dangling_edges,
                    // PENDING is not a defect: an edge written at retirement names collaborators that
                    // are still files, and they resolve as the migration reaches them.
                    "pendingEdges": pending_edges,
                }))
            }
        }
        // `emit` (#4192) — the store→FILE direction, the twin of `bsc ui emit`. The graph is the source
        // of truth and a file is the artifact, so maintenance edits the record then re-emits.
        "emit" => {
            let sub = positional.get(1).copied();
            match sub {
                Some("impl") => {
                    let id = positional.get(2).ok_or("usage: bsc graph emit impl <id> <dir>")?;
                    let dir = positional.get(3).ok_or("usage: bsc graph emit impl <id> <dir>")?;
                    let plan = crate::emit::plan_one(&crate::load(), id)?;
                    write_emit_plan(&plan, dir, emit)
                }
                Some("all") => {
                    let dir = positional.get(2).ok_or("usage: bsc graph emit all <dir>")?;
                    let plan = crate::emit::plan_all(&crate::load());
                    write_emit_plan(&plan, dir, emit)
                }
                Some("sync") => {
                    let dir = positional.get(2).ok_or("usage: bsc graph emit sync <dir>")?;
                    emit_sync(dir, emit)
                }
                Some("help") | None => {
                    print!("{}", help(prog));
                    Ok(())
                }
                Some(other) => Err(format!(
                    "unknown emit command '{other}' — want: impl <id> <dir> | all <dir> | sync <dir>"
                )),
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
/// Will the record carry provenance AFTER this write lands (#4136, corrected #4154)?
///
/// Considers the STORED record, not just the flags — the gate used to see only `im`, so a routine
/// `--domain` edit on a record that already had `src` was refused unless provenance was restated.
///
/// A `--clear`ed field arrives as JSON `null`, which counts as ABSENT: clearing an algorithm's only
/// provenance must FAIL the gate, not satisfy it by virtue of the key being present.
fn provenance_declared(role: &str, im: &Value, stored: Option<&Value>, no_src: bool) -> bool {
    if role != "algorithm" || no_src {
        return true; // a primitive DESCRIBES a built-in via `--ref` (#2972); `--no-src` is the explicit none
    }
    ["src", "folder"].iter().any(|k| match im.get(*k) {
        Some(Value::Null) => false,                                   // explicitly cleared by this write
        Some(_) => true,                                              // supplied by this write
        None => stored.and_then(|s| s.get(*k)).is_some_and(|v| !v.is_null()), // already on the record
    })
}

/// Refuse an unknown `--flag` instead of ignoring it (#4154, designer request #52).
///
/// The designer passed `--tests <content>` — a flag this CLI has never had — got NO error, then read the
/// record back and found no `tests` field. The reasonable conclusion was "the write dropped it", and that
/// reading is what kept a fixed merge looking broken across three probes. Silence is the bug: a flag that
/// does nothing must say so, because the alternative is the caller inferring a data-loss bug from it.
///
/// Walks the argv rather than scanning for `--`, so a VALUE that happens to start with `--`
/// (`--summary "--foo"`) is not mistaken for a flag.
fn reject_unknown_flags(args: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if let Some(stripped) = a.strip_prefix("--") {
            if !FLAGS.contains(&a.as_str()) {
                let near: Vec<&str> = FLAGS
                    .iter()
                    .copied()
                    .filter(|f| f.contains(stripped) || stripped.contains(f.trim_start_matches("--")))
                    .collect();
                return Err(format!(
                    "unknown flag '{a}'{}

run `bsc graph help` for the flags this CLI reads.",
                    if near.is_empty() { String::new() } else { format!(" — did you mean {}?", near.join(" | ")) },
                ));
            }
            // A value-taking flag consumes the next token, which must not be re-read as a flag.
            if !BOOL_FLAGS.contains(&a.as_str()) {
                i += 1;
            }
        }
        i += 1;
    }
    Ok(())
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
         {prog} harvest <dir-or-file> [--tech T] [--worthy-only] [--module] [--pretty]   # harvest a project's functions into candidate library implementations, each classified worthy vs. glue (#2745); a FILE target harvests just that module (#4161); --module lifts a FILE as ONE module-shaped candidate carrying the `provides` specifier, for making a logic module a record rather than a library function; --apply (module mode only) WRITES that candidate to the store, the only path for a module too large to pass as `impl set --code`\n  \
         {prog} curate <dir> [--tech T] [--apply] [--pretty]          # curate a project's WORTHY candidates into the library — add/optimize; --apply writes the runtime store (#2745)\n  \
         {prog} test <id> --out <dir> [--run] | test --all --out <dir> [--run]   # materialize ONE record + its paired tests into an EMPTY dir and optionally run them there — a pass in a directory holding only the record proves it is self-contained (run-a-records-paired-test-in-isolation)
  \n  {prog} edge set --id <id> --members a,b [--src <test-file>] | edge list | edge get <id> | edge remove <id>   # the RELATIONSHIP tier (integration-tests-become-graph-edges): a test spanning two records is evidence about the EDGE between them, not a property of either node; --src is READ from disk so a large test never has to fit through argv
    {prog} refolder [--pretty]                       # re-derive every impl's FOLDER from its `src` — the backfill mirroring `bsc ui regroup` (#4107)
  \
         {prog} relink <dir> [--tech t] [--dry-run] [--pretty]   # recover `src` (and the folder it derives) by matching stored impls to a fresh harvest (#4119)
  \n         {prog} tests harvest <dir> [--dry-run] [--pretty]   # carry each impl's COLOCATED test file onto its node — the algorithms twin of `bsc ui tests harvest` (#4126)
  \n         {prog} doctor [--fix] [--pretty]             # diagnose viz typing + coverage: untyped / invalid-kind / mistyped / missing-viz; --fix assigns the inferred kind to untyped impls (#3212)\n  \
         {prog} used-by <id> [--pretty] | used-by --all [--pretty]   # the composes-INVERSE usage: which impls compose <id>, or every impl ranked by usage — the measure step before a merge (#3594)\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> [--code <c>] [--ref <std-path>] [--composes a,b] [--summary <s>] [--domain <d>] [--tags a,b] [--kind sort|search|traversal|accumulate] [--viz-code <js>] [--src <path>] [--folder <p>] [--provides <spec>] [--module-state a,b] [--reads e1,e2] [--writes e3] [--no-src] [--clear a,b] [--by <who>] [--note <why>]   # upsert a language-kit impl (#4154: a MERGE — unsupplied fields are PRESERVED, not deleted; --clear removes a field explicitly; --no-src declares an algorithm that genuinely has no file here, #4136) (#2863/#2972); --domain/--tags #3120, --kind #3210 animation type, --viz-code #3218 JS trace-program, --src/--folder #4107 (a `--src` DERIVES the folder), --module-state names the module's top-level MUTABLE bindings (sets only; --clear moduleState removes)\n  \
         {prog} impl remove <id>                        # delete a USER-MADE implementation + scrub it from every composes (a PACKAGED one is refused - it re-seeds; use `suppress`)
  \
         {prog} impl suppress <id> [--superseded-by <new-id>]   # RETIRE a packaged algorithm durably (#71): a `{{ id, suppressed: true }}` TOMBSTONE occupies the id so the seed reconcile stops re-adding it; --superseded-by records WHAT replaced it, on the tombstone because that is the one record the reconcile never overwrites (a self / missing / already-retired target is REFUSED, not stored)
  \
         {prog} impl unsuppress <id>                    # drop the tombstone so the packaged algorithm re-seeds on the next load (no data loss). REFUSES on a live impl - that goes through `remove`
         {prog} impl history <id>                       # the write log (#72): rev, who, when, what CHANGED and what was DROPPED per write — the same shape as `bsc ui log`, from the same shared stamp
  \
         {prog} impl revert <id> [--to <rev>] [--by <who>]   # restore a previous `code`. Defaults to undoing the last source-moving write; REFUSES rather than landing on a nearer revision when the target has aged past the retained rungs, and names which revisions are still reachable
  \
  \
         {prog} emit impl <id> <dir> | emit all <dir> | emit sync <dir>   # the store→FILE direction (#4192): write a record's code as stamped source; `sync` re-emits MANAGED files and skips hand-edited ones. One record = one file — NEVER written over the shared `src` it was lifted from
           {prog} merge <from-id> <into-id> [--pretty]    # fold a DUPLICATE into a survivor: repoint every impl's composes from→into (deduped), then remove `from` — the combine ACT (#3594)\n\n\
         Implementation roles (#2863): primitive (a LANGUAGE built-in — Vec, Iterator — DESCRIBED via `--ref`, not re-coded, #2972) · algorithm (real `--code` composing primitives up).\n\
         Implementation techs (#2770): ANY language — `--tech` is not validated and never has been. Each impl `composes` other same-tech impls, rooted in that language's primitives, so a new tech simply starts its own kit (`--tech python` works today; the packaged kits are typescript · rust).\n\
         WHAT IS language-bound is the MINING half: `harvest`/`curate`/`relink` parse real source with tree-sitter and only carry grammars for ts/tsx/rs. Curating code you already have has no such limit — a session that could not harvest a Python project once concluded it could not curate one either, and left 12 real algorithms unstored rather than try (#53).\n\
         The library is the per-language implementation tier; `harvest`/`curate` (#2745) mine a project's real code into candidate implementations.\n",
    )
}

/// Write every planned file under `dir` and report what was written AND what was declined (#4192).
///
/// The skips are reported, not swallowed: a run that emitted 29 of 105 records and said only "29 emitted"
/// reads as success, when the interesting half is WHY the other 76 were left (a primitive, no provenance,
/// no code). Each carries its reason.
fn write_emit_plan(
    plan: &crate::emit::EmitPlan,
    dir: &str,
    emit: impl Fn(&Value) -> Result<(), String>,
) -> Result<(), String> {
    let root = std::path::Path::new(dir);
    for f in &plan.files {
        let out = root.join(&f.path);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
        }
        std::fs::write(&out, &f.content).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
    }
    emit(&serde_json::json!({
        "emitted": plan.files.len(),
        "dir": dir,
        "files": plan.files.iter().map(|f| f.path.clone()).collect::<Vec<_>>(),
        "skipped": plan.skipped.iter()
            .map(|s| serde_json::json!({ "id": s.id, "reason": s.reason }))
            .collect::<Vec<_>>(),
    }))
}

/// `bsc graph emit sync <dir>` — re-emit MANAGED files whose record moved; skip hand-edited ones.
///
/// The same contract (and, since #4192, the same shared classifier) as `bsc ui emit sync`: a file whose
/// body still matches its stamp is ours to upgrade; one that does not was edited by a human and is
/// reported rather than clobbered.
fn emit_sync(dir: &str, emit: impl Fn(&Value) -> Result<(), String>) -> Result<(), String> {
    use bsc_cli_util::vendored::SyncVerdict;
    let plan = crate::emit::plan_all(&crate::load());
    let root = std::path::Path::new(dir);
    let mut files: Vec<(String, String)> = Vec::new();
    collect_emitted_files(root, root, &mut files)?;
    let (mut synced, mut up_to_date, mut diverged, mut unknown) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (rel, content) in &files {
        match crate::emit::classify_file(&plan, rel, content) {
            SyncVerdict::NotVendored => {}
            SyncVerdict::UpToDate => up_to_date.push(rel.clone()),
            SyncVerdict::Diverged => diverged.push(rel.clone()),
            SyncVerdict::Unknown => unknown.push(rel.clone()),
            SyncVerdict::Rewrite(fresh) => {
                let out = root.join(rel);
                std::fs::write(&out, &fresh).map_err(|e| format!("cannot write {}: {e}", out.display()))?;
                synced.push(rel.clone());
            }
        }
    }
    emit(&serde_json::json!({
        "dir": dir, "synced": synced, "upToDate": up_to_date, "diverged": diverged, "unknown": unknown,
    }))
}

/// Collect every file under `dir` as `(dir-relative POSIX path, content)`. Unreadable (binary) files are
/// skipped — a stamp is a UTF-8 line comment, so a file we cannot read as text was never ours.
fn collect_emitted_files(
    root: &std::path::Path,
    dir: &std::path::Path,
    out: &mut Vec<(String, String)>,
) -> Result<(), String> {
    let Ok(entries) = std::fs::read_dir(dir) else { return Ok(()) };
    let mut paths: Vec<std::path::PathBuf> = entries.filter_map(|e| e.ok()).map(|e| e.path()).collect();
    paths.sort(); // order-stable output, so a sync report diffs cleanly run to run
    for path in paths {
        if path.is_dir() {
            collect_emitted_files(root, &path, out)?;
        } else if let Ok(content) = std::fs::read_to_string(&path) {
            let rel = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace('\\', "/");
            out.push((rel, content));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    /// The help is the thing that misled, so it is the thing under test: it must NOT present the
    /// packaged kits as the accepted set, and must still say which half is grammar-bound.
    ///
    /// The BEHAVIOUR (any `--tech` is accepted) is deliberately NOT tested here. It would need a
    /// second `BSC_GRAPH_STORE` mutator, and that env var is process-global while Rust tests run in
    /// parallel — adding one made `the_packaged_seed_carries_domain_collections` fail, an unrelated
    /// test reading the packaged seed through the store this one had redirected. The existing
    /// store-backed test gets away with it only by being the sole mutator. Verified instead by
    /// running the real CLI against a throwaway store (see the change record); pinning it properly
    /// needs the store to take a path rather than an env var.
    #[test]
    fn the_help_does_not_claim_tech_is_limited_to_the_packaged_kits() {
        let h = help("bsc graph");
        assert!(h.contains("ANY language"), "curation must be described as open: {h:.0}");
        assert!(h.contains("harvest"), "the grammar-bound half must still be named");
    }

    /// `impl set` must be able to WRITE the module state, not only a harvest. 27 of the 58 stateful
    /// modules took this path (a colliding id forced them off `--apply`) and landed with no record of
    /// what they hold — the field existed and nothing could set it.
    #[test]
    fn impl_set_writes_and_clears_module_state() {
        let dir = std::env::temp_dir().join(format!("bsc-graph-msflag-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = dir.join("algorithms.json");
        // SAFETY: single-threaded test setup, before any other thread reads the env.
        unsafe { std::env::set_var("BSC_GRAPH_STORE", &store) };

        let set = |extra: Vec<&str>| {
            let mut a: Vec<String> = ["impl", "set", "--tech", "typescript", "--id", "s.ts", "--role",
                                      "algorithm", "--name", "S", "--code", "export const s = 1;",
                                      "--src", "src/x/s.ts"]
                .iter().map(|s| s.to_string()).collect();
            a.extend(extra.into_iter().map(str::to_string));
            run(a, "bsc graph").unwrap();
        };
        let state_of = || {
            crate::implementations()
                .into_iter()
                .find(|i| i.get("id").and_then(Value::as_str) == Some("s.ts"))
                .and_then(|i| i.get("moduleState").cloned())
        };

        set(vec!["--module-state", "seq, pending"]);
        assert_eq!(state_of(), Some(serde_json::json!(["seq", "pending"])), "writes the bindings");

        // A MERGE leaves it alone when unsupplied (#4154) — otherwise every later edit would wipe it.
        set(vec!["--summary", "unchanged"]);
        assert_eq!(state_of(), Some(serde_json::json!(["seq", "pending"])), "preserved when not supplied");

        // …and CLEARING is `--clear`'s job, not an empty value's. `im` is the merge payload, so an
        // absent key means "leave it alone" — two ways to clear one field is how they drift apart.
        set(vec!["--clear", "moduleState"]);
        assert_eq!(state_of(), None, "--clear moduleState removes it");

        unsafe { std::env::remove_var("BSC_GRAPH_STORE") };
        let _ = std::fs::remove_dir_all(&dir);
    }

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

        // `None` for the stored record throughout: these cases are a CREATE, where the write's own
        // flags are the only provenance there can be. The stored-record arm is covered in
        // `set_gate_tests` (#4154) — that is the case this gate used to get wrong.

        // The refused shape — an algorithm with neither, and no opt-out.
        assert!(!provenance_declared("algorithm", &bare, None, false));
        // Each accepted shape, against the SAME record, so the rule is proven to turn on provenance
        // alone rather than on some other difference between the calls.
        assert!(provenance_declared("algorithm", &with_src, None, false));
        assert!(provenance_declared("algorithm", &with_folder, None, false));
        assert!(provenance_declared("algorithm", &bare, None, true)); // --no-src

        // A PRIMITIVE describes a built-in via `--ref` and has no source by design (#2972) — the gate
        // must never apply to it, or the whole primitive tier becomes unwritable.
        assert!(provenance_declared("primitive", &bare, None, false));
    }

    /// `--apply` is the module migration's WRITE path (harvest-module-can-persist), and its guard is
    /// what keeps it from becoming an accidental library dump: a directory harvest under `--apply`
    /// would write every function it walked into the store as a side effect of asking what is there.
    /// That is the deliberate curation decision `curate --apply` exists to make.
    #[test]
    fn apply_is_refused_without_module_mode() {
        let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests").join("fixtures").to_string_lossy().into_owned();
        let err = bsc_cli_util::with_repo_root(None, || {
            run(vec!["harvest".into(), fixtures, "--apply".into()], "bsc graph").unwrap_err()
        });
        assert!(
            err.contains("--module"),
            "a directory --apply must say it needs --module rather than writing the tree: {err}",
        );
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

#[cfg(test)]
mod set_gate_tests {
    use super::*;
    use serde_json::json;

    // ── the provenance gate sees the STORED record (#4154, designer request #52) ──────────────────
    // 14 TypeScript + 3 fleet entries were blocked from routine domain/kind edits because the gate
    // inspected only this write's flags. Restating provenance on every edit is the exact shape that
    // caused the loss the merge now prevents, so the gate was pushing callers back toward it.

    #[test]
    fn an_edit_to_a_record_that_already_has_provenance_passes() {
        let write = json!({ "id": "rotate.ts", "domain": "changed" });
        let stored = json!({ "id": "rotate.ts", "src": "features/x/rotate.ts", "folder": "features/x" });
        assert!(provenance_declared("algorithm", &write, Some(&stored), false));
    }

    #[test]
    fn a_new_algorithm_with_no_provenance_anywhere_is_still_refused() {
        let write = json!({ "id": "new.ts", "domain": "x" });
        assert!(!provenance_declared("algorithm", &write, None, false));
    }

    /// `--clear src,folder` arrives as JSON null. A key that is PRESENT-but-null used to satisfy the
    /// gate, so the one write that genuinely removes an algorithm's provenance was the one it waved
    /// through.
    #[test]
    fn clearing_the_last_provenance_field_fails_the_gate() {
        let write = json!({ "id": "x.ts", "src": null, "folder": null });
        let stored = json!({ "id": "x.ts", "src": "a/x.ts", "folder": "a" });
        assert!(!provenance_declared("algorithm", &write, Some(&stored), false));
    }

    #[test]
    fn clearing_one_of_two_is_fine_the_other_still_carries_it() {
        let write = json!({ "id": "x.ts", "src": null });
        let stored = json!({ "id": "x.ts", "src": "a/x.ts", "folder": "a" });
        assert!(provenance_declared("algorithm", &write, Some(&stored), false));
    }

    #[test]
    fn a_primitive_is_exempt_and_no_src_is_the_explicit_none() {
        assert!(provenance_declared("primitive", &json!({ "id": "p" }), None, false)); // #2972
        assert!(provenance_declared("algorithm", &json!({ "id": "a" }), None, true));  // --no-src
    }

    // ── unknown flags are an error, not silence (#4154, designer request #52) ────────────────────

    #[test]
    fn an_unknown_flag_is_refused_rather_than_ignored() {
        // `--tests` has never existed here. Ignoring it let the designer conclude, three times, that a
        // working merge was deleting the field.
        let args: Vec<String> = ["impl", "set", "--id", "x", "--tests", "…"].iter().map(|s| s.to_string()).collect();
        let err = reject_unknown_flags(&args).unwrap_err();
        assert!(err.contains("--tests"), "names the offending flag: {err}");
    }

    #[test]
    fn a_value_that_looks_like_a_flag_is_not_read_as_one() {
        // `--summary` takes a value, so the next token is consumed even when it starts with `--`.
        let args: Vec<String> = ["impl", "set", "--summary", "--not-a-flag", "--pretty"].iter().map(|s| s.to_string()).collect();
        assert!(reject_unknown_flags(&args).is_ok());
    }

    #[test]
    fn a_bool_flag_does_not_swallow_the_token_after_it() {
        // `--pretty` consumes nothing, so a BAD flag right after it must still be caught.
        let args: Vec<String> = ["dump", "--pretty", "--bogus"].iter().map(|s| s.to_string()).collect();
        assert!(reject_unknown_flags(&args).unwrap_err().contains("--bogus"));
    }

    #[test]
    fn every_declared_flag_is_accepted() {
        // Non-vacuity: a typo in FLAGS would make the walk reject a flag the CLI really reads.
        for f in FLAGS {
            let args = if BOOL_FLAGS.contains(&f) {
                vec![f.to_string()]
            } else {
                vec![f.to_string(), "v".to_string()]
            };
            assert!(reject_unknown_flags(&args).is_ok(), "{f} should be accepted");
        }
    }
}

#[cfg(test)]
mod same_module_path_tests {
    use super::same_module_path;

    /// The false positive this function exists to end: one module, two spellings of its path.
    ///
    /// The stem-collision guard refuses a harvest whose id already names a DIFFERENT module. Comparing
    /// raw `src` strings made it fire on a record pointing at the SAME file — the store holds both
    /// `src/…`-prefixed and bare paths, because records arrived from different eras of the harvest — so
    /// re-harvesting a module over its own stale record was rejected as a collision.
    #[test]
    fn one_module_written_two_ways_compares_equal() {
        for (a, b) in [
            ("src/shared/lib/core/hashString.ts", "shared/lib/core/hashString.ts"),
            ("./app/console/lib/focusQueue.ts", "app/console/lib/focusQueue.ts"),
            (r"src\shared\lib\graph\selectionNeighborhood.ts", "shared/lib/graph/selectionNeighborhood.ts"),
            ("./src/features/algorithms/viz/examples/sort.ts", "features/algorithms/viz/examples/sort.ts"),
        ] {
            assert_eq!(same_module_path(a), same_module_path(b), "{a} and {b} name one module");
        }
    }

    /// ...and it must still tell two modules apart, or the fix has simply disabled the guard. These are
    /// the REAL stem collisions the guard was written for: one id, genuinely different files.
    #[test]
    fn genuinely_different_modules_still_differ() {
        for (a, b) in [
            ("src/shared/ui/registry.tsx", "features/algorithms/viz/examples/registry.ts"),
            ("src/store/types/plan.ts", "src/store/slices/plan.ts"),
            ("features/planner/preview/registry.ts", "features/designs/lib/previewRegistry.ts"),
        ] {
            assert_ne!(same_module_path(a), same_module_path(b), "{a} and {b} are different modules");
        }
    }

    /// Only the LEADING `src/` goes. A path with `src` further in keeps it — stripping every occurrence
    /// would collapse two real modules onto one name, re-introducing the bug in the other direction.
    #[test]
    fn only_the_leading_src_segment_is_stripped() {
        assert_eq!(same_module_path("src/features/src/thing.ts"), "features/src/thing.ts");
        assert_eq!(same_module_path("features/src/thing.ts"), "features/src/thing.ts");
        assert_ne!(same_module_path("src/a/src/b.ts"), same_module_path("src/a/b.ts"));
    }
}
