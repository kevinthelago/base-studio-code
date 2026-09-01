//! Tests for the record-backed command surface, generalized past the JSON-store family
//! (`generalize-the-surface-record-beyond-json-store`).
//!
//! Weighted toward the FALLBACK and REFUSAL paths rather than the happy one, for the reason the spike
//! recorded: a surface that loads correctly announces itself the moment you run a verb, while a surface
//! that silently reverts to the compiled catalog looks exactly like one that was never written.
//!
//! The env var these tests set is process-global, so the ones that touch it run under `ENV_LOCK`.
//! `cargo nextest` gives each test its own process and would not need it; `cargo test` threads them
//! inside one binary and does.

use crate::surface::{
    commands_from_json, resolve_surface, surface_from_json, surface_key, surface_to_json,
};
use crate::{handle_help, unknown_command, CmdDoc};

/// Serializes the tests that write `$BSC_SURFACE_DIR`. See the module note.
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

const COMMANDS: &[CmdDoc] = &[
    CmdDoc { name: "tree", summary: "folder structure with sizes", usage: "USAGE:\n  bsc files tree [path]" },
    CmdDoc { name: "read", summary: "one file's text", usage: "USAGE:\n  bsc files read <path>" },
];
const TAGLINE: &str = "the file surface";

/// A scratch surface dir that removes itself, so a failing assertion cannot leak the env var into the
/// next test in the same process.
struct Scratch {
    dir: std::path::PathBuf,
    _guard: std::sync::MutexGuard<'static, ()>,
}

impl Scratch {
    fn new(tag: &str) -> Self {
        let guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let dir = std::env::temp_dir().join(format!("bsc-cli-surface-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("BSC_SURFACE_DIR", &dir);
        Self { dir, _guard: guard }
    }
    fn write(&self, key: &str, body: &str) {
        std::fs::write(self.dir.join(format!("{key}.json")), body).unwrap();
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        std::env::remove_var("BSC_SURFACE_DIR");
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ── the record key ──────────────────────────────────────────────────────────────────────────────────

/// The key is what decides whether a record is FOUND, and a key that misses is a silent no-op — the
/// one failure this module is built to avoid. So the mapping is pinned rather than left to inspection.
#[test]
fn the_record_key_is_the_prog_without_its_bsc_prefix() {
    let key = |p: &str| surface_key(p).expect("a real prog must produce a key");

    // Backward compatibility with the five surfaces the spike shipped: their records are keyed on
    // `CliSpec::noun`, which is exactly the last token of `prog`. Changing this orphans them.
    assert_eq!(key("bsc persona"), "persona");
    assert_eq!(key("bsc files"), "files");

    // A NESTED surface keeps its whole path. `bsc logs scope` must not answer to `scope.json`: that
    // name is equally a future top-level `bsc scope`'s, and a record loaded by the WRONG CLI is worse
    // than one never found — it would replace a working catalog with an unrelated one.
    assert_eq!(key("bsc logs scope"), "logs-scope");

    // A standalone bin has no `bsc ` prefix to strip and stays addressable rather than keyless.
    assert_eq!(key("bsc-files"), "bsc-files");
    assert_eq!(key("bsc"), "bsc");
}

/// `surface_key` is `pub` and its result is joined onto the surfaces directory. Every caller today
/// passes a compile-time literal, so no separator can reach it — but a `pub fn` in that shape must not
/// be the thing that lets a future dynamic caller escape the directory. Traversal is made
/// UNREPRESENTABLE (there is no key to join) rather than defended against downstream.
#[test]
fn a_key_that_is_not_a_bare_filename_has_no_record_at_all() {
    for hostile in ["bsc ../../etc/passwd", "bsc a/b", "bsc a\\b", "bsc ..", "bsc .", "bsc C:evil", "   "] {
        assert_eq!(surface_key(hostile), None, "`{hostile}` must not resolve to a record path");
    }
}

/// ...and resolution treats an unusable key exactly as it treats a missing record: the compiled
/// catalog, silently. NOT a warning — there is no record here to be wrong about, and a CLI that
/// complained on every invocation about a name nobody wrote would be noise.
#[test]
fn an_unusable_key_falls_back_silently_like_a_missing_record() {
    let _s = Scratch::new("hostile-key");
    let (t, c) = resolve_surface("bsc ../../etc/passwd", TAGLINE, COMMANDS);
    assert_eq!(t, TAGLINE);
    assert_eq!(c.len(), COMMANDS.len());
}

// ── the round trip ──────────────────────────────────────────────────────────────────────────────────

/// A compiled catalog must survive a trip through the record format unchanged. This is what makes the
/// record EDITABLE — dump the real surface, change one line, and the rest comes back identical rather
/// than subtly lossy.
#[test]
fn a_catalog_round_trips_through_the_record_format() {
    let v = surface_to_json(TAGLINE, COMMANDS);
    let names: Vec<&str> = COMMANDS.iter().map(|c| c.name).collect();
    let (tagline, cmds) = surface_from_json(&v, &names).expect("the dumped surface must parse");
    assert_eq!(tagline, Some(TAGLINE));
    assert_eq!(cmds.len(), COMMANDS.len());
    for (a, b) in cmds.iter().zip(COMMANDS) {
        assert_eq!((a.name, a.summary, a.usage), (b.name, b.summary, b.usage));
    }
}

/// An absent `tagline` means "keep the compiled one", so a record need only state what it changes.
/// Defaulting it to something — an empty string, the noun — would silently blank a CLI's one-line
/// description the moment anyone wrote a commands-only record.
#[test]
fn an_absent_tagline_is_kept_rather_than_defaulted() {
    // Holds the env lock: the second half calls `resolve_surface`, which reads `$BSC_SURFACE_DIR`, and
    // under `cargo test` (one process, threaded) that races the scratch-writing tests. Found by a probe
    // run rather than by a red test — it had been passing on ordering luck.
    let s = Scratch::new("absent-tagline");
    let v = serde_json::json!({ "commands": [{ "name": "tree", "summary": "s", "usage": "u" }] });
    let (tagline, _) = surface_from_json(&v, &["tree"]).expect("a commands-only record is valid");
    assert_eq!(tagline, None, "absent must be ABSENT, so the caller supplies its compiled tagline");

    // ...and through resolution, a record that states only its commands keeps the compiled tagline.
    s.write("files", &v.to_string());
    let (t, c) = resolve_surface("bsc files", TAGLINE, COMMANDS);
    assert_eq!(t, TAGLINE, "a commands-only record must not blank the tagline");
    assert_eq!(c.len(), 1, "while its commands DO win");
}

// ── the boundary: data may not conjure a verb ───────────────────────────────────────────────────────

/// THE GENERALIZED RULE. The spike checked a fixed six-verb list; here the constraint is the COMPILED
/// catalog itself, which is strictly more accurate for a CLI whose verbs are its own.
///
/// The failure it prevents was observed, not imagined: adding a `count` verb by record edit put it in
/// `bsc persona help` while `bsc persona count` answered `unknown command 'count'`. A help catalog is
/// what an agent reads to decide what it may call.
#[test]
fn a_verb_the_compiled_catalog_does_not_carry_is_refused() {
    let mut v = surface_to_json(TAGLINE, COMMANDS);
    v["commands"].as_array_mut().unwrap().push(serde_json::json!({
        "name": "count", "summary": "how many", "usage": "bsc files count",
    }));
    let err = commands_from_json(&v, &["tree", "read"]).expect_err("an undispatchable verb must be refused");
    assert!(err.contains("count"), "the error must name the offending verb: {err}");
    assert!(err.contains("no implementation"), "and say why: {err}");
    // And it must say what IS available, or the author has nothing to correct toward.
    assert!(err.contains("tree"), "the error must name the verbs that do dispatch: {err}");
}

/// The same record is REFUSED for one CLI and ACCEPTED for another, because the constraint is that
/// CLI's own catalog. This is the assertion that distinguishes the generalization from a longer list:
/// a fixed `DISPATCHABLE` would give both CLIs the same answer.
#[test]
fn the_refusal_is_relative_to_the_catalog_being_overridden() {
    let v = serde_json::json!({ "commands": [{ "name": "scan", "summary": "s", "usage": "u" }] });
    assert!(commands_from_json(&v, &["tree", "read"]).is_err(), "`scan` is not a files verb");
    assert!(commands_from_json(&v, &["scan", "tables"]).is_ok(), "`scan` IS a data verb");
}

/// `help` is answered by the shared dispatch before any command is looked up, so most catalogs omit it
/// — but a record that lists it is describing something that genuinely works. Refusing it would make
/// the honest record the invalid one.
#[test]
fn help_is_accepted_even_though_a_catalog_rarely_lists_it() {
    let s = Scratch::new("help-verb");
    let v = serde_json::json!({ "commands": [
        { "name": "tree", "summary": "s", "usage": "u" },
        { "name": "help", "summary": "this menu", "usage": "bsc files help" },
    ]});
    // Through `resolve_surface`, which is what adds `help` to the compiled names.
    s.write("files", &v.to_string());
    let (_, cmds) = resolve_surface("bsc files", TAGLINE, COMMANDS);
    assert_eq!(cmds.len(), 2, "the record must have been accepted");
    assert_eq!(cmds[1].name, "help");
}

/// An EMPTY command list parses as valid JSON and would replace a working catalog with one that
/// advertises nothing — present, plausible and useless.
#[test]
fn a_surface_with_no_verbs_is_refused_rather_than_installed() {
    let v = serde_json::json!({ "commands": [] });
    let err = commands_from_json(&v, &["tree"]).expect_err("an empty surface must be refused");
    assert!(err.contains("empty"), "the reason must say so: {err}");
}

/// Every shape error must NAME its field. A record rejected with "invalid" tells the author nothing,
/// and the fallback means they will not see a crash to investigate either.
#[test]
fn a_malformed_record_is_rejected_with_the_field_named() {
    let cases: &[(serde_json::Value, &str)] = &[
        (serde_json::json!({}), "commands"),
        (serde_json::json!({ "commands": "tree" }), "commands"),
        (serde_json::json!({ "commands": [{ "name": "tree", "summary": "s" }] }), "usage"),
        (serde_json::json!({ "commands": [{ "summary": "s", "usage": "u" }] }), "name"),
    ];
    for (v, expect) in cases {
        let err = commands_from_json(v, &["tree"]).expect_err("a malformed record must be rejected");
        assert!(err.contains(expect), "error must name `{expect}`, got: {err}");
    }
    let err = surface_from_json(&serde_json::json!({ "tagline": 7, "commands": [] }), &["tree"])
        .expect_err("a non-string tagline must be rejected");
    assert!(err.contains("tagline"), "error must name `tagline`, got: {err}");
}

// ── resolution: the three outcomes ──────────────────────────────────────────────────────────────────

/// The three outcomes, in one place because they share the env var. The middle one is why this exists:
/// a record that is present and broken must fall back AND say so — never take a surface down, never
/// revert in silence.
#[test]
fn resolution_falls_back_to_the_compiled_catalog_and_never_panics() {
    let s = Scratch::new("resolve");

    // 1. No record at all — the normal case for all 29 CLIs today. Compiled, silently.
    let (t, c) = resolve_surface("bsc files", TAGLINE, COMMANDS);
    assert_eq!(t, TAGLINE);
    assert_eq!(c.len(), COMMANDS.len());

    // 2. A valid record — it wins.
    let mut v = surface_to_json(TAGLINE, COMMANDS);
    v["tagline"] = serde_json::json!("reworded without a compiler");
    v["commands"][0]["summary"] = serde_json::json!("the tree, described differently");
    s.write("files", &v.to_string());
    let (t, c) = resolve_surface("bsc files", TAGLINE, COMMANDS);
    assert_eq!(t, "reworded without a compiler");
    assert_eq!(c[0].summary, "the tree, described differently");

    // 3a. Present but not JSON — compiled, and the caller keeps working.
    s.write("files", "{ not json at all");
    assert_eq!(resolve_surface("bsc files", TAGLINE, COMMANDS).0, TAGLINE);

    // 3b. Structurally-valid JSON that is not a surface.
    s.write("files", r#"{"noun":"files"}"#);
    assert_eq!(resolve_surface("bsc files", TAGLINE, COMMANDS).0, TAGLINE);

    // 3c. Valid JSON, valid shape, and a verb that does not dispatch — the refusal, through the
    //     resolution path rather than the parser, because that is where a real author meets it.
    s.write(
        "files",
        &serde_json::json!({ "commands": [{ "name": "count", "summary": "s", "usage": "u" }] }).to_string(),
    );
    let (t, c) = resolve_surface("bsc files", TAGLINE, COMMANDS);
    assert_eq!(t, TAGLINE);
    assert_eq!(c.len(), COMMANDS.len(), "the compiled catalog must be intact");
}

/// A record written for ONE cli must not be picked up by another. Keyed lookup makes this structural,
/// and the test exists because the alternative — a shared file, or a last-token key — would silently
/// hand `bsc logs scope`'s record to a future `bsc scope`.
#[test]
fn a_record_only_affects_the_cli_it_is_keyed_to() {
    let s = Scratch::new("keyed");
    let mut v = surface_to_json(TAGLINE, COMMANDS);
    v["tagline"] = serde_json::json!("only for files");
    s.write("files", &v.to_string());

    assert_eq!(resolve_surface("bsc files", TAGLINE, COMMANDS).0, "only for files");
    assert_eq!(resolve_surface("bsc shot", TAGLINE, COMMANDS).0, TAGLINE, "a sibling CLI is untouched");
}

// ── the seam: every CmdDoc-driven CLI, not five ─────────────────────────────────────────────────────

/// THE POINT OF THE SLICE. `handle_help` is the seam all 29 `CmdDoc`-driven CLIs already route through,
/// so the record reaches every one of them with no call-site edit — and a per-crate opt-in list is
/// exactly the kind of hand-kept copy this epic exists to stop.
///
/// Asserted through the public dispatcher rather than the parser, because that is the contract a CLI
/// actually depends on.
#[test]
fn the_record_reaches_help_through_the_shared_dispatcher() {
    let s = Scratch::new("dispatch");
    let mut v = surface_to_json(TAGLINE, COMMANDS);
    v["commands"][0]["summary"] = serde_json::json!("SUMMARY FROM THE RECORD");
    s.write("files", &v.to_string());

    // The dispatcher still reports that it handled help — the record changes what is printed, never
    // whether the CLI's own dispatch is reached.
    let pos = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
    assert!(handle_help("bsc files", TAGLINE, COMMANDS, &pos(&["help"])));
    assert!(handle_help("bsc files", TAGLINE, COMMANDS, &pos(&["tree", "help"])));
    assert!(!handle_help("bsc files", TAGLINE, COMMANDS, &pos(&["tree"])), "a real command still dispatches");

    // The unknown-command error is the other half of the seam, and it must show the SAME catalog.
    let err = unknown_command("bsc files", TAGLINE, COMMANDS, "nope");
    assert!(err.contains("SUMMARY FROM THE RECORD"), "the error's menu must come from the record too: {err}");
    assert!(err.contains("nope"), "and still name what was typed: {err}");
}

/// A CLI whose record is absent — the state all 29 are in today — must produce byte-identical help to
/// before this module existed. The generalization is not allowed to cost anything where it is unused.
#[test]
fn no_record_means_byte_identical_help() {
    let _s = Scratch::new("unused");
    let before = crate::help_overview("bsc files", TAGLINE, COMMANDS);
    let (t, c) = resolve_surface("bsc files", TAGLINE, COMMANDS);
    assert_eq!(crate::help_overview("bsc files", t, c), before);
    assert!(before.contains("folder structure with sizes"));
}

// ── the tree-wide guard ─────────────────────────────────────────────────────────────────────────────

/// Every Rust source in the workspace, from BOTH homes: the files under `crates/*/src`, and the records
/// in the committed graph store whose `src` is a `.rs` (`graph/algorithms.json`, materialized into the
/// build by `crates/graph-materialize/build.rs`).
///
/// Reading both is the whole point. 12 of the 26 CLIs that render help are RECORDS with no file on
/// disk, so a scan over the file tree alone would report a clean sweep while seeing less than half the
/// surfaces — which is this repo's signature failure mode, not a hypothetical.
fn workspace_rust_sources() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(std::path::Path::parent)
        .expect("crates/<name> is two deep")
        .to_path_buf();
    assert!(
        std::fs::read_to_string(root.join("Cargo.toml")).is_ok_and(|t| t.contains("[workspace]")),
        "the workspace root must be two levels above this crate — found {}",
        root.display()
    );

    let mut out = Vec::new();
    let mut stack = vec![root.join("crates")];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                // `target/` holds materialized copies of the very records read below; scanning it would
                // double-count and would also depend on whether this tree has been built.
                if p.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                stack.push(p);
            } else if p.extension().is_some_and(|x| x == "rs") {
                if let Ok(t) = std::fs::read_to_string(&p) {
                    out.push((p.strip_prefix(&root).unwrap_or(&p).display().to_string(), t));
                }
            }
        }
    }

    let store = root.join("graph").join("algorithms.json");
    let raw = std::fs::read_to_string(&store)
        .unwrap_or_else(|e| panic!("the committed graph store must be readable at {}: {e}", store.display()));
    let v: serde_json::Value = serde_json::from_str(&raw)
        .unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", store.display()));
    let impls = v.get("implementations").and_then(|i| i.as_array()).cloned().unwrap_or_default();
    let before = out.len();
    for r in impls {
        let src = r.get("src").and_then(|s| s.as_str()).unwrap_or_default();
        if !src.ends_with(".rs") {
            continue;
        }
        if let Some(code) = r.get("code").and_then(|c| c.as_str()) {
            out.push((format!("{src} (record)"), code.to_string()));
        }
    }
    assert!(out.len() > before, "the store must contribute Rust records — a silent zero means the scan is broken");
    out
}

/// THE INVARIANT THIS SLICE ESTABLISHES, encoded rather than asserted in prose: a CLI that renders its
/// own help must resolve its surface record first.
///
/// 34 of the `bsc` verbs get this for free because they route through [`crate::handle_help`], which
/// resolves internally. The exception is a CLI that hand-rolls the block — `bsc logs` does, because a
/// BARE invocation must keep defaulting to its `sessions` verb rather than printing help. Such a CLI
/// must call `surface::resolve_surface` itself, and the failure when it does not is SILENT and total:
/// its record is simply never read, which is indistinguishable from a record nobody wrote. That is the
/// exact shape of bug this module's decline-and-warn design exists to prevent, so leaving the one
/// remaining path to convention would undo it.
///
/// The rule is checked structurally: outside a `#[cfg(test)]` block, `help_overview` / `help_for` must
/// not be handed a crate's raw `TAGLINE, COMMANDS` constants — those are the COMPILED surface, and
/// passing them is precisely the bypass. A test asserting its own catalog renders is not a violation,
/// which is why the scan stops at the test module rather than flagging all 26 files that mention the
/// helpers.
#[test]
fn a_hand_rolled_help_block_must_resolve_its_surface_record() {
    let mut offenders = Vec::new();
    for (path, text) in workspace_rust_sources() {
        // This crate DEFINES the helpers and legitimately calls them with whatever it is given.
        if path.starts_with("crates/bsc-cli-util/") {
            continue;
        }
        // Production code only. Every CLI here puts its `#[cfg(test)]` module last, so truncating there
        // is exact for this tree — and a file with no test module is scanned whole.
        let prod = text.split("#[cfg(test)]").next().unwrap_or(&text);
        for (i, line) in prod.lines().enumerate() {
            let l = line.trim();
            if l.starts_with("//") || l.starts_with("///") {
                continue;
            }
            // `surface::help_for` / `surface::help_overview` ARE the resolving doors — calling them
            // with the compiled constants is the correct form, not the bypass.
            let renders = l.contains("help_overview(") || l.contains("help_for(");
            if renders && l.contains("TAGLINE, COMMANDS") && !l.contains("surface::") {
                offenders.push(format!("{path}:{}: {l}", i + 1));
            }
        }
    }
    assert!(
        offenders.is_empty(),
        "these render help from the COMPILED catalog, so their surface record is silently ignored.\n\
         Call the resolving door instead — same arguments, one path segment different:\n    \
         bsc_cli_util::surface::help_for(prog, TAGLINE, COMMANDS, \"<verb>\")\n    \
         bsc_cli_util::surface::help_overview(prog, TAGLINE, COMMANDS)\n\
         ...or resolve once yourself with `surface::resolve_surface` if you render several times.\n\
         Offenders:\n  {}",
        offenders.join("\n  ")
    );
}
