//! The one dispatch both entry points share — `bsc-emit` (the build tree) and `bsc ui emit records`
//! (the agent). Keeping it here is what makes "two entry points, one implementation" true rather than
//! aspirational.

use crate::{emit_records, plan_records};
use std::path::Path;

pub const USAGE: &str = "\
bsc-emit — materialize retired modules from their packaged seeds into `.bsc-records/`

USAGE:
  bsc-emit [--repo <dir>] [--quiet]        reconcile <repo>/.bsc-records to the seeds
  bsc-emit --plan --json [--repo <dir>]    the PLAN as data, writing nothing

The emitted tree is GIT-IGNORED and regenerated from the seed on every build/typecheck/test. The
repository genuinely loses the module; what is on disk afterwards is a derived cache, the same status
`node_modules` has. The seed is the source of truth.

`--plan` exists so a guard can ask 'would this record's test actually run?' WITHOUT triggering an
emit — an emit prunes, and a prune mid-suite would delete files out from under every other file being
collected in parallel.
";

/// Returns what should be printed, so the caller owns stdout (the warm server captures it).
pub fn run(repo: &Path, plan_only: bool, json: bool, quiet: bool) -> Result<String, String> {
    if plan_only {
        let p = plan_records(repo);
        if !json {
            return Err("`--plan` is only useful as data; pass --json".to_string());
        }
        return serde_json::to_string_pretty(&serde_json::json!({
            "modules": p.modules.iter().map(|m| serde_json::json!({
                "spec": m.spec, "id": m.id, "rel": m.rel,
            })).collect::<Vec<_>>(),
            "tests": p.tests.iter().map(|t| serde_json::json!({
                "spec": t.spec, "name": t.name, "rel": t.rel, "detail": t.detail,
                "ext": t.ext, "src": t.src,
            })).collect::<Vec<_>>(),
            "shadowed": p.shadowed,
            "unresolvable": p.unresolvable.iter().map(|u| serde_json::json!({
                "spec": u.spec, "name": u.name, "missing": u.missing, "detail": u.detail,
            })).collect::<Vec<_>>(),
            "edgeTests": p.edge_tests.iter().map(|t| serde_json::json!({
                "id": t.id, "members": t.members, "rel": t.rel, "detail": t.detail,
            })).collect::<Vec<_>>(),
            "edgeShadowed": p.edge_shadowed,
            "edgeUnresolvable": p.edge_unresolvable.iter().map(|(id, detail)| serde_json::json!({
                "id": id, "detail": detail,
            })).collect::<Vec<_>>(),
        }))
        .map_err(|e| e.to_string());
    }

    let report = emit_records(repo).map_err(|e| format!("emit failed: {e}"))?;
    if json {
        return serde_json::to_string_pretty(&serde_json::json!({
            "materialized": report.materialized.len(),
            "tests": report.tests.len(),
            "edges": report.edges.len(),
            "written": report.written,
            "pruned": report.pruned,
            "intended": report.intended,
        }))
        .map_err(|e| e.to_string());
    }
    Ok(if quiet { String::new() } else { crate::emit::render(&report) })
}
