pub(crate) mod templates;
pub(crate) mod directives;
pub(crate) mod workspace;

#[cfg(test)]
mod tests {
    use super::templates::*;
    use super::directives::*;
    use super::workspace::*;

    #[test]
    fn build_active_stages_md_includes_enabled_excludes_disabled() {
        // Empty → omitted (all-stages default, no behavior change).
        assert_eq!(build_active_stages_md(&[]), "");

        let md = build_active_stages_md(&["context".into(), "structure".into()]);
        assert!(md.contains("Active planning stages"));
        assert!(md.contains("OUT OF SCOPE"), "must declare unlisted stages out of scope");
        assert!(md.contains("**Context**") && md.contains("**Structure**"));
        // a stage not in the enabled list is absent
        assert!(!md.contains("**UI**"), "disabled stage must not be instructed");
        // ordered + numbered
        assert!(md.find("**Context**").unwrap() < md.find("**Structure**").unwrap());

        // unknown id → generic line, never panics
        assert!(build_active_stages_md(&["custom-x".into()]).contains("**custom-x**"));
    }

    /// Context directive must name the four gate-required files so the planner
    /// doesn't create tangential sections that block the gate (#672).
    #[test]
    fn stage_directive_context_seeds_baseline_and_uses_bsc_plan() {
        let d = stage_directive("context");
        // Names the baseline required topics — the DYNAMIC set seeded for the project (#1019).
        for t in ["goal", "scope", "stack", "architecture", "users", "release"] {
            assert!(d.contains(t), "context directive names baseline topic {t}");
        }
        // The required-set is shaped via bsc-plan context; non-applicable dimensions go to _skipped.
        assert!(d.contains("bsc-plan context"), "directive shapes the required-set via bsc-plan context");
        assert!(d.contains("_skipped.md"),      "must mention _skipped.md fallback");
        // Context files gate on GENERATION, not confirmation (#1028).
        assert!(d.to_lowercase().contains("written"), "directive states required files are done once written");
        assert!(d.to_lowercase().contains("generated, not confirmed"), "context files are generated, not confirmed");
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

    /// Skills directive must steer the planner to GROUND authored skills in the built-in
    /// Research MCP and cite real sources (#1056/#1196), not just pick from the library.
    #[test]
    fn stage_directive_skills_grounds_in_research() {
        let d = stage_directive("skills");
        assert!(d.contains("Research"), "skills directive must point at the Research MCP");
        assert!(d.contains("bsc-skill add"), "skills are authored via the bsc-skill CLI");
        assert!(!d.contains("skills.json"), "the planner must no longer be told to write skills.json (#1412)");
        // Names the concrete grounding tools and the cite-don't-fabricate rule.
        assert!(d.contains("search") && d.contains("semantic_search"), "must name the Research tools");
        assert!(d.to_lowercase().contains("cite") || d.to_lowercase().contains("cited"), "must require citing sources");
        assert!(d.to_lowercase().contains("never fabricate"), "must forbid fabricated references");
        // Seed-then-refine loop (#1298): Wikipedia seeds, scientific sources refine.
        assert!(d.contains("Wikipedia") && d.to_lowercase().contains("seed"), "must steer Wikipedia-first skill seeding");
        assert!(d.to_lowercase().contains("refine"), "must steer refining the seed with the scientific sources");
    }

    /// Context directive must also nudge grounding stack/architecture in Research (#1056/#1196).
    #[test]
    fn stage_directive_context_grounds_techniques_in_research() {
        let d = stage_directive("context");
        assert!(d.contains("Research"), "context directive must mention the Research MCP for technique grounding");
    }

    /// Context directive surfaces SEO as a web-conditional production-readiness dimension (#1293).
    #[test]
    fn stage_directive_context_includes_web_seo() {
        let d = stage_directive("context");
        assert!(d.contains("context/seo.md"), "context directive must name the seo dimension file");
        assert!(d.contains("Web SEO"), "context directive must point at the Web SEO skill");
    }

    /// Structure directive must mention both workshop modes (#355).
    #[test]
    fn stage_directive_structure_sequences_features_without_authoring_issues() {
        let d = stage_directive("structure");
        assert!(d.to_lowercase().contains("do not write phases.json"), "phases live in plan.db — must NOT write phases.json (#plan-db)");
        assert!(d.to_lowercase().contains("plan.db") || d.to_lowercase().contains("plan db"), "phases live in the plan DB");
        assert!(d.to_lowercase().contains("generated from the features"), "issues are a publish-time artifact, not authored here (#plan-db)");
        assert!(d.contains("bsc-plan feature add"), "missing the per-feature phase assignment");
        assert!(d.contains("inventory"), "missing existing-project handling");
    }

    /// Custom/refactor-blueprint stages get real directives, not the generic fallback (#666).
    #[test]
    fn stage_directive_custom_stages_have_real_directives() {
        for id in &["refactor", "cleanup", "testing", "testing-informational", "transform"] {
            let d = stage_directive(id);
            assert!(
                !d.ends_with("configured stage."),
                "stage '{id}' fell back to generic — needs a real directive"
            );
        }
        // Refactor explicitly says NOT to produce phases.json/issues.json (#666).
        assert!(stage_directive("refactor").contains("NOT"), "refactor must exclude phases/issues");
    }

    /// PLANNING_PROCESS_MD Coverage section must carry the gate-item and Context gate text (#672).
    #[test]
    fn planning_process_md_coverage_names_context_gate_requirements() {
        let md = PLANNING_PROCESS_MD;
        assert!(md.contains("gate item"), "must explain the gate-item concept");
        assert!(md.contains("Context** gate"), "must name the Context gate");
        assert!(md.contains("goal`, `scope`"), "must list the required core files");
        assert!(md.contains("Work one stage at a time"), "must include the one-stage-at-a-time rule");
    }

    /// Both intros must carry the scope guard that makes the active-stages list
    /// authoritative over the fixed workflow steps (#666).
    #[test]
    fn planner_intros_carry_active_stages_scope_guard() {
        for t in [PLANNING_NEW_INTRO, PLANNING_EXISTING_INTRO] {
            assert!(
                t.contains("Active planning stages section at the bottom of this file"),
                "scope guard missing from intro"
            );
            assert!(
                t.contains("do not produce their artifacts"),
                "must declare that unlisted stages are out of scope"
            );
        }
    }

    /// PLANNING_EXISTING_INTRO must include the lifecycle check paragraph (#458).
    #[test]
    fn planning_existing_intro_has_lifecycle_check() {
        let intro = PLANNING_EXISTING_INTRO;
        assert!(intro.contains("Lifecycle check"), "lifecycle check section missing");
        assert!(intro.contains("near-complete"), "must mention near-complete threshold");
        assert!(intro.contains("refactor"), "must mention refactor pass for near-complete projects");
    }

    #[test]
    fn blueprint_author_intro_requires_repos_and_permissions_for_fleet() {
        // A fleet-launching blueprint that omits a `permissions` stage produces no fleet, so its
        // projects can never launch (the bug that motivated this guard). The author session must be
        // told to always include `repos` + `permissions` for build/execution blueprints (#969).
        let intro = PLANNING_BLUEPRINT_INTRO;
        assert!(intro.contains("LAUNCHES A FLEET"), "author intro must call out fleet-launching blueprints");
        assert!(intro.contains("`permissions` stage"), "author intro must require a permissions stage for fleets");
        assert!(intro.contains("`repos` stage"), "author intro must require a repos stage for fleets");
    }

    #[test]
    fn planner_intro_prompt_selects_by_mode() {
        // mode → matching template; unknown ⇒ the new-project intro (default).
        assert_eq!(planner_intro_prompt("new".into()), PLANNING_INTRO_NEW);
        assert_eq!(planner_intro_prompt("existing".into()), PLANNING_INTRO_EXISTING);
        assert_eq!(planner_intro_prompt("blueprint".into()), PLANNING_INTRO_BLUEPRINT);
        assert_eq!(planner_intro_prompt("garbage".into()), PLANNING_INTRO_NEW);
    }

    #[test]
    fn planner_intros_open_the_session_and_ask_one_question() {
        // Every mode's intro must: open the session (introduce + reference the stage journey),
        // ask exactly one orienting question, and stop and wait — the #1240 conventions.
        for (mode, distinct) in
            [("new", "idea"), ("existing", "existing repositories"), ("blueprint", "reusable")]
        {
            let t = planner_intro_prompt(mode.into());
            assert!(t.contains("ONE orienting question"), "intro {mode} must ask one orienting question");
            assert!(t.contains("Active planning stages"), "intro {mode} must sketch the stage journey");
            assert!(t.to_lowercase().contains("stop and wait"), "intro {mode} must stop and wait for the user");
            assert!(t.contains(distinct), "intro {mode} must carry its mode-distinct framing ('{distinct}')");
            // It's a kickoff, not the spec: it must NOT dump the CLI surface at the user.
            assert!(!t.contains("bsc-plan"), "intro {mode} must not dump the bsc-plan CLI at the user");
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
        for t in [PLANNING_NEW_INTRO, PLANNING_EXISTING_INTRO, PLANNING_PROCESS_MD] {
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
        assert!(PLANNING_PROCESS_MD.contains("plan-only"), "plan-only framing missing");
        assert!(PLANNING_PROCESS_MD.contains("entirely the user's responsibility"),
            "user-owns-publish framing missing");
    }

    #[test]
    fn context_signature_is_versioned_sorted_and_order_independent() {
        // One source of truth (#756): setup_workspaces (baseline) + compute_context_signature
        // (live) call this, so they can never disagree on format/version.
        let a = context_signature(
            &["b".into(), "a".into()], &["k2".into(), "k1".into()], &["s2".into(), "s1".into()]);
        let b = context_signature(
            &["a".into(), "b".into()], &["k1".into(), "k2".into()], &["s1".into(), "s2".into()]);
        assert_eq!(a, b, "order-independent (inputs are sorted)");
        assert_eq!(a, format!("v{}|a,b|k1,k2|s1,s2", PLANNING_TEMPLATE_VERSION));
        // carries the real template version, not a hardcoded constant — fixes the v1/v{N} mismatch.
        assert!(a.starts_with(&format!("v{}|", PLANNING_TEMPLATE_VERSION)));
    }

    #[test]
    fn custom_stage_directives_and_scope_guard() {
        // Custom transform/operate stages get real directives, not the generic fallback.
        let cleanup = stage_directive("cleanup");
        assert!(cleanup.contains("refactor units"), "cleanup has a real directive");
        assert!(cleanup.to_lowercase().contains("do not write"), "cleanup forbids issues.json");
        assert!(stage_directive("boundaries").contains("bounded contexts"));
        // The active-stages section for a refactor-like set (no `structure`) doesn't list
        // Structure — so its issues.json step is out of scope.
        let md = build_active_stages_md(&[
            "context".to_string(), "repos".to_string(), "cleanup".to_string(),
            "testing".to_string(), "permissions".to_string(),
        ]);
        assert!(md.contains("OUT OF SCOPE"), "scope guard present");
        assert!(!md.contains("Structure"), "no Structure stage → no issues.json step");
        assert!(PLANNING_PROCESS_MD.contains("authoritative"), "process defers to the active-stages list");
        // The context directive names the baseline required topics + the bsc-plan context channel that
        // shapes the dynamic required-set, so the planner seeds what the gate keys on (#1019).
        let ctx = stage_directive("context");
        for t in ["goal", "scope", "stack", "architecture", "users", "release"] {
            assert!(ctx.contains(t), "context directive names baseline topic {t}");
        }
        assert!(ctx.contains("bsc-plan context"), "context directive shapes the dynamic required-set");
        assert!(ctx.contains("_skipped.md"), "context directive points non-applicable dimensions at _skipped");
        assert!(PLANNING_PROCESS_MD.contains("gate item"), "coverage section frames created files as gate items");
        // The discovery checklist itself flags the four files as gate-required and tells the
        // planner the gate can't pass without them — so they aren't lost to "skip" guidance (#736).
        let proc = PLANNING_PROCESS_MD;
        assert!(proc.contains("REQUIRED for the Context gate"), "checklist has the required-files callout");
        assert!(proc.contains("gate-required"), "checklist marks the four required dimensions");
        for f in ["goal.md", "scope.md", "stack.md", "architecture.md"] {
            assert!(proc.contains(f), "checklist callout names {f}");
        }
    }
}
