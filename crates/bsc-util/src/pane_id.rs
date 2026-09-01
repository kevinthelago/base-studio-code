//! The pane-id grammar — mint an identity, read one back, and the decisions that hang off it.
//!
//! ## Why this is here
//!
//! A pane id keys almost every backend-owned map: the PTY ledger, the worktree tree, the per-agent
//! sandbox Linux user and its `700` home, the plan row, `coord.log`'s project scope. The grammar that
//! MINTS and READS it lived only in the renderer (`paneIdentity.ts`), while Rust re-stated pieces of
//! it in four places, none derived from the grammar:
//!
//! - `must_be_gated` (`console/pty/mod.rs`) — which `paneNeedsGate` calls "a byte-for-byte mirror" of
//!   itself, in its own doc comment;
//! - `director_project` and `worker_pane` (`fleet/wake.rs`), each a bare `split_once(':')`;
//! - `coord_project_of` (`logs::waiting`, and `logs::coord`);
//! - another `split_once(':')` in `observability/pty_faults.rs`.
//!
//! ## The mirror has already broken once, and it deadlocked
//!
//! `paneNeedsGate` exists BECAUSE the two sides disagreed about which panes need a gate file. Rust
//! refused a gated pane whose cwd had no `.claude/settings.json`, and the only writer of that file sat
//! behind a frontend flag that is false for a RESTORED pane — so the pane could never write the file
//! that would let it launch, and the skip logged nothing. Measured at 30 project hubs with no gate
//! file and 10 directors refused in a single app run.
//!
//! What guarded it afterwards was two HAND-COPIED TABLES: `paneNeedsGate.test.ts` states in a comment
//! that it asserts "THE SAME TABLE" the Rust test does. This module replaces that arrangement with one
//! generated contract — `src/app/console/paneIdentity.fixtures.json`, produced from the shipping
//! TypeScript and read by the tests on both sides.
//!
//! ## The grammar
//!
//! ```text
//!   man:<tabId>:p<idx>          manual console — ephemeral, never auto-recovered
//!   t<idx>p<idx>                legacy positional id
//!   <projectKey>:<repo>:triage  per-repo triage pane
//!   <projectKey>:director       a project's director
//!   <projectKey>:<streamId>     a fleet worker
//! ```
//!
//! Project keys are sanitized to `[A-Za-z0-9-]`, so a colon is purely a structural separator and a
//! repo full name carries `/`, never `:`.
//!
//! ## Ambiguities that are REPRODUCED, not fixed
//!
//! The grammar is not injective and the port must not tidy that up, because the renderer ships the
//! collisions today:
//!
//! - a stream literally named `director` classifies as a DIRECTOR (`<key>:director`);
//! - a two-part `<key>:triage` classifies as a WORKER, because triage needs three parts;
//! - `man:tab:p` does not match the manual shape (no digits), so it parses as a WORKER whose project
//!   key is `man` — while [`is_manual_pane_id`] still says true, because that reads the prefix alone;
//! - `<key>::` parses as a worker with stream id `:`, yet [`pane_needs_gate`] says false.
//!
//! Each is in the fixture. Three rules can disagree about one id, and that is the state of the world.
//!
//! ## Scope
//!
//! The GRAMMAR only. The tab-collection helpers next to it in the TypeScript (`paneIdFor`,
//! `paneBelongsToTab`, `findPaneOwnerTab`, `crashRestorablePanes`, `crashRestoreTabIdx`) walk the
//! renderer's tabs array, which is not a resource Rust owns, and they stay there.

/// What shape a pane identity encodes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaneKind {
    Director,
    Worker,
    Triage,
    Manual,
    /// The legacy `t<idx>p<idx>` form.
    Positional,
}

impl PaneKind {
    /// The wire spelling the TypeScript uses — what the fixture carries.
    pub fn as_str(self) -> &'static str {
        match self {
            PaneKind::Director => "director",
            PaneKind::Worker => "worker",
            PaneKind::Triage => "triage",
            PaneKind::Manual => "manual",
            PaneKind::Positional => "positional",
        }
    }
}

/// A pane identity read back into its parts. Which fields are present depends on [`PaneKind`], and
/// the emptiness of a present field is meaningful: `<key>::triage` is a triage pane whose `repo` is
/// the empty string, which is why [`pane_cwd_recovery`] declines it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPaneIdentity {
    pub kind: PaneKind,
    /// The id as given.
    pub raw: String,
    /// Director, worker, triage.
    pub project_key: Option<String>,
    /// Worker.
    pub stream_id: Option<String>,
    /// Triage — the repo (`owner/name`).
    pub repo: Option<String>,
    /// Manual — the owning tab's stable id.
    pub tab_id: Option<String>,
    /// Manual, positional — the grid cell index.
    pub pane_idx: Option<i64>,
    /// Positional — the tab index.
    pub tab_idx: Option<i64>,
}

impl ParsedPaneIdentity {
    fn of(kind: PaneKind, raw: &str) -> Self {
        ParsedPaneIdentity {
            kind,
            raw: raw.to_string(),
            project_key: None,
            stream_id: None,
            repo: None,
            tab_id: None,
            pane_idx: None,
            tab_idx: None,
        }
    }
}

/// The legacy positional id.
pub fn positional_pane_id(tab_idx: i64, pane_idx: i64) -> String {
    format!("t{tab_idx}p{pane_idx}")
}

/// A manual console pane's ephemeral, per-tab id.
pub fn manual_pane_id(tab_id: &str, pane_idx: i64) -> String {
    format!("man:{tab_id}:p{pane_idx}")
}

/// A fleet worker's identity id.
pub fn fleet_pane_id(project_key: &str, stream_id: &str) -> String {
    format!("{project_key}:{stream_id}")
}

/// A project director's identity id.
pub fn director_pane_id(project_key: &str) -> String {
    format!("{project_key}:director")
}

/// A per-repo triage pane's identity id.
pub fn triage_pane_id(project_key: &str, repo: &str) -> String {
    format!("{project_key}:{repo}:triage")
}

/// Whether an id is a manual console pane — manual panes are never auto-recovered.
///
/// This reads the PREFIX alone, so it can and does disagree with [`parse_pane_identity`]: `man:tab:p`
/// is manual here and a worker there. That is the shipping behaviour, not an oversight.
pub fn is_manual_pane_id(id: &str) -> bool {
    id.starts_with("man:")
}

/// Whether an id is the dedicated PLANNER pane (`planning_<key>`) — the intentional exception to the
/// `<key>:<stream>` scheme. A planning session is re-entered from the Projects page rather than
/// restored from the crash banner, so it is excluded from recovery.
pub fn is_planning_pane_id(id: &str) -> bool {
    id.starts_with("planning_")
}

/// Will the backend require a `.claude/settings.json` gate for this pane before it will spawn?
///
/// Not a `man:` pane, and a `<a>:<b>` shape with a non-empty first segment and at least one non-empty
/// segment after it. Deliberately NOT expressed in terms of [`parse_pane_identity`]: it is its own
/// rule and the two disagree on real ids (`<key>::` parses as a worker and needs no gate), so
/// defining one through the other would silently move the gate.
pub fn pane_needs_gate(id: &str) -> bool {
    if is_manual_pane_id(id) {
        return false;
    }
    let parts: Vec<&str> = id.split(':').collect();
    parts.len() >= 2 && !parts[0].is_empty() && parts[1..].iter().any(|p| !p.is_empty())
}

/// `/^man:(.+):p(\d+)$/` — the tab id runs to the LAST `:p<digits>` tail, so `man:a:p1:p2` is
/// tab `a:p1`, pane 2.
///
/// The regex's `.+` is greedy, and that turns out NOT to be load-bearing: a matching tail is all
/// digits and runs to the end, and digits contain no colon, so at MOST ONE candidate can ever match
/// and greedy and lazy coincide. Checked against both regexes rather than assumed — an earlier
/// version of this comment credited greediness for the `a:p1` answer, and a deliberate non-greedy
/// port then passed every test in this module, which is how the overclaim was caught. What the scan
/// must actually get right is the DIGIT CHECK (a `:p` whose tail is not all digits is not a tail)
/// and the non-empty tab id. Both bite.
fn parse_manual(id: &str) -> Option<(String, i64)> {
    let rest = id.strip_prefix("man:")?;
    let mut best: Option<(usize, i64)> = None;
    for i in 0..rest.len() {
        if !rest.is_char_boundary(i) || !rest[i..].starts_with(":p") {
            continue;
        }
        let tail = &rest[i + 2..];
        if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        // Ascending scan, overwriting ⇒ `best` ends on the LAST match. At most one can match (see
        // the doc comment), so this is belt-and-braces rather than the thing doing the work.
        if let Ok(n) = tail.parse::<i64>() {
            best = Some((i, n));
        }
    }
    let (i, n) = best?;
    // `(.+)` needs at least one character, so a bare `man::p0` does not match.
    if i == 0 {
        return None;
    }
    Some((rest[..i].to_string(), n))
}

/// `/^t(\d+)p(\d+)$/`.
fn parse_positional(id: &str) -> Option<(i64, i64)> {
    let rest = id.strip_prefix('t')?;
    let split = rest.find('p')?;
    let (a, b) = (&rest[..split], &rest[split + 1..]);
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit());
    if !digits(a) || !digits(b) {
        return None;
    }
    Some((a.parse().ok()?, b.parse().ok()?))
}

/// Read a pane identity id back into its structured meaning — the inverse of the minting helpers.
///
/// `None` for an unrecognized shape. The id grammar is self-describing, which is what lets a session
/// be recovered from its NAME alone when the persisted store has lost it.
pub fn parse_pane_identity(id: &str) -> Option<ParsedPaneIdentity> {
    if let Some((tab_id, pane_idx)) = parse_manual(id) {
        let mut p = ParsedPaneIdentity::of(PaneKind::Manual, id);
        p.tab_id = Some(tab_id);
        p.pane_idx = Some(pane_idx);
        return Some(p);
    }
    if let Some((tab_idx, pane_idx)) = parse_positional(id) {
        let mut p = ParsedPaneIdentity::of(PaneKind::Positional, id);
        p.tab_idx = Some(tab_idx);
        p.pane_idx = Some(pane_idx);
        return Some(p);
    }
    let parts: Vec<&str> = id.split(':').collect();
    // Triage: a `triage` tail with the repo in between. The repo may be EMPTY and still parse.
    if parts.len() >= 3 && parts[parts.len() - 1] == "triage" && !parts[0].is_empty() {
        let mut p = ParsedPaneIdentity::of(PaneKind::Triage, id);
        p.project_key = Some(parts[0].to_string());
        p.repo = Some(parts[1..parts.len() - 1].join(":"));
        return Some(p);
    }
    if parts.len() == 2 && parts[1] == "director" && !parts[0].is_empty() {
        let mut p = ParsedPaneIdentity::of(PaneKind::Director, id);
        p.project_key = Some(parts[0].to_string());
        return Some(p);
    }
    if parts.len() >= 2 && !parts[0].is_empty() {
        let stream = parts[1..].join(":");
        if !stream.is_empty() {
            let mut p = ParsedPaneIdentity::of(PaneKind::Worker, id);
            p.project_key = Some(parts[0].to_string());
            p.stream_id = Some(stream);
            return Some(p);
        }
    }
    None
}

/// The identity to provision a per-agent sandbox Linux USER for, or `None` when this pane keeps the
/// sealed distro's shared default user.
///
/// A sandboxed FLEET pane — a worker or the director, running inside the sealed distro — runs as its
/// own non-root user with a `700` home, so co-located agents cannot read or tamper with its files
/// even from raw Bash. Every other pane, and every pane with no distro, keeps the shared user. An
/// EMPTY distro counts as absent, matching the reducer's falsy check.
///
/// Returns the pane id itself — the agent's stable identity — so a relaunch re-derives the SAME
/// Linux user and home.
pub fn sandbox_user_identity(pane_id: &str, distro: Option<&str>) -> Option<String> {
    if distro.is_none_or(str::is_empty) {
        return None;
    }
    match parse_pane_identity(pane_id)?.kind {
        PaneKind::Worker | PaneKind::Director => Some(pane_id.to_string()),
        _ => None,
    }
}

/// Which backend command resolves a pane's on-disk dir from its identity alone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CwdRecovery {
    /// `repo_dir_path` — a triage pane's repo clone.
    RepoDir { project_key: String, repo: String },
    /// `project_dir_path` — a director's project hub.
    ProjectDir { project_key: String },
}

/// The command that recovers a pane's cwd from its identity, for a pane whose configured cwd came
/// back empty.
///
/// `None` where the dir cannot be derived from the id alone: a manual or positional pane, a triage
/// pane with an empty repo, and a WORKER — whose cwd is a worktree keyed by the agent id, which
/// `ensure_worktree` already supplies.
pub fn pane_cwd_recovery(pane_id: &str) -> Option<CwdRecovery> {
    let id = parse_pane_identity(pane_id)?;
    let project_key = id.project_key?;
    match id.kind {
        PaneKind::Triage => {
            let repo = id.repo.filter(|r| !r.is_empty())?;
            Some(CwdRecovery::RepoDir { project_key, repo })
        }
        PaneKind::Director => Some(CwdRecovery::ProjectDir { project_key }),
        _ => None,
    }
}

/// A tab, as the identity rules need it. Every field is optional because the rules DISPATCH on which
/// are present — that is the whole logic, not an accident of modelling.
///
/// `pane_ids` is `Vec<Option<String>>` rather than `Vec<String>` on purpose: the TypeScript reads
/// `tab.paneIds?.[idx]`, so a HOLE at one index falls through to the positional rule while a minted id
/// at the next still wins. Collapsing it to a dense list makes the minted-wins rule all-or-nothing,
/// which passes every dense case and silently changes the sparse one.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdentityTab {
    /// The tab's stable id, when it has one (`man:<id>:p<n>` is minted from it).
    pub id: Option<String>,
    /// Present for a fleet/triage tab. Its VALUE is never read — only whether it is there.
    pub kind: Option<String>,
    /// Minted identity ids by grid index, with holes preserved.
    pub pane_ids: Vec<Option<String>>,
}

/// Resolve a pane's identity id from its tab + grid position.
///
/// The order is load-bearing and is the TypeScript's: a minted `pane_ids[idx]` wins; else a
/// `kind`-bearing (fleet/triage) tab keeps the POSITIONAL id; else a manual tab with a stable `id`
/// mints a `man:` id; else positional. `tab` is optional because the caller reads it out of app state
/// that may not have one yet, and the absent case falls through to positional like an id-less tab.
///
/// Note the second rule: a fleet tab WITHOUT mints does not get a `man:` id even when it has an `id`.
/// That looks like an oversight and is the shipping behaviour — Stage 1 fleet tabs are positional.
pub fn pane_id_for(tab: Option<&IdentityTab>, tab_idx: i64, pane_idx: i64) -> String {
    if let Some(t) = tab {
        if let Some(Some(minted)) = t.pane_ids.get(pane_idx as usize) {
            if !minted.is_empty() {
                return minted.clone();
            }
        }
        if t.kind.is_some() {
            return positional_pane_id(tab_idx, pane_idx);
        }
        if let Some(id) = t.id.as_ref().filter(|i| !i.is_empty()) {
            return manual_pane_id(id, pane_idx);
        }
    }
    positional_pane_id(tab_idx, pane_idx)
}

/// Whether `pane_id` is one of the cells `tab` (at grid index `tab_idx`) owns — the inverse of
/// [`pane_id_for`], and what a status rollup or a stale-status clear is built on.
///
/// A minted id matches when it is in `pane_ids`; a `man:<tabId>:…` id matches when the tab's stable
/// `id` matches; a legacy positional `t<idx>p…` id matches when the tab index matches. Director,
/// worker and triage ids only ever belong via `pane_ids` — parsing cannot place them, because their
/// grammar carries a project key rather than a tab.
pub fn pane_belongs_to_tab(pane_id: &str, tab: &IdentityTab, tab_idx: i64) -> bool {
    if tab.pane_ids.iter().any(|p| p.as_deref() == Some(pane_id)) {
        return true;
    }
    let Some(parsed) = parse_pane_identity(pane_id) else { return false };
    match parsed.kind {
        PaneKind::Manual => tab
            .id
            .as_ref()
            .is_some_and(|id| !id.is_empty() && parsed.tab_id.as_deref() == Some(id.as_str())),
        PaneKind::Positional => parsed.tab_idx == Some(tab_idx),
        _ => false,
    }
}

/// The tab that owns `pane_id`, with its index, or `None`.
///
/// Scans by IDENTITY rather than by parsing a positional key out of the id — the positional parse
/// could only ever resolve legacy `t<idx>p…` ids, which silently dropped every manual and minted
/// fleet/triage pane.
pub fn find_pane_owner_tab<'a>(tabs: &'a [IdentityTab], pane_id: &str) -> Option<(&'a IdentityTab, i64)> {
    tabs.iter()
        .enumerate()
        .find(|(i, t)| pane_belongs_to_tab(pane_id, t, *i as i64))
        .map(|(i, t)| (t, i as i64))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the same rule the tunnel and role-gate contracts use — so
    /// moving a feature slice does not break this, but RENAMING the fixture means updating this call
    /// in lockstep. Exactly one match is required: zero or a collision is a hard failure rather than
    /// a silent first-hit.
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

    fn s(v: &Value, k: &str) -> Option<String> {
        v.get(k).and_then(|x| x.as_str()).map(str::to_string)
    }
    fn n(v: &Value, k: &str) -> Option<i64> {
        v.get(k).and_then(|x| x.as_i64())
    }
    fn arr<'a>(v: &'a Value, path: &[&str]) -> &'a Vec<Value> {
        let mut cur = v;
        for k in path {
            cur = cur.get(k).unwrap_or_else(|| panic!("fixture is missing {path:?}"));
        }
        cur.as_array().unwrap_or_else(|| panic!("fixture {path:?} is not an array"))
    }

    /// THE POINT OF THIS MODULE: Rust must mint exactly what the renderer mints. A pane id is the key
    /// of the PTY ledger, the worktree, the sandbox user's home — an id that differs by one character
    /// is a session that cannot be found again.
    #[test]
    fn rust_mints_the_same_ids_the_typescript_does() {
        let fx = fixture();
        for c in arr(&fx, &["mints", "positional"]) {
            assert_eq!(
                positional_pane_id(n(c, "tabIdx").unwrap(), n(c, "paneIdx").unwrap()),
                s(c, "id").unwrap()
            );
        }
        for c in arr(&fx, &["mints", "manual"]) {
            assert_eq!(
                manual_pane_id(&s(c, "tabId").unwrap(), n(c, "paneIdx").unwrap()),
                s(c, "id").unwrap()
            );
        }
        for c in arr(&fx, &["mints", "fleet"]) {
            assert_eq!(
                fleet_pane_id(&s(c, "projectKey").unwrap(), &s(c, "streamId").unwrap()),
                s(c, "id").unwrap()
            );
        }
        for c in arr(&fx, &["mints", "director"]) {
            assert_eq!(director_pane_id(&s(c, "projectKey").unwrap()), s(c, "id").unwrap());
        }
        for c in arr(&fx, &["mints", "triage"]) {
            assert_eq!(
                triage_pane_id(&s(c, "projectKey").unwrap(), &s(c, "repo").unwrap()),
                s(c, "id").unwrap()
            );
        }
    }

    /// Every classifier, over ONE corpus — so "Rust agrees about this id" is a single claim rather
    /// than four lists that can drift apart.
    #[test]
    fn rust_classifies_the_same_ids_the_typescript_does() {
        let fx = fixture();
        let ids = arr(&fx, &["ids"]);
        assert!(ids.len() >= 30, "the corpus must cover the grammar: {}", ids.len());
        let mut parsed_none = 0;
        for c in ids {
            let id = s(c, "id").unwrap();
            let label = format!("id {id:?}");
            assert_eq!(is_manual_pane_id(&id), c["isManual"].as_bool().unwrap(), "isManual for {label}");
            assert_eq!(is_planning_pane_id(&id), c["isPlanning"].as_bool().unwrap(), "isPlanning for {label}");
            assert_eq!(pane_needs_gate(&id), c["needsGate"].as_bool().unwrap(), "needsGate for {label}");

            let got = parse_pane_identity(&id);
            let want = &c["parsed"];
            if want.is_null() {
                parsed_none += 1;
                assert!(got.is_none(), "expected no parse for {label}, got {got:?}");
                continue;
            }
            let got = got.unwrap_or_else(|| panic!("expected a parse for {label}"));
            assert_eq!(got.kind.as_str(), want["kind"].as_str().unwrap(), "kind for {label}");
            assert_eq!(Some(got.raw.clone()), s(want, "raw"), "raw for {label}");
            assert_eq!(got.project_key, s(want, "projectKey"), "projectKey for {label}");
            assert_eq!(got.stream_id, s(want, "streamId"), "streamId for {label}");
            assert_eq!(got.repo, s(want, "repo"), "repo for {label}");
            assert_eq!(got.tab_id, s(want, "tabId"), "tabId for {label}");
            assert_eq!(got.pane_idx, n(want, "paneIdx"), "paneIdx for {label}");
            assert_eq!(got.tab_idx, n(want, "tabIdx"), "tabIdx for {label}");
        }
        assert!(parsed_none >= 7, "only {parsed_none} unparseable ids — the rejections are half the grammar");
    }

    /// The two derivations that read the grammar. `sandboxUserIdentity` decides whether a pane gets
    /// its own Linux user and `700` home, so a port that widened it would put an agent's files where
    /// another agent can read them.
    #[test]
    fn rust_derives_the_same_sandbox_user_and_cwd_recovery() {
        let fx = fixture();
        for c in arr(&fx, &["sandbox"]) {
            let id = s(c, "id").unwrap();
            let distro = s(c, "distro");
            let got = sandbox_user_identity(&id, distro.as_deref());
            assert_eq!(got, s(c, "user"), "sandbox user for {id:?} distro={distro:?}");
        }
        for c in arr(&fx, &["ids"]) {
            let id = s(c, "id").unwrap();
            let want = &c["cwdRecovery"];
            match pane_cwd_recovery(&id) {
                None => assert!(want.is_null(), "expected a recovery for {id:?}: {want}"),
                Some(CwdRecovery::RepoDir { project_key, repo }) => {
                    assert_eq!(want["cmd"].as_str(), Some("repo_dir_path"), "cmd for {id:?}");
                    assert_eq!(Some(project_key), s(&want["args"], "projectKey"), "projectKey for {id:?}");
                    assert_eq!(Some(repo), s(&want["args"], "repo"), "repo for {id:?}");
                }
                Some(CwdRecovery::ProjectDir { project_key }) => {
                    assert_eq!(want["cmd"].as_str(), Some("project_dir_path"), "cmd for {id:?}");
                    assert_eq!(Some(project_key), s(&want["args"], "projectKey"), "projectKey for {id:?}");
                }
            }
        }
    }

    /// The corpus must actually reach every branch, or the parity assertions above are vacuous for
    /// the kinds it happens to miss.
    #[test]
    fn the_corpus_reaches_every_kind_and_both_recovery_commands() {
        let fx = fixture();
        let mut kinds: Vec<String> = arr(&fx, &["ids"])
            .iter()
            .filter_map(|c| c["parsed"].get("kind").and_then(|k| k.as_str()).map(str::to_string))
            .collect();
        kinds.sort();
        kinds.dedup();
        assert_eq!(kinds, ["director", "manual", "positional", "triage", "worker"]);

        let mut cmds: Vec<String> = arr(&fx, &["ids"])
            .iter()
            .filter_map(|c| c["cwdRecovery"].get("cmd").and_then(|k| k.as_str()).map(str::to_string))
            .collect();
        cmds.sort();
        cmds.dedup();
        assert_eq!(cmds, ["project_dir_path", "repo_dir_path"]);
    }

    // ---------------------------------------------------------------------------------------------
    // Properties the fixture cannot state, because they are about the grammar's SHAPE rather than
    // about one captured answer.
    // ---------------------------------------------------------------------------------------------

    /// Minting and reading must be inverses for every well-formed id, which no single fixture row
    /// says: each row pins one direction.
    #[test]
    fn every_minted_id_reads_back_as_what_minted_it() {
        for (key, stream) in [("studio-code", "api"), ("a", "b-c"), ("k", "stream/with/slash")] {
            let p = parse_pane_identity(&fleet_pane_id(key, stream)).expect("worker");
            assert_eq!(p.kind, PaneKind::Worker);
            assert_eq!(p.project_key.as_deref(), Some(key));
            assert_eq!(p.stream_id.as_deref(), Some(stream));
        }
        for key in ["studio-code", "a"] {
            let p = parse_pane_identity(&director_pane_id(key)).expect("director");
            assert_eq!(p.kind, PaneKind::Director);
            assert_eq!(p.project_key.as_deref(), Some(key));
        }
        for (key, repo) in [("studio-code", "owner/name"), ("a", "r")] {
            let p = parse_pane_identity(&triage_pane_id(key, repo)).expect("triage");
            assert_eq!(p.kind, PaneKind::Triage);
            assert_eq!(p.project_key.as_deref(), Some(key));
            assert_eq!(p.repo.as_deref(), Some(repo));
        }
        for (tab, idx) in [("tab_abc", 2i64), ("tab-with-dashes", 0)] {
            let p = parse_pane_identity(&manual_pane_id(tab, idx)).expect("manual");
            assert_eq!(p.kind, PaneKind::Manual);
            assert_eq!(p.tab_id.as_deref(), Some(tab));
            assert_eq!(p.pane_idx, Some(idx));
        }
        for (t, pn) in [(0i64, 0i64), (12, 3)] {
            let p = parse_pane_identity(&positional_pane_id(t, pn)).expect("positional");
            assert_eq!(p.kind, PaneKind::Positional);
            assert_eq!((p.tab_idx, p.pane_idx), (Some(t), Some(pn)));
        }
    }

    /// The manual shape is `man:<tabId>:p<digits>`, and the two things a port gets wrong are the
    /// DIGIT CHECK and the non-empty tab id. A naive `find(":p")` reads `man:a:p1:p2` as tab `a`,
    /// silently re-homing a pane's state onto a different tab; both mistakes were introduced
    /// deliberately and both fail here.
    ///
    /// Note what is NOT asserted: greediness. It is unobservable in this grammar — see
    /// [`parse_manual`]'s doc comment — and a non-greedy port passes every test in this module. That
    /// is stated as measured fact, not inferred.
    #[test]
    fn the_manual_tab_id_runs_to_the_pane_suffix_that_is_all_digits() {
        let p = parse_pane_identity("man:a:p1:p2").expect("manual");
        assert_eq!(p.tab_id.as_deref(), Some("a:p1"), "`:p1:p2` is not a tail — its digits run out");
        assert_eq!(p.pane_idx, Some(2));
        // `(.+)` needs at least one character, so an EMPTY tab id is not the manual shape — and it
        // does not become `None` either: it falls through to the WORKER rule with "man" read as a
        // project key. The fixture carries this; it is asserted here because the fall-through is a
        // property of rule ORDER, which no single captured row states.
        let fallen = parse_pane_identity("man::p0").expect("falls through, rather than failing");
        assert_eq!(fallen.kind, PaneKind::Worker);
        assert_eq!(fallen.project_key.as_deref(), Some("man"));
        assert_eq!(fallen.stream_id.as_deref(), Some(":p0"));
    }

    /// Three rules, one id, three different answers — and all three are shipping behaviour. A port
    /// that expressed any of them in terms of another would quietly move a security boundary.
    #[test]
    fn the_classifiers_are_allowed_to_disagree_about_one_id() {
        // `man:tab:p` has no digits, so it is NOT the manual shape — it parses as a worker whose
        // project key is `man` — while the prefix check still calls it manual.
        assert!(is_manual_pane_id("man:tab:p"));
        assert_eq!(parse_pane_identity("man:tab:p").map(|p| p.kind), Some(PaneKind::Worker));
        assert!(!pane_needs_gate("man:tab:p"));
        // `<key>::` parses as a worker whose stream is a bare colon, and needs no gate.
        assert_eq!(parse_pane_identity("studio-code::").map(|p| p.kind), Some(PaneKind::Worker));
        assert!(!pane_needs_gate("studio-code::"));
    }
}
