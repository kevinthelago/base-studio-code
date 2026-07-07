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
            "streams","source","market","transformations"];
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

    /// The Transformations stage prompt carries a CONCRETE worked example (#2392 lesson — an example
    /// beats prose) of `echo '…' | bsc plan transformation add`. Machine-verify it: the echoed block
    /// must be single-quote-safe (a stray `'` would end the shell quoting mid-JSON), parse as JSON,
    /// and each row must pass the SAME `validate_transformation` the CLI enforces at set-time — so
    /// the taught example can never drift from the #2509 contract.
    #[test]
    fn transformations_worked_example_is_single_quote_safe_and_passes_the_cli_validator() {
        let raw = crate::platform::config::embedded_str("stages/transformations.json");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid stage JSON");
        let prompt = v["prompt"].as_str().expect("prompt string");
        let start = prompt.find("echo '").expect("prompt carries the echo example") + "echo '".len();
        let rest = &prompt[start..];
        let end = rest.find("' | bsc plan transformation add").expect("example pipes into the CLI");
        let block = &rest[..end];
        assert!(!block.contains('\''), "the example JSON must be single-quote-safe");
        let rows: serde_json::Value = serde_json::from_str(block).expect("example is valid JSON");
        let rows = rows.as_array().expect("example is an array of rows");
        assert_eq!(rows.len(), 2, "two worked rows: a migrate-to-kit replace + an extract");
        for (i, row) in rows.iter().enumerate() {
            plandb::validate::validate_transformation(row)
                .unwrap_or_else(|e| panic!("worked-example row {i} fails the contract: {e}"));
        }
        // Row 1: the migrate-to-kit replace, with its optional KitNode `spec` deliberately omitted.
        assert_eq!(rows[0]["verb"], serde_json::json!("replace"));
        assert_eq!(rows[0]["provenance"]["recipe"], serde_json::json!("migrate-to-kit"));
        assert!(rows[0].get("spec").is_none(), "the replace row teaches that `spec` is optional");
        assert_eq!(rows[0]["tier"], serde_json::json!(0));
        // Row 2: the extract, one tier up, sequenced on the foundation row.
        assert_eq!(rows[1]["verb"], serde_json::json!("extract"));
        assert_eq!(rows[1]["provenance"]["recipe"], serde_json::json!("extract-and-abstract"));
        assert_eq!(rows[1]["dependsOn"], serde_json::json!(["replace-bespoke-buttons"]));
    }

    /// The migrate-to-kit playbook carries a SECOND worked example (#2509 slice c): a gap-fill row
    /// (a no-equivalent cluster becoming a kit contribution) + the migration row that depends on
    /// it. Machine-verify it like the first: single-quote-safe, valid JSON, and every row passes
    /// the SAME `validate_transformation` the CLI enforces — so the taught gap-fill shape can
    /// never drift from the contract.
    #[test]
    fn migrate_to_kit_gap_fill_example_is_single_quote_safe_and_passes_the_validator() {
        let raw = crate::platform::config::embedded_str("stages/transformations.json");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("valid stage JSON");
        let prompt = v["prompt"].as_str().expect("prompt string");
        let playbook = prompt.find("MIGRATE-TO-KIT").expect("prompt carries the migrate-to-kit playbook");
        let rest = &prompt[playbook..];
        let start = rest.find("echo '").expect("playbook carries the gap-fill example") + "echo '".len();
        let rest = &rest[start..];
        let end = rest.find("' | bsc plan transformation add").expect("example pipes into the CLI");
        let block = &rest[..end];
        assert!(!block.contains('\''), "the example JSON must be single-quote-safe");
        let rows: serde_json::Value = serde_json::from_str(block).expect("example is valid JSON");
        let rows = rows.as_array().expect("example is an array of rows");
        assert_eq!(rows.len(), 2, "a gap-fill row + its dependent migration row");
        for (i, row) in rows.iter().enumerate() {
            plandb::validate::validate_transformation(row)
                .unwrap_or_else(|e| panic!("gap-fill example row {i} fails the contract: {e}"));
        }
        // Row 1: the gap-fill — a kit contribution, built via "extract", generated by the recipe,
        // its evidence naming the bespoke instances WITH their usage counts.
        assert_eq!(rows[0]["kitContribution"], serde_json::json!(true));
        assert_eq!(rows[0]["verb"], serde_json::json!("extract"));
        assert_eq!(rows[0]["provenance"]["recipe"], serde_json::json!("migrate-to-kit"));
        let evidence = rows[0]["provenance"]["evidence"].as_array().expect("gap-fill evidence");
        assert!(evidence.len() >= 2, "a cluster is >=2 bespoke instances");
        assert!(
            evidence.iter().all(|e| e.as_str().is_some_and(|s| s.contains("usages"))),
            "every evidence entry carries its usage count"
        );
        // #2509 slice d: the gap-fill row carries a live-preview `spec` (a KitNode object) — the
        // user decides to build the NEW component by SEEING it in the pane, so a gap-fill spec is
        // now REQUIRED at set-time and the taught example must model one.
        assert!(rows[0]["spec"].is_object(), "the gap-fill row carries a preview spec object");
        assert_eq!(rows[0]["spec"]["kind"], serde_json::json!("card"), "the spec is a card sketch");
        // Row 2: the migration — replace, sequenced ON the gap-fill (foundation before fan-out).
        assert_eq!(rows[1]["verb"], serde_json::json!("replace"));
        assert_eq!(rows[1]["kitContribution"], serde_json::json!(false));
        assert_eq!(rows[1]["dependsOn"], serde_json::json!([rows[0]["id"].as_str().unwrap()]));
    }

    /// #2509 slice c: `@data/transformations/taxonomy.json` `recipes[].steps` is the CANONICAL
    /// recipe source; the stage prompt expands each recipe into a numbered playbook. Pin them in
    /// lockstep: every taxonomy recipe appears as an UPPERCASE playbook heading, the playbook
    /// references only real `bsc ui` enumeration verbs, and each playbook carries EXACTLY as many
    /// numbered steps as its taxonomy recipe.
    #[test]
    fn recipe_playbooks_mirror_the_taxonomy_steps() {
        let tax: serde_json::Value =
            serde_json::from_str(&crate::platform::config::embedded_str("transformations/taxonomy.json"))
                .expect("valid taxonomy JSON");
        let stage: serde_json::Value =
            serde_json::from_str(&crate::platform::config::embedded_str("stages/transformations.json"))
                .expect("valid stage JSON");
        let prompt = stage["prompt"].as_str().expect("prompt string");
        let recipes = tax["recipes"].as_array().expect("taxonomy recipes");
        assert_eq!(recipes.len(), 2, "migrate-to-kit + extract-and-abstract");
        let headings: Vec<String> =
            recipes.iter().map(|r| r["id"].as_str().expect("recipe id").to_uppercase()).collect();
        for (i, recipe) in recipes.iter().enumerate() {
            let heading = headings[i].as_str();
            let start = prompt
                .find(heading)
                .unwrap_or_else(|| panic!("prompt carries the {heading} playbook heading"));
            // The section runs to the next recipe heading (or HARD RULES) — count its numbered steps.
            let tail = &prompt[start + heading.len()..];
            let mut end = tail.len();
            for stop in headings.iter().map(String::as_str).chain(["HARD RULES"]) {
                if stop == heading {
                    continue;
                }
                if let Some(p) = tail.find(stop) {
                    end = end.min(p);
                }
            }
            let section = &tail[..end];
            let numbered = section
                .lines()
                .filter(|l| {
                    let t = l.trim_start();
                    t.chars().next().is_some_and(|c| c.is_ascii_digit()) && t.get(1..3) == Some(". ")
                })
                .count();
            let steps = recipe["steps"].as_array().expect("recipe steps").len();
            assert!(steps > 0, "{heading} taxonomy recipe carries steps");
            assert_eq!(
                numbered, steps,
                "the {heading} playbook's numbered steps drifted from taxonomy recipes[].steps"
            );
        }
        // The kit-enumeration step teaches REAL commands only (the bsc-ui / bsc-component CLIs).
        for cmd in ["bsc ui kit list", "bsc ui list --full", "bsc ui get <id>", "bsc ui shapes"] {
            assert!(prompt.contains(cmd), "the migrate-to-kit playbook teaches `{cmd}`");
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
            "bp_review","streams","source","test_ui","market","transformations"].iter().map(|s| s.to_string()).collect();
        assert_eq!(with_directive, expected, "stage `directive` set drifted from the expected set");
    }
}
