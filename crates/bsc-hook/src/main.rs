//! `bsc-hook` — the PreToolUse gates that a **sandboxed** session can actually reach.
//!
//! ── WHY THIS BINARY EXISTS ──────────────────────────────────────────────────────────────────────
//! A session inside a `bsc-sandbox` mount namespace gets a curated `/usr` without `bsc`, no
//! `BASH_ENV`, and an environment cleared to `HOME`/`TERM`. So `bsc hook bash-deny` has no binary
//! and the pure-shell gates never load: **inside a namespace the hooks do not run at all**.
//!
//! That would be fine if the kernel replaced them, and for one of them it does. It does not for the
//! other two, because a mount namespace is *path-granular* (see the table in
//! `bsc_sandbox::profile`):
//!
//! | gate | namespace subsumes it? | here? |
//! |---|---|---|
//! | `bsc-confine` | **yes** — an out-of-root path is simply absent | **no** — do not rebuild it |
//! | `bsc-scope` | **no** — globs *within* one read-write worktree | **yes** |
//! | `bsc-deny` | **partly** — an absent binary cannot run; a present one with dangerous flags still can | **yes** |
//!
//! So this carries exactly the two checks the kernel cannot express, and nothing else. It is
//! deliberately not "little bsc": it opens no store, reads no database, and touches no host path.
//!
//! ── ONE RULE, ONE IMPLEMENTATION ────────────────────────────────────────────────────────────────
//! Both decisions live in `bsc-util` ([`bsc_util::bash_gate`], [`bsc_util::scope`]) and are called
//! by the umbrella `bsc hook` too. `dangerous.rs` exists *because* this floor was once written
//! twice and drifted; a second binary is exactly how that happens again, so the logic is shared
//! rather than copied. The scope matcher is additionally pinned against the shipping `scope.sh` by
//! a shared case table.
//!
//! ── CONFIG COMES FROM THE SPEC, NOT FROM INHERITANCE ────────────────────────────────────────────
//! `$BSC_SCOPE_GLOBS`, `$BSC_REPO_ROOT` and `$BSC_DENY_BASH` are declared by the sandbox spec's
//! explicit env allowlist — the same mechanism that passes `HOME` and `TERM` — and are
//! namespace-relative (`BSC_REPO_ROOT=/repo`), never host paths. Nothing here relaxes `--clearenv`.
//!
//! ── FAIL-OPEN, ON PURPOSE ───────────────────────────────────────────────────────────────────────
//! Unreadable or unparseable stdin ALLOWS, matching `bsc hook`'s existing posture. This gate is one
//! layer among several (the kernel below it, the harness above it); a gate that fails CLOSED on
//! malformed input turns a parsing bug into a wedged agent. A gate that fails open on a *matched*
//! pattern would be the real bug, and that path exits 2 unconditionally.

use std::io::Read;

/// Claude's PreToolUse convention: exit 2 blocks the tool call, 0 allows it.
const BLOCK: i32 = 2;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str).unwrap_or("") {
        "bash-deny" => bash_deny(),
        "scope" => scope(),
        "" | "help" | "-h" | "--help" => {
            print!(
                "bsc-hook — PreToolUse gates for a session inside a mount namespace\n\n\
                 USAGE:\n  \
                 bsc-hook bash-deny   # exit 2 if a Bash command hits the dangerous floor or a\n                       \
                 # $BSC_DENY_BASH pattern (reads the tool JSON on stdin)\n  \
                 bsc-hook scope       # exit 2 if a file write falls outside $BSC_SCOPE_GLOBS\n                       \
                 # (reads the tool JSON on stdin)\n\n\
                 Confinement is NOT here: a mount namespace already makes an out-of-root path absent.\n"
            );
        }
        other => {
            // An unknown gate must not silently allow — the caller believes it installed a check.
            eprintln!("bsc-hook: unknown gate '{other}' (known: bash-deny, scope)");
            std::process::exit(1);
        }
    }
}

/// Read stdin whole. `None` when it cannot be read — the caller then allows (see the fail-open note).
fn stdin_json() -> Option<serde_json::Value> {
    let mut input = String::new();
    if std::io::stdin().read_to_string(&mut input).is_err() {
        return None;
    }
    serde_json::from_str::<serde_json::Value>(&input).ok()
}

/// One string field out of `tool_input`, trying each name in order.
fn tool_input_str(v: &serde_json::Value, names: &[&str]) -> String {
    let Some(ti) = v.get("tool_input") else {
        return String::new();
    };
    for n in names {
        if let Some(s) = ti.get(n).and_then(|x| x.as_str()) {
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    String::new()
}

/// The dangerous floor + the session's deny patterns, over the Bash tool's `command`.
fn bash_deny() {
    let Some(v) = stdin_json() else { return };
    let cmd = tool_input_str(&v, &["command"]);
    let denies = std::env::var("BSC_DENY_BASH").unwrap_or_default();
    if let Some(reason) = bsc_util::bash_gate::deny_reason(&cmd, &denies) {
        eprintln!("blocked: command matches {reason} — #1916 deny-list (sandboxed session)");
        std::process::exit(BLOCK);
    }
}

/// The write-scope globs, over whichever path field the file tool carries.
fn scope() {
    let Some(v) = stdin_json() else { return };
    let path = tool_input_str(&v, &["file_path", "notebook_path"]);
    let globs = std::env::var("BSC_SCOPE_GLOBS").unwrap_or_default();
    let root = std::env::var("BSC_REPO_ROOT").unwrap_or_default();
    if let bsc_util::scope::Scope::Deny(reason) = bsc_util::scope::scope_verdict(&path, &globs, &root)
    {
        eprintln!("blocked: {reason} (#1297, sandboxed session) — allowed: {globs}");
        std::process::exit(BLOCK);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload(field: &str, value: &str) -> serde_json::Value {
        serde_json::json!({ "tool_input": { field: value } })
    }

    #[test]
    fn a_missing_tool_input_yields_an_empty_field_rather_than_panicking() {
        let v = serde_json::json!({ "unrelated": 1 });
        assert_eq!(tool_input_str(&v, &["command"]), "");
    }

    #[test]
    fn the_first_present_non_empty_field_name_wins() {
        let v = serde_json::json!({ "tool_input": { "file_path": "", "notebook_path": "nb.ipynb" } });
        assert_eq!(tool_input_str(&v, &["file_path", "notebook_path"]), "nb.ipynb");
        let v = payload("file_path", "a.rs");
        assert_eq!(tool_input_str(&v, &["file_path", "notebook_path"]), "a.rs");
    }

    #[test]
    fn a_non_string_field_is_treated_as_absent_not_stringified() {
        // A number here must not become the literal "7" and get matched against globs.
        let v = serde_json::json!({ "tool_input": { "file_path": 7 } });
        assert_eq!(tool_input_str(&v, &["file_path"]), "");
    }

    // The decisions themselves are tested in `bsc-util`, where they live. What matters HERE is that
    // this binary reads the payload the harness actually sends and reaches those decisions with the
    // right arguments — the wiring, not the rule.
    #[test]
    fn the_wiring_reaches_the_shared_decisions() {
        let v = payload("command", "rm -rf /");
        let cmd = tool_input_str(&v, &["command"]);
        assert!(bsc_util::bash_gate::deny_reason(&cmd, "").is_some());

        let v = payload("file_path", "/repo/src/store/x.rs");
        let p = tool_input_str(&v, &["file_path", "notebook_path"]);
        assert!(matches!(
            bsc_util::scope::scope_verdict(&p, "src/features/**", "/repo"),
            bsc_util::scope::Scope::Deny(_)
        ));
        assert_eq!(
            bsc_util::scope::scope_verdict(&p, "src/store/**", "/repo"),
            bsc_util::scope::Scope::Allow
        );
    }
}
