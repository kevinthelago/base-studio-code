//! The source hash — **a cross-language contract**, not an implementation detail.
//!
//! The frontend hashes the source it actually COMPILED; `doctor` hashes the source currently in the
//! store. "Is the record what is running?" is the comparison of those two values, so if the two
//! languages disagree the entire attestation system reports noise — and it would report it
//! confidently, which is worse than reporting nothing.
//!
//! FNV-1a (64-bit) is chosen for exactly that reason: it is four lines in any language, has no
//! dependency, and cannot drift the way a "use the platform's built-in hash" choice would. This is not
//! a security boundary — nothing here defends against a crafted collision, and nothing needs to; it
//! answers "is this the same text" between two processes on one machine.
//!
//! The TypeScript twin is `srcHash` in `@/shared/lib/runtime/attest`, and
//! `data/runtime/hash.fixtures.json` pins them together. Change one side and that fixture fails.

/// FNV-1a 64-bit offset basis / prime — the published constants, named so a reader can check them.
const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// Hash a module's source to the 16-char lowercase hex both languages produce.
///
/// Hashes UTF-8 BYTES, not chars: JavaScript strings are UTF-16, so a char-wise implementation would
/// agree with Rust on ASCII and diverge on the first non-ASCII source — and this codebase's records are
/// full of em dashes and arrows in comments, so that divergence would be the normal case, not an edge
/// case. The TS twin encodes to UTF-8 first for the same reason.
pub fn src_hash(source: &str) -> String {
    let mut h = FNV_OFFSET_BASIS;
    for b in source.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(FNV_PRIME);
    }
    format!("{h:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The published FNV-1a 64-bit test vectors. Pinning these means a refactor cannot quietly turn
    /// this into "some hash that is self-consistent" — which would still pass a round-trip test while
    /// disagreeing with every other FNV implementation, including the one on the other side of the
    /// boundary.
    #[test]
    fn matches_the_published_fnv1a_vectors() {
        assert_eq!(src_hash(""), format!("{FNV_OFFSET_BASIS:016x}"));
        assert_eq!(src_hash("a"), "af63dc4c8601ec8c");
        assert_eq!(src_hash("foobar"), "85944171f73967e8");
    }

    #[test]
    fn is_stable_and_length_fixed() {
        for s in ["", "a", "export function X() {}", "— an em dash —"] {
            assert_eq!(src_hash(s).len(), 16, "always 16 hex chars: {s}");
            assert_eq!(src_hash(s), src_hash(s), "deterministic");
        }
    }

    /// The UTF-8 rule, asserted rather than described. A char-wise implementation agrees with this on
    /// ASCII and diverges here — which is precisely the failure that would look fine in every test
    /// written with ASCII fixtures, then mismatch on the first real record.
    #[test]
    fn hashes_utf8_bytes_so_a_multibyte_char_is_not_one_unit() {
        // U+2014 EM DASH is three UTF-8 bytes and one UTF-16 code unit.
        assert_ne!(src_hash("—"), src_hash("-"));
        // Distinct texts hash distinctly (the property every caller relies on).
        assert_ne!(src_hash("a—b"), src_hash("a-b"));
    }

    /// THE CONTRACT. `data/runtime/hash.fixtures.json` is the shared file the TypeScript twin also
    /// asserts against, so this test and its counterpart in `attest.test.ts` are what stop the two
    /// implementations drifting apart — and a drift here is not a broken test, it is every "did this
    /// version run?" answer silently becoming noise.
    #[test]
    fn agrees_with_the_shared_cross_language_fixture() {
        let raw = std::fs::read_to_string(fixture_path()).expect("hash.fixtures.json");
        let doc: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(doc["algorithm"], "fnv1a64-utf8-hex16", "the fixture describes a different algorithm");
        let cases = doc["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 6, "the fixture must keep real coverage, got {}", cases.len());
        for c in cases {
            let input = c["input"].as_str().expect("input");
            let expected = c["hash"].as_str().expect("hash");
            assert_eq!(src_hash(input), expected, "case: {}", c["why"]);
        }
    }

    /// Resolve the fixture from THIS file, so the test works from any cwd (`cargo test -p` runs at the
    /// workspace root, the editor may not).
    fn fixture_path() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/data/runtime/hash.fixtures.json")
    }

    #[test]
    fn distinguishes_a_one_character_edit() {
        // The whole point: a record edited by one character must not read as "the same version ran".
        assert_ne!(src_hash("export const N = 1;"), src_hash("export const N = 2;"));
    }
}
