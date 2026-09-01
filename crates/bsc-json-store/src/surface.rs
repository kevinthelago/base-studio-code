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
//! ## The `&'static str` question: DECIDED, and it stays the leak
//!
//! [`CliSpec`] holds `&'static str`, so a runtime-loaded spec needs either owned strings
//! (`Cow<'static, str>`) or a one-time leak. The spike took the leak and recorded `Cow` as the right
//! production shape "if this graduates past a spike". It graduated
//! (`generalize-the-surface-record-beyond-json-store`) and the decision went the other way, on an
//! argument the spike did not have: [`bsc_cli_util::CmdDoc`] is `Copy` with `&'static str` fields, and
//! that is load-bearing for catalog COMPOSITION — `bsc ui` merges another CLI's verbs into its own help
//! tree by copying `CmdDoc`s. `Cow` is not `Copy`. The full reasoning lives with the shared
//! implementation in [`bsc_cli_util::surface`]; this module follows it rather than holding a second copy.
//!
//! ## What lives here, and what moved down
//!
//! The GENERIC half — the record home, the `commands` parse, the empty-catalog refusal and the
//! "a record may not conjure a verb" rule — is [`bsc_cli_util::surface`], shared with all 29
//! `CmdDoc`-driven CLIs. What stays here is what only this runner has: the [`CliSpec`] fields no other
//! CLI carries (`dir_env`, `dir_segment`, the lean/graph projections and the field aliases), and the
//! fact that its dispatchable set is its RUNNER's verbs rather than its catalog's.

use crate::cli::CliSpec;
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

/// Where surface records live — ONE home, shared with every other `CmdDoc`-driven CLI
/// (`bsc_cli_util::surface::surface_dir`). Re-exported rather than restated: two functions computing
/// the same directory is the shape that drifts, and this store's records sit beside the others'.
pub use bsc_cli_util::surface::surface_dir;

use bsc_cli_util::surface::leak;

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

    // THE SURFACE IS DATA; THE OPERATIONS ARE CODE — the shared rule, with this runner's OWN verb set
    // rather than its catalog's. The two differ on purpose: `rename` dispatches (a wrapper crate
    // intercepts it before delegating, as `bsc persona` does) while `help` is answered before the store
    // is opened, so neither is reliably present in a given spec's `commands`. Parsing, the empty-catalog
    // refusal and the "no implementation" error all live in `bsc_cli_util::surface`, so this store and
    // the other 29 CLIs cannot disagree about what a surface record may say.
    let commands = bsc_cli_util::surface::commands_from_json(v, DISPATCHABLE)?;

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
        commands,
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
