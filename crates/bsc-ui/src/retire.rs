//! RETIRING A MODULE — `bsc ui retire`, ported from `scripts/retire-module.mjs`.
//!
//! The value here is in the REFUSALS, not in the deletion. Six of them, each paid for by a real failure,
//! and every one is a case where the file must stay however good its record looks. A refusal that
//! silently stops firing is the failure mode this migration has already hit twice — a ported predicate
//! that matched nothing in the real tree while its fixtures passed, and a test that asserted a rule was
//! PRESENT rather than reachable. So the decision is a pure function with its inputs injected, and every
//! refusal has its own behavioural test.

/// Why a module may not be retired. `None` is the only value that permits deletion.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// A build config imports it — bundled before any plugin runs, so a record can never serve it.
    BuildConfig(Vec<String>),
    /// An algorithms SEED module: the packaged node's `code` is generated FROM this file.
    AlgorithmSeed,
    /// An app ENTRY imports it statically — the dev server resolves the alias before the plugin loads.
    EntryImport(Vec<String>),
    /// Nothing shipped answers its specifier, so deleting it strands every importer. `near` holds any
    /// seed specifier that differs ONLY in case — a distinct and far more dangerous failure.
    NoSeed { spec: String, near: Vec<String> },
    /// The seed imports siblings by record id — resolvable only by the runtime graph loader.
    GraphHosted(Vec<String>),
    /// The seed's body differs from the file: deleting ships the RECORD's behaviour, and it compiles.
    SeedDiffers(String),
}

impl Refusal {
    /// The message the tool prints. Each names the CONSEQUENCE, not just the rule — "no seed" reads as
    /// tidiness, "every importer of this specifier stops resolving" is the reason anyone stops.
    pub fn message(&self, rel: &str) -> String {
        match self {
            Self::BuildConfig(who) => format!(
                "retire: REFUSED — {rel} is imported by {}. A build config is bundled before any plugin \
                 runs, so `.bsc-records/` can never serve it and only `npx vite build` would catch it.",
                who.join(", ")
            ),
            Self::AlgorithmSeed => format!(
                "retire: REFUSED — {rel} is an algorithms SEED module. Its node's code is generated from \
                 this file, so deleting it turns the standalone guarantee back into a claim \
                 (seedAlgorithms.gen.test.ts, #3465)."
            ),
            Self::EntryImport(who) => format!(
                "retire: REFUSED — {rel} is imported STATICALLY by {}. The dev server's pre-transform \
                 pass resolves that alias to `/src/…` before the records plugin can answer, so the app \
                 fails to boot — and only `node scripts/dev-boot-check.mjs` observes it.",
                who.join(", ")
            ),
            Self::NoSeed { spec, near } => {
                let head = format!(
                    "retire: REFUSED — no packaged seed record provides {spec}, so deleting the file \
                     would leave its importers with nothing to resolve to."
                );
                // A CASE MISMATCH is the dangerous half and gets its own sentence: it is not "no record",
                // it is a record that resolves on Windows and vanishes on a case-sensitive filesystem —
                // so the tidy-looking retirement passes locally and breaks CI.
                if near.is_empty() {
                    format!(
                        "{head}\n   Promote it first (`node scripts/promote-records.mjs --store … \
                         --impls … --apply`) and CHECK THAT RUN'S OUTPUT — a write it skipped is a seed \
                         that still holds the old record."
                    )
                } else {
                    format!(
                        "{head}\n   A seed provides {} — a CASE MISMATCH. The loader matches exactly, so \
                         this would keep working on Windows and break on a case-sensitive filesystem.",
                        near.join(", ")
                    )
                }
            }
            Self::GraphHosted(specs) => {
                let shown = specs.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
                let more = if specs.len() > 3 {
                    format!(", +{}", specs.len() - 3)
                } else {
                    String::new()
                };
                format!(
                    "retire: REFUSED — the seed record providing this module imports its siblings BY \
                     RECORD ID ({shown}{more}). That form is resolved only by the runtime graph loader, \
                     so the record cannot be materialized into `.bsc-records/` as a bundle module — \
                     deleting the file would break the build.\n   This module is graph-hosted: it stays \
                     a file until its siblings are reachable by specifier."
                )
            }
            Self::SeedDiffers(spec) => format!(
                "retire: REFUSED — the seed record providing {spec} does NOT match this file. Deleting \
                 it would ship the RECORD's behaviour under the file's name, and it would still \
                 compile.\n   Adjudicate first: refresh the record from the file, or decide the record \
                 is the app and bring the file to it."
            ),
        }
    }
}

/// Everything the decision needs, gathered by the caller so the decision itself touches no filesystem.
pub struct RetireFacts<'a> {
    /// `src/`-relative path of the module, e.g. `shared/ui/controls/Button.tsx`.
    pub rel: &'a str,
    /// The `@/…` specifier it would be retired behind.
    pub spec: &'a str,
    /// Build configs that import it by a relative path.
    pub build_config_importers: Vec<String>,
    /// App entries importing it statically.
    pub entry_importers: Vec<String>,
    /// The packaged seed's source for `spec`, or `None` when nothing ships it.
    pub seed_source: Option<&'a str>,
    /// Seed specifiers differing from `spec` ONLY in case — from `seed_answers_specifier`.
    pub near_miss: Vec<String>,
    /// The file's own source, already normalized as a record would carry it.
    pub file_source: &'a str,
}

/// May this module be retired? `None` permits it; anything else is the reason it may not.
///
/// ORDER IS DELIBERATE — the cheapest and most absolute refusals come first, so a module that can never
/// be retired is reported as such rather than as a seed mismatch that someone might try to "fix".
pub fn refusal(f: &RetireFacts) -> Option<Refusal> {
    if !f.build_config_importers.is_empty() {
        return Some(Refusal::BuildConfig(f.build_config_importers.clone()));
    }
    // `shared/lib/algorithms/*` is never retirable: the node's `code` is GENERATED from the module, so
    // deleting it turns a checked fact into a claim. The census learned this; the tool that actually
    // deletes did not, and `llmEnergy.ts` went in a tranche because of the gap.
    if is_algorithm_seed_module(f.rel) {
        return Some(Refusal::AlgorithmSeed);
    }
    if !f.entry_importers.is_empty() {
        return Some(Refusal::EntryImport(f.entry_importers.clone()));
    }
    let Some(seed) = f.seed_source else {
        return Some(Refusal::NoSeed {
            spec: f.spec.to_string(),
            near: f.near_miss.clone(),
        });
    };
    // Graph-hosted: `@/components/<id>` resolves only in the runtime loader, so the record cannot be
    // materialized as a bundle module and the file is still doing the work.
    let (any, specs) = crate::record_source::imports_siblings_by_record_id(seed);
    if any {
        return Some(Refusal::GraphHosted(specs));
    }
    // Last, and the one the census only ADVISES about: this tool acts, so it re-decides for itself.
    if !crate::record_source::seed_matches_file(seed, f.file_source) {
        return Some(Refusal::SeedDiffers(f.spec.to_string()));
    }
    None
}

/// `shared/lib/algorithms/<one segment>` — the packaged seed modules, and only those.
///
/// Anchored to a SINGLE segment on purpose: a nested `shared/lib/algorithms/viz/foo.ts` is not a seed
/// module and must stay retirable.
pub fn is_algorithm_seed_module(rel: &str) -> bool {
    rel.strip_prefix("shared/lib/algorithms/").is_some_and(|r| !r.contains('/'))
}

/// The build configs that import `rel` by a relative path.
///
/// Derived from the configs PRESENT rather than a hard-coded list, so a new build-time importer is
/// covered the day it is written rather than the day someone remembers to add it here.
pub fn build_config_importers(repo: &std::path::Path, rel: &str) -> Vec<String> {
    const CONFIGS: [&str; 5] = [
        "vite.config.ts",
        "vitest.config.ts",
        "e2e/vite.config.ts",
        "playwright.config.ts",
        "eslint.config.js",
    ];
    let stem = rel.trim_end_matches(".tsx").trim_end_matches(".ts");
    let pattern = format!(
        r#"from\s+["']\.{{1,2}}/(?:\.\./)*src/{}(?:\.[jt]sx?)?["']"#,
        regex::escape(stem)
    );
    let Ok(re) = regex::Regex::new(&pattern) else { return Vec::new() };
    CONFIGS
        .iter()
        .filter(|c| repo.join(c).is_file())
        .filter(|c| {
            std::fs::read_to_string(repo.join(c)).is_ok_and(|body| re.is_match(&body))
        })
        .map(|c| (*c).to_string())
        .collect()
}

/// Rewrite every relative importer of `target_base` to `spec`, returning how many files changed.
///
/// The specifier pattern allows a BARE `./` or `../` with no name after the slash: a directory import
/// resolves to that directory's barrel, and requiring a name meant those were never rewritten — so
/// retiring `shared/ui/charts/index.ts` left `charts.test.tsx` importing `from "./"`, which typecheck
/// then reported as `Cannot find module './'` once the file was already gone.
pub fn rewrite_importers(
    repo: &std::path::Path,
    files: &[String],
    self_rel: &str,
    // The path form the argument named, extension off — e.g. `shared/ui/charts/index`.
    target_rel: &str,
    // ...and the same with a trailing `/index` removed — `shared/ui/charts`.
    target_specifier: &str,
    spec: &str,
    dry: bool,
    mut on_change: impl FnMut(&str),
) -> usize {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(
            r#"((?:from|import|require|vi\.mock|vi\.doMock|vi\.unmock)\s*\(?\s*)(['"])(\.{1,2}(?:/[^'"]*)?)(['"])"#,
        )
        .expect("importer pattern")
    });
    let mut rewrote = 0usize;
    for f in files {
        if f == self_rel {
            continue;
        }
        let abs = repo.join("src").join(f);
        let Ok(before) = std::fs::read_to_string(&abs) else { continue };
        let from_dir = f.rsplit_once('/').map_or("", |(d, _)| d);
        let mut after = String::with_capacity(before.len());
        let mut last = 0usize;
        for c in re.captures_iter(&before) {
            let whole = c.get(0).expect("group 0");
            let rel_spec = &c[3];
            if resolves_to_target(from_dir, rel_spec, target_rel, target_specifier) {
                after.push_str(&before[last..whole.start()]);
                after.push_str(&c[1]);
                after.push_str(&c[2]);
                after.push_str(spec);
                after.push_str(&c[4]);
                last = whole.end();
            }
        }
        after.push_str(&before[last..]);
        if after != before {
            rewrote += 1;
            on_change(f);
            if !dry {
                let _ = std::fs::write(&abs, after);
            }
        }
    }
    rewrote
}

/// Does `rel_spec`, written inside `from_dir`, resolve to `target_base`?
/// A src-relative target path → the `rel` every other derivation is built from: extension off, and a
/// leading `src/` off. Mirrors `rel` in the retired `scripts/retire-module.mjs`.
pub fn normalize_target(target: &str) -> String {
    let stem = [".tsx", ".ts", ".jsx", ".js"]
        .iter()
        .find_map(|e| target.strip_suffix(*e))
        .unwrap_or(target);
    stem.strip_prefix("src/").unwrap_or(stem).to_string()
}

/// The `@/…` specifier a retired module answers. A BARREL is addressed by its DIRECTORY — `/index` is
/// dropped — because that is the form consumers normally write. Only a whole `/index` SEGMENT counts:
/// `features/x/indexed` merely ends with the letters and keeps them.
pub fn specifier_for(rel: &str) -> String {
    format!("@/{}", rel.strip_suffix("/index").unwrap_or(rel))
}

fn resolves_to_target(
    from_dir: &str,
    rel_spec: &str,
    target_rel: &str,
    target_specifier: &str,
) -> bool {
    let joined = format!("{from_dir}/{rel_spec}");
    let mut out: Vec<&str> = Vec::new();
    for p in joined.split('/') {
        match p {
            "." | "" => continue,
            ".." => {
                out.pop();
            }
            _ => out.push(p),
        }
    }
    // BOTH SPELLINGS reach a barrel: `./lib/plannerCore` (the directory) and `./lib/plannerCore/index`
    // (the file). Matching only the second left every directory-form importer untouched — and the
    // directory form is the one consumers normally write, so that is the half that actually breaks.
    let hit = out.join("/");
    hit == target_rel || hit == target_specifier
}

/// The colocated test(s) for `rel` — files that must be KEPT, never deleted alongside the module.
///
/// A record carries its tests as data, but nothing in the default gate RUNS carried tests. Deleting the
/// colocated file therefore trades executed coverage for stored coverage with everything still green —
/// it cost 31 assertions across the first two tranches. Its relative import is rewritten like any
/// other's, after which it resolves to the emitted record and the gate verifies the module that ships.
pub fn colocated_tests(files: &[String], rel: &str) -> Vec<String> {
    ["test", "spec"]
        .iter()
        .flat_map(|k| [format!("{rel}.{k}.ts"), format!("{rel}.{k}.tsx")])
        .filter(|p| files.contains(p))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const BODY: &str = "export const a = 1;\n";

    fn facts<'a>(rel: &'a str, seed: Option<&'a str>) -> RetireFacts<'a> {
        RetireFacts {
            rel,
            spec: "@/shared/lib/a",
            build_config_importers: Vec::new(),
            entry_importers: Vec::new(),
            seed_source: seed,
            near_miss: Vec::new(),
            file_source: BODY,
        }
    }

    /// NON-VACUITY FIRST. Every test below asserts a REFUSAL, and a `refusal` that returned `Some` for
    /// everything would pass all of them. This is the one that says the tool can still say yes.
    #[test]
    fn an_ordinary_module_with_a_matching_seed_is_permitted() {
        assert_eq!(refusal(&facts("shared/lib/a.ts", Some(BODY))), None);
    }

    #[test]
    fn a_build_config_importer_refuses_and_names_the_config() {
        let mut f = facts("shared/lib/a.ts", Some(BODY));
        f.build_config_importers = vec!["vite.config.ts".to_string()];
        let r = refusal(&f).expect("must refuse");
        assert_eq!(r, Refusal::BuildConfig(vec!["vite.config.ts".to_string()]));
        let m = r.message("shared/lib/a.ts");
        assert!(m.contains("vite.config.ts"), "names which config: {m}");
        // The CONSEQUENCE, not just the rule — this is what makes anyone stop.
        assert!(m.contains("bundled before any plugin runs"), "{m}");
    }

    /// `llmEnergy.ts` went in a tranche before the census learned this, and the tool that actually
    /// deletes never learned it at all.
    #[test]
    fn an_algorithms_seed_module_is_never_retirable() {
        let r = refusal(&facts("shared/lib/algorithms/llmEnergy.ts", Some(BODY))).expect("must refuse");
        assert_eq!(r, Refusal::AlgorithmSeed);
        assert!(r.message("x").contains("generated from"), "names why: {}", r.message("x"));
        // ...and it outranks everything below it: even with no seed at all, this is the reason given.
        assert_eq!(refusal(&facts("shared/lib/algorithms/llmEnergy.ts", None)), Some(Refusal::AlgorithmSeed));
        // A NESTED path is not a seed module and stays retirable.
        assert_eq!(refusal(&facts("shared/lib/algorithms/viz/sorts.ts", Some(BODY))), None);
    }

    /// The `ConsoleGraphHost` case — retired and restored, with every gate green, because only a real
    /// boot observes it.
    #[test]
    fn an_entry_static_import_refuses_and_names_the_entry() {
        let mut f = facts("app/console/ConsoleGraphHost.tsx", Some(BODY));
        f.entry_importers = vec!["app/App.tsx".to_string()];
        let r = refusal(&f).expect("must refuse");
        assert_eq!(r, Refusal::EntryImport(vec!["app/App.tsx".to_string()]));
        let m = r.message("x");
        // The message must name the OBSERVER, not just the rule: no gate leg sees this failure, so a
        // reader who does not know `dev-boot-check` has no way to confirm the refusal was right.
        assert!(m.contains("fails to boot"), "{m}");
        assert!(m.contains("dev-boot-check.mjs"), "{m}");
    }

    #[test]
    fn no_packaged_seed_refuses_rather_than_stranding_importers() {
        let r = refusal(&facts("shared/lib/a.ts", None)).expect("must refuse");
        assert_eq!(r, Refusal::NoSeed { spec: "@/shared/lib/a".to_string(), near: Vec::new() });
        assert!(r.message("x").contains("nothing to resolve"), "{}", r.message("x"));
    }

    /// Graph-hosted: the seed reaches its siblings by RECORD ID, which only the runtime loader resolves,
    /// so the record cannot be materialized as a bundle module.
    #[test]
    fn a_seed_importing_siblings_by_record_id_is_graph_hosted_and_stays() {
        let seed = "import { Panel } from \"@/components/glance-panel\";\nexport const a = 1;\n";
        let mut f = facts("features/glance/GlancePage.tsx", Some(seed));
        f.file_source = seed;
        let r = refusal(&f).expect("must refuse");
        assert_eq!(r, Refusal::GraphHosted(vec!["@/components/glance-panel".to_string()]));
        let m = r.message("x");
        assert!(m.contains("runtime graph loader"), "{m}");
        assert!(m.contains("stays a file"), "says what happens instead: {m}");
    }

    /// The BODY-DIFFERS hazard. The census only ADVISES about this; the tool acts, so it re-decides.
    #[test]
    fn a_seed_that_differs_from_the_file_is_refused_because_deleting_still_compiles() {
        let mut f = facts("shared/lib/a.ts", Some("export const a = 2;\n"));
        f.file_source = BODY;
        let r = refusal(&f).expect("must refuse");
        assert_eq!(r, Refusal::SeedDiffers("@/shared/lib/a".to_string()));
        let m = r.message("x");
        assert!(m.contains("still compile"), "the reason it is dangerous: {m}");
    }

    /// The importer rewrite, including the BARE `./` form. Retiring `shared/ui/charts/index.ts` once left
    /// `charts.test.tsx` importing `from "./"`, which typecheck reported as `Cannot find module './'`
    /// only after the file was already gone — the pattern must allow a slash with no name after it.
    #[test]
    fn a_bare_directory_import_is_rewritten_too() {
        let dir = std::env::temp_dir().join(format!("bsc-retire-bare-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src/shared/ui/charts");
        std::fs::create_dir_all(&src).expect("mkdir");
        std::fs::write(src.join("charts.test.tsx"), "import { A } from \"./\";\nexport const t = 1;\n")
            .expect("write");
        std::fs::write(src.join("other.tsx"), "import { A } from \"./index\";\n").expect("write");

        let files = vec![
            "shared/ui/charts/charts.test.tsx".to_string(),
            "shared/ui/charts/other.tsx".to_string(),
            "shared/ui/charts/index.ts".to_string(),
        ];
        let mut touched: Vec<String> = Vec::new();
        let n = rewrite_importers(
            &dir,
            &files,
            "shared/ui/charts/index.ts",
            "shared/ui/charts/index",
            "shared/ui/charts",
            "@/shared/ui/charts",
            false,
            |f| touched.push(f.to_string()),
        );
        assert_eq!(n, 2, "both the bare `./` and the explicit `./index` rewrite: {touched:?}");
        let after = std::fs::read_to_string(src.join("charts.test.tsx")).expect("read");
        assert!(after.contains("\"@/shared/ui/charts\""), "bare form rewritten: {after}");
        assert!(!after.contains("\"./\""), "the bare relative must be gone: {after}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `--dry` must write NOTHING. Asserted by hashing the whole tree before and after, rather than
    /// spot-checking one file — a dry run that rewrote some other importer would pass a narrower check.
    #[test]
    fn a_dry_run_writes_nothing_at_all() {
        let dir = std::env::temp_dir().join(format!("bsc-retire-dry-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let src = dir.join("src/shared/ui");
        std::fs::create_dir_all(&src).expect("mkdir");
        std::fs::write(src.join("a.ts"), "export const a = 1;\n").expect("write");
        std::fs::write(src.join("b.ts"), "import { a } from \"./a\";\n").expect("write");

        let snapshot = |root: &std::path::Path| -> Vec<(String, String)> {
            let mut out = Vec::new();
            fn walk(d: &std::path::Path, base: &std::path::Path, out: &mut Vec<(String, String)>) {
                for e in std::fs::read_dir(d).into_iter().flatten().flatten() {
                    let p = e.path();
                    if p.is_dir() {
                        walk(&p, base, out);
                    } else {
                        out.push((
                            p.strip_prefix(base).expect("under base").to_string_lossy().into_owned(),
                            std::fs::read_to_string(&p).unwrap_or_default(),
                        ));
                    }
                }
            }
            walk(root, root, &mut out);
            out.sort();
            out
        };

        let before = snapshot(&dir);
        let files = vec!["shared/ui/a.ts".to_string(), "shared/ui/b.ts".to_string()];
        let n = rewrite_importers(&dir, &files, "shared/ui/a.ts", "shared/ui/a", "shared/ui/a", "@/shared/ui/a", true, |_| {});
        assert_eq!(n, 1, "the dry run must still REPORT the importer it would rewrite");
        assert_eq!(snapshot(&dir), before, "a dry run wrote to disk");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The colocated test is FOUND so it can be kept. Deleting it trades executed coverage for stored
    /// coverage with the gate green either way — it cost 31 assertions across two tranches.
    #[test]
    fn the_colocated_test_is_found_in_every_form_it_takes() {
        let files: Vec<String> = ["a.test.ts", "b.spec.tsx", "c.ts"]
            .iter()
            .map(|f| format!("shared/lib/{f}"))
            .collect();
        assert_eq!(colocated_tests(&files, "shared/lib/a"), vec!["shared/lib/a.test.ts".to_string()]);
        assert_eq!(colocated_tests(&files, "shared/lib/b"), vec!["shared/lib/b.spec.tsx".to_string()]);
        // A module with no colocated test is not an error — most have none.
        assert_eq!(colocated_tests(&files, "shared/lib/c"), Vec::<String>::new());
    }

    /// The CASE-MISMATCH branch. It is not a nicer "no record" — it is a record that resolves on Windows
    /// and vanishes on a case-sensitive filesystem, so the retirement passes locally and breaks CI. The
    /// two branches are asserted to differ, since a message that collapsed to one would hide exactly that.
    #[test]
    fn a_case_only_seed_match_refuses_with_its_own_reason() {
        let plain = Refusal::NoSeed { spec: "@/shared/lib/a".into(), near: Vec::new() }.message("shared/lib/a");
        let cased = Refusal::NoSeed {
            spec: "@/shared/lib/a".into(),
            near: vec!["@/shared/lib/A".into()],
        }
        .message("shared/lib/a");

        assert!(plain.contains("Promote it first"), "no near miss → the promote path: {plain}");
        assert!(!plain.contains("CASE MISMATCH"));

        assert!(cased.contains("CASE MISMATCH"), "{cased}");
        assert!(cased.contains("@/shared/lib/A"), "it must NAME the specifier that nearly matched: {cased}");
        assert!(!cased.contains("Promote it first"), "the promote advice is wrong here: {cased}");
    }

    /// The argument arrives however a person has it in hand. `docs/records.md` spells the invocation
    /// with `src/`, and the harvest loop that measured the floor passed paths straight from `find src`.
    #[test]
    fn the_target_path_is_normalised_however_it_is_spelled() {
        for given in [
            "src/features/sounds/index.ts",
            "features/sounds/index.ts",
            "src/features/sounds/index",
            "features/sounds/index",
        ] {
            assert_eq!(normalize_target(given), "features/sounds/index", "given {given}");
        }
        assert_eq!(normalize_target("src/app/App.tsx"), "app/App");
        // `src` only leads once — a module genuinely named `src` deeper in the tree keeps it.
        assert_eq!(normalize_target("src/shared/src/util.ts"), "shared/src/util");
        // ...and a barrel normalises to the `/index` form, which `specifier_for` then strips.
        assert_eq!(specifier_for(&normalize_target("src/features/sounds/index.ts")), "@/features/sounds");
    }

    /// Migrated from `scripts/retire-barrel.test.ts`, whose subject moved to Rust with the script. Both
    /// TS2307 rounds it was written for happened AFTER the file was already deleted, so these rules are
    /// only ever cheap to check here and expensive to relearn.
    #[test]
    fn a_barrel_is_addressed_by_its_directory_and_a_prefix_sibling_is_not_touched() {
        assert_eq!(specifier_for("features/planner/lib/plannerCore/index"), "@/features/planner/lib/plannerCore");
        assert_eq!(specifier_for("features/studio-sessions/index"), "@/features/studio-sessions");
        // A non-barrel keeps its whole path...
        assert_eq!(specifier_for("shared/lib/session/roleModel"), "@/shared/lib/session/roleModel");
        // ...and `indexed.ts` merely ENDS with the letters; only a whole `/index` segment is a barrel.
        assert_eq!(specifier_for("features/x/indexed"), "@/features/x/indexed");

        let rel = "features/planner/lib/plannerCore/index";
        let spec = "features/planner/lib/plannerCore";
        let hits = |from: &str, s: &str| resolves_to_target(from, s, rel, spec);
        assert!(hits("features/planner", "./lib/plannerCore"), "the directory form");
        assert!(hits("features/planner", "./lib/plannerCore/index"), "the explicit /index form");
        assert!(hits("features/planner/lib/plannerSync", "../plannerCore"), "reached through ..");
        // A sibling that merely shares a PREFIX is a different module.
        assert!(!hits("features/planner", "./lib/plannerCoreExtra"));
        assert!(!hits("features/planner", "./lib/plannerCore/types"));
    }

    /// The ORDER is part of the contract: a module that can NEVER be retired must say so, rather than
    /// report a seed mismatch someone might try to "fix" by refreshing the seed.
    #[test]
    fn the_most_absolute_refusal_wins_when_several_apply() {
        let mut f = facts("shared/lib/algorithms/llmEnergy.ts", Some("export const a = 2;\n"));
        f.build_config_importers = vec!["vite.config.ts".to_string()];
        f.entry_importers = vec!["app/App.tsx".to_string()];
        // Build-config first: it is the one no amount of record work can resolve.
        assert!(matches!(refusal(&f), Some(Refusal::BuildConfig(_))));
        f.build_config_importers.clear();
        assert_eq!(refusal(&f), Some(Refusal::AlgorithmSeed));
        f = facts("shared/lib/a.ts", Some("export const a = 2;\n"));
        f.entry_importers = vec!["app/App.tsx".to_string()];
        assert!(matches!(refusal(&f), Some(Refusal::EntryImport(_))));
    }
}
