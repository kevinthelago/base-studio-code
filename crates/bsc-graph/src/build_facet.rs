//! The `build` facet — a node records whether it compiles, and where its artifact is.
//!
//! # What this is actually for
//!
//! Not speed. The gate's sweep already hash-caches the whole set (2.7s → 0.3s), so per-node caching
//! saves little. The value is that **the verdict lives ON THE NODE**: `bsc graph impl get <id>` answers
//! "does this compile?" without running anything, and the artifact reference is what makes a node
//! *runnable* rather than merely stored — the original ask behind this epic.
//!
//! ```jsonc
//! "build": {
//!   "hash":      "<sha256 of the materialized source + toolchain + flags>",
//!   "verdict":   "pass" | "fail",
//!   "targets":   { "native": { "verdict": "pass" },
//!                  "wasm32": { "verdict": "pass", "artifact": "<sha256>", "bytes": 12385 } },
//!   "at":        "2026-08-19T…Z",
//!   "toolchain": "rustc 1.8x.0 (… )"
//! }
//! ```
//!
//! # The hash covers everything that can change the answer
//!
//! Source alone is not enough: the same code compiles or does not depending on the compiler and the
//! flags. A hash that ignored those would report a stale verdict as current after a toolchain bump —
//! the exact shape of "green while covering less" this repo keeps paying for. The MATERIALIZED source
//! is hashed rather than the record's own `code`, because a node's closure is part of what compiles:
//! editing a composed sibling must invalidate its dependents.
//!
//! # Artifacts are a SIDECAR, never inline
//!
//! `algorithms.json` is 8.74 MB and the frontend imports it. A 12 KB wasm per node would add ~1 MB of
//! base64 to a file every reader parses. Artifacts are content-addressed under
//! `~/.base-studio-code/knowledge/artifacts/<sha256>.<ext>` and the node stores only the hash — the same
//! shape sccache uses, at node granularity. They are a CACHE: derived, reproducible, and absent in a
//! fresh clone by design, which is why a missing artifact re-derives rather than failing.

use serde_json::{json, Value};

/// The flag set the wasm measurement was taken with. Changing it changes the artifact, so it is part of
/// the hash — 12,385 bytes with these, 1.5 MB without them.
pub const WASM_FLAGS: &[&str] = &[
    "-C", "opt-level=z",
    "-C", "panic=abort",
    "-C", "lto=fat",
    "-C", "codegen-units=1",
    "-C", "strip=symbols",
];

/// The identity of a build: materialized source, the compiler, and the flags.
///
/// `flags` is joined rather than hashed per element so a reordering shows as a change — it can be one.
pub fn facet_hash(materialized: &str, toolchain: &str, flags: &[&str]) -> String {
    let mut buf = String::with_capacity(materialized.len() + 128);
    buf.push_str(materialized);
    buf.push('\u{1}');
    buf.push_str(toolchain);
    buf.push('\u{1}');
    buf.push_str(&flags.join(" "));
    bsc_cli_util::vendored::sha256_hex(buf.as_bytes())
}

/// Whether a node's recorded verdict still applies to `hash`.
///
/// A node with no facet, or one whose hash differs, is NOT current — the caller must rebuild. This
/// deliberately says nothing about whether the artifact file exists; that is checked separately, so a
/// swept-away cache re-derives instead of being trusted on the strength of a matching hash.
pub fn is_current(node: &Value, hash: &str) -> bool {
    node.get("build")
        .and_then(|b| b.get("hash"))
        .and_then(Value::as_str)
        .is_some_and(|h| h == hash)
}

/// One target's outcome. `artifact` is a content hash, never a path — the sidecar's location is the
/// reader's business, and a path baked into a committed store would be machine-specific.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TargetOutcome {
    pub name: &'static str,
    pub passed: bool,
    pub artifact: Option<String>,
    pub bytes: Option<u64>,
    /// Exported function count — present only for a target where "can it be called?" is a real question.
    pub exports: Option<u32>,
    pub detail: Option<String>,
}

impl TargetOutcome {
    pub fn pass(name: &'static str) -> Self {
        Self { name, passed: true, artifact: None, bytes: None, exports: None, detail: None }
    }
    pub fn fail(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, passed: false, artifact: None, bytes: None, exports: None, detail: Some(detail.into()) }
    }
    pub fn with_artifact(mut self, sha: impl Into<String>, bytes: u64) -> Self {
        self.artifact = Some(sha.into());
        self.bytes = Some(bytes);
        self
    }
    /// Record how many functions the artifact exports, and say so when the answer is none.
    pub fn with_exports(mut self, exports: u32) -> Self {
        self.exports = Some(exports);
        if exports == 0 {
            self.detail = Some(
                "compiled, but exports NOTHING — a node needs a `#[no_mangle] extern \"C\"` wrapper to \
                 be callable. The export contract is `one-implementation-drives-the-animation`."
                    .into(),
            );
        }
        self
    }
}

/// Render the facet. The overall verdict is `pass` only when EVERY target passed — a node that builds
/// natively but not for wasm has not built, and reporting it as a pass would be the optimistic summary
/// this repo's gate incidents are made of.
pub fn facet(hash: &str, toolchain: &str, at: &str, targets: &[TargetOutcome]) -> Value {
    let mut map = serde_json::Map::new();
    for t in targets {
        let mut entry = json!({ "verdict": if t.passed { "pass" } else { "fail" } });
        if let Some(a) = &t.artifact {
            entry["artifact"] = json!(a);
        }
        if let Some(b) = t.bytes {
            entry["bytes"] = json!(b);
        }
        if let Some(e) = t.exports {
            entry["exports"] = json!(e);
        }
        if let Some(d) = &t.detail {
            entry["detail"] = json!(d);
        }
        map.insert(t.name.to_string(), entry);
    }
    json!({
        "hash": hash,
        "verdict": if targets.iter().all(|t| t.passed) { "pass" } else { "fail" },
        "targets": Value::Object(map),
        "at": at,
        "toolchain": toolchain,
    })
}

/// `<sha>.<ext>` — the sidecar filename for a content-addressed artifact.
pub fn artifact_name(sha: &str, ext: &str) -> String {
    format!("{sha}.{ext}")
}

/// The one line a crate adds to its manifest to have its source materialized from the graph.
///
/// Mirrored in `scripts/graph-rust-compile.mjs`; the two must move together, and that script's header
/// says so. Different languages, so the constant cannot be shared — only kept honest.
pub const MATERIALIZE_MARKER: &str = "build = \"../graph-materialize/build.rs\"";

/// The crate directory a record's `src` belongs to, if it is under `crates/`.
pub fn crate_of(src: Option<&str>) -> Option<&str> {
    let rest = src?.strip_prefix("crates/")?;
    rest.split('/').next().filter(|s| !s.is_empty())
}

/// Is this record a whole module of a crate that materializes its source?
///
/// Such a record is **Tier A**: it compiles INSIDE its crate, against that crate's dependencies.
/// Building it standalone fails with `cannot find module or crate …`, which is correct rather than a
/// defect — and recording that as `verdict: fail` would libel a healthy record. Measured: `--all` marked
/// `bsc-blueprint-cli.rs` failed for exactly this reason before the exclusion existed.
pub fn is_tier_a(src: Option<&str>, materialized_crates: &[String]) -> bool {
    crate_of(src).is_some_and(|c| materialized_crates.iter().any(|m| m == c))
}

/// How many functions a wasm module EXPORTS — the difference between "it compiled" and "it can be run".
///
/// This exists because the first artifact this slice produced was **86 bytes**: a `cdylib` whose crate
/// has no `#[no_mangle] extern "C"` function compiles to a valid, empty module. Recording that as
/// `wasm32: pass` would be true and useless — a green verdict for something nothing can call, which is
/// the precise shape of "passes while meaning less than the reader assumes" this repo keeps paying for.
/// The measured 12,385-byte `quick-sort` artifact had a hand-written export wrapper; without one there
/// is nothing to invoke.
///
/// Only **functions** are counted, and that distinction is the entire point. An export-less `cdylib`
/// still exports `memory`, `__data_end` and `__heap_base` — measured: the 86-byte module reported 3
/// until this filtered by kind. Counting those would have restored exactly the false reassurance this
/// function was added to remove.
///
/// Returns `None` when the bytes are not a wasm module at all. The format: an 8-byte header, then
/// sections of `(id: u8, size: LEB128, payload)`. Section **7** is exports: a LEB128 count, then each
/// entry is `(name_len: LEB128, name, kind: u8, index: LEB128)` with kind **0** meaning a function.
pub fn wasm_export_count(bytes: &[u8]) -> Option<u32> {
    if bytes.len() < 8 || &bytes[0..4] != b"\0asm" {
        return None;
    }
    let mut i = 8;
    while i < bytes.len() {
        let id = bytes[i];
        i += 1;
        let (size, used) = leb128(bytes, i)?;
        i += used;
        if id == 7 {
            let (count, used) = leb128(bytes, i)?;
            let mut at = i + used;
            let mut funcs = 0u32;
            for _ in 0..count {
                let (name_len, used) = leb128(bytes, at)?;
                at = at.checked_add(used)?.checked_add(name_len as usize)?;
                let kind = *bytes.get(at)?;
                at += 1;
                let (_, used) = leb128(bytes, at)?;
                at += used;
                if kind == 0 {
                    funcs += 1;
                }
            }
            return Some(funcs);
        }
        i = i.checked_add(size as usize)?;
    }
    Some(0) // a well-formed module with no export section exports nothing
}

/// Unsigned LEB128 at `at` → (value, bytes consumed).
fn leb128(bytes: &[u8], at: usize) -> Option<(u32, usize)> {
    let (mut result, mut shift, mut used) = (0u32, 0u32, 0usize);
    loop {
        let b = *bytes.get(at + used)?;
        used += 1;
        result |= u32::from(b & 0x7f).checked_shl(shift)?;
        if b & 0x80 == 0 {
            return Some((result, used));
        }
        shift += 7;
        if shift > 31 {
            return None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_hash_changes_with_source_toolchain_or_flags() {
        let base = facet_hash("fn a() {}", "rustc 1.80", WASM_FLAGS);
        assert_ne!(base, facet_hash("fn b() {}", "rustc 1.80", WASM_FLAGS), "source");
        assert_ne!(base, facet_hash("fn a() {}", "rustc 1.81", WASM_FLAGS), "toolchain");
        assert_ne!(base, facet_hash("fn a() {}", "rustc 1.80", &["-C", "opt-level=3"]), "flags");
        assert_eq!(base, facet_hash("fn a() {}", "rustc 1.80", WASM_FLAGS), "stable for equal inputs");
    }

    /// The separator matters: without it `("ab", "c")` and `("a", "bc")` would hash identically.
    #[test]
    fn field_boundaries_cannot_be_confused() {
        assert_ne!(facet_hash("ab", "c", &[]), facet_hash("a", "bc", &[]));
    }

    #[test]
    fn a_node_with_no_facet_is_never_current() {
        assert!(!is_current(&json!({ "id": "a.rs" }), "abc"));
    }

    #[test]
    fn currency_is_exactly_a_hash_match() {
        let node = json!({ "build": { "hash": "abc" } });
        assert!(is_current(&node, "abc"));
        assert!(!is_current(&node, "def"));
    }

    #[test]
    fn the_facet_carries_every_target_and_its_artifact() {
        let f = facet(
            "h",
            "rustc 1.80",
            "2026-08-19T00:00:00Z",
            &[TargetOutcome::pass("native"), TargetOutcome::pass("wasm32").with_artifact("deadbeef", 12_385)],
        );
        assert_eq!(f["verdict"], json!("pass"));
        assert_eq!(f["targets"]["native"]["verdict"], json!("pass"));
        assert_eq!(f["targets"]["wasm32"]["artifact"], json!("deadbeef"));
        assert_eq!(f["targets"]["wasm32"]["bytes"], json!(12_385));
        assert_eq!(f["hash"], json!("h"));
    }

    /// A partial pass is a FAIL. Summarizing it as a pass is how a green report comes to mean less than
    /// the reader assumes.
    #[test]
    fn one_failing_target_fails_the_whole_facet() {
        let f = facet(
            "h",
            "t",
            "now",
            &[TargetOutcome::pass("native"), TargetOutcome::fail("wasm32", "no wasm32 target installed")],
        );
        assert_eq!(f["verdict"], json!("fail"));
        assert_eq!(f["targets"]["wasm32"]["detail"], json!("no wasm32 target installed"));
    }

    #[test]
    fn an_artifact_is_named_by_its_content_hash() {
        assert_eq!(artifact_name("abc123", "wasm"), "abc123.wasm");
    }

    #[test]
    fn an_export_less_module_is_reported_as_such_rather_than_a_bare_pass() {
        let t = TargetOutcome::pass("wasm32").with_artifact("sha", 86).with_exports(0);
        assert!(t.passed, "it did compile");
        assert_eq!(t.exports, Some(0));
        assert!(t.detail.as_deref().unwrap().contains("exports NOTHING"), "{t:?}");
    }

    #[test]
    fn a_module_with_exports_carries_the_count_and_no_warning() {
        let t = TargetOutcome::pass("wasm32").with_artifact("sha", 12_385).with_exports(3);
        assert_eq!(t.exports, Some(3));
        assert!(t.detail.is_none());
    }

    #[test]
    fn non_wasm_bytes_are_not_mistaken_for_a_module() {
        assert_eq!(wasm_export_count(b"not wasm at all"), None);
        assert_eq!(wasm_export_count(&[]), None);
    }

    /// The minimal real module: header only. No export section means nothing is exported.
    #[test]
    fn a_header_only_module_exports_nothing() {
        let m = [0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];
        assert_eq!(wasm_export_count(&m), Some(0));
    }

    /// One export entry: name length, name, kind, index.
    fn export_entry(name: &str, kind: u8, index: u8) -> Vec<u8> {
        let mut v = vec![name.len() as u8];
        v.extend_from_slice(name.as_bytes());
        v.push(kind);
        v.push(index);
        v
    }
    fn module_with_exports(entries: &[Vec<u8>]) -> Vec<u8> {
        let mut payload = vec![entries.len() as u8];
        for e in entries {
            payload.extend_from_slice(e);
        }
        let mut m = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];
        m.push(7);
        m.push(payload.len() as u8);
        m.extend_from_slice(&payload);
        m
    }

    #[test]
    fn exported_functions_are_counted() {
        let m = module_with_exports(&[export_entry("run", 0, 0), export_entry("step", 0, 1)]);
        assert_eq!(wasm_export_count(&m), Some(2));
    }

    /// THE CASE THAT MOTIVATED THE KIND FILTER. An export-less cdylib still exports `memory`,
    /// `__data_end` and `__heap_base` — the real 86-byte artifact reported 3 until this was fixed, which
    /// is precisely the false reassurance the export count exists to remove.
    #[test]
    fn memory_and_globals_do_not_count_as_callable_exports() {
        let m = module_with_exports(&[
            export_entry("memory", 2, 0),
            export_entry("__data_end", 3, 0),
            export_entry("__heap_base", 3, 1),
        ]);
        assert_eq!(wasm_export_count(&m), Some(0), "3 exports, 0 of them callable");
    }

    #[test]
    fn a_mixed_export_section_counts_only_the_functions() {
        let m = module_with_exports(&[
            export_entry("memory", 2, 0),
            export_entry("sort", 0, 0),
            export_entry("__heap_base", 3, 1),
        ]);
        assert_eq!(wasm_export_count(&m), Some(1));
    }

    /// A section BEFORE the export section must be skipped by its declared size, not scanned into.
    #[test]
    fn an_earlier_section_is_skipped_by_its_size() {
        let mut m = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];
        m.extend_from_slice(&[1, 3, 0xff, 0xff, 0xff]); // type section, 3 bytes of payload
        let entries = [export_entry("f", 0, 0)];
        let mut payload = vec![1u8];
        payload.extend_from_slice(&entries[0]);
        m.push(7);
        m.push(payload.len() as u8);
        m.extend_from_slice(&payload);
        assert_eq!(wasm_export_count(&m), Some(1));
    }

    #[test]
    fn a_truncated_section_header_does_not_panic() {
        let mut m = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];
        m.extend_from_slice(&[7]); // id with no size
        assert_eq!(wasm_export_count(&m), None);
    }

    #[test]
    fn a_size_running_past_the_end_does_not_panic() {
        let mut m = vec![0x00, b'a', b's', b'm', 0x01, 0x00, 0x00, 0x00];
        m.extend_from_slice(&[1, 0x7f]); // claims 127 bytes that are not there
        assert_eq!(wasm_export_count(&m), Some(0), "walks off the end and stops");
    }
}
