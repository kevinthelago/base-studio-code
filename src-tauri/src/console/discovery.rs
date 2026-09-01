//! Session discovery (#1266, Stage 2): reconstruct the *live* session topology from durable,
//! store-independent sources so a session can be recovered from its NAME alone — even when the
//! persisted (Zustand) store has lost the entry.
//!
//! Recovery surfaces ONLY LIVE sessions — the **pty ledger** (`pty_ledger`) records every running
//! session's identity pane id + pid; it's cleared on a clean quit, so it reflects exactly the
//! live/orphaned processes a crash left behind (the recovery case, #1041). It is NOT reconstructed
//! from on-disk project hubs: a never-launched plan or a launched-but-stopped fleet is not a
//! recoverable session, and surfacing every saved project floods the banner (#1390).
//!
//! The **project hubs + plan.db fleets** are still read — but ONLY to enrich a live session with its
//! `project_key` / `repo` / `cwd` (where to reopen it), never to create a recoverable entry.
//!
//! The result is read-only: the frontend reconciles it against the store and lets the user decide
//! what to restore (#1266 Stages 3–4). Manual `man:…` panes surface (from the ledger) but are
//! never auto-restored.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use crate::worktree_dir_name;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    /// The identity pane id, e.g. `proj:auth-ui`, `proj:director`, `proj:owner/web:triage`, `man:…`.
    pub pane_id: String,
    /// Where it was found: any of "ledger", "fleet", "worktree" (sorted, deduped).
    pub sources: Vec<String>,
    /// The live shell pid, when a running process currently owns this pane.
    pub live_pid: Option<u32>,
    /// "running" (a live pid) · "dormant" (on disk, not running) · "planned" (in the plan.db fleet,
    /// never launched) · "orphaned" (a live pid whose project was deleted — no hub, no known
    /// project; unrestorable, so recovery reaps it rather than opening a console for it, #1279).
    pub status: String,
    /// The owning project key, when derivable from a hub. (The frontend re-parses `pane_id` authoritatively.)
    pub project_key: Option<String>,
    /// The repo a worker/triage session works in, when known.
    pub repo: Option<String>,
    /// A cwd to reopen the session at — the worktree dir for a worker, the hub for the director.
    pub cwd: Option<String>,
}

const RUNNING: &str = "running";
const DORMANT: &str = "dormant";
const PLANNED: &str = "planned";
const ORPHANED: &str = "orphaned";

/// Whether a live ledger pane id is an **orphan of a deleted project** (#1279): a project-keyed
/// session (`<key>:…`, not a manual/positional id) whose project no longer exists — its hub dir is
/// gone **and** its key maps to no known plan.db fleet. Such a shell can't be restored (nothing to
/// rehydrate) nor attributed (the key resolves to no project), so recovery must reap it.
fn is_orphaned(
    pane_id: &str,
    base_dir: &Path,
    fleet_for: &dyn Fn(&str) -> Option<serde_json::Value>,
) -> bool {
    let Some(key) = crate::console::ledger::project_key_of(pane_id) else {
        return false; // manual / positional panes are never project orphans
    };
    let hub_gone = !base_dir.join("projects").join(key).is_dir();
    hub_gone && fleet_for(key).is_none()
}

fn push_source(sources: &mut Vec<String>, s: &str) {
    if !sources.iter().any(|x| x == s) {
        sources.push(s.to_string());
        sources.sort();
    }
}

/// Pure discovery: given the base dir, the ledger entries (`pane_id`, `pid`), and a liveness probe,
/// build the deduped session list. Split out from the Tauri command so it can be tested over a
/// fixture filesystem with a fake ledger + liveness closure.
pub fn discover_sessions_impl(
    base_dir: &Path,
    ledger: &[(String, u32)],
    alive: &dyn Fn(u32) -> bool,
    fleet_for: &dyn Fn(&str) -> Option<serde_json::Value>,
) -> Vec<DiscoveredSession> {
    let mut map: BTreeMap<String, DiscoveredSession> = BTreeMap::new();

    // 1) Ledger pass — every RUNNING session (any kind), keyed by its exact identity id. A stale
    //    entry whose pid is dead is skipped (boot reconcile reaps those; they aren't recoverable).
    for (pane_id, pid) in ledger {
        if !alive(*pid) {
            continue;
        }
        let d = map.entry(pane_id.clone()).or_insert_with(|| blank(pane_id));
        push_source(&mut d.sources, "ledger");
        d.live_pid = Some(*pid);
        // A live shell whose project was deleted (no hub, no known fleet) is an orphan, not a
        // restorable running session — recovery reaps it (#1279). Everything else is running.
        d.status = if is_orphaned(pane_id, base_dir, fleet_for) { ORPHANED } else { RUNNING }.into();
    }

    // 2) Hub pass — dormant/planned director + workers from each project's plan.db fleet + worktrees.
    if let Ok(rd) = std::fs::read_dir(base_dir.join("projects")) {
        for entry in rd.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let key = entry.file_name().to_string_lossy().to_string();
                discover_hub(base_dir, &key, &mut map, fleet_for);
            }
        }
    }

    // Recovery surfaces only LIVE sessions — `running`, or `orphaned` (a live shell whose project was
    // deleted). The hub pass above runs purely to ENRICH those with their project_key/repo/cwd; a
    // session that exists ONLY on disk (a never-launched `planned` fleet, or a launched-but-stopped
    // `dormant` one) is NOT recoverable and must not surface — otherwise recovery floods with every
    // saved project (#1390). A clean quit clears the ledger, so there is correctly nothing to recover
    // then; recovery is the crash/orphan case (#1041).
    map.into_values().filter(|d| d.live_pid.is_some()).collect()
}

fn blank(pane_id: &str) -> DiscoveredSession {
    DiscoveredSession {
        pane_id: pane_id.to_string(),
        sources: Vec::new(),
        live_pid: None,
        status: PLANNED.into(),
        project_key: None,
        repo: None,
        cwd: None,
    }
}

fn discover_hub(
    base_dir: &Path,
    key: &str,
    map: &mut BTreeMap<String, DiscoveredSession>,
    fleet_for: &dyn Fn(&str) -> Option<serde_json::Value>,
) {
    let v = match fleet_for(key) {
        Some(v) => v,
        None => return,
    };
    let hub = base_dir.join("projects").join(key);
    let wts = base_dir.join("worktrees").join(key);
    // The fleet was launched at least once iff any worktree exists — the director's "was it run?"
    // signal (the director runs at the hub, so it has no worktree of its own).
    let fleet_launched = std::fs::read_dir(&wts).map(|mut rd| rd.next().is_some()).unwrap_or(false);

    if v.get("director").and_then(|d| d.get("enabled")).and_then(|b| b.as_bool()).unwrap_or(false) {
        upsert(map, &format!("{key}:director"), Some(key.to_string()), None,
               Some(hub.to_string_lossy().to_string()), fleet_launched, false);
    }

    if let Some(streams) = v.get("streams").and_then(|s| s.as_array()) {
        for s in streams {
            let Some(id) = s.get("id").and_then(|x| x.as_str()) else { continue };
            let repo = s.get("repo").and_then(|x| x.as_str()).unwrap_or("");
            let wt = wts.join(worktree_dir_name(repo, id));
            let on_disk = wt.exists();
            let cwd = on_disk.then(|| wt.to_string_lossy().to_string());
            upsert(map, &format!("{key}:{id}"), Some(key.to_string()),
                   (!repo.is_empty()).then(|| repo.to_string()), cwd, on_disk, on_disk);
        }
    }
}

/// Merge a hub-discovered session into the map without clobbering a running (ledger) hit. Always
/// records `fleet` as a source (it came from the plan.db fleet); adds `worktree` when its checkout exists.
fn upsert(
    map: &mut BTreeMap<String, DiscoveredSession>,
    pane_id: &str,
    project_key: Option<String>,
    repo: Option<String>,
    cwd: Option<String>,
    dormant: bool,
    has_worktree: bool,
) {
    let d = map.entry(pane_id.to_string()).or_insert_with(|| blank(pane_id));
    push_source(&mut d.sources, "fleet");
    if has_worktree {
        push_source(&mut d.sources, "worktree");
    }
    if d.project_key.is_none() {
        d.project_key = project_key;
    }
    if d.repo.is_none() {
        d.repo = repo;
    }
    if d.cwd.is_none() {
        d.cwd = cwd;
    }
    // A running (ledger) hit already set the status + live_pid — don't downgrade it.
    if d.live_pid.is_none() {
        d.status = if dormant { DORMANT } else { PLANNED }.into();
    }
}

/// Discover every store-independent session on disk + in the ledger (#1266). Read-only: the
/// frontend reconciles this against the open tabs and lets the user choose what to restore.
#[tauri::command]
pub fn discover_sessions() -> Vec<DiscoveredSession> {
    let ledger: Vec<(String, u32)> = crate::console::ledger::ledger_entries()
        .into_iter()
        .map(|e| (e.pane_id, e.pid))
        .collect();
    discover_sessions_impl(
        &crate::bsc_base_dir(),
        &ledger,
        &|pid| crate::console::ledger::is_pid_alive(pid),
        &|key| crate::project::plan_db::fleet_for(key),
    )
}

/// Discard ONE discovered session by its identity pane id (#1266 Stage 4): tree-kill its still-running
/// shell (if any) and forget its ledger entry, so an orphaned/unwanted session is gone. Read-only as
/// to the user's work on disk — it only reaps the live process + the ledger record, never the worktree
/// or branch. Returns true if a live shell was killed. The reconcile is recomputed by the caller.
#[tauri::command]
pub fn reap_session(pane_id: String) -> bool {
    crate::console::ledger::reap_session(&pane_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_base() -> PathBuf {
        let pid = std::process::id();
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        std::env::temp_dir().join(format!("bsc-discovery-{pid}-{nanos}"))
    }

    fn find<'a>(v: &'a [DiscoveredSession], id: &str) -> Option<&'a DiscoveredSession> {
        v.iter().find(|d| d.pane_id == id)
    }

    /// A hub with director + two workers; one worker launched (worktree exists), one only planned.
    /// The fleet itself is served via the `fleet_for` closure (plan.db), not a file on disk.
    fn fleet_json() -> serde_json::Value {
        serde_json::json!({
            "recommended": 2, "reasoning": "",
            "director": { "enabled": true, "role": "integrator" },
            "streams": [
                { "id": "auth-ui", "name": "Auth UI", "repo": "own/web", "owns": [], "issues": [], "dependsOn": [] },
                { "id": "api", "name": "API", "repo": "own/api", "owns": [], "issues": [], "dependsOn": [] }
            ]
        })
    }

    /// The hub dir must exist so the hub-pass enumerates "proj"; auth-ui has a worktree (launched),
    /// api does not (planned). No `fleet.json` — the fleet comes from the closure.
    fn prepare_disk(base: &Path) {
        fs::create_dir_all(base.join("projects").join("proj")).unwrap();
        fs::create_dir_all(base.join("worktrees").join("proj").join("web--auth-ui")).unwrap();
    }

    #[test]
    fn surfaces_only_live_sessions_enriched_from_the_hub() {
        // #1390: recovery returns ONLY live (running/orphaned) sessions. A dormant fleet (launched,
        // worktree on disk, not running) and a planned one (in the fleet, never launched) must NOT
        // surface — they only exist on disk. The hub pass still ENRICHES the live ones.
        let base = tmp_base();
        prepare_disk(&base);
        let mut fleets = std::collections::HashMap::new();
        fleets.insert("proj".to_string(), fleet_json());
        let fleet_for = |k: &str| fleets.get(k).cloned();

        // Ledger: the director is running (pid 100); a manual scratch is running (pid 200);
        // a stale api entry (pid 999) is dead.
        let ledger = vec![
            ("proj:director".to_string(), 100u32),
            ("man:scratch:p0".to_string(), 200u32),
            ("proj:api".to_string(), 999u32),
        ];
        let alive = |pid: u32| pid == 100 || pid == 200;

        let out = discover_sessions_impl(&base, &ledger, &alive, &fleet_for);

        // Director: running (live), STILL enriched with the hub cwd + project key from the plan.db fleet.
        let dir = find(&out, "proj:director").expect("running director surfaces");
        assert_eq!(dir.status, "running");
        assert_eq!(dir.live_pid, Some(100));
        assert_eq!(dir.project_key.as_deref(), Some("proj"));
        assert_eq!(dir.sources, vec!["fleet".to_string(), "ledger".to_string()]);

        // The manual scratch surfaces from the ledger (the frontend marks it reap-only).
        let man = find(&out, "man:scratch:p0").expect("running manual surfaces");
        assert_eq!(man.status, "running");
        assert_eq!(man.live_pid, Some(200));

        // auth-ui (dormant: worktree on disk, no live pid) and api (planned: in the fleet, dead pid)
        // are disk-only — NOT recoverable, so they DON'T surface anymore.
        assert!(find(&out, "proj:auth-ui").is_none(), "a dormant fleet session must not surface");
        assert!(find(&out, "proj:api").is_none(), "a planned fleet session must not surface");
        assert_eq!(out.len(), 2, "only the two LIVE sessions surface");

        let _ = fs::remove_dir_all(&base);
    }

    /// #1279: a live ledger entry whose project was deleted — no `projects/<key>/` hub AND the key
    /// maps to no plan.db fleet — is classified `orphaned`, never `running`. Recovery reaps it
    /// rather than trying (and failing) to restore an unrestorable session.
    #[test]
    fn forgotten_key_ledger_entry_is_orphaned_not_running() {
        let base = tmp_base();
        // Only one live hub ("proj"); the deleted project "gone" has NO hub dir and NO fleet.
        fs::create_dir_all(base.join("projects").join("proj")).unwrap();
        let mut fleets = std::collections::HashMap::new();
        fleets.insert("proj".to_string(), fleet_json());
        let fleet_for = |k: &str| fleets.get(k).cloned();

        let ledger = vec![
            ("proj:director".to_string(), 100u32), // live, hub present → running
            ("gone:auth-ui".to_string(), 300u32),  // live, project deleted → orphaned
            ("man:scratch:p0".to_string(), 200u32), // manual scratch → running (reap-only via frontend)
        ];
        let alive = |_: u32| true;

        let out = discover_sessions_impl(&base, &ledger, &alive, &fleet_for);

        let orphan = find(&out, "gone:auth-ui").expect("forgotten-key entry surfaces");
        assert_eq!(orphan.status, "orphaned");
        assert_eq!(orphan.live_pid, Some(300));
        assert_eq!(orphan.sources, vec!["ledger".to_string()]);
        // It is NOT enriched from any hub (there is none) — no project key/cwd to attribute it to.
        assert_eq!(orphan.project_key, None);

        // A live session with a real hub is still plain "running".
        assert_eq!(find(&out, "proj:director").unwrap().status, "running");
        // A manual scratch shell is never a project orphan.
        assert_eq!(find(&out, "man:scratch:p0").unwrap().status, "running");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_when_nothing_on_disk_or_alive() {
        let base = tmp_base();
        fs::create_dir_all(base.join("projects")).unwrap();
        let out = discover_sessions_impl(&base, &[("proj:director".into(), 1)], &|_| false, &|_| None);
        assert!(out.is_empty(), "no live ledger entries + no hubs ⇒ nothing discovered");
        let _ = fs::remove_dir_all(&base);
    }
}

// ── Reconcile (#1266 S3) — ported from `src/app/console/lib/sessionRecovery.ts` ──────────────────
//
// The scan above finds sessions from durable sources; the reconcile decides which of them the store
// has LOST. That decision used to live in the renderer, over a list this file produces — the inversion
// `epic-frontend-logic-over-backend-resources-belongs-in-rust` exists to close. Proved against
// `src/app/console/sessionRecovery.fixtures.json`, generated from the TypeScript it replaces.

/// A tab, as the reconcile needs it: enough to resolve which pane ids it currently shows.
// No non-test caller until the banner is flipped, which is deliberately its own item — a flip inside a
// derivation slice hides which of the two changed the behaviour. The ref is a REAL open item, checked
// with `bsc plan get`, because a dangling `wired by` is invisible to every gate.
#[allow(dead_code)] // wired by `the-recovery-banner-reads-the-rust-reconcile`
#[derive(Debug, Clone, Default)]
pub struct ReconcileTab {
    pub id: Option<String>,
    pub kind: Option<String>,
    pub pane_ids: Vec<Option<String>>,
    pub layout: Option<String>,
}

/// A discovered session the store cannot account for, with what to do about it.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)] // wired by `the-recovery-banner-reads-the-rust-reconcile`
pub struct RecoverableSession {
    /// Every field of the discovered session, flattened — a recoverable session IS a discovered one
    /// plus a verdict, and re-listing the fields here is how one silently goes missing.
    #[serde(flatten)]
    pub session: DiscoveredSession,
    /// The parsed identity kind, or `unknown` when the id does not parse.
    pub kind: String,
    /// Killed, never restored: a manual scratch shell, or an `orphaned` shell of a deleted project.
    pub reap_only: bool,
}

/// Number of grid cells a tab renders.
///
/// DELIBERATELY NOT [`bsc_util::pane_status::pane_count_for_layout`], which answers the same question
/// differently and would silently change which panes count as open. Three differences, all pinned by
/// the fixture: this prefers `pane_ids.len()` over the layout entirely; its grammar accepts an ASCII
/// `x` and surrounding spaces; and `2×0` is ZERO cells here (the parse succeeds and multiplies) where
/// the other reads the zero as falsy and answers two.
#[allow(dead_code)] // wired by `the-recovery-banner-reads-the-rust-reconcile`
fn reconcile_cell_count(tab: &ReconcileTab) -> i64 {
    if !tab.pane_ids.is_empty() {
        return tab.pane_ids.len() as i64;
    }
    let raw = tab.layout.as_deref().unwrap_or("");
    let sep = raw.find(['×', 'x']);
    let Some(sep) = sep else { return 1 };
    let (a, b) = raw.split_at(sep);
    let b = &b[raw[sep..].chars().next().map(char::len_utf8).unwrap_or(1)..];
    let (a, b) = (a.trim(), b.trim());
    // The TypeScript regex is `^(\d+)\s*[×x]\s*(\d+)$` — digits only, both sides, nothing else.
    if a.is_empty() || b.is_empty() || !a.bytes().all(|c| c.is_ascii_digit()) || !b.bytes().all(|c| c.is_ascii_digit()) {
        return 1;
    }
    match (a.parse::<i64>(), b.parse::<i64>()) {
        (Ok(c), Ok(r)) => c * r,
        _ => 1,
    }
}

/// Every pane id currently open across all tabs — each cell's resolved identity id.
#[allow(dead_code)] // wired by `the-recovery-banner-reads-the-rust-reconcile`
pub fn open_pane_ids(tabs: &[ReconcileTab]) -> std::collections::BTreeSet<String> {
    let mut out = std::collections::BTreeSet::new();
    for (tab_idx, tab) in tabs.iter().enumerate() {
        let identity = bsc_util::pane_id::IdentityTab {
            id: tab.id.clone(),
            kind: tab.kind.clone(),
            pane_ids: tab.pane_ids.clone(),
        };
        for p in 0..reconcile_cell_count(tab) {
            out.insert(bsc_util::pane_id::pane_id_for(Some(&identity), tab_idx as i64, p));
        }
    }
    out
}

/// Keep only the discovered sessions NOT represented by an open pane, each with its parsed kind and a
/// reap-only flag.
///
/// FOUR EXCLUSIONS, each for its own reason and each separately pinned:
///   * already OPEN — the store has it, so nothing was lost;
///   * the PLANNER (`planning_<key>`) — re-entered from the Projects page, not the recovery banner;
///   * an app-owned STUDIO session — its id shares the `<key>:<tail>` worker grammar, so without this
///     it would be surfaced as a restorable worker; it is a singleton re-created with its workspace.
///     Membership, never a prefix test: `debug-studio:debugger` is one and `debug-studio:req-4212` is
///     not;
///   * reap-only — a manual scratch shell or an `orphaned` shell of a deleted project is killed rather
///     than restored. That is a FLAG, not an exclusion: it still reaches the user.
#[allow(dead_code)] // wired by `the-recovery-banner-reads-the-rust-reconcile`
pub fn reconcile_sessions(
    discovered: &[DiscoveredSession],
    tabs: &[ReconcileTab],
    studio_pane_ids: &[String],
) -> Vec<RecoverableSession> {
    let open = open_pane_ids(tabs);
    discovered
        .iter()
        .filter(|d| {
            !open.contains(&d.pane_id)
                && !bsc_util::pane_id::is_planning_pane_id(&d.pane_id)
                && !crate::session::fresh_only::is_studio_session_pane_id(&d.pane_id, studio_pane_ids)
        })
        .map(|d| {
            let kind = bsc_util::pane_id::parse_pane_identity(&d.pane_id)
                .map(|p| p.kind.as_str().to_string())
                .unwrap_or_else(|| "unknown".to_string());
            let reap_only = kind == "manual" || d.status == "orphaned";
            RecoverableSession { session: d.clone(), kind, reap_only }
        })
        .collect()
}

#[cfg(test)]
mod reconcile_tests {
    use super::*;
    use serde_json::Value;

    /// The generated contract, resolved BY FILENAME under `src/` — the rule the pane-identity, tunnel
    /// and role-gate fixtures already use. Exactly one match; zero or a collision fails hard.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("sessionRecovery.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one sessionRecovery.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    fn tab_of(v: &Value) -> ReconcileTab {
        ReconcileTab {
            id: v.get("id").and_then(Value::as_str).map(str::to_string),
            kind: v.get("kind").and_then(Value::as_str).map(str::to_string),
            // A JSON `null` inside paneIds is a HOLE and must stay one — collapsing it makes the
            // minted-wins rule all-or-nothing.
            pane_ids: v
                .get("paneIds")
                .and_then(Value::as_array)
                .map(|a| a.iter().map(|x| x.as_str().map(str::to_string)).collect())
                .unwrap_or_default(),
            layout: v.get("layout").and_then(Value::as_str).map(str::to_string),
        }
    }

    fn session_of(v: &Value) -> DiscoveredSession {
        DiscoveredSession {
            pane_id: v["paneId"].as_str().expect("paneId").to_string(),
            sources: v["sources"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
            live_pid: v.get("livePid").and_then(Value::as_u64).map(|n| n as u32),
            status: v["status"].as_str().unwrap_or_default().to_string(),
            project_key: v.get("projectKey").and_then(Value::as_str).map(str::to_string),
            repo: v.get("repo").and_then(Value::as_str).map(str::to_string),
            cwd: v.get("cwd").and_then(Value::as_str).map(str::to_string),
        }
    }

    /// The studio ids the fixture's cases rely on. Taken from the REAL registry rather than written
    /// out, so a studio added on one side cannot leave this corpus describing a world that is gone.
    fn studio_ids() -> Vec<String> {
        crate::session::fresh_only::studio_pane_ids()
    }

    /// Reports every mismatch at once — a wrong port is wrong in a pattern.
    #[test]
    fn the_reconcile_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let studios = studio_ids();
        let mut bad: Vec<String> = Vec::new();

        for c in doc["openIds"].as_array().expect("openIds") {
            let tabs: Vec<ReconcileTab> = c["tabs"].as_array().unwrap().iter().map(tab_of).collect();
            let got: Vec<String> = open_pane_ids(&tabs).into_iter().collect();
            let want: Vec<String> = c["open"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
            if got != want {
                bad.push(format!("  open {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        for c in doc["reconcile"].as_array().expect("reconcile") {
            let label = c["label"].as_str().unwrap();
            let tabs_label = c["tabsLabel"].as_str().unwrap();
            let tabs: Vec<ReconcileTab> = doc["openIds"]
                .as_array()
                .unwrap()
                .iter()
                .find(|o| o["label"].as_str() == Some(tabs_label))
                .unwrap_or_else(|| panic!("no tabs labelled {tabs_label:?}"))["tabs"]
                .as_array()
                .unwrap()
                .iter()
                .map(tab_of)
                .collect();
            let discovered: Vec<DiscoveredSession> = c["discovered"].as_array().unwrap().iter().map(session_of).collect();
            let got = reconcile_sessions(&discovered, &tabs, &studios);
            // WHOLE RECORDS, in order, compared through the SAME serialization the frontend receives —
            // so a dropped or renamed field is a mismatch rather than an invisible loss.
            let got_json = serde_json::to_value(&got).unwrap();
            let want_json = c["recoverable"].clone();
            if got_json != want_json {
                bad.push(format!("  reconcile {label:?}\n    ts   {want_json}\n    rust {got_json}"));
            }
        }

        assert!(bad.is_empty(), "the Rust reconcile disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// `reconcile_cell_count` is NOT `pane_count_for_layout`, and the difference decides which panes
    /// count as open. Asserted side by side so a future tidy cannot merge them.
    #[test]
    fn the_cell_count_deliberately_differs_from_the_status_rollups() {
        let zero = ReconcileTab { layout: Some("2×0".into()), ..Default::default() };
        assert_eq!(reconcile_cell_count(&zero), 0, "the regex matches and multiplies");
        assert_eq!(bsc_util::pane_status::pane_count_for_layout("2×0"), 2, "…while the rollup reads the zero as falsy");

        let ascii = ReconcileTab { layout: Some("2x2".into()), ..Default::default() };
        assert_eq!(reconcile_cell_count(&ascii), 4, "an ASCII x is accepted here");
        assert_eq!(bsc_util::pane_status::pane_count_for_layout("2x2"), 1, "…and not there");

        let spaced = ReconcileTab { layout: Some("2 × 1".into()), ..Default::default() };
        assert_eq!(reconcile_cell_count(&spaced), 2);

        // Mints win over the layout entirely — a 3×3 tab with two minted ids has two cells.
        let minted = ReconcileTab {
            layout: Some("3×3".into()),
            pane_ids: vec![Some("a".into()), Some("b".into())],
            ..Default::default()
        };
        assert_eq!(reconcile_cell_count(&minted), 2);
    }

    /// A studio id is MEMBERSHIP, not a prefix — the distinction that keeps per-request debug panes
    /// recoverable while the debugger singleton is not.
    #[test]
    fn a_debug_request_pane_is_recoverable_but_the_debugger_singleton_is_not() {
        let studios = studio_ids();
        let d = |id: &str| DiscoveredSession {
            pane_id: id.into(),
            sources: vec!["ledger".into()],
            live_pid: None,
            status: "stale".into(),
            project_key: None,
            repo: None,
            cwd: None,
        };
        let out = reconcile_sessions(&[d("debug-studio:debugger"), d("debug-studio:req-4212")], &[], &studios);
        assert_eq!(out.len(), 1, "only the singleton is dropped");
        assert_eq!(out[0].session.pane_id, "debug-studio:req-4212");
    }

    /// Reap-only is a FLAG, not an exclusion: the session still reaches the user, marked kill-not-restore.
    #[test]
    fn reap_only_sessions_are_still_surfaced() {
        let studios = studio_ids();
        let mk = |id: &str, status: &str| DiscoveredSession {
            pane_id: id.into(),
            sources: vec!["ledger".into()],
            live_pid: None,
            status: status.into(),
            project_key: None,
            repo: None,
            cwd: None,
        };
        let out = reconcile_sessions(&[mk("man:gone:p0", "stale"), mk("k:s", "orphaned"), mk("k:s2", "stale")], &[], &studios);
        assert_eq!(out.len(), 3, "all three are surfaced");
        assert_eq!(out.iter().filter(|r| r.reap_only).count(), 2);
    }
}
