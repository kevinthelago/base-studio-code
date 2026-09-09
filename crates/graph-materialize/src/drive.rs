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
    /// `--cfg` flags — in practice `feature="x"`, since a feature is just a cfg to rustc. Cargo's
    /// feature RESOLUTION is a different thing and stays cargo's job; this is only its output.
    pub cfgs: Vec<String>,
    /// Link std dynamically. See [`Profile::prefer_dynamic`] for the 53x measurement.
    pub prefer_dynamic: bool,
    /// Where the loader finds `libstd`. Without it a `prefer_dynamic` artifact links and then fails
    /// at load time.
    pub rpath: Option<PathBuf>,
    /// Extra environment for the compile — `CARGO_CRATE_NAME` for a `[[test]]` target, which the
    /// shared test root reads to select its body.
    pub extra_env: Vec<(String, String)>,
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
        for c in &self.cfgs {
            a.push("--cfg".into());
            a.push(c.clone());
        }
        if self.prefer_dynamic {
            a.push("-C".into());
            a.push("prefer-dynamic".into());
        }
        if let Some(r) = &self.rpath {
            a.push("-C".into());
            a.push(format!("link-arg=-Wl,-rpath,{}", r.display()));
        }
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
            .envs(self.extra_env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
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

// ── From a record to an invocation ──────────────────────────────────────────────────────────────

use crate::manifest::{CrateRecord, Dep, TargetKind};
use std::collections::BTreeMap;

/// The build profile — the workspace `[profile.dev]` equivalent, as data.
#[derive(Debug, Clone)]
pub struct Profile {
    pub opt_level: String,
    /// Share one `libstd` across every artifact instead of copying it into each.
    ///
    /// MEASURED 2026-09-09: an EMPTY cdylib is 4.47 MB and the same plugin with `serde_json` is
    /// 4.57 MB — so 98% of a statically linked plugin is std, not dependencies. With this on, the
    /// same plugin is 0.086 MB, a 53x reduction. It is the difference between 47 subcommands costing
    /// ~212 MB and costing ~4 MB.
    pub prefer_dynamic: bool,
    /// Where the loader finds `libstd` at runtime. REQUIRED when `prefer_dynamic` is set: without it
    /// the artifact links cleanly and then fails at `dlopen` with `libstd-<hash>.so: cannot open
    /// shared object file`, which names neither this flag nor the toolchain.
    pub rpath: Option<PathBuf>,
}

impl Default for Profile {
    fn default() -> Self {
        Profile { opt_level: "1".into(), prefer_dynamic: false, rpath: None }
    }
}

/// Crate name to the exact artifact it binds to, CAPTURED from cargo — never computed, never globbed.
/// See trap 1 at the top of this module.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExternMap {
    map: BTreeMap<String, PathBuf>,
}

impl ExternMap {
    /// Union every `--extern` cargo issued across a verbose build.
    ///
    /// The log must come from a build that actually compiled the closure. A WARM build mentions only
    /// what it recompiled — see trap 2 — so a map built from one is short, and the omission surfaces
    /// later as an `E0463` naming a crate that IS present.
    pub fn from_cargo_log(log: &str) -> ExternMap {
        let mut map = BTreeMap::new();
        for inv in log.split("Running `").skip(1) {
            let inv = inv.split("`\n").next().unwrap_or(inv);
            let toks: Vec<&str> = inv.split_whitespace().collect();
            for (i, t) in toks.iter().enumerate() {
                if *t == "--extern" {
                    if let Some((n, p)) = toks.get(i + 1).and_then(|s| s.split_once('=')) {
                        map.insert(n.to_string(), PathBuf::from(p));
                    }
                }
            }
        }
        ExternMap { map }
    }

    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// Look a dependency up by the name the SOURCE uses.
    ///
    /// A manifest key is a PACKAGE name (`bsc-util`); rustc wants the LIB name (`bsc_util`). The two
    /// differ by more than dashes when `[lib] name` overrides the default — `crates/llm` is package
    /// `bsc-llm` — so both spellings are tried rather than assuming one rule.
    pub fn get(&self, dep_name: &str) -> Option<&Path> {
        self.map
            .get(dep_name)
            .or_else(|| self.map.get(&dep_name.replace('-', "_")))
            .map(|p| p.as_path())
    }

    /// Resolve a dependency set, FAILING by name on anything missing.
    ///
    /// Silently dropping an unresolved dependency is the expensive failure: rustc then reports
    /// `E0463` against whichever crate first referenced it, which is usually not the missing one.
    pub fn resolve(&self, deps: &[&Dep]) -> Result<Vec<Extern>, String> {
        let mut out = Vec::new();
        let mut missing = Vec::new();
        for d in deps {
            match self.get(&d.name) {
                Some(p) => out.push(Extern {
                    name: d.name.replace('-', "_"),
                    path: p.to_path_buf(),
                }),
                None => missing.push(d.name.clone()),
            }
        }
        if !missing.is_empty() {
            return Err(format!(
                "no captured extern for {missing:?} — the map holds {} entries. A map built from a \
                 WARM cargo build lists only what was recompiled; capture from a build that actually \
                 compiled the closure, or the omission resurfaces as an E0463 naming a different crate.",
                self.map.len()
            ));
        }
        Ok(out)
    }
}

/// Where a crate's artifacts and generated source live.
#[derive(Debug, Clone)]
pub struct Dirs {
    pub out_dir: PathBuf,
    pub deps_dir: PathBuf,
    /// `$OUT_DIR` — where the materializer wrote `crate.rs` and `crate_doc.md`.
    pub generated: PathBuf,
}

impl BuildSpec {
    /// Build the invocation for one crate and one target, from its record.
    ///
    /// `features` are passed in rather than read off the record: a feature is enabled by whoever
    /// DEPENDS on a crate, so the set is a property of the build being planned, not of the crate.
    pub fn for_crate(
        rec: &CrateRecord,
        target: &TargetKind,
        externs: &ExternMap,
        profile: &Profile,
        dirs: &Dirs,
        features: &[String],
        shared_root: &Path,
    ) -> Result<BuildSpec, String> {
        // A `--test` build sees dev-dependencies as well; every other target must NOT, or a dev-only
        // crate is linked into a shipped artifact.
        let is_test = matches!(target, TargetKind::Test { .. });
        let mut deps: Vec<&Dep> = rec.normal_deps();
        if is_test {
            deps.extend(rec.dev_deps());
        }
        let externs = externs.resolve(&deps)?;

        let (kind, name, path) = match target {
            TargetKind::Lib { path } => (Target::Lib, rec.name.clone(), path.clone()),
            TargetKind::Bin { name, path } => (Target::Bin, name.clone(), path.clone()),
            TargetKind::Test { name, path } => (Target::Test, name.clone(), path.clone()),
        };
        let crate_name = name.replace('-', "_");

        let mut extra_env = Vec::new();
        if let TargetKind::Test { name, .. } = target {
            // `test_root.rs` selects its body with `env!("CARGO_CRATE_NAME")`, which is the TARGET's
            // name and not the package's — two `[[test]]` entries share one root file and must still
            // resolve different bodies. So this is set per target, never once per crate.
            extra_env.push(("CARGO_CRATE_NAME".to_string(), name.replace('-', "_")));
        }

        Ok(BuildSpec {
            crate_name: crate_name.clone(),
            edition: rec.edition.clone(),
            crate_root: path.map(|p| dirs.generated.join("..").join(p)).unwrap_or_else(|| shared_root.to_path_buf()),
            target: kind,
            opt_level: profile.opt_level.clone(),
            metadata: crate_name,
            out_dir: dirs.out_dir.clone(),
            deps_dir: dirs.deps_dir.clone(),
            externs,
            out_dir_env: dirs.generated.clone(),
            cfgs: features.iter().map(|f| format!("feature=\"{f}\"")).collect(),
            prefer_dynamic: profile.prefer_dynamic,
            rpath: profile.rpath.clone(),
            extra_env,
        })
    }
}

// ── Materialize, then compile ───────────────────────────────────────────────────────────────────

/// Generate a crate's source from the graph store into `generated`, ready for a compile.
///
/// This CALLS the materializer rather than reimplementing it. `build.rs`, `src/lib.rs` and this
/// function all reach the same `emit_into`, so a driver build and a cargo build cannot diverge in
/// what they compile — the divergence would be invisible, since both produce a `crate.rs` that looks
/// plausible. Returns the module count, which is `0` only for an optional adopter.
pub fn materialize(
    repo_root: &Path,
    crate_dir: &str,
    generated: &Path,
    adoption: crate::Adoption,
) -> Result<usize, String> {
    std::fs::create_dir_all(generated)
        .map_err(|e| format!("cannot create {}: {e}", generated.display()))?;
    crate::emit_into(&repo_root.join("crates").join(crate_dir), generated, Some(repo_root), adoption)
}

/// The driver's environment — where the repo is, which toolchain, and the profile and directories
/// every build under it shares.
///
/// A struct rather than a parameter list because those four travel together for the whole of a build
/// and none of them varies per crate. (Passing them individually also put `build_crate` at 8
/// arguments, which clippy refuses at 7 — the lint was right about the shape.)
#[derive(Debug, Clone)]
pub struct Driver {
    pub repo_root: PathBuf,
    /// Passed rather than found, so the caller pins the toolchain the extern map was captured
    /// against — an rlib is specific to the exact compiler that produced it.
    pub rustc: PathBuf,
    pub profile: Profile,
    pub dirs: Dirs,
}

impl Driver {
    /// Materialize a crate and compile one of its targets — records to artifact, no cargo.
    pub fn build(
        &self,
        rec: &CrateRecord,
        target: &TargetKind,
        externs: &ExternMap,
        features: &[String],
    ) -> Result<PathBuf, String> {
        self.spec(rec, target, externs, features)?.compile(&self.rustc)
    }

    /// Materialize and compile as a test target, then run it.
    pub fn test(
        &self,
        rec: &CrateRecord,
        target: &TargetKind,
        externs: &ExternMap,
        features: &[String],
    ) -> Result<TestReport, String> {
        let spec = self.spec(rec, target, externs, features)?;
        compile_and_test(&spec, &self.rustc)
    }

    /// Generate the crate's source, then plan its invocation.
    fn spec(
        &self,
        rec: &CrateRecord,
        target: &TargetKind,
        externs: &ExternMap,
        features: &[String],
    ) -> Result<BuildSpec, String> {
        materialize(&self.repo_root, &rec.dir, &self.dirs.generated, crate::Adoption::Required)?;
        let shared = self.repo_root.join("crates/graph-materialize/crate_root.rs");
        BuildSpec::for_crate(rec, target, externs, &self.profile, &self.dirs, features, &shared)
    }
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
            out_dir_env: "/gen".into(), cfgs: vec![], prefer_dynamic: false, rpath: None, extra_env: vec![],
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
            externs: vec![], out_dir_env: "/g".into(), cfgs: vec![], prefer_dynamic: false, rpath: None, extra_env: vec![],
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
            out_dir_env: gen.clone(), cfgs: vec![], prefer_dynamic: false, rpath: None, extra_env: vec![],
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
            out_dir_env: d.join("does-not-exist"), cfgs: vec![], prefer_dynamic: false, rpath: None, extra_env: vec![],
        };
        let err = spec.compile(Path::new("rustc")).expect_err("a missing OUT_DIR must not succeed");
        assert!(err.contains("rustc failed"), "got: {err}");
        let _ = std::fs::remove_dir_all(&d);
    }
}

#[cfg(test)]
mod record_to_invocation_tests {
    use super::*;
    use crate::manifest::{CrateRecord, Manifest, TargetKind};

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
    }

    fn record(dir: &str) -> CrateRecord {
        let src = std::fs::read_to_string(repo().join("crates").join(dir).join("Cargo.toml")).unwrap();
        CrateRecord::extract(&Manifest::parse(&src).unwrap(), dir)
    }

    /// An extern map that resolves everything a record asks for, so these tests exercise the MAPPING
    /// rather than the capture (which `a_glob_would_pick_a_different_rlib_than_the_captured_map`
    /// already covers).
    fn map_for(rec: &CrateRecord) -> ExternMap {
        let mut log = String::from("Running `rustc --crate-name x");
        for d in rec.deps.iter() {
            log.push_str(&format!(" --extern {}=/deps/lib{}-h.rlib", d.name.replace('-', "_"), d.name.replace('-', "_")));
        }
        log.push_str("`\n");
        ExternMap::from_cargo_log(&log)
    }

    fn dirs() -> Dirs {
        Dirs { out_dir: "/out".into(), deps_dir: "/deps".into(), generated: "/gen".into() }
    }

    fn spec(rec: &CrateRecord, t: &TargetKind, feats: &[String], p: &Profile) -> BuildSpec {
        BuildSpec::for_crate(rec, t, &map_for(rec), p, &dirs(), feats, Path::new("/shared/crate_root.rs"))
            .expect("the synthetic map resolves every dependency")
    }

    /// SHAPE 1 — dev-dependencies widen ONLY the test build. Getting this wrong links a dev-only
    /// crate into a shipped artifact, which nothing downstream would flag.
    #[test]
    fn dev_dependencies_reach_the_test_build_and_nothing_else() {
        let rec = std::fs::read_dir(repo().join("crates"))
            .unwrap()
            .flatten()
            .filter_map(|e| {
                let d = e.file_name().to_string_lossy().to_string();
                let r = record(&d);
                (!r.dev_deps().is_empty() && !r.normal_deps().is_empty()).then_some(r)
            })
            .next()
            .expect("20 crates carry dev-dependencies; finding none means the projection broke");

        let dev: Vec<String> = rec.dev_deps().iter().map(|d| d.name.replace('-', "_")).collect();
        let lib = spec(&rec, &TargetKind::Lib { path: None }, &[], &Profile::default());
        let tst = spec(&rec, &TargetKind::Test { name: "t".into(), path: None }, &[], &Profile::default());

        let names = |s: &BuildSpec| -> Vec<String> { s.externs.iter().map(|e| e.name.clone()).collect() };
        for d in &dev {
            assert!(!names(&lib).contains(d), "{d} is a DEV dependency and must not reach the lib build");
            assert!(names(&tst).contains(d), "{d} must reach the test build");
        }
        assert!(names(&tst).len() > names(&lib).len());
    }

    /// SHAPE 2 — a feature is a `--cfg` to rustc. Cargo's feature RESOLUTION stays cargo's job; this
    /// is only its output, which is why the set is passed in rather than read off the record.
    #[test]
    fn features_become_cfg_flags() {
        let rec = record("bsc-sqlite-util");
        assert!(rec.features.contains(&"conn".to_string()), "bsc-sqlite-util declares the `conn` feature");
        let s = spec(&rec, &TargetKind::Lib { path: None }, &["conn".to_string()], &Profile::default());
        let a = s.argv().join(" ");
        assert!(a.contains(r#"--cfg feature="conn""#), "got: {a}");
        let none = spec(&rec, &TargetKind::Lib { path: None }, &[], &Profile::default());
        assert!(!none.argv().join(" ").contains("--cfg"), "no features means no --cfg");
    }

    /// SHAPE 3 — a `[[test]]` target's body is selected by `CARGO_CRATE_NAME`, which is the TARGET's
    /// name, not the package's. Two targets share one root file, so this must be set per target.
    #[test]
    fn a_test_target_carries_its_own_crate_name_in_the_environment() {
        let rec = record("bsc-publish");
        let names: Vec<String> = rec
            .targets
            .iter()
            .filter_map(|t| match t {
                TargetKind::Test { name, .. } => Some(name.clone()),
                _ => None,
            })
            .collect();
        assert!(names.len() >= 2, "bsc-publish declares two [[test]] targets sharing one root: {names:?}");

        for n in &names {
            let s = spec(&rec, &TargetKind::Test { name: n.clone(), path: None }, &[], &Profile::default());
            assert_eq!(
                s.extra_env.iter().find(|(k, _)| k == "CARGO_CRATE_NAME").map(|(_, v)| v.as_str()),
                Some(n.replace('-', "_").as_str()),
                "each target must resolve its OWN body"
            );
        }
        // The two targets must not collide on one artifact name.
        let a = spec(&rec, &TargetKind::Test { name: names[0].clone(), path: None }, &[], &Profile::default());
        let b = spec(&rec, &TargetKind::Test { name: names[1].clone(), path: None }, &[], &Profile::default());
        assert_ne!(a.artifact(), b.artifact());
    }

    /// A missing extern must fail BY NAME. Dropping it silently produces an E0463 against whichever
    /// crate referenced it, which is usually not the missing one.
    #[test]
    fn an_unresolved_dependency_is_named_rather_than_dropped() {
        let rec = record("plandb");
        let empty = ExternMap::default();
        let err = BuildSpec::for_crate(
            &rec, &TargetKind::Lib { path: None }, &empty, &Profile::default(), &dirs(), &[],
            Path::new("/shared/crate_root.rs"),
        )
        .expect_err("an empty map must not silently produce a spec with no externs");
        assert!(err.contains("bsc-sqlite-util") || err.contains("serde_json"), "must name what is missing: {err}");
        assert!(err.contains("E0463"), "and must say why the later failure would mislead: {err}");
    }

    /// A package name is not a lib name. `crates/llm` is package `bsc-llm`; the source says `bsc_llm`.
    #[test]
    fn a_dependency_resolves_under_either_spelling() {
        let m = ExternMap::from_cargo_log("Running `rustc --extern bsc_util=/deps/libbsc_util-h.rlib`\n");
        assert!(m.get("bsc_util").is_some());
        assert!(m.get("bsc-util").is_some(), "a manifest key uses dashes; rustc uses underscores");
        assert!(m.get("nope").is_none());
    }

    /// The size lever, as flags. 4.57 MB -> 0.086 MB; see `Profile::prefer_dynamic`.
    #[test]
    fn prefer_dynamic_emits_both_the_flag_and_the_rpath_it_requires() {
        let rec = record("bsc-hook");
        let p = Profile {
            opt_level: "1".into(),
            prefer_dynamic: true,
            rpath: Some(PathBuf::from("/tc/lib/rustlib/x86_64-unknown-linux-gnu/lib")),
        };
        let a = spec(&rec, &TargetKind::Bin { name: "bsc-hook".into(), path: None }, &[], &p).argv().join(" ");
        assert!(a.contains("-C prefer-dynamic"));
        assert!(
            a.contains("-C link-arg=-Wl,-rpath,/tc/lib/rustlib"),
            "without the rpath the artifact links and then fails at dlopen: {a}"
        );
    }
}

#[cfg(test)]
mod materialize_tests {
    use super::*;
    use crate::manifest::{CrateRecord, Manifest};

    fn repo() -> &'static Path {
        Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap()
    }

    fn scratch(tag: &str) -> PathBuf {
        let d = repo().join("target").join("gm-drive-tests").join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// THE EQUIVALENCE GUARD: what the driver generates must be byte-identical to what cargo's build
    /// script generated for the same crate.
    ///
    /// Compared at the SOURCE level rather than by diffing artifacts, deliberately. Two rustc runs of
    /// identical source can differ in bytes (`-C metadata` feeds symbol names, and the driver chooses
    /// its own), so an artifact comparison would fail for a reason that does not matter. If the
    /// generated source matches and the invocation matches, the compile has nothing left to disagree
    /// about — and this needs no rlibs, so it holds on a cold tree.
    ///
    /// TWO MODES, and neither is a silent skip. When cargo has already built a materialized crate its
    /// `$OUT_DIR/crate.rs` is on disk and is compared byte-for-byte. When the tree is cold there is
    /// nothing to compare against, so the driver's own output is checked for substance instead.
    #[test]
    fn the_drivers_materialization_matches_what_cargo_generated() {
        let build = repo().join("target/debug/build");
        let mut compared = 0usize;
        let mut checked = 0usize;

        // A SMALL, FIXED SET — and the reason is a limitation of the guard itself, worth stating so
        // nobody widens it again. This compares against cargo's CACHED `$OUT_DIR/crate.rs`, which is
        // legitimately stale until cargo rebuilds that crate. Widened to all 74 it fails on any
        // partially-warm tree (measured: `bsc` reported drift purely because it had not been rebuilt
        // since develop moved), which is a flaky guard rather than a stricter one. These four are
        // enough to catch a rendering or resolution difference, which is what it is for.
        for dir in ["bsc-hook", "bsc-disk", "bsc-publish", "plandb"] {
            let src = std::fs::read_to_string(repo().join("crates").join(dir).join("Cargo.toml")).unwrap();
            let rec = CrateRecord::extract(&Manifest::parse(&src).unwrap(), dir);
            assert!(rec.materialized, "{dir} is expected to compile from records");

            let gen = scratch(&format!("mat-{dir}")).join("out");
            let n = materialize(repo(), dir, &gen, crate::Adoption::Required)
                .unwrap_or_else(|e| panic!("{dir}: {e}"));
            assert!(n > 0, "{dir} materialized 0 modules — an empty crate is the silent-success failure");
            let ours = std::fs::read_to_string(gen.join("crate.rs")).unwrap();
            assert!(ours.len() > 200, "{dir}: generated body is implausibly small ({} bytes)", ours.len());
            checked += 1;

            // Cargo's copy, if this tree has been built — the NEWEST one.
            //
            // A crate accumulates build directories: cargo never reclaims an old one, so every
            // distinct feature set, profile and rustc version leaves its own `<crate>-<hash>/out/`
            // behind. MEASURED after merging develop, `plandb` had FIVE, two current at 830404 bytes
            // and three stale at 786825-792032 from before the store changed.
            //
            // An earlier version took `.find()` over an unordered `read_dir`, which picks an
            // arbitrary one, and it duly reported a difference against a copy generated before the
            // merge. That is the same mistake this module warns about for rlibs one tier down —
            // selecting arbitrarily among candidates that a name cannot tell apart — so it is fixed
            // the same way: choose deliberately, here by modification time.
            let mut candidates: Vec<(std::time::SystemTime, PathBuf)> = std::fs::read_dir(&build)
                .into_iter()
                .flatten()
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.starts_with(&format!("{dir}-")))
                })
                .map(|p| p.join("out/crate.rs"))
                .filter(|p| p.is_file())
                .filter_map(|p| std::fs::metadata(&p).and_then(|m| m.modified()).ok().map(|t| (t, p)))
                .collect();
            candidates.sort_by_key(|(t, _)| std::cmp::Reverse(*t));
            let cargos = candidates.first().map(|(_, p)| p.clone());
            if let Some(c) = cargos {
                let theirs = std::fs::read_to_string(&c).unwrap();
                assert_eq!(
                    ours, theirs,
                    "{dir}: the driver and cargo generated DIFFERENT source. They call the same \
                     emit_into, so a difference means the driver resolved a different store, root or \
                     adoption — not a rendering bug."
                );
                compared += 1;
            }
            let _ = std::fs::remove_dir_all(gen.parent().unwrap());
        }

        assert_eq!(checked, 4, "every named crate must be materialized, not skipped");
        if build.is_dir() {
            assert!(
                compared >= 1,
                "target/debug/build exists but no crate's cargo-generated crate.rs was found, so the \
                 byte-for-byte half of this guard verified nothing. That is a broken lookup, not a \
                 cold tree."
            );
        }
    }

    /// A crate that owns no records must FAIL under `Required`, never emit an empty module.
    #[test]
    fn a_crate_with_no_records_is_an_error_rather_than_an_empty_crate() {
        let gen = scratch("norecords").join("out");
        // `graph-materialize` itself owns no records — it is the materializer and cannot materialize
        // itself, which is exactly the "opted in but owns nothing" case the hard error exists for.
        let err = materialize(repo(), "graph-materialize", &gen, crate::Adoption::Required)
            .expect_err("a required adopter with no records must not silently produce an empty crate");
        assert!(!err.is_empty());
        let _ = std::fs::remove_dir_all(gen.parent().unwrap());
    }
}
