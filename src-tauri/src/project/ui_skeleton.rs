use crate::prelude::*;

/// Collect a UI-skeleton directory as (relpath, contents) pairs — source files only,
/// size-capped, recursive. Pure over a path so it's unit-testable (#533). Delegates to the
/// shared [`read_text_files`] walker, differing from [`read_files_dir`] only by the extension
/// filter (`ok_ext`); the size cap, slash-normalize, sort, and symlink-skip live there.
pub(crate) fn read_skeleton_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn ok_ext(p: &std::path::Path) -> bool {
        matches!(p.extension().and_then(|s| s.to_str()), Some("jsx" | "tsx" | "js" | "ts" | "css" | "json"))
    }
    read_text_files(root, ok_ext)
}
/// Read a project's `.ui-skeleton/` folder (relpath → contents) for the render-preview
/// pipeline (#533): the lightweight, functionless UI promoted from the user's dropped Claude
/// Design files (#1404 — the planner no longer generates it). Empty when the folder doesn't exist yet.
#[tauri::command]
pub(crate) fn read_ui_skeleton(project_key: String) -> Vec<(String, String)> {
    read_skeleton_dir(&project_dir(&project_key).join(".ui-skeleton"))
}

/// Promote the renderable files a user dropped under `design/` into `.ui-skeleton/` so the
/// render-preview shows the REAL dropped Claude Design instead of the demo (#1373). The
/// round-trip stages exports to `design/` (+ a `design/intake.json` manifest); this copies the
/// bundle-able source files into the skeleton the preview reads. Overwrites (idempotent); returns
/// how many files were synced.
#[tauri::command]
pub(crate) fn sync_design_to_skeleton(project_key: String) -> Result<usize, String> {
    Ok(sync_design_dir(&project_dir(&project_key)))
}

/// Core of [`sync_design_to_skeleton`], over a hub PATH so it's unit-testable without the base dir.
pub(crate) fn sync_design_dir(hub: &std::path::Path) -> usize {
    let picked = skeletonizable_design(&read_skeleton_dir(&hub.join("design")));
    let skel = hub.join(".ui-skeleton");
    let mut n = 0usize;
    for (rel, contents) in &picked {
        if !is_safe_relpath(std::path::Path::new(rel)) {
            continue;
        }
        let dest = skel.join(rel);
        if let Some(parent) = dest.parent() {
            if std::fs::create_dir_all(parent).is_err() {
                continue;
            }
        }
        if std::fs::write(&dest, contents).is_ok() {
            n += 1;
        }
    }
    n
}

/// Filter a `design/` listing (already ext/size-filtered by `read_skeleton_dir`) to the files worth
/// promoting into `.ui-skeleton/`: everything except the `intake.json` file-intake manifest, which
/// is bookkeeping, not a screen. Pure so it's unit-testable.
pub(crate) fn skeletonizable_design(files: &[(String, String)]) -> Vec<(String, String)> {
    files.iter().filter(|(rel, _)| rel.as_str() != "intake.json").cloned().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skeletonizable_design_drops_only_the_intake_manifest() {
        let files = vec![
            ("intake.json".to_string(), "[]".to_string()),                 // the manifest → dropped
            ("Login.jsx".to_string(), "export default () => null".to_string()),
            ("components/Button.tsx".to_string(), "export const Button = () => null".to_string()),
            ("theme.css".to_string(), ":root{}".to_string()),
            ("data/sample.json".to_string(), "{}".to_string()),            // a component's data json → kept
        ];
        let names: Vec<String> = skeletonizable_design(&files).into_iter().map(|(r, _)| r).collect();
        assert!(!names.contains(&"intake.json".to_string()), "the file-intake manifest is dropped");
        assert!(names.contains(&"Login.jsx".to_string()));
        assert!(names.contains(&"components/Button.tsx".to_string()));
        assert!(names.contains(&"theme.css".to_string()));
        assert!(names.contains(&"data/sample.json".to_string()), "non-manifest json (component data) is kept");
    }

    #[test]
    fn sync_design_dir_copies_components_into_the_skeleton_preserving_subpaths() {
        let hub = std::env::temp_dir().join(format!("bsc-design-sync-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&hub);
        std::fs::create_dir_all(hub.join("design").join("components")).unwrap();
        std::fs::write(hub.join("design").join("Login.jsx"), "export default function Login(){return null}").unwrap();
        std::fs::write(hub.join("design").join("components").join("Button.tsx"), "export const Button=()=>null").unwrap();
        std::fs::write(hub.join("design").join("intake.json"), "[]").unwrap(); // manifest must NOT be promoted

        let n = sync_design_dir(&hub);
        assert_eq!(n, 2, "two components synced, the manifest skipped");
        let skel: Vec<String> = read_skeleton_dir(&hub.join(".ui-skeleton")).into_iter().map(|(r, _)| r).collect();
        assert!(skel.contains(&"Login.jsx".to_string()));
        assert!(skel.contains(&"components/Button.tsx".to_string()), "subpath preserved");
        assert!(!skel.iter().any(|r| r.ends_with("intake.json")), "the manifest is not in the skeleton");
        let _ = std::fs::remove_dir_all(&hub);
    }
}
