//! On-demand provisioning of the commons + integration LANES (#851 /
//! #funnel-commons-and-integration-streams) for a project whose plan never got them — request #132.
//!
//! ## Why a lane can be missing at all
//! `commonsLanesFor`/`applyCommonsGate` (`@/features/planner/fleet/commonsGate`) materialize the
//! `commons`/`integration` streams, but only inside `fleetStartProject` — a **frontend** action fired
//! by a UI-driven (re)launch — and only when it computes a non-empty `commonsGlobs` from
//! `s.planStages[projectKey]?.stack`. That field is written by `setPlanStage`, which nothing in the
//! shipped app calls any more (`scanPlanStages`/`read_plan_stages` — the only remaining path to it —
//! has zero callers): a casualty of the planner-UI deletion that nothing rewired. So on the
//! architect → director → workers funnel, `commonsGlobs` is always `[]`, `applyCommonsGate` never
//! fires, and no plan ever gets a commons lane. `bsc fleet start` (`fleet/start.rs`) makes it worse
//! for a headless launch: it reads `fleet_stream_list()` straight from plan.db and never calls the
//! frontend gate at all, gate or no gate.
//!
//! network-monitor is the real incident this was filed from: a director whose plan assigned it
//! Phase-0 commons work it structurally cannot write (`code: write` scoped to `*.md`/`*.json`/
//! `prompts/*`/`discovery/*` only — see `src-tauri/data/personas/director.json`) tried to route the
//! work to the commons lane instead, per the standing protocol (`ROUTE THE COMMONS`,
//! `director-protocol.md`) — and found no such lane, because plan.db never had one.
//!
//! ## What this module does about it
//! Rewiring `fleetStartProject`'s stack derivation is the real fix for the root cause, and is out of
//! scope here (filed separately, see the `bsc request` this branch's change record links). What is in
//! scope and directly unblocks the filed command: give `bsc fleet wake` the ability to CREATE the
//! lane it was asked to wake, when the id it was given is recognizably a lane id and plan.db has no
//! such stream. `wake.rs::resolve_stream` calls in here before falling back to its ordinary silent
//! "unplanned stream" refusal.
//!
//! Deriving the RIGHT stack-specific glob set has no reliable signal at provision time (the same gap
//! that leaves `commonsGlobs` empty upstream — see above), so this grants the full base + every
//! stack's globs unconditionally. A commons lane that can write a manifest it turns out not to need
//! is a mild over-grant; a commons lane that CANNOT write `Cargo.toml` because "rust" wasn't detected
//! is the exact failure that filed this.

use serde_json::{json, Value};

/// Mirrors `COMMONS_STREAM_ID` in `@/features/planner/fleet/commonsGate`.
pub const COMMONS_STREAM_ID: &str = "commons";
/// Mirrors `INTEGRATION_STREAM_ID` in `@/features/planner/fleet/commonsGate`.
pub const INTEGRATION_STREAM_ID: &str = "integration";

/// Mirrors `BASE_COMMONS` in `@/shared/lib/session/commons.ts` — present regardless of stack.
const BASE_COMMONS: &[&str] = &[
    ".gitignore",
    ".gitattributes",
    ".github/workflows/**",
    ".env.example",
    ".editorconfig",
    ".prettierrc",
    ".prettierrc.*",
    "prettier.config.*",
    ".eslintrc",
    ".eslintrc.*",
    "eslint.config.*",
];

/// The union of every `STACK_COMMONS` entry in `commons.ts` — see the module doc for why this is
/// granted unconditionally rather than stack-matched. Also adds `rust-toolchain.toml`/`rust-toolchain`
/// (named in the filing request itself, #132) — a repo-root, stack-specific commons file the TS side
/// never listed either; carry the fix here rather than let a second gap stand next to the one that
/// motivated this module.
const STACK_COMMONS: &[&str] = &[
    // JS/TS
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "tsconfig.json",
    "tsconfig.*.json",
    // Rust
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "rust-toolchain",
    // Python
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "requirements*.txt",
    "poetry.lock",
    "Pipfile",
    "Pipfile.lock",
    // Go
    "go.mod",
    "go.sum",
];

/// The full commons glob set an on-demand-provisioned commons lane owns.
pub fn all_commons_globs() -> Vec<String> {
    BASE_COMMONS.iter().chain(STACK_COMMONS.iter()).map(|s| s.to_string()).collect()
}

/// True when `id` names one of the two lanes — bare, or a per-repo `--<slug>` suffixed one. Mirrors
/// `isLaneStream` in `commonsGate.ts`.
pub fn is_lane_stream(id: &str) -> bool {
    id == COMMONS_STREAM_ID
        || id == INTEGRATION_STREAM_ID
        || id.starts_with("commons--")
        || id.starts_with("integration--")
}

/// Mirrors `laneIdFor`'s slug half in `commonsGate.ts`: lowercase, non-alnum runs collapsed to a
/// single `-`, trimmed at both ends.
fn slug(repo: &str) -> String {
    let mut out = String::with_capacity(repo.len());
    let mut last_dash = false;
    for c in repo.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Which base (`commons` or `integration`) `id` names — `is_lane_stream(id)` must already be true.
fn lane_base(id: &str) -> &'static str {
    if id == COMMONS_STREAM_ID || id.starts_with("commons--") {
        COMMONS_STREAM_ID
    } else {
        INTEGRATION_STREAM_ID
    }
}

/// The companion pair `(commons_id, integration_id)` for a lane id — both lanes are provisioned
/// together (they always launch as a pair, `commonsLanesFor`), so waking either materializes both.
pub fn lane_id_pair(id: &str) -> (String, String) {
    match id.strip_prefix("commons--").or_else(|| id.strip_prefix("integration--")) {
        Some(suffix) => (format!("commons--{suffix}"), format!("integration--{suffix}")),
        None => (COMMONS_STREAM_ID.to_string(), INTEGRATION_STREAM_ID.to_string()),
    }
}

/// Resolve which repo a lane id refers to, from the repos the project's OTHER planned streams
/// already name.
///
/// A single-repo fleet accepts the id AS GIVEN, suffixed or not: the one repo is unambiguously the
/// answer, and a director guessing the multi-repo suffixed form for a single-repo fleet (exactly
/// what happened in #132 — `commons--kevinthelago-networkmonitor` against a fleet with one repo) must
/// not turn into a SECOND failure layered on top of the missing lane. A multi-repo fleet is
/// genuinely ambiguous without a suffix, so there the id must carry one and it must slug-match.
pub fn resolve_lane_repo(id: &str, known_repos: &[String]) -> Result<String, String> {
    let mut repos: Vec<String> = known_repos.iter().map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    repos.sort();
    repos.dedup();
    if repos.is_empty() {
        return Err(
            "no repo is planned for this project yet -- nothing to provision the commons lane \
             against. `bsc plan fleet get` shows what the plan holds."
                .into(),
        );
    }
    if repos.len() == 1 {
        return Ok(repos.remove(0));
    }
    let base = lane_base(id);
    let suffix = id.strip_prefix(&format!("{base}--"));
    let Some(suffix) = suffix else {
        let options: Vec<String> = repos.iter().map(|r| format!("{base}--{}", slug(r))).collect();
        return Err(format!(
            "'{id}' names no repo, and this project plans {} repos -- use one of: {}",
            repos.len(),
            options.join(", ")
        ));
    };
    repos
        .into_iter()
        .find(|r| slug(r) == suffix)
        .ok_or_else(|| format!("'{id}' does not match any repo this project plans -- check the slug against `bsc plan fleet get`"))
}

/// Build the commons + integration stream rows for `repo`, using the caller's own ids — the pane id
/// a director asked to wake becomes the real stream id, no silent rename to a canonical form it
/// didn't request.
pub fn build_lane_rows(commons_id: &str, integration_id: &str, repo: &str) -> (Value, Value) {
    let commons = json!({
        "id": commons_id,
        "name": "Commons",
        "repo": repo,
        "owns": all_commons_globs(),
        "issues": [],
        "dependsOn": [],
    });
    let integration = json!({
        "id": integration_id,
        "name": "Integration",
        "repo": repo,
        "owns": Vec::<String>::new(),
        "issues": [],
        "dependsOn": [commons_id],
    });
    (commons, integration)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_bare_and_suffixed_lane_ids() {
        for id in ["commons", "integration", "commons--own-web", "integration--own-web"] {
            assert!(is_lane_stream(id), "{id} must be recognized as a lane id");
        }
        for id in ["", "commonsx", "xintegration", "domain-model-and-adapter-traits", "director"] {
            assert!(!is_lane_stream(id), "{id} must NOT be recognized as a lane id");
        }
    }

    #[test]
    fn slug_matches_the_ts_laneidfor_convention() {
        // kevinthelago/networkmonitor -> kevinthelago-networkmonitor, the exact id #132 was filed
        // against (`commons--kevinthelago-networkmonitor`).
        assert_eq!(slug("kevinthelago/networkmonitor"), "kevinthelago-networkmonitor");
        assert_eq!(slug("Own/Web-App"), "own-web-app");
        assert_eq!(slug("---weird//repo--"), "weird-repo");
    }

    #[test]
    fn lane_id_pair_derives_the_companion_from_either_half() {
        assert_eq!(lane_id_pair("commons"), ("commons".into(), "integration".into()));
        assert_eq!(lane_id_pair("integration"), ("commons".into(), "integration".into()));
        assert_eq!(
            lane_id_pair("commons--own-web"),
            ("commons--own-web".into(), "integration--own-web".into())
        );
        assert_eq!(
            lane_id_pair("integration--own-web"),
            ("commons--own-web".into(), "integration--own-web".into())
        );
    }

    #[test]
    fn a_single_repo_fleet_resolves_any_id_shape_to_its_one_repo() {
        // The #132 regression exactly: the director guessed the multi-repo suffixed form
        // (`commons--kevinthelago-networkmonitor`) against a fleet with exactly one repo. That must
        // resolve, not compound the missing-lane failure with a second "which repo" failure.
        let repos = vec!["kevinthelago/networkmonitor".to_string()];
        assert_eq!(
            resolve_lane_repo("commons--kevinthelago-networkmonitor", &repos).unwrap(),
            "kevinthelago/networkmonitor"
        );
        assert_eq!(resolve_lane_repo("commons", &repos).unwrap(), "kevinthelago/networkmonitor");
        assert_eq!(resolve_lane_repo("integration", &repos).unwrap(), "kevinthelago/networkmonitor");
    }

    #[test]
    fn a_multi_repo_fleet_requires_a_matching_suffix() {
        let repos = vec!["own/api".to_string(), "own/web".to_string()];
        assert_eq!(resolve_lane_repo("commons--own-web", &repos).unwrap(), "own/web");
        assert_eq!(resolve_lane_repo("integration--own-api", &repos).unwrap(), "own/api");

        let bare_err = resolve_lane_repo("commons", &repos).unwrap_err();
        assert!(bare_err.contains("2 repos"), "names how many repos are ambiguous: {bare_err}");
        assert!(bare_err.contains("commons--own-api"), "lists a usable id: {bare_err}");
        assert!(bare_err.contains("commons--own-web"), "lists the other usable id: {bare_err}");

        let bad_slug_err = resolve_lane_repo("commons--nope", &repos).unwrap_err();
        assert!(bad_slug_err.contains("does not match any repo"));
    }

    #[test]
    fn a_project_with_no_planned_repo_refuses_clearly() {
        let err = resolve_lane_repo("commons", &[]).unwrap_err();
        assert!(err.contains("no repo is planned"));
    }

    #[test]
    fn built_rows_carry_the_requested_ids_and_the_full_commons_set() {
        let (commons, integration) =
            build_lane_rows("commons--kevinthelago-networkmonitor", "integration--kevinthelago-networkmonitor", "kevinthelago/networkmonitor");
        assert_eq!(commons["id"], json!("commons--kevinthelago-networkmonitor"));
        assert_eq!(commons["repo"], json!("kevinthelago/networkmonitor"));
        assert_eq!(commons["dependsOn"], json!(Vec::<String>::new()));
        let owns = commons["owns"].as_array().unwrap();
        // The manifests #132 was filed over, present unconditionally (see module doc).
        for g in [".gitignore", "Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".github/workflows/**"] {
            assert!(owns.iter().any(|v| v == g), "commons must own {g}");
        }

        assert_eq!(integration["id"], json!("integration--kevinthelago-networkmonitor"));
        assert_eq!(integration["owns"], json!(Vec::<String>::new()), "the integration lane owns no source");
        assert_eq!(
            integration["dependsOn"],
            json!(["commons--kevinthelago-networkmonitor"]),
            "integration gates on ITS commons lane"
        );
    }
}
