use super::prompts::*;
use include_dir::{include_dir, Dir};

/// The migrated stage directives (#1462) live as the `directive` field in each
/// `data/stages/<id>.json` — the single source of truth, shared with the frontend `SectionDef`.
/// Embedded at compile time; `stage_directive` resolves them by id.
static STAGES_DIR: Dir = include_dir!("$CARGO_MANIFEST_DIR/data/stages");

/// The user-facing planner introduction kickoff for a session mode (#1240). Returned to the
/// frontend, which bakes it into the planner's `claude` launch as a fresh-only startup prompt.
/// `mode`: `"blueprint"` (authoring) | `"existing"` (existing repos) | anything else ⇒ new project.
#[tauri::command]
pub(crate) fn planner_intro_prompt(mode: String) -> String {
    match mode.as_str() {
        "blueprint" => PLANNING_GREETING_BLUEPRINT,
        "existing" => PLANNING_GREETING_EXISTING,
        _ => PLANNING_GREETING_NEW,
    }
    .to_string()
}
/// Return one planning stage's directive prose by id (the same text `build_active_stages_md`
/// embeds) so the frontend can bake the FIRST active stage's directive into a bsc-agent planner's
/// startup prompt (#qwen). Claude Code receives stage directives via runtime injection as it
/// advances; the one-shot bsc-agent loop never gets stage 1's, so without this it greets the user
/// and then waits for instructions the app never sends. Unknown ids fall back to the generic line.
#[tauri::command]
pub(crate) fn planner_stage_directive(id: String) -> String {
    stage_directive(&id)
}

/// One-line directive per planning stage (#542/#666) for the assembled active-stages
/// section. Unknown ids fall back to a generic line.
pub(crate) fn stage_directive(id: &str) -> String {
    // `testing-informational` shares the `testing` stage's directive (alias; it has no own JSON).
    // Every stage directive — including the composed/lifecycle ids (`repos_deploy`, `streams`,
    // `refactor`, `transform`) — now resolves from its `data/stages/<id>.json` `directive` field;
    // an unknown id gets the generic fallback. ONE resolution path, no Rust-side prose (#1610).
    let key = if id == "testing-informational" { "testing" } else { id };
    embedded_directive(key)
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| format!("**{id}** — configured stage."))
}
/// Read the `directive` field of the embedded `data/stages/<id>.json`, if present + a string.
fn embedded_directive(id: &str) -> Option<String> {
    let file = STAGES_DIR.get_file(format!("{id}.json"))?;
    let v: serde_json::Value = serde_json::from_slice(file.contents()).ok()?;
    v.get("directive")?.as_str().map(str::to_string)
}
/// Assemble the "Active planning stages" section from the project's ENABLED stages
/// (in order). Stages not listed are declared out of scope, so a disabled stage is
/// never instructed (#512/#542). Empty input ⇒ "" (section omitted; no behavior change).
pub(crate) fn build_active_stages_md(stages: &[String]) -> String {
    if stages.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "\n## Active planning stages\n\nThe app drives the plan **one stage at a time** — it sends you each stage's working instructions the moment you reach it. Treat this list as SCOPE: work the current stage, then wait for the app to advance you; don't run ahead or jump stages. **Stages not listed here are OUT OF SCOPE — do not produce their artifacts.**\n\n",
    );
    for (i, id) in stages.iter().enumerate() {
        s.push_str(&format!("{}. {}\n", i + 1, stage_directive(id)));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_directive_routes_design_without_generating_it() {
        // #1371: the UI stage must route dropped design files into the repo and author the kickoff.
        // #1404: but it must NOT instruct the planner to GENERATE the UI — no skeleton code, no live
        // preview; the visual design comes from the user via Claude Design (matches sections/ui.json).
        let ui = stage_directive("ui");
        assert!(ui.contains("design/intake.json"), "ui directive must reference the intake manifest: {ui}");
        assert!(ui.contains("ui-kickoff.md"), "ui directive must still author the kickoff: {ui}");
        assert!(!ui.contains(".ui-skeleton/"), "ui directive must NOT tell the planner to write UI skeletons: {ui}");
        assert!(!ui.contains("ui_preview"), "ui directive must NOT tell the planner to render a live preview: {ui}");
        assert!(ui.contains("Do NOT design"), "ui directive must tell the planner not to design the screens: {ui}");
        // #786: when a Data Model exists, the kickoff is authored FROM it (entities→screens) + the
        // behavior summary — the generation stays the existing Claude Design loop, no new engine.
        // #1446: the Data Model + behaviors now live in DuckDB, read via the bsc-data CLI (not a file).
        assert!(ui.contains("bsc-data model get"), "ui directive must read the Data Model via bsc-data: {ui}");
        assert!(!ui.contains("datamodel.json"), "the Data Model is in DuckDB now, not a datamodel.json file (#1446): {ui}");
        assert!(ui.contains("Platform Behavior Summary"), "ui directive must fold the captured behaviors into the kickoff: {ui}");
    }

    #[test]
    fn deploy_directive_ships_only_deps_moved_to_streams() {
        // #1429: dependencies moved Deploy → Streams. The Deploy directive records the deploy config
        // and gates on shipping ALONE — it must NOT instruct `bsc-plan deps set`; the `streams`
        // directive owns dependency locking now.
        let dep = stage_directive("deploy");
        assert!(dep.contains("bsc-plan deploy set"), "deploy directive records the deploy config: {dep}");
        assert!(!dep.contains("bsc-plan deps set"), "deps moved to Streams — not the deploy directive: {dep}");
        assert!(dep.contains("deploymentDefined"), "deploy gates on shipping: {dep}");
        let streams = stage_directive("streams");
        assert!(streams.contains("bsc-plan deps set") && streams.contains("sharedDepsLocked"),
            "the streams directive owns dependency locking: {streams}");
    }

    #[test]
    fn merged_stage_directives_name_the_stage_and_cover_both_halves() {
        // #1383/#1392: the planner overview gets ONE directive for a merged stage, covering both
        // halves' CLIs. `repos_deploy` = "Deployment" (link repos + deploy); `streams` = both the
        // roadmap (phases) AND the fleet.
        let dep = stage_directive("repos_deploy");
        assert!(dep.contains("Deployment"), "merged stage names itself Deployment: {dep}");
        assert!(dep.contains("repo_link") && dep.contains("bsc-plan deploy set"),
            "Deployment covers link + deploy: {dep}");
        assert!(!dep.contains("bsc-plan deps set"), "deps moved to Streams (#1429): {dep}");
        let streams = stage_directive("streams");
        assert!(streams.contains("Streams"), "merged stage names itself Streams: {streams}");
        assert!(streams.contains("bsc-plan phase add") && streams.contains("bsc-plan fleet set") && streams.contains("bsc-plan deps set"),
            "Streams covers the roadmap, the fleet, AND shared deps: {streams}");

        // The merged stages render in the active-stages overview with their merged names.
        let md = build_active_stages_md(&["repos_deploy".into(), "streams".into()]);
        assert!(md.contains("**Deployment**") && md.contains("**Streams**"), "overview lists merged names: {md}");
    }

    /// #1462: the migrated stage directives now live in `data/stages/<id>.json` (`directive` field),
    /// read via `include_dir!`. Every migrated id (incl. the `testing-informational` alias) must
    /// resolve to its real directive — NOT the generic fallback — and come from the embedded JSON.
    /// This, with the substring tests above, proves the prose survived the move byte-for-byte.
    #[test]
    fn migrated_stage_directives_resolve_from_embedded_json() {
        let migrated = ["discovery","repos","deploy","ui","features","structure","permissions",
            "automations","skills","cleanup","testing","testing-informational",
            "boundaries","extraction","consolidation","migration","hardening","purpose","bp_stages",
            "bp_capabilities","bp_review",
            // #1610: the formerly-inline composed/lifecycle directives now resolve from JSON too.
            "repos_deploy","streams","refactor","transform"];
        for id in migrated {
            let d = stage_directive(id);
            assert!(!d.trim().is_empty(), "stage '{id}' has an empty directive");
            assert!(!d.ends_with("configured stage."),
                "stage '{id}' fell back to the generic line — its JSON `directive` is missing");
            let key = if id == "testing-informational" { "testing" } else { id };
            assert_eq!(d, embedded_directive(key).unwrap_or_default(),
                "stage '{id}' must resolve from its embedded JSON `directive`");
        }
    }

    /// Drift guard (the `find_fixture`-style contract): the stage JSONs carrying a `directive` are
    /// EXACTLY the expected set. Both Rust (`include_dir!`) and the frontend (`import.meta.glob`) read
    /// the SAME `data/stages/` dir, so a directive can't drift between them; this pins the set.
    /// #1610: the composed/lifecycle ids (`repos_deploy`/`streams`/`refactor`/`transform`) are now
    /// plain stage JSONs too — no Rust-side prose, no special carve-out.
    #[test]
    fn embedded_directive_key_set_matches_the_migrated_set() {
        use std::collections::BTreeSet;
        let with_directive: BTreeSet<String> = STAGES_DIR
            .files()
            .filter_map(|f| {
                let v: serde_json::Value = serde_json::from_slice(f.contents()).ok()?;
                v.get("directive").and_then(|d| d.as_str()).filter(|s| !s.is_empty())?;
                Some(f.path().file_stem()?.to_string_lossy().into_owned())
            })
            .collect();
        let expected: BTreeSet<String> = ["discovery","repos","deploy","ui","features","structure",
            "permissions","automations","skills","cleanup","testing","boundaries",
            "extraction","consolidation","migration","hardening","purpose","bp_stages","bp_capabilities",
            "bp_review","repos_deploy","streams","refactor","transform"].iter().map(|s| s.to_string()).collect();
        assert_eq!(with_directive, expected, "stage `directive` set drifted from the expected set");
    }
}
