//! The kit-usage consumer index (#2277) — which projects consume which kit. A flat edge list at the
//! GLOBAL `~/.base-studio-code/kit-usage.json` (the same shape as the project-links store, #2253), it's
//! the data the change-propagation fan-out reads: `bsc component usage list` → every (projectKey, kitId)
//! edge, so a kit change knows exactly which apps to notify. Written verbatim; one edge per (project, kit).

use serde_json::Value;
use std::path::PathBuf;

/// One consumer edge: project `project_key` uses kit `kit_id`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KitUsage {
    pub id: String,
    pub project_key: String,
    pub kit_id: String,
}

/// The global store file (`~/.base-studio-code/kit-usage.json`), or None when no home dir resolves.
pub fn usage_path() -> Option<PathBuf> {
    bsc_util::bsc_base_dir().map(|b| b.join("kit-usage.json"))
}

/// Deterministic edge id — one edge per (project, kit); re-adding the same pair is idempotent.
pub fn usage_id(project_key: &str, kit_id: &str) -> String {
    format!("{project_key}>{kit_id}")
}

fn from_json(v: &Value) -> Option<KitUsage> {
    Some(KitUsage {
        id: v.get("id")?.as_str()?.to_string(),
        project_key: v.get("projectKey")?.as_str()?.to_string(),
        kit_id: v.get("kitId")?.as_str()?.to_string(),
    })
}
fn to_json(u: &KitUsage) -> Value {
    serde_json::json!({ "id": u.id, "projectKey": u.project_key, "kitId": u.kit_id })
}

/// Load every consumer edge (empty on a fresh install / unreadable / malformed file).
pub fn load() -> Vec<KitUsage> {
    let Some(path) = usage_path() else { return Vec::new() };
    let Ok(text) = std::fs::read_to_string(&path) else { return Vec::new() };
    let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(&text) else { return Vec::new() };
    arr.iter().filter_map(from_json).collect()
}

fn save(list: &[KitUsage]) -> Result<(), String> {
    let path = usage_path().ok_or("save: no home dir ($HOME / $USERPROFILE unset)")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("save: {e}"))?;
    }
    let arr: Vec<Value> = list.iter().map(to_json).collect();
    let json = serde_json::to_string(&arr).map_err(|e| format!("save: {e}"))?;
    std::fs::write(&path, json).map_err(|e| format!("save: {e}"))
}

/// Record that `project_key` uses `kit_id` (idempotent by id). Returns the edge id.
pub fn add(project_key: &str, kit_id: &str) -> Result<String, String> {
    let (project_key, kit_id) = (project_key.trim(), kit_id.trim());
    if project_key.is_empty() || kit_id.is_empty() {
        return Err("add: empty projectKey/kitId".into());
    }
    let id = usage_id(project_key, kit_id);
    let mut list = load();
    if !list.iter().any(|u| u.id == id) {
        list.push(KitUsage { id: id.clone(), project_key: project_key.into(), kit_id: kit_id.into() });
        save(&list)?;
    }
    Ok(id)
}

/// Remove a consumer edge by id (a no-op, not an error, when absent).
pub fn remove(id: &str) -> Result<(), String> {
    let mut list = load();
    let before = list.len();
    list.retain(|u| u.id != id);
    if list.len() != before {
        save(&list)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    /// Run `f` with `$HOME`/`$USERPROFILE` pointed at a fresh temp dir, restored after (serialized so
    /// the env mutation doesn't race other tests).
    fn with_home<T>(f: impl FnOnce() -> T) -> T {
        let _g = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let prev = std::env::var_os(key);
        let dir = std::env::temp_dir().join(format!("bsc-component-usage-{}-{}", std::process::id(), bsc_util::now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var(key, &dir);
        let out = f();
        match prev {
            Some(v) => std::env::set_var(key, v),
            None => std::env::remove_var(key),
        }
        let _ = std::fs::remove_dir_all(&dir);
        out
    }

    #[test]
    fn usage_id_is_the_deterministic_project_kit_key() {
        assert_eq!(usage_id("proj-a", "react-ui"), "proj-a>react-ui");
    }

    #[test]
    fn add_is_idempotent_reject_empty_and_remove_is_a_no_op_when_absent() {
        with_home(|| {
            assert!(load().is_empty(), "fresh install has no usage");
            let id = add("proj-a", "react-ui").unwrap();
            assert_eq!(id, "proj-a>react-ui");
            add("proj-a", "react-ui").unwrap(); // idempotent — same (project, kit)
            assert_eq!(load().len(), 1);
            add("proj-a", "spring-kotlin").unwrap(); // a second kit for the same project = a distinct edge
            add("proj-b", "react-ui").unwrap(); // a second consumer of react-ui
            assert_eq!(load().len(), 3);
            assert!(add("", "react-ui").is_err(), "empty projectKey rejected");
            assert!(add("proj-a", "  ").is_err(), "empty kitId rejected");

            // The consumer index the fan-out reads: react-ui has two consumers.
            let react_consumers: Vec<_> = load().into_iter().filter(|u| u.kit_id == "react-ui").map(|u| u.project_key).collect();
            assert_eq!(react_consumers, vec!["proj-a", "proj-b"]);

            remove("proj-a>react-ui").unwrap();
            assert_eq!(load().len(), 2);
            remove("missing").unwrap(); // no-op, not an error
            assert_eq!(load().len(), 2);
        });
    }
}
