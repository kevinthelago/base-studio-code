//! Wait-for deadlock detection over the coordination state.
//!
//! # The log is parsed here and the state reduced here; only this was not
//!
//! `coord.log` is written by the backend and by the pure-shell `bsc-*` helpers, and [`super::coord`]
//! already parses and reduces it. The reasoning ON TOP — whether the parked waiters form a wait-for
//! cycle — ran in a renderer, about sessions the backend owns, over a log the backend writes.
//!
//! That matters more than most of this epic's slices because a deadlock is the ONE coordination state
//! nothing recovers from on its own. "Satisfied" is monotonic, so the only way a parked waiter never
//! wakes is a ring: A waits on something B produces while B waits on something A produces. No producer
//! in the ring can move, so all of them hang for ever. The runtime is meant to detect that and
//! escalate rather than spin.
//!
//! # Two details are the whole correctness
//!
//! * A LONE node is a cycle only if it waits on ITSELF. Tarjan reports every node as a
//!   strongly-connected component of size one, so reporting singletons would flag EVERY parked waiter
//!   as deadlocked — the detector would fire constantly and be turned off.
//! * An edge is drawn only to another PARKED waiter. An unsatisfied dep whose producer is still
//!   running is not a deadlock; that producer can finish. Dropping the check turns every ordinary wait
//!   into a false alarm.
//!
//! And an edge exists only for an UNSATISFIED dep, because a satisfied one imposes no wait — which is
//! why breaking a single latch in a ring dissolves it.
//!
//! # What is deliberately NOT decided here
//!
//! The frontend also maps a `file:` dep to its owning session by glob. That engine's semantics are an
//! OPEN question (`the-two-write-scope-glob-engines-disagree`: 8 of 25 pairs disagree, and the
//! enforcing side is the wider one). Choosing either here would silently settle it in a place where
//! the cost is a missed or an invented deadlock, so [`build_producer_of`] takes the file matcher as an
//! injected predicate and the decision stays with whoever closes that item.

use std::collections::{BTreeMap, HashMap, HashSet};

use crate::coord::{is_satisfied, CoordRef, CoordState};

/// One detected wait-for cycle: the sessions in it, in discovery order.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Deadlock {
    pub cycle: Vec<String>,
}

/// Resolve a dep to the session expected to satisfy it.
pub type ProducerOf<'a> = &'a dyn Fn(&CoordRef) -> Option<String>;

/// The default: only a `session:<id>` dep names its producer. Every other kind carries no producer in
/// the log, so it yields NO edge — zero false positives until a plan-derived resolver is supplied.
pub fn default_producer_of(r: &CoordRef) -> Option<String> {
    match r {
        CoordRef::Session { id } => Some(id.clone()),
        _ => None,
    }
}

/// What one session declares it produces.
#[derive(Debug, Clone, Default)]
pub struct SessionProduces {
    pub session: String,
    pub contracts: Vec<String>,
    pub issues: Vec<i64>,
    /// File globs this session owns. Matched by the INJECTED predicate — see the module docs.
    pub owns: Vec<String>,
}

/// Build a resolver from the plan's produces data.
///
/// FIRST DECLARATION WINS on a collision: a contract or issue should have exactly one producer, and
/// the planning critic rejects duplicates, so a later one is a data defect rather than an override.
/// `matches_glob` decides `file:` ownership and is injected rather than chosen — see the module docs.
pub fn build_producer_of(
    producers: &[SessionProduces],
    matches_glob: impl Fn(&str, &str) -> bool + 'static,
) -> impl Fn(&CoordRef) -> Option<String> {
    let mut by_contract: BTreeMap<String, String> = BTreeMap::new();
    let mut by_issue: BTreeMap<i64, String> = BTreeMap::new();
    let mut file_owners: Vec<(String, String)> = Vec::new();
    for p in producers {
        for name in &p.contracts {
            if !name.is_empty() {
                by_contract.entry(name.clone()).or_insert_with(|| p.session.clone());
            }
        }
        for n in &p.issues {
            if *n > 0 {
                by_issue.entry(*n).or_insert_with(|| p.session.clone());
            }
        }
        for g in &p.owns {
            if !g.is_empty() {
                file_owners.push((g.clone(), p.session.clone()));
            }
        }
    }
    move |r: &CoordRef| match r {
        CoordRef::Session { id } => Some(id.clone()),
        CoordRef::Contract { name } => by_contract.get(name).cloned(),
        CoordRef::Issue { number } => by_issue.get(number).cloned(),
        CoordRef::File { path } => {
            file_owners.iter().find(|(g, _)| matches_glob(g, path)).map(|(_, s)| s.clone())
        }
        // No session "produces" a predicate.
        _ => None,
    }
}

/// Every wait-for cycle among the parked waiters.
pub fn detect_deadlocks(s: &CoordState, producer_of: ProducerOf) -> Vec<Deadlock> {
    let waiter_ids: HashSet<&str> = s.waiters.iter().map(|w| w.session.as_str()).collect();
    // Insertion-ordered adjacency: Tarjan visits in this order, and the reported cycle order follows.
    let mut order: Vec<String> = Vec::new();
    let mut adj: HashMap<String, Vec<String>> = HashMap::new();
    for w in &s.waiters {
        let mut outs: Vec<String> = Vec::new();
        for d in &w.deps {
            // A satisfied dep is no longer blocking.
            if is_satisfied(s, d) {
                continue;
            }
            if let Some(p) = producer_of(d) {
                // ONLY an edge to another parked session. BELT AND BRACES for cycle detection —
                // removing it leaves the parity green, because a non-waiter has no outgoing edges and
                // so can never close a ring (the source says as much: "an edge to a non-waiter is
                // harmless since that producer can still finish"). Kept because it states the rule the
                // graph MEANS — a wait-for edge is between parked sessions — and because any future
                // reader of `adj` would otherwise see phantom nodes that are not waiters at all.
                if waiter_ids.contains(p.as_str()) && !outs.contains(&p) {
                    outs.push(p);
                }
            }
        }
        order.push(w.session.clone());
        adj.insert(w.session.clone(), outs);
    }
    tarjan_cycles(&order, &adj)
}

/// Whether any parked waiter sits in a wait-for cycle.
pub fn has_deadlock(s: &CoordState, producer_of: ProducerOf) -> bool {
    !detect_deadlocks(s, producer_of).is_empty()
}

/// Tarjan's SCC — the cyclic components, each as a [`Deadlock`].
///
/// Iterative rather than recursive: the graphs are tiny (one node per parked pane), but a recursive
/// DFS over attacker-influenced data is a stack-overflow waiting to be discovered, and the iterative
/// form costs nothing here.
fn tarjan_cycles(order: &[String], adj: &HashMap<String, Vec<String>>) -> Vec<Deadlock> {
    let mut index = 0usize;
    let mut idx: HashMap<&str, usize> = HashMap::new();
    let mut low: HashMap<&str, usize> = HashMap::new();
    let mut on_stack: HashSet<&str> = HashSet::new();
    let mut stack: Vec<&str> = Vec::new();
    let mut out: Vec<Deadlock> = Vec::new();
    let empty: Vec<String> = Vec::new();

    for root in order {
        if idx.contains_key(root.as_str()) {
            continue;
        }
        // (node, next child to visit)
        let mut work: Vec<(&str, usize)> = vec![(root.as_str(), 0)];
        idx.insert(root.as_str(), index);
        low.insert(root.as_str(), index);
        index += 1;
        stack.push(root.as_str());
        on_stack.insert(root.as_str());

        while let Some((v, child)) = work.pop() {
            let children = adj.get(v).unwrap_or(&empty);
            if child < children.len() {
                work.push((v, child + 1));
                let w = children[child].as_str();
                if !idx.contains_key(w) {
                    idx.insert(w, index);
                    low.insert(w, index);
                    index += 1;
                    stack.push(w);
                    on_stack.insert(w);
                    work.push((w, 0));
                } else if on_stack.contains(w) {
                    let lw = idx[w];
                    let lv = low[v];
                    low.insert(v, lv.min(lw));
                }
                continue;
            }
            // v is finished: fold its low-link into its parent, then close a root.
            if let Some(&(parent, _)) = work.last() {
                let lv = low[v];
                let lp = low[parent];
                low.insert(parent, lp.min(lv));
            }
            if low[v] == idx[v] {
                let mut comp: Vec<String> = Vec::new();
                while let Some(node) = stack.pop() {
                    on_stack.remove(node);
                    comp.push(node.to_string());
                    if node == v {
                        break;
                    }
                }
                // A multi-node component is a ring; a lone node is a cycle ONLY if it waits on itself.
                let self_loop = comp.len() == 1 && adj.get(&comp[0]).is_some_and(|o| o.contains(&comp[0]));
                if comp.len() > 1 || self_loop {
                    comp.reverse();
                    out.push(Deadlock { cycle: comp });
                }
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coord::{LatchStatus, SatisfySource, Waiter};

    fn fixture() -> serde_json::Value {
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("deadlock.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one deadlock.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Rebuild the CoordState a case describes, using the crate's OWN types — so the parity is against
    /// the state this crate actually reduces, not against a shape invented for the test.
    fn state(case: &serde_json::Value) -> CoordState {
        let mut s = CoordState::default();
        for w in case["waiters"].as_array().unwrap() {
            s.waiters.push(Waiter {
                session: w["session"].as_str().unwrap().to_string(),
                // Parse the token's KIND, exactly as the generator writes it. Mapping every token to
                // a Session ref — which this did at first — silently discards the kind and makes the
                // default resolver's kind-gate untestable: a resolver that mapped every kind looked
                // identical, because no dep in the corpus was ever anything but a session.
                deps: w["deps"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|d| {
                        let t = d.as_str().unwrap();
                        match t.strip_prefix("contract:") {
                            Some(name) => CoordRef::Contract { name: name.to_string() },
                            None => CoordRef::Session { id: t.to_string() },
                        }
                    })
                    .collect(),
                checkpoint: None,
                registered_at: 0,
            });
        }
        for sat in case["satisfied"].as_array().unwrap() {
            s.latches.insert(
                format!("session:{}", sat.as_str().unwrap()),
                LatchStatus::Satisfied { source: SatisfySource::Landed, at: 1 },
            );
        }
        s
    }

    /// Reports every mismatch at once. Compares the cycles AND their member order — the order is the
    /// ring as discovered, and a set comparison would call a reversed ring identical.
    #[test]
    fn the_deadlock_detection_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 12, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut deadlocked, mut healthy) = (0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let s = state(case);
            let want: Vec<Vec<String>> = case["deadlocks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|d| d["cycle"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect())
                .collect();
            if want.is_empty() {
                healthy += 1;
            } else {
                deadlocked += 1;
            }

            let got: Vec<Vec<String>> =
                detect_deadlocks(&s, &default_producer_of).into_iter().map(|d| d.cycle).collect();
            if got != want {
                mismatches.push(format!("  {label}\n    ts   {want:?}\n    rust {got:?}"));
            }
            let want_any = case["hasDeadlock"].as_bool().unwrap();
            if has_deadlock(&s, &default_producer_of) != want_any {
                mismatches.push(format!("  {label} [hasDeadlock] ts={want_any}"));
            }
        }
        assert!(deadlocked >= 4, "only {deadlocked} deadlocked graphs");
        assert!(healthy >= 4, "only {healthy} healthy graphs");
        assert!(
            mismatches.is_empty(),
            "the Rust detection disagrees with the live TypeScript on {} of {} cases:\n{}",
            mismatches.len(),
            cases.len(),
            mismatches.join("\n")
        );
    }

    fn waiter(session: &str, deps: &[&str]) -> Waiter {
        Waiter {
            session: session.into(),
            deps: deps.iter().map(|d| CoordRef::Session { id: (*d).to_string() }).collect(),
            checkpoint: None,
            registered_at: 0,
        }
    }

    /// THE SINGLETON RULE. Tarjan makes every node its own component, so reporting singletons would
    /// flag every parked waiter as deadlocked — the detector would fire constantly and be turned off.
    #[test]
    fn a_lone_waiter_is_a_cycle_only_when_it_waits_on_itself() {
        let mut s = CoordState::default();
        s.waiters.push(waiter("a", &["ghost"]));
        assert!(detect_deadlocks(&s, &default_producer_of).is_empty(), "waiting on a non-waiter is not a ring");

        let mut s = CoordState::default();
        s.waiters.push(waiter("a", &["a"]));
        assert_eq!(
            detect_deadlocks(&s, &default_producer_of),
            vec![Deadlock { cycle: vec!["a".into()] }],
            "a session waiting on itself never wakes"
        );
    }

    /// THE PARKED-PRODUCER RULE. A dep on a session that is still RUNNING is an ordinary wait.
    #[test]
    fn an_edge_is_only_drawn_to_another_parked_waiter() {
        let mut s = CoordState::default();
        s.waiters.push(waiter("a", &["b"]));
        assert!(!has_deadlock(&s, &default_producer_of), "b is not parked — it can still finish");

        s.waiters.push(waiter("b", &["a"]));
        assert!(has_deadlock(&s, &default_producer_of), "now neither can move");
    }

    /// A SATISFIED dep imposes no wait, so breaking one latch dissolves a ring.
    #[test]
    fn satisfying_one_dep_dissolves_the_ring() {
        let mut s = CoordState::default();
        s.waiters.push(waiter("a", &["b"]));
        s.waiters.push(waiter("b", &["a"]));
        assert!(has_deadlock(&s, &default_producer_of));

        s.latches.insert("session:a".into(), LatchStatus::Satisfied { source: SatisfySource::Landed, at: 1 });
        assert!(!has_deadlock(&s, &default_producer_of), "b's dep is satisfied, so b has no outgoing edge");
    }

    /// A FAILED latch is not satisfied — a waiter blocked on a failure is still blocked, and must not
    /// be quietly treated as unblocked.
    #[test]
    fn a_failed_latch_does_not_break_a_ring() {
        let mut s = CoordState::default();
        s.waiters.push(waiter("a", &["b"]));
        s.waiters.push(waiter("b", &["a"]));
        s.latches.insert("session:a".into(), LatchStatus::Failed { reason: "boom".into(), at: 1 });
        assert!(has_deadlock(&s, &default_producer_of), "failed is not satisfied");
    }

    /// The injected matcher is what decides `file:` ownership — this crate does not choose a glob
    /// engine, because which semantics is correct is still an open question.
    #[test]
    fn the_file_matcher_is_injected_not_chosen() {
        let producers = vec![SessionProduces {
            session: "owner".into(),
            owns: vec!["src/**".into()],
            ..Default::default()
        }];
        // A matcher that never matches resolves no owner…
        let never = build_producer_of(&producers, |_, _| false);
        assert_eq!(never(&CoordRef::File { path: "src/a.rs".into() }), None);
        // …and one that does, does. The DECISION is the caller's.
        let always = build_producer_of(&producers, |_, _| true);
        assert_eq!(always(&CoordRef::File { path: "src/a.rs".into() }).as_deref(), Some("owner"));
    }

    /// First declaration wins on a contract collision — a later one is a data defect, not an override.
    #[test]
    fn the_first_declaration_of_a_contract_wins() {
        let producers = vec![
            SessionProduces { session: "first".into(), contracts: vec!["api".into()], ..Default::default() },
            SessionProduces { session: "second".into(), contracts: vec!["api".into()], ..Default::default() },
        ];
        let r = build_producer_of(&producers, |_, _| false);
        assert_eq!(r(&CoordRef::Contract { name: "api".into() }).as_deref(), Some("first"));
    }
}
