use super::prompts::*;

/// The user-facing planner introduction kickoff for a session mode (#1240). Returned to the
/// frontend, which bakes it into the planner's `claude` launch as a fresh-only startup prompt.
/// `mode`: `"blueprint"` (authoring) | `"existing"` (existing repos) | anything else ⇒ new project.
#[tauri::command]
pub(crate) fn planner_intro_prompt(mode: String) -> String {
    match mode.as_str() {
        "blueprint" => planning_greeting_blueprint(),
        "existing" => planning_greeting_existing(),
        _ => planning_greeting_new(),
    }
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
    // Every stage directive — including the composed/lifecycle ids (`deployment`, `streams`) —
    // resolves from its `data/stages/<id>.json` `directive` field; an unknown id (incl. an archived
    // stage) gets the generic fallback. ONE resolution path, no Rust-side prose (#1610).
    directive_of(id)
        .filter(|d| !d.trim().is_empty())
        .unwrap_or_else(|| format!("**{id}** — configured stage."))
}
/// Read the `directive` field of `data/stages/<id>.json` — the user's copy under the config dir if
/// present, else the embedded seed (#2027 P2). `None` if the stage file is absent or has no directive.
fn directive_of(id: &str) -> Option<String> {
    let raw = crate::platform::config::load_opt(&format!("stages/{id}.json"))?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("directive")?.as_str().map(str::to_string)
}
/// Assemble the "Active planning stages" section from the project's ENABLED stages
/// (in order). Stages not listed are declared out of scope, so a disabled stage is
/// never instructed (#512/#542). Empty input ⇒ "" (section omitted; no behavior change).
pub(crate) fn build_active_stages_md(stages: &[String]) -> String {
    if stages.is_empty() {
        return String::new();
    }
    // The preamble prose lives in `@data/planner/active-stages-preamble.md` (#2027 P1); the surrounding
    // newlines that frame it in the CLAUDE.md + the per-stage lines below stay here.
    let mut s = format!("\n{}\n\n", planning_active_stages_preamble().trim_end());
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
        // #1446: the Data Model + behaviors now live in DuckDB, read via `bsc data` (not a file).
        assert!(ui.contains("bsc data model get"), "ui directive must read the Data Model via `bsc data`: {ui}");
        assert!(!ui.contains("datamodel.json"), "the Data Model is in DuckDB now, not a datamodel.json file (#1446): {ui}");
        assert!(ui.contains("Platform Behavior Summary"), "ui directive must fold the captured behaviors into the kickoff: {ui}");
    }

    #[test]
    fn collapsed_stage_directives_name_the_stage_and_cover_both_halves() {
        // #1914: the unified vocabulary collapsed the old fold split into single canonical defs.
        // `deployment` = "Deployment" (link repos + deploy); `streams` = the feature roadmap, the
        // fleet, AND shared deps. Each carries the WHOLE merged directive — and `deployment` must NOT
        // instruct `bsc plan deps set` (deps live in the Streams stage now, #1429).
        let dep = stage_directive("deployment");
        assert!(dep.contains("Deployment"), "collapsed stage names itself Deployment: {dep}");
        assert!(dep.contains("bsc plan repo add") && dep.contains("bsc plan deploy set"),
            "Deployment covers link + deploy: {dep}");
        assert!(!dep.contains("bsc plan deps set"), "deps moved to Streams (#1429): {dep}");
        let streams = stage_directive("streams");
        assert!(streams.contains("Streams"), "collapsed stage names itself Streams: {streams}");
        assert!(streams.contains("bsc plan feature list") && streams.contains("bsc plan fleet set") && streams.contains("bsc plan deps set"),
            "Streams covers the roadmap, the fleet, AND shared deps: {streams}");
        assert!(streams.contains("sharedDepsLocked"), "streams gates on shared deps locked: {streams}");

        // The collapsed stages render in the active-stages overview with their names.
        let md = build_active_stages_md(&["deployment".into(), "streams".into()]);
        assert!(md.contains("**Deployment**") && md.contains("**Streams**"), "overview lists collapsed names: {md}");
    }

    /// The conductor injects a stage's top-level `prompt` FIRST as orientation (plannerConductor.ts).
    /// The Deployment `prompt` used to end at "Gate: at least one repository is linked" — which made
    /// the planner treat linking as the whole stage and never define the deploy config, leaving the
    /// `deploymentDefined` gate stuck. The orientation `prompt` must state the FULL gate: both linking
    /// AND every service's deploy config (target, environments, pipeline, secrets, release).
    #[test]
    fn deployment_stage_prompt_states_the_full_deploy_gate_not_just_linking() {
        let raw = crate::platform::config::embedded_str("stages/deployment.json");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid JSON");
        let prompt = v.get("prompt").and_then(|p| p.as_str()).unwrap_or_default().to_lowercase();
        for term in ["repo", "bsc plan deploy", "target", "environment", "pipeline", "secret", "release"] {
            assert!(prompt.contains(term), "Deployment `prompt` must cover the full gate — missing '{term}': {prompt}");
        }
    }

    /// #1462: the migrated stage directives now live in `data/stages/<id>.json` (`directive` field),
    /// read via the runtime config loader (#2027 P2 — config-dir override → embedded seed). Every
    /// migrated id must resolve to its real directive — NOT the generic fallback. (The v1.0.5
    /// consolidation archived the data/transform/harden stages; this is the kept set that carries a
    /// `directive`.)
    #[test]
    fn migrated_stage_directives_resolve_from_embedded_json() {
        // #1914: the unified vocabulary collapsed repos+deploy → `deployment` and
        // structure+permissions → `streams`; the legacy `repos`/`structure`/`permissions` defs are gone.
        let migrated = ["discovery","deployment","ui","features",
            "automations","skills","purpose","bp_stages","bp_capabilities","bp_review",
            "streams","source"];
        for id in migrated {
            let d = stage_directive(id);
            assert!(!d.trim().is_empty(), "stage '{id}' has an empty directive");
            assert!(!d.ends_with("configured stage."),
                "stage '{id}' fell back to the generic line — its JSON `directive` is missing");
            // The SHIPPED stage JSON carries a non-empty `directive` (checked against the embedded
            // seed, so it holds regardless of any local config override).
            let raw = crate::platform::config::embedded_str(&format!("stages/{id}.json"));
            let v: serde_json::Value = serde_json::from_str(&raw).expect("stage json valid");
            let shipped = v.get("directive").and_then(|x| x.as_str()).unwrap_or_default();
            assert!(!shipped.trim().is_empty(), "stage '{id}' embedded JSON has a `directive`");
        }
    }

    /// Drift guard (the `find_fixture`-style contract): the stage JSONs carrying a `directive` are
    /// EXACTLY the expected set. Both Rust (the config loader / embedded seed) and the frontend
    /// (`import.meta.glob`) read the SAME `data/stages/` dir, so a directive can't drift between them;
    /// this pins the set.
    /// #1914: after the collapse the composed/lifecycle ids (`deployment`/`streams`) are plain stage
    /// JSONs too — no Rust-side prose, no special carve-out; the legacy `repos`/`structure`/`permissions`
    /// defs are gone.
    #[test]
    fn embedded_directive_key_set_matches_the_migrated_set() {
        use std::collections::BTreeSet;
        let with_directive: BTreeSet<String> = crate::platform::config::embedded_dir_files("stages")
            .into_iter()
            .filter_map(|(stem, contents)| {
                let v: serde_json::Value = serde_json::from_str(&contents).ok()?;
                v.get("directive").and_then(|d| d.as_str()).filter(|s| !s.is_empty())?;
                Some(stem)
            })
            .collect();
        let expected: BTreeSet<String> = ["discovery","deployment","ui","features",
            "automations","skills","purpose","bp_stages","bp_capabilities",
            "bp_review","streams","source"].iter().map(|s| s.to_string()).collect();
        assert_eq!(with_directive, expected, "stage `directive` set drifted from the expected set");
    }
}
