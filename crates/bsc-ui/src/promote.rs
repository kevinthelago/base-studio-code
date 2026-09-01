//! PROMOTE A LIVE STORE RECORD INTO THE PACKAGED SEED — `bsc ui promote-seed`, ported from
//! `scripts/promote-records.mjs`. The step that makes a module's file retirable.
//!
//! WHY IT IS NEEDED AT ALL. `emit-records` materializes a retired module from the SEED, never from the
//! store: the seed is what ships, and the store is a per-machine working copy. So a module whose record
//! exists only in the store cannot be retired however good that record is — 633 of 882 modules were in
//! exactly that state, which is why the candidate pool had been stuck at single digits.
//!
//! WHAT IT WILL PROMOTE. Only a record whose CODE already matches its file, compared through
//! [`bsc_record::record_source`] — the same module the census uses, so the two can never disagree about
//! which files are safe. A census that grades differently from the tool that acts is worse than either
//! being wrong alone.

use bsc_record::record_source::{blank_comments, code_only, norm, split_preamble};

/// Why a module was not promoted. Every variant was learned by shipping the bug first.
#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Skip {
    /// The packaged seed already provides this specifier; promoting again would duplicate it.
    AlreadySeeded,
    /// No store record answers this specifier.
    NoRecord,
    /// A VITE build-time transform. esbuild emits `import.meta.glob` verbatim and it is not a function at
    /// runtime, so the record throws the moment a graph consumer evaluates it — and retiring the file
    /// would leave nothing to fall back to.
    BuildTimeOnly,
    /// A `role: page` record is an APP SCREEN to `shadowPages.test.ts`, which demands every one be
    /// catalogued. Promoting an uncatalogued page fails the suite, so it is a deliberate per-page act.
    PageNotCatalogued(String),
    /// The record imports something no record provides and the platform does not register.
    Unresolvable(Vec<String>),
    /// The record is NOT the same module as the file. Promoting would ship the record's behaviour under
    /// the file's name — silently, since it still compiles. `delta` is signed on purpose: a record LARGER
    /// than its file usually holds something the file lost, and a smaller one usually dropped an export.
    BodyDiffers { record_len: usize, file_len: usize, delta: isize },
}

/// The `@/…` specifier a `src/`-relative module answers.
pub fn spec_of(file: &str) -> String {
    let stem = [".tsx", ".ts", ".jsx", ".js"]
        .iter()
        .find_map(|e| file.strip_suffix(*e))
        .unwrap_or(file);
    format!("@/{}", stem.strip_suffix("/index").unwrap_or(stem))
}

/// Is this `src/`-relative path a MODULE a record could stand for?
///
/// `.d.ts` is AMBIENT TYPE INFORMATION, not a module. tsc reads it because it is INCLUDED, never because
/// something imports it — so no resolver can substitute a record for it, and no record can carry its
/// meaning. `src/vite-env.d.ts` matched `\.ts$`, was harvested, promoted and retired; the whole typecheck
/// then failed on `*.css` and `*?raw` side-effect imports, because the file declaring those wildcards was
/// gone. NOTHING DOWNSTREAM COULD HAVE CAUGHT IT — there is no importer to break, which is exactly why it
/// has to be excluded here.
pub fn is_module(name: &str) -> bool {
    let is_ts = name.ends_with(".ts") || name.ends_with(".tsx");
    let is_test = name.ends_with(".test.ts")
        || name.ends_with(".test.tsx")
        || name.ends_with(".spec.ts")
        || name.ends_with(".spec.tsx");
    is_ts && !is_test && !name.ends_with(".d.ts")
}

/// Does this source use the VITE build-time glob?
///
/// TESTED AGAINST COMMENT-BLANKED SOURCE. `features/planner/list/graphPlatform.ts` was classified
/// build-time-only because a comment in it EXPLAINS that `blueprintBuiltins` is an `import.meta.glob`
/// module — prose about the rule tripped the rule. Writing down why something is floor should not make
/// the writer floor too.
pub fn is_build_time_only(source: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r"\bimport\s*\.\s*meta\s*\.\s*glob\b").expect("build-time glob")
    });
    re.is_match(&blank_comments(source))
}

/// Should this `@/…` import count as unresolvable?
///
/// `?raw` / `?url` are answered by the LOADER, not by registration: `makeRequire` calls `rawImportSpec`
/// and returns the string the importer's contract promised. Counting them demands a registration that
/// cannot exist — a specifier carrying a query is not a registry key.
pub fn needs_resolution(spec: &str) -> bool {
    !spec.ends_with(".css")
        && !spec.ends_with(".svg")
        && !spec.ends_with(".png")
        && !spec.ends_with("?raw")
        && !spec.ends_with("?url")
}

/// The per-module gate, in the script's order. `Ok(())` means promotable so far — the two fixed points
/// and the TSX compile check run afterwards, over the surviving set.
#[allow(clippy::too_many_arguments)]
pub fn classify(
    already_seeded: bool,
    record: Option<&RecordView<'_>>,
    file_src: &str,
    catalogued_pages: &dyn Fn(&str) -> bool,
    resolvable: &dyn Fn(&str) -> bool,
    runtime_imports: &dyn Fn(&str) -> Vec<String>,
) -> Result<(), Skip> {
    if already_seeded {
        return Err(Skip::AlreadySeeded);
    }
    let Some(rec) = record else { return Err(Skip::NoRecord) };
    if is_build_time_only(rec.source) {
        return Err(Skip::BuildTimeOnly);
    }
    // A `pageKind: "kit"` record is exempt for the same reason the guard exempts it: a kit template has
    // no workspace to catalogue.
    if rec.kind == "component"
        && rec.role == Some("page")
        && rec.page_kind != Some("kit")
        && !catalogued_pages(rec.id)
    {
        return Err(Skip::PageNotCatalogued(rec.id.to_string()));
    }
    let unresolved: Vec<String> = runtime_imports(rec.source)
        .into_iter()
        .filter(|s| s.starts_with("@/"))
        .filter(|s| !resolvable(s) && needs_resolution(s))
        .collect();
    if !unresolved.is_empty() {
        return Err(Skip::Unresolvable(unresolved));
    }

    // THE GATE: is the record the SAME module as the file? Compared as a record would HOLD it — imports
    // absolutized, asset imports dropped — so a difference of FORM is never mistaken for a difference of
    // substance. That mistake cost 21 candidates the first time round.
    let (_, body) = split_preamble(&norm(rec.source), file_src);
    if body != file_src && code_only(&body) != code_only(file_src) {
        let r = code_only(&body).encode_utf16().count();
        let f = code_only(file_src).encode_utf16().count();
        return Err(Skip::BodyDiffers { record_len: r, file_len: f, delta: r as isize - f as isize });
    }
    Ok(())
}

/// The fields of a store record this gate reads.
pub struct RecordView<'a> {
    pub id: &'a str,
    /// `"component"` or `"impl"`.
    pub kind: &'a str,
    pub role: Option<&'a str>,
    pub page_kind: Option<&'a str>,
    pub source: &'a str,
}

/// A seed carries CONTENT, not provenance.
///
/// `history`/`rev`/`updatedAt`/`updatedBy` are per-machine facts about who last wrote the local store,
/// and `builtin`/`seedHash` are stamped at LOAD by `seed.ts`. Writing the raw store record put all of
/// them in the file — a 98-line diff of one component's local edit history.
pub const SEED_FIELDS: [&str; 21] = [
    "id", "name", "kitId", "role", "provides", "srcText", "composes", "src", "props", "folder",
    "tests", "variants", "animations", "themeSystem", "pageKind", "shapes", "guidance", "whenUse",
    "whenNot", "tags", "analytics",
];

/// The fields an IMPL entry keeps in `algorithms.json`.
pub const IMPL_KEEP: [&str; 11] =
    ["code", "composes", "domain", "folder", "id", "name", "provides", "ref", "role", "src", "tech"];

/// Project a store record onto the fields a seed holds, in `fields` order, dropping anything absent.
pub fn project(rec: &serde_json::Value, fields: &[&str]) -> serde_json::Value {
    let mut out = serde_json::Map::new();
    for k in fields {
        if let Some(v) = rec.get(*k) {
            out.insert((*k).to_string(), v.clone());
        }
    }
    serde_json::Value::Object(out)
}

/// END-TO-END through the real verb against a synthetic repo + a seeded store.
///
/// SEPARATE MODULE because it needs `SeededStore`, which sets `BSC_COMPONENT_DIR` process-wide.
///
/// IT EXISTS BECAUSE THE LIVE ORACLE IS EMPTY. Measured on this tree, `promote-seed` reports 0
/// promotable and six of its eight buckets are empty — the harvest is finished, so the dry-run parity
/// that proved every other port exercises almost nothing here. The WRITE path, the resolvability fixed
/// point and the seed-field projection have no live case at all, and this is the only thing standing in
/// for them.
#[cfg(test)]
mod e2e {
    use crate::test_store::SeededStore;

    /// A synthetic repo with the four inputs the verb reads besides `src/`.
    fn scaffold(s: &SeededStore) -> String {
        let root = s.repo().to_path_buf();
        for d in ["src-tauri/data/components/app", "src-tauri/data/knowledge", "src-tauri/data/ui", "src/app/runtime"] {
            std::fs::create_dir_all(root.join(d)).expect("scaffold");
        }
        std::fs::write(
            root.join("src-tauri/data/knowledge/algorithms.json"),
            "{\n  \"version\": 2,\n  \"implementations\": []\n}\n",
        )
        .expect("algorithms");
        std::fs::write(root.join("src-tauri/data/ui/platform-modules.json"), "[]").expect("platform");
        std::fs::write(root.join("src/app/runtime/shadowPages.ts"), "export const SHADOW_PAGES = [];\n")
            .expect("shadow");
        root.to_string_lossy().into_owned()
    }

    const BODY: &str = "export const thing = 1;\n";

    /// THE WRITE PATH. A record that IS its file is promoted into the packaged seed, and the seed holds
    /// CONTENT ONLY — writing the raw store record once put 98 lines of local edit history into the file.
    #[test]
    fn a_matching_record_is_written_into_the_seed_with_content_only() {
        let s = SeededStore::new("promote-e2e");
        let root = scaffold(&s);
        s.seed_file("shared/lib/thing.ts", BODY);
        s.seed(
            "thing",
            &serde_json::json!({
                "id": "thing", "name": "thing", "kitId": "base-studio-code", "role": "composite",
                "provides": "@/shared/lib/thing", "src": "src/shared/lib/thing.ts",
                "srcText": BODY, "folder": "shared",
                // Provenance the seed must NOT carry.
                "rev": 7, "updatedAt": "2026-01-01T00:00:00Z", "updatedBy": "someone",
                "history": [{"by": "someone", "changed": ["srcText"]}],
            })
            .to_string(),
        );

        let (res, out) = s.run(&["promote-seed", "--apply", "--repo", &root]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("+ component shared/lib/thing.ts"), "it must NAME what it promotes: {out}");
        assert!(out.contains("promoted 1 record(s) into the seed"), "{out}");

        let written = s.repo().join("src-tauri/data/components/app/shared/thing.json");
        assert!(written.is_file(), "the seed must land at <folder>/<id>.json: {out}");
        let rec: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&written).expect("read")).expect("json");
        let o = rec.as_object().expect("object");
        assert_eq!(o.get("provides").and_then(serde_json::Value::as_str), Some("@/shared/lib/thing"));
        assert_eq!(o.get("srcText").and_then(serde_json::Value::as_str), Some(BODY));
        for gone in ["rev", "updatedAt", "updatedBy", "history"] {
            assert!(!o.contains_key(gone), "a seed carries CONTENT, not provenance — {gone} leaked");
        }
    }

    /// THE NEVER-OVERWRITE GUARD. Seven curated seeds were clobbered before it existed, so an existing
    /// seed is left alone and the decline is REPORTED rather than silent.
    #[test]
    fn an_existing_seed_is_never_overwritten_without_adopt_seed() {
        let s = SeededStore::new("promote-guard");
        let root = scaffold(&s);
        s.seed_file("shared/lib/thing.ts", BODY);
        s.seed(
            "thing",
            &serde_json::json!({
                "id": "thing", "name": "thing", "kitId": "base-studio-code", "role": "composite",
                "provides": "@/shared/lib/thing", "src": "src/shared/lib/thing.ts",
                "srcText": BODY, "folder": "shared",
            })
            .to_string(),
        );
        // A CURATED seed already at that path, with DIFFERENT content and no `provides` — so the
        // already-seeded skip (which keys on `provides`) cannot catch it and the write guard must.
        let curated = s.repo().join("src-tauri/data/components/app/shared/thing.json");
        std::fs::create_dir_all(curated.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &curated,
            "{\n  \"id\": \"thing\",\n  \"name\": \"curated\",\n  \"srcText\": \"export const curated = 1;\\n\"\n}\n",
        )
        .expect("curated seed");
        let before = std::fs::read_to_string(&curated).expect("read");

        let (res, out) = s.run(&["promote-seed", "--apply", "--repo", &root]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("SKIPPED (a seed already occupies that path)"), "{out}");
        assert_eq!(std::fs::read_to_string(&curated).expect("read"), before, "the curated seed MOVED");
        // ...and the count reports what LANDED, not what was planned.
        assert!(out.contains("promoted 0 record(s)"), "a declined write must not be counted: {out}");
    }

    /// THE RESOLVABILITY FIXED POINT: `a` imports `b`, and `b` is only promotable in the same run. A
    /// single pass judged against the shipped seed alone would refuse `a`.
    #[test]
    fn a_record_is_promoted_because_its_dependency_lands_in_the_same_run() {
        let s = SeededStore::new("promote-fixpoint");
        let root = scaffold(&s);
        let b_src = "export const b = 1;\n";
        let a_src = "import { b } from \"@/shared/lib/b\";\nexport const a = b;\n";
        s.seed_file("shared/lib/b.ts", b_src);
        s.seed_file("shared/lib/a.ts", a_src);
        for (id, spec, src) in
            [("b", "@/shared/lib/b", b_src), ("a", "@/shared/lib/a", a_src)]
        {
            s.seed(
                id,
                &serde_json::json!({
                    "id": id, "name": id, "kitId": "base-studio-code", "role": "composite",
                    "provides": spec, "src": format!("src/shared/lib/{id}.ts"),
                    "srcText": src, "folder": "shared",
                })
                .to_string(),
            );
        }

        let (res, out) = s.run(&["promote-seed", "--apply", "--repo", &root]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("promoted 2 record(s)"), "BOTH must land: {out}");
        assert!(!out.contains("unresolvable import"), "the fixed point must clear it: {out}");
        for id in ["a", "b"] {
            assert!(
                s.repo().join(format!("src-tauri/data/components/app/shared/{id}.json")).is_file(),
                "{id} was not written: {out}"
            );
        }
    }

    /// ...and an import NOTHING answers is refused. This one is caught by the per-module gate rather
    /// than the fixed point — stated because the distinction matters: the fixed point's own drop needs
    /// a provider that EXISTS in the store and still does not land, which is the test below.
    #[test]
    fn a_record_whose_dependency_never_lands_is_refused() {
        let s = SeededStore::new("promote-fixpoint-neg");
        let root = scaffold(&s);
        let a_src = "import { z } from \"@/shared/lib/nowhere\";\nexport const a = z;\n";
        s.seed_file("shared/lib/a.ts", a_src);
        s.seed(
            "a",
            &serde_json::json!({
                "id": "a", "name": "a", "kitId": "base-studio-code", "role": "composite",
                "provides": "@/shared/lib/a", "src": "src/shared/lib/a.ts",
                "srcText": a_src, "folder": "shared",
            })
            .to_string(),
        );

        let (res, out) = s.run(&["promote-seed", "--apply", "--repo", &root]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("unresolvable import"), "{out}");
        assert!(out.contains("@/shared/lib/nowhere"), "the message must NAME what is missing: {out}");
        assert!(out.contains("promoted 0 record(s)"), "{out}");
        assert!(!s.repo().join("src-tauri/data/components/app/shared/a.json").exists());
    }

    /// THE FIXED POINT'S OWN DROP, which no single pass can make. `a` imports `@/shared/lib/b`, and `b`
    /// IS in the store — so the per-module gate passes `a` cleanly, because resolvability there is judged
    /// against the store. But `b`'s record does not match its file, so `b` is refused, and `a` must then
    /// be dropped too: resolvability has to be judged against what the PACKAGE will hold once the run
    /// lands, not against a store that knows records the shipped seed will still be missing.
    #[test]
    fn the_fixed_point_drops_a_record_whose_provider_was_refused() {
        let s = SeededStore::new("promote-fixpoint-cascade");
        let root = scaffold(&s);
        let a_src = "import { b } from \"@/shared/lib/b\";\nexport const a = b;\n";
        s.seed_file("shared/lib/a.ts", a_src);
        // `b`'s FILE and its RECORD disagree, so `b` is refused as body-differs.
        s.seed_file("shared/lib/b.ts", "export const b = 1;\n");
        s.seed(
            "b",
            &serde_json::json!({
                "id": "b", "name": "b", "kitId": "base-studio-code", "role": "composite",
                "provides": "@/shared/lib/b", "src": "src/shared/lib/b.ts",
                "srcText": "export const b = 1;\nexport const somethingElse = 2;\n", "folder": "shared",
            })
            .to_string(),
        );
        s.seed(
            "a",
            &serde_json::json!({
                "id": "a", "name": "a", "kitId": "base-studio-code", "role": "composite",
                "provides": "@/shared/lib/a", "src": "src/shared/lib/a.ts",
                "srcText": a_src, "folder": "shared",
            })
            .to_string(),
        );

        let (res, out) = s.run(&["promote-seed", "--apply", "--repo", &root]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("body differs"), "`b` must be refused first: {out}");
        assert!(
            out.contains("unresolvable import") && out.contains("shared/lib/a.ts"),
            "and `a` must then be DROPPED by the fixed point: {out}"
        );
        assert!(out.contains("promoted 0 record(s)"), "{out}");
        assert!(
            !s.repo().join("src-tauri/data/components/app/shared/a.json").exists(),
            "`a` must not ship importing a specifier the seed will not answer"
        );
    }

    /// A DRY RUN WRITES NOTHING — asserted on the seed tree, not on the absence of a log line.
    #[test]
    fn a_dry_run_writes_no_seed() {
        let s = SeededStore::new("promote-dry");
        let root = scaffold(&s);
        s.seed_file("shared/lib/thing.ts", BODY);
        s.seed(
            "thing",
            &serde_json::json!({
                "id": "thing", "name": "thing", "kitId": "base-studio-code", "role": "composite",
                "provides": "@/shared/lib/thing", "src": "src/shared/lib/thing.ts",
                "srcText": BODY, "folder": "shared",
            })
            .to_string(),
        );
        let algos = s.repo().join("src-tauri/data/knowledge/algorithms.json");
        let before = std::fs::read_to_string(&algos).expect("read");

        let (res, out) = s.run(&["promote-seed", "--repo", &root]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("+ component shared/lib/thing.ts"), "{out}");
        assert!(out.contains("(dry run"), "{out}");
        assert!(!s.repo().join("src-tauri/data/components/app/shared/thing.json").exists());
        assert_eq!(std::fs::read_to_string(&algos).expect("read"), before, "the seed document moved");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view<'a>(id: &'a str, source: &'a str) -> RecordView<'a> {
        RecordView { id, kind: "component", role: None, page_kind: None, source }
    }
    fn no_pages(_: &str) -> bool {
        false
    }
    fn all_resolvable(_: &str) -> bool {
        true
    }
    fn no_imports(_: &str) -> Vec<String> {
        Vec::new()
    }

    const FILE: &str = "export const a = 1;\n";

    /// NON-VACUITY: a record that IS its file promotes. Every refusal below could otherwise be satisfied
    /// by a gate that refuses everything.
    #[test]
    fn a_record_that_matches_its_file_is_promotable() {
        let v = view("a", FILE);
        assert_eq!(classify(false, Some(&v), FILE, &no_pages, &all_resolvable, &no_imports), Ok(()));
    }

    #[test]
    fn an_already_seeded_specifier_and_a_missing_record_are_both_skipped() {
        let v = view("a", FILE);
        assert_eq!(
            classify(true, Some(&v), FILE, &no_pages, &all_resolvable, &no_imports),
            Err(Skip::AlreadySeeded)
        );
        assert_eq!(
            classify(false, None, FILE, &no_pages, &all_resolvable, &no_imports),
            Err(Skip::NoRecord)
        );
    }

    /// `import.meta.glob` is a VITE transform: esbuild emits it verbatim and it is not a function at
    /// runtime, so the record throws the moment a graph consumer evaluates it.
    #[test]
    fn a_build_time_glob_is_skipped() {
        let src = "const all = import.meta.glob(\"./*.ts\");\nexport const a = 1;\n";
        let v = view("a", src);
        assert_eq!(
            classify(false, Some(&v), src, &no_pages, &all_resolvable, &no_imports),
            Err(Skip::BuildTimeOnly)
        );
    }

    /// ...but PROSE ABOUT THE RULE MUST NOT TRIP THE RULE. `graphPlatform.ts` was classified build-time
    /// only because a comment in it explains that another module is an `import.meta.glob` module.
    /// Writing down why something is floor should not make the writer floor too.
    #[test]
    fn a_comment_mentioning_the_glob_does_not_trip_the_rule() {
        let src = "// `blueprintBuiltins` is an import.meta.glob module, so it is floor.\nexport const a = 1;\n";
        assert!(!is_build_time_only(src), "a COMMENT must not classify the module");
        let v = view("a", src);
        assert_eq!(classify(false, Some(&v), src, &no_pages, &all_resolvable, &no_imports), Ok(()));
        // ...and the real thing still trips it, so the blanking is not just disabling the check.
        assert!(is_build_time_only("const x = import.meta.glob('./*');"));
    }

    /// A `role: page` record is an APP SCREEN to `shadowPages.test.ts`, which demands every one be
    /// catalogued — so promoting an uncatalogued page fails the suite.
    #[test]
    fn an_uncatalogued_page_record_is_skipped_and_a_catalogued_one_is_not() {
        let v = RecordView { id: "glancepage", kind: "component", role: Some("page"), page_kind: None, source: FILE };
        assert_eq!(
            classify(false, Some(&v), FILE, &no_pages, &all_resolvable, &no_imports),
            Err(Skip::PageNotCatalogued("glancepage".into()))
        );
        let catalogued = |id: &str| id == "glancepage";
        assert_eq!(classify(false, Some(&v), FILE, &catalogued, &all_resolvable, &no_imports), Ok(()));
    }

    /// ...and a KIT template is exempt, for the same reason the guard exempts it: it has no workspace to
    /// catalogue.
    #[test]
    fn a_kit_page_record_is_exempt_from_the_catalogue() {
        let v = RecordView {
            id: "kittemplate", kind: "component", role: Some("page"), page_kind: Some("kit"), source: FILE,
        };
        assert_eq!(classify(false, Some(&v), FILE, &no_pages, &all_resolvable, &no_imports), Ok(()));
    }

    #[test]
    fn an_unresolvable_import_is_skipped_but_a_loader_answered_one_is_not() {
        let v = view("a", FILE);
        let imports = |_: &str| {
            ["@/app/chrome/Titlebar", "@/styles/tokens.css", "@/x/y?raw", "./sibling"]
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>()
        };
        let none_resolvable = |_: &str| false;
        // ONLY the bare `@/` specifier counts: `.css` and `?raw` are answered by the LOADER, and a
        // relative path is not a `@/` specifier at all.
        assert_eq!(
            classify(false, Some(&v), FILE, &no_pages, &none_resolvable, &imports),
            Err(Skip::Unresolvable(vec!["@/app/chrome/Titlebar".to_string()]))
        );
    }

    /// THE BODY GATE, with the SIGNED delta an adjudicator needs — direction is the first thing they
    /// want, and the one thing a name cannot carry.
    #[test]
    fn a_record_that_is_not_its_file_is_skipped_with_a_signed_delta() {
        let bigger = "export const a = 1;\nexport const b = 2;\n";
        let v = view("a", bigger);
        let e = classify(false, Some(&v), FILE, &no_pages, &all_resolvable, &no_imports).unwrap_err();
        let Skip::BodyDiffers { record_len, file_len, delta } = e else { panic!("{e:?}") };
        assert!(record_len > file_len);
        assert_eq!(delta, record_len as isize - file_len as isize);
        assert!(delta > 0, "a record LARGER than its file reports a positive delta");

        // ...and the other direction reports a negative one.
        let v2 = view("a", "export const a = 1;\n");
        let e2 = classify(false, Some(&v2), bigger, &no_pages, &all_resolvable, &no_imports).unwrap_err();
        let Skip::BodyDiffers { delta, .. } = e2 else { panic!("{e2:?}") };
        assert!(delta < 0);
    }

    #[test]
    fn spec_of_strips_the_extension_and_a_trailing_index() {
        assert_eq!(spec_of("app/App.tsx"), "@/app/App");
        assert_eq!(spec_of("features/x/index.ts"), "@/features/x");
        assert_eq!(spec_of("shared/lib/a.ts"), "@/shared/lib/a");
        // `indexed.ts` merely ends with the letters.
        assert_eq!(spec_of("features/x/indexed.ts"), "@/features/x/indexed");
    }

    /// `.d.ts` is AMBIENT TYPE INFORMATION, not a module — and nothing downstream can catch its
    /// retirement, because there is no importer to break.
    #[test]
    fn is_module_excludes_ambient_types_and_tests() {
        assert!(is_module("app/App.tsx") && is_module("shared/lib/a.ts"));
        assert!(!is_module("vite-env.d.ts"), "an ambient declaration is not a module");
        assert!(!is_module("a.test.ts") && !is_module("a.spec.tsx"));
        assert!(!is_module("styles/tokens.css"));
    }

    /// A seed carries CONTENT, not provenance — writing the raw store record put 98 lines of one
    /// component's local edit history into the file.
    #[test]
    fn project_keeps_only_the_seed_fields_and_drops_provenance() {
        let rec = serde_json::json!({
            "id": "a", "name": "A", "kitId": "k", "srcText": "x",
            "rev": 12, "updatedAt": "now", "updatedBy": "someone", "history": [1, 2],
            "builtin": true, "seedHash": "deadbeef",
        });
        let out = project(&rec, &SEED_FIELDS);
        let o = out.as_object().expect("object");
        assert!(o.contains_key("id") && o.contains_key("srcText"));
        for gone in ["rev", "updatedAt", "updatedBy", "history", "builtin", "seedHash"] {
            assert!(!o.contains_key(gone), "{gone} is provenance and must not reach the seed");
        }
    }
}
