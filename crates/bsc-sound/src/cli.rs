//! The `bsc sound` subcommand (#3080, epic #3071) — the sound-kit shim over the shared
//! verbatim-JSON-per-id store CLI ([`bsc_json_store::cli`], #2158). The sound library
//! (`~/.base-studio-code/sounds.db`) is list/get/set/remove-able from a session's own shell — the same
//! store the desktop Sounds library reads/writes and the (future) sound designer can author into.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc sound help          # compact menu
//!   bsc sound get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the `BSC_SOUND_DIR` env var, defaulting to
//! `~/.base-studio-code/sounds/` (the db at `~/.base-studio-code/sounds.db`).

use crate::release::ReleaseStore;
use bsc_cli_util::CmdDoc;
use bsc_json_store::cli::CliSpec;
use std::io::Read;

const TAGLINE: &str =
    "the user sound-kit store — list/get/set/remove ~/.base-studio-code/sounds + the versioned `release` store (#3080/#3371)";

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every kit's {id, name} (JSON)",
        usage: "\
USAGE:
  bsc sound list [--full] [--pretty]

Prints every sound kit's { id, name } as JSON (compact; --pretty for indented). --full emits the
COMPLETE kit objects (primitives + voices + cues) as a plain array — the full-fidelity read the
desktop Sounds library hydration needs.",
    },
    CmdDoc {
        name: "get",
        summary: "print one kit (JSON, verbatim) or null",
        usage: "\
USAGE:
  bsc sound get <id> [--pretty]

Prints the stored sound-kit JSON for <id> verbatim, or `null` if absent.",
    },
    CmdDoc {
        name: "set",
        summary: "upsert from kit JSON on stdin; prints id(s)",
        usage: "\
USAGE:
  bsc sound set [--pretty]   # kit JSON (one object or an array) on stdin

Upserts each sound kit by its (required, non-empty) \"id\" field, written verbatim. Prints the id(s)
written. Use this to author or update a kit from a session (the sound designer authors kits this way).",
    },
    CmdDoc {
        name: "remove",
        summary: "delete a kit (no-op if absent)",
        usage: "\
USAGE:
  bsc sound remove <id> [--pretty]

Deletes the sound kit keyed by <id>. A no-op (not an error) when it does not exist.",
    },
    CmdDoc {
        name: "release",
        summary: "the versioned sound-kit release store — immutable id@version artifacts blueprints pin (#3371)",
        usage: "\
USAGE:
  bsc sound release list [--pretty]                  # every stored release's manifest (+ the packaged default)
  bsc sound release get <id@version> [--artifact]    # one manifest (or null); --artifact prints the kit JSON
  bsc sound release add <id> <version> [--source URL] [--sha256 HEX] [--file PATH]
  bsc sound release add <id> <version> --from-store <kit>   # cut the release from the live kit in the sound store
  bsc sound release remove <id@version>              # delete a materialized entry (packaged stays embedded)
  bsc sound release verify <id@version>              # recompute the artifact hash against the manifest

The versioned release store at ~/.base-studio-code/sound-kits/<id>/<version>/ (--dir/
BSC_SOUND_KIT_STORE_DIR override): one immutable copy per id@version — a
{ id, version, sha256, kind: \"sound-kit\", source? } manifest + the kit artifact — shared by every
blueprint that pins it. This is the sounds twin of `bsc ui release` (#2465), same contract.

DISTINCT from the mutable working kits of `bsc sound list/get/set` (#3080): those are what you
AUTHOR, a release is a frozen published snapshot of one. Different store root, so the two never
collide. `add` reads the artifact from stdin (or --file), verifies --sha256 BEFORE writing (mismatch
⇒ nothing stored), and refuses to overwrite an existing version with different content (bump the
version instead). It also REFUSES a hollow release: an artifact that is empty, doesn't parse, or
carries ZERO cues is rejected before anything is stored. --from-store <kit> cuts the release in one
shot from the live sound store (instead of hand-piping --file): it reads that kit record and
canonicalizes it, so an authoring session publishes what it just wrote with its one granted CLI. The
packaged `bsc/signal` kit resolves as a built-in entry with zero setup and zero network.",
    },
];

/// The env var overriding the VERSIONED release store root (#3371) — the sounds twin of
/// `BSC_UI_KIT_STORE_DIR`. Deliberately distinct from `SPEC.dir_env` (`BSC_SOUND_DIR`, the flat
/// working store): the two stores are separate roots and must be redirectable independently, so a test
/// or a sandboxed session can point one somewhere without dragging the other along.
const RELEASE_DIR_ENV: &str = "BSC_SOUND_KIT_STORE_DIR";

/// The sound store's concrete knobs over the shared CLI (#2158): its noun, env var, dir segment, help
/// catalog, and the `{id, name}` lean-`list` projection.
const SPEC: CliSpec = CliSpec {
    noun: "sound",
    dir_env: "BSC_SOUND_DIR",
    dir_segment: "sounds",
    tagline: TAGLINE,
    commands: COMMANDS,
    meta_fields: &["id", "name"],
    graph_fields: &[],
    field_aliases: &[],
};

/// The `sound` subcommand entrypoint: `args` is everything after `bsc sound`; `prog` is the display
/// name for help/errors. The locally-owned `release` verb (#3371, the versioned store) is intercepted
/// here; everything else delegates to the shared flat-store dispatch with the sound [`SPEC`]. Same
/// shape as `bsc ui`, which owns `release` and delegates its library verbs to `bsc component`.
/// `release` is in [`COMMANDS`] so the ONE catalog still drives the overview + per-command help.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("release") {
        return cmd_release(&args[1..], prog);
    }
    bsc_json_store::cli::run(args, prog, &SPEC)
}

/// `bsc sound release …` (#3371) — the versioned release store (see [`crate::release`]). Resolves the
/// store dir from `--dir`, else `$BSC_SOUND_KIT_STORE_DIR`, else `~/.base-studio-code/sound-kits/`.
/// Mirrors `bsc ui release`'s flag grammar verb-for-verb so the two stores are one contract to learn.
fn cmd_release(args: &[String], prog: &str) -> Result<(), String> {
    if args.first().map(String::as_str) == Some("help") || args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{}", bsc_cli_util::help_for(prog, TAGLINE, COMMANDS, "release"));
        return Ok(());
    }
    // Flag parsing: --flag <value> pairs + boolean flags; everything else is positional.
    let mut dir = None::<String>;
    let mut kind = "sound-kit".to_string();
    let mut source = None::<String>;
    let mut sha = None::<String>;
    let mut file = None::<String>;
    let mut from_store = None::<String>;
    let (mut pretty, mut want_artifact) = (false, false);
    let mut positional: Vec<String> = Vec::new();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--dir" => dir = it.next().cloned(),
            "--kind" => kind = it.next().cloned().unwrap_or_default(),
            "--source" => source = it.next().cloned(),
            "--sha256" => sha = it.next().cloned(),
            "--file" => file = it.next().cloned(),
            "--from-store" => from_store = it.next().cloned(),
            "--pretty" => pretty = true,
            "--artifact" => want_artifact = true,
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => positional.push(a.clone()),
        }
    }
    let store = match dir.or_else(|| std::env::var(RELEASE_DIR_ENV).ok()).filter(|d| !d.trim().is_empty())
    {
        Some(d) => ReleaseStore::new(d),
        None => ReleaseStore::open_default()?,
    };
    let emit = |v: &serde_json::Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    let kit_ref = |n: usize| -> Result<(&str, &str), String> {
        crate::release::split_ref(positional.get(n).map(String::as_str).ok_or("missing <id@version>")?)
    };
    match positional.first().map(String::as_str).unwrap_or("list") {
        "list" => emit(&serde_json::Value::Array(store.list())),
        "get" => {
            let (id, version) = kit_ref(1)?;
            if want_artifact {
                match store.artifact(id, version)? {
                    Some(text) => {
                        println!("{}", text.trim_end_matches('\n'));
                        Ok(())
                    }
                    None => {
                        println!("null");
                        Ok(())
                    }
                }
            } else {
                emit(&store.get(id, version)?.unwrap_or(serde_json::Value::Null))
            }
        }
        "add" => {
            let id = positional.get(1).ok_or(
                "usage: bsc sound release add <id> <version> [--source URL] [--sha256 HEX] [--file PATH | --from-store KIT]",
            )?;
            let version = positional.get(2).ok_or("usage: bsc sound release add <id> <version> …")?;
            // Source the artifact: cut from a live kit in the flat sound store (--from-store), else read
            // from --file / stdin. The two sources are mutually exclusive.
            let content = if let Some(kit_id) = &from_store {
                if file.is_some() {
                    return Err("give either --from-store <kit> or --file <path>, not both".into());
                }
                artifact_from_store(kit_id)?
            } else {
                match &file {
                    Some(p) => std::fs::read_to_string(p).map_err(|e| format!("cannot read {p}: {e}"))?,
                    None => {
                        let mut s = String::new();
                        std::io::stdin()
                            .read_to_string(&mut s)
                            .map_err(|e| format!("cannot read stdin: {e}"))?;
                        s
                    }
                }
            };
            // Refuse a hollow / shapeless release BEFORE writing the immutable entry: an empty artifact,
            // or one that doesn't parse or carries zero cues, is rejected and nothing is stored.
            crate::release::validate_artifact(&kind, &content)?;
            emit(&store.add_verified(id, version, &kind, source.as_deref(), &content, sha.as_deref())?)
        }
        "remove" => {
            let (id, version) = kit_ref(1)?;
            store.remove(id, version)?;
            println!("removed {id}@{version}");
            Ok(())
        }
        "verify" => {
            let (id, version) = kit_ref(1)?;
            let hash = store.verify(id, version)?;
            println!("ok {hash}");
            Ok(())
        }
        other => Err(format!(
            "unknown release command '{other}' — want: list | get | add | remove | verify"
        )),
    }
}

/// Cut a release artifact from the LIVE flat sound store (`--from-store <kit>`) — the one-shot
/// alternative to hand-piping a `--file`, so an authoring session publishes what it just wrote using
/// only its one granted `bsc sound` prefix. Reads the kit record from the SAME flat store `bsc sound
/// get` serves (honoring `$BSC_SOUND_DIR`; `--dir` names the RELEASE store, not the working one) and
/// canonicalizes it via [`crate::release::assemble_artifact`]. Errors loudly when the kit isn't in the
/// store — the pipeline-failed case, surfaced before anything is stored.
fn artifact_from_store(kit_id: &str) -> Result<String, String> {
    let dir = bsc_cli_util::resolve_store_path(&None, SPEC.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(SPEC.dir_segment))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    let flat = bsc_json_store::Store::new(dir, SPEC.noun);
    let record = flat.get(kit_id)?.ok_or_else(|| {
        format!(
            "sound kit '{kit_id}' is not in the sound store — author it with `bsc sound set` first (or check the id with `bsc sound list`)"
        )
    })?;
    let kit: serde_json::Value = serde_json::from_str(&record)
        .map_err(|e| format!("sound kit '{kit_id}' record is not valid JSON: {e}"))?;
    Ok(crate::release::assemble_artifact(&kit))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_is_the_sound_store_with_the_lean_id_name_list() {
        assert_eq!(SPEC.noun, "sound");
        assert_eq!(SPEC.dir_env, "BSC_SOUND_DIR");
        assert_eq!(SPEC.dir_segment, "sounds");
        assert_eq!(SPEC.meta_fields, &["id", "name"]);
    }

    #[test]
    fn help_overview_lists_commands_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc sound", TAGLINE, COMMANDS);
        for c in ["list", "get", "set", "remove", "release"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc sound", TAGLINE, COMMANDS, "set");
        assert!(one.contains("bsc sound set"));
        assert!(one.contains("stdin"));
        assert!(bsc_cli_util::help_for("bsc sound", TAGLINE, COMMANDS, "nope").contains("COMMANDS:"));
    }

    // ── the versioned release store (#3371) ──────────────────────────────────────────────────────

    #[test]
    fn release_help_explains_the_store_contract_and_needs_no_store_dir() {
        let d = bsc_cli_util::help_for("bsc sound", TAGLINE, COMMANDS, "release");
        for needle in [
            "bsc sound release list",
            "bsc sound release verify",
            "--from-store",
            "BSC_SOUND_KIT_STORE_DIR",
            "sound-kits",
            "immutable",
            "bsc/signal",
        ] {
            assert!(d.contains(needle), "release help mentions {needle}");
        }
        // `bsc sound release help` routes to the same detail WITHOUT touching a store.
        assert!(run(vec!["release".into(), "help".into()], "bsc sound").is_ok());
    }

    /// The release verb is intercepted BEFORE the shared flat-store dispatch, so it can never be read
    /// as a kit id (`bsc sound get release`) nor reach the SQLite store.
    #[test]
    fn release_is_owned_here_and_never_delegates_to_the_flat_store() {
        assert_eq!(RELEASE_DIR_ENV, "BSC_SOUND_KIT_STORE_DIR");
        assert_ne!(RELEASE_DIR_ENV, SPEC.dir_env, "the two stores are independently redirectable");
        assert!(COMMANDS.iter().any(|c| c.name == "release"), "one catalog drives every help surface");
    }

    #[test]
    fn release_cli_round_trips_add_list_get_verify_remove_against_an_explicit_dir() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bsc-sound-release-cli-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let art = dir.join("kit.json");
        std::fs::write(
            &art,
            "{\"id\":\"neon\",\"name\":\"Neon\",\"primitives\":[],\"voices\":[],\"cues\":[{\"id\":\"click\"}]}\n",
        )
        .unwrap();

        let rel = |extra: &[&str]| -> Result<(), String> {
            let mut args = vec!["release".to_string()];
            args.extend(extra.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), dir.display().to_string()]);
            run(args, "bsc sound")
        };

        // add (from a file) → get → verify → list → remove, the full CLI contract.
        rel(&["add", "acme/neon", "1.0.0", "--file", &art.display().to_string()]).unwrap();
        rel(&["get", "acme/neon@1.0.0"]).unwrap();
        rel(&["get", "acme/neon@1.0.0", "--artifact"]).unwrap();
        rel(&["verify", "acme/neon@1.0.0"]).unwrap();
        rel(&["list"]).unwrap();
        // Failure cases surface as errors, never a silent success.
        assert!(rel(&["verify", "acme/neon@9.9.9"]).is_err(), "an unknown version fails");
        assert!(rel(&["get", "acme/neon"]).is_err(), "a ref missing @version is rejected");
        assert!(rel(&["nope"]).is_err(), "an unknown release verb is rejected");
        assert!(rel(&["add", "acme/neon", "1.0.0", "--file", &art.display().to_string(), "--from-store", "neon"]).is_err(), "--file and --from-store are mutually exclusive");
        // A duplicate release with DIFFERENT bytes is refused (immutability), through the CLI.
        let other = dir.join("other.json");
        std::fs::write(&other, "{\"id\":\"neon\",\"cues\":[{\"id\":\"toggle\"}]}\n").unwrap();
        let err = rel(&["add", "acme/neon", "1.0.0", "--file", &other.display().to_string()]).unwrap_err();
        assert!(err.contains("immutable"), "{err}");
        // A hollow artifact is refused before anything is stored.
        let hollow = dir.join("hollow.json");
        std::fs::write(&hollow, "{\"id\":\"neon\",\"cues\":[]}").unwrap();
        assert!(rel(&["add", "acme/hollow", "1.0.0", "--file", &hollow.display().to_string()])
            .unwrap_err()
            .contains("ZERO cues"));

        rel(&["remove", "acme/neon@1.0.0"]).unwrap();
        assert!(rel(&["verify", "acme/neon@1.0.0"]).is_err(), "removed ⇒ no longer resolvable");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The packaged `signal` kit resolves through the CLI with an EMPTY store dir and no network — the
    /// fresh-install path #3372's default pin depends on.
    #[test]
    fn release_cli_resolves_the_packaged_signal_kit_from_an_empty_store() {
        let dir = std::env::temp_dir().join(format!("bsc-sound-release-empty-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let rel = |extra: &[&str]| -> Result<(), String> {
            let mut args = vec!["release".to_string()];
            args.extend(extra.iter().map(|s| s.to_string()));
            args.extend(["--dir".to_string(), dir.display().to_string()]);
            run(args, "bsc sound")
        };
        rel(&["get", "bsc/signal@1.0.0"]).unwrap();
        rel(&["verify", "bsc/signal@1.0.0"]).unwrap();
        rel(&["list"]).unwrap();
        assert!(!dir.exists(), "the packaged fallback materializes nothing");
    }

    /// `--from-store` reads the FLAT store (`$BSC_SOUND_DIR`) and cuts a verifiable release from it —
    /// the sound-designer's publish step, using only its one granted `bsc sound` prefix.
    #[test]
    fn release_add_from_store_cuts_a_release_from_the_live_sound_store() {
        use std::sync::atomic::{AtomicU64, Ordering};
        static N: AtomicU64 = AtomicU64::new(0);
        let base = std::env::temp_dir().join(format!(
            "bsc-sound-from-store-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let flat_dir = base.join("sounds");
        let rel_dir = base.join("sound-kits");

        // Author a kit into the flat store exactly as `bsc sound set` does.
        let flat = bsc_json_store::Store::new(flat_dir.clone(), SPEC.noun);
        flat.set(
            "neon",
            "{\"id\":\"neon\",\"name\":\"Neon\",\"primitives\":[],\"voices\":[],\"cues\":[{\"id\":\"click\"}]}",
        )
        .unwrap();

        // `--from-store` locates the flat store through SPEC.dir_env, so point it at our temp one.
        // (Serialized against the other env-reading tests by using a distinct process-unique dir.)
        std::env::set_var(SPEC.dir_env, flat_dir.display().to_string());
        let out = run(
            vec![
                "release".into(),
                "add".into(),
                "acme/neon".into(),
                "1.0.0".into(),
                "--from-store".into(),
                "neon".into(),
                "--dir".into(),
                rel_dir.display().to_string(),
            ],
            "bsc sound",
        );
        // A kit that is NOT in the flat store errors loudly rather than storing a hollow entry.
        let missing = run(
            vec![
                "release".into(),
                "add".into(),
                "acme/ghost".into(),
                "1.0.0".into(),
                "--from-store".into(),
                "ghost".into(),
                "--dir".into(),
                rel_dir.display().to_string(),
            ],
            "bsc sound",
        );
        std::env::remove_var(SPEC.dir_env);

        out.unwrap();
        assert!(
            missing.unwrap_err().contains("is not in the sound store"),
            "an absent kit is refused with a pointer to `bsc sound set`"
        );

        // The release really landed, carries the authored cue, and verifies.
        let store = crate::release::ReleaseStore::new(rel_dir);
        let artifact = store.artifact("acme/neon", "1.0.0").unwrap().expect("artifact stored");
        let kit: serde_json::Value = serde_json::from_str(&artifact).unwrap();
        assert_eq!(kit["cues"][0]["id"], "click", "the authored cue rode into the release");
        store.verify("acme/neon", "1.0.0").unwrap();
        let _ = std::fs::remove_dir_all(&base);
    }
}
