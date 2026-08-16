//! The command surface as DATA (#spike-load-the-json-store-cli-spec-from-a-record).
//!
//! [`crate::cli::run`] is already a generic runner: it dispatches `list`/`get`/`set`/`remove` from a
//! [`CliSpec`], and five crates ride it (bsc-blueprint, bsc-component, bsc-persona, bsc-sound,
//! bsc-teams). The spec is also already pure data — every field is a string or a slice of strings, no
//! function pointers, no closures. The only thing compiled in is the DATA.
//!
//! So the whole "interpreted command surface" question, for this family of stores, is one step: let the
//! runner read its spec from a record instead of a `static`. Then changing a verb's help, its lean
//! projection, or a field alias is a record write — no cargo, no rustc, no re-staging — and live on the
//! next invocation, because `bsc` is a fresh process per call.
//!
//! ## Decline and fall back — from day one, not after the first incident
//!
//! A missing record is normal and silent. A record that is PRESENT and malformed is reported loudly and
//! then ignored, and the compiled spec runs. That rule is not general caution: a `provides` override
//! that resolved wrongly once took down Glance and Console together, and the runtime now declines and
//! falls back for exactly that reason. A surface record is the same shape of override — global, and
//! able to break a surface it was only meant to adjust.
//!
//! ## The `&'static str` question, answered explicitly
//!
//! [`CliSpec`] holds `&'static str`. A runtime-loaded spec therefore needs either owned strings
//! (`Cow<'static, str>`, which touches all five call sites) or a one-time leak. This takes the leak, on
//! purpose: `bsc` is a short-lived process that answers one command and exits, so leaking one spec at
//! startup costs a few hundred bytes for the life of a process measured in milliseconds. `Cow` is the
//! right production shape if this graduates past a spike — recorded here so the choice is a decision
//! rather than something a later reader has to reverse-engineer.

use crate::cli::CliSpec;
use bsc_cli_util::CmdDoc;
use serde_json::Value;

/// The verbs [`crate::cli::run`] can actually dispatch.
///
/// This is the BOUNDARY the spike found, and it is narrower than "the command surface": the
/// presentation and projection layer is data (help text, taglines, `meta_fields`, `graph_fields`,
/// `field_aliases`), while the OPERATIONS are code. `help` is here because the shared help system
/// handles it before the store is even resolved; `rename` because a wrapper crate may intercept its own
/// verb before delegating, as `bsc persona` does — so it is dispatchable even though this runner never
/// sees it.
const DISPATCHABLE: &[&str] = &["list", "get", "set", "remove", "help", "rename"];

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

/// Leak an owned string into the `&'static str` [`CliSpec`] wants. See the module note on why.
fn leak(s: String) -> &'static str {
    Box::leak(s.into_boxed_str())
}

fn need_str(v: &Value, key: &str) -> Result<String, String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("missing or non-string `{key}`"))
}

fn str_list(v: &Value, key: &str) -> Result<Vec<String>, String> {
    match v.get(key) {
        None => Ok(Vec::new()), // absent == empty, so a record need only state what it changes
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(str::to_string).ok_or_else(|| format!("`{key}` holds a non-string")))
            .collect(),
        Some(_) => Err(format!("`{key}` is not an array")),
    }
}

/// Parse a surface record into a leaked [`CliSpec`].
///
/// Pure apart from the leak — takes the parsed JSON, never the filesystem — so the SHAPE rules are
/// unit-testable. Every error names the field, because the failure this has to avoid is a record that
/// is quietly ignored: a surface that silently reverts to the compiled one looks identical to a record
/// that was never written.
pub fn spec_from_json(v: &Value) -> Result<&'static CliSpec, String> {
    let noun = need_str(v, "noun")?;
    let dir_env = need_str(v, "dir_env")?;
    let dir_segment = need_str(v, "dir_segment")?;
    let tagline = need_str(v, "tagline")?;

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
        // A surface with no commands would dispatch nothing while looking like a valid override —
        // the exact "present but useless" state that is worse than absent.
        return Err("`commands` is empty — a surface with no verbs would replace a working one".into());
    }

    // THE SURFACE IS DATA; THE OPERATIONS ARE CODE. The runner implements exactly `list`/`get`/`set`/
    // `remove` (plus `help`), and a wrapper crate may intercept a verb of its own before delegating —
    // `bsc persona rename` does. A record naming anything else renders in `help` and then dies at
    // dispatch with `unknown command`, which is a surface PROMISING something it cannot deliver.
    //
    // Observed in the spike: adding a `count` verb by record edit put it in the help output while
    // `bsc persona count` answered `unknown command 'count'`. Rejecting the record is the honest
    // outcome — the alternative is a help catalog that lies, and a help catalog is the one thing an
    // agent reads to decide what it may call.
    if let Some(bad) = commands.iter().find(|c| !DISPATCHABLE.contains(&c.name)) {
        return Err(format!(
            "command `{}` has no implementation — this runner dispatches {:?}. The surface record can \
             change help, projections and aliases; a NEW operation is code, not data",
            bad.name, DISPATCHABLE
        ));
    }

    let meta_fields: Vec<&'static str> = str_list(v, "meta_fields")?.into_iter().map(leak).collect();
    let graph_fields: Vec<&'static str> = str_list(v, "graph_fields")?.into_iter().map(leak).collect();

    let mut field_aliases = Vec::new();
    if let Some(a) = v.get("field_aliases") {
        let pairs = a.as_array().ok_or_else(|| "`field_aliases` is not an array".to_string())?;
        for (i, p) in pairs.iter().enumerate() {
            let pair = p.as_array().filter(|x| x.len() == 2).ok_or_else(|| {
                format!("field_aliases[{i}]: expected a [current, legacy] pair")
            })?;
            let cur = pair[0].as_str().ok_or_else(|| format!("field_aliases[{i}]: current is not a string"))?;
            let leg = pair[1].as_str().ok_or_else(|| format!("field_aliases[{i}]: legacy is not a string"))?;
            field_aliases.push((leak(cur.to_string()), leak(leg.to_string())));
        }
    }

    Ok(Box::leak(Box::new(CliSpec {
        noun: leak(noun),
        dir_env: leak(dir_env),
        dir_segment: leak(dir_segment),
        tagline: leak(tagline),
        commands: Box::leak(commands.into_boxed_slice()),
        meta_fields: Box::leak(meta_fields.into_boxed_slice()),
        graph_fields: Box::leak(graph_fields.into_boxed_slice()),
        field_aliases: Box::leak(field_aliases.into_boxed_slice()),
    })))
}

/// The compiled spec as a record — what `bsc <noun> surface dump` would emit, and what a round-trip
/// test compares against. Having this is what makes the record EDITABLE rather than hand-authored.
pub fn spec_to_json(spec: &CliSpec) -> Value {
    serde_json::json!({
        "noun": spec.noun,
        "dir_env": spec.dir_env,
        "dir_segment": spec.dir_segment,
        "tagline": spec.tagline,
        "commands": spec.commands.iter().map(|c| serde_json::json!({
            "name": c.name, "summary": c.summary, "usage": c.usage,
        })).collect::<Vec<_>>(),
        "meta_fields": spec.meta_fields,
        "graph_fields": spec.graph_fields,
        "field_aliases": spec.field_aliases.iter().map(|(a, b)| vec![*a, *b]).collect::<Vec<_>>(),
    })
}

/// The spec the runner should use: a surface record if one is readable and valid, else `compiled`.
///
/// THREE OUTCOMES, and the middle one is the whole point:
///   - no record            -> `compiled`, silently. This is the normal case for every store today.
///   - record, valid        -> the record.
///   - record, unreadable   -> `compiled`, with a WARNING naming the file and the reason. Never a
///     panic, never a silent revert: a surface that quietly falls back is indistinguishable from one
///     that was never overridden, which is how an override gets debugged for an hour.
///
/// The returned reference borrows from `compiled`, NOT `'static`, on purpose. The runner takes
/// `&CliSpec` rather than `&'static CliSpec`, and widening that signature would ripple through all five
/// wrapper crates for no gain — a LOADED spec is `'static` (it is leaked), and `'static` coerces to any
/// shorter lifetime, so the substitution is sound in the direction that matters. Lifetimes are elided
/// here because elision already ties the output to the input; naming them said nothing extra.
pub fn resolve_spec(compiled: &CliSpec) -> &CliSpec {
    let Some(dir) = surface_dir() else { return compiled };
    let path = dir.join(format!("{}.json", compiled.noun));
    let Ok(raw) = std::fs::read_to_string(&path) else { return compiled };
    match serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string()).and_then(|v| spec_from_json(&v)) {
        Ok(spec) => spec,
        Err(why) => {
            eprintln!(
                "bsc: surface record {} is invalid ({why}) — falling back to the compiled surface",
                path.display()
            );
            compiled
        }
    }
}
