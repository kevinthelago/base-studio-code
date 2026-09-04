//! The normalized finding — **the reason this crate is `bsc-security` and not `cve`**.
//!
//! Widening a vulnerability scanner into a security surface is not a rename. If a secrets detector,
//! an SBOM reader and a KEV join each invent their own report type, the result is several tools
//! sharing a noun: `bsc security scan` becomes three concatenated answers rather than one, and
//! nothing can rank across them. One shape every detector emits is what makes the surface a surface.
//!
//! Two properties here are correctness rather than presentation, and both are enforced by the type
//! rather than left to a renderer:
//!
//! 1. **A secret is never stored raw.** [`Finding`] has no field that can hold one — the constructor
//!    [`Finding::redacted`] takes the sensitive text, keeps a masked display form and a hash for
//!    dedupe, and drops the original. Findings flow into terminals, logs, plan notes and change
//!    records, and in this repo notes are APPEND-ONLY: a secret written into one cannot be removed.
//!    So the redaction has to happen before the value reaches a struct, not on the way out of it.
//!
//! 2. **The fingerprint is stable across runs and independent of position.** It keys dedupe and
//!    suppression, so it must not change when a line is inserted above the finding.

use crate::types::Severity;
use serde::{Deserialize, Serialize};
use std::fmt::Write as _;

/// What KIND of thing was found. Detectors are open-ended, but the kind set is closed so a reader
/// can exhaustively handle them and a new detector cannot silently render as something else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    /// A dependency with a known advisory.
    VulnerableDependency,
    /// A credential committed to the repository.
    LeakedSecret,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::VulnerableDependency => "vulnerable-dependency",
            Kind::LeakedSecret => "leaked-secret",
        }
    }
}

/// WHERE a finding is. The variants are deliberately different shapes rather than a lowest common
/// denominator: a dependency finding has no line number and a secret has no version, and flattening
/// both into `{file, line}` would make one of them lie.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "at", rename_all = "kebab-case")]
pub enum Locator {
    /// A package at a version, from a manifest or lockfile.
    Package {
        ecosystem: String,
        name: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        version: Option<String>,
        /// The manifest the package was read from.
        #[serde(skip_serializing_if = "Option::is_none")]
        manifest: Option<String>,
    },
    /// A span in a file in the working tree.
    File { path: String, line: usize },
    /// A span in a blob reachable from history but not necessarily from HEAD.
    ///
    /// Separate from [`Locator::File`] on purpose: "this secret is in your working tree" and "this
    /// secret is only in a commit from March" are different problems with different remediations,
    /// and collapsing them would let a rotated-but-still-committed credential read as fixed.
    GitObject {
        /// The blob's object id.
        object: String,
        /// The commit it was reached through.
        commit: String,
        path: String,
        line: usize,
    },
}

impl Locator {
    /// A short human label — what the renderer prints in the location column.
    pub fn label(&self) -> String {
        match self {
            Locator::Package { ecosystem, name, version, .. } => match version {
                Some(v) => format!("{ecosystem}:{name}@{v}"),
                None => format!("{ecosystem}:{name}"),
            },
            Locator::File { path, line } => format!("{path}:{line}"),
            Locator::GitObject { commit, path, line, .. } => {
                format!("{}:{path}:{line}", &commit[..commit.len().min(8)])
            }
        }
    }

    /// The part of the location that is STABLE across edits, for fingerprinting. Line numbers are
    /// excluded: inserting a line above a finding must not mint a new one, or every suppression
    /// breaks on the next commit.
    fn stable(&self) -> String {
        match self {
            Locator::Package { ecosystem, name, .. } => format!("pkg:{ecosystem}/{name}"),
            Locator::File { path, .. } => format!("file:{path}"),
            // A blob id already identifies exact content, so the path is enough context.
            Locator::GitObject { object, path, .. } => format!("git:{object}:{path}"),
        }
    }
}

/// One normalized finding. Every detector emits this and nothing else.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub kind: Kind,
    pub severity: Severity,
    /// Stable id for dedupe and suppression — see [`Finding::fingerprint`].
    pub fingerprint: String,
    /// A short title, safe to print.
    pub title: String,
    pub locator: Locator,
    /// A SAFE excerpt. For a secret this is already masked; there is no unmasked field.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evidence: Option<String>,
    /// Advisory ids, rule ids — whatever a reader would look up.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub refs: Vec<String>,
}

/// Mask a sensitive value for display: keep a short head and tail so a human can recognise WHICH
/// credential it is, and replace the middle. Short values are masked entirely — for a 12-character
/// secret, "first four and last four" would disclose most of it.
pub fn redact(secret: &str) -> String {
    let n = secret.chars().count();
    if n <= 12 {
        return "*".repeat(n.max(1));
    }
    let head: String = secret.chars().take(4).collect();
    let tail: String = secret.chars().skip(n - 4).collect();
    format!("{head}{}{tail}", "*".repeat(n - 8))
}

/// A short, stable hash. FNV-1a rather than a crypto hash: this identifies a finding, it does not
/// protect one, and a dependency-free 64-bit digest keeps the crate lean.
fn digest(parts: &[&str]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for p in parts {
        for b in p.as_bytes() {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100_0000_01b3);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x100_0000_01b3);
    }
    let mut s = String::with_capacity(16);
    let _ = write!(s, "{h:016x}");
    s
}

impl Finding {
    /// A finding whose evidence is safe to keep verbatim.
    pub fn new(kind: Kind, severity: Severity, title: impl Into<String>, locator: Locator) -> Finding {
        let title = title.into();
        Finding {
            fingerprint: Finding::fingerprint(kind, &locator, &title),
            kind,
            severity,
            title,
            locator,
            evidence: None,
            refs: Vec::new(),
        }
    }

    /// A finding over SENSITIVE text. The secret is consumed here and never reaches a field: the
    /// evidence is masked and the fingerprint uses a hash of the value rather than the value.
    ///
    /// This is the only constructor a secret may pass through, which is what makes "the store never
    /// holds a raw credential" a property of the type instead of a rule someone has to remember.
    pub fn redacted(
        kind: Kind,
        severity: Severity,
        title: impl Into<String>,
        locator: Locator,
        secret: &str,
    ) -> Finding {
        let title = title.into();
        // Fingerprint on the SECRET's hash, not its text, so the same credential in two places
        // dedupes while the value itself never enters the id.
        let fingerprint = digest(&[kind.as_str(), &locator.stable(), &digest(&[secret])]);
        Finding {
            kind,
            severity,
            fingerprint,
            title,
            locator,
            evidence: Some(redact(secret)),
            refs: Vec::new(),
        }
    }

    /// Attach reference ids (advisory ids, rule ids).
    pub fn with_refs(mut self, refs: Vec<String>) -> Finding {
        self.refs = refs;
        self
    }

    /// Attach a non-sensitive evidence excerpt.
    pub fn with_evidence(mut self, evidence: impl Into<String>) -> Finding {
        self.evidence = Some(evidence.into());
        self
    }

    /// The stable id for a non-secret finding.
    fn fingerprint(kind: Kind, locator: &Locator, title: &str) -> String {
        digest(&[kind.as_str(), &locator.stable(), title])
    }
}

/// Rank findings worst-first, then by kind and fingerprint so the order is total and reproducible —
/// a report that reorders between runs cannot be diffed against itself.
pub fn rank(mut findings: Vec<Finding>) -> Vec<Finding> {
    findings.sort_by(|a, b| {
        b.severity
            .cmp(&a.severity)
            .then_with(|| a.kind.cmp(&b.kind))
            .then_with(|| a.fingerprint.cmp(&b.fingerprint))
    });
    findings.dedup_by(|a, b| a.fingerprint == b.fingerprint);
    findings
}

#[cfg(test)]
mod tests {
    use super::*;

    const AWS: &str = "AKIAIOSFODNN7EXAMPLE";

    fn file_at(path: &str, line: usize) -> Locator {
        Locator::File { path: path.into(), line }
    }

    #[test]
    fn a_secret_never_reaches_any_field_of_the_finding() {
        // The acceptance criterion, as a test: serialize the WHOLE finding and assert the raw value
        // is absent. A field added later that carried it would fail here rather than in production.
        let f = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "AWS access key id", file_at("a.rs", 3), AWS);
        let json = serde_json::to_string(&f).unwrap();
        assert!(!json.contains(AWS), "the raw secret must not appear anywhere in the finding: {json}");
        assert!(!f.fingerprint.contains(AWS));
        assert_eq!(f.evidence.as_deref(), Some("AKIA************MPLE"));
    }

    #[test]
    fn redaction_keeps_enough_to_recognise_which_credential_it_is() {
        assert_eq!(redact("AKIAIOSFODNN7EXAMPLE"), "AKIA************MPLE");
        assert_eq!(redact("ghp_abcdefghijklmnop"), "ghp_************mnop");
    }

    #[test]
    fn a_short_secret_is_masked_entirely() {
        // Head-and-tail on a 12-char value would disclose two thirds of it.
        assert_eq!(redact("abcdefghijkl"), "************");
        assert_eq!(redact("short"), "*****");
        assert_eq!(redact(""), "*", "an empty value still renders as masked, never as nothing");
    }

    #[test]
    fn the_same_secret_in_the_same_place_dedupes() {
        let a = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 3), AWS);
        let b = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 3), AWS);
        assert_eq!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn a_line_insert_above_a_finding_does_not_mint_a_new_one() {
        // Fingerprints key suppression. If a line number entered the id, every suppression would
        // break on the next commit that touched the file above it.
        let a = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 3), AWS);
        let b = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 41), AWS);
        assert_eq!(a.fingerprint, b.fingerprint, "position must not be part of the identity");
    }

    #[test]
    fn a_different_secret_in_the_same_place_is_a_different_finding() {
        let a = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 3), AWS);
        let b = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 3), "ghp_something_else_x");
        assert_ne!(a.fingerprint, b.fingerprint);
    }

    #[test]
    fn a_working_tree_secret_and_a_history_secret_are_distinct_findings() {
        // Different problems, different remediations: one is `edit the file`, the other is `rotate
        // the credential, because it is in the pack forever`. Collapsing them would let a rotated
        // but still-committed key read as fixed.
        let tree = Finding::redacted(Kind::LeakedSecret, Severity::Critical, "t", file_at("a.rs", 3), AWS);
        let hist = Finding::redacted(
            Kind::LeakedSecret,
            Severity::Critical,
            "t",
            Locator::GitObject { object: "abc123".into(), commit: "deadbeefcafe".into(), path: "a.rs".into(), line: 3 },
            AWS,
        );
        assert_ne!(tree.fingerprint, hist.fingerprint);
    }

    #[test]
    fn locator_labels_read_correctly_for_each_shape() {
        let pkg = Locator::Package {
            ecosystem: "npm".into(),
            name: "lodash".into(),
            version: Some("4.17.20".into()),
            manifest: Some("package-lock.json".into()),
        };
        assert_eq!(pkg.label(), "npm:lodash@4.17.20");
        assert_eq!(file_at("src/a.rs", 12).label(), "src/a.rs:12");
        let g = Locator::GitObject {
            object: "o".into(),
            commit: "deadbeefcafebabe".into(),
            path: "a.rs".into(),
            line: 7,
        };
        assert_eq!(g.label(), "deadbeef:a.rs:7");
    }

    #[test]
    fn rank_puts_the_worst_first_and_is_total() {
        let lo = Finding::new(Kind::LeakedSecret, Severity::Low, "lo", file_at("a", 1));
        let hi = Finding::new(Kind::VulnerableDependency, Severity::Critical, "hi", file_at("b", 1));
        let one = rank(vec![lo.clone(), hi.clone()]);
        let two = rank(vec![hi, lo]);
        assert_eq!(one[0].severity, Severity::Critical);
        assert_eq!(one, two, "a report that reorders between runs cannot be diffed against itself");
    }

    #[test]
    fn rank_dedupes_identical_fingerprints() {
        let f = Finding::redacted(Kind::LeakedSecret, Severity::High, "t", file_at("a.rs", 3), AWS);
        assert_eq!(rank(vec![f.clone(), f]).len(), 1);
    }
}
