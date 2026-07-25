//! The normalized vulnerability model (#3797) — pure data + serde, mapped FROM OSV.dev's response
//! schema into a small clean shape the CLI prints, the cache stores, and the MCP server returns.
//!
//! OSV's vuln JSON is rich + irregular (a `severity` array of CVSS vectors, a `database_specific`
//! severity string, ecosystem-specific `affected` ranges). Rather than fight serde against all of it,
//! [`Advisory::from_osv`] walks a `serde_json::Value` and extracts exactly the fields we surface, so
//! the mapping (especially [`Severity`]) is one pure, fixture-tested function.

use serde::{Deserialize, Serialize};

/// A package ecosystem — the ones the fleet installs, mapped 1:1 to OSV's ecosystem strings.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Ecosystem {
    Npm,
    Cargo,
    Pypi,
    Go,
    Maven,
    Nuget,
    RubyGems,
}

impl Ecosystem {
    /// OSV's exact ecosystem token (the `package.ecosystem` field). Note the casing/naming is OSV's,
    /// not ours — `crates.io`, `PyPI`, `RubyGems`.
    pub fn osv(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm",
            Ecosystem::Cargo => "crates.io",
            Ecosystem::Pypi => "PyPI",
            Ecosystem::Go => "Go",
            Ecosystem::Maven => "Maven",
            Ecosystem::Nuget => "NuGet",
            Ecosystem::RubyGems => "RubyGems",
        }
    }

    /// The short CLI/lockfile token a user types (`npm`, `cargo`, `pypi`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            Ecosystem::Npm => "npm",
            Ecosystem::Cargo => "cargo",
            Ecosystem::Pypi => "pypi",
            Ecosystem::Go => "go",
            Ecosystem::Maven => "maven",
            Ecosystem::Nuget => "nuget",
            Ecosystem::RubyGems => "rubygems",
        }
    }

    /// Parse a user/lockfile token (lenient: accepts our short form + OSV's own spelling + aliases).
    pub fn parse(s: &str) -> Option<Ecosystem> {
        match s.trim().to_ascii_lowercase().as_str() {
            "npm" | "node" => Some(Ecosystem::Npm),
            "cargo" | "crates" | "crates.io" | "rust" => Some(Ecosystem::Cargo),
            "pypi" | "pip" | "python" => Some(Ecosystem::Pypi),
            "go" | "golang" => Some(Ecosystem::Go),
            "maven" | "java" => Some(Ecosystem::Maven),
            "nuget" | "dotnet" => Some(Ecosystem::Nuget),
            "rubygems" | "gem" | "ruby" => Some(Ecosystem::RubyGems),
            _ => None,
        }
    }
}

/// One package to check — ecosystem + name + an optional exact version (OSV needs the version to
/// resolve which advisories actually AFFECT this install; a name-only query returns every advisory
/// ever filed against the package).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Package {
    pub ecosystem: Ecosystem,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

impl Package {
    pub fn new(ecosystem: Ecosystem, name: impl Into<String>, version: Option<String>) -> Package {
        Package { ecosystem, name: name.into(), version }
    }

    /// The cache key: `ecosystem:name@version` (or `ecosystem:name` when versionless). Stable +
    /// collision-free since none of ecosystem/name/version contains a bare `:` or `@` boundary clash.
    pub fn cache_key(&self) -> String {
        match &self.version {
            Some(v) => format!("{}:{}@{}", self.ecosystem.osv(), self.name, v),
            None => format!("{}:{}", self.ecosystem.osv(), self.name),
        }
    }
}

/// A normalized severity, ORDERED so `--min-severity` gating is a simple comparison. `Unknown` sits
/// at the bottom (an advisory with no machine-readable severity never trips a threshold above `unknown`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Unknown,
    Low,
    Medium,
    High,
    Critical,
}

impl Severity {
    pub fn as_str(self) -> &'static str {
        match self {
            Severity::Unknown => "unknown",
            Severity::Low => "low",
            Severity::Medium => "medium",
            Severity::High => "high",
            Severity::Critical => "critical",
        }
    }

    /// Parse a `--min-severity` token (case-insensitive; `moderate` is GHSA's word for `medium`).
    pub fn parse(s: &str) -> Option<Severity> {
        match s.trim().to_ascii_lowercase().as_str() {
            "unknown" | "none" => Some(Severity::Unknown),
            "low" => Some(Severity::Low),
            "medium" | "moderate" => Some(Severity::Medium),
            "high" => Some(Severity::High),
            "critical" => Some(Severity::Critical),
            _ => None,
        }
    }

    /// Map a CVSS base score (0.0–10.0) onto the qualitative band (CVSS v3.1 §5).
    pub fn from_cvss_score(score: f64) -> Severity {
        if score >= 9.0 {
            Severity::Critical
        } else if score >= 7.0 {
            Severity::High
        } else if score >= 4.0 {
            Severity::Medium
        } else if score > 0.0 {
            Severity::Low
        } else {
            Severity::Unknown
        }
    }

    /// Map a qualitative label (GHSA's `LOW`/`MODERATE`/`HIGH`/`CRITICAL`) onto our scale.
    pub fn from_label(s: &str) -> Severity {
        Severity::parse(s).unwrap_or(Severity::Unknown)
    }
}

/// One advisory affecting a package — our clean, printable/cacheable shape.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Advisory {
    /// The OSV id (usually a `GHSA-…` or `CVE-…`).
    pub id: String,
    /// A one-line summary (OSV `summary`, else the first line of `details`).
    pub summary: String,
    pub severity: Severity,
    /// Cross-ids (CVE ↔ GHSA), OSV `aliases`.
    #[serde(default)]
    pub aliases: Vec<String>,
    /// Reference URLs (advisory pages, fixes).
    #[serde(default)]
    pub references: Vec<String>,
}

impl Advisory {
    /// Extract our [`Advisory`] from one OSV vuln `Value`. Severity precedence: the highest CVSS score
    /// in the `severity` array (parsed from the vector string's `.../S:.../ ...` — we read the trailing
    /// `score`), else `database_specific.severity` label, else `Unknown`.
    pub fn from_osv(v: &serde_json::Value) -> Advisory {
        let id = v.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string();
        let summary = v
            .get("summary")
            .and_then(|x| x.as_str())
            .map(str::to_string)
            .or_else(|| {
                v.get("details")
                    .and_then(|x| x.as_str())
                    .map(|d| d.lines().next().unwrap_or("").trim().to_string())
            })
            .unwrap_or_default();
        let aliases = v
            .get("aliases")
            .and_then(|a| a.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let references = v
            .get("references")
            .and_then(|a| a.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|r| r.get("url").and_then(|u| u.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        Advisory { id, summary, severity: severity_of(v), aliases, references }
    }
}

/// Pull the highest CVSS score out of an OSV `severity` array and band it; fall back to the
/// `database_specific.severity` label; else `Unknown`. Kept free-standing so it's directly fixture-tested.
pub fn severity_of(v: &serde_json::Value) -> Severity {
    let cvss = v
        .get("severity")
        .and_then(|s| s.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|e| e.get("score").and_then(|x| x.as_str()))
                .filter_map(cvss_base_score)
                .fold(0.0_f64, f64::max)
        })
        .unwrap_or(0.0);
    if cvss > 0.0 {
        return Severity::from_cvss_score(cvss);
    }
    v.get("database_specific")
        .and_then(|d| d.get("severity"))
        .and_then(|x| x.as_str())
        .map(Severity::from_label)
        .unwrap_or(Severity::Unknown)
}

/// Best-effort CVSS base score from a vector string. OSV stores the full vector (`CVSS:3.1/AV:N/...`),
/// which does NOT carry the score, so we can't read a score field — instead we recompute nothing and
/// return `None` for a bare vector. But OSV's GHSA-sourced entries frequently store a plain numeric
/// string (`"9.8"`) as the score, which we DO parse; anything else yields `None` and severity falls
/// back to the qualitative label.
fn cvss_base_score(score: &str) -> Option<f64> {
    let s = score.trim();
    // A bare numeric score ("9.8") — the common GHSA-in-OSV shape.
    if let Ok(n) = s.parse::<f64>() {
        if (0.0..=10.0).contains(&n) {
            return Some(n);
        }
    }
    None
}

/// One package's result in a scan/check — the package plus every advisory affecting it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PackageReport {
    pub package: Package,
    pub advisories: Vec<Advisory>,
}

impl PackageReport {
    /// The worst severity among this package's advisories (`Unknown` if none).
    pub fn max_severity(&self) -> Severity {
        self.advisories.iter().map(|a| a.severity).max().unwrap_or(Severity::Unknown)
    }
}

/// A whole-lockfile scan result — every package with ≥1 advisory, plus the roll-up counts the CLI
/// gates on. Clean packages are omitted from `packages` (the report is the FINDINGS, not the inventory).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    /// Packages that have at least one advisory (the findings).
    pub packages: Vec<PackageReport>,
    /// Total packages scanned.
    pub scanned: usize,
    /// How many of them are vulnerable (== `packages.len()`).
    pub vulnerable: usize,
    /// The worst severity seen across every finding.
    pub max_severity: Severity,
}

impl ScanReport {
    /// Build the roll-up from the per-package findings (only vulnerable packages passed in) + the
    /// total scanned count.
    pub fn new(findings: Vec<PackageReport>, scanned: usize) -> ScanReport {
        let max_severity = findings.iter().map(|p| p.max_severity()).max().unwrap_or(Severity::Unknown);
        ScanReport { vulnerable: findings.len(), packages: findings, scanned, max_severity }
    }

    /// Does this scan breach `min` — i.e. is there a finding at or above the gate? The exit-code
    /// decision, kept pure so the CLI's `process::exit` is a one-liner over a tested predicate.
    pub fn breaches(&self, min: Severity) -> bool {
        self.max_severity >= min && self.vulnerable > 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ecosystem_maps_to_osv_and_back() {
        assert_eq!(Ecosystem::Cargo.osv(), "crates.io");
        assert_eq!(Ecosystem::Pypi.osv(), "PyPI");
        assert_eq!(Ecosystem::parse("crates.io"), Some(Ecosystem::Cargo));
        assert_eq!(Ecosystem::parse("PIP"), Some(Ecosystem::Pypi));
        assert_eq!(Ecosystem::parse("nonsense"), None);
    }

    #[test]
    fn cache_key_is_stable_and_version_aware() {
        let p = Package::new(Ecosystem::Npm, "lodash", Some("4.17.0".into()));
        assert_eq!(p.cache_key(), "npm:lodash@4.17.0");
        let q = Package::new(Ecosystem::Cargo, "time", None);
        assert_eq!(q.cache_key(), "crates.io:time");
    }

    #[test]
    fn severity_orders_and_gates() {
        assert!(Severity::Critical > Severity::High);
        assert!(Severity::High > Severity::Medium);
        assert!(Severity::Low > Severity::Unknown);
        assert_eq!(Severity::parse("moderate"), Some(Severity::Medium));
        assert_eq!(Severity::from_cvss_score(9.8), Severity::Critical);
        assert_eq!(Severity::from_cvss_score(7.5), Severity::High);
        assert_eq!(Severity::from_cvss_score(5.0), Severity::Medium);
        assert_eq!(Severity::from_cvss_score(2.0), Severity::Low);
        assert_eq!(Severity::from_cvss_score(0.0), Severity::Unknown);
    }

    #[test]
    fn severity_of_prefers_numeric_cvss_then_falls_back_to_label() {
        // Numeric CVSS score wins.
        let v = json!({ "severity": [{ "type": "CVSS_V3", "score": "9.8" }], "database_specific": { "severity": "LOW" } });
        assert_eq!(severity_of(&v), Severity::Critical);
        // A bare CVSS vector string carries no score → fall back to the label.
        let v = json!({ "severity": [{ "type": "CVSS_V3", "score": "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }], "database_specific": { "severity": "HIGH" } });
        assert_eq!(severity_of(&v), Severity::High);
        // Nothing machine-readable → Unknown.
        assert_eq!(severity_of(&json!({})), Severity::Unknown);
    }

    #[test]
    fn from_osv_extracts_the_surfaced_fields() {
        let v = json!({
            "id": "GHSA-xxxx",
            "summary": "Prototype pollution in lodash",
            "aliases": ["CVE-2020-8203"],
            "severity": [{ "type": "CVSS_V3", "score": "7.4" }],
            "references": [{ "type": "WEB", "url": "https://example.test/a" }, { "type": "FIX", "url": "https://example.test/b" }]
        });
        let a = Advisory::from_osv(&v);
        assert_eq!(a.id, "GHSA-xxxx");
        assert_eq!(a.summary, "Prototype pollution in lodash");
        assert_eq!(a.severity, Severity::High);
        assert_eq!(a.aliases, vec!["CVE-2020-8203".to_string()]);
        assert_eq!(a.references, vec!["https://example.test/a".to_string(), "https://example.test/b".to_string()]);
    }

    #[test]
    fn from_osv_falls_back_to_first_details_line_for_summary() {
        let v = json!({ "id": "GHSA-y", "details": "First line.\nSecond line." });
        assert_eq!(Advisory::from_osv(&v).summary, "First line.");
    }

    #[test]
    fn scan_report_rolls_up_and_gates() {
        let hi = Advisory { id: "a".into(), summary: "".into(), severity: Severity::High, aliases: vec![], references: vec![] };
        let lo = Advisory { id: "b".into(), summary: "".into(), severity: Severity::Low, aliases: vec![], references: vec![] };
        let findings = vec![
            PackageReport { package: Package::new(Ecosystem::Npm, "x", Some("1".into())), advisories: vec![lo] },
            PackageReport { package: Package::new(Ecosystem::Npm, "y", Some("2".into())), advisories: vec![hi] },
        ];
        let r = ScanReport::new(findings, 50);
        assert_eq!(r.scanned, 50);
        assert_eq!(r.vulnerable, 2);
        assert_eq!(r.max_severity, Severity::High);
        assert!(r.breaches(Severity::High));
        assert!(r.breaches(Severity::Medium));
        assert!(!r.breaches(Severity::Critical));
        // An empty scan never breaches.
        assert!(!ScanReport::new(vec![], 10).breaches(Severity::Unknown));
    }
}
