use super::prompts::*;

/// The user-facing planner introduction kickoff for a session mode (#1240). Returned to the
/// frontend, which bakes it into the planner's `claude` launch as a fresh-only startup prompt.
/// `mode`: `"existing"` (existing repos) | anything else ⇒ new project.
#[tauri::command]
pub(crate) fn planner_intro_prompt(mode: String) -> String {
    match mode.as_str() {
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

    /// The PACKAGED stage prose — `(directive, prompt)` straight from the embedded seed.
    ///
    /// NOT `stage_directive`, which resolves the user's copy under the config dir first (#2027 P2) and
    /// only falls back to the seed. That is right at runtime and wrong in a test: a machine with a stale
    /// `config/stages/*.json` mirror asserts against ITS text, not the text we ship — which is how a
    /// directive edit in `src-tauri/data/` can leave these tests passing on the old prose (#4249 found
    /// this the slow way). Every assertion about what we SHIP reads the seed.
    fn packaged(id: &str) -> (String, String) {
        let raw = crate::platform::config::embedded_str(&format!("stages/{id}.json"));
        let v: serde_json::Value = serde_json::from_str(&raw).expect("stage json valid");
        (
            v["directive"].as_str().unwrap_or_default().to_string(),
            v["prompt"].as_str().unwrap_or_default().to_string(),
        )
    }

    #[test]
    fn ui_directive_commissions_the_designer_reuse_first() {
        // #3783 (flips #1371/#1404): the UI stage now generates a live, navigable UI IN-APP — it
        // commissions the INTERNAL designer (reuse-first from the shared kit), rendered in the planner's
        // preview pane — instead of sending the user out to Claude Design. External design stays a
        // documented FALLBACK, so the intake-routing + kickoff still appear (retired fully in a later slice).
        let (ui, _) = packaged("ui");
        // Primary path: internal designer commission, reuse-first, previewed as a navigable shell.
        assert!(ui.contains("bsc-commission designer"), "ui directive must commission the internal designer: {ui}");
        assert!(ui.contains("reuse-first"), "ui directive must source components reuse-first: {ui}");
        assert!(ui.contains("preview pane") && ui.contains("navigable"),
            "ui directive must render a navigable shell in the preview pane: {ui}");
        assert!(ui.contains("author no UI code"), "the planner specs; the designer builds — the planner writes no UI itself: {ui}");
        assert!(!ui.contains(".ui-skeleton/"), "ui directive must NOT tell the planner to write UI skeletons: {ui}");
        // Fallback (external design) stays available: the intake manifest + the Claude Design kickoff.
        assert!(ui.contains("design/intake.json"), "ui directive keeps the external-design intake manifest as a fallback: {ui}");
        assert!(ui.contains("ui-kickoff.md"), "ui directive keeps the Claude Design kickoff as a fallback: {ui}");
        // #786/#1446: when a Data Model exists, the shape is derived FROM it via `bsc data` (DuckDB, not a file).
        assert!(ui.contains("bsc data model get"), "ui directive must read the Data Model via `bsc data`: {ui}");
        assert!(!ui.contains("datamodel.json"), "the Data Model is in DuckDB now, not a datamodel.json file (#1446): {ui}");
        assert!(ui.contains("Platform Behavior Summary"), "ui directive must fold the captured behaviors into the screens: {ui}");

        // #4249: `test_ui` was a fully-written stage in NO blueprint, and it owned the ONLY path that
        // records a project's {kit, theme} pair and emits its palette — so no generated project ever got
        // a theme. Those steps are part of commissioning a UI, not a separate phase, so they live here.
        assert!(ui.contains("bsc ui shapes") && ui.contains("--shape"),
            "ui directive must query the KIT for a screen's shape, not only derive the data's shape: {ui}");
        assert!(ui.contains("bsc ui theme list") && ui.contains("bsc plan ui set"),
            "ui directive must pair the app with a theme and record the {{kit, theme}} pair: {ui}");
        assert!(ui.contains("bsc ui emit-css") && ui.contains("tokens.css") && ui.contains("theme.css"),
            "ui directive must name the palette emission + its two files: {ui}");
        assert!(ui.contains("bsc ui eslint-preset"),
            "ui directive must bake the kit's lint enforcement into the generated app: {ui}");
        // …and `test_ui` must POINT at `ui` rather than instruct these itself, or a project has two
        // places its theme is settled. A substring BAN cannot express that — the pointer names those
        // commands deliberately, to say where they moved — so assert the pointer instead.
        let (test_ui, _) = packaged("test_ui");
        assert!(test_ui.contains("**UI** stage owns the pipeline"),
            "test_ui must hand the pipeline to `ui`, not carry a second copy (#4249): {test_ui}");
        assert!(test_ui.contains("settles nothing"),
            "test_ui must declare itself a reading stage: {test_ui}");
    }

    #[test]
    fn features_commissions_the_librarian_for_a_missing_algorithm() {
        // #4249: the two studios were ASYMMETRIC. The UI stage says "where a screen needs something the
        // kit lacks, commission a general, always-applicable component"; Features said only "leave it out
        // when nothing in the library applies" — a dead end that quietly hands the gap to a worker, which
        // is the `reimplemented-component` problem (#3892) one layer up.
        let (features, prompt) = packaged("features");
        for (face, text) in [("directive", &features), ("prompt", &prompt)] {
            assert!(text.contains("bsc graph impl list"),
                "features {face} must look the library up FIRST (reuse-first): {text}");
            assert!(text.contains("bsc-commission librarian"),
                "features {face} must commission the librarian for an algorithm the library lacks: {text}");
            // Reuse-first is an ORDER, not two sentences: look it up before you ask for a new one.
            assert!(text.find("bsc graph impl list") < text.find("bsc-commission librarian"),
                "features {face} must check the library BEFORE commissioning: {text}");
        }
        // The boundary the planner routes on: a component is UI (designer, `bsc ui`); an algorithm is
        // computation (librarian, `bsc graph impl`). Without it the planner has two emitters and no rule.
        assert!(features.contains("designer") && features.contains("librarian"),
            "features directive must name BOTH studios: {features}");
        assert!(features.contains("`bsc ui`") && features.contains("`bsc graph impl`"),
            "features directive must name each studio's store, which is the boundary: {features}");
        // An empty `requires` means "needs none" — never "the library was missing one".
        assert!(features.contains("NEVER") || features.contains("never"),
            "features directive must rule out an empty `requires` standing in for a gap: {features}");
    }

    #[test]
    fn discovery_asks_the_user_for_the_ui_mode() {
        // #4249: `uiMode` selects the ENTIRE UI pipeline — whether the designer is commissioned at all —
        // and discovery used to describe it with a default, phrased as a decision for the planner to make,
        // while the very next clause told it to ASK about the optional stages. A whole-pipeline choice is
        // the user's; the planner may not infer it.
        let (disc, _) = packaged("discovery");
        assert!(disc.contains("`uiMode`"), "discovery still records the UI mode: {disc}");
        let clause = &disc[disc.find("`uiMode`").expect("uiMode clause")..];
        let clause = &clause[..clause.len().min(600)];
        assert!(clause.contains("ASK the user"),
            "discovery must ASK for the UI mode, not choose it: {clause}");
        assert!(clause.contains("custom") && clause.contains("external"),
            "both modes must still be offered by name: {clause}");
    }

    #[test]
    fn discovery_asks_both_system_axes_and_separates_them_from_ui_mode() {
        // #4115: the system axes decide whether OUR platform supplies AND RUNS each half of the
        // project — the component graph rendering its UI, the algorithms graph supplying (and our host
        // EXECUTING) its computation. Different question from `uiMode` (where the DESIGNS come from),
        // and the trap is that uiMode looks sufficient: `external` still means we render the shell.
        let (disc, _) = packaged("discovery");
        for axis in ["`uiSystem`", "`algorithmSystem`"] {
            assert!(disc.contains(axis), "discovery must record {axis}: {disc}");
        }
        let clause = &disc[disc.find("`uiSystem`").expect("system-axis clause")..];
        let clause = &clause[..clause.len().min(1600)];
        assert!(clause.contains("ASK the user"), "the system axes are the user's call: {clause}");
        assert!(clause.contains("studio") && clause.contains("own"),
            "both values must be offered by name: {clause}");
        // The distinction from uiMode is the whole point — state it, don't leave it to be inferred.
        assert!(clause.contains("NOT the same question as `uiMode`"),
            "the clause must separate uiSystem from uiMode explicitly: {clause}");
        // Asked SEPARATELY: the axes differ often (own UI, studio algorithms), and collapsing them
        // into one answer is exactly how the executed half ends up unstated.
        assert!(clause.contains("SEPARATELY"),
            "the two axes must be asked separately, not collapsed: {clause}");
        // Ask, never infer silently — but propose from evidence (an existing frontend / core logic).
        assert!(clause.contains("frontend"), "propose `own` from an existing frontend: {clause}");
        // Both are asked BEFORE uiMode, because they govern whether uiMode means anything.
        assert!(disc.find("`uiSystem`") < disc.find("`uiMode`"),
            "uiSystem must be asked before uiMode — it decides whether uiMode matters");
        assert!(disc.find("`algorithmSystem`") < disc.find("`uiMode`"),
            "algorithmSystem belongs with its twin, ahead of uiMode");
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
            "automations","skills",
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
        // Row 1: the migrate-to-kit replace, with its optional preview `spec` deliberately omitted.
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
        // #2509 slice d: the gap-fill row carries a live-preview `spec` — the user decides to build
        // the NEW component by SEEING it in the pane, so a gap-fill spec is REQUIRED at set-time and
        // the taught example must model one. #3500 moved it to the general node vocabulary, so the
        // discriminant is `type` naming a REAL kit primitive (the example sketches a Card).
        assert!(rows[0]["spec"].is_object(), "the gap-fill row carries a preview spec object");
        assert_eq!(rows[0]["spec"]["type"], serde_json::json!("Card"), "the spec is a Card sketch");
        assert!(
            rows[0]["spec"].get("kind").is_none(),
            "the taught spec uses the general vocabulary, not the retired `kind` nodes"
        );
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

    /// #2478: the shape LOOP is closed end to end in the shipped stage prose. `bsc data shapes`
    /// answers "what shape IS this entity's data" (inferred from the canonical Data Model's own
    /// structure — see `bsc_data::shape`); `bsc ui shapes` answers "which kit components render that
    /// shape" (#2475). The stages that pick a layout must teach BOTH halves, or the planner is back
    /// to judging the taxonomy by hand — which is exactly what #2478 removed.
    #[test]
    fn layout_stages_teach_the_schema_to_shape_to_component_loop() {
        for id in ["ui"] {
            let raw = crate::platform::config::embedded_str(&format!("stages/{id}.json"));
            let v: serde_json::Value = serde_json::from_str(&raw).expect("stage json valid");
            let prompt = v["prompt"].as_str().unwrap_or_default();
            let directive = v["directive"].as_str().unwrap_or_default();
            for field in [prompt, directive] {
                assert!(
                    field.contains("bsc data shapes"),
                    "stage '{id}' must teach `bsc data shapes` — the schema→shape half of the loop"
                );
            }
            // The inference returns RANKED candidates, never one guess: the prose has to say so, so
            // the session surfaces the tie instead of silently picking (a lone self-reference is a
            // tree ONLY if an item has one parent).
            let both = format!("{prompt}\n{directive}").to_lowercase();
            assert!(
                both.contains("rank"),
                "stage '{id}' must say the shapes come back RANKED, not as a single answer"
            );
            assert!(
                both.contains("ask the user") || both.contains("put the question to the user"),
                "stage '{id}' must tell the session to ask when the top candidates tie"
            );
            // The shape slugs are the shared vocabulary both CLIs accept — pin them so the prose
            // can't teach a token `bsc ui shapes` would reject.
            for shape in ["list", "linked-list", "tree", "graph", "table", "key-value", "series"] {
                assert!(
                    both.contains(shape),
                    "stage '{id}' must name the `{shape}` vocabulary token"
                );
            }
        }
        // The component half stays where #2475 put it: the Test UI stage picks the layout.
        let test_ui = crate::platform::config::embedded_str("stages/test_ui.json");
        assert!(test_ui.contains("bsc ui shapes"), "test_ui teaches the component-side picker");
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
            "automations","skills",
            "streams","source","test_ui","market","transformations"].iter().map(|s| s.to_string()).collect();
        assert_eq!(with_directive, expected, "stage `directive` set drifted from the expected set");
    }
}
