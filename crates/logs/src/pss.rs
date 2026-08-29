//! System-wide PSS-by-process-category sampling (`bsc logs pss`, request #182).
//!
//! Replaces the ad-hoc python PSS sampler used to produce the BEFORE figures on
//! `a-scoped-gate-runs-the-whole-vitest-suite-and-takes-no-slot` (memory climbing 8.37 -> 20.19 GB
//! over a 60s window of ordinary fleet work, peak 18.19 GB across vitest/rustc/sccache/cargo/claude/
//! the app). That script was a private workaround — "a temporary script is a missing `bsc`
//! command" — so this is the durable, testable replacement: sum `Pss` (not `Rss`) out of every
//! `/proc/<pid>/smaps_rollup` and bucket it by what the process actually is.
//!
//! PSS, not RSS: several of the categories this exists to separate (webkit renderers, rustc/cc1plus
//! instances, node workers) share libraries and forked pages. Summing RSS across them double-counts
//! every shared page; PSS divides each shared page by its sharer count, so the category totals add
//! up to something close to the real system total instead of overshooting it.
//!
//! Linux-only by construction — `smaps_rollup` does not exist on macOS or Windows, and there is no
//! portable equivalent that reports PSS.
//!
//! Every reader takes a `proc_dir: &Path` rather than hardcoding `/proc`, so a test builds a small
//! fake tree instead of asserting against whatever happens to be running on the box.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

/// One process's attributed share of physical memory, already categorized.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ProcSample {
    pub pid: i32,
    pub category: &'static str,
    pub pss_bytes: u64,
}

/// One category's total across every matching process in a single sample.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CategoryTotal {
    pub category: &'static str,
    pub pss_bytes: u64,
    pub procs: usize,
}

/// A snapshot of `/proc/meminfo`, in bytes.
#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
pub struct MemInfo {
    /// `MemTotal - MemAvailable` — what the kernel considers actually in use.
    pub used_bytes: u64,
    /// `SwapTotal - SwapFree` — swap already resident, not swap capacity.
    pub swap_used_bytes: u64,
}

/// One full sample: every categorized process plus the system memory snapshot taken alongside it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct Sample {
    pub ts_ms: i64,
    pub mem: Option<MemInfo>,
    pub procs: Vec<ProcSample>,
}

/// The categories this exists to separate, in the order the BEFORE measurement reported them —
/// used only to seed a stable display order; aggregation itself is order-independent.
pub const KNOWN_CATEGORIES: &[&str] = &[
    "vitest workers",
    "vitest runner",
    "C++ (libduckdb)",
    "claude sessions",
    "rustc",
    "sccache",
    "cargo",
    "the app",
    "node (other)",
    "other",
];

/// Parse `MemTotal`/`MemAvailable`/`SwapTotal`/`SwapFree` (kB) out of a `/proc/meminfo`-shaped file.
/// `None` when the file is missing or missing a required field — never a fabricated zero.
pub fn read_meminfo(proc_dir: &Path) -> Option<MemInfo> {
    let text = fs::read_to_string(proc_dir.join("meminfo")).ok()?;
    let mut kb: BTreeMap<&str, u64> = BTreeMap::new();
    for line in text.lines() {
        let Some((key, rest)) = line.split_once(':') else { continue };
        let Some(n) = rest.split_whitespace().next() else { continue };
        if let Ok(v) = n.parse::<u64>() {
            kb.insert(key.trim(), v);
        }
    }
    let total = *kb.get("MemTotal")?;
    let avail = *kb.get("MemAvailable")?;
    let swap_total = *kb.get("SwapTotal")?;
    let swap_free = *kb.get("SwapFree")?;
    Some(MemInfo {
        used_bytes: total.saturating_sub(avail) * 1024,
        swap_used_bytes: swap_total.saturating_sub(swap_free) * 1024,
    })
}

/// The last path component of a `/`-joined string — `basename`, without touching the filesystem
/// (the binary the process ran may no longer exist on disk, e.g. a since-removed build).
fn basename(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

/// Categorize one process from its argv and (truncated, 15-byte) `comm` fallback.
///
/// argv[0], NOT a free-text search of the whole cmdline: a `claude` session's argv routinely
/// contains the literal words "cargo build" or "vitest" as PROMPT TEXT (this repo's own CLAUDE.md
/// quotes `cargo build --bin bsc`), so matching anywhere in the joined cmdline would miscategorize
/// every debug session that happens to be reading this file's own doc comment. Only the executable
/// name identifies what a process actually IS.
pub fn categorize(argv: &[String], comm: &str) -> &'static str {
    let exe = argv.first().map(|s| basename(s)).unwrap_or("");
    // `comm` is kernel-truncated to 15 bytes (Linux TASK_COMM_LEN), so match it only for names that
    // fit — argv[0] is the untruncated source of truth whenever cmdline was readable at all.
    let name = if exe.is_empty() { comm } else { exe };
    match name {
        "sccache" => "sccache",
        "rustc" => "rustc",
        "cargo" => "cargo",
        "cc1plus" | "cc1" | "clang" | "clang++" | "cc" | "c++" | "gcc" | "g++" => "C++ (libduckdb)",
        "claude" => "claude sessions",
        // Linux `comm` truncates "base-studio-code" (16 bytes) to "base-studio-cod" — argv[0] never
        // does, so this arm only needs the untruncated name.
        "base-studio-code" | "base-studio-cod" => "the app",
        "node" => categorize_node(argv),
        _ => "other",
    }
}

/// Node processes need their SCRIPT, not just "node" — vitest's runner and its forked workers are
/// both plain `node`, distinguished only by which file they were told to run. Scans EVERY argv
/// element after argv[0] (never just "the first non-flag one" — a worker's real invocation is
/// `node --experimental-import-meta-resolve --require <path>/vitest/suppress-warnings.cjs
/// --conditions node --conditions development <path>/vitest/dist/workers/forks.js`, and `--require`
/// takes a value that is not itself flag-shaped, so a positional "first non-flag arg" scan lands on
/// the `--require` value — a `vitest`-containing path that is NOT the worker script — and
/// miscategorizes every worker as the runner). Matching vitest's actual module layout
/// (`node_modules/vitest/dist/workers/{forks,vmForks,threads,vmThreads,runVmTests}.js` for a worker,
/// anything else mentioning `vitest` — the CLI entry, an npx/`.bin` shim, or a `--require` value on
/// the RUNNER's own invocation — for the runner), checked in that order so a worker's OWN
/// `--require` value never shadows its later, more specific workers-path argument.
fn categorize_node(argv: &[String]) -> &'static str {
    let rest = argv.get(1..).unwrap_or(&[]);
    if rest.iter().any(|a| a.contains("vitest/dist/workers/")) {
        "vitest workers"
    } else if rest.iter().any(|a| a.contains("vitest")) {
        "vitest runner"
    } else {
        "node (other)"
    }
}

/// Read `argv` from `/proc/<pid>/cmdline` (NUL-separated, no trailing empty element kept).
fn read_cmdline(pid_dir: &Path) -> Vec<String> {
    let Ok(raw) = fs::read(pid_dir.join("cmdline")) else { return Vec::new() };
    raw.split(|&b| b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect()
}

/// Read `/proc/<pid>/comm`, trimmed of its trailing newline. Empty when unreadable (the process
/// exited between the directory listing and this read — normal on a busy box, not an error).
fn read_comm(pid_dir: &Path) -> String {
    fs::read_to_string(pid_dir.join("comm"))
        .map(|s| s.trim_end().to_string())
        .unwrap_or_default()
}

/// Sum the `Pss:` line (kB) out of a `/proc/<pid>/smaps_rollup`-shaped file. `None` when the file is
/// absent or unreadable — a process can be gone by the time this runs, or owned by another user; a
/// gap is dropped from the sample rather than counted as zero.
fn read_pss_bytes(pid_dir: &Path) -> Option<u64> {
    let text = fs::read_to_string(pid_dir.join("smaps_rollup")).ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("Pss:") {
            let kb: u64 = rest.split_whitespace().next()?.parse().ok()?;
            return Some(kb * 1024);
        }
    }
    None
}

/// Take one sample: every numeric entry under `proc_dir`, categorized and PSS-summed, plus the
/// system memory snapshot from the same directory. A process that vanishes mid-scan (exited, or its
/// `smaps_rollup` was unreadable) is silently skipped — sampling is inherently a race against a live
/// process table, and dropping a gone PID is correct, not an error to surface.
pub fn sample(proc_dir: &Path, ts_ms: i64) -> Sample {
    let mem = read_meminfo(proc_dir);
    let mut procs = Vec::new();
    let Ok(entries) = fs::read_dir(proc_dir) else {
        return Sample { ts_ms, mem, procs };
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name.to_str().and_then(|s| s.parse::<i32>().ok()) else { continue };
        let pid_dir = entry.path();
        let Some(pss_bytes) = read_pss_bytes(&pid_dir) else { continue };
        let argv = read_cmdline(&pid_dir);
        let comm = read_comm(&pid_dir);
        let category = categorize(&argv, &comm);
        procs.push(ProcSample { pid, category, pss_bytes });
    }
    Sample { ts_ms, mem, procs }
}

/// Aggregate one sample's processes into per-category totals, sorted by descending PSS (the biggest
/// consumer first — what a reader scanning the table wants).
pub fn aggregate(procs: &[ProcSample]) -> Vec<CategoryTotal> {
    let mut totals: BTreeMap<&'static str, (u64, usize)> = BTreeMap::new();
    for p in procs {
        let e = totals.entry(p.category).or_insert((0, 0));
        e.0 += p.pss_bytes;
        e.1 += 1;
    }
    let mut out: Vec<CategoryTotal> = totals
        .into_iter()
        .map(|(category, (pss_bytes, procs))| CategoryTotal { category, pss_bytes, procs })
        .collect();
    out.sort_by_key(|a| std::cmp::Reverse(a.pss_bytes));
    out
}

/// The report `--watch` produces across N samples: the climb in system memory-in-use, the swap
/// resident at the start, and each category's OWN peak — independently, not necessarily at the same
/// moment — the same convention the BEFORE measurement used ("peak by category" then "peak sum").
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct WatchSummary {
    pub samples: usize,
    pub from_ts_ms: i64,
    pub to_ts_ms: i64,
    /// System memory-in-use at the first and last sample. `None` when `/proc/meminfo` was
    /// unreadable for that sample.
    pub used_from_bytes: Option<u64>,
    pub used_to_bytes: Option<u64>,
    /// Swap already resident at the first sample.
    pub swap_used_bytes: Option<u64>,
    /// Each category's peak PSS across every sample it appeared in, descending by peak.
    pub peak_by_category: Vec<CategoryTotal>,
    /// Sum of every category's own peak — an upper bound on total attributable memory, not a
    /// simultaneous reading (categories can peak at different samples).
    pub peak_sum_bytes: u64,
}

/// Summarize a `--watch` run's samples into a [`WatchSummary`]. Pure — the caller does the actual
/// interval sleeping; this only reduces whatever samples it was handed. Panics-free on an empty
/// slice (returns a summary with no samples and no data) so a watch that got interrupted before its
/// first tick still reports something coherent rather than crashing.
pub fn summarize_watch(samples: &[Sample]) -> WatchSummary {
    let (from_ts_ms, to_ts_ms) = match (samples.first(), samples.last()) {
        (Some(f), Some(l)) => (f.ts_ms, l.ts_ms),
        _ => (0, 0),
    };
    let used_from_bytes = samples.first().and_then(|s| s.mem).map(|m| m.used_bytes);
    let used_to_bytes = samples.last().and_then(|s| s.mem).map(|m| m.used_bytes);
    let swap_used_bytes = samples.first().and_then(|s| s.mem).map(|m| m.swap_used_bytes);

    // Peak per category: fold every sample's aggregated totals, keeping the max pss_bytes seen and
    // the process count AT that peak sample (not the max count seen elsewhere).
    let mut peak: BTreeMap<&'static str, CategoryTotal> = BTreeMap::new();
    for s in samples {
        for c in aggregate(&s.procs) {
            peak.entry(c.category)
                .and_modify(|existing| {
                    if c.pss_bytes > existing.pss_bytes {
                        *existing = c.clone();
                    }
                })
                .or_insert(c);
        }
    }
    let mut peak_by_category: Vec<CategoryTotal> = peak.into_values().collect();
    peak_by_category.sort_by_key(|a| std::cmp::Reverse(a.pss_bytes));
    let peak_sum_bytes = peak_by_category.iter().map(|c| c.pss_bytes).sum();

    WatchSummary {
        samples: samples.len(),
        from_ts_ms,
        to_ts_ms,
        used_from_bytes,
        used_to_bytes,
        swap_used_bytes,
        peak_by_category,
        peak_sum_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn tmp_proc() -> PathBuf {
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bsc-logs-pss-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build one fake `/proc/<pid>/{cmdline,comm,smaps_rollup}` triple.
    fn seed_proc(proc_dir: &Path, pid: i32, argv: &[&str], comm: &str, pss_kb: u64) {
        let dir = proc_dir.join(pid.to_string());
        fs::create_dir_all(&dir).unwrap();
        let mut cmdline = Vec::new();
        for a in argv {
            cmdline.extend_from_slice(a.as_bytes());
            cmdline.push(0);
        }
        fs::write(dir.join("cmdline"), cmdline).unwrap();
        fs::write(dir.join("comm"), format!("{comm}\n")).unwrap();
        fs::write(
            dir.join("smaps_rollup"),
            format!(
                "55f4-7ffc ---p 00000000 00:00 0                          [rollup]\nRss:              {} kB\nPss:              {} kB\nPss_Dirty:        0 kB\n",
                pss_kb, pss_kb
            ),
        )
        .unwrap();
    }

    fn seed_meminfo(proc_dir: &Path, total_kb: u64, avail_kb: u64, swap_total_kb: u64, swap_free_kb: u64) {
        fs::write(
            proc_dir.join("meminfo"),
            format!(
                "MemTotal:       {total_kb} kB\nMemFree:              0 kB\nMemAvailable:   {avail_kb} kB\nSwapTotal:      {swap_total_kb} kB\nSwapFree:        {swap_free_kb} kB\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn categorizes_by_argv0_not_free_text_search() {
        // A claude session whose PROMPT contains the words "cargo build" and "vitest" must not be
        // miscategorized — this is the exact bug a naive full-cmdline substring search would have.
        let argv: Vec<String> = vec![
            "claude".into(),
            "--model".into(),
            "sonnet".into(),
            "run cargo build --bin bsc, then npm run gate -- vitest".into(),
        ];
        assert_eq!(categorize(&argv, "claude"), "claude sessions");
    }

    #[test]
    fn categorizes_known_binaries_by_argv0_basename() {
        assert_eq!(categorize(&["/home/u/.cargo/bin/sccache".into()], "sccache"), "sccache");
        assert_eq!(categorize(&["/usr/bin/rustc".into()], "rustc"), "rustc");
        assert_eq!(categorize(&["/home/u/.cargo/bin/cargo".into(), "build".into()], "cargo"), "cargo");
        assert_eq!(categorize(&["cc1plus".into()], "cc1plus"), "C++ (libduckdb)");
        assert_eq!(
            categorize(
                &["/home/u/repo/target/debug/base-studio-code".into()],
                "base-studio-cod" // kernel-truncated comm, exercised via the comm fallback below
            ),
            "the app"
        );
        assert_eq!(categorize(&[], "unknown-thing"), "other");
    }

    #[test]
    fn falls_back_to_truncated_comm_when_cmdline_is_unreadable() {
        // No argv (e.g. a zombie, or a permission-denied cmdline) — comm is all that's left, and the
        // app's own binary name is exactly the kernel-truncated 15-byte case.
        assert_eq!(categorize(&[], "base-studio-cod"), "the app");
    }

    #[test]
    fn distinguishes_vitest_runner_from_forked_workers_by_script_path() {
        let runner: Vec<String> = vec![
            "node".into(),
            "/repo/node_modules/vitest/dist/cli.js".into(),
            "run".into(),
        ];
        assert_eq!(categorize(&runner, "node"), "vitest runner");

        let worker: Vec<String> = vec![
            "node".into(),
            "--max-old-space-size=4096".into(), // a flag before the script — must be skipped
            "/repo/node_modules/vitest/dist/workers/forks.js".into(),
        ];
        assert_eq!(categorize(&worker, "node"), "vitest workers");

        let other: Vec<String> = vec!["node".into(), "/repo/node_modules/.bin/vite".into()];
        assert_eq!(categorize(&other, "node"), "node (other)");
    }

    #[test]
    fn categorizes_a_worker_correctly_even_when_a_require_flag_value_comes_first() {
        // The REAL argv a vitest "forks" worker launches with (captured live, request #182 follow-up):
        // `--require <path>` takes a value that is NOT itself flag-shaped, so a categorizer that
        // takes "the first non-flag argument after argv[0]" lands on the --require value (a path
        // that also contains "vitest") instead of the actual worker script two args later, and
        // miscategorizes every worker as "vitest runner". Zero "vitest workers" ever showing up in a
        // real `--watch` sample was exactly this bug, not an absence of workers.
        let worker: Vec<String> = vec![
            "/usr/bin/node".into(),
            "--experimental-import-meta-resolve".into(),
            "--require".into(),
            "/repo/node_modules/vitest/suppress-warnings.cjs".into(),
            "--conditions".into(),
            "node".into(),
            "--conditions".into(),
            "development".into(),
            "/repo/node_modules/vitest/dist/workers/forks.js".into(),
        ];
        assert_eq!(categorize(&worker, "node"), "vitest workers");

        // The runner's own invocation carries the same --require shape but never a workers/ path —
        // must still resolve to "vitest runner", not fall through to "node (other)".
        let runner: Vec<String> = vec![
            "/usr/bin/node".into(),
            "--require".into(),
            "/repo/node_modules/vitest/suppress-warnings.cjs".into(),
            "/repo/node_modules/.bin/vitest".into(),
            "run".into(),
        ];
        assert_eq!(categorize(&runner, "node"), "vitest runner");
    }

    #[test]
    fn reads_meminfo_used_and_swap_used_in_bytes() {
        let dir = tmp_proc();
        seed_meminfo(&dir, 32_000_000, 22_000_000, 16_000_000, 9_000_000);
        let m = read_meminfo(&dir).unwrap();
        assert_eq!(m.used_bytes, 10_000_000 * 1024);
        assert_eq!(m.swap_used_bytes, 7_000_000 * 1024);
    }

    #[test]
    fn missing_meminfo_is_none_not_a_fabricated_zero() {
        let dir = tmp_proc();
        assert!(read_meminfo(&dir).is_none());
    }

    #[test]
    fn samples_and_aggregates_by_category_descending() {
        let dir = tmp_proc();
        seed_meminfo(&dir, 32_000_000, 12_000_000, 16_000_000, 8_000_000);
        seed_proc(&dir, 100, &["/usr/bin/rustc"], "rustc", 200_000);
        seed_proc(&dir, 101, &["/usr/bin/rustc"], "rustc", 300_000);
        seed_proc(&dir, 102, &["/home/u/.cargo/bin/sccache"], "sccache", 50_000);
        seed_proc(
            &dir,
            103,
            &["node", "/repo/node_modules/vitest/dist/workers/forks.js"],
            "node",
            900_000,
        );

        let s = sample(&dir, 12345);
        assert_eq!(s.ts_ms, 12345);
        assert_eq!(s.procs.len(), 4);
        assert_eq!(s.mem.unwrap().used_bytes, 20_000_000 * 1024);

        let totals = aggregate(&s.procs);
        // Descending by pss_bytes: vitest workers (900MB-ish) > rustc (500MB-ish) > sccache.
        assert_eq!(totals[0].category, "vitest workers");
        assert_eq!(totals[0].pss_bytes, 900_000 * 1024);
        assert_eq!(totals[0].procs, 1);
        assert_eq!(totals[1].category, "rustc");
        assert_eq!(totals[1].pss_bytes, 500_000 * 1024);
        assert_eq!(totals[1].procs, 2);
        assert_eq!(totals[2].category, "sccache");
        assert_eq!(totals[2].pss_bytes, 50_000 * 1024);
    }

    #[test]
    fn a_pid_dir_with_no_smaps_rollup_is_skipped_not_zeroed() {
        // Simulates a process that exited between the directory listing and the read — common on a
        // busy box, and must not appear as a phantom zero-byte row.
        let dir = tmp_proc();
        fs::create_dir_all(dir.join("999")).unwrap();
        fs::write(dir.join("999").join("cmdline"), b"rustc\0").unwrap();
        // no smaps_rollup written
        let s = sample(&dir, 1);
        assert!(s.procs.is_empty());
    }

    #[test]
    fn non_numeric_proc_entries_are_ignored() {
        let dir = tmp_proc();
        fs::create_dir_all(dir.join("self")).unwrap();
        fs::create_dir_all(dir.join("net")).unwrap();
        let s = sample(&dir, 1);
        assert!(s.procs.is_empty());
    }

    #[test]
    fn watch_summary_reports_climb_and_independent_category_peaks() {
        let d1 = tmp_proc();
        seed_meminfo(&d1, 32_000_000, 24_000_000, 16_000_000, 8_000_000); // used = 8GB, swap = 8GB
        seed_proc(&d1, 100, &["/usr/bin/rustc"], "rustc", 200_000);

        let d2 = tmp_proc();
        seed_meminfo(&d2, 32_000_000, 12_000_000, 16_000_000, 8_000_000); // used = 20GB
        seed_proc(&d2, 100, &["/usr/bin/rustc"], "rustc", 900_000); // rustc peaks here
        seed_proc(&d2, 101, &["/home/u/.cargo/bin/sccache"], "sccache", 50_000);

        let d3 = tmp_proc();
        seed_meminfo(&d3, 32_000_000, 20_000_000, 16_000_000, 8_000_000); // used = 12GB, mid-run dip
        seed_proc(&d3, 102, &["/home/u/.cargo/bin/sccache"], "sccache", 300_000); // sccache peaks here

        let samples = vec![sample(&d1, 0), sample(&d2, 9_000), sample(&d3, 18_000)];
        let w = summarize_watch(&samples);

        assert_eq!(w.samples, 3);
        assert_eq!(w.from_ts_ms, 0);
        assert_eq!(w.to_ts_ms, 18_000);
        assert_eq!(w.used_from_bytes, Some(8_000_000 * 1024));
        assert_eq!(w.used_to_bytes, Some(12_000_000 * 1024));
        assert_eq!(w.swap_used_bytes, Some(8_000_000 * 1024));

        let rustc = w.peak_by_category.iter().find(|c| c.category == "rustc").unwrap();
        assert_eq!(rustc.pss_bytes, 900_000 * 1024, "rustc's peak came from sample 2, not the last one");
        let sccache = w.peak_by_category.iter().find(|c| c.category == "sccache").unwrap();
        assert_eq!(sccache.pss_bytes, 300_000 * 1024, "sccache's peak came from sample 3, not sample 2");

        // peak_sum is the sum of INDEPENDENT peaks (900_000 + 300_000), never simultaneous.
        assert_eq!(w.peak_sum_bytes, (900_000 + 300_000) * 1024);
    }

    #[test]
    fn watch_summary_of_no_samples_is_coherent_not_a_panic() {
        let w = summarize_watch(&[]);
        assert_eq!(w.samples, 0);
        assert!(w.peak_by_category.is_empty());
        assert_eq!(w.peak_sum_bytes, 0);
        assert_eq!(w.used_from_bytes, None);
    }
}
