//! `bsc-sound` — the sound-kit shim over the shared `bsc-json-store` (#2158, epic #3071). The user
//! sound library (`~/.base-studio-code/sounds.db`, #3080) is a verbatim-JSON-per-id store; the CRUD +
//! the `list/get/set/remove` CLI live once in [`bsc_json_store`], and this crate supplies only the
//! sound-kit-specific noun + lean `list` fields.
//!
//! A **sound kit** is a cohesive, CRUD-able set of SYNTHESIZED sounds — primitives (oscillators/noise) →
//! voices (patches: pitch + envelope + filter) → cues (UI-mapped sounds = layered voices). A sound is a
//! DESCRIPTOR (Web Audio graph), not a binary file, so it's diffable + seedable, exactly like a component
//! or an algorithm impl. It is the one store the desktop Sounds library and a live session's own shell
//! share: the desktop UI reaches it through the generic `bsc` command (`bsc sound …`, over the #2114
//! bridge), and a session's shell reaches the same store through the [`cli`] module. Packaged (built-in)
//! kits are seeded into this store on first hydrate + kept reconciled by the frontend, like the persona +
//! blueprint libraries.

//! Two stores live here, deliberately split (#3371): the FLAT working store above (mutable, SQLite,
//! keyed by bare kit id — what a session authors into), and the VERSIONED [`release`] store (immutable
//! `id@version` artifacts under `~/.base-studio-code/sound-kits/`, content-addressed by sha256 — what a
//! blueprint PINS). The release store mirrors the UI-kit one (`bsc_ui::kit`, #2465) contract-for-contract.

pub mod cli;
pub mod release;

#[cfg(test)]
mod tests {
    use bsc_json_store::Store;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A per-test unique suffix so parallel tests never share a base dir.
    fn uniq() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    /// Regression (epic #2982 pattern, mirrors bsc-persona): the sound store persists to a SQLite
    /// **`sounds.db`**, NOT to per-id `sounds/<id>.json` files. `bsc-sound` rides the shared
    /// `bsc-json-store` backend over `bsc_json_store::Store` with segment `sounds` / noun `sound` (the
    /// [`cli::SPEC`](crate::cli) config). Pins that a round-trip write/read leaves a `<base>/sounds.db`
    /// and creates no `<base>/sounds/<id>.json`.
    #[test]
    fn sound_store_persists_to_sqlite_not_json_files() {
        let base = std::env::temp_dir().join(format!("bsc-sound-sqlite-{}", uniq()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // The sound store exactly as its CLI configures it (mirrors `cli::SPEC.dir_segment` / `.noun`).
        let store = Store::new(base.join("sounds"), "sound");

        // Round-trip: write a kit, read it back verbatim (and via list).
        let kit = r#"{"id":"signal","name":"Signal"}"#;
        store.set("signal", kit).unwrap();
        assert_eq!(store.get("signal").unwrap().as_deref(), Some(kit), "the kit reads back verbatim");
        assert_eq!(store.list(), vec![kit.to_string()], "and lists from the db");

        // SQLite, not files: the sibling `<base>/sounds.db` exists…
        assert!(base.join("sounds.db").is_file(), "sounds.db exists after the write");
        // …and NO legacy per-id file (nor the `sounds/` dir) was created.
        assert!(!base.join("sounds").join("signal.json").exists(), "no per-id json file was written");
        assert!(!base.join("sounds").exists(), "no file-based `sounds/` store dir was created");

        let _ = std::fs::remove_dir_all(&base);
    }
}
