//! LIFT A COMPONENT FILE INTO A MODULE-SHAPED RECORD — `bsc ui lift`, ported from
//! `scripts/lift-component-module.mjs`. The reshape `bsc graph harvest --module` stops one step short of.
//!
//! WHY THIS EXISTS. Roughly 100 `.tsx` have records that are PREVIEW-SHAPED DERIVATIVES: `bsc ui harvest`
//! lifts a COMPONENT, inlining what it cannot reach so the thing mounts standalone in the Design Studio.
//! That is right for previewing and wrong for retirement — and such a record carries no `provides`, so
//! nothing can import the module it stands for.
//!
//! THE LIFT ITSELF IS NOT REIMPLEMENTED HERE. `bsc_graph::extract::harvest_module` already does it, and
//! carries three separately-learned rules a second copy would get wrong: strip the FILE's extension (not
//! one guessed from `tech`, which gave `.tsx` modules a specifier no import writes), strip a trailing
//! `/index` (a directory import resolves to it, and keeping the segment gave 13 barrels an unreachable
//! specifier), and absolutize relative imports (a record resolves against the registry, never a
//! directory). This decides WHETHER to lift and reshapes what comes back.

/// Why one target was not lifted. Every variant is a case where the file must keep doing the work.
#[derive(Debug, PartialEq, Eq)]
pub enum Skip {
    /// The path names nothing on disk.
    NoSuchFile,
    /// No component record points at it, so there is nothing to reshape — author one first.
    NoRecord,
    /// The derived module id already belongs to a DIFFERENT module.
    IdTaken(String),
    /// `harvest_module` returned nothing at all.
    NoCandidate,
    /// The module holds MODULE STATE. Not a judgement call: `provides` beats the platform registry, so a
    /// record of a stateful module vendors a SECOND copy of that state to every consumer — the failure
    /// that made the a11y announcer go silent.
    ModuleState(Vec<String>),
    /// The harvest derived no `provides`, so the record could not answer any specifier.
    NoProvides,
}

impl Skip {
    pub fn reason(&self) -> String {
        match self {
            Self::NoSuchFile => "no such file".into(),
            Self::NoRecord => "no component record points at it (`src`); author one first".into(),
            Self::IdTaken(id) => format!("the module id `{id}` is already taken by a different module"),
            Self::NoCandidate => "the harvest returned no candidate".into(),
            Self::ModuleState(s) => {
                format!("holds MODULE STATE ({}); it must stay a file", s.join(", "))
            }
            Self::NoProvides => "the harvest derived no `provides`".into(),
        }
    }
}

/// What a lift would write.
#[derive(Debug, PartialEq, Eq)]
pub struct Plan {
    /// The record id the module lands on.
    pub module_id: String,
    /// True when a NEW record is authored beside the component ones, rather than one being reshaped.
    pub new_record: bool,
}

/// `features/x/Telemetry.tsx` → `telemetry-module`, or `telemetry-module-src` when the first is taken.
///
/// Derived from the FILE, because that is what it stands for, and suffixed so it can never collide with
/// a component record of the same name.
pub fn module_id_for(rel: &str, taken: &[String]) -> String {
    let stem = rel.rsplit('/').next().unwrap_or(rel);
    let stem = stem.strip_suffix(".tsx").or_else(|| stem.strip_suffix(".ts")).unwrap_or(stem);
    // `([a-z0-9])([A-Z])` → `$1-$2`, then lowercase — camelCase and PascalCase both become kebab.
    let mut kebab = String::with_capacity(stem.len() + 4);
    let chars: Vec<char> = stem.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        if c.is_ascii_uppercase()
            && i > 0
            && (chars[i - 1].is_ascii_lowercase() || chars[i - 1].is_ascii_digit())
        {
            kebab.push('-');
        }
        kebab.extend(c.to_lowercase());
    }
    let base = format!("{kebab}-module");
    if taken.contains(&base) { format!("{kebab}-module-src") } else { base }
}

/// Decide what to do with one target.
///
/// `records` are the component records whose `src` is this file, `all_ids` every record id paired with
/// the `src` it points at, and `candidate` what `harvest_module` returned.
///
/// A FILE WITH SEVERAL COMPONENT RECORDS GETS A NEW ONE, never one of them promoted. Picking silently is
/// what a map keyed by `src` used to do — it kept whichever came last, so `telemetrypanel` became the
/// whole of `telemetry.tsx` while `itembars` and `splitbar` went on claiming their own identity, and a
/// consumer asking for `@/components/splitbar` would have got a module whose export pick is not that
/// component. The two things are genuinely different and the store holds both: `AppBanners.tsx` is NINE
/// banner components AND one module.
pub fn plan(
    rel: &str,
    exists: bool,
    records: &[String],
    all_ids: &[(String, String)],
    force_new: bool,
    candidate: Option<(&str, &[String], Option<&str>)>,
) -> Result<Plan, Skip> {
    if !exists {
        return Err(Skip::NoSuchFile);
    }
    if records.is_empty() {
        return Err(Skip::NoRecord);
    }
    let src_rel = if rel.starts_with("src/") { rel.to_string() } else { format!("src/{rel}") };
    let new_record = records.len() > 1 || force_new;
    // The `-module-src` fallback is checked against THIS FILE'S OWN records, not the whole store: it
    // exists so a module record cannot land on one of its siblings' ids. A store-wide clash is a
    // different question and gets its own refusal below, with a message that says which.
    let module_id = if new_record { module_id_for(rel, records) } else { records[0].clone() };
    if new_record && all_ids.iter().any(|(id, src)| *id == module_id && *src != src_rel) {
        return Err(Skip::IdTaken(module_id));
    }

    let Some((code, module_state, provides)) = candidate else { return Err(Skip::NoCandidate) };
    if code.is_empty() {
        return Err(Skip::NoCandidate);
    }
    if !module_state.is_empty() {
        return Err(Skip::ModuleState(module_state.to_vec()));
    }
    if provides.is_none_or(str::is_empty) {
        return Err(Skip::NoProvides);
    }
    Ok(Plan { module_id, new_record })
}

/// The batch-isolation guarantee, driven through the real verb against a seeded store.
///
/// SEPARATE MODULE because it needs `SeededStore`, which sets `BSC_COMPONENT_DIR` process-wide — the
/// pure tests above must stay free of that.
#[cfg(test)]
mod batch_tests {
    use crate::test_store::SeededStore;

    /// A component record whose `srcText` was last authored by a NAMED writer. Overwriting that with no
    /// `--by` is refused by the store (`refuse_anonymous_src_overwrite`, bsc request #119).
    fn attributed(id: &str, src: &str) -> String {
        serde_json::json!({
            "id": id, "name": id, "kitId": "base-studio-code", "role": "composite",
            "src": src, "srcText": "export function Thing() { return null; }\n",
            "history": [{ "by": "designer", "changed": ["srcText"] }],
        })
        .to_string()
    }

    /// ...and one with no history, so nothing is being overwritten anonymously and the write lands.
    fn plain(id: &str, src: &str) -> String {
        serde_json::json!({
            "id": id, "name": id, "kitId": "base-studio-code", "role": "composite",
            "src": src, "srcText": "export function Thing() { return null; }\n",
        })
        .to_string()
    }

    const BODY: &str = "export function Thing() {\n  return null;\n}\n";

    /// A REFUSED STORE WRITE IS A FINDING, NOT A CRASH. Letting one throw killed a 40-item batch on its
    /// first refusal and lost the other 39, so this asserts BOTH halves: the refusal is reported against
    /// its own target, and every later target in the same batch still lands.
    #[test]
    fn a_refused_write_is_reported_and_the_rest_of_the_batch_still_lands() {
        // SAFETY: per-process env; the gate runs nextest, one process per test.
        unsafe { std::env::remove_var("BSC_UI_WRITER") };
        let s = SeededStore::new("lift-batch");
        s.seed("alpha", &attributed("alpha", "src/a/Alpha.tsx"));
        s.seed("beta", &plain("beta", "src/a/Beta.tsx"));
        s.seed_file("a/Alpha.tsx", BODY);
        s.seed_file("a/Beta.tsx", BODY);

        let repo = s.repo().to_string_lossy().into_owned();
        // NO `--by`: that is what makes the first write unattributed, and so refused.
        let (res, out) = s.run(&["lift", "a/Alpha.tsx", "a/Beta.tsx", "--apply", "--repo", &repo]);
        assert!(res.is_ok(), "one refusal must not fail the whole verb: {res:?}");

        assert!(out.contains("the store REFUSED the write"), "the refusal must be REPORTED: {out}");
        assert!(out.contains("a/Alpha.tsx"), "...against its own target: {out}");
        assert!(
            out.contains("1 component record(s) lifted"),
            "the SECOND target must still have landed: {out}"
        );
        // ...and that is a real write, not just a hopeful line of output. Read back THROUGH THE STORE,
        // never `s.record()`: the store is SQLite-backed and the seeded `.json` files are ingested only
        // on open, so the on-disk seed still says what the test wrote there and would "pass" regardless.
        let get = |id: &str| s.stored(id).unwrap_or_else(|| panic!("{id} is in the store"));
        assert_eq!(get("beta").get("provides").and_then(serde_json::Value::as_str), Some("@/a/Beta"));
        // The refused one kept its original source — a refusal that half-wrote is worse than a crash.
        assert_eq!(
            get("alpha").get("srcText").and_then(serde_json::Value::as_str),
            Some("export function Thing() { return null; }\n"),
            "the refused record must be UNCHANGED"
        );
    }

    /// The dry run writes nothing at all — asserted on the record, not on the absence of a log line.
    #[test]
    fn a_dry_run_writes_nothing_to_the_store() {
        let s = SeededStore::new("lift-dry");
        s.seed("beta", &plain("beta", "src/a/Beta.tsx"));
        s.seed_file("a/Beta.tsx", BODY);
        let repo = s.repo().to_string_lossy().into_owned();

        // Through the store, for the reason the batch test gives: the seeded `.json` on disk is not
        // what a write moves.
        let get = || s.stored("beta").expect("beta is in the store");
        let before = get();
        let (res, out) = s.run(&["lift", "a/Beta.tsx", "--repo", &repo]);
        assert!(res.is_ok(), "{res:?}");
        assert!(out.contains("would lift"), "{out}");
        assert_eq!(get(), before, "a dry run wrote to the store");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cand<'a>() -> Option<(&'a str, &'a [String], Option<&'a str>)> {
        Some(("export const A = 1;\n", &[], Some("@/features/x/telemetry")))
    }
    fn recs(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("rec{i}")).collect()
    }

    /// NON-VACUITY FIRST: an ordinary single-record file lifts, reshaping the record that is already
    /// there. Without this every refusal test below could pass by refusing everything.
    #[test]
    fn a_single_record_file_is_reshaped_in_place() {
        let got = plan("features/x/telemetry.tsx", true, &recs(1), &[], false, cand()).expect("lifts");
        assert_eq!(got, Plan { module_id: "rec0".into(), new_record: false });
    }

    #[test]
    fn a_missing_file_is_skipped() {
        assert_eq!(
            plan("features/x/gone.tsx", false, &recs(1), &[], false, cand()),
            Err(Skip::NoSuchFile)
        );
    }

    #[test]
    fn a_file_no_record_points_at_is_skipped() {
        assert_eq!(plan("features/x/t.tsx", true, &[], &[], false, cand()), Err(Skip::NoRecord));
    }

    /// SEVERAL RECORDS ⇒ A NEW ONE. Promoting one of them would make a component silently become the
    /// whole file while its siblings go on claiming their own identity.
    #[test]
    fn a_file_with_several_records_gets_a_new_module_record() {
        let got = plan("features/x/telemetry.tsx", true, &recs(3), &[], false, cand()).expect("lifts");
        assert_eq!(got, Plan { module_id: "telemetry-module".into(), new_record: true });
    }

    /// ...and `--new-record` forces that path for the case where the single record is not the module
    /// either — adopting it would drop an export the module does not have.
    #[test]
    fn new_record_forces_a_new_module_record_for_a_single_record_file() {
        let got = plan("features/x/telemetry.tsx", true, &recs(1), &[], true, cand()).expect("lifts");
        assert!(got.new_record);
        assert_eq!(got.module_id, "telemetry-module");
    }

    #[test]
    fn a_taken_module_id_on_a_different_module_is_skipped() {
        let all = vec![("telemetry-module".to_string(), "src/elsewhere/other.tsx".to_string())];
        assert_eq!(
            plan("features/x/telemetry.tsx", true, &recs(2), &all, false, cand()),
            Err(Skip::IdTaken("telemetry-module".into()))
        );
    }

    /// ...but the SAME module holding that id is not a clash — a re-run must be idempotent, not refuse
    /// itself on the second pass.
    #[test]
    fn a_module_id_already_held_by_this_same_file_is_not_a_clash() {
        let all = vec![("telemetry-module".to_string(), "src/features/x/telemetry.tsx".to_string())];
        assert!(plan("features/x/telemetry.tsx", true, &recs(2), &all, false, cand()).is_ok());
    }

    /// The fallback reached THROUGH `plan`, not just by calling the deriver: a sibling component record
    /// already holding `telemetry-module` must push the module onto `-module-src` rather than colliding
    /// with it. Wiring the deriver to the wrong list is exactly the bug this pins.
    #[test]
    fn a_sibling_holding_the_base_id_pushes_the_module_onto_the_fallback() {
        let recs = vec!["telemetry-module".to_string(), "itembars".to_string()];
        let got = plan("features/x/telemetry.tsx", true, &recs, &[], false, cand()).expect("lifts");
        assert_eq!(got.module_id, "telemetry-module-src");
    }

    #[test]
    fn no_candidate_and_an_empty_candidate_are_both_skipped() {
        assert_eq!(plan("features/x/t.tsx", true, &recs(1), &[], false, None), Err(Skip::NoCandidate));
        let empty: Option<(&str, &[String], Option<&str>)> = Some(("", &[], Some("@/x")));
        assert_eq!(plan("features/x/t.tsx", true, &recs(1), &[], false, empty), Err(Skip::NoCandidate));
    }

    /// MODULE STATE IS NOT A JUDGEMENT CALL. `provides` beats the platform registry, so a record of a
    /// stateful module vendors a second copy of that state to every consumer — which is what made the
    /// a11y announcer go silent, its vendored subscriber list swallowing every announcement.
    #[test]
    fn a_module_holding_state_is_skipped_and_the_state_is_named() {
        let state = vec!["listeners".to_string(), "done".to_string()];
        let c: Option<(&str, &[String], Option<&str>)> = Some(("export const A = 1;\n", &state, Some("@/x")));
        let e = plan("features/x/t.tsx", true, &recs(1), &[], false, c).expect_err("must skip");
        assert_eq!(e, Skip::ModuleState(state));
        assert!(e.reason().contains("listeners"), "the reason must NAME the state: {}", e.reason());
        assert!(e.reason().contains("must stay a file"), "{}", e.reason());
    }

    #[test]
    fn a_candidate_with_no_provides_is_skipped() {
        for p in [None, Some("")] {
            let c: Option<(&str, &[String], Option<&str>)> = Some(("export const A = 1;\n", &[], p));
            assert_eq!(
                plan("features/x/t.tsx", true, &recs(1), &[], false, c),
                Err(Skip::NoProvides),
                "provides {p:?}"
            );
        }
    }

    #[test]
    fn the_module_id_is_kebab_cased_from_the_file_and_falls_back_on_a_collision() {
        assert_eq!(module_id_for("features/x/AppBanners.tsx", &[]), "app-banners-module");
        assert_eq!(module_id_for("features/x/telemetry.tsx", &[]), "telemetry-module");
        assert_eq!(module_id_for("a/b/useAppBoot.ts", &[]), "use-app-boot-module");
        // A run of capitals is one word, as the JS regex's `[a-z0-9]` lookbehind gives.
        assert_eq!(module_id_for("a/b/HTTPClient.tsx", &[]), "httpclient-module");
        // ...and the collision fallback, which exists so a module record never lands on a component's id.
        assert_eq!(
            module_id_for("features/x/telemetry.tsx", &["telemetry-module".to_string()]),
            "telemetry-module-src"
        );
    }
}
