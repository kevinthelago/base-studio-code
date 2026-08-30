//! `.claude/session.json` — what a session is, resolved from where it stands
//! (#a-session-outside-the-app-can-discover-itself-from-claude-session-json).
//!
//! ## The problem this exists for
//!
//! MEASURED: `bsc-agent` at a project root with a clean environment against the same run inside the
//! app —
//!
//! ```text
//! fact       in the app              clean terminal
//! provider   ollama                  anthropic   <- wrong, dies on 401
//! model      qwen3.5-abliterated:9b  <default>
//! tools      32                      10          <- no bsc-plan, no bsc-fleet
//! CLAUDE.md  loaded                  loaded  OK
//! skills     15                      15      OK
//! ```
//!
//! The pattern is exact: **everything derived from the filesystem works; everything derived from
//! environment variables is absent.** The app injects ~10 variables through the PTY, and outside it a
//! session loses its provider, its model, its whole `bsc` tool surface, its plan store, its identity
//! and its write scope. It does not degrade — it dies on `401 x-api-key header is required` against a
//! service the user is not running, because `provider` silently defaults.
//!
//! ## Why a file, and why THIS file
//!
//! The convention was already two-thirds built: a worktree's `.claude/` holds `skills/`, which
//! `bsc-agent` already reads, and `settings.json`. What it carried was ENFORCEMENT — a hundred deny
//! rules — and no IDENTITY.
//!
//! A NEW FILE beside `settings.json`, never keys inside it: that file is Claude Code's format, and the
//! app rewrites it on every launch. A paired `.qwen/` was considered and rejected — two directories
//! means every writer writes twice and every reader needs precedence rules between them, which is not
//! two sources of truth but one truth and one thing that drifts.
//!
//! ## Composition, and why per FIELD
//!
//! Read by walking UP from the cwd and merged least-specific-first, exactly as the `CLAUDE.md` chain
//! is: `~/.claude/` supplies machine defaults, a project hub supplies its key and store, a worktree
//! supplies its stream and scope. Merging per FIELD rather than per FILE is the whole point — a
//! machine-level provider and a worktree-level stream have to COMBINE, and a whole-file override would
//! make the deepest file responsible for restating everything above it.
//!
//! ## Precedence: an explicit environment variable wins
//!
//! The env var is a caller being explicit right now; the file is what was persisted earlier. So every
//! app-launched session behaves exactly as it does today — including a caged worker, whose config is
//! passed deliberately — and the file is purely additive for sessions the app did not launch.
//!
//! ## It must never guess
//!
//! A field that resolves from nowhere is ABSENT, and absence is reported. A silent default is what
//! produced the 401 this module exists to remove, and `Resolved` therefore carries the SOURCE of every
//! value so a fresh machine can be asked what it found rather than inferred at.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// The directory the session document lives in, alongside Claude Code's own files.
pub const SESSION_DIR: &str = ".claude";
/// The document itself. Deliberately NOT `settings.json`, which Claude Code owns.
pub const SESSION_FILE: &str = "session.json";

/// One `.claude/session.json`. Every field optional: a level supplies what it knows and stays silent
/// about the rest, which is what makes the per-field merge meaningful.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SessionDoc {
    /// Format version, so a future shape can be recognised rather than mis-read.
    pub version: Option<u32>,
    // ── the preference: what this machine runs local work on ────────────────────────────────────
    pub provider: Option<String>,
    pub model: Option<String>,
    pub base_url: Option<String>,
    pub num_ctx: Option<u64>,
    // ── the project: which stores this scope belongs to ─────────────────────────────────────────
    pub project_key: Option<String>,
    pub plan_db: Option<String>,
    // ── the identity: who this session is and what it may touch ─────────────────────────────────
    pub role: Option<String>,
    pub stream: Option<String>,
    pub write_scope: Option<Vec<String>>,
}

/// Where a resolved value came from — the field that makes a fresh machine debuggable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Source {
    /// An explicit environment variable, which beats everything.
    Env(String),
    /// A `.claude/session.json`, at this path.
    File(PathBuf),
}

impl Source {
    pub fn describe(&self) -> String {
        match self {
            Source::Env(k) => format!("${k}"),
            Source::File(p) => p.display().to_string(),
        }
    }
}

/// A session's configuration, with every value's origin.
///
/// `values` holds only what actually RESOLVED. A field absent here is absent everywhere — the caller
/// reports it as unset rather than substituting a default, which is the rule this whole module turns on.
#[derive(Debug, Clone, Default)]
pub struct Resolved {
    pub values: BTreeMap<String, String>,
    pub sources: BTreeMap<String, Source>,
    /// Files that were found and could not be parsed. Reported, never silently skipped: a session
    /// running on machine defaults because its project file has a stray comma should be able to
    /// discover that in one step.
    pub malformed: Vec<(PathBuf, String)>,
    /// Every session file that contributed, least-specific first.
    pub chain: Vec<PathBuf>,
}

impl Resolved {
    pub fn get(&self, field: &str) -> Option<&str> {
        self.values.get(field).map(String::as_str)
    }
    pub fn source_of(&self, field: &str) -> Option<&Source> {
        self.sources.get(field)
    }
}

/// The fields, and the environment variable that overrides each.
///
/// A table rather than a match so the report, the merge and the override cannot list different sets —
/// the drift that a second hand-maintained list always produces.
pub const FIELDS: &[(&str, &str)] = &[
    ("provider", "BSC_AGENT_PROVIDER"),
    ("model", "BSC_AGENT_MODEL"),
    ("baseUrl", "BSC_AGENT_BASE_URL"),
    ("numCtx", "BSC_AGENT_NUM_CTX"),
    ("projectKey", "BSC_PROJECT_KEY"),
    ("planDb", "BSC_PLAN_DB"),
    ("role", "BSC_SESSION_ROLE"),
    ("stream", "BSC_STREAM"),
    ("writeScope", "BSC_SCOPE_GLOBS"),
];

/// Pull a doc's fields into the flat `(field, value)` shape the merge works in.
fn fields_of(doc: &SessionDoc) -> Vec<(&'static str, String)> {
    let mut out: Vec<(&'static str, String)> = Vec::new();
    let mut push = |k: &'static str, v: Option<String>| {
        if let Some(v) = v.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            out.push((k, v));
        }
    };
    push("provider", doc.provider.clone());
    push("model", doc.model.clone());
    push("baseUrl", doc.base_url.clone());
    push("numCtx", doc.num_ctx.map(|n| n.to_string()));
    push("projectKey", doc.project_key.clone());
    push("planDb", doc.plan_db.clone());
    push("role", doc.role.clone());
    push("stream", doc.stream.clone());
    // Whitespace-joined, matching `$BSC_SCOPE_GLOBS`'s own shape so the two are interchangeable.
    push("writeScope", doc.write_scope.as_ref().map(|g| g.join(" ")));
    out
}

/// Every `.claude/session.json` from the filesystem root down to `start`, least-specific first.
///
/// Root-first is the same ordering the `CLAUDE.md` chain uses, and for the same reason: the deepest
/// file is the most specific, so it must be applied last.
pub fn chain_for(start: &Path, home: Option<&Path>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    // The machine defaults live under HOME and are NOT an ancestor of a project hub or a worktree, so
    // the ancestor walk below would miss them — exactly as `compose_system_inner` reads the global
    // CLAUDE.md separately, and for the same reason.
    if let Some(h) = home {
        let p = h.join(SESSION_DIR).join(SESSION_FILE);
        if p.is_file() {
            out.push(p);
        }
    }
    let mut dirs: Vec<&Path> = start.ancestors().collect();
    dirs.reverse();
    for d in dirs {
        let p = d.join(SESSION_DIR).join(SESSION_FILE);
        if p.is_file() && !out.contains(&p) {
            out.push(p);
        }
    }
    out
}

/// Resolve a session's configuration: the file chain merged per field, then the environment on top.
///
/// `env` is injected so the precedence rule is testable without touching the process environment —
/// which is global, and which a parallel test suite cannot own.
pub fn resolve_with(
    start: &Path,
    home: Option<&Path>,
    env: impl Fn(&str) -> Option<String>,
) -> Resolved {
    let mut r = Resolved::default();

    for path in chain_for(start, home) {
        let text = match std::fs::read_to_string(&path) {
            Ok(t) => t,
            Err(e) => {
                r.malformed.push((path.clone(), e.to_string()));
                continue;
            }
        };
        match serde_json::from_str::<SessionDoc>(&text) {
            Ok(doc) => {
                r.chain.push(path.clone());
                // PER FIELD, and later wins: a machine-level provider and a worktree-level stream have
                // to combine. A whole-file override would make the deepest file restate everything.
                for (k, v) in fields_of(&doc) {
                    r.values.insert(k.to_string(), v);
                    r.sources.insert(k.to_string(), Source::File(path.clone()));
                }
            }
            // REPORTED, never skipped in silence. A session quietly running on machine defaults
            // because its project file has a stray comma is the failure this whole module is about.
            Err(e) => r.malformed.push((path.clone(), e.to_string())),
        }
    }

    // The environment last: a caller being explicit right now beats what was persisted earlier, so no
    // app-launched session changes behaviour and the file is purely additive.
    for (field, var) in FIELDS {
        if let Some(v) = env(var).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
            r.values.insert((*field).to_string(), v);
            r.sources.insert((*field).to_string(), Source::Env((*var).to_string()));
        }
    }
    r
}

/// [`resolve_with`] against the real process environment and home directory.
pub fn resolve(start: &Path) -> Resolved {
    resolve_with(start, bsc_util::home_dir().as_deref(), |k| std::env::var(k).ok())
}

/// The whole resolution, rendered — the answer to "why does my fresh machine behave differently",
/// in one step rather than an afternoon.
///
/// Prints what resolved AND what did not. The absent half is the useful half: a field that resolved
/// from nowhere is the thing a reader has to act on, and a report that listed only successes would
/// leave them counting what is missing by hand.
pub fn render_report(r: &Resolved) -> String {
    let mut out = String::from("# Session configuration\n\n");
    if r.chain.is_empty() {
        out.push_str("no .claude/session.json found on the way up from here\n");
    } else {
        out.push_str("files, least-specific first:\n");
        for p in &r.chain {
            out.push_str(&format!("  {}\n", p.display()));
        }
    }
    out.push('\n');
    for (field, var) in FIELDS {
        match (r.get(field), r.source_of(field)) {
            (Some(v), Some(s)) => out.push_str(&format!("{field:<12} {v}\n{:<12} from {}\n", "", s.describe())),
            _ => out.push_str(&format!("{field:<12} (unset — no file supplies it and ${var} is not set)\n")),
        }
    }
    if !r.malformed.is_empty() {
        out.push_str("\nUNREADABLE — these were found and could not be used:\n");
        for (p, why) in &r.malformed {
            out.push_str(&format!("  {}: {why}\n", p.display()));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, json: &str) {
        let d = dir.join(SESSION_DIR);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join(SESSION_FILE), json).unwrap();
    }

    fn tmp(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("bsc-session-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn the_chain_merges_per_field_least_specific_first() {
        // THE POINT OF PER-FIELD. A machine-level provider and a worktree-level stream must COMBINE;
        // a whole-file override would make the deepest file responsible for restating everything
        // above it, which is how a worktree ends up silently on the wrong model.
        let base = tmp("merge");
        let home = base.join("home");
        let hub = base.join("hub");
        let wt = hub.join("wt");
        std::fs::create_dir_all(&wt).unwrap();
        write(&home, r#"{"provider":"ollama","model":"qwen3.5:9b"}"#);
        write(&hub, r#"{"projectKey":"demo","model":"qwen3.5:35b"}"#);
        write(&wt, r#"{"stream":"api","writeScope":["src/**/*.ts","docs/**"]}"#);

        let r = resolve_with(&wt, Some(&home), |_| None);
        assert_eq!(r.get("provider"), Some("ollama"), "from the machine level");
        assert_eq!(r.get("projectKey"), Some("demo"), "from the hub");
        assert_eq!(r.get("stream"), Some("api"), "from the worktree");
        // ...and the most specific wins where two levels both speak.
        assert_eq!(r.get("model"), Some("qwen3.5:35b"), "the hub overrides the machine default");
        // The glob list joins the way $BSC_SCOPE_GLOBS is already shaped, so the two are interchangeable.
        assert_eq!(r.get("writeScope"), Some("src/**/*.ts docs/**"));
        assert_eq!(r.chain.len(), 3);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_explicit_environment_variable_beats_the_file() {
        // The precedence that keeps every app-launched session behaving exactly as it does today.
        let base = tmp("envwins");
        write(&base, r#"{"provider":"ollama","model":"qwen3.5:9b"}"#);
        let r = resolve_with(&base, None, |k| {
            (k == "BSC_AGENT_MODEL").then(|| "claude-sonnet-5".to_string())
        });
        assert_eq!(r.get("model"), Some("claude-sonnet-5"));
        assert_eq!(r.source_of("model"), Some(&Source::Env("BSC_AGENT_MODEL".into())));
        // ...and only that field: the rest still comes from the file.
        assert_eq!(r.get("provider"), Some("ollama"));
        assert!(matches!(r.source_of("provider"), Some(Source::File(_))));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_field_nobody_supplies_is_absent_rather_than_defaulted() {
        // THE RULE THIS MODULE TURNS ON. A silent default is what produced the measured
        // `401 x-api-key header is required` — `provider` fell back to anthropic against a service the
        // user was not running, and the error named neither the cause nor the fix.
        let base = tmp("absent");
        write(&base, r#"{"stream":"api"}"#);
        let r = resolve_with(&base, None, |_| None);
        assert_eq!(r.get("stream"), Some("api"));
        assert_eq!(r.get("provider"), None);
        assert_eq!(r.source_of("provider"), None);
        // ...and the report SAYS so, naming the variable that would set it.
        let text = render_report(&r);
        assert!(text.contains("provider     (unset"), "{text}");
        assert!(text.contains("$BSC_AGENT_PROVIDER"), "{text}");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_malformed_file_is_reported_rather_than_skipped() {
        // A session quietly running on machine defaults because its project file has a stray comma is
        // exactly the silent-wrong-answer this exists to remove. It must not crash the session either.
        let base = tmp("bad");
        let hub = base.join("hub");
        std::fs::create_dir_all(&hub).unwrap();
        write(&base, r#"{"provider":"ollama"}"#);
        write(&hub, "{ not json");

        let r = resolve_with(&hub, None, |_| None);
        assert_eq!(r.get("provider"), Some("ollama"), "the readable level still applies");
        assert_eq!(r.malformed.len(), 1);
        assert!(render_report(&r).contains("UNREADABLE"));
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn every_field_has_an_override_and_the_table_is_the_only_list() {
        // One table drives the merge, the override and the report, so they cannot list different sets.
        let names: Vec<&str> = FIELDS.iter().map(|(f, _)| *f).collect();
        for f in ["provider", "model", "baseUrl", "numCtx", "projectKey", "planDb", "role", "stream", "writeScope"] {
            assert!(names.contains(&f), "{f} must be resolvable");
        }
        // Every doc field reaches the merge — a field added to the struct and forgotten in
        // `fields_of` would be silently unresolvable.
        let doc = SessionDoc {
            version: Some(1),
            provider: Some("p".into()),
            model: Some("m".into()),
            base_url: Some("b".into()),
            num_ctx: Some(7),
            project_key: Some("k".into()),
            plan_db: Some("d".into()),
            role: Some("r".into()),
            stream: Some("s".into()),
            write_scope: Some(vec!["g".into()]),
        };
        assert_eq!(fields_of(&doc).len(), FIELDS.len(), "every field is carried");
    }

    #[test]
    fn a_blank_value_is_the_same_as_an_absent_one() {
        // An empty string is not a choice — a runtime would take `""` literally where it falls back
        // for an absent one.
        let base = tmp("blank");
        write(&base, r#"{"provider":"   ","model":"qwen"}"#);
        let r = resolve_with(&base, None, |k| (k == "BSC_STREAM").then(|| "  ".to_string()));
        assert_eq!(r.get("provider"), None);
        assert_eq!(r.get("stream"), None);
        assert_eq!(r.get("model"), Some("qwen"));
        let _ = std::fs::remove_dir_all(&base);
    }
}
