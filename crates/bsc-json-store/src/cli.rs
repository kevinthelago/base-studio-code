//! The shared agent-facing CLI over a verbatim-JSON-per-id store (#2158). `bsc-blueprint` and
//! `bsc-persona` had byte-identical `list/get/set/remove` dispatch — this is the one copy, made
//! concrete per store by a [`CliSpec`] (its nouns, env var, directory segment, help catalog, and the
//! keys the lean `list` projects). Each wrapper crate's `cli::run` is a one-liner over [`run`].
//!
//! Per-command help (#1762) and the flag→env→default store resolution ([`bsc_cli_util`]) are
//! unchanged from the two originals:
//!   bsc <noun> help          # compact menu
//!   bsc <noun> get help      # detailed help for ONE command
//!
//! The store is located via `--dir <path>` or the store's env var, defaulting to
//! `~/.base-studio-code/<segment>/`. Output is JSON to stdout: compact by default, `--pretty` indents.

use crate::Store;
use bsc_cli_util::CmdDoc;
use bsc_sqlite_util::{print_json, read_stdin_json};
use serde_json::Value;

/// The per-store knobs that make the otherwise-identical CLI concrete.
pub struct CliSpec {
    /// Singular record noun, used for the stdin-read + id-validation errors (`"blueprint"` / `"persona"`).
    pub noun: &'static str,
    /// The env var naming the store dir (`"BSC_BLUEPRINT_DIR"` / `"BSC_PERSONA_DIR"`).
    pub dir_env: &'static str,
    /// The default store directory segment under `~/.base-studio-code/` (`"blueprints"` / `"personas"`).
    pub dir_segment: &'static str,
    /// One-line store description for the help header.
    pub tagline: &'static str,
    /// The command catalog (drives dispatch validation + the shared help system).
    pub commands: &'static [CmdDoc],
    /// The keys the lean `list` projects from each stored object (`["id","name"]` / `["id","name","role"]`),
    /// each rendered as the stored string — or verbatim for a non-string value (e.g. the component
    /// store's `shapes` array, #2475) — and `""` when absent.
    pub meta_fields: &'static [&'static str],
    /// The keys `list --graph` projects (#4072) — a store's GRAPH projection: exactly the fields a
    /// graph view renders (its nodes + the field its edges derive from), and nothing else.
    ///
    /// It exists because the desktop hydrated its Design Studio graph with `--full`, which for 321
    /// components is 1.72 MB — 77.6% of it `srcText`, which no node reads. The projection is 33 KB,
    /// 1.9% of that, and the page blocked up to 8s on the difference.
    ///
    /// EMPTY (`&[]`) means the store has no graph view; `--graph` is then rejected rather than
    /// silently falling back to {@link CliSpec::meta_fields}, which would hand a caller a shape that
    /// looks right and is missing the fields its edges need.
    pub graph_fields: &'static [&'static str],
    /// Field RENAMES this collection has been through: `(current, legacy)` (#4107 slice B).
    ///
    /// A JSON document store has no schema migration — records are written once and read forever — so a
    /// renamed field would otherwise project as absent (`""`) for every record predating the rename.
    /// That does not read as a bug; it reads as data that was never there. The component store hit this
    /// renaming `group` -> `folder` with 351 stored records.
    ///
    /// Applied by [`lean_meta`] on the way OUT: a projection prefers the current key and falls back to
    /// the legacy one. Writes always emit the current name, so a record migrates the first time it is
    /// rewritten and the alias is a read-side bridge, never a second source of truth.
    pub field_aliases: &'static [(&'static str, &'static str)],
}

/// Parsed global flags + leftover positional args.
struct Args {
    dir: Option<String>,
    pretty: bool,
    /// `list --full`: emit the COMPLETE stored objects as a plain array — the full-fidelity read the
    /// desktop library hydration needs (#2143). Ignored by other subcommands.
    full: bool,
    /// `--raw` (#3166): byte-clean output for `while read` / `$( )` — raw UTF-8, LF-only, NO JSON
    /// envelope/quoting. On `list` it prints one id per line; on `get` it prints the stored record raw
    /// (CR-stripped). Neutralizes the CRLF + cp1252 traps that broke shell audits. Ignored elsewhere.
    raw: bool,
    /// `list --graph` (#4072): emit only the store's GRAPH projection — the fields a graph view
    /// actually renders. Takes precedence over `--full` (both are JSON shapes; this is the narrower).
    graph: bool,
    /// `set --file <name>` (#3373): read the payload from a BARE-NAMED file in `$BSC_SCRATCH` instead
    /// of stdin. The channel a restricted studio session must use — a heredoc cannot be allow-listed,
    /// since newlines are command separators, so its JSON body parses as its own unmatchable commands.
    /// Resolution + the traversal defence live in `bsc_cli_util::read_payload`.
    file: Option<String>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let mut a = Args { dir: None, pretty: false, full: false, graph: false, raw: false, file: None, positional: Vec::new() };
    let mut it = raw.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--dir" => a.dir = Some(it.next().ok_or("--dir needs a path")?),
            "--pretty" => a.pretty = true,
            "--full" => a.full = true,
            "--graph" => a.graph = true,
            "--raw" => a.raw = true,
            "--file" => a.file = Some(it.next().ok_or("--file needs a bare filename in $BSC_SCRATCH")?),
            // `-h`/`--help` route to the help command (anywhere on the line).
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            _ => a.positional.push(arg),
        }
    }
    Ok(a)
}

/// A per-mutation observer: fired with the affected id AFTER a `set` write (once per upserted id) or
/// a `remove` lands (#2525). The seam the component/theme stores use to emit their `ui-touch` activity
/// line WITH their own collection context — bsc-json-store never emits itself (it has no collection
/// context, the reason the emit doesn't live here), it just invokes the caller's hook.
pub type WriteHook<'a> = &'a dyn Fn(&str);

/// A per-`set` batch validator: given the parsed records about to be upserted, return `Err` to REJECT
/// the whole batch before anything is written (#2928). The seam a domain store uses to enforce a
/// write-time invariant the generic verbatim store can't know — e.g. the component store rejects a
/// `srcText` that looks like a module but won't build (an unterminated string). Runs BEFORE `set_items`.
pub type SetValidator<'a> = &'a dyn Fn(&[Value]) -> Result<(), String>;

/// The store subcommand entrypoint: `args` is everything after `bsc <noun>`; `prog` is the display
/// name for help/errors (`"bsc blueprint"` from the umbrella). `spec` supplies the per-store nouns +
/// help catalog. Handles help (no command / `help` / `help <cmd>` / `<cmd> help`) before any store read.
pub fn run(args: Vec<String>, prog: &str, spec: &CliSpec) -> Result<(), String> {
    run_hooked(args, prog, spec, None)
}

/// [`run`] with an optional [`WriteHook`] fired after each `set`/`remove` write lands (#2525). Stores
/// that don't observe writes call [`run`] (`on_write = None`); the component/kit/theme surfaces pass a
/// hook that emits a `ui-touch` line for the Design Studio's live-focus.
pub fn run_hooked(args: Vec<String>, prog: &str, spec: &CliSpec, on_write: Option<WriteHook>) -> Result<(), String> {
    run_hooked_validated(args, prog, spec, on_write, None)
}

/// [`run_hooked`] with an optional per-`set` batch [`SetValidator`] (#2928) run on the parsed records
/// BEFORE any write — if it errors, the batch is REJECTED and nothing is stored. The component surface
/// passes a validator that rejects a `srcText` that looks like a module but won't build (an unterminated
/// string — the escape-collapse corruption class). Stores with no domain validation call [`run_hooked`].
pub fn run_hooked_validated(
    args: Vec<String>,
    prog: &str,
    spec: &CliSpec,
    on_write: Option<WriteHook>,
    validate: Option<SetValidator>,
) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    // Top-level + per-command help, run BEFORE resolving the store (help works without a store dir).
    if bsc_cli_util::handle_help(prog, spec.tagline, spec.commands, &args.positional) {
        return Ok(());
    }

    let store = resolve_store(&args.dir, spec)?;

    match cmd.as_str() {
        // Every record's lean projection ({id, name[, role]}) — the library's id/label summary (the
        // full JSON is one `get` away, or `list --full`). Each stored file is parsed leniently so an
        // odd-shaped file never aborts the list.
        "list" => {
            if args.raw {
                // Byte-clean id list (#3166): one id per line, LF-only, no JSON envelope — safe for
                // `for id in $(bsc <noun> list --raw)` / `while read id`. Records with no usable id are
                // skipped so the list never carries a blank or garbage line (the class of bug that let a
                // `while read` audit silently run on zero rows and report success). `--raw` wins over
                // `--full`/`--pretty` (they're JSON shapes; raw is the non-JSON one).
                let ids: Vec<String> = store.list().iter().filter_map(|j| id_field(j)).collect();
                bsc_cli_util::print_raw_lines(&ids);
            } else if args.graph {
                // #4072 — the GRAPH projection: only what a graph view renders. Rejected (never
                // silently widened to the lean meta) for a store that declares none, so a caller
                // cannot get a plausible-looking shape whose edge field is missing.
                if spec.graph_fields.is_empty() {
                    return Err(format!(
                        "{prog} list --graph: the {} store has no graph projection",
                        spec.noun
                    ));
                }
                let metas: Vec<Value> =
                    store.list().iter().map(|j| lean_meta_aliased(j, spec.graph_fields, spec.field_aliases)).collect();
                print_json(&metas, args.pretty);
            } else if args.full {
                // Full-fidelity read (#2143): every record's COMPLETE JSON object as a plain array.
                // An unparseable file is skipped (matching the lenient lean path).
                let full: Vec<Value> = store
                    .list()
                    .iter()
                    .filter_map(|j| serde_json::from_str::<Value>(j).ok())
                    .collect();
                print_json(&full, args.pretty);
            } else {
                let metas: Vec<Value> =
                    store.list().iter().map(|j| lean_meta_aliased(j, spec.meta_fields, spec.field_aliases)).collect();
                print_json(&metas, args.pretty);
            }
            Ok(())
        }
        "get" => {
            let id = args.positional.get(1).ok_or_else(|| format!("usage: {prog} get <id>"))?;
            match store.get(id)? {
                // `--raw` (#3166): the stored JSON straight to stdout as bytes, CR-stripped, LF-only,
                // no `println!`/locale layer — safe for `$( )` capture (composes with the `--field`
                // read #3162 adds: field present ⇒ that value raw, else the whole record raw). A miss
                // prints NOTHING (empty capture), not the literal `null`. Else print verbatim / `null`.
                Some(json) if args.raw => bsc_cli_util::print_raw(json.trim_end()),
                None if args.raw => {}
                Some(json) => println!("{}", json.trim_end()),
                None => println!("null"),
            }
            Ok(())
        }
        // Upsert from an object — or an array of them — written verbatim by id. Two channels with
        // identical semantics (#3373): stdin, or `--file <bare-name>` from the session's `$BSC_SCRATCH`.
        "set" => {
            let items: Vec<Value> = match args.file.as_deref() {
                None => read_stdin_json(spec.noun)?,
                Some(name) => bsc_sqlite_util::parse_json_items(&bsc_cli_util::read_payload(Some(name))?, spec.noun)?,
            };
            // Domain write-time gate (#2928): reject the whole batch before any write if it fails.
            if let Some(v) = validate {
                v(&items)?;
            }
            let ids = set_items(&store, &items, spec.noun, on_write)?;
            print_json(&ids, args.pretty);
            Ok(())
        }
        "remove" => {
            let id = args.positional.get(1).ok_or_else(|| format!("usage: {prog} remove <id>"))?;
            store.remove(id)?;
            if let Some(hook) = on_write {
                hook(id);
            }
            print_json(&id, args.pretty);
            Ok(())
        }
        other => Err(bsc_cli_util::unknown_command(prog, spec.tagline, spec.commands, other)),
    }
}

/// Upsert every `item` into `store` by its (required, non-empty) `id`, written verbatim, firing
/// `on_write(id)` after each write lands (#2525). Returns the written ids in input order. Split out of
/// the `set` arm so the per-id write + hook is unit-testable without a drivable stdin.
fn set_items(store: &Store, items: &[Value], noun: &str, on_write: Option<WriteHook>) -> Result<Vec<String>, String> {
    let mut ids = Vec::new();
    for item in items {
        let id = id_of(item, noun)?;
        let json = serde_json::to_string(item).map_err(|e| format!("set: {e}"))?;
        store.set(&id, &json)?;
        if let Some(hook) = on_write {
            hook(&id);
        }
        ids.push(id);
    }
    Ok(ids)
}

/// Resolve the store: explicit `--dir` wins, then the store's env var, else the default user store at
/// `~/.base-studio-code/<segment>/`. The flag→env→default precedence is the shared
/// [`bsc_cli_util::resolve_store_path`]; the resolved dir is wrapped in a [`Store`].
fn resolve_store(flag: &Option<String>, spec: &CliSpec) -> Result<Store, String> {
    let segment = spec.dir_segment;
    let dir = bsc_cli_util::resolve_store_path(flag, spec.dir_env, || {
        bsc_util::bsc_base_dir()
            .map(|b| b.join(segment))
            .ok_or_else(|| "could not resolve a home directory; set HOME/USERPROFILE".to_string())
    })?;
    Ok(Store::new(dir, spec.noun))
}

/// The `id` of a stored record's raw JSON, if present as a non-empty string — the lenient projection
/// `list --raw` prints one-per-line (#3166). An unparseable file, a missing `id`, or a non-string /
/// blank `id` all yield `None` (that record is skipped), so the raw id list is never polluted by a
/// blank or garbage line. Trimmed to match [`id_of`]'s key normalization.
pub fn id_field(json: &str) -> Option<String> {
    serde_json::from_str::<Value>(json)
        .ok()?
        .get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The `id` of a stored Value — required, non-empty (it keys the on-disk file). `noun` names the
/// record in the error (`each <noun> needs a non-empty "id"`).
pub fn id_of(v: &Value, noun: &str) -> Result<String, String> {
    v.get("id")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| format!("each {noun} needs a non-empty \"id\""))
}

/// The lean `list` projection one record contributes: an object with just `fields`, each the stored
/// string — a NON-string value (an array like the component store's `shapes`, #2475) rides verbatim —
/// or `""` when missing / null; robust to odd-shaped files (an unparseable blob yields all-empty,
/// never a panic). `fields` are alphabetically ordered by the shipped specs (`id`,`name`,`role`,…),
/// so the `serde_json::Map` (BTreeMap) render is byte-identical to the old derived structs.
/// Public so a wrapper's custom read verbs (e.g. `bsc ui list --shape`) project the SAME lean shape.
pub fn lean_meta(json: &str, fields: &[&str]) -> Value {
    lean_meta_aliased(json, fields, &[])
}

/// [`lean_meta`] with a collection's {@link CliSpec::field_aliases} applied — the projection prefers the
/// current key and falls back to the legacy one, so a record written before a rename still projects its
/// value instead of `""`.
pub fn lean_meta_aliased(json: &str, fields: &[&str], aliases: &[(&str, &str)]) -> Value {
    let v: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    let mut m = serde_json::Map::new();
    for f in fields {
        let looked_up = v.get(*f).or_else(|| {
            aliases
                .iter()
                .find(|(cur, _)| cur == f)
                .and_then(|(_, legacy)| v.get(*legacy))
        });
        let val = match looked_up {
            Some(Value::String(s)) => Value::String(s.clone()),
            Some(Value::Null) | None => Value::String(String::new()),
            Some(other) => other.clone(),
        };
        m.insert((*f).to_string(), val);
    }
    Value::Object(m)
}

#[cfg(test)]
mod tests {
    use super::*;

    // A CliSpec standing in for a wrapper, used to exercise the shared dispatch helpers.
    const TEST_COMMANDS: &[CmdDoc] = &[
        CmdDoc { name: "list", summary: "list", usage: "USAGE:\n  bsc widget list" },
        CmdDoc { name: "get", summary: "get one", usage: "USAGE:\n  bsc widget get <id>" },
        CmdDoc { name: "set", summary: "upsert from stdin", usage: "USAGE:\n  bsc widget set" },
        CmdDoc { name: "remove", summary: "delete", usage: "USAGE:\n  bsc widget remove <id>" },
    ];

    #[test]
    fn id_of_requires_a_non_empty_id_and_names_the_noun() {
        assert_eq!(id_of(&serde_json::json!({"id": "r1"}), "record").unwrap(), "r1");
        assert_eq!(id_of(&serde_json::json!({"id": "  r2 "}), "record").unwrap(), "r2");
        assert!(id_of(&serde_json::json!({"id": ""}), "blueprint").is_err());
        assert_eq!(
            id_of(&serde_json::json!({"name": "no id"}), "persona"),
            Err("each persona needs a non-empty \"id\"".into()),
        );
    }

    #[test]
    fn lean_meta_projects_requested_fields_and_tolerates_garbage() {
        // Blueprint shape: {id, name}.
        let m = lean_meta(r#"{"id":"bp","name":"Mobile","extra":1}"#, &["id", "name"]);
        assert_eq!(m, serde_json::json!({"id":"bp","name":"Mobile"}));
        // Persona shape: {id, name, role}.
        let m = lean_meta(
            r#"{"id":"persona-worker","name":"Worker","role":"worker"}"#,
            &["id", "name", "role"],
        );
        assert_eq!(m, serde_json::json!({"id":"persona-worker","name":"Worker","role":"worker"}));
        // A field-less / unparseable blob yields empty strings for each field, never a panic.
        let m = lean_meta("not json", &["id", "name"]);
        assert_eq!(m, serde_json::json!({"id":"","name":""}));
    }

    #[test]
    fn lean_meta_rides_non_string_fields_verbatim() {
        // The component store's `shapes` array (#2475) projects verbatim; absent stays "".
        let m = lean_meta(r#"{"id":"masterdetail","shapes":["list"]}"#, &["id", "shapes"]);
        assert_eq!(m, serde_json::json!({"id":"masterdetail","shapes":["list"]}));
        let m = lean_meta(r#"{"id":"button"}"#, &["id", "shapes"]);
        assert_eq!(m, serde_json::json!({"id":"button","shapes":""}));
        // An explicit null renders as "" too (matching the absent case).
        let m = lean_meta(r#"{"id":"x","shapes":null}"#, &["id", "shapes"]);
        assert_eq!(m, serde_json::json!({"id":"x","shapes":""}));
    }

    #[test]
    fn graph_flag_parses_and_is_independent_of_full() {
        // #4072 — `--graph` is its own JSON shape, not a modifier of `--full`.
        let a = parse_args(vec!["list".into(), "--graph".into()]).unwrap();
        assert!(a.graph && !a.full);
        let a = parse_args(vec!["list".into(), "--full".into()]).unwrap();
        assert!(a.full && !a.graph);
    }

    #[test]
    fn graph_is_rejected_for_a_store_that_declares_no_projection() {
        // The widget spec has `graph_fields: &[]`. It must ERROR rather than silently serving the lean
        // meta — a caller handed a plausible shape whose edge field is missing would draw a graph with
        // no edges and no error, which is the worst of both.
        let dir = std::env::temp_dir().join(format!("bsc-graphflag-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let err = run(
            vec!["list".into(), "--graph".into(), "--dir".into(), dir.to_string_lossy().into_owned()],
            "bsc widget",
            &widget_spec(),
        )
        .unwrap_err();
        assert!(err.contains("no graph projection"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn parse_args_reads_flags_and_positionals() {
        let a = parse_args(vec![
            "set".into(),
            "--dir".into(),
            "/tmp/w".into(),
            "--pretty".into(),
        ])
        .unwrap();
        assert_eq!(a.dir.as_deref(), Some("/tmp/w"));
        assert!(a.pretty);
        assert_eq!(a.positional, vec!["set".to_string()]);
        assert!(parse_args(vec!["--nope".into()]).is_err());
    }

    #[test]
    fn full_flag_parses_and_defaults_off() {
        assert!(!parse_args(vec!["list".into()]).unwrap().full, "default list is lean");
        assert!(parse_args(vec!["list".into(), "--full".into()]).unwrap().full, "--full opts into full objects");
    }

    #[test]
    fn raw_flag_parses_and_defaults_off() {
        // #3166: `--raw` selects byte-clean output; it's a known flag (no longer "unknown flag").
        assert!(!parse_args(vec!["list".into()]).unwrap().raw, "default is JSON output");
        assert!(parse_args(vec!["list".into(), "--raw".into()]).unwrap().raw, "--raw opts into raw output");
        assert!(parse_args(vec!["get".into(), "x".into(), "--raw".into()]).unwrap().raw);
        // It composes with the other flags without being swallowed.
        let a = parse_args(vec!["list".into(), "--raw".into(), "--dir".into(), "/tmp/w".into()]).unwrap();
        assert!(a.raw && a.dir.as_deref() == Some("/tmp/w"));
    }

    #[test]
    fn id_field_extracts_a_non_empty_string_id_or_none() {
        // The lenient projection `list --raw` maps each stored record through — the whole point is a
        // clean, gap-free id list.
        assert_eq!(id_field(r#"{"id":"button","name":"Button"}"#).as_deref(), Some("button"));
        assert_eq!(id_field(r#"{"id":"  chip  "}"#).as_deref(), Some("chip"), "trimmed like id_of");
        // No id / blank id / non-string id / unparseable ⇒ None (that record is skipped, no blank line).
        assert_eq!(id_field(r#"{"name":"no id"}"#), None);
        assert_eq!(id_field(r#"{"id":""}"#), None);
        assert_eq!(id_field(r#"{"id":"   "}"#), None);
        assert_eq!(id_field(r#"{"id":42}"#), None);
        assert_eq!(id_field("not json"), None);
    }

    #[test]
    fn raw_list_yields_one_clean_id_per_line_no_envelope_no_cr() {
        // The acceptance shape: `list --raw` = each stored record's id on its own LF-terminated line,
        // no JSON array/quotes, no `\r` — exactly what `while read id` / `$( )` needs. We assemble the
        // same string the dispatch prints (`print_raw_lines` over the extracted ids) so the contract is
        // asserted without capturing real stdout.
        let stored = [
            r#"{"id":"button","name":"Button"}"#,
            r#"{"name":"skipped — no id"}"#, // dropped, not a blank line
            r#"{"id":"chip"}"#,
        ];
        let ids: Vec<String> = stored.iter().filter_map(|j| id_field(j)).collect();
        let out = bsc_cli_util::raw_lines(&ids);
        assert_eq!(out, "button\nchip\n");
        assert!(!out.contains('\r'), "LF-only, no carriage return");
        assert!(!out.contains('"') && !out.contains('[') && !out.contains(']'), "no JSON envelope/quoting");
        assert_eq!(out.lines().count(), 2, "one id per line, id-less record skipped");
    }

    #[test]
    fn raw_get_output_is_the_record_bytes_lf_only() {
        // `get --raw` prints the stored JSON straight through, CR-stripped to LF — so a CRLF-poisoned
        // record can't leak a `\r` into a captured value. (Same builder the dispatch writes via.)
        let stored = "{\r\n  \"id\": \"button\"\r\n}";
        let out = bsc_cli_util::raw_line(stored.trim_end());
        assert!(!out.contains('\r'));
        assert!(out.ends_with('\n') && !out.ends_with("\n\n"), "exactly one trailing LF");
    }

    #[test]
    fn parse_args_routes_help_flag_to_the_help_command() {
        let a = parse_args(vec!["--help".into()]).unwrap();
        assert_eq!(a.positional.first().map(String::as_str), Some("help"));
    }

    fn tmp_store(tag: &str) -> Store {
        let d = std::env::temp_dir().join(format!("bsc-json-store-cli-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        Store::new(d, "record")
    }

    #[test]
    fn set_items_writes_each_by_id_and_fires_the_write_hook_per_id() {
        // #2525: the extracted set core writes each item and invokes on_write(id) after each write —
        // the seam the component/kit surfaces use to emit a `ui-touch` line (no stdin needed here).
        let store = tmp_store("set-hook");
        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let items = vec![
            serde_json::json!({ "id": "button", "name": "Button" }),
            serde_json::json!({ "id": "chip", "name": "Chip" }),
        ];
        let hook = |id: &str| seen.borrow_mut().push(id.to_string());
        let ids = set_items(&store, &items, "record", Some(&hook)).unwrap();
        assert_eq!(ids, vec!["button".to_string(), "chip".to_string()]);
        assert_eq!(*seen.borrow(), vec!["button".to_string(), "chip".to_string()], "hook fires once per written id");
        // The writes actually landed (hook fires AFTER the store write).
        assert!(store.get("button").unwrap().is_some() && store.get("chip").unwrap().is_some());
        // No hook ⇒ writes still happen, no fire.
        let ids = set_items(&store, &[serde_json::json!({ "id": "box" })], "record", None).unwrap();
        assert_eq!(ids, vec!["box".to_string()]);
    }

    #[test]
    fn run_hooked_fires_the_write_hook_on_remove() {
        // `remove` is drivable via run_hooked (positional id, no stdin): the hook fires after the
        // delete lands, carrying the removed id.
        let store = tmp_store("rm-hook");
        store.set("button", r#"{"id":"button"}"#).unwrap();
        let dir = store_dir(&store);
        let seen = std::cell::RefCell::new(Vec::<String>::new());
        let hook = |id: &str| seen.borrow_mut().push(id.to_string());
        run_hooked(
            vec!["remove".into(), "button".into(), "--dir".into(), dir],
            "bsc widget",
            &widget_spec(),
            Some(&hook),
        )
        .unwrap();
        assert_eq!(*seen.borrow(), vec!["button".to_string()]);
        assert!(store.get("button").unwrap().is_none(), "the remove landed");
    }

    /// The scratch store's dir as a string, for the `--dir` flag.
    fn store_dir(store: &Store) -> String {
        store.dir().to_string_lossy().into_owned()
    }

    /// A concrete CliSpec over the TEST_COMMANDS, for the dispatch tests.
    fn widget_spec() -> CliSpec {
        CliSpec {
            noun: "record",
            dir_env: "BSC_WIDGET_DIR_TEST",
            dir_segment: "widgets",
            tagline: "the widget store",
            commands: TEST_COMMANDS,
            meta_fields: &["id", "name"],
            graph_fields: &[],
            field_aliases: &[],
        }
    }

    #[test]
    fn help_overview_and_per_command_help_drill_in() {
        let ov = bsc_cli_util::help_overview("bsc widget", "the widget store", TEST_COMMANDS);
        for c in ["list", "get", "set", "remove"] {
            assert!(ov.contains(c), "overview lists {c}");
        }
        let one = bsc_cli_util::help_for("bsc widget", "the widget store", TEST_COMMANDS, "get");
        assert!(one.contains("bsc widget get"));
        // An unknown command falls back to the overview.
        assert!(bsc_cli_util::help_for("bsc widget", "the widget store", TEST_COMMANDS, "nope").contains("COMMANDS:"));
    }
}
