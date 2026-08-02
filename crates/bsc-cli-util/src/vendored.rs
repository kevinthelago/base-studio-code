//! The vendored-file provenance contract (#4192) — shared by every `emit` surface.
//!
//! A store that emits source into a repo has to answer one question later: *did anyone hand-edit this?*
//! The answer is a stamp on line 1 carrying the store ref plus a `sha256` of the BODY (everything after
//! the stamp). Re-hash the body and compare: equal ⇒ MANAGED, so a re-emit may overwrite it; different
//! ⇒ DIVERGED, so it must be skipped and reported rather than clobbered.
//!
//! This lives here — the scaffold every `bsc` state CLI already depends on — rather than in one store's
//! crate, because there are now two emitters (`bsc ui emit` for components, `bsc graph emit` for
//! algorithms) and a copied stamp format would be two drift detectors free to drift apart. The stamp is
//! a `//` line comment, which both surfaces' languages (TS/TSX and Rust) accept.
//!
//! The `sync` COMMAND is a parameter, not a constant, so each surface names its own in the prose a
//! human reads on line 1 — while the machine-read half (the ref and the hash) stays one format.

use sha2::{Digest, Sha256};

/// Lowercase hex sha256 of `bytes` — the one content-hash form for every stamped artifact.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

/// The provenance stamp line: the store ref, the body's hash, and how to refresh it.
///
/// `sync_cmd` is the surface's own re-emit command (`bsc ui emit sync` / `bsc graph emit sync`), so the
/// instruction a reader sees names a command that actually exists on that store.
pub fn stamp_line(id: &str, version: &str, body_sha256: &str, sync_cmd: &str) -> String {
    format!("// vendored from {id}@{version} (sha256:{body_sha256}) — `{sync_cmd}` to update, do not hand-edit")
}

/// The store ref + stamped body-hash parsed from a vendored file's first line.
#[derive(Debug, PartialEq, Eq)]
pub struct Stamp {
    /// `<id>@<version>` — which store, and which revision of it, emitted this.
    pub kit_ref: String,
    pub body_sha256: String,
}

/// Parse the provenance stamp from a vendored file's first line. `None` when line 1 is not a stamp —
/// an un-vendored file, which every `sync` leaves strictly alone.
pub fn parse_stamp(content: &str) -> Option<Stamp> {
    let first = content.lines().next()?;
    let rest = first.strip_prefix("// vendored from ")?;
    let (kit_ref, after) = rest.split_once(" (sha256:")?;
    let hash = after.split_once(')').map(|(h, _)| h)?;
    Some(Stamp { kit_ref: kit_ref.to_string(), body_sha256: hash.to_string() })
}

/// The body of a vendored file — everything after the first (stamp) line, which is what the stamp's
/// `sha256` covers. An unstamped or single-line file has no body.
pub fn body_of(content: &str) -> &str {
    content.find('\n').map(|i| &content[i + 1..]).unwrap_or("")
}

/// Has this vendored file been hand-edited since it was emitted?
///
/// `false` for a file with no stamp: the caller decides what an un-vendored file means (every `sync`
/// treats it as none of its business), and calling that "diverged" would conflate the two.
pub fn is_diverged(content: &str) -> bool {
    parse_stamp(content).is_some_and(|s| sha256_hex(body_of(content).as_bytes()) != s.body_sha256)
}

/// The verdict for one file under a `sync` pass — the pure classification a CLI acts on.
#[derive(Debug, PartialEq, Eq)]
pub enum SyncVerdict {
    /// Managed and identical to a fresh render — nothing to do.
    UpToDate,
    /// Managed, but the store moved — the fresh content to overwrite it with (an atomic upgrade).
    Rewrite(String),
    /// Hand-edited since emit — skipped, never clobbered. Falling loudly is the point.
    Diverged,
    /// Stamped, but the store no longer carries its path (a removed/renamed record).
    Unknown,
    /// No provenance stamp — not a vendored file, left untouched.
    NotVendored,
}

/// Classify one on-disk vendored file against a fresh render of the CURRENT store.
///
/// `fresh` is `None` when the store no longer carries this path. Shared so both emitters apply the same
/// precedence: not-vendored → diverged → unknown → up-to-date/rewrite. Divergence is checked BEFORE the
/// store lookup, so a hand-edited file whose record was also deleted still reports as hand-edited rather
/// than as an unknown path — the reading that keeps the user's edit visible.
pub fn classify(content: &str, fresh: Option<String>) -> SyncVerdict {
    if parse_stamp(content).is_none() {
        return SyncVerdict::NotVendored;
    }
    if is_diverged(content) {
        return SyncVerdict::Diverged;
    }
    match fresh {
        None => SyncVerdict::Unknown,
        Some(f) if f == content => SyncVerdict::UpToDate,
        Some(f) => SyncVerdict::Rewrite(f),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamped(body: &str, sync: &str) -> String {
        format!("{}\n{body}", stamp_line("bsc/algorithms", "1.0.0", &sha256_hex(body.as_bytes()), sync))
    }

    #[test]
    fn a_stamp_round_trips_and_names_its_own_sync_command() {
        let f = stamped("fn merge() {}\n", "bsc graph emit sync");
        let s = parse_stamp(&f).expect("a stamp");
        assert_eq!(s.kit_ref, "bsc/algorithms@1.0.0");
        assert_eq!(s.body_sha256, sha256_hex(body_of(&f).as_bytes()));
        // The human half names the command for THIS store, not the other one's.
        assert!(f.contains("`bsc graph emit sync` to update"), "{f}");
        assert!(!f.contains("bsc ui emit"), "{f}");
    }

    #[test]
    fn a_hand_edit_is_diverged_and_an_unstamped_file_is_not() {
        let f = stamped("fn merge() {}\n", "bsc graph emit sync");
        assert!(!is_diverged(&f));
        // Same stamp, changed body — the case the whole mechanism exists to catch.
        let edited = f.replace("fn merge() {}", "fn merge() { /* hand-edited */ }");
        assert!(is_diverged(&edited));
        // An unstamped file is NOT "diverged" — it is simply not ours, which is a different verdict.
        assert!(!is_diverged("fn merge() {}\n"));
    }

    #[test]
    fn classify_orders_its_verdicts_so_a_hand_edit_always_wins() {
        let f = stamped("a\n", "bsc graph emit sync");
        assert_eq!(classify(&f, Some(f.clone())), SyncVerdict::UpToDate);
        let moved = stamped("b\n", "bsc graph emit sync");
        assert_eq!(classify(&f, Some(moved.clone())), SyncVerdict::Rewrite(moved));
        assert_eq!(classify(&f, None), SyncVerdict::Unknown);
        assert_eq!(classify("plain source\n", Some(f.clone())), SyncVerdict::NotVendored);

        // A hand-edited file whose record ALSO disappeared reports as hand-edited, not unknown —
        // otherwise the user's edit is described as a stale path and quietly loses its warning.
        let edited = f.replace("a\n", "a-edited\n");
        assert_eq!(classify(&edited, None), SyncVerdict::Diverged);
    }
}
