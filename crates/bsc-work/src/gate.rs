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
            known_red_owner: if l.ok {
                None
            } else {
                known_red
                    .get(&l.key)
                    .and_then(|v| v.get("ref"))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            },
        })
        .collect()
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
                .map(|(k, ok)| Leg { key: (*k).into(), label: format!("{k} (leg)"), ok: *ok, seconds: 1.0 })
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
