//! `bsc` — the unified base-studio-code CLI (#1877). One binary; `bsc <command>` dispatches to each
//! state store / tool that used to be its own `bsc-*` sidecar. The shared help scaffold lives in
//! `bsc-cli-util`; each subcommand's logic lives in its owning crate's `cli` module.
//!
//! `bsc help` / `bsc` prints the command overview; `bsc <command> help` drills into one command.

use std::process::ExitCode;


/// How a catalog row should be PRESENTED. Carried as data so a consumer (the `bsc help` overview, a
/// Glance node, a future dispatch table) can render or hide a row without keeping its own list of
/// which commands are deprecated and which are plumbing — a second list being exactly what
/// `epic-command-surfaces-are-nodes` exists to stop minting.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum Status {
    /// A normal, supported surface.
    Active,
    /// A deprecated alias, kept dispatchable because live agent sessions still call it.
    Deprecated,
    /// Real and dispatchable, but not something a person invokes by hand — the desktop or Claude Code
    /// runs it. Listed rather than hidden: `perf` and `serve` were BOTH dispatchable and absent from
    /// `bsc help`, and a surface an agent cannot discover may as well not exist.
    Internal,
}

impl Status {
    /// The wire word, for `bsc surface list --json`.
    const fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Deprecated => "deprecated",
            Status::Internal => "internal",
        }
    }
}

/// One row of the ONE catalog (`command-surface-catalog-is-one-source`).
///
/// It drives the `bsc help` overview AND `bsc surface list`, and
/// [`tests::the_catalog_and_the_dispatch_match_agree`] pins it against the dispatch `match`, so a
/// command can no longer exist in one and not the other.
///
/// Before this, `COMMANDS` was a `(name, summary)` tuple sitting beside an independent `match` with
/// nothing reconciling them — which is how `bsc perf` and `bsc serve` both came to dispatch while
/// appearing nowhere in `bsc help`. The detailed per-command help still comes from each crate's own
/// `CmdDoc` catalog, via `bsc <command> help`.
pub(crate) struct Surface {
    /// The subcommand token, exactly as typed.
    pub name: &'static str,
    /// The one-line overview summary.
    pub summary: &'static str,
    /// The store this surface reads or writes; `None` when it touches none — a probe of the running
    /// app, a pure tool, an internal hook.
    ///
    /// For most rows this is the FIRST machine-readable statement of the store, not a copy of one
    /// held elsewhere. The five `bsc-json-store` crates are the exception: they already state theirs
    /// as `dir_env`/`dir_segment` on their `CliSpec`, so treat those as derivable and keep this text
    /// descriptive rather than authoritative.
    pub store: Option<&'static str>,
    /// How a consumer should present it.
    pub status: Status,
    /// The cargo PACKAGE that serves this surface — the key the Glance surface node is built on
    /// (`epic-command-surfaces-are-nodes`, keyed on the crate as of 2026-09-01).
    ///
    /// Three names are in play and only this one is right to key on. The DIRECTORY differs from the
    /// package for `crates/data` (`bsc-data`) and `crates/llm` (`bsc-llm`), and the LIB TARGET the
    /// dispatch actually writes differs again for `llm` — `"llm" => llm::cli::run`, the one crate in
    /// the workspace where it does. Everything else in the repo refers to a crate by its package
    /// name, so that is what a node is keyed on.
    ///
    /// `bsc` means this crate serves the verb itself, through a local fn or module — `surface`,
    /// `mcp`, `hook`, `serve`, `version`. `version` formats its string with `bsc-cli-util`, but a
    /// library it calls is not the crate that serves it.
    ///
    /// PINNED TO THE DISPATCH BY [`tests::the_catalog_names_the_crate_that_dispatches`], not
    /// maintained independently of it — the same guarantee `name` has. The catalog is a const and
    /// the dispatch is code, so the gate is the mechanism; there is no build step deriving this.
    pub krate: &'static str,
}

const fn active(name: &'static str, krate: &'static str, summary: &'static str, store: Option<&'static str>) -> Surface {
    Surface { name, krate, summary, store, status: Status::Active }
}
const fn deprecated(name: &'static str, krate: &'static str, summary: &'static str, store: Option<&'static str>) -> Surface {
    Surface { name, krate, summary, store, status: Status::Deprecated }
}
const fn internal(name: &'static str, krate: &'static str, summary: &'static str, store: Option<&'static str>) -> Surface {
    Surface { name, krate, summary, store, status: Status::Internal }
}

const COMMANDS: &[Surface] = &[
    active("plan", "plandb", "per-project plan store: issues, features, fleet, sections", Some("plan.db — per-project, $BSC_PLAN_DB")),
    active("publish", "bsc-publish", "push a plan's GitHub structure — repos, board, one issue per plan row", Some("plan.db + GitHub")),
    active("errors", "errordb", "per-project runtime-fault store: fingerprinted errors + alerts", Some("error.db — per-project hub")),
    active("usage", "usagedb", "per-project usage-events store: record + query what users do (epic #3809)", Some("usage.db — per-project hub")),
    active("project", "bsc-project", "cross-project hub: list local projects + the .published marker", Some("the project hub list + the .published marker")),
    active("skill", "skilldb", "global skills + task-groups store", Some("skills.db — global")),
    active("compliance", "compliance", "compliance standards corpus", Some("the packaged compliance corpus")),
    active("atlas", "atlasdb", "product feature inventories: domains · products · capabilities (relational)", Some("atlas.db — global")),
    active("blueprint", "bsc-blueprint", "user blueprint store", Some("blueprints/ — user")),
    active("fin", "bsc-fin", "personal finance: statement ingest + position. LOCAL — reads the files you name and sends nothing anywhere", Some("finance.db — user")),
    active("rf", "bsc-rf", "DEFENSIVE RF monitoring: detect radio jamming from the radio's own telemetry. Read-only — it observes a medium it never transmits on", None),
    active("persona", "bsc-persona", "user persona store: agent identities (prompt + skills + model over a role)", Some("personas/ — user")),
    active("sound", "bsc-sound", "user sound-kit store: synthesized cues (primitives + voices + cues)", Some("sounds/ — user")),
    active("teams", "bsc-teams", "user teams store: persona-relationship graph (positions + relationships)", Some("orgs/ — user; the on-disk dir keeps its pre-rename name")),
    active("network", "bsc-network", "user network store: a DOMAIN owning a set of projects and one architect session", Some("networks/ — user; membership is the `network` column on the project row")),
    active("secret", "bsc-secret", "credential store: which services we are paired with and whether those pairings still work (metadata + derived status; NO verb reads a secret back)", Some("secrets.db — user; the VALUE lives in the OS keychain, not here")),
    active("studio", "bsc-studio", "Studio store: shareable snapshots of the app's library state (save · apply · list · get · remove)", Some("the Studio snapshot store — user")),
    deprecated("org", "bsc-teams", "DEPRECATED (#2700) → use `bsc teams` (the store, renamed org → teams)", Some("orgs/ — the same store `bsc teams` serves")),
    deprecated("component", "bsc-component", "DEPRECATED (#2469) → use `bsc ui` (the component verbs now live there)", Some("the component library — the same store `bsc ui` serves")),
    active("ui", "bsc-ui", "UI design surface: the primitive contract + themes (#1852) + the component library (#2469) + the released-kit store (release, #2465)", Some("the component library + themes + released kits")),
    active("logs", "logs", "unified logs + perf + cost (read-only) + `logs scope` runtime console-scope control", Some("the unified log / perf / cost engine")),
    // #82: this line USED to advertise `read/write/edit/list/info` — four of which have never
    // existed. A designer followed it, ran `bsc files list`, got `unknown command 'list'`, and filed
    // a request for the directory listing that `tree` had been providing all along. An overview that
    // names verbs the CLI lacks is worse than no overview: it is a map to a door that is not there.
    active("files", "bsc-files", "read-only file toolkit: tree (folder structure) · stat · read · refs", None),
    active("shot", "bsc-shot", "capture the RUNNING app's real pixels — a webview snapshot (needs the app running)", None),
    active("navigate", "bsc-navigate", "steer the RUNNING app to a view — so a capture can target something", None),
    active("fleet", "bsc-fleet", "which fleet panes are ACTUALLY alive — real liveness + pid from the running app", None),
    active("sandbox", "bsc-sandbox", "a caged session's rendered launch argv: inspect or replay it outside the app (#135)", Some("the pane's sandbox-stores dir — per-session, cleared with the pane")),
    active("session", "bsc-session", "the app-owned SYSTEM SESSIONS: start · stop · list (designer, librarian, …)", None),
    active("metrics", "logs", "fleet-wide generation scoreboard — $ / tokens / cache-hit / wall-clock per project", Some("the unified log / perf / cost engine")),
    // #command-surface-catalog-is-one-source: `perf` DISPATCHED but was absent from this catalog, so
    // `bsc help` never mentioned it. Same shape as `bsc plan brief` being undiscoverable.
    active("perf", "logs", "the FRONTEND instrumentation — render commits, named phases, jank windows, bsc spawns (read-only)", Some("the frontend instrumentation store")),
    active("mem", "bsc-mem", "the MEMORY + COST surface — app heap, build time and build memory (read-only)", Some("the project run store + the browser harness")),
    active("work", "bsc-work", "the work loop: run the gate and RECORD what it actually did on the change record", Some("the per-project plan store — the change record's gate evidence + the known-red declarations")),
    active("self", "bsc-self", "this binary and its siblings: is the `bsc` you are about to run trustworthy, and which one would be used", None),
    active("resolve", "bsc-resolve", "what a session RECEIVES: its resolved skills and MCP servers (read-only)", Some("skills.db + the packaged mcp/builtin-servers.json")),
    active("disk", "bsc-disk", "reclaim build-tree disk: gc, prune, sweep, and dedupe across worktrees", Some("target/ - per-checkout build output")),
    active("worktree", "bsc-disk", "the worktree pool: list every tree, cap the parked/merged ones (DESTRUCTIVE)", Some("the checkout's git worktree list")),
    active("debug", "bsc-debug", "inspect the RUNNING app's live DOM + preview state (read-only)", None),
    active("llm", "bsc-llm", "the LOCAL model runtime: what slot count and context ollama actually GRANTED, vs what was asked", None),
    active("loop", "bsc-loop", "conversation loop store: two participants exchange turns until a signal ends it, or never (#3262)", Some("the conversation-loop store — user")),
    active("request", "bsc-request", "improvement-request store: the designer→debug channel for bsc ui surface gaps (#3295)", Some("the improvement-request store — user")),
    active("runtime", "bsc-runtime", "runtime attestations: which RECORD actually served each module while the app ran", Some("the runtime-attestation store")),
    active("graph", "bsc-graph", "algorithms knowledge library: per-language implementations (impl list · dump · harvest · curate)", Some("knowledge/algorithms.json — packaged seed + writable store, $BSC_GRAPH_STORE")),
    active("cad", "bsc-cad", "mesh/SDF geometry kernel (mm): mesh an op-tree spec into a binary STL", None),
    active("widget", "bsc-widget", "toggleable UI surfaces: one NODE per widget and the stream it subscribes to", Some("a closed set in code — an id selects a node, never a path")),
    active("ear", "bsc-ear", "always-on local capture: speech-only segments inside an enforced retention window (the listening half of `say`)", Some("audio + state under ~/.base-studio-code/ear")),
    active("say", "bsc-say", "speak text aloud: kokoro (neural, phoneme-level) when installed, then piper, then the OS voice (NOT `sound`, which is the synthesis kit store)", Some("no store — voices in ~/.base-studio-code/voices and models/kokoro")),
    active("lan", "bsc-lan", "the emit-only LAN sensor: what a host exposes · its keys · what it would send (NOT `network`, which is the user domain store)", Some("no store yet — keys are printed, never written")),
    active("deploy", "bsc-deploy", "ship a binary to a device and take it back: status · push · rollback (push-only; LAB has no egress)", Some("the device roster — deploy/devices.json")),
    active("capability", "bsc-capability", "the USE layer: what a network can DO right now, and how fresh each answer is", Some("derived — reads `bsc project network` + `bsc deploy`")),
    active("data", "bsc-data", "canonical data model (DuckDB): model · scan · tables · connector", Some("the canonical data model — DuckDB")),
    active("security", "bsc-security", "the security surface: scan a repo for vulnerable dependencies AND leaked credentials (tree + git history), as one ranked finding list", Some("the OSV.dev advisory cache")),
    deprecated("cve", "bsc-security", "→ `bsc security deps`. The vulnerability half of the security surface; kept because its exit-code contract gates CI and the install hook", Some("the OSV.dev advisory cache")),
    active("news", "bsc-news", "low-trust news layer: poll outlets · brief an event (corroboration · framing · agency deletion). NOT `research` — an article is a claim, a paper is a source", Some("the news store — every fetched article version, $BSC_NEWS_DB")),
    active("surface", "bsc", "THIS catalog: every bsc command surface as data (list · --json) — one source for help, the node set and drift checks", Some("the command-surface catalog, compiled into this binary")),
    active("mcp", "bsc", "MCP: the server store (`server`) + the bundled stdio servers (research/compliance/cve)", None),
    internal("hook", "bsc", "internal PreToolUse deny hooks (run by Claude Code, not by hand)", None),
    // #command-surface-catalog-is-one-source: `serve` (#4152) dispatched but was likewise absent.
    internal("serve", "bsc", "internal WARM server (#4152) — one long-lived process answering many requests; the desktop spawns it", None),
    active("version", "bsc", "which build this binary IS — its build time + path (#92, tells a stale sidecar from a missing verb)", None),
    active("config", "bsc-config", "runtime config-seed mirror: classify a diverged file against the packaged seed, with a diff, and adopt it (#168)", Some("~/.base-studio-code/config/ — the runtime config-seed mirror")),
    active("github", "bsc-github", "GitHub rules a session can ask about: issue provenance, REST path routing, board shape (read-only)", Some("no store - derived rules over a GitHub payload; it never reads a credential back")),
    active("perms", "bsc-perms", "what a session role actually resolves to: capability, denies, tool rules, write scope (read-only)", Some("the frozen role-capability baseline + the packaged permission data")),
    active("app", "bsc-app", "the APP's own lifecycle: status, promote (develop -> main at the root), rebuild, release, hooks", Some("the repo root's git refs + the built app binary")),
];

fn top_help() -> String {
    let mut s = String::from(
        "bsc — the base-studio-code CLI (#1877)\n\n\
         USAGE:\n  \
         bsc <command> [args]\n  \
         bsc help              # this overview\n  \
         bsc <command> help    # detail for one command\n\n\
         COMMANDS:\n",
    );
    let w = COMMANDS.iter().map(|c| c.name.len()).max().unwrap_or(0);
    for c in COMMANDS {
        let name = c.name;
        s.push_str(&format!("  {name:<w$}  {}\n", c.summary));
    }
    s
}

/// `bsc surface` — the catalog as DATA (`command-surface-catalog-is-one-source`).
///
/// The point is not the table; it is that a CONSUMER can generate from this instead of restating it.
/// `command-surfaces-are-glance-nodes` builds one Glance node per row from `--json`, and a
/// hand-maintained node list would have been the fourth copy of the surface set to drift.
///
/// Output goes through [`bsc_cli_util::print_raw`] rather than `println!` so it stays capture-safe —
/// the warm server (`serve.rs`) answers a request by capturing the verb's output, and a verb writing
/// to stdout by another route would corrupt the protocol stream.
/// A SURFACE's own verb catalog, by the noun `bsc` dispatches — POINTERS, never a restatement.
///
/// **KEYED ON THE NOUN, NOT THE CRATE, and that distinction is load-bearing.** The first version of
/// this keyed on the package and was WRONG for every crate serving more than one noun: `logs` serves
/// `logs`, `perf` and `metrics` from three different `run` fns, so keying on the package made all
/// three project `logs::cli::COMMANDS` — `bsc surface verbs metrics` advertised fourteen verbs that
/// `bsc metrics` cannot run. That is the precise failure this epic exists to end, since help is what
/// an agent reads to decide what it may call. The rule that holds: the catalog is the `COMMANDS`
/// beside the `run` the dispatch arm names, which is why `perf` reaches into `logs::instrument`.
///
/// `metrics` is deliberately absent. It is `bsc metrics <project>` — a project argument, not a verb —
/// so it HAS no catalog, and reporting none is the honest answer rather than borrowing a sibling's.
///
/// What this table can still drift on is coverage: a crate that gains a catalog is not added here
/// automatically, so the snapshot test pins the set and must be updated deliberately.
fn surface_verbs(noun: &str) -> Option<&'static [bsc_cli_util::CmdDoc]> {
    Some(match noun {
        "plan" => plandb::cli::COMMANDS,
        "logs" => logs::cli::COMMANDS,
        "perf" => logs::instrument::COMMANDS,
        "ui" => bsc_ui::cli::COMMANDS,
        "fleet" => bsc_fleet::cli::COMMANDS,
        "mem" => bsc_mem::cli::COMMANDS,
        "persona" => bsc_persona::cli::COMMANDS,
        "request" => bsc_request::cli::COMMANDS,
        "secret" => bsc_secret::cli::COMMANDS,
        "config" => bsc_config::cli::COMMANDS,
        "work" => bsc_work::cli::COMMANDS,
        "cad" => bsc_cad::cli::COMMANDS,
        "widget" => bsc_widget::cli::COMMANDS,
        "say" => bsc_say::cli::COMMANDS,
        "ear" => bsc_ear::cli::COMMANDS,
        "lan" => bsc_lan::cli::COMMANDS,
        "deploy" => bsc_deploy::cli::COMMANDS,
        "capability" => bsc_capability::cli::COMMANDS,
        // Gated exactly like the dispatch arm below. Without this, `--no-default-features` — the lean,
        // DuckDB-free build #1877 documents and every cross-compiled device build needs — fails to
        // compile on an unresolved `bsc_data`. The feature existed; this arm was simply never gated.
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::COMMANDS,
        "compliance" => compliance::cli::COMMANDS,
        "cve" => bsc_security::cli::COMMANDS,
        "security" => bsc_security::security_cli::COMMANDS,
        "news" => bsc_news::cli::COMMANDS,
        // The RECORD-backed CLIs (`every-record-cli-projects-its-catalog`). Their `cli.rs` compiles from
        // the graph store rather than a file on disk, which is why they were absent here: the catalogs
        // existed all along and were merely private. 19 of 20 needed nothing but `pub`.
        "blueprint" => bsc_blueprint::cli::COMMANDS,
        "fin" => bsc_fin::cli::COMMANDS,
        "rf" => bsc_rf::cli::COMMANDS,
        "debug" => bsc_debug::cli::COMMANDS,
        "files" => bsc_files::cli::COMMANDS,
        "loop" => bsc_loop::cli::COMMANDS,
        "navigate" => bsc_navigate::cli::COMMANDS,
        "network" => bsc_network::cli::COMMANDS,
        "project" => bsc_project::cli::COMMANDS,
        "publish" => bsc_publish::cli::COMMANDS,
        "runtime" => bsc_runtime::cli::COMMANDS,
        "sandbox" => bsc_sandbox::cli::COMMANDS,
        "session" => bsc_session::cli::COMMANDS,
        "shot" => bsc_shot::cli::COMMANDS,
        "sound" => bsc_sound::cli::COMMANDS,
        "studio" => bsc_studio::cli::COMMANDS,
        // `org` is a DEPRECATED ALIAS of `teams` and shares its catalog on purpose — the one case where
        // two surfaces advertising the same verb list is correct, and the reason
        // `two_active_surfaces_never_advertise_the_same_verb_list` exempts deprecated ones.
        "teams" | "org" => bsc_teams::cli::COMMANDS,
        "errors" => errordb::cli::COMMANDS,
        "skill" => skilldb::cli::COMMANDS,
        "usage" => usagedb::cli::COMMANDS,
        // CATALOG-BY-FUNCTION. These crates expose `pub fn command_docs()` rather than a const — already
        // public, so they were reachable all along and simply had no arm. `bsc-disk` serves TWO nouns and
        // already keeps a catalog PER NOUN (`disk_command_docs` / `worktree_command_docs`), which is the
        // shape `logs` did not have and had to be re-keyed for.
        "app" => bsc_app::cli::command_docs(),
        "component" => bsc_component::cli::command_docs(),
        "github" => bsc_github::cli::command_docs(),
        "perms" => bsc_perms::cli::command_docs(),
        "resolve" => bsc_resolve::cli::command_docs(),
        "self" => bsc_self::cli::command_docs(),
        "disk" => bsc_disk::cli::disk_command_docs(),
        "worktree" => bsc_disk::cli::worktree_command_docs(),
        _ => return None,
    })
}

/// One surface node's whole drill, as pure data over a roster — so the projection is testable without
/// a workspace on disk, which is the only way its edge cases get guards.
///
/// DEPENDENTS ARE INVERTED HERE, once, from the roster the caller already read. That is the fact a
/// surface node exists to show and the one `bsc surface crates` cannot give without the consumer
/// pulling all 54 rows: `bsc-util` exposes no verb and reaches 40 crates.
///
/// An unknown crate is an ERROR, never an empty document. A drill that renders nothing looks exactly
/// like a crate with no surface, and the two mean opposite things.
fn drill_doc(rows: &[CrateRow], want: &str) -> Result<serde_json::Value, String> {
    let row = rows
        .iter()
        .find(|r| r.package == want)
        .ok_or_else(|| format!("no workspace crate named '{want}' — `bsc surface crates` lists all of them"))?;

    let dependents: Vec<&str> = rows
        .iter()
        .filter(|r| r.package != row.package && r.depends_on.iter().any(|d| d == &row.package))
        .map(|r| r.package.as_str())
        .collect();

    // Grouped by NOUN, because a crate can serve several and they are different surfaces with
    // different catalogs — flattening them rebuilds the bug `surface_verbs` was re-keyed to fix.
    let nouns: Vec<serde_json::Value> = COMMANDS
        .iter()
        .filter(|c| c.krate == row.package)
        .map(|c| match surface_verbs(c.name) {
            Some(docs) => serde_json::json!({
                "noun": c.name, "status": c.status.as_str(), "catalog": "projected",
                "verbs": docs.iter().map(|d| serde_json::json!({
                    "verb": d.name, "summary": d.summary, "usage": d.usage,
                })).collect::<Vec<_>>(),
            }),
            None => serde_json::json!({
                "noun": c.name, "status": c.status.as_str(), "catalog": "unreachable",
                "verbs": serde_json::Value::Null,
            }),
        })
        .collect();

    Ok(serde_json::json!({
        "crate": row.package,
        "path": row.path,
        "surface": !nouns.is_empty(),
        "nouns": nouns,
        "dependsOn": row.depends_on,
        "dependents": dependents,
        "dependentCount": dependents.len(),
    }))
}

fn surface_cli(rest: Vec<String>) -> Result<(), String> {
    let verb = rest.first().map(String::as_str).unwrap_or("list");
    match verb {
        // `bsc surface verbs [<crate>] [--json]` — the SECOND LEVEL of the catalog.
        //
        // `list` answers "what surfaces exist"; this answers "what can this one DO", which is what a
        // Glance surface node drills into. Every row is PROJECTED from the crate's own `CmdDoc` catalog
        // — the same const its `--help` prints — so a verb cannot appear here and be missing from help,
        // which is the drift `command-surface-catalog-is-one-source` exists to end.
        //
        // A crate with no reachable catalog reports NONE, never an empty list. That distinction is the
        // honesty of the number: a zero meaning "we could not look" would read as "this surface has no
        // verbs".
        "verbs" => {
            let want = rest.iter().skip(1).find(|a| !a.starts_with("--")).cloned();
            let rows: Vec<serde_json::Value> = COMMANDS
                .iter()
                .filter(|c| match want.as_deref() { Some(w) => w == c.name || w == c.krate, None => true })
                .map(|c| match surface_verbs(c.name) {
                    Some(docs) => serde_json::json!({
                        "name": c.name, "crate": c.krate, "catalog": "projected",
                        "verbs": docs.iter().map(|d| serde_json::json!({
                            "verb": d.name, "summary": d.summary,
                        })).collect::<Vec<_>>(),
                    }),
                    None => serde_json::json!({
                        "name": c.name, "crate": c.krate, "catalog": "unreachable", "verbs": serde_json::Value::Null,
                    }),
                })
                .collect();
            if rest.iter().any(|a| a == "--json") {
                let json = serde_json::to_string_pretty(&rows)
                    .map_err(|e| format!("could not render the verb catalog: {e}"))?;
                bsc_cli_util::print_raw(&json);
            } else {
                let mut out = String::new();
                for r in &rows {
                    let name = r["name"].as_str().unwrap_or("?");
                    match r["verbs"].as_array() {
                        Some(vs) => {
                            out.push_str(&format!("{name}  ({} verbs)\n", vs.len()));
                            let w = vs.iter().map(|v| v["verb"].as_str().unwrap_or("").len()).max().unwrap_or(0);
                            for v in vs {
                                let vn = v["verb"].as_str().unwrap_or("");
                                out.push_str(&format!("  {vn:<w$}  {}\n", v["summary"].as_str().unwrap_or("")));
                            }
                        }
                        None => out.push_str(&format!("{name}  (catalog not reachable from here)\n")),
                    }
                }
                bsc_cli_util::print_raw(out.trim_end());
            }
            Ok(())
        }
        "list" => {
            if rest.iter().any(|a| a == "--json") {
                let rows: Vec<serde_json::Value> = COMMANDS
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "name": c.name,
                            "crate": c.krate,
                            "summary": c.summary,
                            "store": c.store,
                            "status": c.status.as_str(),
                        })
                    })
                    .collect();
                let json = serde_json::to_string_pretty(&rows)
                    .map_err(|e| format!("could not render the surface catalog: {e}"))?;
                bsc_cli_util::print_raw(&json);
            } else {
                let w = COMMANDS.iter().map(|c| c.name.len()).max().unwrap_or(0);
                let mut s = String::new();
                for c in COMMANDS {
                    let name = c.name;
                    let store = c.store.unwrap_or("—");
                    s.push_str(&format!("{name:<w$}  {:<10}  {store}\n", c.status.as_str()));
                }
                bsc_cli_util::print_raw(s.trim_end());
            }
            Ok(())
        }
        // `bsc surface drill <crate> [--json]` — EVERYTHING the Glance second layer renders, in ONE
        // call. `list` says what surfaces exist, `verbs` says what one can do; this answers both for a
        // single node, plus the two facts a node's drill needs that neither of those carries.
        //
        // BATCHED BY CONSTRUCTION. The roster is read once and inverted here. A caller that wanted
        // DEPENDENTS from `crates --json` would have to pull all 54 rows and invert them itself to draw
        // one node — and dependents are the whole point of a surface node: `bsc-util` exposes no verb
        // at all while its change reaches most of the workspace, which is precisely why it has a node.
        //
        // NOUNS, NOT ONE FLAT VERB LIST. A crate can serve several surfaces — `logs` serves `logs`,
        // `perf` and `metrics` from three different `run` fns — and flattening them would reassemble
        // the very bug `surface_verbs` was re-keyed to fix.
        //
        // It returns DOMAIN data, never graph nodes: minting `surface:<crate>` and `depends-on` ids
        // stays in `glanceGraph.ts`, which owns that grammar. A second id vocabulary in Rust is the
        // drift this epic exists to end.
        "drill" => {
            let root_flag = rest.iter().position(|a| a == "--root").and_then(|i| rest.get(i + 1)).cloned();
            let root = roster_root(root_flag.as_deref())?;
            let want = rest
                .iter()
                .skip(1)
                .find(|a| !a.starts_with("--") && Some(a.as_str()) != root_flag.as_deref())
                .ok_or_else(|| "name the crate to drill into: bsc surface drill <crate>".to_string())?
                .clone();
            let rows = crate_roster(&root)?;
            let doc = drill_doc(&rows, &want)?;

            if rest.iter().any(|a| a == "--json") {
                let json = serde_json::to_string_pretty(&doc)
                    .map_err(|e| format!("could not render the drill: {e}"))?;
                bsc_cli_util::print_raw(&json);
            } else {
                let mut s = String::new();
                s.push_str(&format!(
                    "{}  ({})\n",
                    doc["crate"].as_str().unwrap_or("?"),
                    doc["path"].as_str().unwrap_or("?")
                ));
                s.push_str(&format!(
                    "  reaches {} crate(s) · depends on {}\n",
                    doc["dependentCount"].as_u64().unwrap_or(0),
                    doc["dependsOn"].as_array().map(|a| a.len()).unwrap_or(0)
                ));
                let nouns = doc["nouns"].as_array().cloned().unwrap_or_default();
                if nouns.is_empty() {
                    s.push_str("  no bsc surface — a library crate\n");
                }
                for n in &nouns {
                    let noun = n["noun"].as_str().unwrap_or("?");
                    let dep = if n["status"] == "deprecated" { "  (deprecated)" } else { "" };
                    match n["verbs"].as_array() {
                        Some(vs) => {
                            s.push_str(&format!("\n  bsc {noun}{dep}  ({} verbs)\n", vs.len()));
                            let w = vs.iter().map(|v| v["verb"].as_str().unwrap_or("").len()).max().unwrap_or(0);
                            for v in vs {
                                s.push_str(&format!(
                                    "    {:<w$}  {}\n",
                                    v["verb"].as_str().unwrap_or("?"),
                                    v["summary"].as_str().unwrap_or("")
                                ));
                            }
                        }
                        None => s.push_str(&format!("\n  bsc {noun}{dep}  (catalog not reachable from here)\n")),
                    }
                }
                bsc_cli_util::print_raw(s.trim_end());
            }
            Ok(())
        }
        "crates" => {
            let root_flag = rest.iter().position(|a| a == "--root").and_then(|i| rest.get(i + 1));
            let root = roster_root(root_flag.map(String::as_str))?;
            let rows = crate_roster(&root)?;
            if rest.iter().any(|a| a == "--json") {
                let json: Vec<serde_json::Value> = rows
                    .iter()
                    .map(|r| {
                        serde_json::json!({
                            "crate": r.package,
                            "path": r.path,
                            "surface": !r.verbs.is_empty(),
                            "verbs": r.verbs,
                            "dependsOn": r.depends_on,
                        })
                    })
                    .collect();
                let out = serde_json::to_string_pretty(&json)
                    .map_err(|e| format!("could not render the crate roster: {e}"))?;
                bsc_cli_util::print_raw(&out);
            } else {
                let w = rows.iter().map(|r| r.package.len()).max().unwrap_or(0);
                let mut s = String::new();
                for r in &rows {
                    let verbs = if r.verbs.is_empty() { "—".to_string() } else { r.verbs.join(" ") };
                    s.push_str(&format!("{:<w$}  {:>2} dep  {verbs}\n", r.package, r.depends_on.len()));
                }
                bsc_cli_util::print_raw(s.trim_end());
            }
            Ok(())
        }
        "help" | "-h" | "--help" => {
            bsc_cli_util::print_raw(surface_help().trim_end());
            Ok(())
        }
        other => Err(format!("unknown command '{other}'\n\n{}", surface_help())),
    }
}

/// One workspace member, as the surface node set reads it (`epic-command-surfaces-are-nodes`).
///
/// The NODE is keyed on `package`. `verbs` is the join to the catalog and is empty for the crates
/// that expose none — which is the point of the crate-keyed decision: `bsc-util` has no verb and is
/// the crate whose change rebuilds most of the workspace, so it is exactly the one that needs an
/// owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CrateRow {
    /// The cargo package name — the node key. See [`Surface::krate`] for why this and not the
    /// directory or the lib target.
    pub package: String,
    /// The workspace member path, as the root `Cargo.toml` lists it.
    pub path: String,
    /// The catalog verbs this crate serves, in catalog order. Empty for a crate with no surface.
    pub verbs: Vec<&'static str>,
    /// Its INTERNAL dependencies — other workspace packages only, external crates excluded.
    pub depends_on: Vec<String>,
}

/// The repo root to read the workspace from: `--root`, else `$BSC_REPO_ROOT`, else the cwd.
///
/// A staged binary outside the repo has no workspace to read, and must SAY so rather than report an
/// empty roster — an empty list that looks like an answer is the failure this repo keeps hitting.
fn roster_root(explicit: Option<&str>) -> Result<std::path::PathBuf, String> {
    let start = explicit
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var("BSC_REPO_ROOT").ok().filter(|v| !v.is_empty()).map(Into::into))
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    // WALK UP, the way cargo itself does. An explicit `--root` or `$BSC_REPO_ROOT` still wins, and a
    // caller standing AT the root is unaffected — this only rescues the case that used to be a flat
    // error: being somewhere inside the workspace.
    //
    // That case is not hypothetical, it is the DESKTOP APP. `bsc` is spawned by `bsc_blocking` with no
    // `current_dir` and no `BSC_REPO_ROOT` (which is wired for PTY sessions only), so it inherits the
    // app's cwd — and `tauri dev` runs from `src-tauri/`, one level in. Measured before this change:
    // the roster read 60 crates from the repo root and FAILED from `src-tauri/`, so the Glance surface
    // band would have been empty on every launch while every test stayed green.
    find_workspace_root(&start, explicit.is_some())
}

/// The upward search, split out so it is testable WITHOUT touching the process cwd.
///
/// Taking the start directory as an argument rather than reading `.` is the whole point: a test that
/// had to `set_current_dir` would be a process-global mutation, and nextest's one-process-per-test
/// makes that pass on the gate while racing under `cargo test` — the exact asymmetry this repo has
/// been bitten by before.
fn find_workspace_root(start: &std::path::Path, explicit: bool) -> Result<std::path::PathBuf, String> {
    let mut dir = start
        .canonicalize()
        .map_err(|e| format!("cannot resolve {}: {e}", start.display()))?;
    loop {
        let manifest = dir.join("Cargo.toml");
        if let Ok(txt) = std::fs::read_to_string(&manifest) {
            if txt.contains("[workspace]") {
                return Ok(dir);
            }
        }
        // An explicit root is taken at its word: if the caller NAMED a directory, silently using its
        // parent would answer a question they did not ask.
        if explicit {
            // BOTH original messages are preserved, and the distinction matters: "cannot read" needs
            // to say how to fix it (`--root` / `$BSC_REPO_ROOT`), while "not a workspace" needs to name
            // what is missing. A pre-existing test asserts each, and collapsing them into one string
            // is what this branch got wrong the first time.
            let manifest = dir.join("Cargo.toml");
            return Err(match std::fs::read_to_string(&manifest) {
                Err(e) => format!(
                    "cannot read {}: {e}\n\npass --root <repo> or set $BSC_REPO_ROOT",
                    manifest.display()
                ),
                Ok(_) => format!("{} is not the workspace root (no [workspace])", manifest.display()),
            });
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => {
                return Err(format!(
                    "no Cargo.toml with [workspace] at or above {}\n\npass --root <repo> or set $BSC_REPO_ROOT",
                    start.display()
                ))
            }
        }
    }
}

/// The workspace member paths, from the root `Cargo.toml`'s explicit `members` list.
///
/// FROM THE MEMBERS LIST, NEVER A DIRECTORY LISTING. The two disagree in both directions: `src-tauri`
/// is a member and is not under `crates/` at all, so a listing of `crates/` drops the app; and a
/// directory under `crates/` need not be a package. `crates/graph-materialize` was the standing
/// witness for the second half — a directory holding only the shared `build.rs` other crates pull in
/// via `build = "../graph-materialize/build.rs"` — until
/// `graph-materialize-becomes-a-real-build-dependency` gave it a manifest and a `src/lib.rs` so a
/// crate at another depth could CALL it. It is a member now, and `src-tauri` carries the invariant.
fn workspace_members(root: &std::path::Path) -> Result<Vec<String>, String> {
    let txt = std::fs::read_to_string(root.join("Cargo.toml")).map_err(|e| e.to_string())?;
    let start = txt.find("members").ok_or("the workspace has no `members` list")?;
    let open = txt[start..].find('[').ok_or("malformed `members`")? + start;
    let close = txt[open..].find(']').ok_or("unterminated `members`")? + open;
    let mut out = Vec::new();
    let mut rest = &txt[open..close];
    while let Some(q) = rest.find('"') {
        let after = &rest[q + 1..];
        let Some(e) = after.find('"') else { break };
        out.push(after[..e].to_string());
        rest = &after[e + 1..];
    }
    if out.len() < 20 {
        return Err(format!("the workspace member scan found only {} entries — the scan is broken", out.len()));
    }
    Ok(out)
}

/// `name = "..."` from a manifest's `[package]` section.
fn package_name(manifest: &str) -> Option<String> {
    let pkg = manifest.find("[package]")?;
    let tail = &manifest[pkg..];
    let end = tail[1..].find("\n[").map(|i| i + 1).unwrap_or(tail.len());
    tail[..end].lines().find_map(|l| {
        let t = l.trim();
        t.strip_prefix("name")?.trim_start().strip_prefix('=')?.trim().strip_prefix('"')?.strip_suffix('"').map(str::to_string)
    })
}

/// Every workspace member with its verbs and its internal dependencies.
///
/// Dependencies are read as PATH deps whose key is another workspace package; an external crate has
/// no path and is skipped. Dev- and build-dependencies count, deliberately: cargo rebuilds a test
/// target when they move, so they are part of "what does touching this crate reach".
pub(crate) fn crate_roster(root: &std::path::Path) -> Result<Vec<CrateRow>, String> {
    let members = workspace_members(root)?;
    let mut manifests = Vec::new();
    for m in &members {
        let path = root.join(m).join("Cargo.toml");
        let txt = std::fs::read_to_string(&path)
            .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
        let pkg = package_name(&txt)
            .ok_or_else(|| format!("{} has no [package] name", path.display()))?;
        manifests.push((m.clone(), pkg, txt));
    }
    let known: std::collections::HashSet<&str> = manifests.iter().map(|(_, p, _)| p.as_str()).collect();

    let mut rows = Vec::new();
    for (path, package, txt) in &manifests {
        let mut depends_on: Vec<String> = Vec::new();
        for line in txt.lines() {
            let t = line.trim();
            if !t.contains("path") || t.starts_with('#') {
                continue;
            }
            let Some(eq) = t.find('=') else { continue };
            let key = t[..eq].trim().trim_matches('"');
            if key.is_empty() || !key.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '_') {
                continue;
            }
            if known.contains(key) && key != package && !depends_on.iter().any(|d| d == key) {
                depends_on.push(key.to_string());
            }
        }
        depends_on.sort();
        let verbs: Vec<&'static str> =
            COMMANDS.iter().filter(|c| c.krate == package).map(|c| c.name).collect();
        rows.push(CrateRow { package: package.clone(), path: path.clone(), verbs, depends_on });
    }
    rows.sort_by(|a, b| a.package.cmp(&b.package));
    Ok(rows)
}

fn surface_help() -> String {
    String::from(
        "bsc surface — every bsc command surface, as data\n\n\
         USAGE:\n  \
         bsc surface list           # name · status · the store it touches\n  \
         bsc surface list --json    # the catalog as JSON — GENERATE from this, do not restate it\n  \
         bsc surface crates         # every workspace member: its verbs + its internal deps\n  \
         bsc surface crates --json [--root <repo>]   # the crate-keyed node set\n  \
         bsc surface verbs [<noun>]  # the SECOND level: what ONE surface can DO\n  \
         bsc surface drill <crate>   # one node's whole drill: nouns, verbs, and what it reaches\n\n\
         One catalog drives `bsc help`, this command, and the drift test that pins both against the\n\
         dispatch match. `status` is active | deprecated | internal.\n\n\
         Roles are deliberately NOT here: the real role-to-surface data is `restricted_allow`, which\n\
         lives in the desktop app crate this binary cannot depend on. Join it at the consumer.\n",
    )
}


pub(crate) fn dispatch(cmd: &str, rest: Vec<String>) -> Result<(), String> {
    match cmd {
        "plan" => plandb::cli::run(rest, "bsc plan"),
        "publish" => bsc_publish::cli::run(rest, "bsc publish"),
        "errors" => errordb::cli::run(rest, "bsc errors"),
        "usage" => usagedb::cli::run(rest, "bsc usage"),
        "project" => bsc_project::cli::run(rest, "bsc project"),
        "skill" => skilldb::cli::run(rest, "bsc skill"),
        "compliance" => compliance::cli::run(rest, "bsc compliance"),
        "blueprint" => bsc_blueprint::cli::run(rest, "bsc blueprint"),
        "fin" => bsc_fin::cli::run(rest, "bsc fin"),
        "rf" => bsc_rf::cli::run(rest, "bsc rf"),
        "persona" => bsc_persona::cli::run(rest, "bsc persona"),
        // The CREDENTIAL store: what services we are paired with and whether those pairings still
        // work. The secret VALUE is not in it — that stays in the OS keychain, and no verb here can
        // read one back, so a live session can see WHICH credentials exist without extracting any.
        "secret" => bsc_secret::cli::run(rest, "bsc secret"),
        // The RELATIONAL corpus store — product feature inventories. Distinct from `bsc data`, which
        // is per-project and whose rows come from connectors scanning a live system.
        "atlas" => atlasdb::cli::run(rest, "bsc atlas"),
        "sound" => bsc_sound::cli::run(rest, "bsc sound"),
        "teams" => bsc_teams::cli::run(rest, "bsc teams"),
        // A NETWORK is a domain: a named set of projects sharing one concern, and the owner of exactly
        // one architect session. This store holds the entity only — a project's membership is the
        // `network` column on its project row (`bsc project network set`), the same seam `architect`
        // uses, so a network never has to keep a member list in sync.
        "network" => bsc_network::cli::run(rest, "bsc network"),
        "studio" => bsc_studio::cli::run(rest, "bsc studio"),
        // Deprecated alias (#2700, the #2469 `bsc component` → `bsc ui` pattern): `bsc org` still routes
        // to the SAME teams store handler — live agent sessions call it, so it must keep working. The
        // pointer goes to STDERR so stdout stays clean JSON for pipes.
        "org" => {
            eprintln!("`bsc org` is deprecated; use `bsc teams`");
            bsc_teams::cli::run(rest, "bsc org")
        }
        // Deprecated alias (#2469, the #1721 `bsc plan integration` pattern): the component verbs
        // moved under `bsc ui`. Same behavior via the same delegate; the pointer goes to STDERR so
        // stdout stays clean JSON for pipes.
        "component" => {
            eprintln!("`bsc component` is deprecated; use `bsc ui`");
            bsc_component::cli::run(rest, "bsc component")
        }
        // #4152: the WARM server - one process, many requests over line-delimited JSON.
        "serve" => serve::run(),
        "ui" => bsc_ui::cli::run(rest, "bsc ui"),
        "logs" => logs::cli::run(rest, "bsc logs"),
        // The FRONTEND instrumentation reader — distinct from `bsc logs perf` (perf.db process samples).
        "perf" => logs::instrument::run(rest, "bsc perf"),
        // The MEMORY half of the same question `perf` answers for computation — app heap, build time
        // and build memory. Read-only, so no role needs a grant to reach it.
        "mem" => bsc_mem::cli::run(rest, "bsc mem"),
        "work" => bsc_work::cli::run(rest, "bsc work"),
        "self" => bsc_self::cli::run(rest, "bsc self"),
        "github" => bsc_github::cli::run(rest, "bsc github"),
        "resolve" => bsc_resolve::cli::run(rest, "bsc resolve"),
        "disk" => bsc_disk::cli::run_disk(rest, "bsc disk"),
        "worktree" => bsc_disk::cli::run_worktree(rest, "bsc worktree"),
        "metrics" => logs::metrics::run(rest, "bsc metrics"),
        "files" => bsc_files::cli::run(rest, "bsc files"),
        "shot" => bsc_shot::cli::run(rest, "bsc shot"),
        "navigate" => bsc_navigate::cli::run(rest, "bsc navigate"),
        "fleet" => bsc_fleet::cli::run(rest, "bsc fleet"),
        "sandbox" => bsc_sandbox::cli::run(rest, "bsc sandbox"),
        "session" => bsc_session::cli::run(rest, "bsc session"),
        "debug" => bsc_debug::cli::run(rest, "bsc debug"),
        "loop" => bsc_loop::cli::run(rest, "bsc loop"),
        "request" => bsc_request::cli::run(rest, "bsc request"),
        "runtime" => bsc_runtime::cli::run(rest, "bsc runtime"),
        "llm" => llm::cli::run(rest, "bsc llm"),
        "graph" => bsc_graph::cli::run(rest, "bsc graph"),
        "cad" => bsc_cad::cli::run(rest, "bsc cad"),
        "widget" => bsc_widget::cli::run(rest, "bsc widget"),
        "say" => bsc_say::cli::run(rest, "bsc say"),
        "ear" => bsc_ear::cli::run(rest, "bsc ear"),
        "lan" => bsc_lan::cli::run(rest, "bsc lan"),
        "deploy" => bsc_deploy::cli::run(rest, "bsc deploy"),
        "capability" => bsc_capability::cli::run(rest, "bsc capability"),
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::run(rest, "bsc data"),
        "cve" => bsc_security::cli::run(rest, "bsc cve"),
        "security" => bsc_security::security_cli::run(rest, "bsc security"),
        "news" => bsc_news::cli::run(rest, "bsc news"),
        "config" => bsc_config::cli::run(rest, "bsc config"),
        "perms" => bsc_perms::cli::run(rest, "bsc perms"),
        "app" => bsc_app::cli::run(rest, "bsc app"),
        // The catalog, as data (`command-surface-catalog-is-one-source`) — so a consumer generates
        // the surface set instead of keeping its own copy of it.
        "surface" => surface_cli(rest),
        "mcp" => run_mcp(rest),
        "hook" => hook::run(&rest),
        // #92: "which build am I?" — the question a session had no way to ask, so an unstaged fix and an
        // unwritten one read identically. Both spellings, because the one you try first is the one that
        // has to work.
        "version" | "--version" | "-V" => {
            println!("{}", bsc_cli_util::version_line("bsc"));
            Ok(())
        }
        "" | "help" | "-h" | "--help" => {
            print!("{}", top_help());
            Ok(())
        }
        other => Err(format!("unknown command '{other}'\n\n{}", top_help())),
    }
}

/// `bsc mcp <server>` (#1877): the bundled native MCP servers — once standalone `bsc-research-mcp` /
/// `bsc-compliance-mcp` binaries — are now subcommands of the umbrella. Each builds its server from
/// the environment and runs the shared stdio JSON-RPC loop (`mcp_rpc::run_stdio_server`), so the app's
/// `.mcp.json` spawns `bsc mcp research` / `bsc mcp compliance` instead of a separate binary.
fn run_mcp(rest: Vec<String>) -> Result<(), String> {
    let server = rest.first().map(String::as_str).unwrap_or("");
    // `server` is the STORE surface (CRUD + persona assignment), nested rather than flattened:
    // every `.mcp.json` the app has generated spawns `bsc mcp <name>`, so a flat `bsc mcp list`
    // would both break those files and collide with a server actually named `list`.
    if server == "server" {
        return bsc_mcp::cli::run(rest[1..].to_vec(), "bsc mcp server");
    }
    match server {
        "research" => mcp_rpc::run_stdio_server(&research::mcp::Server::from_env()?),
        "compliance" => mcp_rpc::run_stdio_server(&compliance::mcp::Server::from_env()?),
        "cve" => mcp_rpc::run_stdio_server(&bsc_security::mcp::Server::from_env()?),
        "channel-mock" => mcp_rpc::run_stdio_server(&channel::mock::Server::from_env()?),
        "" | "help" | "-h" | "--help" => {
            print!("{}", mcp_help());
            Ok(())
        }
        other => Err(format!("unknown mcp server '{other}'\n\n{}", mcp_help())),
    }
}

fn mcp_help() -> String {
    String::from(
        "bsc mcp — bundled native MCP servers (stdio JSON-RPC 2.0)\n\n\
         USAGE:\n  \
         bsc mcp <server>            # spawn a bundled server (what .mcp.json does)\n  \
         bsc mcp server <command>    # the server STORE: list / get / set / remove / assign\n\n\
         COMMANDS:\n  \
         server        the MCP server store: list / get / set / remove + assign to a persona\n\n\
         SERVERS:\n  \
         research      literature grounding (arXiv · Semantic Scholar · PubMed · Crossref)\n  \
         compliance    compliance standards corpus (WCAG · GDPR · CCPA · SOC 2)\n  \
         cve           vulnerability data (OSV.dev) — scan a lockfile · check a package · advisory detail\n  \
         channel-mock  the Marketer's mock marketing channel — records send_email/post/schedule (no real sends)\n\n\
         These are spawned by Claude Code from the project's .mcp.json; you rarely run them by hand.\n",
    )
}

fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let cmd = argv.get(1).map(String::as_str).unwrap_or("");
    let rest: Vec<String> = argv.iter().skip(2).cloned().collect();
    bsc_cli_util::cli_main("bsc", || dispatch(cmd, rest))
}

// This crate's modules are IN THE GRAPH, not in this directory.
// src/defer.rs, src/hook.rs, src/serve.rs, src/superseded.rs, src/tests.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc--<module>.rs
//     bsc graph impl set --id bsc--<module>.rs --code-file <f>
//     bsc graph promote --id bsc--<module>.rs
//
// This header is still a file because this root holds crate-level code of its own. A root
// down to its //! docs and this include is migrated too: the docs become the
// `bsc--lib.rs` doc record and [lib] path points at crates/graph-materialize/crate_root.rs.
include!(concat!(env!("OUT_DIR"), "/crate.rs"));