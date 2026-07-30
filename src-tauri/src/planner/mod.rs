pub(crate) mod prompts;
pub(crate) mod directives;
pub(crate) mod workspace;

#[cfg(test)]
mod tests {
    use super::prompts::*;
    use super::directives::*;
    use super::workspace::*;

    // Content assertions validate the SHIPPED prompt artifacts, so they read the EMBEDDED seed
    // (`config::embedded_str`), independent of any local config-dir override (#2027 P2). The routing
    // test compares against the production `planning_greeting_*` accessors (both use `load_str`, so
    // it stays env-independent).
    fn process_md() -> String { crate::platform::config::embedded_str("planner/process.md") }
    fn new_intro() -> String { crate::platform::config::embedded_str("planner/intro.new.md") }
    fn existing_intro() -> String { crate::platform::config::embedded_str("planner/intro.existing.md") }

    #[test]
    fn build_active_stages_md_includes_enabled_excludes_disabled() {
        // Empty → omitted (all-stages default, no behavior change).
        assert_eq!(build_active_stages_md(&[]), "");

        let md = build_active_stages_md(&["discovery".into(), "streams".into()]);
        assert!(md.contains("Active planning stages"));
        assert!(md.contains("OUT OF SCOPE"), "must declare unlisted stages out of scope");
        assert!(md.contains("**Discovery**") && md.contains("**Streams**"));
        // a stage not in the enabled list is absent
        assert!(!md.contains("**UI**"), "disabled stage must not be instructed");
        // ordered + numbered
        assert!(md.find("**Discovery**").unwrap() < md.find("**Streams**").unwrap());

        // unknown id → generic line, never panics
        assert!(build_active_stages_md(&["custom-x".into()]).contains("**custom-x**"));
    }

    /// Context directive must name the four gate-required files so the planner
    /// doesn't create tangential sections that block the gate (#672).
    #[test]
    fn stage_directive_context_seeds_baseline_and_uses_bsc_plan() {
        let d = stage_directive("discovery");
        // Names the baseline required topics — the DYNAMIC set seeded for the project (#1019).
        for t in ["goal", "scope", "stack", "architecture", "users", "release"] {
            assert!(d.contains(t), "context directive names baseline topic {t}");
        }
        // The required-set is shaped via `bsc plan context`; non-applicable dimensions go to _skipped.
        assert!(d.contains("bsc plan discovery"), "directive shapes the required-set via `bsc plan context`");
        assert!(d.contains("_skipped.md"),      "must mention _skipped.md fallback");
        // Context files gate on GENERATION, not confirmation (#1028).
        assert!(d.to_lowercase().contains("written"), "directive states required files are done once written");
        assert!(d.to_lowercase().contains("generated, not confirmed"), "context files are generated, not confirmed");
    }

    /// #3989: Discovery must produce a CLOUD OUTAGE RESPONSE PLAN for anything hosted on cloud
    /// infrastructure — the failure a hosted app is most exposed to and least in control of. It is
    /// a per-project require (a CLI has no cloud to lose), so the directive must carry BOTH the
    /// require rule and the plan's shape, or the planner writes a vague paragraph or nothing.
    #[test]
    fn stage_directive_discovery_carries_the_cloud_outage_response_plan() {
        // Read the EMBEDDED seed, not `stage_directive` — the latter prefers a local config-dir
        // copy, and this asserts on the SHIPPED prose (same rule as `process_md` above).
        let raw = crate::platform::config::embedded_str("stages/discovery.json");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("discovery.json parses");
        let d = v["directive"].as_str().expect("discovery.json has a directive").to_string();
        assert!(d.contains("discovery/outage_response.md"), "directive names the outage plan file");
        assert!(
            d.contains("require `outage_response`") || d.contains("requires `outage_response`"),
            "directive gives the cloud-hosted require rule for outage_response",
        );
        // The six-part shape — each is the part a plan is useless without.
        for part in ["blast radius", "degradation posture", "RPO/RTO", "drill"] {
            assert!(d.contains(part), "outage plan must cover {part}");
        }
        assert!(d.to_lowercase().contains("detect"), "outage plan must cover detection");
        assert!(d.to_lowercase().contains("failover"), "outage plan must cover failover");
        // Not a universal require: it stays skippable for a project with no cloud dependency.
        assert!(d.contains("_skipped.md"), "a no-cloud project records the skip");
    }

    /// The planning guide carries the same bar, so a planner reading the guide rather than the
    /// stage directive still reaches the plan (#3989).
    #[test]
    fn planning_process_carries_the_cloud_outage_response_bar() {
        let md = process_md();
        assert!(md.contains("Cloud outage response"), "readiness bars include cloud outage response");
        assert!(md.contains("outage_response"), "guide names the canonical dimension key");
        assert!(
            md.contains("bsc plan discovery require outage_response"),
            "guide gives the require command",
        );
    }

    /// #4024: Discovery must record integrations as DATA, not only prose — the Source pane and the
    /// Integration Studio both read those rows and neither can read markdown. The `direction` split is
    /// the load-bearing part: it cannot be recovered later, so the directive must demand it be ASKED.
    #[test]
    fn stage_directive_discovery_records_integrations_as_data() {
        let raw = crate::platform::config::embedded_str("stages/discovery.json");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("discovery.json parses");
        let d = v["directive"].as_str().expect("directive").to_string();
        assert!(d.contains("bsc plan discovery integration set"), "directive names the capture verb");
        for field in ["\"id\"", "direction", "docs", "baseUrl", "purpose"] {
            assert!(d.contains(field), "directive names the {field} field");
        }
        // Both directions, and the instruction to ASK rather than infer.
        assert!(d.contains("`source`") && d.contains("`runtime`"), "directive defines both directions");
        assert!(d.to_lowercase().contains("never guess") || d.to_lowercase().contains("must ask"),
                "direction must be asked, not inferred");
        // The prose file is NOT replaced by the rows.
        assert!(d.contains("discovery/integrations.md"), "the prose record survives alongside the data");
        // Declaring nothing must stay valid, or the planner invents integrations to satisfy the step.
        assert!(d.to_lowercase().contains("declaring nothing is a valid outcome"),
                "an integration-free project must not be pushed to invent one");
        // Must NOT steer at the deprecated connector alias (#1721) — a different store entirely.
        assert!(d.contains("NOT `bsc plan integration`"), "directive disambiguates from the deprecated alias");
    }

    /// Features directive must steer the planner to write features.json (the artifact the
    /// Features pane + gate read), not the per-feature markdown sections (#815).
    #[test]
    fn stage_directive_features_names_features_json() {
        let d = stage_directive("features");
        assert!(d.contains("features.json"), "must name the features.json artifact");
        assert!(d.contains("acceptance"), "must mention the acceptance checklist");
        assert!(d.contains("behavior"), "must mention behavior");
        assert!(d.contains("ONE feature"), "must mandate one-feature-at-a-time pacing");
    }

    /// Skills directive authors via `bsc skill` + the per-session group, and points skill
    /// grounding at the planning guide's Research workflow (the how-to moved there, #1433).
    #[test]
    fn stage_directive_skills_authors_via_bsc_skill() {
        let d = stage_directive("skills");
        assert!(d.contains("bsc skill add"), "skills are authored via `bsc skill`");
        assert!(!d.contains("skills.json"), "the planner must no longer be told to write skills.json (#1412)");
        // #1419: authored skills pair into the per-session group and the planner can curate it.
        assert!(d.contains("$BSC_SESSION_SKILL_GROUP"), "must author into the session skill group");
        assert!(d.contains("group member"), "must tell the planner it can add/remove group members");
        // #1433: the Research how-to lives in the planning guide now; the directive only points at it.
        assert!(d.to_lowercase().contains("research"), "must point skill grounding at the Research workflow");
        assert!(!d.contains("semantic_search"), "the Research tool how-to belongs in the planning guide, not the directive (#1433)");
    }

    /// Context directive points technique grounding at the planning guide's Research workflow (#1433).
    #[test]
    fn stage_directive_context_points_to_research_workflow() {
        let d = stage_directive("discovery");
        assert!(d.to_lowercase().contains("research workflow"), "context directive must point technique grounding at the planning guide's Research workflow");
        assert!(!d.contains("semantic_search"), "the Research tool how-to belongs in the planning guide, not the directive (#1433)");
    }

    /// #1433: the Research how-to (Wikipedia-first → compile Skills → refine with research papers)
    /// lives in the planning guide, not the per-stage directives.
    #[test]
    fn planning_process_describes_the_research_workflow() {
        let md = process_md();
        assert!(md.contains("Research"), "planning guide must describe the Research MCP");
        assert!(md.contains("Wikipedia") && md.contains("sources:[\"wikipedia\"]"), "must steer Wikipedia-first research");
        assert!(md.contains("get_fulltext") && md.contains("semantic_search"), "must name the Research tools");
        assert!(md.contains("arXiv"), "must steer refining with the scientific sources (research papers)");
        assert!(md.contains("bsc skill add"), "must compile the findings into Skills");
        assert!(md.to_lowercase().contains("never fabricate"), "must forbid fabricated references");
    }

    /// Context directive surfaces SEO as a web-conditional production-readiness dimension (#1293).
    #[test]
    fn stage_directive_context_includes_web_seo() {
        let d = stage_directive("discovery");
        assert!(d.contains("discovery/seo.md"), "context directive must name the seo dimension file");
        assert!(d.contains("Web SEO"), "context directive must point at the Web SEO skill");
    }

    /// The Streams directive sequences the feature DAG + plans the fleet (#1914 — the collapsed
    /// structure+permissions stage). It must never author phases/issues (publish-time artifacts).
    #[test]
    fn stage_directive_streams_sequences_features_and_plans_fleet() {
        let d = stage_directive("streams");
        assert!(d.contains("dependency DAG") || d.contains("dependsOn"), "streams reviews the feature dependency graph: {d}");
        assert!(d.contains("bsc plan feature list"), "streams reviews the DAG via the plan DB: {d}");
        assert!(d.to_lowercase().contains("no milestone phases"), "sequencing is dependsOn-only, no milestone phases: {d}");
        assert!(d.contains("bsc plan fleet set"), "streams plans the fleet: {d}");
        assert!(d.contains("bsc plan deps set") && d.contains("sharedDepsLocked"), "streams locks shared deps (#1429): {d}");
    }

    /// process_md() Coverage section must carry the gate-item and Context gate text (#672).
    #[test]
    fn planning_process_md_coverage_names_context_gate_requirements() {
        let md = process_md();
        assert!(md.contains("gate item"), "must explain the gate-item concept");
        assert!(md.contains("Context** gate"), "must name the Context gate");
        assert!(md.contains("goal`, `scope`"), "must list the required core files");
        assert!(md.contains("Work one stage at a time"), "must include the one-stage-at-a-time rule");
    }

    /// The Deploy stage's config example must teach BOTH deploy modes — the `mode:"local"` example with
    /// its `localKind`/`buildTargets`/`artifact` target fields, not just cloud `platform`/`workload`
    /// (#2392: a cloud-only example led the planner to write a schema-invalid local service — `mode:local`
    /// with a stray `workload` and no `localKind` — that never cleared the mode-aware Deployment gate).
    #[test]
    fn planning_process_md_deploy_example_covers_local_and_cloud_modes() {
        let md = process_md();
        assert!(md.contains(r#""mode":"cloud""#), "deploy example must include a mode:cloud service");
        assert!(md.contains(r#""mode":"local""#), "deploy example must include a mode:local service");
        assert!(md.contains(r#""localKind":"application""#), "local example must set localKind");
        assert!(
            md.contains("buildTargets") && md.contains("artifact"),
            "a local application target needs buildTargets + artifact"
        );
        assert!(md.contains("MUTUALLY EXCLUSIVE"), "must state the cloud/local target fields are mutually exclusive");
    }

    /// Both intros must carry the scope guard that makes the active-stages list
    /// authoritative over the fixed workflow steps (#666).
    #[test]
    fn planner_intros_carry_active_stages_scope_guard() {
        for t in [new_intro(), existing_intro()] {
            assert!(
                t.contains("Active planning stages section at the bottom of this file"),
                "scope guard missing from intro"
            );
            assert!(
                t.contains("DO NOT produce its outputs"),
                "must declare that unlisted stages are out of scope"
            );
        }
    }

    /// existing_intro() must include the lifecycle check paragraph (#458).
    #[test]
    fn planning_existing_intro_has_lifecycle_check() {
        let intro = existing_intro();
        assert!(intro.contains("Lifecycle check"), "lifecycle check section missing");
        assert!(intro.contains("near-complete"), "must mention near-complete threshold");
        assert!(intro.contains("refactor"), "must mention refactor pass for near-complete projects");
    }

    #[test]
    fn planner_intro_prompt_selects_by_mode() {
        // mode → matching template; unknown ⇒ the new-project intro (default).
        assert_eq!(planner_intro_prompt("new".into()), planning_greeting_new());
        assert_eq!(planner_intro_prompt("existing".into()), planning_greeting_existing());
        assert_eq!(planner_intro_prompt("garbage".into()), planning_greeting_new());
    }

    #[test]
    fn planner_intros_open_the_session_and_ask_one_question() {
        // Every mode's intro must: open the session (introduce + reference the stage journey),
        // ask exactly one orienting question, and stop and wait — the #1240 conventions.
        for (mode, distinct) in
            [("new", "idea"), ("existing", "existing repositories")]
        {
            let t = planner_intro_prompt(mode.into());
            assert!(t.contains("ONE orienting question"), "intro {mode} must ask one orienting question");
            assert!(t.contains("Active planning stages"), "intro {mode} must sketch the stage journey");
            assert!(t.to_lowercase().contains("stop and wait"), "intro {mode} must stop and wait for the user");
            assert!(t.contains(distinct), "intro {mode} must carry its mode-distinct framing ('{distinct}')");
            // It's a kickoff, not the spec: it must NOT dump the CLI surface at the user.
            assert!(!t.contains("bsc plan"), "intro {mode} must not dump the `bsc plan` CLI at the user");
        }
    }

    #[test]
    fn planner_template_is_plan_only_no_git_mutations() {
        // The planner is plan-only (#503): it must not be instructed to create repos,
        // milestones, issues, or labels, nor commit/push. Publishing is ENTIRELY the user's
        // job (#…) — the planner is never even told how it works. (The prohibition prose uses
        // bare backticked forms like `gh repo create`; here we guard the args-bearing
        // INSTRUCTION forms that only ever appeared as commands to run, AND that no template
        // describes the publish flow.)
        for t in [new_intro(), existing_intro(), process_md()] {
            assert!(!t.contains("--method POST --field"), "planner template instructs `gh api … --method POST`");
            assert!(!t.contains("gh label create \""), "planner template instructs `gh label create`");
            assert!(!t.contains("gh issue create --repo"), "planner template instructs `gh issue create`");
            assert!(!t.contains("gh repo create owner"), "planner template instructs `gh repo create`");
            assert!(!t.contains("gh repo create {owner}"), "planner template instructs `gh repo create`");
            assert!(!t.contains("gh repo create {login}"), "planner template instructs `gh repo create`");
            // De-publish (#…): the planner is never told how publishing works — it's the user's job.
            assert!(!t.contains("Publish button"), "planner must not be told how the publish flow works");
            assert!(!t.contains("publish flow"), "planner must not be told how the publish flow works");
            assert!(!t.contains("Publish to GitHub"), "planner must not carry a publish step");
        }
        // Positive: the plan-only framing is present, and publishing is framed as the user's job.
        assert!(process_md().contains("plan-only"), "plan-only framing missing");
        assert!(process_md().contains("entirely the user's responsibility"),
            "user-owns-publish framing missing");
        // Studio commissioning (#2940): the reuse-first directive names both targets + the reuse-check
        // command before the emitter, so the planner reuses the library before commissioning new work.
        assert!(process_md().contains("bsc-commission designer"), "component commissioning directive missing");
        assert!(process_md().contains("bsc-commission librarian"), "algorithm commissioning directive missing");
        assert!(process_md().contains("bsc ui list") && process_md().contains("bsc graph impl list"),
            "reuse-first check must precede commissioning");
    }

    #[test]
    fn context_signature_is_versioned_sorted_and_order_independent() {
        // One source of truth (#756): setup_workspaces (baseline) + compute_context_signature
        // (live) call this, so they can never disagree on format/version.
        let a = context_signature(
            &["b".into(), "a".into()], &["s2".into(), "s1".into()]);
        let b = context_signature(
            &["a".into(), "b".into()], &["s1".into(), "s2".into()]);
        assert_eq!(a, b, "order-independent (inputs are sorted)");
        assert_eq!(a, format!("v{}|a,b|s1,s2", PLANNING_TEMPLATE_VERSION));
        // carries the real template version, not a hardcoded constant — fixes the v1/v{N} mismatch.
        assert!(a.starts_with(&format!("v{}|", PLANNING_TEMPLATE_VERSION)));
    }

    #[test]
    fn custom_stage_directives_and_scope_guard() {
        // The active-stages section for a stage set WITHOUT `streams` doesn't list Streams —
        // so its issue-generation step is out of scope (#1914).
        let md = build_active_stages_md(&[
            "discovery".to_string(), "deployment".to_string(),
        ]);
        assert!(md.contains("OUT OF SCOPE"), "scope guard present");
        // The deployment directive references the Streams stage in prose ("dependencies are locked in
        // the Streams stage"), so check the full Streams DIRECTIVE (its issue-generation step) is absent
        // — not the bare word.
        assert!(!md.contains(&stage_directive("streams")), "no Streams stage → its issue-generation directive is out of scope");
        assert!(process_md().contains("authoritative"), "process defers to the active-stages list");
        // The context directive names the baseline required topics + the `bsc plan context` channel that
        // shapes the dynamic required-set, so the planner seeds what the gate keys on (#1019).
        let ctx = stage_directive("discovery");
        for t in ["goal", "scope", "stack", "architecture", "users", "release"] {
            assert!(ctx.contains(t), "context directive names baseline topic {t}");
        }
        assert!(ctx.contains("bsc plan discovery"), "context directive shapes the dynamic required-set");
        assert!(ctx.contains("_skipped.md"), "context directive points non-applicable dimensions at _skipped");
        assert!(process_md().contains("gate item"), "coverage section frames created files as gate items");
        // The discovery checklist itself flags the four files as gate-required and tells the
        // planner the gate can't pass without them — so they aren't lost to "skip" guidance (#736).
        let proc = process_md();
        assert!(proc.contains("REQUIRED for the Context gate"), "checklist has the required-files callout");
        assert!(proc.contains("gate-required"), "checklist marks the four required dimensions");
        for f in ["goal.md", "scope.md", "stack.md", "architecture.md"] {
            assert!(proc.contains(f), "checklist callout names {f}");
        }
    }
}
