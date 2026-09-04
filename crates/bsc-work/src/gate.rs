//! The gate's verdict, and what it means for a change record.
//!
//! PURE — no git, no filesystem, no process. The interesting logic is the classification (which reds
//! are explained, what the exit code should be), and that is the part worth testing against literal
//! inputs rather than against a two-minute build.

use serde::Deserialize;

/// One leg of a gate run, as `scripts/gate.mjs` writes it.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct Leg {
    /// The STABLE id — the same one `record-run.mjs` measures under as `gate:<key>`. Gate evidence is
    /// filed under this, never under `label`, which is prose and gets reworded ("lint" →
    /// "lint (changed files)") without anything being meant by it.
    pub key: String,
    pub label: String,
    pub ok: bool,
    #[serde(default)]
    pub seconds: f64,
    /// The tests that FAILED, when the leg can name them (nextest, via its JUnit report).
    ///
    /// EMPTY MEANS UNKNOWN, NOT NONE, and the distinction decides whether a declaration may excuse
    /// the leg — see [`classify`]. A leg that cannot name its failures (`tsc`, `eslint`) leaves this
    /// empty and is excused by a leg-level declaration as before.
    #[serde(default)]
    pub failures: Vec<String>,
}

/// The whole artifact (`target/gate-result.json`).
#[derive(Debug, Clone, Deserialize)]
pub struct GateResult {
    #[serde(default)]
    pub version: u32,
    /// `"full"` or `"scoped"` — recorded alongside the legs, because a green SCOPED gate and a green
    /// FULL one are different claims and this repo's recurring failure is a gate that passes while
    /// covering less than the reader assumes.
    #[serde(default)]
    pub mode: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub passed: bool,
    #[serde(default)]
    pub legs: Vec<Leg>,
}

/// What one leg turned out to be, once the known-red declarations are applied.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub key: String,
    pub label: String,
    pub ok: bool,
    pub seconds: f64,
    /// The plan ref that owns this leg's failure, when it is declared. Only ever set on a RED leg:
    /// a declaration explains a failure, and attaching one to a green leg would suggest the pass was
    /// somehow conditional.
    pub known_red_owner: Option<String>,
}

impl Verdict {
    /// What goes on the change record. `pass`/`fail` and nothing else — see [`classify`].
    pub fn recorded_result(&self) -> &'static str {
        if self.ok {
            "pass"
        } else {
            "fail"
        }
    }
    /// A red leg nobody has accounted for. This, not the raw red count, is what the exit code follows.
    pub fn is_unexplained(&self) -> bool {
        !self.ok && self.known_red_owner.is_none()
    }
}

/// Apply the known-red declarations to a gate result.
///
/// A DECLARATION EXCUSES THE FAILURE IT NAMES, NOT THE LEG IT LIVES IN.
///
/// It used to be keyed on the leg alone, so any `nextest` red was absorbed by whatever item owned the
/// one known failure in it. MEASURED 2026-09-03: the gate printed `1 red, 1 known-red → 0 unexplained`
/// while the failure was a test that same commit had just broken. `cargo nextest run --no-fail-fast`
/// named it in seven seconds — the information was cheap and the summariser simply did not use it.
/// That is this repo's signature failure (a gate that passes while covering less than the reader
/// assumes) produced by the gate itself, and a worker following the documented flow lands a broken
/// test behind a green-looking footer.
///
/// So when a leg NAMES its failures, every one of them must be declared for the leg to be excused.
/// One undeclared failure alongside a declared one leaves the leg unexplained, which is the whole
/// point: the declared failure was never the question.
///
/// FAILING CLOSED IS DELIBERATE when a leg names nothing. A declaration whose `tests` list is set
/// only excuses failures it can actually match, so an empty `failures` on a leg whose declaration
/// names tests is UNEXPLAINED rather than excused — losing the report must not silently restore the
/// old behaviour. A declaration with no `tests` list stays leg-level, for the legs that genuinely
/// cannot enumerate (`tsc` reports a program, `eslint` a file set).
///
/// THE RECORDED RESULT IS NEVER CHANGED BY A DECLARATION. A leg that failed is recorded `fail`
/// whether or not it is declared, and the declaration only travels alongside as an explanation.
/// Laundering a red into a `pass` would put an untruth in the one store built to be trustworthy —
/// the same "wrong in the safe-looking direction" shape as a wake that reports success after killing
/// what it could not relaunch. The exit code is where a declaration is allowed to have an effect,
/// because that is a statement about THIS run rather than a durable record of it.
pub fn classify(result: &GateResult, known_red: &plandb::known_red::KnownRed) -> Vec<Verdict> {
    result
        .legs
        .iter()
        .map(|l| Verdict {
            key: l.key.clone(),
            label: l.label.clone(),
            ok: l.ok,
            seconds: l.seconds,
            known_red_owner: if l.ok { None } else { owner_for(l, known_red) },
        })
        .collect()
}

/// The plan ref that accounts for this red leg, if any. See [`classify`] for the rules.
fn owner_for(l: &Leg, known_red: &plandb::known_red::KnownRed) -> Option<String> {
    let decl = known_red.get(&l.key)?;
    let owner = decl.get("ref").and_then(|v| v.as_str())?.to_string();
    let declared: Vec<&str> = decl
        .get("tests")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|t| t.as_str()).collect())
        .unwrap_or_default();

    // No `tests` on the declaration ⇒ leg-level, as before. The legs that cannot enumerate their
    // failures still need a way to be accounted for.
    if declared.is_empty() {
        return Some(owner);
    }
    // The declaration names tests but the leg named none: fail CLOSED. A missing report must not
    // silently restore the behaviour this exists to remove.
    if l.failures.is_empty() {
        return None;
    }
    // EVERY failure must be declared. One undeclared failure beside a declared one is exactly the
    // case that shipped a broken test behind a green footer.
    l.failures
        .iter()
        .all(|f| declared.iter().any(|d| f == d || f.ends_with(d)))
        .then_some(owner)
}

/// `(red, known-red, unexplained)` — the split the summary line states out loud.
///
/// Stated rather than implied because the exit code does not follow the red count, and a reader who
/// assumed it did would draw the wrong conclusion from a zero exit.
pub fn tally(verdicts: &[Verdict]) -> (usize, usize, usize) {
    let red = verdicts.iter().filter(|v| !v.ok).count();
    let known = verdicts.iter().filter(|v| !v.ok && v.known_red_owner.is_some()).count();
    (red, known, red - known)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn res(legs: &[(&str, bool)]) -> GateResult {
        GateResult {
            version: 1,
            mode: "full".into(),
            reason: "--full requested".into(),
            passed: legs.iter().all(|(_, ok)| *ok),
            legs: legs
                .iter()
                .map(|(k, ok)| Leg { key: (*k).into(), label: format!("{k} (leg)"), ok: *ok, seconds: 1.0, failures: Vec::new() })
                .collect(),
        }
    }

    fn declared(pairs: &[(&str, &str)]) -> plandb::known_red::KnownRed {
        let mut m = serde_json::Map::new();
        for (leg, owner) in pairs {
            m.insert((*leg).to_string(), json!({ "ref": owner }));
        }
        m
    }

    #[test]
    fn a_declared_red_leg_is_still_recorded_as_a_failure() {
        // THE INVARIANT. A declaration explains a red; it must never launder one into a pass, or the
        // change record — the one store built to be evidence — would carry an untruth.
        let v = classify(&res(&[("graph-store", false)]), &declared(&[("graph-store", "owning-item")]));
        assert_eq!(v[0].recorded_result(), "fail");
        assert_eq!(v[0].known_red_owner.as_deref(), Some("owning-item"));
        assert!(!v[0].is_unexplained(), "it IS explained — that is what the declaration buys");
    }

    #[test]
    fn an_undeclared_red_leg_stays_unexplained() {
        let v = classify(&res(&[("vitest", false)]), &declared(&[("graph-store", "owning-item")]));
        assert_eq!(v[0].recorded_result(), "fail");
        assert_eq!(v[0].known_red_owner, None);
        assert!(v[0].is_unexplained());
    }

    #[test]
    fn a_declaration_never_attaches_to_a_green_leg() {
        // Declaring a leg that then PASSES must read as an ordinary pass. Carrying the owner through
        // would suggest the pass was somehow conditional on it.
        let v = classify(&res(&[("graph-store", true)]), &declared(&[("graph-store", "owning-item")]));
        assert_eq!(v[0].recorded_result(), "pass");
        assert_eq!(v[0].known_red_owner, None);
        assert!(!v[0].is_unexplained());
    }

    #[test]
    fn the_tally_separates_red_from_unexplained() {
        // The number the exit code follows is the LAST one, and it is not the red count — which is
        // exactly why the summary has to state all three rather than leave the reader to infer.
        let v = classify(
            &res(&[("typecheck", true), ("graph-store", false), ("vitest", false)]),
            &declared(&[("graph-store", "owning-item")]),
        );
        assert_eq!(tally(&v), (2, 1, 1));

        let all_explained = classify(&res(&[("graph-store", false)]), &declared(&[("graph-store", "x")]));
        assert_eq!(tally(&all_explained), (1, 1, 0));

        let green = classify(&res(&[("typecheck", true)]), &declared(&[]));
        assert_eq!(tally(&green), (0, 0, 0));
    }

    #[test]
    fn the_artifact_parses_with_fields_missing() {
        // Written by a JS script that may gain fields before this is rebuilt. An older `bsc` must read
        // a newer artifact rather than refusing to record anything at all.
        let r: GateResult = serde_json::from_value(json!({
            "version": 1,
            "legs": [{ "key": "typecheck", "label": "typecheck", "ok": true, "somethingNew": 5 }]
        }))
        .expect("unknown fields and absent ones are both tolerated");
        assert_eq!(r.legs.len(), 1);
        assert_eq!(r.legs[0].seconds, 0.0, "an absent duration reads as 0, never as a failure to parse");
    }
}

/// A declaration excuses the FAILURE it names, not the leg it lives in.
#[cfg(test)]
mod known_red_matches_the_test {
    use super::*;
    use serde_json::json;

    fn leg(key: &str, ok: bool, failures: &[&str]) -> Leg {
        Leg {
            key: key.into(),
            label: key.into(),
            ok,
            seconds: 1.0,
            failures: failures.iter().map(|s| s.to_string()).collect(),
        }
    }
    fn result(legs: Vec<Leg>) -> GateResult {
        GateResult { version: 1, mode: "full".into(), reason: String::new(), passed: false, legs }
    }
    /// `KnownRed` is a JSON map of leg key → declaration.
    fn declare(v: serde_json::Value) -> plandb::known_red::KnownRed {
        serde_json::from_value(v).expect("known-red fixture")
    }

    #[test]
    fn an_undeclared_failure_beside_a_declared_one_is_unexplained() {
        // THE BUG. The gate printed `1 red, 1 known-red → 0 unexplained` while the actual failure was
        // a test that commit had just broken — the declaration was keyed on the leg, so it absorbed
        // everything in it.
        let kr = declare(json!({ "nextest": { "ref": "the-ollama-item", "tests": ["llm::model_probe"] } }));
        let v = classify(
            &result(vec![leg("nextest", false, &["llm::model_probe", "plandb::feature_readiness"])]),
            &kr,
        );
        assert!(v[0].is_unexplained(), "an undeclared failure was absorbed by the declared one");
        assert_eq!(tally(&v), (1, 0, 1));
    }

    #[test]
    fn the_declared_failure_alone_is_still_excused() {
        let kr = declare(json!({ "nextest": { "ref": "the-ollama-item", "tests": ["llm::model_probe"] } }));
        let v = classify(&result(vec![leg("nextest", false, &["llm::model_probe"])]), &kr);
        assert_eq!(v[0].known_red_owner.as_deref(), Some("the-ollama-item"));
        assert_eq!(tally(&v), (1, 1, 0));
    }

    #[test]
    fn a_leg_that_names_no_failures_fails_closed_when_the_declaration_names_tests() {
        // Losing the JUnit report must not silently restore "excuse everything in this leg".
        let kr = declare(json!({ "nextest": { "ref": "the-ollama-item", "tests": ["llm::model_probe"] } }));
        let v = classify(&result(vec![leg("nextest", false, &[])]), &kr);
        assert!(v[0].is_unexplained(), "a leg naming nothing was excused by a test-level declaration");
    }

    #[test]
    fn a_declaration_with_no_tests_stays_leg_level() {
        // `tsc` reports a program and `eslint` a file set — neither can enumerate, and both still
        // need a way to be accounted for.
        let kr = declare(json!({ "typecheck": { "ref": "some-item" } }));
        let v = classify(&result(vec![leg("typecheck", false, &[])]), &kr);
        assert_eq!(v[0].known_red_owner.as_deref(), Some("some-item"));
    }

    #[test]
    fn a_declared_test_matches_by_suffix_so_the_binary_prefix_is_optional() {
        // nextest reports `plandb::validate::tests::foo`; a declaration naming the test alone should
        // still match, because a reader writing one down will not include the crate path.
        let kr = declare(json!({ "nextest": { "ref": "item", "tests": ["validate::tests::foo"] } }));
        let v = classify(&result(vec![leg("nextest", false, &["plandb::validate::tests::foo"])]), &kr);
        assert_eq!(v[0].known_red_owner.as_deref(), Some("item"));
    }

    #[test]
    fn a_green_leg_never_carries_an_owner() {
        let kr = declare(json!({ "nextest": { "ref": "item", "tests": ["a"] } }));
        let v = classify(&result(vec![leg("nextest", true, &[])]), &kr);
        assert_eq!(v[0].known_red_owner, None);
        assert_eq!(v[0].recorded_result(), "pass");
    }

    #[test]
    fn a_declared_red_is_still_recorded_as_a_failure() {
        // Unchanged and load-bearing: laundering a red into a `pass` would put an untruth in the one
        // store built to be trustworthy.
        let kr = declare(json!({ "nextest": { "ref": "item", "tests": ["a"] } }));
        let v = classify(&result(vec![leg("nextest", false, &["a"])]), &kr);
        assert_eq!(v[0].recorded_result(), "fail");
    }
}
