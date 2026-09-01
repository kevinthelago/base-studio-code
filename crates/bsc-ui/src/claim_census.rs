//! WHICH STORE RECORDS CLAIM A MODULE THEY ARE NOT — the classifier behind `bsc ui census`.
//!
//! Derived from `scripts/lib/claimCensus.mjs`, which was proved equal through a shared fixture and then
//! DELETED along with `census-claims.mjs` when this became `bsc ui census`.
//!
//! THE FIXTURE OUTLIVES THE JS, and its role changes at that moment. While both existed it proved two
//! implementations agreed; now there is only one, so it is the REGRESSION baseline — the exact verdicts
//! the JavaScript produced, which this had to reproduce and must keep reproducing. Its generator went
//! with the module it generated from, because a generator that cannot run is worse than none: it reads
//! as a way to refresh the fixture and is not one.
//!
//! ## Why this is a command and not a number in an issue
//!
//! The population moves every tranche. It was filed against 978 records carrying both `provides` and
//! `src`, of which 244 files still existed and 122 disagreed; re-run on 2026-08-24 it was 936 / 12 / 0 —
//! because 924 of those files have been RETIRED since, and once the file is gone the record IS the module
//! and there is nothing left to disagree with. A number written into an issue is stale before it is read.

/// A record's `provides` claim, judged.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    /// `preview-derivative` · `per-component-lift` · `unknown` · `drops-exports` · `newer-truth`.
    pub kind: String,
    pub why: String,
    /// Only `newer-truth` keeps its claim: same exports, different body is a record that legitimately
    /// IS the module and has simply moved ahead of the file.
    pub keeps_provides: bool,
}

/// Names that mark a record as carrying stand-in DATA its file never had.
fn fake_name() -> &'static regex::Regex {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"\b(?:SAMPLE|MOCK|FAKE|DEMO|STUB|FIXTURE)_[A-Z0-9_]+\b")
            .expect("fake-name pattern")
    })
}

/// Every specifier a source imports FROM, deduped.
///
/// Deliberately looser than [`crate::record_source::runtime_imports`]: this is a similarity signal
/// between two bodies, not a dependency claim anything resolves, so a `from` inside prose costing a
/// false match is cheaper here than the machinery to exclude it.
pub fn imported_specifiers(src: &str) -> std::collections::BTreeSet<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        regex::Regex::new(r#"\bfrom\s+["']([^"']+)["']"#).expect("from pattern")
    });
    re.captures_iter(src).map(|c| c[1].to_string()).collect()
}

/// What a record's `provides` claim really is, given the file it names.
///
/// FIVE VERDICTS IN ORDER, and the order is the judgement:
///
///   1. It defines `SAMPLE_*`/`MOCK_*` data its file does not → a PREVIEW DERIVATIVE. A record that
///      invented its own data to mount standalone is not the module.
///   2. It stops importing something and stands it in locally → also a derivative. Guarded on the record
///      being at least HALF the file's length, so a genuinely tiny record is not read as a stub of a
///      large one merely because it imports less.
///   3. It drops exports AND several records share this file → a PER-COMPONENT LIFT, which is expected:
///      each record exports its own component, and none of them is the whole module.
///   4. Either side re-exports a star → UNKNOWN. The export set cannot be enumerated, so no honest
///      verdict is available and a guess would be worse than an admission.
///   5. It drops exports otherwise → DROPS-EXPORTS.
///
/// Anything left is `newer-truth` — same exports, different body — the one verdict that keeps its claim.
pub fn classify(
    record_src: &str,
    file_src: &str,
    file_exports: Option<&std::collections::BTreeSet<String>>,
    record_exports: Option<&std::collections::BTreeSet<String>>,
    shares_src: usize,
) -> Verdict {
    let file_imports = imported_specifiers(file_src);
    let rec_imports = imported_specifiers(record_src);
    let dropped: Vec<&String> = file_imports.iter().filter(|s| !rec_imports.contains(*s)).collect();

    if fake_name().is_match(record_src) && !fake_name().is_match(file_src) {
        return Verdict {
            kind: "preview-derivative".to_string(),
            why: "defines SAMPLE/MOCK data its file does not".to_string(),
            keeps_provides: false,
        };
    }
    // `>= half` uses the JS's own comparison on UTF-16 lengths; both sides are source text, so the
    // ordering this produces is the same one the script produced.
    if !dropped.is_empty()
        && record_src.encode_utf16().count() * 2 >= file_src.encode_utf16().count()
    {
        let named: Vec<&str> = dropped.iter().take(3).map(|s| s.as_str()).collect();
        return Verdict {
            kind: "preview-derivative".to_string(),
            why: format!("stops importing {} and stands it in locally", named.join(", ")),
            keeps_provides: false,
        };
    }

    let drops: Option<Vec<String>> = match (file_exports, record_exports) {
        (Some(f), Some(r)) => Some(f.iter().filter(|n| !r.contains(*n)).cloned().collect()),
        _ => None,
    };

    if let Some(d) = &drops {
        if !d.is_empty() && shares_src > 1 {
            return Verdict {
                kind: "per-component-lift".to_string(),
                why: format!("{shares_src} records share this file; exporting only its own is expected"),
                keeps_provides: false,
            };
        }
    }
    let Some(drops) = drops else {
        return Verdict {
            kind: "unknown".to_string(),
            why: "a star export means the exports cannot be enumerated".to_string(),
            keeps_provides: false,
        };
    };
    if !drops.is_empty() {
        return Verdict {
            kind: "drops-exports".to_string(),
            why: format!("the file exports {} and the record does not", drops.join(", ")),
            keeps_provides: false,
        };
    }
    Verdict {
        kind: "newer-truth".to_string(),
        why: "same exports, different body".to_string(),
        keeps_provides: true,
    }
}

/// The census totals: how many of each kind, and how many must lose their claim.
pub fn summarize(verdicts: &[Verdict]) -> (usize, std::collections::BTreeMap<String, usize>, usize) {
    let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    for v in verdicts {
        *counts.entry(v.kind.clone()).or_insert(0) += 1;
    }
    let should_drop = verdicts.iter().filter(|v| !v.keeps_provides).count();
    (verdicts.len(), counts, should_drop)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// The FROZEN baseline. There is no `UPDATE_FIXTURES` path any more — the JS it was captured from is
    /// deleted — so a failure here means this implementation changed what the census decides, which is a
    /// decision to argue for rather than a fixture to regenerate.
    fn fixture() -> Value {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src/shared/lib/runtime/shadow/claimCensus.fixtures.json");
        let body = std::fs::read_to_string(&p)
            .unwrap_or_else(|e| panic!("{}: {e} — the frozen census baseline is missing", p.display()));
        serde_json::from_str(&body).expect("valid JSON")
    }

    fn set(v: &Value) -> Option<std::collections::BTreeSet<String>> {
        v.as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect())
    }

    #[test]
    fn classify_matches_the_typescript_verdict_for_verdict() {
        let fx = fixture();
        let cases = fx["cases"].as_array().expect("cases[]");
        assert!(cases.len() >= 8, "thin corpus: {}", cases.len());
        for c in cases {
            let label = c["label"].as_str().unwrap();
            let got = classify(
                c["recordSrc"].as_str().unwrap(),
                c["fileSrc"].as_str().unwrap(),
                set(&c["fileExports"]).as_ref(),
                set(&c["recordExports"]).as_ref(),
                usize::try_from(c["sharesSrc"].as_u64().unwrap()).unwrap(),
            );
            let want = &c["verdict"];
            assert_eq!(got.kind, want["kind"].as_str().unwrap(), "kind — {label}");
            // The WHY is asserted too: it is what the census prints, and it names the specific exports
            // or specifiers a reader acts on. A port reaching the right kind with a different
            // explanation has not reproduced the tool.
            assert_eq!(got.why, want["why"].as_str().unwrap(), "why — {label}");
            assert_eq!(
                got.keeps_provides,
                want["keepsProvides"].as_bool().unwrap(),
                "keepsProvides — {label}"
            );
        }
    }

    #[test]
    fn imported_specifiers_and_the_totals_match_the_typescript() {
        let fx = fixture();
        for c in fx["specs"].as_array().expect("specs[]") {
            let got: Vec<String> = imported_specifiers(c["src"].as_str().unwrap()).into_iter().collect();
            let want: Vec<String> = c["specifiers"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(got, want, "{}", c["label"].as_str().unwrap());
        }

        let verdicts: Vec<Verdict> = fx["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| Verdict {
                kind: c["verdict"]["kind"].as_str().unwrap().to_string(),
                why: c["verdict"]["why"].as_str().unwrap().to_string(),
                keeps_provides: c["verdict"]["keepsProvides"].as_bool().unwrap(),
            })
            .collect();
        let (total, counts, should_drop) = summarize(&verdicts);
        let want = &fx["totals"];
        assert_eq!(total, usize::try_from(want["total"].as_u64().unwrap()).unwrap());
        assert_eq!(
            should_drop,
            usize::try_from(want["shouldDropProvides"].as_u64().unwrap()).unwrap()
        );
        for (k, v) in want["counts"].as_object().unwrap() {
            assert_eq!(counts.get(k).copied().unwrap_or(0), usize::try_from(v.as_u64().unwrap()).unwrap(), "count {k}");
        }
    }

    /// Every verdict kind must appear, and both sides of `keeps_provides`. Two of the five verdicts exist
    /// only to STOP a false accusation — `per-component-lift` and `unknown` — so a corpus that lost
    /// either would let those guards be deleted with everything still green.
    #[test]
    fn the_corpus_covers_every_verdict_and_both_outcomes() {
        let fx = fixture();
        let kinds: std::collections::BTreeSet<&str> = fx["cases"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["verdict"]["kind"].as_str().unwrap())
            .collect();
        for k in
            ["preview-derivative", "per-component-lift", "unknown", "drops-exports", "newer-truth"]
        {
            assert!(kinds.contains(k), "no {k} subject in the corpus");
        }
        let keeps = fx["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["verdict"]["keepsProvides"].as_bool().unwrap())
            .count();
        assert!(keeps >= 2, "nothing survives the census — {keeps}");
        assert!(fx["cases"].as_array().unwrap().len() - keeps >= 4, "nothing is flagged");
    }
}
