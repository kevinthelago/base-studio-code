//! The queries — the part that makes this a tool rather than a document.
//!
//! Three of them answer questions a written manual structurally cannot:
//!
//! - [`Engine::feasible`] runs the lookup BACKWARDS. A manual is indexed by what you want to do; a
//!   person in trouble is indexed by what is in their hands. Given a list of materials, this ranks
//!   what those materials actually support and names what is still missing from the rest.
//! - [`Engine::remedies`] crosses FUNCTION with LOCATION — "what growing here stops bleeding" — which
//!   is two independent axes and therefore a query, not a chapter.
//! - [`Engine::functions`] / [`Engine::regions`] rank the vocabulary the store actually holds, so a
//!   filter is reachable without already knowing the token to type. The same discover-then-filter
//!   shape `bsc news entities` uses, and for the same reason: a filter nobody can spell is a filter
//!   nobody can use.
//!
//! [`Engine::compile`] then renders the whole corpus as one markdown field manual — the document is
//! the OUTPUT of the store, not its source, which is what keeps the two from drifting.

use crate::seed;
use crate::store::Store;
use crate::types::{Category, Function, Procedure, Remedy};
use serde::{Deserialize, Serialize};

pub struct Engine {
    store: Store,
}

/// What a set of materials supports, and what it is short of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Feasibility {
    pub id: String,
    pub name: String,
    pub category: String,
    pub summary: String,
    /// True when every non-optional material is accounted for.
    pub ready: bool,
    /// The required materials nothing on hand satisfies.
    pub missing: Vec<String>,
    /// The optional materials nothing on hand satisfies — worth knowing, never blocking.
    pub missing_optional: Vec<String>,
    /// Which thing on hand covered which material, so the caller can check the substitution.
    pub covered_by: Vec<Coverage>,
}

/// One material and the thing on hand that satisfied it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Coverage {
    pub material: String,
    pub have: String,
}

/// One term of a vocabulary, with how many records carry it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Term {
    pub token: String,
    pub count: usize,
}

/// A search hit across both kinds.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Hit {
    /// `procedure` or `remedy`.
    pub kind: String,
    pub id: String,
    pub name: String,
    pub summary: String,
}

impl Engine {
    pub fn with_store(store: Store) -> Engine {
        Engine { store }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    /// Free-text search across both kinds. Every whitespace-separated term must appear somewhere in
    /// the record's haystack — AND, not OR, because a two-word query on an OR match returns most of
    /// the corpus and reads as a broken search.
    pub fn search(&self, query: &str) -> Vec<Hit> {
        let terms: Vec<String> =
            query.split_whitespace().map(|t| t.trim().to_ascii_lowercase()).filter(|t| !t.is_empty()).collect();
        if terms.is_empty() {
            return Vec::new();
        }
        let matches = |hay: &str| terms.iter().all(|t| hay.contains(t.as_str()));
        let mut out: Vec<Hit> = Vec::new();
        for p in self.store.procedures() {
            if matches(&p.haystack()) {
                out.push(Hit {
                    kind: "procedure".into(),
                    id: p.id.clone(),
                    name: p.name.clone(),
                    summary: p.summary.clone(),
                });
            }
        }
        for r in self.store.remedies() {
            if matches(&r.haystack()) {
                let summary = format!(
                    "{} — {}",
                    r.functions.iter().map(|f| f.as_str()).collect::<Vec<_>>().join(", "),
                    r.habitat
                );
                out.push(Hit { kind: "remedy".into(), id: r.id.clone(), name: r.name.clone(), summary });
            }
        }
        out
    }

    /// The INVERSE lookup: given what is in your hands, what can you actually do?
    ///
    /// Ranked ready-first, then by how few things are missing, then by the survival priority of the
    /// category — so a medical procedure one item short outranks a food procedure one item short.
    /// A procedure that shares NOTHING with the materials on hand is dropped entirely, because a list
    /// that includes everything has ranked nothing.
    pub fn feasible(&self, have: &[String]) -> Vec<Feasibility> {
        let mut out: Vec<(Category, Feasibility)> = Vec::new();
        for p in self.store.procedures() {
            let mut missing = Vec::new();
            let mut missing_optional = Vec::new();
            let mut covered_by = Vec::new();
            for m in &p.materials {
                match have.iter().find(|h| m.satisfied_by(h)) {
                    Some(h) => covered_by.push(Coverage { material: m.item.clone(), have: h.clone() }),
                    None if m.optional => missing_optional.push(m.item.clone()),
                    None => missing.push(m.item.clone()),
                }
            }
            // Nothing on hand touches this procedure — it is not an answer to the question asked.
            if covered_by.is_empty() {
                continue;
            }
            out.push((
                p.category,
                Feasibility {
                    id: p.id.clone(),
                    name: p.name.clone(),
                    category: p.category.as_str().to_string(),
                    summary: p.summary.clone(),
                    ready: missing.is_empty(),
                    missing,
                    missing_optional,
                    covered_by,
                },
            ));
        }
        out.sort_by(|a, b| {
            b.1.ready
                .cmp(&a.1.ready)
                .then_with(|| a.1.missing.len().cmp(&b.1.missing.len()))
                .then_with(|| a.0.cmp(&b.0))
                .then_with(|| a.1.id.cmp(&b.1.id))
        });
        out.into_iter().map(|(_, f)| f).collect()
    }

    /// Remedies filtered by function and/or region. An absent filter is not a filter.
    pub fn remedies(&self, function: Option<Function>, region: Option<&str>) -> Vec<Remedy> {
        self.store
            .remedies()
            .into_iter()
            .filter(|r| function.is_none_or(|f| r.functions.contains(&f)))
            .filter(|r| region.is_none_or(|q| r.grows_in(q)))
            .collect()
    }

    /// Procedures, optionally in one category.
    pub fn procedures(&self, category: Option<Category>) -> Vec<Procedure> {
        match category {
            Some(c) => self.store.procedures_in(c),
            None => self.store.procedures(),
        }
    }

    /// The FUNCTION vocabulary the store actually holds, most-carried first.
    pub fn functions(&self) -> Vec<Term> {
        let rems = self.store.remedies();
        let mut out: Vec<Term> = Function::all()
            .into_iter()
            .map(|f| Term {
                token: f.as_str().to_string(),
                count: rems.iter().filter(|r| r.functions.contains(&f)).count(),
            })
            .filter(|t| t.count > 0)
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.token.cmp(&b.token)));
        out
    }

    /// The REGION vocabulary the store actually holds, most-carried first.
    pub fn regions(&self) -> Vec<Term> {
        let mut counts: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
        for r in self.store.remedies() {
            for region in &r.regions {
                *counts.entry(region.to_ascii_lowercase()).or_insert(0) += 1;
            }
        }
        let mut out: Vec<Term> = counts.into_iter().map(|(token, count)| Term { token, count }).collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.token.cmp(&b.token)));
        out
    }

    /// The CATEGORY vocabulary, most-carried first.
    pub fn categories(&self) -> Vec<Term> {
        let procs = self.store.procedures();
        let mut out: Vec<Term> = Category::all()
            .into_iter()
            .map(|c| Term {
                token: c.as_str().to_string(),
                count: procs.iter().filter(|p| p.category == c).count(),
            })
            .filter(|t| t.count > 0)
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.token.cmp(&b.token)));
        out
    }

    /// The whole corpus as one markdown field manual — what you print and carry when the machine that
    /// answers queries is not with you.
    pub fn compile(&self) -> String {
        let mut s = String::new();
        s.push_str("# Field manual\n\n");
        s.push_str(seed::PREAMBLE);
        s.push_str("\n\n");

        let procs = self.store.procedures();
        let rems = self.store.remedies();
        s.push_str(&format!("{} procedures · {} remedies\n\n---\n\n", procs.len(), rems.len()));

        s.push_str("# Procedures\n\n");
        let mut current: Option<Category> = None;
        for p in &procs {
            if current != Some(p.category) {
                s.push_str(&format!("## {}\n\n", p.category.as_str().to_uppercase()));
                current = Some(p.category);
            }
            s.push_str(&format!("### {} (`{}`)\n\n{}\n\n", p.name, p.id, p.summary));
            if let Some(t) = &p.time {
                s.push_str(&format!("*Time: {t}*\n\n"));
            }
            if !p.materials.is_empty() {
                s.push_str("**You need**\n\n");
                for m in &p.materials {
                    let subs = if m.substitutes.is_empty() {
                        String::new()
                    } else {
                        format!(" — or: {}", m.substitutes.join(", "))
                    };
                    let opt = if m.optional { " *(optional)*" } else { "" };
                    s.push_str(&format!("- {}{}{}\n", m.item, opt, subs));
                }
                s.push('\n');
            }
            if !p.steps.is_empty() {
                s.push_str("**Steps**\n\n");
                for (i, step) in p.steps.iter().enumerate() {
                    s.push_str(&format!("{}. {}\n", i + 1, step.text));
                    if let Some(why) = &step.why {
                        s.push_str(&format!("   - *why:* {why}\n"));
                    }
                }
                s.push('\n');
            }
            Engine::bullets(&mut s, "Check", &p.verify);
            Engine::bullets(&mut s, "LIMITS — what this does NOT do", &p.limits);
            Engine::bullets(&mut s, "Cautions", &p.cautions);
            s.push_str("---\n\n");
        }

        s.push_str("# Remedies\n\n");
        for r in &rems {
            let latin = r.latin.as_deref().map(|l| format!(" *({l})*")).unwrap_or_default();
            s.push_str(&format!("### {}{} (`{}`)\n\n", r.name, latin, r.id));
            s.push_str(&format!(
                "**For:** {}\n\n**Where:** {}\n\n",
                r.functions.iter().map(|f| f.as_str()).collect::<Vec<_>>().join(", "),
                if r.regions.is_empty() { "not recorded".to_string() } else { r.regions.join(", ") },
            ));
            if !r.habitat.is_empty() {
                s.push_str(&format!("{}\n\n", r.habitat));
            }
            Engine::bullets(&mut s, "Identify", &r.identify);
            if !r.lookalikes.is_empty() {
                s.push_str("**LOOK-ALIKES**\n\n");
                for l in &r.lookalikes {
                    let latin = l.latin.as_deref().map(|x| format!(" *({x})*")).unwrap_or_default();
                    s.push_str(&format!("- **{}**{} — {}\n  - **Tell:** {}\n", l.name, latin, l.danger, l.tell));
                }
                s.push('\n');
            }
            if !r.parts.is_empty() {
                s.push_str(&format!("**Parts used:** {}\n\n", r.parts.join(", ")));
            }
            if !r.preparations.is_empty() {
                s.push_str("**Preparations**\n\n");
                for p in &r.preparations {
                    s.push_str(&format!("- **{}** — {}\n", p.form, p.method));
                    if !p.for_use.is_empty() {
                        s.push_str(&format!("  - *for:* {}\n", p.for_use));
                    }
                }
                s.push('\n');
            }
            Engine::bullets(&mut s, "Cautions", &r.cautions);
            if let Some(e) = &r.evidence {
                s.push_str(&format!("**How well attested:** {e}\n\n"));
            }
            s.push_str("---\n\n");
        }
        s
    }

    fn bullets(s: &mut String, heading: &str, items: &[String]) {
        if items.is_empty() {
            return;
        }
        s.push_str(&format!("**{heading}**\n\n"));
        for i in items {
            s.push_str(&format!("- {i}\n"));
        }
        s.push('\n');
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        Engine::with_store(Store::in_memory().unwrap())
    }

    #[test]
    fn search_requires_every_term_and_reaches_both_kinds() {
        let e = engine();
        let boil = e.search("boil water");
        assert!(boil.iter().any(|h| h.id == "water-boil"), "found the procedure");
        // AND, not OR: adding a term that appears nowhere must empty the result.
        assert!(e.search("boil zzzznotathing").is_empty());
        // A remedy is reachable by its function token.
        assert!(e.search("hemostatic").iter().any(|h| h.kind == "remedy"));
        assert!(e.search("").is_empty(), "an empty query is not a match-everything");
    }

    /// The inverse lookup is the reason this is a store. A bottle, sand and a fire is a specific set
    /// of things, and the answer must be ranked by what they actually complete.
    #[test]
    fn feasible_ranks_what_the_materials_in_hand_complete() {
        let e = engine();
        let have: Vec<String> = ["bottle", "sand", "gravel", "charcoal", "cloth", "pot"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let out = e.feasible(&have);

        let filter = out.iter().find(|f| f.id == "water-improvised-filter").expect("the filter is reachable");
        assert!(filter.ready, "every required material is covered: missing {:?}", filter.missing);
        assert!(
            filter.covered_by.iter().any(|c| c.have == "bottle"),
            "and it says WHICH thing on hand covered which material",
        );

        // Ready procedures sort above ones that are short of something.
        let first_unready = out.iter().position(|f| !f.ready);
        let last_ready = out.iter().rposition(|f| f.ready);
        if let (Some(fu), Some(lr)) = (first_unready, last_ready) {
            assert!(lr < fu, "every ready procedure sorts above every unready one");
        }

        // Something the materials cannot touch at all is dropped, not listed as 'missing everything'.
        assert!(
            !out.iter().any(|f| f.id == "signal-mirror"),
            "a procedure sharing nothing with what is on hand is not an answer to the question",
        );

        // A KNOWN, TOLERATED FALSE POSITIVE, pinned here so a later reader does not think it is a bug:
        // `sand` (meant as filter media) also satisfies the shadow stick's `sand` as a stand-in for
        // level ground. Containment matching cannot tell two senses of one word apart, and the fix
        // would be a sense vocabulary that every corpus author then has to get right. The cost of the
        // false positive is one extra row, ranked below everything it actually completes; the cost of
        // tightening to exact matches is that `tin can` stops satisfying `metal container`, which is
        // the whole feature. Ranked-not-filtered is the trade.
        assert!(
            out.iter().any(|f| f.id == "nav-shadow-stick"),
            "the cross-sense match is still happening — if this ever fails, the matching rule changed",
        );
    }

    /// A substitute is what makes the inverse lookup usable — nobody has "a metal container", they
    /// have a tin can.
    #[test]
    fn feasible_matches_through_a_substitute_not_only_the_canonical_name() {
        let e = engine();
        let out = e.feasible(&["tin can".to_string(), "fire".to_string()]);
        let boil = out.iter().find(|f| f.id == "water-boil").expect("boiling is reachable with a can and a fire");
        assert!(boil.ready, "a tin can satisfies 'metal container': missing {:?}", boil.missing);
        assert!(
            boil.missing_optional.iter().any(|m| m.contains("pre-filtering")),
            "and the optional cloth is reported as optional, not as blocking",
        );
    }

    #[test]
    fn remedies_cross_function_with_location() {
        let e = engine();
        // The question the corpus exists to answer.
        let clotting_here = e.remedies(Function::parse("clotting"), Some("north-america-west"));
        assert!(!clotting_here.is_empty());
        assert!(clotting_here.iter().all(|r| r.functions.contains(&Function::Hemostatic)));
        assert!(clotting_here.iter().all(|r| r.grows_in("north-america-west")));
        assert!(clotting_here.iter().any(|r| r.id == "yarrow"));

        // A region nothing is recorded for returns the worldwide entries only, not everything.
        let antarctic = e.remedies(None, Some("antarctica"));
        assert!(antarctic.iter().all(|r| r.regions.iter().any(|x| x == "worldwide")));

        // Witch hazel is east-only, so it must not answer a west query.
        let west = e.remedies(None, Some("north-america-west"));
        assert!(!west.iter().any(|r| r.id == "witch-hazel"), "an eastern species does not answer a western query");
    }

    /// The vocabulary verbs exist so a filter is reachable without already knowing the token.
    #[test]
    fn the_vocabularies_rank_what_the_store_actually_holds() {
        let e = engine();
        let fns = e.functions();
        assert!(!fns.is_empty());
        assert!(fns.windows(2).all(|w| w[0].count >= w[1].count), "most-carried first");
        assert!(fns.iter().all(|t| t.count > 0), "a term nothing carries is not vocabulary");
        // Every listed token parses back into the filter it is advertising.
        for t in &fns {
            assert!(Function::parse(&t.token).is_some(), "{} is a usable --function value", t.token);
        }
        for t in &e.categories() {
            assert!(Category::parse(&t.token).is_some(), "{} is a usable --category value", t.token);
        }
        // Every advertised region actually selects the rows it counted.
        for t in &e.regions() {
            assert!(e.remedies(None, Some(&t.token)).len() >= t.count, "{} selects its rows", t.token);
        }
    }

    #[test]
    fn compile_renders_the_whole_corpus_with_its_safety_fields() {
        let e = engine();
        let md = e.compile();
        assert!(md.starts_with("# Field manual"));
        assert!(md.contains(seed::PREAMBLE), "the standing note is rendered, not paraphrased");
        // Every record reaches the page.
        for p in e.store().procedures() {
            assert!(md.contains(&format!("(`{}`)", p.id)), "{} is in the manual", p.id);
        }
        for r in e.store().remedies() {
            assert!(md.contains(&format!("(`{}`)", r.id)), "{} is in the manual", r.id);
        }
        // And the two fields that exist for safety are rendered under headings that say so.
        assert!(md.contains("**LIMITS — what this does NOT do**"));
        assert!(md.contains("**LOOK-ALIKES**"));
        assert!(md.contains("**Tell:**"));
    }
}
