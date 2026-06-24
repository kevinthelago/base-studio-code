//! Session discovery (#1266, Stage 2): reconstruct the session topology from durable,
//! store-independent sources so a session can be recovered from its NAME alone — even when the
//! persisted (Zustand) store has lost the entry.
//!
//! Two sources, with different lifetimes:
//!   * the **pty ledger** (`pty_ledger`) — every *running* session's exact identity pane id + pid.
//!     Cleared on a clean quit, so it reflects live/orphaned processes (the crash case).
//!   * the **project hubs + worktrees** — each `projects/<key>/fleet.json` (the planned director +
//!     workers) cross-referenced with `worktrees/<key>/<repo>--<slug>/` existence. Durable across
//!     clean exits → *dormant* fleet sessions that aren't currently running.
//!
//! The result is read-only: the frontend reconciles it against the store and lets the user decide
//! what to restore (#1266 Stages 3–4). Manual `man:…` panes surface (from the ledger) but are
//! never auto-restored.

use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSession {
    /// The identity pane id, e.g. `proj:auth-ui`, `proj:director`, `proj:owner/web:triage`, `man:…`.
    pub pane_id: String,
    /// Where it was found: any of "ledger", "fleet", "worktree" (sorted, deduped).
    pub sources: Vec<String>,
    /// The live shell pid, when a running process currently owns this pane.
    pub live_pid: Option<u32>,
    /// "running" (a live pid) · "dormant" (on disk, not running) · "planned" (in fleet.json, never launched).
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

/// Mirror of the frontend `worktreeSlug` / Rust `worktree_slug`: keep only `[A-Za-z0-9._-]`.
fn worktree_slug(agent_id: &str) -> String {
    agent_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '-' })
        .collect()
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
        d.status = RUNNING.into();
    }

    // 2) Hub pass — dormant/planned director + workers from each project's fleet.json + worktrees.
    if let Ok(rd) = std::fs::read_dir(base_dir.join("projects")) {
        for entry in rd.flatten() {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                let key = entry.file_name().to_string_lossy().to_string();
                discover_hub(base_dir, &key, &mut map);
            }
        }
    }

    map.into_values().collect()
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

fn discover_hub(base_dir: &Path, key: &str, map: &mut BTreeMap<String, DiscoveredSession>) {
    let raw = match std::fs::read_to_string(base_dir.join("projects").join(key).join("fleet.json")) {
        Ok(s) => s,
        Err(_) => return,
    };
    let v: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return,
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
            let short = repo.rsplit('/').next().unwrap_or(repo);
            let wt = wts.join(format!("{short}--{}", worktree_slug(id)));
            let on_disk = wt.exists();
            let cwd = on_disk.then(|| wt.to_string_lossy().to_string());
            upsert(map, &format!("{key}:{id}"), Some(key.to_string()),
                   (!repo.is_empty()).then(|| repo.to_string()), cwd, on_disk, on_disk);
        }
    }
}

/// Merge a hub-discovered session into the map without clobbering a running (ledger) hit. Always
/// records `fleet` as a source (it came from fleet.json); adds `worktree` when its checkout exists.
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
    let ledger: Vec<(String, u32)> = crate::pty_ledger::ledger_entries()
        .into_iter()
        .map(|e| (e.pane_id, e.pid))
        .collect();
    discover_sessions_impl(&crate::bsc_base_dir(), &ledger, &|pid| crate::pty_ledger::is_pid_alive(pid))
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
    fn write_fixture(base: &Path) {
        let hub = base.join("projects").join("proj");
        fs::create_dir_all(&hub).unwrap();
        fs::write(
            hub.join("fleet.json"),
            r#"{
                "recommended": 2, "reasoning": "",
                "director": { "enabled": true, "role": "integrator" },
                "streams": [
                    { "id": "auth-ui", "name": "Auth UI", "repo": "own/web", "owns": [], "issues": [], "dependsOn": [] },
                    { "id": "api", "name": "API", "repo": "own/api", "owns": [], "issues": [], "dependsOn": [] }
                ]
            }"#,
        )
        .unwrap();
        // auth-ui has a worktree (launched); api does not (planned).
        fs::create_dir_all(base.join("worktrees").join("proj").join("web--auth-ui")).unwrap();
    }

    #[test]
    fn discovers_running_dormant_and_planned_with_sources() {
        let base = tmp_base();
        write_fixture(&base);

        // Ledger: the director is running (pid 100); a manual scratch is running (pid 200);
        // a stale api entry (pid 999) is dead and must be skipped.
        let ledger = vec![
            ("proj:director".to_string(), 100u32),
            ("man:scratch:p0".to_string(), 200u32),
            ("proj:api".to_string(), 999u32),
        ];
        let alive = |pid: u32| pid == 100 || pid == 200;

        let out = discover_sessions_impl(&base, &ledger, &alive);

        // Director: running (ledger wins), enriched with the hub cwd + project key from fleet.json.
        let dir = find(&out, "proj:director").expect("director discovered");
        assert_eq!(dir.status, "running");
        assert_eq!(dir.live_pid, Some(100));
        assert_eq!(dir.project_key.as_deref(), Some("proj"));
        assert_eq!(dir.sources, vec!["fleet".to_string(), "ledger".to_string()]);

        // auth-ui: dormant — its worktree exists but it isn't running.
        let auth = find(&out, "proj:auth-ui").expect("auth-ui discovered");
        assert_eq!(auth.status, "dormant");
        assert_eq!(auth.live_pid, None);
        assert_eq!(auth.repo.as_deref(), Some("own/web"));
        assert_eq!(auth.sources, vec!["fleet".to_string(), "worktree".to_string()]);
        assert!(auth.cwd.as_deref().unwrap().ends_with("web--auth-ui"));

        // api: planned — in fleet.json, no worktree, dead ledger entry skipped.
        let api = find(&out, "proj:api").expect("api discovered");
        assert_eq!(api.status, "planned");
        assert_eq!(api.sources, vec!["fleet".to_string()]);
        assert_eq!(api.repo.as_deref(), Some("own/api"));

        // The manual scratch surfaces from the ledger (the frontend marks it reap-only).
        let man = find(&out, "man:scratch:p0").expect("manual discovered");
        assert_eq!(man.status, "running");
        assert_eq!(man.live_pid, Some(200));
        assert_eq!(man.project_key, None);
        assert_eq!(man.sources, vec!["ledger".to_string()]);

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn empty_when_nothing_on_disk_or_alive() {
        let base = tmp_base();
        fs::create_dir_all(base.join("projects")).unwrap();
        let out = discover_sessions_impl(&base, &[("proj:director".into(), 1)], &|_| false);
        assert!(out.is_empty(), "no live ledger entries + no hubs ⇒ nothing discovered");
        let _ = fs::remove_dir_all(&base);
    }
}
