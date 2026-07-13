//! `bsc-persona` — the persona-specific shim over the shared `bsc-json-store` (#2158). The user
//! persona store (`~/.base-studio-code/personas/<id>.json`, #2094, an instance of #1325) is a
//! verbatim-JSON-per-id file store; the store CRUD + the `list/get/set/remove` CLI now live once in
//! [`bsc_json_store`], and this crate supplies only the persona-specific nouns + lean `list` fields.
//!
//! A **persona** is the CRUD-able behavioral identity of an agent — a start prompt + attached skills +
//! default model, running under a referenced ROLE (its permission floor). It is the one store the
//! desktop Personas library and every live console session + the planner share: the desktop UI reaches
//! it through the generic `bsc` command (`bsc persona …`, over the #2114 bridge), and a session's own
//! shell reaches the same store through the [`cli`] module — so the planner can mint a persona the same
//! way it mints a skill. Packaged (built-in) personas are seeded into this store on first hydrate + kept
//! reconciled by the frontend, exactly like the user blueprint library.

pub mod cli;

#[cfg(test)]
mod tests {
    use bsc_json_store::Store;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A per-test unique suffix so parallel tests never share a base dir.
    fn uniq() -> String {
        static N: AtomicU64 = AtomicU64::new(0);
        format!("{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed))
    }

    /// #2986 (epic #2982) regression: the persona store persists to a SQLite **`personas.db`**, NOT to
    /// per-id `personas/<id>.json` files. #2983 migrated the shared `bsc-json-store` backend
    /// JSON-files → SQLite transparently; `bsc-persona` rides it over `bsc_json_store::Store` with
    /// segment `personas` / noun `persona` (the [`cli::SPEC`](crate::cli) config). This pins that a
    /// round-trip write/read through the persona store leaves a `<base>/personas.db` and creates no
    /// `<base>/personas/<id>.json`.
    ///
    /// The crate exposes no base-dir-injectable persona API (only the `bsc persona` CLI), so — per the
    /// #2986 spec — it drives the shared `Store` directly with the persona store's own segment + noun.
    #[test]
    fn persona_store_persists_to_sqlite_not_json_files() {
        // A fresh temp base — the `~/.base-studio-code` root the persona store lives under.
        let base = std::env::temp_dir().join(format!("bsc-persona-sqlite-{}", uniq()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        // The persona store exactly as its CLI configures it (mirrors `cli::SPEC.dir_segment` / `.noun`).
        let store = Store::new(base.join("personas"), "persona");

        // Round-trip: write a persona, read it back verbatim (and via list).
        let persona = r#"{"id":"review-bot","name":"Review Bot","role":"reviewer"}"#;
        store.set("review-bot", persona).unwrap();
        assert_eq!(
            store.get("review-bot").unwrap().as_deref(),
            Some(persona),
            "the persona reads back verbatim",
        );
        assert_eq!(store.list(), vec![persona.to_string()], "and lists from the db");

        // The claim — SQLite, not files: the sibling `<base>/personas.db` exists after the write…
        let db = base.join("personas.db");
        assert!(db.is_file(), "personas.db exists after the write: {}", db.display());
        // …and NO legacy per-id file (nor even the `personas/` dir) was created.
        let legacy = base.join("personas").join("review-bot.json");
        assert!(!legacy.exists(), "no per-id json file was written: {}", legacy.display());
        assert!(
            !base.join("personas").exists(),
            "no file-based `personas/` store dir was created",
        );

        let _ = std::fs::remove_dir_all(&base);
    }
}
