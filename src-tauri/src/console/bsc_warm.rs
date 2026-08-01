//! The desktop's client for a WARM `bsc` (#4152) — one long-lived `bsc serve` child instead of a fresh
//! process per read.
//!
//! Measured on the real staged binary: `bsc help` (pure startup, no work) is 39ms, `bsc ui list --graph`
//! is 49ms, and the app makes ~1,500 calls in a session. Six sequential `ui list --graph` spawns take
//! 206ms; the same six through one warm child take 125ms INCLUDING its single startup.
//!
//! ## Deliberately serialized
//!
//! One child, one mutex, one request at a time. That is not a compromise: a served call is ~14ms, so six
//! serialized answers beat six concurrent 34ms spawns — and serializing is what makes the server's
//! thread-local output capture sound.
//!
//! ## Every failure falls back
//!
//! A warm child that will not spawn, dies mid-request, or answers something unparseable returns `None`
//! and the caller spawns one-shot exactly as before. The warm path is an OPTIMISATION, never the only
//! way to run a command — so a broken child degrades speed, never correctness.

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;

/// The live child, or `None` before the first call / after a failure retired it.
static WARM: Mutex<Option<Warm>> = Mutex::new(None);

struct Warm {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Warm {
    /// Spawn `bsc serve` with the same global store env a one-shot read gets.
    ///
    /// PROJECT-LESS ONLY — the caller guarantees it via [`bsc_util::is_servable_warm`]. Per-project
    /// store env is set per call and env is process-global, so a warm child could not switch it.
    fn spawn() -> Option<Self> {
        let bin = crate::console::pty::bsc_bin_path()?;
        let mut cmd = Command::new(&bin);
        cmd.arg("serve");
        super::bsc::wire_bsc_stores(&mut cmd, None);
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW — no console flash for a background child
        }
        let mut child = cmd.spawn().ok()?;
        let stdin = child.stdin.take()?;
        let stdout = BufReader::new(child.stdout.take()?);
        Some(Self { child, stdin, stdout, next_id: 1 })
    }

    /// Send one request and read its reply line. `None` on ANY I/O trouble, which retires the child.
    fn round_trip(&mut self, args: &[String]) -> Option<Result<String, String>> {
        let id = self.next_id;
        self.next_id += 1;
        let req = serde_json::json!({ "id": id, "args": args }).to_string();
        self.stdin.write_all(req.as_bytes()).ok()?;
        self.stdin.write_all(b"\n").ok()?;
        self.stdin.flush().ok()?;

        let mut line = String::new();
        // A zero-length read means the child closed its stdout — it died, and there is no reply coming.
        if self.stdout.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(&line).ok()?;
        // An id mismatch means the stream desynchronised (a stray write on the child's stdout). Retire
        // the child rather than returning another request's output as this one's answer.
        if v.get("id").and_then(serde_json::Value::as_u64) != Some(id) {
            return None;
        }
        if v.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            Some(Ok(v.get("out").and_then(serde_json::Value::as_str).unwrap_or_default().to_string()))
        } else {
            Some(Err(v.get("err").and_then(serde_json::Value::as_str).unwrap_or("bsc serve: failed").to_string()))
        }
    }
}

impl Drop for Warm {
    fn drop(&mut self) {
        // Dropping stdin closes the pipe, which ends the serve loop; kill is the backstop for a child
        // that ignores it, so retiring one never leaks a process.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Answer `args` from the warm child, or `None` to tell the caller to spawn one-shot.
///
/// `None` covers every reason: not servable, no child, a dead child, a desynchronised stream. The caller
/// must always be able to fall back — that is what keeps this an optimisation rather than a dependency.
pub(crate) fn try_warm(project_key: Option<&str>, args: &[String]) -> Option<Result<String, String>> {
    // A project key means per-project store env this child cannot switch.
    if project_key.is_some_and(|k| !k.is_empty()) || !bsc_util::is_servable_warm(args) {
        return None;
    }
    // A poisoned lock means a previous caller panicked mid-request; the stream state is unknown, so
    // fall back rather than trusting it.
    let mut guard = WARM.lock().ok()?;
    if guard.is_none() {
        *guard = Warm::spawn();
    }
    let result = guard.as_mut()?.round_trip(args);
    if result.is_none() {
        *guard = None; // retire the child; the next call respawns
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_project_scoped_call_is_never_sent_warm() {
        // Per-project store env is set PER CALL and env is process-global, so a warm child would answer
        // from whatever project it was spawned for. Refusing here is what keeps that impossible.
        assert!(try_warm(Some("some-project"), &a(&["ui", "list"])).is_none());
    }

    #[test]
    fn a_non_servable_command_is_never_sent_warm() {
        // Mirrors the server's own allow-list, from the one shared definition.
        assert!(try_warm(None, &a(&["plan", "list"])).is_none());
        assert!(try_warm(None, &a(&["ui", "set"])).is_none());
        assert!(try_warm(None, &a(&[])).is_none());
    }

    #[test]
    fn an_empty_project_key_still_counts_as_project_less() {
        // `wire_bsc_stores` treats "" as absent, so this must route the same way the one-shot path does —
        // otherwise an empty key would silently disable the warm path for every global read.
        // (No assertion on the RESULT: whether a child spawns depends on the sidecar being present.)
        let _ = try_warm(Some(""), &a(&["ui", "list"]));
    }
}
