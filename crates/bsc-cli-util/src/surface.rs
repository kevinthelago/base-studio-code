//! The command surface as DATA, for EVERY `CmdDoc`-driven CLI (`generalize-the-surface-record-beyond-json-store`).
//!
//! `spike-load-the-json-store-cli-spec-from-a-record` proved the mechanism on the five crates that
//! ride the shared JSON-store runner: the runner reads its [`crate::CmdDoc`] catalog from a record
//! instead of a `static`, so changing a verb's help is a record write — no cargo, no rustc, no
//! re-staging, live on the next invocation because `bsc` is a fresh process per call. Measured 0.63s
//! edit-to-live against a 2m08s rebuild. It covered 5 surfaces out of ~37 and was otherwise unused.
//!
//! This module is that mechanism's generic half, moved DOWN to where `CmdDoc` itself lives, so the
//! coverage is every CLI rather than one family.
//!
//! ## Why the resolution happens inside `handle_help` / `unknown_command`
//!
//! 29 CLIs (15 file-backed, 14 record-backed) route their help and their unknown-command error through
//! [`crate::handle_help`] and [`crate::unknown_command`]. Resolving there covers all of them with ZERO
//! call-site edits — which matters beyond convenience: a per-crate opt-in is a list that drifts, and a
//! catalog that drifts from what dispatches is the exact failure this epic exists to end. Three plan
//! items already exist for hand-kept copies of the surface set going stale.
//!
//! Resolution is deliberately done at the point of PRINTING, not at the top of `run()`. `handle_help`
//! is called on every invocation and returns `false` for a real command; reading a record there would
//! put a `stat` + `read` on the hot path of a binary that agents invoke constantly, to serve a file
//! that only ever affects the help output.
//!
//! ## The boundary, generalized rather than relaxed
//!
//! The spike's rule was a fixed `DISPATCHABLE` list of the six verbs its runner implements. The honest
//! generalization is not a bigger list — it is that **the COMPILED catalog is the set of verbs that
//! dispatch**, so a record may retitle, reword, reorder and drop, and may NOT introduce a name the
//! compiled catalog does not carry. That is strictly more accurate than any list: it is derived from
//! the very thing it constrains.
//!
//! The spike found out why this matters by doing it: adding a `count` verb by record edit put it in
//! `bsc persona help` while `bsc persona count` answered `unknown command 'count'`. A help catalog is
//! the one thing an agent reads to decide what it may call, so a surface that promises what dispatch
//! cannot deliver is worse than no surface at all.
//!
//! Dropping a verb IS allowed — a record replaces the catalog wholesale, and curating help down is
//! presentation, not a promise. An EMPTY catalog is refused, because a surface that lists nothing while
//! replacing one that worked is the "present, plausible and useless" state the spike already rejected.
//!
//! ## Decline and fall back
//!
//! A missing record is normal and silent. A record that is PRESENT and malformed is reported loudly on
//! stderr, naming the file and the reason, and then ignored — the compiled catalog runs. Never a panic,
//! never a silent revert: a surface that quietly falls back is indistinguishable from one that was
//! never written, which is how an override gets debugged for an hour.
//!
//! ## `Box::leak` vs `Cow`: TAKEN, and it is the leak
//!
//! The spike took the leak and recorded `Cow<'static, str>` as "the right production shape if this
//! graduates past a spike". Graduating is this item, so the choice is made here rather than inherited.
//!
//! It stays the leak, and the reason is stronger now than the spike's own: [`crate::CmdDoc`] is `Copy`
//! with `&'static str` fields, and that is LOAD-BEARING — a CLI that mounts another CLI's verbs
//! composes the two catalogs into one merged help tree by copying `CmdDoc`s (`bsc ui` + the
//! component-library verbs, #2469). `Cow` is not `Copy`, so taking it would break catalog composition
//! for all 29 surfaces in order to reclaim a few hundred bytes. The spike's own argument also still
//! holds and is now narrower: `bsc` answers ONE command and exits, and after the change above a spec is
//! leaked only on a path that is about to print help and return.
//!
//! The leak is bounded by construction: at most one catalog per process, and only when help is printed.

use crate::CmdDoc;
use serde_json::Value;

/// Where surface records live: `$BSC_SURFACE_DIR`, else `~/.base-studio-code/surfaces/`.
///
/// The env var exists so a test — and an agent trying this out — can point at a throwaway directory
/// without touching the real one. Same shape as every other store's `--dir`/env override.
pub fn surface_dir() -> Option<std::path::PathBuf> {
    if let Ok(d) = std::env::var("BSC_SURFACE_DIR") {
        if !d.trim().is_empty() {
            return Some(std::path::PathBuf::from(d));
        }
    }
    Some(bsc_util::bsc_base_dir()?.join("surfaces"))
}

/// The record filename stem for a CLI invoked as `prog`, WITHOUT the `.json`.
///
/// `bsc persona` → `persona`, which is exactly the key the JSON-store spike already used
/// (`CliSpec::noun`), so the five existing surfaces keep their filenames. A nested surface keeps its
/// whole path — `bsc logs scope` → `logs-scope` — because the last token alone is not an identity:
/// `scope` would claim a name a future top-level `bsc scope` would also claim, and a record loaded by
/// the wrong CLI is a worse outcome than one that is never found.
///
/// A `prog` with no spaces is used as-is (`bsc-files` → `bsc-files`), so a standalone bin is still
/// addressable rather than silently keyless.
///
/// `None` when the result would not be a bare filename. Every caller today passes a compile-time
/// literal from `bsc`'s dispatch, so there is no path by which a separator reaches here — but this is
/// `pub` and builds a filesystem path, and the ONE thing a `pub fn` in that shape must not do is let a
/// future dynamic caller reach outside the surfaces directory. Returning `None` makes traversal
/// unrepresentable rather than defended-against, which is the same call [`crate::is_bare_filename`]
/// makes for the `--file` payload channel and for the same reason.
pub fn surface_key(prog: &str) -> Option<String> {
    let mut parts = prog.split_whitespace().peekable();
    if parts.peek() == Some(&"bsc") {
        parts.next();
    }
    let key: Vec<&str> = parts.collect();
    let key = if key.is_empty() { prog.trim().to_string() } else { key.join("-") };
    crate::is_bare_filename(&key).then_some(key)
}

/// Leak an owned string into the `&'static str` [`CmdDoc`] wants. See the module note on why.
pub fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn need_str(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing or non-string `{key}`"))
}

/// The `commands` array of a surface record, parsed and leaked.
///
/// `dispatchable` is the set of verb names that actually dispatch. Callers pass the COMPILED catalog's
/// names (see [`resolve_surface`]); the JSON-store runner passes its own fixed verb set, which is
/// narrower than its catalog because a wrapper crate may intercept a verb before the runner sees it.
///
/// Every error names the field or the verb, because the failure this has to avoid is a record that is
/// quietly ignored — a surface that silently reverts looks identical to one that was never written.
pub fn commands_from_json(v: &Value, dispatchable: &[&str]) -> Result<&'static [CmdDoc], String> {
    let cmds_val = v.get("commands").ok_or_else(|| "missing `commands`".to_string())?;
    let arr = cmds_val.as_array().ok_or_else(|| "`commands` is not an array".to_string())?;
    let mut commands = Vec::with_capacity(arr.len());
    for (i, c) in arr.iter().enumerate() {
        let at = |e: String| format!("commands[{i}]: {e}");
        commands.push(CmdDoc {
            name: leak(need_str(c, "name").map_err(at)?),
            summary: leak(need_str(c, "summary").map_err(|e| format!("commands[{i}]: {e}"))?),
            usage: leak(need_str(c, "usage").map_err(|e| format!("commands[{i}]: {e}"))?),
        });
    }
    if commands.is_empty() {
        // A surface with no commands would advertise nothing while looking like a valid override —
        // the exact "present but useless" state that is worse than absent.
        return Err("`commands` is empty — a surface with no verbs would replace a working one".into());
    }
    if let Some(bad) = commands.iter().find(|c| !dispatchable.contains(&c.name)) {
        return Err(format!(
            "command `{}` has no implementation — this surface dispatches {:?}. A surface record can \
             change help text, taglines and ordering; a NEW operation is code, not data",
            bad.name, dispatchable
        ));
    }
    Ok(Box::leak(commands.into_boxed_slice()))
}

/// A tagline + catalog parsed from a record — the generic half of a surface, shared by every
/// `CmdDoc`-driven CLI.
///
/// The tagline comes back as an `Option` rather than defaulted here: absent means "keep the compiled
/// one", so a record need only state what it changes, and the caller supplies its own compiled tagline
/// without this function having to demand a `'static` one it does not need.
pub fn surface_from_json(
    v: &Value,
    dispatchable: &[&str],
) -> Result<(Option<&'static str>, &'static [CmdDoc]), String> {
    let tagline = match v.get("tagline") {
        None => None,
        Some(Value::String(s)) => Some(leak(s.clone())),
        Some(_) => return Err("`tagline` is not a string".into()),
    };
    Ok((tagline, commands_from_json(v, dispatchable)?))
}

/// The compiled surface as a record — what an author edits, so the record is DERIVED rather than
/// hand-authored. Round-tripping this through [`surface_from_json`] must be lossless; that is what
/// makes "dump it, change one line" a safe workflow rather than a lossy retype.
pub fn surface_to_json(tagline: &str, cmds: &[CmdDoc]) -> Value {
    serde_json::json!({
        "tagline": tagline,
        "commands": cmds.iter().map(|c| serde_json::json!({
            "name": c.name, "summary": c.summary, "usage": c.usage,
        })).collect::<Vec<_>>(),
    })
}

/// The tagline + catalog a CLI should PRESENT: a surface record if one is readable and valid, else the
/// compiled pair unchanged.
///
/// THREE OUTCOMES, and the middle one is the whole point:
///   - no record          → compiled, silently. The normal case for every CLI today.
///   - record, valid      → the record.
///   - record, unreadable → compiled, with a WARNING naming the file and the reason.
///
/// The returned references borrow from the inputs, not `'static`, on purpose: a LOADED surface is
/// `'static` (it is leaked) and `'static` coerces to any shorter lifetime, so the substitution is sound
/// in the direction that matters and the callers' signatures do not have to widen.
pub fn resolve_surface<'a>(
    prog: &str,
    tagline: &'a str,
    cmds: &'a [CmdDoc],
) -> (&'a str, &'a [CmdDoc]) {
    let Some(dir) = surface_dir() else { return (tagline, cmds) };
    // A key that is not a bare filename has no record and cannot be given one — see `surface_key`.
    let Some(key) = surface_key(prog) else { return (tagline, cmds) };
    let path = dir.join(format!("{key}.json"));
    let Ok(raw) = std::fs::read_to_string(&path) else { return (tagline, cmds) };
    // The COMPILED catalog is the set of verbs that dispatch — plus `help`, which the shared help
    // dispatch answers before any command is looked up and which most catalogs therefore omit.
    let mut dispatchable: Vec<&str> = cmds.iter().map(|c| c.name).collect();
    dispatchable.push("help");
    let parsed = serde_json::from_str::<Value>(&raw)
        .map_err(|e| e.to_string())
        .and_then(|v| surface_from_json(&v, &dispatchable));
    match parsed {
        Ok((t, c)) => (t.unwrap_or(tagline), c),
        Err(why) => {
            eprintln!(
                "bsc: surface record {} is invalid ({why}) — falling back to the compiled surface",
                path.display()
            );
            (tagline, cmds)
        }
    }
}

/// [`crate::help_overview`] with the surface record applied — the entry point PRODUCTION code calls.
///
/// The pure renderers in the crate root stay pure on purpose: they are what a CLI's own tests use to
/// assert its COMPILED catalog renders, and a renderer that reads `$BSC_SURFACE_DIR` would make those
/// tests depend on ambient state. So resolution is a separate, obviously-named door rather than a
/// hidden effect inside the thing everybody already calls.
///
/// `handle_help` covers the common case with no call-site change at all. These two exist for the calls
/// it cannot reach: a CLI rendering ONE nested verb's detail from inside its own dispatch
/// (`bsc ui generate` with no args prints `help_for(… "generate")`). Those bypassed the record entirely
/// until `a_hand_rolled_help_block_must_resolve_its_surface_record` found all 19 of them — a surface
/// where the top-level help honoured a record and the per-verb help did not is exactly the
/// half-covered state this epic exists to end.
pub fn help_overview(prog: &str, tagline: &str, cmds: &[CmdDoc]) -> String {
    let (tagline, cmds) = resolve_surface(prog, tagline, cmds);
    crate::help_overview(prog, tagline, cmds)
}

/// [`crate::help_for`] with the surface record applied. See [`help_overview`] for why this is a
/// separate door rather than an effect inside the pure renderer.
pub fn help_for(prog: &str, tagline: &str, cmds: &[CmdDoc], name: &str) -> String {
    let (tagline, cmds) = resolve_surface(prog, tagline, cmds);
    crate::help_for(prog, tagline, cmds, name)
}
