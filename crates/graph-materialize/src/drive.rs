// The driver — building and testing a crate from records, with cargo out of the loop.
//
// # What cargo actually contributes, and therefore what this has to replace
//
// A manifest is read by cargo at BUILD-PLANNING time to derive ONE rustc command line. rustc never
// sees the manifest and neither does the runtime; `build.rs` does not even parse it, using only
// `CARGO_MANIFEST_DIR`. MEASURED 2026-09-09 on `bsc-hook`, that command line replayed standalone
// produced a working binary in 0.271s, a `cdylib` in 0.110s, and a passing 4/4 test binary in
// 0.195s — none of them with cargo running.
//
// So this module is not a build system. It is the ten fields that invocation needs, plus the two
// places the obvious implementation is silently wrong.
//
// # Trap 1: an extern path can NEVER come from a filename glob
//
// MEASURED: `target/debug/deps` holds 1037 rlibs for 576 distinct crate names — `serde_json` has 4
// variants and `getrandom` 6, differing by feature set. They are distinguished only by the
// `-C metadata` hash cargo computes, which is cargo-internal and explicitly unstable. So the extern
// map is CAPTURED from cargo's own verbose output and stored; recomputing it means reimplementing a
// hash that is allowed to change under us, and GUESSING it means linking the wrong `serde_json`
// while every filename looks right. `a_glob_would_pick_a_different_rlib` pins this.
//
// # Trap 2: a closure taken from an incremental build is silently short
//
// The obvious source for "what does this crate need" is the build log — and it is wrong, because an
// incremental build only mentions what it RECOMPILED. MEASURED: `bsc-hook` appears to need 3 crates
// from its incremental log; it actually needs 7. `itoa`, `memchr` and `zmij` were already built, so
// cargo said nothing about them. The failure that follows is an `E0463` naming `serde_json` — a
// crate that IS present — because the missing one is its dependency. See
// `an_incremental_log_yields_a_short_closure`.

use std::path::{Path, PathBuf};

/// What kind of artifact to produce.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Bin,
    Lib,
    /// The loadable form — a C-ABI shared object. Used by the long-lived app, NOT by `bsc`, which is
    /// a fresh process per invocation and reloads by having its binary replaced.
    Cdylib,
    /// `--test`: the same crate root compiled with the test harness linked in.
    Test,
}

impl Target {
    fn flags(self) -> Vec<String> {
        match self {
            Target::Bin => vec!["--crate-type".into(), "bin".into()],
            Target::Lib => vec!["--crate-type".into(), "lib".into()],
            Target::Cdylib => vec!["--crate-type".into(), "cdylib".into()],
            Target::Test => vec!["--test".into()],
        }
    }
}

/// One resolved dependency: the name the source refers to, and the exact artifact it binds to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Extern {
    pub name: String,
    pub path: PathBuf,
}

/// Everything one rustc invocation needs. Ten fields, plus `OUT_DIR` in the environment.
#[derive(Debug, Clone)]
pub struct BuildSpec {
    pub crate_name: String,
    pub edition: String,
    pub crate_root: PathBuf,
    pub target: Target,
    pub opt_level: String,
    /// OUR value, not cargo's. Any stable string works — it only names symbols and the output file.
    pub metadata: String,
    pub out_dir: PathBuf,
    /// Where the rest of the closure is found. Proven relocatable: a moved rlib links fine so long
    /// as the WHOLE closure moved with it.
    pub deps_dir: PathBuf,
    pub externs: Vec<Extern>,
    /// `$OUT_DIR` — the directory holding the materialized `crate.rs` the crate root `include!`s.
    /// Omitting it is not a subtle failure: the crate root resolves to nothing and rustc reports
    /// `E0601: main function not found`, which names neither the cause nor this variable.
    pub out_dir_env: PathBuf,
}

impl BuildSpec {
    /// The full rustc argv. Pure, so it is testable without a toolchain.
    pub fn argv(&self) -> Vec<String> {
        let mut a: Vec<String> = vec![
            "--crate-name".into(),
            self.crate_name.clone(),
            format!("--edition={}", self.edition),
            self.crate_root.display().to_string(),
        ];
        a.extend(self.target.flags());
        a.push("-C".into());
        a.push(format!("opt-level={}", self.opt_level));
        a.push("-C".into());
        a.push(format!("metadata={}", self.metadata));
        a.push("-C".into());
        a.push(format!("extra-filename=-{}", self.metadata));
        a.push("--out-dir".into());
        a.push(self.out_dir.display().to_string());
        a.push("-L".into());
        a.push(format!("dependency={}", self.deps_dir.display()));
        for e in &self.externs {
            a.push("--extern".into());
            a.push(format!("{}={}", e.name, e.path.display()));
        }
        a
    }

    /// The artifact this invocation writes.
    pub fn artifact(&self) -> PathBuf {
        let stem = format!("{}-{}", self.crate_name, self.metadata);
        match self.target {
            Target::Cdylib => self.out_dir.join(format!("lib{stem}.so")),
            Target::Lib => self.out_dir.join(format!("lib{stem}.rlib")),
            Target::Bin | Target::Test => self.out_dir.join(stem),
        }
    }

    /// Compile. `rustc` is passed in rather than found, so a caller pins the toolchain the extern
    /// map was captured against — an rlib is specific to the exact compiler that produced it.
    pub fn compile(&self, rustc: &Path) -> Result<PathBuf, String> {
        let out = std::process::Command::new(rustc)
            .args(self.argv())
            .env("OUT_DIR", &self.out_dir_env)
            .output()
            .map_err(|e| format!("could not run {}: {e}", rustc.display()))?;
        if !out.status.success() {
            return Err(format!(
                "rustc failed for `{}`:\n{}",
                self.crate_name,
                String::from_utf8_lossy(&out.stderr)
            ));
        }
        let art = self.artifact();
        if !art.is_file() {
            return Err(format!("rustc reported success but {} does not exist", art.display()));
        }
        Ok(art)
    }
}

/// One test's outcome.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestOutcome {
    pub name: String,
    pub passed: bool,
}

/// What a test binary reported.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TestReport {
    pub outcomes: Vec<TestOutcome>,
}

impl TestReport {
    pub fn passed(&self) -> usize {
        self.outcomes.iter().filter(|o| o.passed).count()
    }
    pub fn failed(&self) -> usize {
        self.outcomes.iter().filter(|o| !o.passed).count()
    }

    /// Parse libtest's stdout. Reports BY NAME, because "4 passed" does not say which four, and a
    /// suite that silently stopped running a test reports a smaller number that still looks green.
    pub fn parse(stdout: &str) -> TestReport {
        let mut outcomes = Vec::new();
        for line in stdout.lines() {
            let Some(rest) = line.strip_prefix("test ") else { continue };
            let Some((name, verdict)) = rest.rsplit_once(" ... ") else { continue };
            match verdict.trim() {
                "ok" => outcomes.push(TestOutcome { name: name.trim().into(), passed: true }),
                "FAILED" => outcomes.push(TestOutcome { name: name.trim().into(), passed: false }),
                _ => {}
            }
        }
        TestReport { outcomes }
    }
}

/// Compile with `--test` and run the result.
pub fn compile_and_test(spec: &BuildSpec, rustc: &Path) -> Result<TestReport, String> {
    let mut s = spec.clone();
    s.target = Target::Test;
    let bin = s.compile(rustc)?;
    let out = std::process::Command::new(&bin)
        .output()
        .map_err(|e| format!("could not run test binary {}: {e}", bin.display()))?;
    let report = TestReport::parse(&String::from_utf8_lossy(&out.stdout));
    if report.outcomes.is_empty() {
        return Err(format!(
            "{} ran but reported no tests — a test binary that reports nothing is a green result \
             that verified nothing, so this is an error rather than a pass",
            bin.display()
        ));
    }
    Ok(report)
}

/// Capture the extern map from cargo's verbose output — the ONLY sound source. See trap 1.
pub fn externs_from_cargo_log(log: &str, crate_name: &str) -> Vec<Extern> {
    let needle = format!("--crate-name {crate_name} ");
    for inv in log.split("Running `").skip(1) {
        let inv = inv.split("`\n").next().unwrap_or(inv);
        if !inv.contains(&needle) {
            continue;
        }
        let mut out = Vec::new();
        let toks: Vec<&str> = inv.split_whitespace().collect();
        for (i, t) in toks.iter().enumerate() {
            if *t == "--extern" {
                if let Some((n, p)) = toks.get(i + 1).and_then(|s| s.split_once('=')) {
                    out.push(Extern { name: n.to_string(), path: PathBuf::from(p) });
                }
            }
        }
        if !out.is_empty() {
            return out;
        }
    }
    Vec::new()
}

/// Every rlib in `deps_dir` whose name matches `crate_name` — what a GLOB would have to choose
/// between. Exists to make the ambiguity measurable rather than asserted.
pub fn rlib_variants(deps_dir: &Path, crate_name: &str) -> Vec<PathBuf> {
    let prefix = format!("lib{}-", crate_name.replace('-', "_"));
    let Ok(rd) = std::fs::read_dir(deps_dir) else { return Vec::new() };
    let mut v: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            p.extension().is_some_and(|x| x == "rlib")
                && p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with(&prefix))
        })
        .collect();
    v.sort();
    v
}

/// The dependency closure, parsed from `cargo tree` output.
///
/// `cargo tree` is used rather than a build log FOR A REASON — see trap 2. A build log lists what was
/// recompiled, which on any warm tree is a strict subset of what is needed.
pub fn closure_from_tree(tree_stdout: &str) -> Vec<String> {
    let mut v: Vec<String> = tree_stdout
        .lines()
        .filter_map(|l| l.split_whitespace().next())
        .filter(|s| !s.is_empty() && !s.starts_with('[') && *s != "|" && *s != "└──" && *s != "├──")
        .map(|s| s.to_string())
        .collect();
    v.sort();
    v.dedup();
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch directory under `target/`, never under `/tmp` — the shared tmpfs on this box runs at
    /// 99% and a test that fails on ENOSPC blames the wrong thing.
    fn scratch(tag: &str) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let d = root.join("target").join("gm-drive-tests").join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn argv_carries_every_field_the_invocation_needs() {
        let spec = BuildSpec {
            crate_name: "bsc_hook".into(),
            edition: "2021".into(),
            crate_root: "crate_root.rs".into(),
            target: Target::Test,
            opt_level: "1".into(),
            metadata: "v1".into(),
            out_dir: "/out".into(),
            deps_dir: "/deps".into(),
            externs: vec![Extern { name: "serde_json".into(), path: "/deps/libserde_json-abc.rlib".into() }],
            out_dir_env: "/gen".into(),
        };
        let a = spec.argv().join(" ");
        assert!(a.contains("--crate-name bsc_hook"));
        assert!(a.contains("--edition=2021"));
        assert!(a.contains("--test"), "a Test target must pass --test, not --crate-type");
        assert!(a.contains("-L dependency=/deps"));
        assert!(a.contains("--extern serde_json=/deps/libserde_json-abc.rlib"));
        assert_eq!(spec.artifact(), PathBuf::from("/out/bsc_hook-v1"));
    }

    #[test]
    fn a_cdylib_and_a_lib_name_their_artifacts_differently() {
        let mk = |t| BuildSpec {
            crate_name: "p".into(), edition: "2021".into(), crate_root: "r.rs".into(), target: t,
            opt_level: "1".into(), metadata: "m".into(), out_dir: "/o".into(), deps_dir: "/d".into(),
            externs: vec![], out_dir_env: "/g".into(),
        };
        assert_eq!(mk(Target::Cdylib).artifact(), PathBuf::from("/o/libp-m.so"));
        assert_eq!(mk(Target::Lib).artifact(), PathBuf::from("/o/libp-m.rlib"));
        assert_eq!(mk(Target::Bin).artifact(), PathBuf::from("/o/p-m"));
    }

    /// TRAP 1, pinned. Two rlibs share a crate name and differ only by cargo's metadata hash; a glob
    /// picks by sort order, which is not the same thing as picking correctly.
    #[test]
    fn a_glob_would_pick_a_different_rlib_than_the_captured_map() {
        let d = scratch("glob");
        std::fs::write(d.join("libserde_json-aaaaaaaa.rlib"), b"variant A").unwrap();
        std::fs::write(d.join("libserde_json-zzzzzzzz.rlib"), b"variant B").unwrap();
        let variants = rlib_variants(&d, "serde_json");
        assert_eq!(variants.len(), 2, "the ambiguity this guards must actually be present");

        // What cargo ACTUALLY linked, captured from its own output.
        let log = format!(
            "Running `rustc --crate-name bsc_hook --edition=2021 x.rs --extern serde_json={}`\n",
            d.join("libserde_json-zzzzzzzz.rlib").display()
        );
        let captured = externs_from_cargo_log(&log, "bsc_hook");
        assert_eq!(captured.len(), 1);
        assert_ne!(
            captured[0].path, variants[0],
            "the captured extern and the first glob hit must differ, or this guard proves nothing"
        );
        assert_eq!(captured[0].path, variants[1]);
    }

    /// TRAP 2, pinned. An incremental log lists what was RECOMPILED, which is a strict subset of the
    /// closure on any warm tree — and the resulting E0463 names a crate that is present.
    #[test]
    fn an_incremental_log_yields_a_short_closure() {
        // Verbatim shape of what `cargo build -p bsc-hook -v` printed on a warm tree.
        let incremental = "\
Running `rustc --crate-name serde_core --edition=2021 a.rs`
Running `rustc --crate-name serde_json --edition=2021 b.rs`
Running `rustc --crate-name bsc_util --edition=2021 c.rs`
";
        let recompiled: Vec<String> = incremental
            .lines()
            .filter_map(|l| l.split("--crate-name ").nth(1))
            .filter_map(|s| s.split_whitespace().next())
            .map(|s| s.to_string())
            .collect();
        assert_eq!(recompiled.len(), 3, "the warm log really does mention only three");

        // What `cargo tree -p bsc-hook --prefix none` reports — the TRUE closure.
        let tree = "bsc-hook\nbsc-util\nitoa\nmemchr\nserde_core\nserde_json\nzmij\n";
        let closure = closure_from_tree(tree);
        assert_eq!(closure.len(), 7, "bsc-hook's true closure is 7 crates");
        for missed in ["itoa", "memchr", "zmij"] {
            assert!(closure.contains(&missed.to_string()));
            assert!(
                !recompiled.contains(&missed.to_string()),
                "{missed} is exactly the kind of crate a build log omits"
            );
        }
    }

    #[test]
    fn a_report_names_each_test_rather_than_counting_them() {
        let out = "\nrunning 3 tests\ntest tests::alpha ... ok\ntest tests::beta ... FAILED\ntest tests::gamma ... ok\n";
        let r = TestReport::parse(out);
        assert_eq!(r.passed(), 2);
        assert_eq!(r.failed(), 1);
        assert_eq!(r.outcomes[1], TestOutcome { name: "tests::beta".into(), passed: false });
    }

    /// END TO END, hermetic: materialize a crate body, compile it with `--test` through the REAL
    /// shared crate root, run it, and read the results back. No cargo, no network, no prebuilt deps.
    #[test]
    fn a_crate_compiles_and_its_tests_run_without_cargo() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let d = scratch("e2e");
        let gen = d.join("gen");
        std::fs::create_dir_all(&gen).unwrap();
        // What the materializer writes: the crate body plus the crate's own doc.
        std::fs::write(gen.join("crate_doc.md"), "//! scratch\n").unwrap();
        std::fs::write(
            gen.join("crate.rs"),
            "pub fn double(n: i32) -> i32 { n * 2 }\n\
             #[cfg(test)] mod tests {\n\
             use super::*;\n\
             #[test] fn doubling_works() { assert_eq!(double(21), 42); }\n\
             #[test] fn doubling_zero_is_zero() { assert_eq!(double(0), 0); }\n\
             }\n",
        )
        .unwrap();

        let spec = BuildSpec {
            crate_name: "scratch_crate".into(),
            edition: "2021".into(),
            // THE REAL shared root, so this exercises the file every migrated crate compiles from.
            crate_root: root.join("crates/graph-materialize/crate_root.rs"),
            target: Target::Test,
            opt_level: "0".into(),
            metadata: "e2e".into(),
            out_dir: d.join("out"),
            deps_dir: d.join("out"),
            externs: vec![],
            out_dir_env: gen.clone(),
        };
        std::fs::create_dir_all(&spec.out_dir).unwrap();

        let report = compile_and_test(&spec, Path::new("rustc")).expect("driver must build and run");
        assert_eq!(report.failed(), 0, "{:?}", report.outcomes);
        assert_eq!(report.passed(), 2, "both carried tests must run: {:?}", report.outcomes);
        let names: Vec<&str> = report.outcomes.iter().map(|o| o.name.as_str()).collect();
        assert!(names.contains(&"tests::doubling_works"), "got {names:?}");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Omitting `OUT_DIR` is the one failure whose message names neither the cause nor the variable.
    #[test]
    fn a_missing_out_dir_fails_loudly_rather_than_producing_an_empty_crate() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap();
        let d = scratch("nooutdir");
        let spec = BuildSpec {
            crate_name: "scratch_crate".into(), edition: "2021".into(),
            crate_root: root.join("crates/graph-materialize/crate_root.rs"),
            target: Target::Lib, opt_level: "0".into(), metadata: "n".into(),
            out_dir: d.clone(), deps_dir: d.clone(), externs: vec![],
            out_dir_env: d.join("does-not-exist"),
        };
        let err = spec.compile(Path::new("rustc")).expect_err("a missing OUT_DIR must not succeed");
        assert!(err.contains("rustc failed"), "got: {err}");
        let _ = std::fs::remove_dir_all(&d);
    }
}
