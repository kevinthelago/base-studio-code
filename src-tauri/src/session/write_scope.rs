//! The write-scope environment a session launches with — `$BSC_SCOPE_GLOBS` and `$BSC_SCOPES`.
//!
//! # Why this is the hard deny
//!
//! The role gate's write rules are ALLOW-only, and an allow-list is not a block: under the bypass
//! posture `permissions.deny` is ignored entirely. `$BSC_SCOPE_GLOBS` is what closes that — the
//! `bsc-scope` PreToolUse hook refuses any Edit/Write outside those globs, and a hook fires under both
//! postures. `$BSC_SCOPES` is the same shape one level down: the role's per-store access tiers, which
//! the store CLIs check before a mutating verb (#2470).
//!
//! Rust already owned the enforcing half of both — `crates/bsc-hook/src/main.rs` reads
//! `$BSC_SCOPE_GLOBS` and blocks; `crates/bsc-cli-util` reads `$BSC_SCOPES` and refuses a store write
//! — and computed neither. `console/pty` copied the strings into the child env. This closes that.
//!
//! # The three-way branch, and why its ORDER is the whole thing
//!
//! | condition                     | `$BSC_SCOPE_GLOBS`            |
//! |-------------------------------|-------------------------------|
//! | scoped globs, non-empty       | the globs, space-joined       |
//! | empty AND `code: none`        | [`DENY_ALL`] (#1916 Step 3.5) |
//! | empty AND `code` is not none  | UNSET — the pane stays allow-all |
//!
//! The middle branch is the one that must not be lost. `bsc_util::scope::scope_verdict` reads an
//! ABSENT scope as "no scope configured" and ALLOWS, so a `code: none` role falling through to unset
//! would be silently converted from "may write nothing" into "may write anywhere" — a hard deny
//! inverted into a permit, on exactly the roles most restricted.
//!
//! Note that `code: none` does NOT imply the sentinel: a carve-out role (`documentor`, `designer`,
//! `architect`, `librarian`, `sound-designer`, `marketer`) is `code: none` WITH globs and takes the
//! first branch. Conversely a `code: none` role given globs it has no carve-out for — a `triage` pane
//! handed `src/**` — still gets the sentinel, because [`scope_write_globs`] refuses to hand it any.
//!
//! # The sentinel was a cross-language agreement held together by a comment
//!
//! The TypeScript declares `SCOPE_DENY_ALL = "__bsc_deny_all__"` saying it "MUST match the literal in
//! `bsc-scope`", and Rust declares [`DENY_ALL`] with the same string. Nothing compared them. The
//! failure mode of a drift is silent and total: the hook would treat the sentinel as an ordinary glob,
//! match no path, and every write from a `code: none` session would pass. This module REUSES the Rust
//! constant and `the_deny_all_sentinel_matches_the_typescript` asserts the equality against the
//! generated fixture, so the agreement is now tested rather than asserted in prose.

// UNWIRED BY DESIGN, and the `allow` names the item that wires it. Deriving the scope and FLIPPING the
// launch are separate slices with separate reverts — this env is what the only bypass-posture write
// block reads.
#![allow(dead_code)] // wired by `the-launch-derives-its-own-write-scope-instead-of-receiving-it`

use bsc_util::scope::DENY_ALL;

use super::role_gate::{has_scoped_write_carve_out, session_scopes, RoleCapability, Tier};

/// The globs a session may write within, or empty when it has none.
///
/// A `code: write` role writes its own globs. A `code: none` role writes NOTHING unless it holds a
/// scoped carve-out, which is deliberately a closed list rather than "has globs" — otherwise handing a
/// restricted role a glob would silently widen it, which is the opposite of what supplying a scope is
/// for.
pub fn scope_write_globs(cap: &RoleCapability) -> Vec<String> {
    if cap.code == Tier::Write || has_scoped_write_carve_out(cap) {
        return cap.write_globs.clone();
    }
    Vec::new()
}

/// The two scope environment variables for a gated pane.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteScopeEnv {
    /// `$BSC_SCOPE_GLOBS`. `None` means the variable is UNSET — an ungated, allow-all pane.
    pub scope_globs: Option<String>,
    /// `$BSC_SCOPES`, the per-store tiers as JSON.
    pub scopes: String,
}

/// Derive the write-scope env for a pane holding `cap`.
///
/// A pane with NO role capability gets neither variable; that is the caller's branch, not this one, and
/// it is why this takes a `&RoleCapability` rather than an `Option`.
pub fn write_scope_env(cap: &RoleCapability) -> WriteScopeEnv {
    let globs = scope_write_globs(cap);
    let scope_globs = if !globs.is_empty() {
        // Space-joined, matching `$BSC_SCOPE_GLOBS`'s own whitespace-separated shape.
        Some(globs.join(" "))
    } else if cap.code == Tier::None {
        Some(DENY_ALL.to_string())
    } else {
        // `code` is only ever `none` or `write` today, so this arm is reached only by `write`. That is
        // an ASSUMPTION about the role model, not a property of this function, and
        // `code_is_only_ever_none_or_write` guards it: a `code: read` role introduced later would fall
        // here and be left UNSET — allow-all — which for a read tier is exactly backwards.
        None
    };
    WriteScopeEnv {
        scope_globs,
        // A BTreeMap, so the key order is stable rather than dependent on insertion.
        scopes: serde_json::to_string(&session_scopes(cap)).expect("session scopes are plain strings"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_util::scope::{scope_verdict, Scope};

    fn fixture() -> serde_json::Value {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("writeScopeEnv.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one writeScopeEnv.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// Reports every mismatch at once — a wrong port is usually wrong in a pattern.
    #[test]
    fn the_write_scope_env_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let cases = doc["cases"].as_array().expect("cases");
        assert!(cases.len() >= 18, "fixture shrank to {} cases — regenerate it", cases.len());

        let (mut scoped, mut sentinel, mut unset) = (0usize, 0usize, 0usize);
        let mut mismatches = Vec::new();
        for case in cases {
            let label = case["label"].as_str().unwrap();
            let Some(cap_json) = case["capability"].as_object() else {
                // The ungated pane: no capability, so this module is never called. Asserted in its own
                // test below rather than folded in here.
                continue;
            };
            let cap: RoleCapability = serde_json::from_value(serde_json::Value::Object(cap_json.clone()))
                .unwrap_or_else(|e| panic!("{label}: capability did not deserialize: {e}"));
            let got = write_scope_env(&cap);
            let want_globs = case["scopeGlobs"].as_str().map(str::to_string);
            let want_scopes = case["scopes"].as_str().unwrap();

            match want_globs.as_deref() {
                None => unset += 1,
                Some(g) if g == DENY_ALL => sentinel += 1,
                Some(_) => scoped += 1,
            }
            if got.scope_globs != want_globs {
                mismatches.push(format!("  {label}\n    ts   {want_globs:?}\n    rust {:?}", got.scope_globs));
            }
            if got.scopes != want_scopes {
                mismatches.push(format!("  {label} SCOPES\n    ts   {want_scopes}\n    rust {}", got.scopes));
            }
        }
        // All three branches must actually be exercised, or the parity is over a corpus that never
        // reaches the branch this module exists for.
        assert!(scoped >= 3, "only {scoped} cases produced real globs");
        assert!(sentinel >= 3, "only {sentinel} cases produced the deny-all sentinel");
        assert!(unset >= 1, "no case left the scope UNSET");
        assert!(
            mismatches.is_empty(),
            "the Rust write-scope env disagrees with the live TypeScript on {} point(s):\n{}",
            mismatches.len(),
            mismatches.join("\n")
        );
    }

    /// THE AGREEMENT THAT WAS ONLY A COMMENT. The TypeScript's `SCOPE_DENY_ALL` and Rust's `DENY_ALL`
    /// are two hard-coded literals in two languages, and nothing compared them until now. A drift is
    /// silent and total: the hook would read the sentinel as an ordinary glob, match no path, and every
    /// write from a `code: none` session would pass.
    #[test]
    fn the_deny_all_sentinel_matches_the_typescript() {
        let doc = fixture();
        assert_eq!(
            doc["denyAllSentinel"].as_str(),
            Some(DENY_ALL),
            "the deny-all sentinel has drifted between the TypeScript and bsc_util::scope"
        );
    }

    /// And the sentinel must be UNDERSTOOD by the side that enforces it — equality of two strings is
    /// only half the agreement. `scope_verdict` must deny under the sentinel a path it would otherwise
    /// allow.
    #[test]
    fn the_enforcing_side_actually_honours_the_sentinel() {
        assert!(
            matches!(scope_verdict("src/main.rs", "", ""), Scope::Allow),
            "an EMPTY scope allows — which is exactly why code:none must not fall through to unset"
        );
        assert!(
            matches!(scope_verdict("src/main.rs", DENY_ALL, ""), Scope::Deny(_)),
            "the sentinel must deny a path an empty scope would allow"
        );
    }

    fn cap(role: &str, code: Tier, globs: &[&str]) -> RoleCapability {
        serde_json::from_value(serde_json::json!({
            "role": role, "git": "none", "github": "none", "net": "none", "code": code,
            "writeGlobs": globs, "ui": "read"
        }))
        .unwrap()
    }

    /// The middle branch, stated directly — the inversion this module exists to prevent.
    #[test]
    fn a_code_none_role_with_no_globs_denies_all_rather_than_falling_through_to_unset() {
        let e = write_scope_env(&cap("triage", Tier::None, &[]));
        assert_eq!(e.scope_globs.as_deref(), Some(DENY_ALL));
        // The failure mode, made concrete: had this been None, the hook would allow this write.
        assert!(matches!(scope_verdict("src/anything.rs", e.scope_globs.as_deref().unwrap(), ""), Scope::Deny(_)));
    }

    /// `code: none` does NOT imply the sentinel — a carve-out role is `code: none` WITH globs.
    #[test]
    fn a_carve_out_role_keeps_its_scoped_write_despite_code_none() {
        let e = write_scope_env(&cap("designer", Tier::None, &["scratch/**"]));
        assert_eq!(e.scope_globs.as_deref(), Some("scratch/**"));
        assert!(matches!(scope_verdict("scratch/a.tsx", "scratch/**", ""), Scope::Allow));
    }

    /// Handing globs to a `code: none` role WITHOUT a carve-out must not widen it. Supplying a scope is
    /// for narrowing; if it could widen, the scope field would be a privilege-escalation vector.
    #[test]
    fn globs_given_to_a_non_carve_out_restricted_role_grant_nothing() {
        let e = write_scope_env(&cap("triage", Tier::None, &["src/**"]));
        assert!(scope_write_globs(&cap("triage", Tier::None, &["src/**"])).is_empty());
        assert_eq!(e.scope_globs.as_deref(), Some(DENY_ALL), "the globs must be refused, not honoured");
    }

    /// A `code: write` role with no globs is UNSET, not denied — an unscoped worker is allow-all, and
    /// turning that into a deny would break every ordinary session.
    #[test]
    fn a_write_role_without_globs_is_unset_not_denied() {
        assert_eq!(write_scope_env(&cap("worker", Tier::Write, &[])).scope_globs, None);
        assert_eq!(
            write_scope_env(&cap("worker", Tier::Write, &["src/**", "docs/**"])).scope_globs.as_deref(),
            Some("src/** docs/**"),
            "space-joined, matching $BSC_SCOPE_GLOBS' own shape"
        );
    }

    /// THE ASSUMPTION THE `else` ARM RESTS ON, guarded rather than assumed.
    ///
    /// `code` takes only `none` or `write` across every packaged role — verified here against the
    /// generated fixture rather than believed. That is why `cap.code == Tier::None` and
    /// `cap.code != Tier::Write` are indistinguishable today: a bite experiment swapping them does NOT
    /// turn this suite red, and the honest reason is that the input separating them cannot occur.
    ///
    /// It is worth a guard because the two are NOT equivalent in general. A `code: read` role added
    /// later would fall to the `else` arm and be left UNSET — allow-all — when a read tier plainly
    /// means "writes nothing". This test goes red the moment such a role appears, which forces the
    /// decision to be made deliberately instead of inherited from whichever comparison was written.
    #[test]
    fn code_is_only_ever_none_or_write() {
        let doc = fixture();
        let mut seen = std::collections::BTreeSet::new();
        for case in doc["cases"].as_array().unwrap() {
            if let Some(code) = case["capability"].get("code").and_then(|v| v.as_str()) {
                seen.insert(code.to_string());
            }
        }
        assert_eq!(
            seen.into_iter().collect::<Vec<_>>(),
            vec!["none".to_string(), "write".to_string()],
            "a new `code` tier appeared — decide what $BSC_SCOPE_GLOBS should be for it before shipping \
             it, because the current `else` arm leaves anything that is not `none` UNSET (allow-all)"
        );
    }

    /// The store tiers ride along as JSON, and all three values must survive.
    #[test]
    fn the_store_scopes_carry_every_tier() {
        for (tier, want) in [("none", "none"), ("read", "read"), ("write", "write")] {
            let c: RoleCapability = serde_json::from_value(serde_json::json!({
                "role": "designer", "git": "none", "github": "none", "net": "none", "code": "none",
                "writeGlobs": ["scratch/**"], "ui": tier
            }))
            .unwrap();
            assert_eq!(write_scope_env(&c).scopes, format!("{{\"ui\":\"{want}\"}}"));
        }
    }
}
