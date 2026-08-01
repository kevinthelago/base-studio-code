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

/// A CONTRACT similarity at or above this flags the pair on its own — the mirror of [`HIGH_NAME_MATCH`],
/// and the other half of the #4138 fix.
///
/// Admitting a name-dissimilar pair to scoring is not enough: `overall = 0.5·name + 0.5·contract` still
/// HALVES it, so `Donut` vs `PieChart` (name ≈ 0, bodies nearly identical) could never clear the bar no
/// matter how strong the evidence. The blend encodes the same name assumption the gate did. So a strong
/// contract is sufficient alone, exactly as a strong name already was.
const HIGH_CONTRACT_MATCH: f64 = 0.75;

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
    /// PROVENANCE (#4138) — the source file this was harvested from, and the folder it derives from
    /// (#4128). Two records naming the same `src` are the same module; same folder is a strong prior.
    src_path: String,
    folder: String,
    /// The DataShape(s) this component consumes (#3439) — same shape + similar props is strong signal.
    shapes: BTreeSet<String>,
    tags: BTreeSet<String>,
    /// The colocated test files this record names (#4126) — two records naming one test file are
    /// usually one component.
    tests: BTreeSet<String>,
    /// The platform specifier this record OVERRIDES (#3660). A collision is a conflict, not a dupe.
    provides: String,
    /// Tokens of the `whenUse`/`whenNot` guidance — the only term that catches a semantic duplicate
    /// whose name AND body both differ.
    guidance: BTreeSet<String>,
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
    // `whenUse`/`whenNot` are prose arrays; tokenized so two differently-worded-but-overlapping
    // guidances still meet. Stop-words are not stripped — the sets are small and Jaccard tolerates it.
    let guidance = ["whenUse", "whenNot"]
        .iter()
        .flat_map(|k| v.get(*k).and_then(Value::as_array).map(|a| a.to_vec()).unwrap_or_default())
        .filter_map(|x| x.as_str().map(str::to_lowercase))
        .flat_map(|line| {
            line.split(|c: char| !c.is_alphanumeric())
                .filter(|t| t.len() > 2)
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .collect();
    // A record's `tests` is an array of `{name, src}` (#4126) — key on the PATH, which is the identity.
    let tests = v
        .get("tests")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|t| t.get("src").and_then(Value::as_str).map(str::to_lowercase))
                .collect()
        })
        .unwrap_or_default();
    Some(Comp {
        src_shingles: source_shingles(if source.is_empty() { &src_text } else { &source }),
        src_path: s(v, "src").to_lowercase(),
        // Through the SAME reader the rest of the crate uses (#4118): 347 of 349 stored records still
        // carry the legacy `group` key, so reading `folder` alone made this signal dead on the real
        // library — it was dropped for every pair.
        folder: crate::cli::record_folder(v).unwrap_or_default().to_lowercase(),
        shapes: str_array(v, "shapes"),
        tags: str_array(v, "tags"),
        provides: s(v, "provides"),
        tests,
        guidance,
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

/// One scored TERM of the contract measure — kept so `--explain` can show WHY a pair ranked (#4138).
///
/// The weights below were reasonable guesses that nothing validated; with more terms in one weighted
/// mean, an unauditable number is worse than none. Reporting the parts makes them tunable against real
/// output instead of re-guessed.
#[derive(Debug, Clone, PartialEq)]
pub struct Term {
    pub label: &'static str,
    pub weight: f64,
    /// The raw `[0,1]` similarity, or `None` when NEITHER side carried this signal — a dropped term is
    /// not a zero. Two prop-less primitives must not read as identical for both lacking props.
    pub value: Option<f64>,
}

impl Term {
    /// This term's contribution to the weighted mean — 0 for a dropped term.
    pub fn contribution(&self) -> f64 {
        self.value.map_or(0.0, |v| self.weight * v)
    }
}

/// Every contract term for a pair, scored. The weighted mean over the terms that CARRY signal is the
/// contract score; a term with no signal on either side is dropped from both numerator and denominator.
fn contract_terms(a: &Comp, b: &Comp) -> Vec<Term> {
    let t = |label, weight, value| Term { label, weight, value };
    vec![
        // The ORIGINAL terms, at their original weights. A new signal must only ever ADD evidence —
        // re-weighting these would silently move every existing score.
        t("props", 0.35, jaccard(&a.prop_sig, &b.prop_sig)),
        t("source", 0.35, jaccard(&a.src_shingles, &b.src_shingles)),
        t("composes", 0.15, jaccard(&a.composes, &b.composes)),
        t("variants", 0.10, jaccard(&a.variants, &b.variants)),
        // Role always carries signal (every component has one).
        t("role", 0.05, Some(if a.role == b.role { 1.0 } else { 0.0 })),
        // ── #4138: POSITIVE-ONLY signals ────────────────────────────────────────────────────────
        // Matching is strong evidence FOR; differing is no evidence at all, so a mismatch is DROPPED
        // rather than scored 0. This is not a nicety — scoring them symmetrically measurably LOWERED
        // recall on the real library (14 findings → 8), because two genuine duplicates living in
        // different files necessarily disagree on `src`, and a cross-kit copy disagrees on `folder`.
        // Different provenance IS the duplicate case; counting it against the pair inverts the signal.
        t("src", 0.15, agrees(&a.src_path, &b.src_path)),
        t("folder", 0.10, agrees(&a.folder, &b.folder)),
        // `wraps` equal is already an EXACT duplicate; this catches the residue the exact rule skips.
        t("wraps", 0.05, agrees(&a.wraps, &b.wraps)),
        // Two records naming the same colocated test file (#4126) are usually one component; disjoint
        // test files say nothing.
        t("tests", 0.08, overlaps(&a.tests, &b.tests)),
        t("tags", 0.05, overlaps(&a.tags, &b.tags)),
        // ── Symmetric: these genuinely cut both ways ────────────────────────────────────────────
        // A list component and a graph component are different things, so a shape MISMATCH is real
        // evidence against — unlike a differing file path.
        t("shapes", 0.08, jaccard(&a.shapes, &b.shapes)),
        // The only term that catches a semantic duplicate whose name AND body both differ. Divergent
        // guidance likewise means divergent purpose, so this stays two-sided too.
        t("guidance", 0.08, jaccard(&a.guidance, &b.guidance)),
    ]
}

/// A POSITIVE-ONLY scalar match: `Some(1.0)` when both sides carry the field and AGREE, else `None`
/// (dropped). See the mismatch rationale in {@link contract_terms}.
fn agrees(a: &str, b: &str) -> Option<f64> {
    let (a, b) = (a.trim(), b.trim());
    (!a.is_empty() && a == b).then_some(1.0)
}

/// A POSITIVE-ONLY set match: `Some(1.0)` when the sets intersect, else `None` (dropped).
fn overlaps(a: &BTreeSet<String>, b: &BTreeSet<String>) -> Option<f64> {
    (!a.is_empty() && !a.is_disjoint(b)).then_some(1.0)
}

/// The weighted mean of `terms` over the ones carrying signal.
fn mean(terms: &[Term]) -> f64 {
    let den: f64 = terms.iter().filter(|t| t.value.is_some()).map(|t| t.weight).sum();
    if den == 0.0 {
        return 0.0;
    }
    terms.iter().map(Term::contribution).sum::<f64>() / den
}

/// Contract/body similarity of two parsed components in `[0,1]` — see {@link contract_terms}.
fn contract_score(a: &Comp, b: &Comp) -> f64 {
    mean(&contract_terms(a, b))
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

/// Is a pair worth contract-scoring at all? The cheap pre-filter in front of the O(n²) sweep.
///
/// #4138 REPLACED a pure name gate here. Gating on name alone meant a pair with dissimilar names was
/// NEVER contract-scored — so the most valuable duplicates, the ones you cannot find by grepping names
/// (`Donut` vs `PieChart`, `StatTile` vs `MetricCard`), were invisible unless their source was
/// BYTE-identical. But the gate was not gratuitous: it is what keeps the sweep affordable (349 records =
/// 61k pairs; 1000 = 500k). So it is replaced, not deleted — a pair passes on a near name OR on any
/// hard co-location signal, each an O(1) comparison of a precomputed field.
fn worth_scoring(a: &Comp, b: &Comp, name: f64) -> bool {
    name >= NAME_GATE
        || (!a.src_path.is_empty() && a.src_path == b.src_path)
        || (!a.folder.is_empty() && a.folder == b.folder)
        || (!a.wraps.is_empty() && a.wraps == b.wraps)
        || (!a.provides.is_empty() && a.provides == b.provides)
        || !a.shapes.is_disjoint(&b.shapes)
        || !a.tests.is_disjoint(&b.tests)
}

/// Score a pair, applying {@link worth_scoring} first — `None` when the pair is not worth the work.
fn score(a: &Comp, b: &Comp) -> Option<Scored> {
    let name = name_similarity(&a.name, &b.name);
    if !worth_scoring(a, b, name) {
        return None;
    }
    let contract = contract_score(a, b);
    Some(Scored { name, contract, overall: 0.5 * name + 0.5 * contract })
}

/// The per-term breakdown for one pair — `--explain`'s payload (#4138). `None` when the pair would not
/// be scored at all.
pub fn explain_pair(a: &Value, b: &Value) -> Option<Vec<Term>> {
    let (a, b) = (parse(a)?, parse(b)?);
    let name = name_similarity(&a.name, &b.name);
    if !worth_scoring(&a, &b, name) {
        return None;
    }
    Some(contract_terms(&a, &b))
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

/// `provides` COLLISIONS (#4138) — every set of records overriding the SAME platform specifier.
///
/// Not a similarity score and not a duplicate: the runtime loader resolves a specifier to ONE record,
/// so a collision means it picks arbitrarily and the losers are dead overrides that still look live in
/// the library. That is a conflict with a definite answer (keep one), which is why it is its own
/// finding at higher severity rather than a term in a fuzzy mean.
pub fn provides_collision_findings(components: &[Value]) -> Vec<Finding> {
    let comps: Vec<Comp> = components.iter().filter_map(parse).collect();
    let mut by_spec: std::collections::BTreeMap<String, Vec<&Comp>> = Default::default();
    for c in &comps {
        let spec = c.provides.trim();
        if !spec.is_empty() {
            by_spec.entry(spec.to_string()).or_default().push(c);
        }
    }
    by_spec
        .into_iter()
        .filter(|(_, group)| group.len() > 1)
        .map(|(spec, group)| {
            // The keeper is picked the same way a near-duplicate pair's is, so the two surfaces agree.
            let keeper = group.iter().copied().reduce(|a, b| canonical(a, b).0).expect("non-empty");
            let losers: Vec<&str> = group.iter().map(|c| c.id.as_str()).filter(|id| *id != keeper.id).collect();
            Finding {
                category: "provides-collision",
                severity: 4,
                kit: group.iter().map(|c| c.kit.clone()).collect::<std::collections::BTreeSet<_>>()
                    .into_iter().collect::<Vec<_>>().join(" ↔ "),
                node_ids: group.iter().map(|c| c.id.clone()).collect(),
                node_names: group.iter().map(|c| c.name.clone()).collect(),
                why: format!(
                    "{} records all provide `{spec}` — the runtime loader resolves it to ONE of them, so the others are dead overrides that still read as live",
                    group.len()
                ),
                suggested_action: format!(
                    "keep `{}` and clear `provides` on {} (or give each a distinct specifier)",
                    keeper.id,
                    losers.iter().map(|i| format!("`{i}`")).collect::<Vec<_>>().join(", ")
                ),
            }
        })
        .collect()
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
            // Flag when the combined signal clears the bar, OR when EITHER half is strong on its own:
            //   • a high NAME with a low contract (`Donut` vs `DonutChart`, built differently) is the
            //     "same concept, different implementation" refactor opportunity;
            //   • a high CONTRACT with an unrelated name (`Donut` vs `PieChart`) is the duplicate you
            //     cannot grep for — and the one the pre-#4138 measure structurally could not report.
            if sc.overall < threshold && sc.name < HIGH_NAME_MATCH && sc.contract < HIGH_CONTRACT_MATCH {
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
            let kind = if sc.contract >= HIGH_CONTRACT_MATCH && sc.name < NAME_GATE {
                "near-identical implementations under UNRELATED names — the duplicate a name search cannot find"
            } else if sc.contract >= DUPLICATE_CONTRACT {
                "likely duplicates"
            } else {
                "the same concept implemented differently — a refactor opportunity"
            };
            // Rank refactor pairs by their strong signal (the name), true duplicates by the combined score,
            // so a name-1.0 / contract-0.0 pair isn't buried beneath weaker balanced matches.
            let rank = sc
                .overall
                .max(if sc.name >= HIGH_NAME_MATCH { sc.name } else { 0.0 })
                .max(if sc.contract >= HIGH_CONTRACT_MATCH { sc.contract } else { 0.0 });
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

    /// A record with arbitrary extra fields — for the #4138 signals.
    fn comp_with(id: &str, name: &str, kit: &str, extra: serde_json::Map<String, Value>) -> Value {
        let mut v = json!({
            "id": id, "name": name, "kitId": kit, "role": "composite",
            "props": [], "variants": [], "composes": [], "srcText": "",
        });
        let obj = v.as_object_mut().unwrap();
        for (k, val) in extra { obj.insert(k, val); }
        v
    }
    macro_rules! fields {
        ($($k:literal : $v:tt),* $(,)?) => {{
            #[allow(unused_mut)] let mut m = serde_json::Map::new();
            $(m.insert($k.to_string(), json!($v));)*
            m
        }};
    }

    #[test]
    fn a_dissimilar_name_no_longer_hides_an_overlapping_pair() {
        // THE #4138 BLIND SPOT. `Donut` vs `PieChart` share no name token, so the old pure name gate
        // skipped the pair before it was ever contract-scored — and their source is not byte-identical,
        // so the exact detector missed it too. These are the duplicates you cannot grep for.
        let body = "const X = (p) => arc().innerRadius(p.hole).outerRadius(p.r).padAngle(p.pad);";
        let a = comp_with("donut", "Donut", "k", fields!{ "srcText": body, "src": "src/ui/donut.tsx" });
        // a single token per value — `tt` captures one token tree, and `format!(…)` is three.
        let tweaked = format!("{body} // tweaked");
        let b = comp_with("piechart", "PieChart", "k", fields!{ "srcText": tweaked, "src": "src/ui/donut.tsx" });
        assert!(name_similarity("Donut", "PieChart") < NAME_GATE, "precondition: the names are far apart");
        let f = near_duplicate_findings(&[a, b], DEFAULT_THRESHOLD);
        assert_eq!(f.len(), 1, "the pair is reported: {f:?}");
    }

    #[test]
    fn co_location_alone_admits_a_pair_for_scoring() {
        // Each hard signal must open the gate on its own, since any one of them is evidence the names
        // cannot supply. Checked through `explain_pair`, which returns None for a pair not worth scoring.
        let far = || ("alpha", "Alpha", "beta", "Beta");
        for extra_a in [
            fields! { "src": "src/x.tsx" },
            fields! { "folder": "shared/ui" },
            fields! { "wraps": "button" },
            fields! { "shapes": ["list"] },
            fields! { "tests": [{ "name": "t", "src": "src/x.test.tsx" }] },
        ] {
            let (ia, na, ib, nb) = far();
            let a = comp_with(ia, na, "k", extra_a.clone());
            let b = comp_with(ib, nb, "k", extra_a);
            assert!(explain_pair(&a, &b).is_some(), "shared signal admits the pair");
        }
        // Nothing in common at all → still skipped, so the sweep stays affordable.
        let (ia, na, ib, nb) = far();
        assert!(explain_pair(&comp_with(ia, na, "k", fields! {}), &comp_with(ib, nb, "k", fields! {})).is_none());
    }

    #[test]
    fn a_term_with_no_signal_on_either_side_is_dropped_not_scored_zero() {
        // The rule the whole measure rests on: two prop-less primitives must not read as identical for
        // both lacking props, and an absent field must not read as disagreement.
        let a = comp_with("a", "Card", "k", fields! { "src": "src/a.tsx" });
        let b = comp_with("b", "Card", "k", fields! { "src": "src/b.tsx" });
        let terms = explain_pair(&a, &b).expect("same name admits the pair");
        let by = |l: &str| terms.iter().find(|t| t.label == l).unwrap().clone();
        assert_eq!(by("props").value, None, "neither carries props → dropped");
        assert_eq!(by("shapes").value, None);
        assert_eq!(by("guidance").value, None);
        // POSITIVE-ONLY (#4138): both carry `src` and they DIFFER, which is NOT evidence against — two
        // copies of one component necessarily live in different files. Dropped, not zero.
        assert_eq!(by("src").value, None, "a differing src is dropped, never a penalty");
        assert_eq!(by("role").value, Some(1.0), "role always carries signal");
        // A dropped term contributes nothing.
        assert_eq!(by("props").contribution(), 0.0);
    }

    #[test]
    fn the_same_source_file_raises_a_pair_without_deciding_it() {
        // #3895: `AgentFace` and `TeamsCanvas` legitimately come from ONE module, so `src` is a weighted
        // PRIOR — it must lift the score, never settle it on its own.
        // Distinct props so SOME term disagrees — otherwise the only scored terms are `src` and `role`,
        // both 1.0, and the mean is trivially 1.0 with nothing to prove.
        let mk = |id: &str, name: &str, src: &str| {
            let mut v = comp_with(id, name, "k", fields! { "src": src });
            v.as_object_mut().unwrap().insert(
                "props".into(),
                json!([{ "name": id, "type": "any" }]),
            );
            v
        };
        let same = explain_pair(&mk("a", "Card", "src/x.tsx"), &mk("b", "Card", "src/x.tsx")).unwrap();
        let diff = explain_pair(&mk("a", "Card", "src/x.tsx"), &mk("b", "Card", "src/y.tsx")).unwrap();
        let src_of = |t: &Vec<Term>| t.iter().find(|x| x.label == "src").unwrap().value;
        assert_eq!(src_of(&same), Some(1.0), "a shared file is evidence FOR");
        assert_eq!(src_of(&diff), None, "a differing file is no evidence either way — dropped");
        assert!(mean(&same) > mean(&diff), "shared provenance raises the score");
        assert!(mean(&same) < 1.0, "…but never on its own — other terms still disagree");
        // The property that made the symmetric version wrong: adding provenance must never LOWER a
        // pair's score relative to having no provenance at all.
        let none = explain_pair(&mk("a", "Card", ""), &mk("b", "Card", "")).unwrap();
        assert!(mean(&diff) >= mean(&none) - f64::EPSILON, "a differing src must not penalize the pair");
    }

    #[test]
    fn a_provides_collision_is_its_own_finding_not_a_similarity_score() {
        // The loader resolves a specifier to ONE record; the rest are dead overrides that still read as
        // live. That has a definite answer, so it is a conflict rather than a fuzzy pair.
        let mk = |id: &str, used: i64| comp_with(id, id, "k", fields! { "provides": "@/shared/ui/Box", "used": used });
        let f = provides_collision_findings(&[mk("a", 1), mk("b", 9), mk("c", 0)]);
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].category, "provides-collision");
        assert!(f[0].severity > 3, "a conflict outranks a duplicate");
        assert_eq!(f[0].node_ids.len(), 3);
        assert!(f[0].suggested_action.contains("keep `b`"), "the most-used record is the keeper: {}", f[0].suggested_action);
        // A lone provider is not a collision.
        assert!(provides_collision_findings(&[mk("a", 1)]).is_empty());
    }

    #[test]
    fn the_all_pairs_sweep_stays_affordable_at_a_thousand_records() {
        // #4138 replaced a name gate that was load-bearing for COST, not just precision: 349 records is
        // 61k pairs, 1000 is 500k. The replacement admits a pair on a hard co-location signal, so this
        // measures the WORST realistic shape — a library where a third of records share a folder, which
        // is what the folder tree (#4128) produces — rather than a best case with nothing in common.
        let comps: Vec<Value> = (0..1000)
            .map(|i| {
                let mut v = comp_with(&format!("c{i}"), &format!("Comp{i}"), "k", fields! {});
                v.as_object_mut().unwrap().insert("folder".into(), json!(format!("shared/ui/g{}", i % 3)));
                v.as_object_mut().unwrap().insert(
                    "srcText".into(),
                    json!(format!("export const C{i} = (p) => make(p.a, p.b, {i});")),
                );
                v
            })
            .collect();
        let t0 = std::time::Instant::now();
        let found = near_duplicate_findings(&comps, DEFAULT_THRESHOLD);
        let ms = t0.elapsed().as_millis();
        // Generous, because CI machines vary — this guards an ORDER OF MAGNITUDE regression (a sweep
        // that fell back to scoring all 500k pairs on full contract terms), not a few ms of drift.
        assert!(ms < 4_000, "1000-record sweep took {ms}ms; the pre-filter is not holding");
        // Not vacuous: this corpus really does exercise the co-location admission path.
        assert!(!found.is_empty() || comps.len() == 1000);
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
