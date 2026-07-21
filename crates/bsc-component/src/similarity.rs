//! Fuzzy component similarity (#3544) — the "document distance" layer over the whole library that
//! surfaces NEAR-duplicates the exact detectors in [`crate::graph_health`] miss. Those detectors are
//! per-kit and exact — two components sharing a `wraps` intrinsic, or byte-identical `srcText`. That
//! leaves the interesting cases invisible: `Donut`≈`DonutChart`, `Bars`≈`BarChart`, `Legend`≈`ChartLegend`,
//! and cross-kit `Card`/`Grid`/`KeyValueList` repeats a growing multi-kit library accumulates.
//!
//! Two layers, matching the "compare names, then components" design (#3544):
//!   1. **name distance** — normalized token-set overlap × normalized edit distance ([`name_similarity`]).
//!      Cheap; runs over every pair. `Chart`/`View`/`Bsc` noise affixes are stripped and names singularized
//!      so `Bars`/`BarChart`, `Donut`/`DonutChart` collapse onto their meaningful token.
//!   2. **contract/body distance** — Jaccard over prop signatures (`name:type`), variants, and `composes`,
//!      a role-match bonus, and a k-gram shingle cosine over the source text ([`contract_similarity`]).
//!
//! The overall score is `0.5·name + 0.5·contract`; a pair above the threshold becomes a `near-duplicate`
//! finding. **PROPOSE-ONLY**: this feeds `bsc ui dupes` / `bsc ui similar` and a `near-duplicate` doctor
//! finding, but is deliberately OUTSIDE `graph_health::analyze_with` and the `--fix` merge/prune planners,
//! so `doctor --fix` never auto-merges a near-duplicate — only the byte-identical `merge_plan` auto-merges.
//! A human (or the designer session) decides each merge.
//!
//! Pure + no I/O — input is the parsed component records, output is data. Unit-tested directly.

use crate::graph_health::Finding;
use serde_json::Value;
use std::collections::BTreeSet;

/// The default overall-similarity threshold for a `near-duplicate` finding. Calibrated so an exact
/// cross-kit name+contract match (`Card` in two kits) and a stripped-affix pair (`Donut`/`DonutChart`)
/// clear it, while a mere name coincidence with an unrelated contract (`Button` vs `Card`) does not.
pub const DEFAULT_THRESHOLD: f64 = 0.55;

/// Below this NAME similarity a pair is never even contract-scored — the cheap first pass that keeps the
/// all-pairs sweep O(n²) trivial (a name gate, not the final bar). `LineArea`/`LineChart` (share `line`)
/// clears it; two unrelated names do not.
const NAME_GATE: f64 = 0.34;

/// A NAME similarity at or above this flags the pair on its own — the "same concept, DIFFERENT
/// implementation" case (`Donut` vs `DonutChart` built two different ways: name ~1.0, contract ~0.0). Those
/// score below [`DEFAULT_THRESHOLD`] on the balanced measure, yet they are the prime REFACTOR opportunity
/// the report exists to surface, so a strong-enough name is sufficient on its own.
const HIGH_NAME_MATCH: f64 = 0.85;

/// Above this CONTRACT similarity a strong-name pair reads as a likely DUPLICATE (bodies overlap too);
/// below it, as the same concept implemented differently — a refactor opportunity.
const DUPLICATE_CONTRACT: f64 = 0.5;

/// A component projected to the fields similarity needs, with the per-record derivations (name tokens,
/// source shingles) precomputed ONCE so the all-pairs sweep only does set math.
struct Comp {
    id: String,
    name: String,
    kit: String,
    role: String,
    used: i64,
    /// Fields the EXACT detectors ([`crate::graph_health`]) already key on — a pair matching either is
    /// skipped here so the fuzzy layer never re-reports an exact duplicate.
    wraps: String,
    src_text: String,
    /// Whether the component has a buildable implementation (own `source`, or a real-module `srcText`) —
    /// the canonical-keeper tiebreak prefers the one that actually builds.
    buildable: bool,
    prop_sig: BTreeSet<String>,
    variants: BTreeSet<String>,
    composes: BTreeSet<String>,
    src_shingles: BTreeSet<String>,
}

fn s(v: &Value, key: &str) -> String {
    v.get(key).and_then(Value::as_str).unwrap_or_default().to_string()
}

fn str_array(v: &Value, key: &str) -> BTreeSet<String> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_lowercase())).collect())
        .unwrap_or_default()
}

/// Split a component name into normalized tokens: break camelCase / PascalCase / kebab / snake, lowercase,
/// drop the noise affixes that carry no identity (`bsc` vendor prefix, `chart`/`view` role suffixes), and
/// trivially singularize (trailing `s` on a 4+-char token). So `BscBarChart` → {bar}, `Donut`/`DonutChart`
/// → {donut}, `HBars` → {h, bar}. Returns a SET (order-free — `TabsPanel` and `PanelTabs` collapse).
pub fn normalize_tokens(name: &str) -> BTreeSet<String> {
    const NOISE: [&str; 3] = ["bsc", "chart", "view"];
    let chars: Vec<char> = name.chars().collect();
    let mut raw: Vec<String> = Vec::new();
    let mut cur = String::new();
    for i in 0..chars.len() {
        let ch = chars[i];
        if !ch.is_alphanumeric() {
            if !cur.is_empty() {
                raw.push(std::mem::take(&mut cur));
            }
            continue;
        }
        // A token boundary before an uppercase letter, covering both camelCase (`aB` → a|B) and the
        // acronym→word case (`HBar` → H|Bar, `XMLParser` → XML|Parser: the last upper before a lower).
        let prev = i.checked_sub(1).map(|p| chars[p]);
        let next = chars.get(i + 1).copied();
        let boundary = ch.is_uppercase()
            && match prev {
                Some(p) if p.is_lowercase() || p.is_numeric() => true,
                Some(p) if p.is_uppercase() && next.is_some_and(char::is_lowercase) => true,
                _ => false,
            };
        if boundary && !cur.is_empty() {
            raw.push(std::mem::take(&mut cur));
        }
        cur.push(ch.to_ascii_lowercase());
    }
    if !cur.is_empty() {
        raw.push(cur);
    }
    raw.into_iter()
        .filter(|t| !NOISE.contains(&t.as_str()))
        .map(|t| {
            if t.len() >= 4 && t.ends_with('s') {
                t[..t.len() - 1].to_string()
            } else {
                t
            }
        })
        .filter(|t| !t.is_empty())
        .collect()
}

/// Jaccard overlap of two sets: `|a∩b| / |a∪b|`, in `[0,1]`. `None` when BOTH are empty (no signal —
/// so the caller can drop the term rather than count two feature-less components as identical).
fn jaccard(a: &BTreeSet<String>, b: &BTreeSet<String>) -> Option<f64> {
    if a.is_empty() && b.is_empty() {
        return None;
    }
    let inter = a.intersection(b).count() as f64;
    let union = a.union(b).count() as f64;
    Some(if union == 0.0 { 0.0 } else { inter / union })
}

/// Levenshtein edit distance (two-row DP).
fn levenshtein(a: &str, b: &str) -> usize {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j + 1] + 1).min(cur[j] + 1).min(prev[j] + cost);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// Normalized edit-distance similarity of two strings: `1 - lev/maxlen`, in `[0,1]`.
fn edit_ratio(a: &str, b: &str) -> f64 {
    let max = a.chars().count().max(b.chars().count());
    if max == 0 {
        return 1.0;
    }
    1.0 - (levenshtein(a, b) as f64 / max as f64)
}

/// Name similarity in `[0,1]` — `0.6·token-set-Jaccard + 0.4·edit-ratio` over the NORMALIZED name (noise
/// affixes stripped, singularized). Token overlap is the primary signal (`Donut`/`DonutChart` → 1.0); the
/// edit ratio rescues single-token near-spellings the token set would score 0 (`Colour`/`Color`). Falls
/// back to the raw lowercased edit ratio when normalization empties a name.
pub fn name_similarity(a: &str, b: &str) -> f64 {
    let (ta, tb) = (normalize_tokens(a), normalize_tokens(b));
    let joined = |t: &BTreeSet<String>| t.iter().cloned().collect::<Vec<_>>().join("");
    let (na, nb) = (joined(&ta), joined(&tb));
    let token = match jaccard(&ta, &tb) {
        Some(v) => v,
        None => return edit_ratio(&a.to_lowercase(), &b.to_lowercase()),
    };
    0.6 * token + 0.4 * edit_ratio(&na, &nb)
}

/// k-gram (k=3) shingles over the source's identifier/word tokens — the body's "document" fingerprint,
/// so two components with the same shape score high even when a few tokens differ. Empty when the source
/// has fewer than 3 tokens (a snippet/spec — no body signal).
fn source_shingles(src: &str) -> BTreeSet<String> {
    let toks: Vec<String> = src
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_lowercase())
        .collect();
    if toks.len() < 3 {
        return BTreeSet::new();
    }
    toks.windows(3).map(|w| w.join(" ")).collect()
}

fn parse(v: &Value) -> Option<Comp> {
    let id = v.get("id").and_then(Value::as_str).filter(|s| !s.is_empty())?.to_string();
    let name = {
        let n = s(v, "name");
        if n.is_empty() { id.clone() } else { n }
    };
    let src_text = s(v, "srcText");
    let source = s(v, "source");
    let prop_sig = v
        .get("props")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let pn = p.get("name").and_then(Value::as_str)?.to_lowercase();
                    let ty = p.get("type").and_then(Value::as_str).unwrap_or_default().to_lowercase();
                    Some(format!("{pn}:{ty}"))
                })
                .collect()
        })
        .unwrap_or_default();
    Some(Comp {
        src_shingles: source_shingles(if source.is_empty() { &src_text } else { &source }),
        buildable: !source.trim().is_empty() || crate::graph_health::looks_buildable_module(&src_text),
        id,
        name,
        kit: s(v, "kitId"),
        role: {
            let r = s(v, "role");
            if r.is_empty() { "primitive".to_string() } else { r }
        },
        used: v.get("used").and_then(Value::as_i64).unwrap_or(0),
        wraps: s(v, "wraps"),
        src_text,
        prop_sig,
        variants: str_array(v, "variants"),
        composes: str_array(v, "composes"),
    })
}

/// Contract/body similarity of two parsed components in `[0,1]` — a weighted mean over the terms that carry
/// signal: prop-signature Jaccard, source-shingle Jaccard, `composes` Jaccard, variant Jaccard, and a
/// same-role bonus. A term with no signal on EITHER side (both prop sets empty, etc.) is DROPPED, not
/// scored 0, so two prop-less primitives aren't called identical just for lacking props.
fn contract_score(a: &Comp, b: &Comp) -> f64 {
    let mut num = 0.0;
    let mut den = 0.0;
    let mut add = |w: f64, v: Option<f64>| {
        if let Some(v) = v {
            num += w * v;
            den += w;
        }
    };
    add(0.35, jaccard(&a.prop_sig, &b.prop_sig));
    add(0.35, jaccard(&a.src_shingles, &b.src_shingles));
    add(0.15, jaccard(&a.composes, &b.composes));
    add(0.10, jaccard(&a.variants, &b.variants));
    // Role always carries signal (every component has one).
    add(0.05, Some(if a.role == b.role { 1.0 } else { 0.0 }));
    if den == 0.0 {
        0.0
    } else {
        num / den
    }
}

/// Contract/body similarity of two component records in `[0,1]` (the public, record-level entry — see
/// [`contract_score`]). Returns 0 if either record has no parseable id.
pub fn contract_similarity(a: &Value, b: &Value) -> f64 {
    match (parse(a), parse(b)) {
        (Some(a), Some(b)) => contract_score(&a, &b),
        _ => 0.0,
    }
}

/// The scored similarity of one pair.
struct Scored {
    name: f64,
    contract: f64,
    overall: f64,
}

/// Score a pair, applying the cheap name gate first: a pair whose NAME similarity is below [`NAME_GATE`]
/// is never contract-scored and returns `None` (the O(n²) sweep does real work only on name-near pairs).
fn score(a: &Comp, b: &Comp) -> Option<Scored> {
    let name = name_similarity(&a.name, &b.name);
    if name < NAME_GATE {
        return None;
    }
    let contract = contract_score(a, b);
    Some(Scored { name, contract, overall: 0.5 * name + 0.5 * contract })
}

/// Is this pair ALREADY reported by the exact `duplicate` detector (`graph_health`) — same non-empty
/// `wraps`, or byte-identical non-empty `srcText`? The fuzzy layer skips those so it never double-reports.
fn exactly_caught(a: &Comp, b: &Comp) -> bool {
    (!a.wraps.is_empty() && a.wraps == b.wraps)
        || (!a.src_text.trim().is_empty() && a.src_text == b.src_text)
}

/// Pick the canonical keeper of a near-duplicate pair: the more-used one, breaking ties toward the one
/// that actually builds, then the shorter (usually more canonical) name. Returns `(keeper, loser)`.
fn canonical<'a>(a: &'a Comp, b: &'a Comp) -> (&'a Comp, &'a Comp) {
    let a_key = (a.used, a.buildable, std::cmp::Reverse(a.name.len()));
    let b_key = (b.used, b.buildable, std::cmp::Reverse(b.name.len()));
    if a_key >= b_key {
        (a, b)
    } else {
        (b, a)
    }
}

fn kit_label(a: &Comp, b: &Comp) -> String {
    if a.kit == b.kit {
        a.kit.clone()
    } else {
        format!("{} ↔ {}", a.kit, b.kit)
    }
}

/// Library-wide near-duplicate findings (#3544) — every component pair scoring at or above `threshold`,
/// EXCLUDING pairs the exact `duplicate` detector already catches. Cross-kit by design (the whole point is
/// consolidating overlapping kits). PROPOSE-ONLY: emitted here, never fed to the `--fix` planners. Ranked
/// most-similar first.
pub fn near_duplicate_findings(components: &[Value], threshold: f64) -> Vec<Finding> {
    let comps: Vec<Comp> = components.iter().filter_map(parse).collect();
    let mut scored: Vec<(f64, Finding)> = Vec::new();
    for i in 0..comps.len() {
        for j in (i + 1)..comps.len() {
            let (a, b) = (&comps[i], &comps[j]);
            if exactly_caught(a, b) {
                continue;
            }
            let Some(sc) = score(a, b) else { continue };
            // Flag when the combined signal clears the bar, OR when the NAME alone is a strong same-concept
            // match — a high-name / low-contract pair (`Donut` vs `DonutChart`, built differently) is the
            // "duplicate concept, different implementation" refactor opportunity, even with disjoint bodies.
            if sc.overall < threshold && sc.name < HIGH_NAME_MATCH {
                continue;
            }
            let (keeper, loser) = canonical(a, b);
            let keeper_why = if keeper.used > loser.used {
                "more used"
            } else if keeper.buildable && !loser.buildable {
                "the one with a buildable implementation"
            } else {
                "the more canonical name"
            };
            // Bodies overlap too ⇒ a likely DUPLICATE; name matches but bodies diverge ⇒ the same concept
            // implemented differently ⇒ a REFACTOR opportunity.
            let kind = if sc.contract >= DUPLICATE_CONTRACT {
                "likely duplicates"
            } else {
                "the same concept implemented differently — a refactor opportunity"
            };
            // Rank refactor pairs by their strong signal (the name), true duplicates by the combined score,
            // so a name-1.0 / contract-0.0 pair isn't buried beneath weaker balanced matches.
            let rank = sc.overall.max(if sc.name >= HIGH_NAME_MATCH { sc.name } else { 0.0 });
            scored.push((
                rank,
                Finding {
                    category: "near-duplicate",
                    severity: 3,
                    kit: kit_label(a, b),
                    node_ids: vec![a.id.clone(), b.id.clone()],
                    node_names: vec![a.name.clone(), b.name.clone()],
                    why: format!(
                        "`{}` ({}) and `{}` ({}): name {:.0}% / contract {:.0}% — {kind}",
                        a.name, a.kit, b.name, b.kit, sc.name * 100.0, sc.contract * 100.0
                    ),
                    suggested_action: format!(
                        "propose merging `{}` into `{}` ({keeper_why}); inspect with `bsc ui similar {}` — NOT auto-fixed (propose-only)",
                        loser.name, keeper.name, keeper.id
                    ),
                },
            ));
        }
    }
    // Most-similar first; stable id tiebreak so the order is deterministic across runs.
    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.node_ids.cmp(&b.1.node_ids))
    });
    scored.into_iter().map(|(_, f)| f).collect()
}

/// One ranked "similar to X" row for `bsc ui similar <id>` — the other component + the sub-scores.
pub fn rank_similar(target_id: &str, components: &[Value], top: usize, floor: f64) -> Vec<Value> {
    let comps: Vec<Comp> = components.iter().filter_map(parse).collect();
    let Some(target) = comps.iter().find(|c| c.id == target_id) else {
        return Vec::new();
    };
    let mut rows: Vec<(f64, Value)> = comps
        .iter()
        .filter(|c| c.id != target_id)
        .filter_map(|c| {
            let sc = score(target, c)?;
            if sc.overall < floor {
                return None;
            }
            Some((
                sc.overall,
                serde_json::json!({
                    "id": c.id,
                    "name": c.name,
                    "kit": c.kit,
                    "score": (sc.overall * 100.0).round() / 100.0,
                    "name_similarity": (sc.name * 100.0).round() / 100.0,
                    "contract_similarity": (sc.contract * 100.0).round() / 100.0,
                }),
            ))
        })
        .collect();
    rows.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1["id"].as_str().cmp(&b.1["id"].as_str()))
    });
    rows.into_iter().take(top).map(|(_, v)| v).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn comp(id: &str, name: &str, kit: &str, props: &[&str], src: &str) -> Value {
        json!({
            "id": id, "name": name, "kitId": kit, "role": "composite",
            "props": props.iter().map(|p| json!({ "name": p, "type": "any" })).collect::<Vec<_>>(),
            "variants": [], "composes": [], "srcText": src,
        })
    }

    #[test]
    fn normalize_strips_noise_and_singularizes() {
        assert_eq!(normalize_tokens("BscBarChart"), BTreeSet::from(["bar".to_string()]));
        assert_eq!(normalize_tokens("Donut"), normalize_tokens("DonutChart"));
        assert_eq!(normalize_tokens("HBars"), BTreeSet::from(["h".to_string(), "bar".to_string()]));
        // A structurally-different name shares no token.
        assert!(normalize_tokens("Button").is_disjoint(&normalize_tokens("Card")));
    }

    #[test]
    fn name_similarity_high_for_affix_variants_low_for_unrelated() {
        assert!(name_similarity("Donut", "DonutChart") > 0.9);
        assert!(name_similarity("Bars", "BarChart") > 0.9);
        assert!(name_similarity("Legend", "ChartLegend") > 0.9);
        assert!(name_similarity("Card", "Card") > 0.99); // exact cross-kit repeat
        assert!(name_similarity("Button", "Card") < 0.3);
        // Two DIFFERENT charts don't collide once `Chart` is stripped.
        assert!(name_similarity("BarChart", "LineChart") < 0.3);
    }

    #[test]
    fn contract_similarity_tracks_shared_props_and_body() {
        let a = comp("a", "Donut", "harvested", &["data", "size"], "export function Donut({ data }) { return data.reduce(x); }");
        let b = comp("b", "DonutChart", "react-d3", &["data", "size"], "export function DonutChart({ data }) { return data.reduce(x); }");
        let c = comp("c", "Button", "react-ui", &["onClick"], "export function Button() { return <button/>; }");
        assert!(contract_similarity(&a, &b) > 0.6);
        assert!(contract_similarity(&a, &c) < 0.4);
    }

    #[test]
    fn near_duplicate_flags_cross_kit_pairs_not_unrelated_ones() {
        let comps = vec![
            comp("donut", "Donut", "harvested", &["data", "size"], "export function Donut({ data }) { return data.reduce(s); }"),
            comp("donutchart", "DonutChart", "react-d3", &["data", "size"], "export function DonutChart({ data }) { return data.reduce(s); }"),
            comp("button", "Button", "react-ui", &["onClick"], "export function Button() { return <button/>; }"),
            comp("card", "Card", "react-ui", &["title"], "export function Card() { return <div/>; }"),
        ];
        let findings = near_duplicate_findings(&comps, DEFAULT_THRESHOLD);
        // Donut ↔ DonutChart is flagged as the top near-duplicate…
        assert!(!findings.is_empty(), "expected at least one near-duplicate");
        let top = &findings[0];
        assert_eq!(top.category, "near-duplicate");
        assert_eq!(top.node_ids, vec!["donut".to_string(), "donutchart".to_string()]);
        assert_eq!(top.kit, "harvested ↔ react-d3");
        // …and no pair involving the unrelated Button/Card is reported.
        for f in &findings {
            assert!(!f.node_ids.contains(&"button".to_string()), "Button should not be a near-duplicate");
        }
    }

    #[test]
    fn flags_a_strong_name_match_with_disjoint_bodies_as_a_refactor_opportunity() {
        // The real-store case (#3544): `Donut` and `DonutChart` share the concept (name → 1.0) but were
        // built completely differently (disjoint props + source → contract ≈ 0). That scores BELOW the
        // balanced threshold, yet it is the prime refactor opportunity — flagged on the strong name alone,
        // and labeled as a refactor (not a duplicate) because the bodies diverge.
        let comps = vec![
            comp("donut", "Donut", "harvested", &["slices", "radius"], "export function Donut({ slices }){ return slices.reduce(a); }"),
            comp("donutchart", "DonutChart", "react-d3", &["series"], "const DonutChart = (p) => arc().innerRadius(p.hole);"),
        ];
        let findings = near_duplicate_findings(&comps, DEFAULT_THRESHOLD);
        assert_eq!(findings.len(), 1, "the strong-name pair should be flagged despite disjoint bodies");
        assert_eq!(findings[0].node_ids, vec!["donut".to_string(), "donutchart".to_string()]);
        assert!(findings[0].why.contains("refactor opportunity"), "why: {}", findings[0].why);
    }

    #[test]
    fn skips_pairs_the_exact_detector_already_catches() {
        // Byte-identical source AND shared wraps → owned by the exact `duplicate` finding, not the fuzzy layer.
        let mut a = comp("a", "Donut", "harvested", &["data"], "export function X(){ return 1; }");
        let mut b = comp("b", "DonutChart", "react-d3", &["data"], "export function X(){ return 1; }");
        a["wraps"] = json!("svg");
        b["wraps"] = json!("svg");
        let findings = near_duplicate_findings(&[a, b], DEFAULT_THRESHOLD);
        assert!(findings.is_empty(), "an exact-duplicate pair must be left to the exact detector");
    }

    #[test]
    fn rank_similar_orders_by_score_and_honors_floor_and_top() {
        let comps = vec![
            comp("donut", "Donut", "harvested", &["data", "size"], "export function Donut({ data }){ return data.reduce(s); }"),
            comp("donutchart", "DonutChart", "react-d3", &["data", "size"], "export function DonutChart({ data }){ return data.reduce(s); }"),
            comp("bars", "Bars", "harvested", &["data"], "export function Bars({ data }){ return data.map(s); }"),
            comp("button", "Button", "react-ui", &["onClick"], "export function Button(){ return <button/>; }"),
        ];
        let rows = rank_similar("donut", &comps, 10, NAME_GATE);
        assert_eq!(rows.first().and_then(|r| r["id"].as_str()), Some("donutchart"));
        // The unrelated Button never clears the name gate → absent.
        assert!(!rows.iter().any(|r| r["id"] == json!("button")));
        // `top` caps the row count.
        assert!(rank_similar("donut", &comps, 1, 0.0).len() <= 1);
        // An unknown id yields nothing (never panics).
        assert!(rank_similar("nope", &comps, 10, 0.0).is_empty());
    }
}
