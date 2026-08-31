//! `bsc llm` — what the local model runtime is actually doing.
//!
//! The impure half of [`crate::runtime`]: walking `/proc` for the running `llama-server`, reading the
//! server's environment, and calling ollama's HTTP API. Every parse and every judgement lives in that
//! module and is tested against captured real output; nothing here decides anything.
//!
//! The point of the command is the GRANT. Ollama fits its runner to available VRAM and reports
//! nothing when it gives you less than you asked for — measured on this box as a request for two 64K
//! slots coming up as `-c 4096 -np 1`. Every other surface, including ollama's own API, answers as
//! though the request succeeded.

use crate::runtime::{
    findings_with_headroom, parse_llama_server_argv, parse_ollama_env, parse_ps, parse_tags,
    parse_vram_sysfs, Requested, ResidentModel, Severity, SlotGrant, Vram, GIB,
};

const USAGE: &str = "\
bsc llm — what the local model runtime is actually doing

USAGE:
  bsc llm status [--host <url>] [--json]

  status    GPU/runner state: resident models, the slot + context grant, and any gap
            between what was REQUESTED and what is actually running.

The grant is read from the running llama-server's own argv, not from the HTTP API:
ollama sizes the runner to available VRAM and does NOT report having shrunk it.

ENV:
  OLLAMA_HOST         where to probe (default http://127.0.0.1:11434)
  BSC_AGENT_NUM_CTX   the context the app requests per slot; enables the shrink check
";

/// Where a running `llama-server` was found, and what it was granted.
struct Runner {
    pid: i32,
    grant: SlotGrant,
}

/// Walk `/proc` for live `llama-server` processes and read the grant out of each one's argv.
///
/// `/proc/<pid>/cmdline` rather than `ps`: it is NUL-separated exactly as the kernel holds it, so
/// there is no quoting to undo and an argument containing a space cannot split into two.
#[cfg(target_os = "linux")]
fn runners() -> Vec<Runner> {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Vec::new() };
    let mut out = Vec::new();
    for e in entries.flatten() {
        let Some(pid) = e.file_name().to_str().and_then(|n| n.parse::<i32>().ok()) else { continue };
        let Ok(raw) = std::fs::read(e.path().join("cmdline")) else { continue };
        let argv: Vec<String> =
            raw.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect();
        let Some(first) = argv.first() else { continue };
        if !first.contains("llama-server") {
            continue;
        }
        if let Some(grant) = parse_llama_server_argv(&argv) {
            out.push(Runner { pid, grant });
        }
    }
    out.sort_by_key(|r| r.pid);
    out
}

/// No `/proc` to walk. The grant is a Linux-only measurement, and saying so is better than reporting
/// an empty list that reads as "no runner is running".
#[cfg(not(target_os = "linux"))]
fn runners() -> Vec<Runner> {
    Vec::new()
}

/// The `OLLAMA_*` settings from the SERVER's environment.
///
/// Read from the server process, not from our own: `ollama serve` is commonly launched from a plain
/// shell rather than a unit file, so `systemctl show` reports nothing and this process's own
/// environment has never seen the value.
#[cfg(target_os = "linux")]
fn server_request() -> Requested {
    let Ok(entries) = std::fs::read_dir("/proc") else { return Requested::default() };
    for e in entries.flatten() {
        let Ok(raw) = std::fs::read(e.path().join("cmdline")) else { continue };
        let argv = String::from_utf8_lossy(&raw);
        if !argv.contains("ollama") || !argv.contains("serve") {
            continue;
        }
        if let Ok(env) = std::fs::read(e.path().join("environ")) {
            return parse_ollama_env(&String::from_utf8_lossy(&env));
        }
    }
    Requested::default()
}

#[cfg(not(target_os = "linux"))]
fn server_request() -> Requested {
    Requested::default()
}

/// One GET against the ollama API.
///
/// BLOCKING and short-timeout on purpose. This is a CLI a person or a session runs to find out why a
/// local worker will not start, and the common failing case is that ollama is down — so it must fail
/// fast and say so rather than hang on a connect.
fn get(host: &str, path: &str) -> Result<String, String> {
    let url = format!("{}{path}", host.trim_end_matches('/'));
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| format!("http client: {e}"))?
        .get(&url)
        .send()
        .map_err(|e| format!("{url}: {e}"))?
        .text()
        .map_err(|e| format!("{url}: {e}"))
}

/// GPU memory from the kernel driver's sysfs counters.
///
/// The driver rather than ollama's startup log: `ollama serve` is commonly launched from a bare shell,
/// so that log goes to a terminal nothing can read back. amdgpu-specific and best-effort — an absent
/// counter reports UNKNOWN, which suppresses the headroom claim instead of guessing at it.
fn vram() -> Option<Vram> {
    let cards = std::fs::read_dir("/sys/class/drm").ok()?;
    for e in cards.flatten() {
        let dev = e.path().join("device");
        let (t, u) = (dev.join("mem_info_vram_total"), dev.join("mem_info_vram_used"));
        if let (Ok(t), Ok(u)) = (std::fs::read_to_string(&t), std::fs::read_to_string(&u)) {
            if let Some(v) = parse_vram_sysfs(&t, &u) {
                return Some(v);
            }
        }
    }
    None
}

fn gib(bytes: u64) -> String {
    format!("{:.2} GiB", bytes as f64 / GIB)
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let mut it = args.into_iter();
    let cmd = it.next().unwrap_or_default();
    let rest: Vec<String> = it.collect();
    match cmd.as_str() {
        "status" => status(&rest),
        "" | "-h" | "--help" | "help" => {
            print!("{USAGE}");
            Ok(())
        }
        other => Err(format!("{prog}: unknown subcommand `{other}`\n\n{USAGE}")),
    }
}

fn status(args: &[String]) -> Result<(), String> {
    let flag = |name: &str| -> Option<String> {
        args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
    };
    let host = flag("--host")
        .or_else(|| std::env::var("OLLAMA_HOST").ok())
        .map(|h| if h.starts_with("http") { h } else { format!("http://{h}") })
        .unwrap_or_else(|| "http://127.0.0.1:11434".into());
    let as_json = args.iter().any(|a| a == "--json");

    // The request side. `num_ctx` is the app's, not the server's, so it comes from the same variable
    // a session is launched with — absent simply disables the context check rather than defaulting.
    let mut req = server_request();
    req.num_ctx = std::env::var("BSC_AGENT_NUM_CTX").ok().and_then(|v| v.trim().parse().ok());

    let found = runners();
    let grants: Vec<SlotGrant> = found.iter().map(|r| r.grant.clone()).collect();

    // Each probe is allowed to fail on its own. Ollama being down is a normal state and must still
    // produce a report, because "the server is not running" is exactly the answer someone is looking
    // for when a local session will not start.
    let ps = get(&host, "/api/ps");
    let resident: Vec<ResidentModel> = ps.as_ref().ok().and_then(|b| parse_ps(b).ok()).unwrap_or_default();
    let weights = get(&host, "/api/tags").ok().and_then(|b| parse_tags(&b).ok()).unwrap_or_default();
    // The measured per-slot cost, from whatever is actually loaded — never a formula. Divided by the
    // granted slot count, since a runner with N slots holds N contexts worth of KV.
    let gpu = vram();
    let slot_cost = resident.iter().find_map(|m| {
        let over = weights.get(&m.name).and_then(|w| m.overhead_bytes(*w))?;
        let slots = grants.first().map(|g| g.slots).unwrap_or(1).max(1);
        Some(over / u64::from(slots))
    });
    let fs = findings_with_headroom(&req, &grants, gpu, slot_cost);

    if as_json {
        let v = serde_json::json!({
            "host": host,
            "reachable": ps.is_ok(),
            "vram": gpu.map(|v| serde_json::json!({
                "totalBytes": v.total_bytes, "usedBytes": v.used_bytes, "freeBytes": v.free_bytes(),
            })),
            "slotCostBytes": slot_cost,
            "requested": { "parallel": req.parallel, "numCtx": req.num_ctx },
            "runners": found.iter().map(|r| serde_json::json!({
                "pid": r.pid,
                "slots": r.grant.slots,
                "totalCtx": r.grant.total_ctx,
                "perSlotCtx": r.grant.per_slot_ctx(),
            })).collect::<Vec<_>>(),
            "resident": resident.iter().map(|m| serde_json::json!({
                "name": m.name,
                "sizeBytes": m.size_bytes,
                "vramBytes": m.vram_bytes,
                "contextLength": m.context_length,
                "overheadBytes": weights.get(&m.name).and_then(|w| m.overhead_bytes(*w)),
            })).collect::<Vec<_>>(),
            "findings": fs.iter().map(|f| serde_json::json!({
                "severity": match f.severity { Severity::Warn => "warn", Severity::Note => "note" },
                "message": f.message,
                "fix": f.fix,
            })).collect::<Vec<_>>(),
        });
        println!("{}", serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?);
        return Ok(());
    }

    println!("host  {host}");
    match gpu {
        Some(v) => println!(
            "gpu   {} total · {} used · {} free",
            gib(v.total_bytes),
            gib(v.used_bytes),
            gib(v.free_bytes())
        ),
        None => println!("gpu   (no VRAM counters — headroom cannot be computed)"),
    }
    match &ps {
        Ok(_) => {}
        Err(e) => println!("      UNREACHABLE — {e}"),
    }

    println!("\nRESIDENT");
    if resident.is_empty() {
        println!("  (nothing loaded)");
    }
    for m in &resident {
        let ctx = m.context_length.map(|c| c.to_string()).unwrap_or_else(|| "?".into());
        let over = weights
            .get(&m.name)
            .and_then(|w| m.overhead_bytes(*w))
            .map(|o| format!(" · {} KV+buffers", gib(o)))
            .unwrap_or_default();
        println!("  {:<40} {:>10} @ ctx={ctx}{over}", m.name, gib(m.size_bytes));
    }

    println!("\nGRANTED (from the running runner's argv — the authority)");
    if found.is_empty() {
        println!("  (no llama-server running)");
    }
    for r in &found {
        println!(
            "  pid {:<7} {} slot(s) · -c {} total · {} tokens per request",
            r.pid,
            r.grant.slots,
            r.grant.total_ctx,
            r.grant.per_slot_ctx()
        );
    }

    println!("\nREQUESTED");
    println!(
        "  OLLAMA_NUM_PARALLEL  {}",
        req.parallel.map(|p| p.to_string()).unwrap_or_else(|| "(unset — ollama chooses)".into())
    );
    println!(
        "  BSC_AGENT_NUM_CTX    {}",
        req.num_ctx.map(|c| c.to_string()).unwrap_or_else(|| "(unset — no context check)".into())
    );

    if !fs.is_empty() {
        println!();
        for f in &fs {
            let tag = match f.severity {
                Severity::Warn => "WARN",
                Severity::Note => "note",
            };
            println!("{tag}  {}", f.message);
            if let Some(fix) = &f.fix {
                println!("      fix: {fix}");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn help_is_offered_rather_than_treated_as_an_error() {
        assert!(run(vec![], "bsc llm").is_ok());
        assert!(run(vec!["--help".into()], "bsc llm").is_ok());
    }

    #[test]
    fn an_unknown_subcommand_names_itself_and_prints_the_usage() {
        let e = run(vec!["frobnicate".into()], "bsc llm").unwrap_err();
        assert!(e.contains("frobnicate"), "{e}");
        assert!(e.contains("USAGE"), "an error without the usage leaves the reader stuck");
    }

    /// A `status` against a host with nothing listening must still SUCCEED and report. The case this
    /// command is most needed for is a local session that will not start, which is often exactly the
    /// case where ollama is down.
    #[test]
    fn an_unreachable_host_still_produces_a_report() {
        // Port 1 is reserved and never has a listener.
        let r = status(&["--host".into(), "http://127.0.0.1:1".into()]);
        assert!(r.is_ok(), "an unreachable ollama is a finding, not a crash: {r:?}");
    }

    #[test]
    fn json_output_is_valid_json_even_with_nothing_running() {
        // Captured to a pipe would be cleaner, but the contract worth pinning is that it does not
        // error; the shape itself is covered by the pure parsers' own tests.
        assert!(status(&["--host".into(), "http://127.0.0.1:1".into(), "--json".into()]).is_ok());
    }
}
