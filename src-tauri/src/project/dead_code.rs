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
