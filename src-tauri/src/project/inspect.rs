use crate::*;

/// Result of running a dead-code scanner (#626). `ran` distinguishes "the tool ran"
/// (parse `stdout`) from "couldn't run it" (`error` set — not installed, bad dir, …).
#[derive(serde::Serialize)]
pub(crate) struct ScanResult {
    pub(crate) tool: String,
    pub(crate) ran: bool,
    pub(crate) exit_code: Option<i32>,
    pub(crate) stdout: String,
    pub(crate) stderr: String,
    pub(crate) error: Option<String>,
}
/// Allowlisted dead-code / unused-dependency scanners → (program, args). Only these may
/// run — the `tool` arg never becomes an arbitrary command. (#626)
pub(crate) fn dead_code_cmd(tool: &str) -> Option<(&'static str, &'static [&'static str])> {
    match tool {
        "depcheck" => Some(("npx", &["--yes", "depcheck", "--json"])),
        "ts-prune" => Some(("npx", &["--yes", "ts-prune"])),
        "cargo-machete" => Some(("cargo", &["machete"])),
        _ => None,
    }
}
/// Run an allowlisted dead-code scanner in `repo_path` and return its raw output for the
/// frontend to parse. Never panics; a missing tool / bad dir comes back as `error`.
#[tauri::command]
pub(crate) fn scan_dead_code(repo_path: String, tool: String) -> ScanResult {
    let err = |e: String| ScanResult { tool: tool.clone(), ran: false, exit_code: None, stdout: String::new(), stderr: String::new(), error: Some(e) };
    let dir = std::path::Path::new(&repo_path);
    if !dir.is_dir() {
        return err(format!("not a directory: {repo_path}"));
    }
    let Some((prog, args)) = dead_code_cmd(&tool) else {
        return err(format!("unknown scanner '{tool}'"));
    };
    match std::process::Command::new(prog).args(args).current_dir(dir).output() {
        Ok(out) => ScanResult {
            tool,
            ran: true,
            exit_code: out.status.code(),
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            error: None,
        },
        Err(e) => err(format!("couldn't run {prog}: {e}")),
    }
}
/// Collect a UI-skeleton directory as (relpath, contents) pairs — source files only,
/// size-capped, recursive. Pure over a path so it's unit-testable (#533).
pub(crate) fn read_skeleton_dir(root: &std::path::Path) -> Vec<(String, String)> {
    fn ok_ext(p: &std::path::Path) -> bool {
        matches!(p.extension().and_then(|s| s.to_str()), Some("jsx" | "tsx" | "js" | "ts" | "css" | "json"))
    }
    fn walk(base: &std::path::Path, dir: &std::path::Path, out: &mut Vec<(String, String)>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(base, &p, out);
            } else if ok_ext(&p) {
                let small = std::fs::metadata(&p).map(|m| m.len() <= 512 * 1024).unwrap_or(false);
                if small {
                    if let (Ok(rel), Ok(content)) = (p.strip_prefix(base), std::fs::read_to_string(&p)) {
                        out.push((rel.to_string_lossy().replace('\\', "/"), content));
                    }
                }
            }
        }
    }
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}
/// Read a project's `.ui-skeleton/` folder (relpath → contents) for the render-preview
/// pipeline (#533): the lightweight, functionless UI the planner generates. Empty when
/// the folder doesn't exist yet.
#[tauri::command]
pub(crate) fn read_ui_skeleton(project_key: String) -> Vec<(String, String)> {
    read_skeleton_dir(&project_dir(&project_key).join(".ui-skeleton"))
}
