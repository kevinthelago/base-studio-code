use super::templates::*;

/// The user-facing planner introduction kickoff for a session mode (#1240). Returned to the
/// frontend, which bakes it into the planner's `claude` launch as a fresh-only startup prompt.
/// `mode`: `"blueprint"` (authoring) | `"existing"` (existing repos) | anything else ⇒ new project.
#[tauri::command]
pub(crate) fn planner_intro_prompt(mode: String) -> String {
    match mode.as_str() {
        "blueprint" => PLANNING_INTRO_BLUEPRINT,
        "existing" => PLANNING_INTRO_EXISTING,
        _ => PLANNING_INTRO_NEW,
    }
    .to_string()
}
/// One-line directive per planning stage (#542/#666) for the assembled active-stages
/// section. Unknown ids fall back to a generic line.
pub(crate) fn stage_directive(id: &str) -> String {
    let line = match id {
        "context"     => "**Context** — establish the project's context one topic at a time, each a markdown file at `context/<topic>.md` (canonical key = the file stem). The REQUIRED set is DYNAMIC: the baseline `goal, scope, stack, architecture, users, release` is seeded for you — shape it for THIS project with `bsc-plan context require <topic>` / `bsc-plan context unrequire <topic>` as the picture clarifies (a CLI tool unrequires `users`/`ux`; a data platform requires `schema`; a realtime API requires `api`). `bsc-plan context list` shows the manifest. The `release` file proposes the versioning + release schedule: default to a COMPLETE initial prototype first, then FEATURE-BY-FEATURE releases (semver; release-and-continue). ALWAYS write the required files; cover other dimensions ONLY where they genuinely apply, using the canonical key as the file stem (`context/ux.md`, `context/schema.md`, `context/api.md`, `context/security.md`, `context/testing.md`, `context/observability.md`, `context/reliability.md`, `context/data_lifecycle.md`, …; the production-readiness bars in the planning guide are first-class dimensions here — apply where they matter, accessibility/compliance via the Compliance MCP, and **SEO for any public web-facing project** (`context/seo.md` — target audience/keywords + indexability; the **Web SEO** skill carries the how; skip it for CLI/desktop/library/internal/API-only)). When the project hinges on specialized or fast-moving techniques (graphics, algorithms, ML, cryptography, distributed systems, physics), ground the `stack`/`architecture` choices in the built-in **Research** MCP — start with `search` `sources:[\"wikipedia\"]` for the lay-of-the-land, then the scientific sources for depth, and cite what you adopt rather than guessing. Record every dimension you don't document in `context/_skipped.md`. The required files are done once WRITTEN — they're generated, not confirmed (the gate checks every required `context/<topic>.md` exists). Do NOT create files for tangential topics, or the gate can't complete.",
        "repos"       => "**Repos** — decide and link the repositories: emit `<repo_link owner/repo>` for each (clones it into the hub + records the link in plan.db, durable). Do NOT write repos.json — links live in plan.db (`bsc-plan repo list` shows them; `bsc-plan repo add owner/repo` links one directly).",
        "deploy"      => "**Deploy** (right after Repos) — define how each service SHIPS, then RECORD it in the plan DB by piping the config JSON to `bsc-plan deploy set`. **`bsc-plan deploy set` is what clears the gate and fills the Deploy pane — a prose `deploy.md` does NOT** (`bsc-plan deploy get` shows the stored config). JSON fields: `services` (array; each REQUIRES `platform` + `workload` = static|serverless|container|service, plus `id`, `repo`, `region`, `build`, `output`/`runtime`); `environments` (≥2; each `name`, `branch`, `url`, `auto`); `pipeline` (`provider` + `stages`: array of `{name, trigger: push|tag|on-green|manual, gate: bool, cmd}`, ≥2 stages); `secrets` (array of `{key, envs:[…]}` — list `prod` in `envs` for every prod-needed secret); `release` (`strategy` = recreate|rolling|blue-green|canary, `autoRollback`, `keep`, `migrateWithDeploy`); `health` (`probe`, `slo`, `alerts`). The gate (`deploymentDefined`) needs: a `platform` on EVERY service, ≥2 environments, ≥2 pipeline stages, every secret wired for `prod`, and a non-empty `release.strategy`. Propose defaults from the stack, confirm with the user, then pipe the whole config: `echo '{…}' | bsc-plan deploy set` (re-run with the full config as it firms up). A human-readable `deploy.md` is optional reference. Publishes as deployment issues owned by a `deploy` stream.",
        "ui"          => "**UI** — runs AFTER Features: design the screens that deliver the defined capabilities. Write functionless React skeletons to `.ui-skeleton/<Screen>.jsx` and emit `<ui_preview screen=\"…\" mode=\"2d|3d\" />` to render them live. Then author a **Claude Design kickoff** at `prompts/ui-kickoff.md` — a self-contained brief (goal, feature→screen map, each screen's states/flows, design-system constraints) the user pastes into a Claude Design session. If the user has DROPPED design files (check `design/intake.json` — the file-intake manifest), they're real Claude Design exports: route each into the UI repo (e.g. `<repo>/src/components/`), base the `.ui-skeleton/` screens on them rather than inventing from scratch, and reference them in `prompts/ui-kickoff.md` AND in the UI stream's worker kickoff — so the fleet builds the actual approved design, not a fresh guess.",
        "features"    => "**Features** — work titles-first via the `bsc-plan feature` store (NOT a features.json file). STEP 1: register the COMPLETE title roster in one pass — `bsc-plan feature add \"Invite teammates\" \"Export to CSV\" ...` (names only; the board shows each as an undefined title). Agree the roster with the user before detailing. STEP 2: drive ONE feature at a time, filling its detail by slug — `echo '{\"slug\":\"invite-teammates\",\"behavior\":\"…\",\"acceptance\":[\"…\"],\"approach\":\"…\",\"tools\":[\"…\"],\"data\":\"…\",\"dependsOn\":[\"…\"],\"stream\":\"…\"}' | bsc-plan feature add` (merges in place — do NOT resend the name). `behavior` = what it does + when, in the user's terms; `acceptance` = a done-when checklist; `data` = what it stores/reads; `dependsOn` = slugs of OTHER features this one builds on (the roadmap DAG — keep it acyclic; a feature may be foundational, not just user-facing); `stream` defaults to the slug. A feature is defined once it has name + behavior + ≥1 acceptance (`bsc-plan feature list` shows ✓/·). Do NOT design the integration contracts here — that's the Plan/Structure stage. When EVERY feature is populated, present the set and let the USER confirm to complete the stage — never advance the stage yourself.",
        "structure"   => "**Structure** — the features are a dependency DAG (`bsc-plan feature list` shows each feature + its `dependsOn`). SEQUENCE them into a roadmap, all IN THE PLAN DB — do NOT write phases.json or any issue files. Issues are generated from the features at GitHub-publish time, not during planning (no `bsc-plan add`). Two writes: (1) define the ordered phases — `bsc-plan phase add \"<name>\" \"<done-when>\"`, foundations first (`bsc-plan phase list` numbers them); (2) assign EVERY feature its phase NUMBER via `echo '{\"slug\":\"…\",\"phase\":<n>}' | bsc-plan feature add` (merges in place). When every feature is phased, present the roadmap + the dependency graph and get the user's approval. (Existing repos: inventory every screen/module first so none is missed.)",
        "permissions" => "**Permissions** — plan the agent fleet IN THE PLAN DB: pipe a FleetPlan JSON (non-overlapping streams with least-privilege profiles + per-stream perms/flows, plus recommended/director/topology) to `bsc-plan fleet set`. A stream may also carry `mcp` (assigned MCP servers) and `groupIds` (skill task-group ids from `bsc-skill group`, authored in the Skills stage) — each worker inherits those at launch. The fleet lives ONLY in plan.db — there is no fleet.json; `bsc-plan fleet get` shows the stored fleet.",
        // Merged stages (#1383/#1392): a blueprint can fold two stages into ONE — Deploy folds into
        // Repos ("Deployment") and Permissions folds into Structure ("Streams"). The overview names
        // the merged stage and covers BOTH halves; the app still delivers each half's working
        // instructions as its substep activates.
        "repos_deploy" => "**Deployment** — ONE stage, two parts. (1) **Link** the repositories this project spans: emit `<repo_link owner/repo>` for each (clones into the hub + records the link in plan.db; `bsc-plan repo add owner/repo`, `bsc-plan repo list`). (2) **Ship**: define how each service DEPLOYS and the libraries it depends on, recorded in plan.db — `bsc-plan deploy set` (config JSON: `services` each with `platform`+`workload`, ≥2 `environments`, a staged `pipeline`, `secrets`, a `release.strategy`) and `bsc-plan deps set` (the locked dependency manifest). The gate needs BOTH: ≥1 repo linked AND the deploy config + ≥1 locked dependency. `bsc-plan deploy get` / `bsc-plan deps get` show the stored config.",
        "streams"     => "**Streams** — ONE stage, two parts. (1) **Plan the roadmap**: the features are a dependency DAG (`bsc-plan feature list`). Sequence them into ordered phases IN PLAN.DB — `bsc-plan phase add \"<name>\" \"<done-when>\"` (foundations first), then assign EVERY feature its phase number (`echo '{\"slug\":\"…\",\"phase\":<n>}' | bsc-plan feature add`). (2) **Plan the fleet**: pipe a FleetPlan JSON (non-overlapping streams with least-privilege profiles + per-stream perms/flows, plus recommended/director/topology; a stream may carry `mcp`/`groupIds`) to `bsc-plan fleet set`. The gate needs BOTH: the roadmap sequenced AND the fleet streams scoped/profiled. The fleet lives ONLY in plan.db (`bsc-plan fleet get`).",
        "automations" => "**Automations** — propose cron automations (emit `<automation_assign>`).",
        "skills"      => "**Skills** — select reusable skills from the library AND author new ones GROUNDED IN REAL SOURCES (`skills.json`). The built-in **Research** MCP is always available (no setup). SEED each new skill from **Wikipedia** first — `search` with `sources:[\"wikipedia\"]`, then `get_fulltext` on the article to lay down the broad skeleton (definitions, sub-topics, key terms). Then REFINE it by looping the scientific sources (arXiv, Semantic Scholar, PubMed/PMC, Crossref): `search` those sub-topics and use `get_fulltext` / `semantic_search` to pull the exact passages, folding that cited, current depth back into the skill. Each pass adds detail + citations — so workers get evidence-based technique, not guesswork. This matters most for specialized, fast-moving areas (3D graphics, algorithms, ML, cryptography, distributed systems, physics). Prefer recent, well-cited work; never fabricate references. GROUP related skills into reusable **task groups** in the GLOBAL skills library via `bsc-skill` (available in this session): `echo '{\"id\":\"grp-<slug>\",\"name\":\"<Group>\",\"skillIds\":[\"<skill-id>\",…]}' | bsc-skill group add` (the skill ids are the ones you authored in `skills.json`; `bsc-skill group list` shows the stored groups). Then ASSIGN a group to a fleet stream by listing its id in that stream's `groupIds` in the FleetPlan (parallel to `mcp`) — every worker on the stream then inherits the whole group's skills at launch.",
        // transform / operate stages (#666) — these do NOT produce issues.json.
        "refactor"     => "**Refactor** — identify improvement opportunities (dead code, simplification, performance); write one targeted cleanup issue per area. Do NOT produce `phases.json` or `issues.json`.",
        "cleanup"      => "**Dead & legacy code** — scan for unused/dead code & dependencies, verify each finding, and triage them into refactor units. Do NOT write `issues.json` — the refactor units drive the fleet directly.",
        "testing" | "testing-informational" => "**Testing** — define the coverage strategy and the test safety net for the changes.",
        "transform"    => "**Transform** — plan the migration to a new pattern, version, or framework; write migration issues in strict dependency order.",
        "boundaries"   => "**Service boundaries** — map the bounded contexts and the seams to split the monolith along.",
        "extraction"   => "**Extraction plan** — sequence the incremental, shippable steps to carve out each service.",
        "consolidation" => "**Consolidation** — plan merging the services, unifying data stores and contracts.",
        "migration"    => "**Migration plan** — the from→to mapping and an incremental, reversible cutover.",
        "hardening"    => "**Security hardening** — threat-model, audit (authz / secrets / deps), and plan concrete fixes.",
        // Blueprint-authoring lifecycle (#923) — the DELIVERABLE is a reusable blueprint published
        // to a gist; there is NO code, no fleet, no triage. Build the blueprint with `bsc-plan
        // blueprint set` and re-run it with the whole blueprint as it grows (#1022).
        "purpose"         => "**Purpose** — you are designing a reusable BLUEPRINT (a planning template), not a software project. Establish its lifecycle category, the projects it seeds, and its name + description; record it with `bsc-plan blueprint set` (the blueprint JSON on stdin: id/name/desc/category/mode). Do NOT emit a `<blueprint>` tag — `bsc-plan blueprint get` shows the stored blueprint.",
        "bp_stages"       => "**Stages** — design the blueprint's ordered stages, one at a time: each stage's key+name, intent, the discovery prompt it runs, its deps/order, and whether it's optional. Re-run `bsc-plan blueprint set` with the full blueprint JSON as the sections array grows.",
        "bp_capabilities" => "**Capabilities** (optional) — attach reusable skills/knowledge + MCP servers the blueprint should bundle into projects it seeds; fold them into the blueprint JSON's section or blueprint-level skills/mcp arrays and re-run `bsc-plan blueprint set`.",
        "bp_review"       => "**Review & publish** — review the assembled blueprint with the user, record the FINAL blueprint with `bsc-plan blueprint set`, and let the user publish it to a gist from the footer. Do NOT publish it yourself.",
        other         => return format!("**{other}** — configured stage."),
    };
    line.to_string()
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
    fn ui_directive_instructs_routing_dropped_design_files() {
        // #1371: the UI stage must tell the planner to route dropped design files into the repo
        // and build the skeleton/kickoff from them — otherwise staged design never reaches the build.
        let ui = stage_directive("ui");
        assert!(ui.contains("design/intake.json"), "ui directive must reference the intake manifest: {ui}");
        assert!(ui.contains(".ui-skeleton/"), "ui directive must still drive the skeleton");
        assert!(ui.contains("ui-kickoff.md"), "ui directive must still author the kickoff");
    }

    #[test]
    fn merged_stage_directives_name_the_stage_and_cover_both_halves() {
        // #1383/#1392: the planner overview gets ONE directive for a merged stage, covering both
        // halves' CLIs. `repos_deploy` = "Deployment" (link repos + deploy); `streams` = both the
        // roadmap (phases) AND the fleet.
        let dep = stage_directive("repos_deploy");
        assert!(dep.contains("Deployment"), "merged stage names itself Deployment: {dep}");
        assert!(dep.contains("repo_link") && dep.contains("bsc-plan deploy set") && dep.contains("bsc-plan deps set"),
            "Deployment covers link + deploy + deps: {dep}");
        let streams = stage_directive("streams");
        assert!(streams.contains("Streams"), "merged stage names itself Streams: {streams}");
        assert!(streams.contains("bsc-plan phase add") && streams.contains("bsc-plan fleet set"),
            "Streams covers the roadmap AND the fleet: {streams}");

        // The merged stages render in the active-stages overview with their merged names.
        let md = build_active_stages_md(&["repos_deploy".into(), "streams".into()]);
        assert!(md.contains("**Deployment**") && md.contains("**Streams**"), "overview lists merged names: {md}");
    }
}
