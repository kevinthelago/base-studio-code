//! The canonical pane ACTIVITY status (#435) and how it rolls up to a tab.
//!
//! Ported from `src/app/console/lib/paneStatus.ts` under
//! `epic-frontend-logic-over-backend-resources-belongs-in-rust`, and proved against
//! `src/app/console/paneIdentity.fixtures.json`, generated from that TypeScript.
//!
//! # Why this belongs on this side
//!
//! ONE vocabulary serves three readers — the dot in a console pane, the dot on a tab, and the
//! tunnel's desktop→mobile status mapping. The third is the argument: a phone asks the desktop what a
//! pane is doing, and until now the answer was computed in a renderer the phone cannot see. The data
//! it reasons over is already here — `console/pty/reap.rs` owns `RunState`, `Activity` and
//! `should_reap` — so this is the reasoning catching up with the resource.
//!
//! # The two rules that are easy to port wrongly
//!
//! * **The rollup is over the CURRENT grid**, recomputed whole, never mutated incrementally. A status
//!   left behind by a closed or remounted pane is outside the layout and is simply not read, which is
//!   what stops a stale `Run` stranding a tab. A port that iterated the status map instead of the grid
//!   would reproduce every ordinary case and resurrect exactly that bug.
//! * **A disabled cell is excluded, not defaulted.** It does not contribute `Idle`; it contributes
//!   nothing. The difference is invisible unless a disabled pane holds the only `Run`.

use crate::pane_id::{pane_belongs_to_tab, pane_id_for, IdentityTab};
use std::collections::BTreeMap;

/// A pane's activity, in the one vocabulary the grid, the tab and the phone all read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PaneStatus {
    /// No live session in the cell.
    Idle,
    /// A session is attached but at rest, at its prompt.
    On,
    /// A session is actively working — its turn is in flight.
    Run,
}

impl PaneStatus {
    /// The wire spelling the TypeScript uses — what the fixture carries.
    pub fn as_str(self) -> &'static str {
        match self {
            PaneStatus::Idle => "idle",
            PaneStatus::On => "on",
            PaneStatus::Run => "run",
        }
    }

    /// Parse the wire spelling. An unknown value is `None` rather than a silent `Idle`: a status this
    /// side does not recognise is a disagreement to surface, not one to average away.
    pub fn parse(s: &str) -> Option<PaneStatus> {
        match s {
            "idle" => Some(PaneStatus::Idle),
            "on" => Some(PaneStatus::On),
            "run" => Some(PaneStatus::Run),
            _ => None,
        }
    }
}

/// Pane-cell count for a `"C×R"` layout string.
///
/// A malformed layout falls back to 1, and so does a ZERO dimension — `2×0` is one cell, not none,
/// because the TypeScript's `(c || 1) * (r || 1)` reads `0` as falsy. That is a sentinel, not an
/// arithmetic result, and it needs its own fixture case: a corpus of real grids passes either version.
pub fn pane_count_for_layout(layout: &str) -> i64 {
    let mut parts = layout.split('×');
    let c: i64 = parts.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    let r: i64 = parts.next().and_then(|x| x.trim().parse().ok()).unwrap_or(0);
    let c = if c == 0 { 1 } else { c };
    let r = if r == 0 { 1 } else { r };
    c * r
}

/// Roll a tab's per-pane statuses up to one tab-level status (#435).
///
/// Only panes IN the current grid and NOT disabled contribute. Precedence: any live `Run` ⇒ `Run`;
/// else any `On` ⇒ `On`; else `Idle`. A pane that paused mid-turn never pulls a tab out of `Run` while
/// another cell is still working, because the rollup is over the whole live set rather than the last
/// event.
pub fn aggregate_tab_state(
    tab: &IdentityTab,
    layout: &str,
    tab_idx: i64,
    statuses: &BTreeMap<String, PaneStatus>,
    disabled: &BTreeMap<String, bool>,
) -> PaneStatus {
    let count = pane_count_for_layout(layout);
    let mut result = PaneStatus::Idle;
    for i in 0..count {
        let pid = pane_id_for(Some(tab), tab_idx, i);
        if disabled.get(&pid).copied().unwrap_or(false) {
            continue;
        }
        match statuses.get(&pid).copied().unwrap_or(PaneStatus::Idle) {
            PaneStatus::Run => return PaneStatus::Run,
            PaneStatus::On => result = PaneStatus::On,
            PaneStatus::Idle => {}
        }
    }
    result
}

/// Drop every per-pane status belonging to `tab` (at grid index `tab_idx`), returning a NEW map.
///
/// Used when a tab's panes remount or the tab closes, so a previous session's `Run`/`On` cannot linger
/// as a stale dot on the fresh panes. Membership is by IDENTITY, so a manual or minted fleet/triage
/// pane is cleared too — the positional parse this replaced silently kept them.
///
/// An id that belongs to no tab (unparseable, or another tab's) SURVIVES. That asymmetry is the whole
/// function: returning an empty map would satisfy every corpus whose entries all belong to the tab.
pub fn clear_tab_statuses(
    statuses: &BTreeMap<String, PaneStatus>,
    tab: &IdentityTab,
    tab_idx: i64,
) -> BTreeMap<String, PaneStatus> {
    statuses
        .iter()
        .filter(|(pid, _)| !pane_belongs_to_tab(pid, tab, tab_idx))
        .map(|(k, v)| (k.clone(), *v))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane_id::find_pane_owner_tab;
    use serde_json::Value;

    /// The SAME fixture `pane_id`'s tests read, resolved the same way — by filename under `src/`, with
    /// exactly one match required. One artifact for the whole grammar and the reasoning on top of it,
    /// rather than a second contract that can drift from the first.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("paneIdentity.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one paneIdentity.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// The tab shapes the fixture's `tabLabel` names. Kept in ONE place so the label is the join and a
    /// renamed case fails loudly rather than silently testing the wrong tab.
    fn tab_for(label: &str) -> (IdentityTab, &'static str) {
        let mint = |v: &[Option<&str>]| v.iter().map(|o| o.map(str::to_string)).collect::<Vec<_>>();
        match label {
            "legacy id-less" => (IdentityTab::default(), "2×1"),
            "manual with stable id" => (IdentityTab { id: Some("tab_abc".into()), ..Default::default() }, "2×2"),
            "build kind, no mints" => (
                IdentityTab { id: Some("tab_fleet".into()), kind: Some("build".into()), ..Default::default() },
                "2×1",
            ),
            "build kind with mints" => (
                IdentityTab {
                    id: Some("tab_f2".into()),
                    kind: Some("build".into()),
                    pane_ids: mint(&[Some("studio-code:director"), Some("studio-code:api")]),
                },
                "2×2",
            ),
            "triage kind, sparse mints" => (
                IdentityTab {
                    id: Some("tab_t".into()),
                    kind: Some("triage".into()),
                    pane_ids: mint(&[None, Some("alpha:repo:triage")]),
                },
                "2×1",
            ),
            "manual with sparse mints" => (
                IdentityTab { id: Some("tab_m2".into()), pane_ids: mint(&[None, Some("studio-code:api")]), ..Default::default() },
                "2×1",
            ),
            "malformed layout" => (IdentityTab { id: Some("tab_bad".into()), ..Default::default() }, "not-a-layout"),
            "one-cell layout" => (IdentityTab { id: Some("tab_one".into()), ..Default::default() }, "1×1"),
            other => panic!("fixture names a tab this test does not know: {other:?}"),
        }
    }

    fn statuses_of(v: &Value, key: &str) -> BTreeMap<String, PaneStatus> {
        v.get(key)
            .and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .map(|(k, s)| {
                        let raw = s.as_str().expect("a status is a string");
                        (k.clone(), PaneStatus::parse(raw).unwrap_or_else(|| panic!("unknown status {raw:?}")))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reports EVERY mismatch at once rather than dying on the first — when a port is wrong it is
    /// usually wrong in a PATTERN, and one failing assertion hides the shape of it.
    #[test]
    fn the_rollup_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let mut bad: Vec<String> = Vec::new();

        for c in doc["layouts"].as_array().expect("layouts") {
            let (layout, want) = (c["layout"].as_str().unwrap(), c["count"].as_i64().unwrap());
            let got = pane_count_for_layout(layout);
            if got != want {
                bad.push(format!("  layout {layout:?}: ts {want}, rust {got}"));
            }
        }

        for c in doc["idFor"].as_array().expect("idFor") {
            let (tab, _) = tab_for(c["tabLabel"].as_str().unwrap());
            let got = pane_id_for(Some(&tab), c["tabIdx"].as_i64().unwrap(), c["paneIdx"].as_i64().unwrap());
            let want = c["id"].as_str().unwrap();
            if got != want {
                bad.push(format!("  idFor {} [{}][{}]: ts {want:?}, rust {got:?}", c["tabLabel"], c["tabIdx"], c["paneIdx"]));
            }
        }

        for c in doc["idForNoTab"].as_array().expect("idForNoTab") {
            let got = pane_id_for(None, c["tabIdx"].as_i64().unwrap(), c["paneIdx"].as_i64().unwrap());
            let want = c["id"].as_str().unwrap();
            if got != want {
                bad.push(format!("  idFor(no tab) [{}][{}]: ts {want:?}, rust {got:?}", c["tabIdx"], c["paneIdx"]));
            }
        }

        for c in doc["membership"].as_array().expect("membership") {
            let (tab, _) = tab_for(c["tabLabel"].as_str().unwrap());
            let got = pane_belongs_to_tab(c["paneId"].as_str().unwrap(), &tab, c["tabIdx"].as_i64().unwrap());
            let want = c["belongs"].as_bool().unwrap();
            if got != want {
                bad.push(format!("  belongs {:?} to {} @{}: ts {want}, rust {got}", c["paneId"], c["tabLabel"], c["tabIdx"]));
            }
        }

        for c in doc["rollups"].as_array().expect("rollups") {
            let label = c["label"].as_str().unwrap();
            let (tab, _) = tab_for(tab_label_for_rollup(label));
            let got = aggregate_tab_state(
                &tab,
                c["layout"].as_str().unwrap(),
                c["tabIdx"].as_i64().unwrap(),
                &statuses_of(c, "statuses"),
                &c["disabled"]
                    .as_object()
                    .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_bool().unwrap_or(false))).collect())
                    .unwrap_or_default(),
            );
            let want = c["state"].as_str().unwrap();
            if got.as_str() != want {
                bad.push(format!("  rollup {label:?}: ts {want}, rust {}", got.as_str()));
            }
        }

        for c in doc["clears"].as_array().expect("clears") {
            let label = c["label"].as_str().unwrap();
            let (tab, _) = tab_for(tab_label_for_clear(label));
            let got = clear_tab_statuses(&statuses_of(c, "statuses"), &tab, c["tabIdx"].as_i64().unwrap());
            // WHOLE MAP compared, in key order — a count would let "cleared everything" and "cleared
            // nothing" both pass on a corpus that happens to be symmetric.
            let want = statuses_of(c, "remaining");
            if got != want {
                bad.push(format!("  clear {label:?}: ts {want:?}, rust {got:?}"));
            }
        }

        assert!(bad.is_empty(), "the Rust rollup disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// Which tab each rollup case is about. In the generator these are indices into `TABS`; here the
    /// mapping is written out so a reader can see it, and an unknown label panics.
    fn tab_label_for_rollup(label: &str) -> &'static str {
        match label {
            "out-of-grid status ignored" => "one-cell layout",
            "manual tab rolls up by man: id" => "manual with stable id",
            "minted build ids roll up" | "minted id disabled" => "build kind with mints",
            "sparse mints: hole falls through to positional" => "triage kind, sparse mints",
            _ => "legacy id-less",
        }
    }

    fn tab_label_for_clear(label: &str) -> &'static str {
        match label {
            "drops own manual, keeps a different manual tab's" | "keeps everything when nothing belongs" => {
                "manual with stable id"
            }
            "drops minted ids it owns, keeps a minted id it does not" => "build kind with mints",
            _ => "legacy id-less",
        }
    }

    /// INVARIANTS, asserted separately from the parity — a fixture case can be right for the wrong
    /// reason, and these are the rules the doc comments claim.
    #[test]
    fn a_disabled_cell_contributes_nothing_rather_than_idle() {
        let tab = IdentityTab::default();
        let statuses: BTreeMap<String, PaneStatus> = [("t0p0".to_string(), PaneStatus::Run)].into();
        let none: BTreeMap<String, bool> = BTreeMap::new();
        assert_eq!(aggregate_tab_state(&tab, "2×1", 0, &statuses, &none), PaneStatus::Run);
        let off: BTreeMap<String, bool> = [("t0p0".to_string(), true)].into();
        assert_eq!(
            aggregate_tab_state(&tab, "2×1", 0, &statuses, &off),
            PaneStatus::Idle,
            "a disabled cell holding the only Run must not keep the tab running"
        );
    }

    /// The rollup reads the GRID, not the status map — which is what stops a stale entry from a closed
    /// pane stranding a tab in Run. Iterating the map instead would pass every ordinary case.
    #[test]
    fn a_status_outside_the_current_layout_is_not_read() {
        let tab = IdentityTab::default();
        let statuses: BTreeMap<String, PaneStatus> = [("t0p7".to_string(), PaneStatus::Run)].into();
        assert_eq!(
            aggregate_tab_state(&tab, "1×1", 0, &statuses, &BTreeMap::new()),
            PaneStatus::Idle,
            "a Run left by a pane the grid no longer has must not be counted"
        );
    }

    /// `0` is a SENTINEL in the layout arithmetic, not a dimension.
    #[test]
    fn a_zero_dimension_is_one_cell_not_none() {
        assert_eq!(pane_count_for_layout("2×0"), 2);
        assert_eq!(pane_count_for_layout("0×3"), 3);
        assert_eq!(pane_count_for_layout("not-a-layout"), 1);
        assert_eq!(pane_count_for_layout(""), 1);
    }

    /// The owner scan is by identity, so a minted id resolves to its tab rather than to nothing.
    #[test]
    fn the_owner_scan_finds_a_minted_pane_no_positional_parse_could() {
        let tabs = vec![
            IdentityTab::default(),
            IdentityTab { id: Some("tab_f2".into()), kind: Some("build".into()), pane_ids: vec![Some("studio-code:api".into())] },
        ];
        let (_, idx) = find_pane_owner_tab(&tabs, "studio-code:api").expect("the minted pane has an owner");
        assert_eq!(idx, 1);
        assert!(find_pane_owner_tab(&tabs, "alpha:web").is_none());
    }
}
