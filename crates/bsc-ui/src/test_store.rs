//! A SEEDED COMPONENT STORE for driving `bsc ui` verbs in a test — the harness the script migration
//! needs, built once and reused.
//!
//! ## Why it exists
//!
//! The first two verbs moved (`census`, `diff`) were verified against the LIVE store, and that is what
//! made them trustworthy: real disagreeing records made the ports byte-comparable, and doing so caught
//! two Rust bugs the hand-written fixtures had missed. Not every script has such an oracle —
//! `check-record-imports` found ZERO relative specifiers across 1047 live module sources, so its report
//! path compared two implementations that both correctly said nothing, and its `--fix` path, which
//! rewrites `srcText` and drops `provides`, had nothing whatsoever to exercise it.
//!
//! Porting a destructive path verified only by fixtures its own author wrote is the
//! green-gate-that-sees-less failure this repo keeps meeting. This makes the scenario instead.
//!
//! ## Two limits, stated because both can make a test lie
//!
//! **IT ISOLATES THE COMPONENT STORE ONLY.** `BSC_GRAPH_STORE` pointed at an empty file still yields the
//! packaged implementations, because the graph store reconciles its packaged seed on load. So an
//! assertion must key on the SEEDED record — never on a total. A test asserting "638 module sources"
//! passes today and breaks the next time anything is added to the packaged seed, for no reason connected
//! to what it was checking.
//!
//! **THE ENV IS PROCESS-GLOBAL.** `BSC_COMPONENT_DIR` is read per process, so this is safe under
//! `cargo nextest` — which runs each test in its own process, and is what the gate uses — and would race
//! under threaded `cargo test`. Same constraint `ENV_LOCK` exists for elsewhere in this workspace.
//!
//! **IT CAN ONLY CAPTURE WHAT EMITS PROPERLY.** [`bsc_util::capture_output`] swaps a thread-local sink
//! that only `bsc_util::emit_line`/`emit` write to; a plain `println!` goes straight to stdout and is
//! invisible here. So a verb written with `println!` cannot be asserted on by this harness at all —
//! which is a reason to write new ones with `emit_line` rather than a reason to weaken the harness.
//! (`bsc ui census` and `bsc ui diff` predate this and still `println!`; moving them is worth doing when
//! something needs to assert on their output.)
//!
//! ## The parity window
//!
//! While a script still exists, the same seeded store can be handed to BOTH implementations and their
//! output diffed — that is the strongest evidence a migration can produce. After the script is deleted
//! there is no second implementation, and this becomes a REGRESSION harness: the same role change the
//! captured fixtures go through.

use std::path::{Path, PathBuf};

/// A throwaway component store, torn down on drop.
pub struct SeededStore {
    root: PathBuf,
    prev: Option<String>,
}

impl SeededStore {
    /// Create an empty store and point `BSC_COMPONENT_DIR` at it.
    ///
    /// `label` only names the temp directory, so a leaked one says which test made it.
    pub fn new(label: &str) -> Self {
        let root = std::env::temp_dir()
            .join(format!("bsc-ui-seeded-{label}-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("components")).expect("create the seeded store");
        let prev = std::env::var("BSC_COMPONENT_DIR").ok();
        // SAFETY: per-process env, and the gate runs nextest — one process per test. See the module
        // header for why this is not safe under threaded `cargo test`.
        unsafe { std::env::set_var("BSC_COMPONENT_DIR", root.join("components")) };
        Self { root, prev }
    }

    /// Write one record into the store. `json` is the record body verbatim, so a test can seed exactly
    /// the shape it means — including a deliberately malformed one.
    pub fn seed(&self, id: &str, json: &str) -> &Self {
        std::fs::write(self.root.join("components").join(format!("{id}.json")), json)
            .expect("seed a record");
        self
    }

    /// Write a FILE into the fixture's `src/` tree — the copy a record's `src` points at, so
    /// record-versus-file comparisons have something real to compare against.
    pub fn seed_file(&self, rel: &str, body: &str) -> &Self {
        let p = self.root.join("src").join(rel);
        if let Some(d) = p.parent() {
            std::fs::create_dir_all(d).expect("create the fixture src dir");
        }
        std::fs::write(p, body).expect("seed a file");
        self
    }

    /// The fixture root — pass as `--repo` so `src/` paths resolve inside it.
    pub fn repo(&self) -> &Path {
        &self.root
    }

    /// Read one record's SEED back — the `.json` this test wrote into the store directory.
    ///
    /// THIS IS NOT WHAT A WRITE MOVES. The store is SQLite-backed and ingests these files only when it
    /// opens, so a verb's write lands in the `.db` and leaves this file exactly as the test seeded it.
    /// Asserting a write with this passes whether or not the write happened. Use [`Self::stored`].
    pub fn seed_of(&self, id: &str) -> serde_json::Value {
        let body = std::fs::read_to_string(self.root.join("components").join(format!("{id}.json")))
            .unwrap_or_else(|e| panic!("{id}: {e}"));
        serde_json::from_str(&body).unwrap_or_else(|e| panic!("{id} is not valid JSON: {e}"))
    }

    /// Run a `bsc ui` verb against this store and capture what it printed.
    ///
    /// Returns `(result, stdout)` so a test can assert on BOTH — a verb that prints the right report and
    /// exits wrong, or exits right and prints nothing, is broken either way.
    /// Read one record back THROUGH THE STORE — what a write actually left behind.
    ///
    /// Neither [`Self::seed_of`] nor `run(&["get", id])` can answer this: the first reads a file the
    /// write never touches, and `get` prints with `println!`, which [`Self::run`]'s capture does not see.
    /// `None` when the store holds no such record.
    pub fn stored(&self, id: &str) -> Option<serde_json::Value> {
        let dir = Some(self.root.join("components").to_string_lossy().into_owned());
        let store = bsc_component::cli::open_component_store(&dir).expect("open the seeded store");
        store
            .get(id)
            .expect("read the seeded store")
            .map(|b| serde_json::from_str(&b).expect("a stored record is valid JSON"))
    }

    pub fn run(&self, args: &[&str]) -> (Result<(), String>, String) {
        let argv: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
        bsc_util::capture_output(|| crate::cli::run(argv, "bsc ui"))
    }
}

impl Drop for SeededStore {
    fn drop(&mut self) {
        // SAFETY: same per-process constraint as `new`.
        unsafe {
            match &self.prev {
                Some(v) => std::env::set_var("BSC_COMPONENT_DIR", v),
                None => std::env::remove_var("BSC_COMPONENT_DIR"),
            }
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The harness must be proved to WORK before anything is proved with it — a fixture that seeds
    /// nothing would make every test built on it vacuously green.
    #[test]
    fn the_seeded_store_is_actually_what_the_verbs_read() {
        let s = SeededStore::new("selfcheck");
        s.seed(
            "relimport",
            r#"{"id":"relimport","name":"RelImport","kitId":"k","role":"composite",
                "src":"features/demo/RelImport.tsx","provides":"@/features/demo/RelImport",
                "srcText":"import { Helper } from \"./helper\";\nexport function RelImport() { return 1; }\n"}"#,
        );
        // `list --full` is used rather than `get` because it EMITS: `get` prints through `println!`,
        // which bypasses the capture sink entirely. That distinction is the harness's main limitation
        // and is stated in the module header.
        let (res, out) = s.run(&["list", "--full"]);
        res.expect("the verb reads the seeded store");
        assert!(out.contains("relimport"), "the seeded record must be visible: {out}");
        assert!(out.contains("./helper"), "its body must come back verbatim, imports and all: {out}");
    }

    /// And it must be ISOLATED: a store seeded with one record must not see the real library.
    #[test]
    fn the_seeded_store_does_not_leak_the_real_component_library() {
        let s = SeededStore::new("isolation");
        s.seed("only", r#"{"id":"only","name":"Only","kitId":"k","role":"composite","srcText":"export const a = 1;\n"}"#);
        let (res, out) = s.run(&["list", "--full"]);
        res.expect("list runs");
        let rows: serde_json::Value = serde_json::from_str(out.trim()).expect("list emits JSON");
        let ids: Vec<&str> =
            rows.as_array().expect("an array").iter().filter_map(|r| r["id"].as_str()).collect();
        assert_eq!(ids, vec!["only"], "the real library leaked in: {ids:?}");
    }

    /// Re-seeding is visible to `seed_of` — which is all this ever proved. It is kept, and renamed to
    /// say so: it exercises no WRITE path, and reading a write back with `seed_of` would pass whether or
    /// not the write happened. See the test below for the half that matters.
    #[test]
    fn a_reseeded_record_is_read_back_from_the_seed_file() {
        let s = SeededStore::new("readback");
        s.seed("w", r#"{"id":"w","name":"W","kitId":"k","role":"composite","srcText":"export const a = 1;\n"}"#);
        assert_eq!(s.seed_of("w")["name"], "W");
        s.seed("w", r#"{"id":"w","name":"W2","kitId":"k","role":"composite","srcText":"export const a = 2;\n"}"#);
        assert_eq!(s.seed_of("w")["name"], "W2", "the read-back must see the new bytes, not a cache");
    }

    /// A REAL WRITE's read-back, and the reason [`SeededStore::stored`] exists. The store is
    /// SQLite-backed, so a verb's write never touches the seeded `.json` — `seed_of` is pinned here
    /// AGREEING with the stale file while `stored` sees the write, which is the whole trap in one test.
    #[test]
    fn only_stored_sees_what_a_write_actually_left() {
        let s = SeededStore::new("wrote");
        s.seed("w", r#"{"id":"w","name":"W","kitId":"k","role":"composite","srcText":"export const a = 1;\n"}"#);
        // Written through the STORE, not a verb: `set` reads stdin, which a captured in-process run
        // cannot drive, and the point here is the read-back asymmetry rather than which verb wrote.
        let dir = Some(s.root.join("components").to_string_lossy().into_owned());
        let store = bsc_component::cli::open_component_store(&dir).expect("open");
        store
            .set("w", r#"{"id":"w","name":"W2","kitId":"k","role":"composite","srcText":"export const a = 1;\n"}"#)
            .expect("write through the store");

        assert_eq!(s.seed_of("w")["name"], "W", "the seed file is UNTOUCHED by a store write");
        assert_eq!(
            s.stored("w").expect("stored")["name"],
            "W2",
            "`stored` must see the write the seed file cannot"
        );
    }
}
