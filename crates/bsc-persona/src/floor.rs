//! The persona permission FLOOR and its narrow-only clamp (epic `the-persona-is-the-whole-agent`).
//!
//! ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
//! A persona used to REFERENCE a role, and the capability that role carried lived elsewhere — the
//! access tiers in `data/permissions/role-capabilities.json`, the confined command surface as a TS
//! const. Neither was reachable from this store, so `bsc persona set` was a fully generic JSON
//! passthrough: it round-trips `unknownFutureField: 42` verbatim, and `bsc` is in the always-allowed
//! mandatory tier. Any session could therefore run
//!
//! ```text
//! bsc persona get X | jq '.role = "debugger"' | bsc persona set
//! ```
//!
//! and `debugger` is `write` on github, git, code AND ui. Nothing rejected it. That was not live only
//! because `persona.role` reached no launch path — the studio sessions carry their own hardcoded role
//! beside `personaId`. The moment the persona becomes the launch primitive, it is live.
//!
//! So the floor moves onto the persona, and the write is checked HERE, at the one place every write
//! passes through.
//!
//! ── THE RULE: NARROW-ONLY, AND IT IS A BOUNDARY ─────────────────────────────────────────────────
//! A floor may only ever NARROW the floor of the persona it derives from:
//!
//!   * editing an existing persona  ⇒ the ancestor is its own CURRENT stored floor
//!   * creating a new one           ⇒ the ancestor is the persona named by `derivesFrom`
//!   * creating one with no ancestor ⇒ the floor must be all-`none` — a new persona FAILS CLOSED
//!
//! This is deliberately a property of the WRITE, not of the CALLER. Identity checks are spoofable
//! from a session that controls its own environment; "the resulting floor is not wider than what was
//! already there" is not. Restricting persona writes to the architect is a POLICY layered on top
//! (its denied-command entry and its protocol) — real friction, but the deny hook matches a spaced
//! pattern as a substring (`bsc  persona set` walks through it) and under bypass posture the
//! allow-list is ignored entirely. The clamp is what holds regardless.
//!
//! The worst a non-architect can therefore do is narrow a persona into uselessness. That is a
//! denial-of-service, not an escalation, and it is recoverable: a built-in's floor is re-seeded from
//! its packaged JSON, which is authoritative for a built-in.
//!
//! ── WHAT NARROWING MEANS PER FIELD ──────────────────────────────────────────────────────────────
//! Each field narrows in the direction that REMOVES reach. See the per-check docs below; the one
//! non-obvious case is `allow`, where ABSENCE is a widening rather than a no-op.

use serde_json::Value;

/// The five access axes, in the order the role gate reasons about them (#219).
pub const AXES: [&str; 5] = ["github", "git", "code", "net", "ui"];

/// `none` < `read` < `write`. An unknown string sorts as `none` — the safe direction: an unreadable
/// tier can then never be the thing that lets a widening through.
fn tier_rank(tier: &str) -> u8 {
    match tier {
        "write" => 2,
        "read" => 1,
        _ => 0,
    }
}

/// A floor whose every axis is `none` and which grants nothing — what a persona with no ancestor is
/// held to, so a brand-new persona can never be born with capability it was not derived from.
pub fn closed_floor() -> Value {
    let mut floor = serde_json::Map::new();
    for axis in AXES {
        floor.insert(axis.to_string(), Value::String("none".into()));
    }
    Value::Object(floor)
}

fn str_list(floor: &Value, key: &str) -> Option<Vec<String>> {
    floor.get(key)?.as_array().map(|a| {
        a.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect()
    })
}

/// The literal prefix of a glob — everything before the first wildcard. `scratch/**` ⇒ `scratch/`.
fn glob_prefix(glob: &str) -> &str {
    match glob.find(['*', '?', '[']) {
        Some(i) => &glob[..i],
        None => glob,
    }
}

/// Is `child` within the boundary `ancestor` describes?
///
/// Exact match, or a PREFIX-EXTENSION of one of the ancestor's globs (`scratch/**` admits
/// `scratch/kits/**`, and refuses `src/**`). Full glob-containment is undecidable in the general
/// case, so this covers the shape real narrowing takes and refuses everything it cannot prove —
/// refusing is the safe direction, and the error names the ancestor glob so the fix is obvious.
fn glob_within(child: &str, ancestor: &[String]) -> bool {
    ancestor
        .iter()
        .any(|a| a == child || (!glob_prefix(a).is_empty() && child.starts_with(glob_prefix(a))))
}

/// Every way `child` exceeds `ancestor`, as human-readable clauses. EMPTY means the write only
/// narrows and may proceed.
///
/// A STORED floor is complete, not a patch: the store writes what it is given, so an absent field is
/// absent at launch too. Each omission is therefore judged by WHAT LAUNCH WOULD READ, and that is not
/// uniform across the fields — which is the one genuinely surprising thing here:
///
///   * an omitted AXIS reads as `none`             ⇒ the narrowest value, never a widening
///   * omitted `writeGlobs` / `harvestRoots` read as empty ⇒ likewise
///   * an omitted `allow` reads as UNCONFINED      ⇒ the WIDEST value, so it must be checked
///
/// `allow` is inverted because its PRESENCE is what marks a persona confined at all (`isRestrictedRole`
/// is "has a non-empty list"). Dropping it promotes a session pinned to one store CLI into one running
/// the broad baseline allow-list. Treating absence as "inherit" would have waved exactly that through,
/// and an earlier draft of this module did.
pub fn widenings(child: &Value, ancestor: &Value) -> Vec<String> {
    let mut out = Vec::new();

    for axis in AXES {
        let Some(want) = child.get(axis).and_then(Value::as_str) else {
            continue; // omitted ⇒ launch reads `none`, the narrowest value; never a widening
        };
        let have = ancestor.get(axis).and_then(Value::as_str).unwrap_or("none");
        if tier_rank(want) > tier_rank(have) {
            out.push(format!("{axis}: '{want}' exceeds '{have}'"));
        }
    }

    // writeGlobs — every glob must fall inside the ancestor's boundary. An ancestor with NO globs
    // has no boundary to be inside, so any glob at all is a widening.
    if let Some(want) = str_list(child, "writeGlobs") {
        let have = str_list(ancestor, "writeGlobs").unwrap_or_default();
        for glob in want {
            if !glob_within(&glob, &have) {
                out.push(match have.is_empty() {
                    true => format!("writeGlobs: '{glob}' — the ancestor grants no write scope at all"),
                    false => format!("writeGlobs: '{glob}' is outside the ancestor's scope ({})", have.join(" ")),
                });
            }
        }
    }

    // harvestRoots — read reach. A root the ancestor does not hold is more reach, so subset only.
    //
    // NOTE the direction, because the same field is UNIONed elsewhere and the two are easy to
    // confuse: `floorLists` in the TS role model unions harvest roots when REFRESHING a stale
    // config mirror against the shipped default, so a mirror can never revoke a grant the app now
    // ships. That is the refresh direction. This is the DERIVE direction, where a child adding a
    // root its ancestor lacks is exactly the escalation being prevented.
    if let Some(want) = str_list(child, "harvestRoots") {
        let have = str_list(ancestor, "harvestRoots").unwrap_or_default();
        for root in want {
            if !have.contains(&root) {
                out.push(format!("harvestRoots: '{root}' is not one the ancestor holds"));
            }
        }
    }

    // allow — the confined store-CLI surface. ABSENCE IS A WIDENING, not a no-op: the PRESENCE of a
    // non-empty list is what marks a persona as confined at all, so dropping it promotes a confined
    // persona to an unconfined one. That is the single most valuable thing this check catches, and
    // it is the one a subset test alone would wave through.
    let want_allow = str_list(child, "allow");
    let have_allow = str_list(ancestor, "allow");
    match (&want_allow, &have_allow) {
        (None, Some(have)) if !have.is_empty() => {
            out.push("allow: dropping the list would lift the confined command surface entirely".into());
        }
        (Some(want), Some(have)) if !have.is_empty() => {
            for cmd in want {
                if !have.contains(cmd) {
                    out.push(format!("allow: '{cmd}' is not on the ancestor's surface"));
                }
            }
        }
        // ancestor unconfined ⇒ a child MAY introduce a surface (that is a narrowing), and both
        // absent is trivially fine.
        _ => {}
    }

    // surfaces — the `bsc` COMMAND SURFACES this persona drives
    // (`a-persona-declares-its-command-surfaces`). Judged by the SAME inverted rule as `allow`, and
    // for the same reason: `bsc` is in the permission model's mandatory tier, so a persona that
    // declares no surfaces reaches every one of them. Absence is therefore the WIDEST value, and
    // dropping the list promotes a worker pinned to five stores into one driving the whole CLI.
    //
    // A plain subset test would wave that through — which is exactly the case the `allow` check above
    // exists for, so the two are deliberately the same shape rather than sharing a helper that would
    // make the inversion easy to miss when reading either one.
    let want_surfaces = str_list(child, "surfaces");
    let have_surfaces = str_list(ancestor, "surfaces");
    match (&want_surfaces, &have_surfaces) {
        (None, Some(have)) if !have.is_empty() => {
            out.push("surfaces: dropping the list would lift the declared command-surface set entirely".into());
        }
        (Some(want), Some(have)) if !have.is_empty() => {
            for surface in want {
                if !have.contains(surface) {
                    out.push(format!("surfaces: '{surface}' is not one the ancestor drives"));
                }
            }
        }
        _ => {}
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// A CONFINED ancestor — it carries an `allow` surface, so any child that omits one is widening.
    fn ancestor() -> Value {
        json!({
            "github": "read", "git": "write", "code": "write", "net": "read", "ui": "read",
            "writeGlobs": ["scratch/**"],
            "harvestRoots": ["app-repo", "projects"],
            "allow": ["bsc ui", "bsc graph"]
        })
    }

    /// The same floor WITHOUT a confined surface. The axis/glob/root cases use this one so the
    /// `allow` rule cannot mask what they are actually asserting — the failure that made this split
    /// necessary was six tests all going red for the one reason none of them was about.
    fn open_ancestor() -> Value {
        let mut v = ancestor();
        v.as_object_mut().unwrap().remove("allow");
        v
    }

    #[test]
    fn an_identical_floor_is_not_a_widening() {
        assert!(widenings(&ancestor(), &ancestor()).is_empty());
    }

    #[test]
    fn narrowing_every_axis_is_allowed() {
        let child = json!({ "github": "none", "git": "read", "code": "none", "net": "none", "ui": "none" });
        assert!(widenings(&child, &open_ancestor()).is_empty());
    }

    #[test]
    fn raising_a_tier_is_refused_and_the_message_names_both_ends() {
        let child = json!({ "github": "write" });
        let out = widenings(&child, &open_ancestor());
        assert_eq!(out, vec!["github: 'write' exceeds 'read'"]);
    }

    #[test]
    fn an_omitted_axis_is_never_a_widening() {
        // An empty floor grants nothing, so against an UNCONFINED ancestor it is pure narrowing.
        assert!(widenings(&json!({}), &open_ancestor()).is_empty());
    }

    #[test]
    fn an_empty_floor_against_a_confined_ancestor_widens_by_dropping_the_surface() {
        // The asymmetry, pinned: the same `{}` that is harmless above lifts a confined persona's
        // command surface, and that is the one omission that widens rather than narrows.
        let out = widenings(&json!({}), &ancestor());
        assert_eq!(out.len(), 1, "{out:?}");
        assert!(out[0].starts_with("allow: dropping the list"), "{out:?}");
    }

    #[test]
    fn an_unknown_tier_string_sorts_as_none_so_it_cannot_smuggle_a_widening() {
        let child = json!({ "code": "superuser" });
        assert!(widenings(&child, &open_ancestor()).is_empty(), "unknown tiers must not rank above write");
    }

    #[test]
    fn a_sub_glob_narrows_but_an_unrelated_one_does_not() {
        let ok = json!({ "writeGlobs": ["scratch/kits/**"] });
        assert!(widenings(&ok, &open_ancestor()).is_empty());

        let bad = json!({ "writeGlobs": ["src/**"] });
        assert_eq!(widenings(&bad, &open_ancestor()).len(), 1);
    }

    #[test]
    fn any_write_glob_is_a_widening_when_the_ancestor_grants_none() {
        let anc = json!({ "github": "none", "git": "none", "code": "none", "net": "none", "ui": "none" });
        let child = json!({ "writeGlobs": ["scratch/**"] });
        let out = widenings(&child, &anc);
        assert_eq!(out.len(), 1);
        assert!(out[0].contains("no write scope at all"), "{out:?}");
    }

    #[test]
    fn a_harvest_root_the_ancestor_lacks_is_refused() {
        let child = json!({ "harvestRoots": ["app-repo", "somewhere-else"] });
        let out = widenings(&child, &open_ancestor());
        assert_eq!(out, vec!["harvestRoots: 'somewhere-else' is not one the ancestor holds"]);
    }

    #[test]
    fn dropping_the_confined_surface_is_a_widening() {
        // The case a plain subset test waves through, and the most valuable one here.
        let child = json!({ "github": "none" });
        let out = widenings(&child, &ancestor());
        assert_eq!(out.len(), 1);
        assert!(out[0].starts_with("allow: dropping the list"), "{out:?}");
    }

    #[test]
    fn shrinking_the_confined_surface_is_allowed() {
        let child = json!({ "allow": ["bsc ui"] });
        assert!(widenings(&child, &ancestor()).is_empty());
    }

    #[test]
    fn adding_a_command_to_the_confined_surface_is_refused() {
        let child = json!({ "allow": ["bsc ui", "bsc persona"] });
        let out = widenings(&child, &ancestor());
        assert_eq!(out, vec!["allow: 'bsc persona' is not on the ancestor's surface"]);
    }

    #[test]
    fn an_unconfined_ancestor_may_gain_a_surface_because_that_confines_it() {
        let anc = json!({ "github": "read", "git": "read", "code": "none", "net": "read", "ui": "read" });
        let child = json!({ "allow": ["bsc plan"] });
        assert!(widenings(&child, &anc).is_empty());
    }

    #[test]
    fn the_closed_floor_admits_nothing() {
        for axis in AXES {
            let child = json!({ axis: "read" });
            assert_eq!(widenings(&child, &closed_floor()).len(), 1, "axis {axis} escaped the closed floor");
        }
    }

    /// A persona that DECLARES command surfaces (`a-persona-declares-its-command-surfaces`). The
    /// worker's real shape: unconfined (no `allow`, so it keeps its baseline command tiers) but held
    /// to a named set of `bsc` surfaces.
    fn declaring_ancestor() -> Value {
        json!({
            "github": "read", "git": "write", "code": "write", "net": "read", "ui": "read",
            "surfaces": ["plan", "graph", "ui", "files", "errors"]
        })
    }

    #[test]
    fn dropping_the_declared_surfaces_is_a_widening_not_a_no_op() {
        // The case a subset test waves through: `bsc` is in the mandatory tier, so a persona with no
        // `surfaces` reaches EVERY surface. Omission is the widest value, exactly as for `allow`.
        let child = json!({ "github": "read", "git": "write", "code": "write", "net": "read", "ui": "read" });
        let out = widenings(&child, &declaring_ancestor());
        assert_eq!(
            out,
            vec!["surfaces: dropping the list would lift the declared command-surface set entirely"]
        );
    }

    #[test]
    fn a_declared_surface_the_ancestor_does_not_drive_is_refused() {
        let child = json!({ "surfaces": ["plan", "fleet"] });
        let out = widenings(&child, &declaring_ancestor());
        assert_eq!(out, vec!["surfaces: 'fleet' is not one the ancestor drives"]);
    }

    #[test]
    fn narrowing_the_declared_surfaces_is_allowed() {
        let child = json!({ "surfaces": ["plan"] });
        assert!(widenings(&child, &declaring_ancestor()).is_empty());
    }

    #[test]
    fn an_undeclared_ancestor_may_gain_surfaces_because_that_narrows_it() {
        // The direction every still-undeclared role will travel: triage/tester/reviewer declare for
        // the first time, which is a restriction, not an escalation.
        let anc = json!({ "github": "read", "git": "read", "code": "none", "net": "read", "ui": "read" });
        let child = json!({ "surfaces": ["plan"] });
        assert!(widenings(&child, &anc).is_empty());
    }

    #[test]
    fn the_surfaces_rule_is_independent_of_the_allow_rule() {
        // Both are inverted, and an earlier draft checked only one. A persona can be unconfined
        // (no `allow`) AND declaring (`surfaces`), which is exactly the worker — so a child dropping
        // `surfaces` must be caught even though there is no `allow` anywhere in the comparison.
        let child = json!({ "allow": ["bsc plan"] });
        let out = widenings(&child, &declaring_ancestor());
        assert!(
            out.iter().any(|w| w.starts_with("surfaces:")),
            "the surfaces drop was missed: {out:?}"
        );
    }
}
