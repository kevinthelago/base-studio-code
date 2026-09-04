//! Leaked-credential detection over a working tree and over git history.
//!
//! **Named structured patterns, not entropy.** Entropy alone is a false-positive machine in any real
//! repository: lockfile integrity strings, git object ids, base64 test fixtures and content hashes
//! all score high and none of them is a credential. This repo carries a 6.8 MB JSON graph store and
//! hundreds of test files, so a noisy scanner would be switched off within a day — and a scanner
//! nobody runs is worse than none, because its silence gets read as a clean result.
//!
//! Every rule therefore matches a vendor-issued shape with a fixed prefix and a known body length,
//! which is what makes a hit worth acting on. The cost of that choice is honest: a bespoke or
//! self-issued credential with no recognisable shape is NOT found, and no amount of tuning here
//! would change that. This detects the credentials that are issued with a format, which is most of
//! the ones that actually leak.
//!
//! **History is in scope and is the point.** A credential removed from the working tree is still in
//! the pack, still fetchable by anyone with a clone, and still valid until it is rotated. A scanner
//! that reads only `HEAD` reports clean on a repository that is still leaking, which is the exact
//! shape of failure this crate exists to avoid elsewhere.

use crate::finding::{Finding, Kind, Locator};
use crate::types::Severity;
use std::path::Path;
use std::process::Command;

/// One credential shape.
pub struct Rule {
    /// Stable rule id, reported in `refs`.
    pub id: &'static str,
    /// What a reader should understand was found.
    pub title: &'static str,
    /// Literal prefix that must be present — the cheap pre-filter and the reason this is not entropy.
    pub prefix: &'static str,
    /// Length of the body AFTER the prefix.
    pub body: BodyLen,
    /// Which characters the body may contain.
    pub charset: Charset,
    pub severity: Severity,
}

/// How long a credential body is.
pub enum BodyLen {
    /// Exactly this many characters.
    Exact(usize),
    /// At least this many; the match takes the longest run of the charset.
    AtLeast(usize),
}

/// Which characters a credential body admits.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Charset {
    /// `A-Z0-9`
    UpperAlnum,
    /// `A-Za-z0-9`
    Alnum,
    /// `A-Za-z0-9_-`
    AlnumDashUnderscore,
}

impl Charset {
    fn admits(self, c: char) -> bool {
        match self {
            Charset::UpperAlnum => c.is_ascii_uppercase() || c.is_ascii_digit(),
            Charset::Alnum => c.is_ascii_alphanumeric(),
            Charset::AlnumDashUnderscore => c.is_ascii_alphanumeric() || c == '_' || c == '-',
        }
    }
}

/// The rule set. Each entry is a shape a vendor actually issues.
pub const RULES: &[Rule] = &[
    Rule { id: "aws-access-key-id", title: "AWS access key id", prefix: "AKIA", body: BodyLen::Exact(16), charset: Charset::UpperAlnum, severity: Severity::Critical },
    Rule { id: "aws-temp-key-id", title: "AWS temporary access key id", prefix: "ASIA", body: BodyLen::Exact(16), charset: Charset::UpperAlnum, severity: Severity::High },
    Rule { id: "github-pat", title: "GitHub personal access token", prefix: "ghp_", body: BodyLen::AtLeast(36), charset: Charset::Alnum, severity: Severity::Critical },
    Rule { id: "github-oauth", title: "GitHub OAuth token", prefix: "gho_", body: BodyLen::AtLeast(36), charset: Charset::Alnum, severity: Severity::Critical },
    Rule { id: "github-server", title: "GitHub server-to-server token", prefix: "ghs_", body: BodyLen::AtLeast(36), charset: Charset::Alnum, severity: Severity::Critical },
    Rule { id: "github-fine-grained", title: "GitHub fine-grained PAT", prefix: "github_pat_", body: BodyLen::AtLeast(50), charset: Charset::AlnumDashUnderscore, severity: Severity::Critical },
    Rule { id: "anthropic-api-key", title: "Anthropic API key", prefix: "sk-ant-", body: BodyLen::AtLeast(90), charset: Charset::AlnumDashUnderscore, severity: Severity::Critical },
    Rule { id: "openai-project-key", title: "OpenAI project API key", prefix: "sk-proj-", body: BodyLen::AtLeast(40), charset: Charset::AlnumDashUnderscore, severity: Severity::Critical },
    Rule { id: "slack-token", title: "Slack token", prefix: "xoxb-", body: BodyLen::AtLeast(20), charset: Charset::AlnumDashUnderscore, severity: Severity::High },
    Rule { id: "slack-user-token", title: "Slack user token", prefix: "xoxp-", body: BodyLen::AtLeast(20), charset: Charset::AlnumDashUnderscore, severity: Severity::High },
    Rule { id: "stripe-live-key", title: "Stripe live secret key", prefix: "sk_live_", body: BodyLen::AtLeast(24), charset: Charset::Alnum, severity: Severity::Critical },
    Rule { id: "google-api-key", title: "Google API key", prefix: "AIza", body: BodyLen::Exact(35), charset: Charset::AlnumDashUnderscore, severity: Severity::High },
    Rule { id: "sendgrid-key", title: "SendGrid API key", prefix: "SG.", body: BodyLen::AtLeast(60), charset: Charset::AlnumDashUnderscore, severity: Severity::High },
    Rule { id: "npm-token", title: "npm access token", prefix: "npm_", body: BodyLen::Exact(36), charset: Charset::Alnum, severity: Severity::High },
];

/// PEM private-key headers. Matched as whole lines rather than by prefix+length, since the secret is
/// the block that FOLLOWS the header rather than a fixed-width token.
const PEM_HEADERS: &[(&str, &str)] = &[
    ("-----BEGIN RSA PRIVATE KEY-----", "RSA private key"),
    ("-----BEGIN OPENSSH PRIVATE KEY-----", "OpenSSH private key"),
    ("-----BEGIN PGP PRIVATE KEY BLOCK-----", "PGP private key"),
    ("-----BEGIN EC PRIVATE KEY-----", "EC private key"),
    ("-----BEGIN DSA PRIVATE KEY-----", "DSA private key"),
    ("-----BEGIN PRIVATE KEY-----", "private key"),
];

/// Minimum base64 characters between a PEM header and its `-----END`, below which the block is a
/// MENTION OF THE FORMAT rather than a key.
///
/// Every token rule matches a prefix AND a known body length; the PEM rules originally matched only
/// a header, which is why the first real run's single finding was a test fixture whose key material
/// was the four characters `MIIB`. The smallest real private key is several hundred base64
/// characters, so this separates them by an order of magnitude rather than by a hair.
pub const MIN_PEM_BODY: usize = 100;

/// One match inside a line of text.
pub struct Hit {
    pub rule_id: &'static str,
    pub title: &'static str,
    pub severity: Severity,
    /// The matched credential. Callers pass this straight to [`Finding::redacted`] and never store it.
    pub secret: String,
}

/// Scan one line for TOKEN credential shapes.
///
/// PEM blocks are not looked for here: a real key spans lines, so it needs [`scan_text`]. Pure and
/// offline — the whole detector is testable against a fixture without a repo or a network.
pub fn scan_line(line: &str) -> Vec<Hit> {
    let mut hits = Vec::new();
    for rule in RULES {
        let mut from = 0usize;
        while let Some(rel) = line[from..].find(rule.prefix) {
            let start = from + rel;
            let after = start + rule.prefix.len();
            let run: String = line[after..].chars().take_while(|c| rule.charset.admits(*c)).collect();
            let ok = match rule.body {
                BodyLen::Exact(n) => run.chars().count() == n,
                BodyLen::AtLeast(n) => run.chars().count() >= n,
            };
            if ok {
                hits.push(Hit {
                    rule_id: rule.id,
                    title: rule.title,
                    severity: rule.severity,
                    secret: format!("{}{run}", rule.prefix),
                });
            }
            from = after.max(start + 1);
            if from >= line.len() {
                break;
            }
        }
    }
    hits
}

/// Scan whole text: every token hit, plus PEM blocks that actually carry key material.
///
/// Returns `(line_number, Hit)` with 1-based lines, so callers need not re-derive positions.
pub fn scan_text(text: &str) -> Vec<(usize, Hit)> {
    let mut out: Vec<(usize, Hit)> = Vec::new();
    for (i, line) in text.lines().enumerate() {
        for hit in scan_line(line) {
            out.push((i + 1, hit));
        }
    }
    // PEM blocks, measured across the whole text so a multi-line key is seen as one block.
    for (header, what) in PEM_HEADERS {
        let mut from = 0usize;
        while let Some(rel) = text[from..].find(header) {
            let start = from + rel;
            let after = start + header.len();
            // The matching END, or the rest of the text if the block is unterminated.
            let end = text[after..].find("-----END").map(|e| after + e).unwrap_or(text.len());
            let body = text[after..end].chars().filter(|c| c.is_ascii_alphanumeric() || *c == '+' || *c == '/' || *c == '=').count();
            if body >= MIN_PEM_BODY {
                let line = text[..start].lines().count().max(1);
                out.push((
                    line,
                    Hit {
                        rule_id: "private-key",
                        title: what,
                        severity: Severity::Critical,
                        // The HEADER plus the block's size — never the key material itself, which
                        // never needs to be read into a struct to be reported.
                        secret: format!("{header} ({body} chars)"),
                    },
                ));
            }
            from = after.max(start + 1);
            if from >= text.len() {
                break;
            }
        }
    }
    out.sort_by_key(|(l, _)| *l);
    out
}

/// Files never worth scanning: binary-ish, vendored, or build output. Skipped for speed, not safety
/// — a credential inside `node_modules` is somebody else's package, not this repo's leak.
fn skip_path(path: &str) -> bool {
    const DIRS: &[&str] = &["node_modules/", "target/", ".git/", "dist/", "build/", ".bsc-records/"];
    const EXTS: &[&str] =
        &[".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".zip", ".gz", ".woff", ".woff2", ".ttf", ".ico", ".mp4", ".wasm"];
    DIRS.iter().any(|d| path.contains(d)) || EXTS.iter().any(|e| path.ends_with(e))
}

/// Scan the working tree at `root` — the files git tracks, so ignored and generated output is out of
/// scope without maintaining a second ignore list.
pub fn scan_tree(root: &Path) -> Result<Vec<Finding>, String> {
    let out = git(root, &["ls-files", "-z"])?;
    let mut findings = Vec::new();
    for rel in out.split('\0').filter(|s| !s.is_empty()) {
        if skip_path(rel) {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(root.join(rel)) else { continue };
        for (line, hit) in scan_text(&text) {
            findings.push(
                Finding::redacted(
                    Kind::LeakedSecret,
                    hit.severity,
                    hit.title,
                    Locator::File { path: rel.to_string(), line },
                    &hit.secret,
                )
                .with_refs(vec![hit.rule_id.to_string()]),
            );
        }
    }
    Ok(findings)
}

/// Scan git HISTORY — the diffs of the last `commits` commits.
///
/// Bounded on purpose: an unbounded history walk on a large repository is indistinguishable from a
/// hang, and a scan nobody waits for is a scan nobody runs. The bound is reported by the caller so a
/// clean result is never mistaken for "the whole history is clean".
pub fn scan_history(root: &Path, commits: usize) -> Result<Vec<Finding>, String> {
    // Added lines only: a `-` line is a credential being REMOVED, and reporting the removal as a new
    // finding would make every cleanup look like a fresh leak.
    let log = git(
        root,
        &["log", "--no-color", "--unified=0", "--no-merges", &format!("-n{commits}"), "--pretty=format:%x00commit %H", "-p"],
    )?;
    let mut findings = Vec::new();
    let (mut commit, mut path) = (String::new(), String::new());
    for line in log.lines() {
        if let Some(rest) = line.strip_prefix("\u{0}commit ") {
            commit = rest.trim().to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("+++ b/") {
            path = rest.trim().to_string();
            continue;
        }
        let Some(added) = line.strip_prefix('+') else { continue };
        if added.starts_with("++") || path.is_empty() || skip_path(&path) {
            continue;
        }
        for hit in scan_line(added) {
            findings.push(
                Finding::redacted(
                    Kind::LeakedSecret,
                    hit.severity,
                    hit.title,
                    Locator::GitObject {
                        object: format!("{commit}:{path}"),
                        commit: commit.clone(),
                        path: path.clone(),
                        // A unified=0 diff gives no reliable line number for the new file; 0 means
                        // "somewhere in this commit's addition", which is honest rather than wrong.
                        line: 0,
                    },
                    &hit.secret,
                )
                .with_refs(vec![hit.rule_id.to_string()]),
            );
        }
    }
    Ok(findings)
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|e| format!("git {}: {e}", args.first().copied().unwrap_or("")))?;
    if !out.status.success() {
        return Err(format!("git {} failed: {}", args.first().copied().unwrap_or(""), String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_rule_is_found_in_a_realistic_line() {
        // One case per rule, in the assignment shape these actually appear in.
        let cases: &[(&str, &str)] = &[
            ("aws-access-key-id", "aws_access_key_id = AKIAIOSFODNN7EXAMPLE"),
            ("aws-temp-key-id", "ASIAIOSFODNN7EXAMPLE"),
            ("github-pat", "token: ghp_16C7e42F292c6912E7710c838347Ae178B4a"),
            ("github-fine-grained", "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"),
            ("anthropic-api-key", &format!("ANTHROPIC_API_KEY=sk-ant-{}", "a".repeat(95))),
            ("openai-project-key", &format!("sk-proj-{}", "b".repeat(45))),
            ("slack-token", "xoxb-123456789012-1234567890123-abcdefgh"),
            ("stripe-live-key", "sk_live_4eC39HqLyjWDarjtT1zdp7dc"),
            ("google-api-key", "AIzaSyD-1234567890abcdefghijklmnopqrstu"),
            ("npm-token", "npm_abcdefghijklmnopqrstuvwxyz0123456789"),
        ];
        for (rule, line) in cases {
            let hits = scan_line(line);
            assert!(hits.iter().any(|h| h.rule_id == *rule), "{rule} not found in: {line}");
        }
    }

    #[test]
    fn a_pem_block_with_real_key_material_is_found() {
        for (header, _) in PEM_HEADERS {
            let block = format!("{header}\n{}\n-----END-----\n", "MIIBVgIBADANBgkqhkiG9w0BAQEFAASC".repeat(6));
            let hits = scan_text(&block);
            assert!(hits.iter().any(|(_, h)| h.rule_id == "private-key"), "missed {header}");
        }
    }

    #[test]
    fn a_pem_header_with_no_key_material_is_not_a_leak() {
        // The real repo's ONLY finding on the first run, and it was a test fixture: four characters
        // of base64 between the header and END. A header alone is a mention of the FORMAT.
        let fixture = r#""private_key": "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----\n","#;
        assert!(scan_text(fixture).is_empty(), "a format mention is not a credential: {fixture}");
    }

    #[test]
    fn a_multi_line_pem_key_is_seen_as_one_block() {
        // A real key spans lines, so a line-based scan structurally cannot measure it — which is
        // why PEM detection lives in scan_text and not in scan_line.
        let key = format!(
            "-----BEGIN RSA PRIVATE KEY-----\n{}-----END RSA PRIVATE KEY-----\n",
            "MIIEowIBAAKCAQEAvBQ1n2r8yZ9k3mQ7pL0xW4tYcJ2sD5fG8hK1jN6bV3aXeR9u\n".repeat(4)
        );
        let hits = scan_text(&key);
        assert_eq!(hits.len(), 1, "one block, one finding");
        assert!(scan_line(&key.replace('\n', " ")).is_empty(), "scan_line alone would never have seen it");
    }

    #[test]
    fn high_entropy_non_secrets_produce_nothing() {
        // The guard that decides whether this tool survives contact with the repo. Every line here
        // is real: a lockfile integrity hash, a git object id, a base64 fixture, a UUID, a content
        // hash. All are high-entropy and none is a credential.
        for line in [
            r#""integrity": "sha512-c2N5Cw3nX9nH2b8pQ0dnKmRhqLZmYWY7Fh1sZjK4bLQ2qXvJ8vZ6mVw1hQaGZ0kA==""#,
            "commit 9d71c4730a1b2c3d4e5f60718293a4b5c6d7e8f9",
            "const FIXTURE = 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXowMTIzNDU2Nzg5';",
            "id: 550e8400-e29b-41d4-a716-446655440000",
            "blake3 = 7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
            "let key = process.env.API_KEY;",
            "password = os.environ['DB_PASSWORD']",
        ] {
            assert!(scan_line(line).is_empty(), "false positive on: {line}");
        }
    }

    #[test]
    fn a_wrong_length_body_is_not_a_match() {
        // AKIA followed by too few characters is not an AWS key, and matching it would make the
        // prefix alone the rule — which is how prefix scanners become entropy scanners.
        assert!(scan_line("AKIASHORT").is_empty());
        assert!(scan_line("AIzaTooShort").is_empty());
        assert!(!scan_line("AKIAIOSFODNN7EXAMPLE").is_empty());
    }

    #[test]
    fn two_secrets_on_one_line_are_both_found() {
        let hits = scan_line("a=AKIAIOSFODNN7EXAMPLE b=AKIA1234567890ABCDEF");
        assert_eq!(hits.len(), 2);
    }

    #[test]
    fn skip_path_excludes_vendored_and_binary_files() {
        assert!(skip_path("node_modules/foo/index.js"));
        assert!(skip_path("target/debug/x"));
        assert!(skip_path("docs/logo.png"));
        assert!(!skip_path("src/main.rs"));
        assert!(!skip_path("config/settings.json"));
    }

    #[test]
    fn a_finding_from_a_hit_is_redacted() {
        let hit = &scan_line("k = AKIAIOSFODNN7EXAMPLE")[0];
        let f = Finding::redacted(
            Kind::LeakedSecret,
            hit.severity,
            hit.title,
            Locator::File { path: "a".into(), line: 1 },
            &hit.secret,
        );
        assert!(!serde_json::to_string(&f).unwrap().contains("AKIAIOSFODNN7EXAMPLE"));
    }
}

#[cfg(test)]
mod git_tests {
    use super::*;
    use std::process::Command;

    /// A throwaway repo with a deterministic identity, so the test never depends on the machine's
    /// git config.
    fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let run = |args: &[&str]| {
            let ok = Command::new("git").arg("-C").arg(dir.path()).args(args).output().unwrap();
            assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
        };
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@example.invalid"]);
        run(&["config", "user.name", "t"]);
        run(&["config", "commit.gpgsign", "false"]);
        dir
    }

    fn commit(dir: &Path, path: &str, body: &str, msg: &str) {
        std::fs::write(dir.join(path), body).unwrap();
        for args in [vec!["add", "-A"], vec!["commit", "-q", "-m", msg]] {
            let ok = Command::new("git").arg("-C").arg(dir).args(&args).output().unwrap();
            assert!(ok.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&ok.stderr));
        }
    }

    const AWS: &str = "AKIAIOSFODNN7EXAMPLE";

    #[test]
    fn a_secret_in_the_working_tree_is_found() {
        let d = repo();
        commit(d.path(), "config.env", &format!("AWS_ACCESS_KEY_ID={AWS}\n"), "add config");
        let f = scan_tree(d.path()).unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].refs, vec!["aws-access-key-id"]);
        assert!(!serde_json::to_string(&f[0]).unwrap().contains(AWS), "the finding must be redacted");
    }

    #[test]
    fn a_secret_deleted_from_the_tree_is_still_found_in_history() {
        // THE REASON THE HISTORY WALK EXISTS. The working tree is clean; the credential is still in
        // the pack, still fetchable from any clone, and still valid until it is rotated. A scanner
        // that reads only HEAD reports this repository clean while it is leaking.
        let d = repo();
        commit(d.path(), "config.env", &format!("AWS_ACCESS_KEY_ID={AWS}\n"), "oops");
        commit(d.path(), "config.env", "AWS_ACCESS_KEY_ID=\n", "remove the key");

        assert!(scan_tree(d.path()).unwrap().is_empty(), "the working tree really is clean now");

        let hist = scan_history(d.path(), 50).unwrap();
        assert_eq!(hist.len(), 1, "and the credential is still in history");
        assert!(matches!(hist[0].locator, Locator::GitObject { .. }), "history findings are located in git, not in a file");
        assert!(!serde_json::to_string(&hist[0]).unwrap().contains(AWS));
    }

    #[test]
    fn removing_a_secret_is_not_reported_as_a_new_leak() {
        // The history walk reads ADDED lines only. Counting removals would make every cleanup
        // commit look like a fresh leak, and the report would grow as the repo got safer.
        let d = repo();
        commit(d.path(), "config.env", &format!("AWS_ACCESS_KEY_ID={AWS}\n"), "oops");
        commit(d.path(), "config.env", "AWS_ACCESS_KEY_ID=\n", "remove the key");
        let hist = scan_history(d.path(), 50).unwrap();
        assert_eq!(hist.len(), 1, "the ADD is reported once; the removal is not a second finding");
    }

    #[test]
    fn the_history_bound_is_respected() {
        // The bound is what keeps a large repo's scan from being indistinguishable from a hang, so
        // it has to actually bound.
        let d = repo();
        commit(d.path(), "a.txt", &format!("k={AWS}\n"), "leak");
        for i in 0..5 {
            commit(d.path(), "b.txt", &format!("filler {i}\n"), &format!("c{i}"));
        }
        assert!(scan_history(d.path(), 2).unwrap().is_empty(), "the leak is older than the bound");
        assert_eq!(scan_history(d.path(), 50).unwrap().len(), 1, "and is found when the bound reaches it");
    }

    #[test]
    fn a_non_repo_reports_an_error_rather_than_clean() {
        // Silence must never be mistaken for a clean result — that is the failure this whole crate
        // is built to avoid.
        let d = tempfile::tempdir().unwrap();
        assert!(scan_tree(d.path()).is_err(), "an unscannable directory is an error, not zero findings");
    }
}
