//! `bsc` — the unified base-studio-code CLI (#1877). One binary; `bsc <command>` dispatches to each
//! state store / tool that used to be its own `bsc-*` sidecar. The shared help scaffold lives in
//! `bsc-cli-util`; each subcommand's logic lives in its owning crate's `cli` module.
//!
//! `bsc help` / `bsc` prints the command overview; `bsc <command> help` drills into one command.

use std::process::ExitCode;

mod defer;
mod hook;
mod superseded;

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
    active("lan", "bsc-lan", "the emit-only LAN sensor: what a host exposes · its keys · what it would send (NOT `network`, which is the user domain store)", Some("no store yet — keys are printed, never written")),
    active("deploy", "bsc-deploy", "ship a binary to a device and take it back: status · push · rollback (push-only; LAB has no egress)", Some("the device roster — deploy/devices.json")),
    active("capability", "bsc-capability", "the USE layer: what a network can DO right now, and how fresh each answer is", Some("derived — reads `bsc project network` + `bsc deploy`")),
    active("data", "bsc-data", "canonical data model (DuckDB): model · scan · tables · connector", Some("the canonical data model — DuckDB")),
    active("cve", "cve", "vulnerability data (OSV.dev): scan a lockfile · check a package · advisory detail (supply-chain #2433)", Some("the OSV.dev advisory cache")),
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
        "lan" => bsc_lan::cli::COMMANDS,
        "deploy" => bsc_deploy::cli::COMMANDS,
        "capability" => bsc_capability::cli::COMMANDS,
        // Gated exactly like the dispatch arm below. Without this, `--no-default-features` — the lean,
        // DuckDB-free build #1877 documents and every cross-compiled device build needs — fails to
        // compile on an unresolved `bsc_data`. The feature existed; this arm was simply never gated.
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::COMMANDS,
        "compliance" => compliance::cli::COMMANDS,
        "cve" => cve::cli::COMMANDS,
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
/// FROM THE MEMBERS LIST, NEVER A DIRECTORY LISTING. `crates/graph-materialize` is a directory in
/// `crates/` holding only a `build.rs` — the shared build script other crates pull in via
/// `build = "../graph-materialize/build.rs"`. It is not a package, has no name to key a node on, and
/// a listing would wrongly give it one.
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

mod serve;

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
        "lan" => bsc_lan::cli::run(rest, "bsc lan"),
        "deploy" => bsc_deploy::cli::run(rest, "bsc deploy"),
        "capability" => bsc_capability::cli::run(rest, "bsc capability"),
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::run(rest, "bsc data"),
        "cve" => cve::cli::run(rest, "bsc cve"),
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
        "cve" => mcp_rpc::run_stdio_server(&cve::mcp::Server::from_env()?),
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

#[cfg(test)]
mod tests {

    /// `bsc surface help` MUST NAME EVERY VERB `surface_cli` DISPATCHES.
    ///
    /// This command's whole thesis is that help and dispatch cannot disagree — it exists to project
    /// other crates' catalogs for exactly that reason. Shipping a verb it does not advertise about
    /// itself is the same defect one level up, and it happened: `verbs` and `drill` were both live and
    /// undocumented until this test was written.
    ///
    /// Reads its own source, like `dispatched_crates` does, because the arms are a match rather than a
    /// catalog. If `surface_cli` ever grows a real `CmdDoc` catalog, delete this and project it.
    #[test]
    fn surface_help_names_every_verb_it_dispatches() {
        const SRC: &str = include_str!("main.rs");
        let start = SRC.find("fn surface_cli").expect("surface_cli is still named that");
        let end = start + SRC[start..].find("\nfn ").unwrap_or(SRC.len() - start);
        let body = &SRC[start..end];

        // The help text lives in `surface_help()`, a SEPARATE fn — reading it out of `surface_cli`
        // silently found nothing and would have made this guard vacuous.
        let hs = SRC.find("fn surface_help").expect("surface_help is still named that");
        let help = &SRC[hs..hs + SRC[hs..].find("\nfn ").unwrap_or(SRC.len() - hs)];
        assert!(help.contains("bsc surface list"), "the help scan found no help — the scan is broken");

        let mut arms: Vec<&str> = Vec::new();
        for line in body.lines() {
            let t = line.trim_start();
            // an arm head at the match's own indent: `"name" => {` or `"a" | "b" =>`
            if !t.starts_with('"') || !t.contains("=>") {
                continue;
            }
            let head = &t[..t.find("=>").unwrap()];
            for piece in head.split('|') {
                let p = piece.trim().trim_matches(|c| c == '"' || c == ' ');
                if !p.is_empty() && !p.starts_with('-') && p != "help" {
                    arms.push(p);
                }
            }
        }
        arms.sort_unstable();
        arms.dedup();
        assert!(arms.len() >= 4, "the arm scan found only {arms:?} — the scan is broken, not the help");

        for verb in &arms {
            assert!(
                help.contains(&format!("bsc surface {verb}")),
                "`bsc surface {verb}` dispatches but `bsc surface help` never mentions it"
            );
        }
    }

    /// THE ROSTER MUST BE READABLE FROM INSIDE THE WORKSPACE, NOT ONLY AT ITS ROOT.
    ///
    /// Measured before the fix: `bsc surface crates` read 60 crates from the repo root and FAILED from
    /// `src-tauri/` — which is where `tauri dev` runs the app, and the app spawns `bsc` with no
    /// `current_dir` and no `BSC_REPO_ROOT` (that is wired for PTY sessions only). So the Glance
    /// surface band would have been empty on every launch, with every test green. That is the same
    /// shape as the bug this whole slice exists to fix, one layer down.
    #[test]
    fn the_workspace_root_is_found_from_any_depth() {
        // NAMED PER TEST, not just per pid: `cargo test` runs these in ONE process, so a
        // pid-only path is shared with the sibling test below and with the pre-existing roster test.
        // nextest gives each test its own process and hides that entirely.
        let tmp = std::env::temp_dir().join(format!("bsc-walkup-{}", std::process::id()));
        let deep = tmp.join("crates").join("thing").join("src");
        std::fs::create_dir_all(&deep).expect("temp tree");
        std::fs::write(tmp.join("Cargo.toml"), "[workspace]\nmembers = []\n").expect("manifest");
        // a NESTED manifest with no [workspace] must be walked past, not mistaken for the root
        std::fs::write(tmp.join("crates").join("thing").join("Cargo.toml"), "[package]\nname = \"thing\"\n")
            .expect("member manifest");

        let want = tmp.canonicalize().expect("canonical");
        for from in [&tmp, &deep, &tmp.join("crates")] {
            assert_eq!(
                find_workspace_root(from, false).expect("walks up to the workspace"),
                want,
                "failed from {}",
                from.display()
            );
        }

        // Outside any workspace it REFUSES rather than guessing — an empty roster and a missing
        // workspace must not look the same to the caller.
        let orphan = tmp.join("crates").join("thing").join("src");
        std::fs::remove_file(tmp.join("Cargo.toml")).expect("drop the workspace manifest");
        assert!(find_workspace_root(&orphan, false).is_err(), "no workspace above ⇒ an error");

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// An EXPLICIT root is taken at its word — silently using its parent answers a question the caller
    /// did not ask, and would make a typo look like success against the wrong tree.
    #[test]
    fn an_explicit_root_is_never_silently_replaced_by_its_parent() {
        let tmp = std::env::temp_dir().join(format!("bsc-explicit-{}", std::process::id()));
        let sub = tmp.join("sub");
        std::fs::create_dir_all(&sub).expect("temp tree");
        std::fs::write(tmp.join("Cargo.toml"), "[workspace]\nmembers = []\n").expect("manifest");

        assert!(find_workspace_root(&sub, true).is_err(), "explicit ⇒ no walk-up");
        assert!(find_workspace_root(&sub, false).is_ok(), "…but the implicit path still walks");

        std::fs::remove_dir_all(&tmp).ok();
    }

    /// A miniature roster: a verbless util everything leans on, a multi-noun crate, and a leaf.
    fn roster() -> Vec<CrateRow> {
        let row = |pkg: &str, deps: &[&str]| CrateRow {
            package: pkg.to_string(),
            path: format!("crates/{pkg}"),
            verbs: Vec::new(),
            depends_on: deps.iter().map(|d| d.to_string()).collect(),
        };
        vec![
            row("bsc-util", &[]),
            row("logs", &["bsc-util"]),
            row("bsc-mem", &["bsc-util", "logs"]),
            row("plandb", &["bsc-util"]),
        ]
    }

    /// DEPENDENTS ARE THE INVERSION, and the reason this call exists at all — `bsc surface crates`
    /// carries only the outbound direction, so a consumer drawing ONE node would need all 54 rows.
    #[test]
    fn a_drill_inverts_dependents_from_the_roster() {
        let d = drill_doc(&roster(), "bsc-util").expect("bsc-util is in the roster");
        let deps: Vec<&str> = d["dependents"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert_eq!(deps, vec!["logs", "bsc-mem", "plandb"], "every crate that names bsc-util, in roster order");
        assert_eq!(d["dependentCount"].as_u64(), Some(3));
        assert_eq!(d["dependsOn"].as_array().unwrap().len(), 0, "bsc-util depends on nothing internal");

        // The other direction, on the same roster, so a swapped inversion cannot pass both.
        let m = drill_doc(&roster(), "bsc-mem").unwrap();
        assert_eq!(m["dependentCount"].as_u64(), Some(0), "nothing depends on bsc-mem");
        assert_eq!(m["dependsOn"].as_array().unwrap().len(), 2);
    }

    /// A crate never counts itself, even if a malformed roster says it depends on itself.
    #[test]
    fn a_crate_is_never_its_own_dependent() {
        let mut r = roster();
        r[0].depends_on.push("bsc-util".to_string());
        let d = drill_doc(&r, "bsc-util").unwrap();
        let deps: Vec<&str> = d["dependents"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        assert!(!deps.contains(&"bsc-util"), "self-dependency must not become a self-edge");
        assert_eq!(d["dependentCount"].as_u64(), Some(3));
    }

    /// A MULTI-NOUN CRATE STAYS SPLIT. `logs` serves three surfaces from three `run` fns; flattening
    /// them is the bug `surface_verbs` was re-keyed to fix, and this is where it would come back.
    #[test]
    fn a_multi_noun_crate_drills_into_separate_nouns() {
        let d = drill_doc(&roster(), "logs").expect("logs is in the roster");
        let nouns = d["nouns"].as_array().unwrap();
        let names: Vec<&str> = nouns.iter().map(|n| n["noun"].as_str().unwrap()).collect();
        assert_eq!(names, vec!["logs", "metrics", "perf"], "all three nouns the logs crate serves");

        let by = |n: &str| nouns.iter().find(|x| x["noun"] == n).unwrap().clone();
        assert!(by("metrics")["verbs"].is_null(), "metrics takes a PROJECT, not a verb — it has no catalog");
        assert_eq!(by("metrics")["catalog"], "unreachable");

        let (ln, pn) = (by("logs"), by("perf"));
        let names = |v: &serde_json::Value| -> Vec<String> {
            v["verbs"].as_array().unwrap().iter().map(|x| x["verb"].as_str().unwrap().to_string()).collect()
        };
        let (logs, perf) = (names(&ln), names(&pn));
        assert_ne!(logs, perf, "logs and perf must not share one catalog");
        assert!(by("logs")["verbs"][0]["usage"].is_string(), "the drill carries usage, not just a summary");
    }

    /// A VERBLESS CRATE STILL DRILLS — that is the 2026-09-01 decision that every crate gets a node,
    /// and `bsc-util` is its whole argument: no verb, largest blast radius.
    #[test]
    fn a_verbless_crate_still_drills() {
        let d = drill_doc(&roster(), "bsc-util").unwrap();
        assert_eq!(d["surface"], false);
        assert_eq!(d["nouns"].as_array().unwrap().len(), 0);
        assert_eq!(d["dependentCount"].as_u64(), Some(3), "still reports what it reaches");
    }

    /// An unknown crate must FAIL — an empty drill is indistinguishable from a library crate, and the
    /// two mean opposite things.
    #[test]
    fn an_unknown_crate_is_an_error_not_an_empty_drill() {
        let e = drill_doc(&roster(), "no-such-crate").expect_err("must not succeed");
        assert!(e.contains("no-such-crate"), "the message names what was asked for: {e}");
        assert!(e.contains("bsc surface crates"), "and points at how to find the real name: {e}");
    }

    /// COVERAGE IS THE ONE THING `surface_verbs` CAN DRIFT ON, so it is pinned here.
    ///
    /// The verb NAMES and summaries cannot drift — they are projected from the `COMMANDS` beside the
    /// `run` each dispatch arm names, the same const that noun's `--help` prints. What a hand-written
    /// pointer table can lose is a surface: one that gains a catalog is not added automatically, and
    /// one whose module stops being public silently falls back to "unreachable", which renders as
    /// *no verbs* rather than as an error.
    #[test]
    fn every_projected_surface_is_still_reachable() {
        const PROJECTED: &[&str] = &[
            "plan", "logs", "perf", "ui", "fleet", "mem", "persona", "request", "secret", "config",
            "work", "cad", "data", "compliance", "cve", "news",
            // the record-backed CLIs, whose catalogs were private rather than absent
            "blueprint", "debug", "files", "loop", "navigate", "network", "project", "publish",
            "runtime", "sandbox", "session", "shot", "sound", "studio", "teams", "org", "errors",
            "skill", "usage",
            // catalog-by-function rather than by const
            "app", "component", "github", "perms", "resolve", "self", "disk", "worktree",
        ];
        for n in PROJECTED {
            let docs = surface_verbs(n).unwrap_or_else(|| panic!("{n} stopped projecting its catalog"));
            assert!(!docs.is_empty(), "{n} projects an EMPTY catalog — that reads as 'no verbs'");
        }
        assert!(surface_verbs("graph").is_none(), "graph uses cli::VERBS, not COMMANDS — see the table");
        assert!(surface_verbs("no-such-noun").is_none());

        // The table may only name a noun this binary actually dispatches.
        for n in PROJECTED {
            assert!(COMMANDS.iter().any(|c| c.name == *n), "{n} is projected but is not a surface");
        }
    }

    /// THE BUG THIS SLICE FIXED: keying the catalog on the PACKAGE, not the noun.
    ///
    /// `logs` serves `logs`, `perf` and `metrics` from three different `run` fns. Keyed on the package,
    /// all three projected `logs::cli::COMMANDS`, so `bsc surface verbs metrics` advertised fourteen
    /// verbs `bsc metrics` cannot run — help promising what dispatch will refuse, which is the exact
    /// drift `command-surface-catalog-is-one-source` exists to end.
    ///
    /// The general invariant, which catches the next one of these without naming it: two DISTINCT
    /// ACTIVE surfaces must not advertise the same verb list. Deprecated aliases are exempt — `org` is
    /// an alias of `teams` and shares its catalog on purpose.
    #[test]
    fn two_active_surfaces_never_advertise_the_same_verb_list() {
        let mut seen: Vec<(&str, Vec<&str>)> = Vec::new();
        for c in COMMANDS.iter().filter(|c| c.status == Status::Active) {
            let Some(docs) = surface_verbs(c.name) else { continue };
            let names: Vec<&str> = docs.iter().map(|d| d.name).collect();
            if let Some((other, _)) = seen.iter().find(|(_, n)| *n == names) {
                panic!(
                    "'{}' and '{}' advertise an identical verb list — one of them is borrowing the \
                     other's catalog. The catalog belongs to the NOUN, not the package.",
                    c.name, other
                );
            }
            seen.push((c.name, names));
        }
        assert!(seen.len() >= 15, "only {} surfaces projected — the scan is broken", seen.len());
    }

    /// `metrics` takes a PROJECT, not a verb, so it has no catalog and must say so rather than
    /// borrowing the `logs` crate's. This is the specific case the general guard above generalises.
    #[test]
    fn metrics_reports_no_catalog_rather_than_borrowing_logs() {
        assert!(surface_verbs("metrics").is_none(), "metrics has no verb catalog — `bsc metrics <project>`");
        assert!(surface_verbs("logs").is_some());
        assert!(surface_verbs("perf").is_some());
        let logs: Vec<&str> = surface_verbs("logs").unwrap().iter().map(|d| d.name).collect();
        let perf: Vec<&str> = surface_verbs("perf").unwrap().iter().map(|d| d.name).collect();
        assert_ne!(logs, perf, "logs and perf are different nouns with different catalogs");
    }

    /// A CATALOG CHANGE MUST REACH THIS OUTPUT — the criterion that "no second list is introduced".
    ///
    /// `surface_verbs` names each module's own const, so today the projection cannot differ. The guard
    /// is for the edit that breaks that: someone replaces a pointer with a locally-written array. A
    /// copy compares equal the day it is written and diverges later, when the crate edits its catalog
    /// and the copy does not — so this fires exactly when the copy becomes wrong.
    ///
    /// Compares FIELD BY FIELD IN ORDER: `CmdDoc` derives no `PartialEq`, and a reordered verb list is
    /// a real difference in `--help` output.
    #[test]
    fn a_catalog_edit_reaches_the_projection() {
        let pairs: &[(&str, &'static [bsc_cli_util::CmdDoc])] = &[
            ("mem", bsc_mem::cli::COMMANDS),
            ("plan", plandb::cli::COMMANDS),
            ("fleet", bsc_fleet::cli::COMMANDS),
            ("logs", logs::cli::COMMANDS),
            ("perf", logs::instrument::COMMANDS),
        ];
        for (noun, canonical) in pairs {
            let projected = surface_verbs(noun).unwrap_or_else(|| panic!("{noun} projects"));
            assert_eq!(projected.len(), canonical.len(), "{noun}: verb COUNT diverged from its catalog");
            for (i, (got, want)) in projected.iter().zip(canonical.iter()).enumerate() {
                assert_eq!(got.name, want.name, "{noun} verb {i}: name diverged");
                assert_eq!(got.summary, want.summary, "{noun} verb {i} ({}): summary diverged", want.name);
                assert_eq!(got.usage, want.usage, "{noun} verb {i} ({}): usage diverged", want.name);
            }
        }
    }

    /// An unreachable catalog must be DISTINCT from an empty one, all the way to the wire.
    #[test]
    fn an_unreachable_catalog_is_null_never_an_empty_list() {
        assert!(!surface_verbs("mem").expect("mem projects").is_empty());
        assert!(surface_verbs("graph").is_none(), "not Some(&[]) — the caller must be able to tell");
    }

    use super::*;

    /// The arm names `dispatch` actually handles, scraped from this file's own source.
    ///
    /// Scraping is not elegant. It is, however, the only way to ENUMERATE `match` arms from a test —
    /// and enumeration is the whole point. Every previous guard here was one hand-written
    /// `assert!(top_help().contains("…"))` per command, which can only ever pin the commands someone
    /// remembered to pin: `bsc usage` shipped without one and reddened the workspace gate
    /// (`agent-cli-surface-test-misses-usage`), and `perf` and `serve` went unadvertised for longer.
    ///
    /// Only lines whose trimmed form STARTS with a quote are considered, and only the text before
    /// `=>` is read, so a string inside an arm BODY (`run(rest, "bsc org")`) can never be mistaken
    /// for an arm name. The region is bounded to `dispatch` so `run_mcp`'s own match — whose arms are
    /// MCP servers, not top-level commands — cannot leak in.
    fn dispatched_names() -> Vec<String> {
        const SRC: &str = include_str!("main.rs");
        let start = SRC.find("pub(crate) fn dispatch").expect("dispatch is still named `dispatch`");
        let end = start + SRC[start..].find("fn run_mcp").expect("run_mcp still follows dispatch");
        let mut names = Vec::new();
        for line in SRC[start..end].lines() {
            let t = line.trim_start();
            if !t.starts_with('"') {
                continue;
            }
            let Some(arrow) = t.find("=>") else { continue };
            let mut head = &t[..arrow];
            while let Some(open) = head.find('"') {
                let after = &head[open + 1..];
                let Some(close) = after.find('"') else { break };
                names.push(after[..close].to_string());
                head = &after[close + 1..];
            }
        }
        // A scan that finds nothing must FAIL, never quietly pass — a silent zero would turn this
        // guard into a no-op the first time the function is renamed.
        assert!(names.len() > 10, "the dispatch scan found only {names:?} — the scan is broken, not the code");
        names
    }

    /// Every crate in the workspace, as `lib target name -> package name`.
    ///
    /// THREE NAMES ARE IN PLAY and mixing them up is the whole difficulty. The DIRECTORY differs
    /// from the package for `crates/data` (`bsc-data`) and `crates/llm` (`bsc-llm`). The LIB TARGET
    /// — what the dispatch actually writes — differs again for `llm`, the only crate in the
    /// workspace where it does. Keying on either of the other two gets `llm` wrong and looks right
    /// everywhere else, which is exactly the shape that ships.
    fn lib_target_to_package() -> std::collections::HashMap<String, String> {
        let crates_dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let mut out = std::collections::HashMap::new();
        for e in std::fs::read_dir(&crates_dir).expect("crates/ is readable").flatten() {
            let toml = e.path().join("Cargo.toml");
            let Ok(txt) = std::fs::read_to_string(&toml) else { continue };
            let pkg = txt
                .lines()
                .find_map(|l| l.trim().strip_prefix("name = \"").and_then(|r| r.strip_suffix('"')))
                .map(str::to_string);
            let Some(pkg) = pkg else { continue };
            // `[lib] name = "..."` when present, else the package name with hyphens swapped.
            let lib = txt
                .split("[lib]")
                .nth(1)
                .and_then(|tail| {
                    tail.split("\n[").next().unwrap_or(tail).lines().find_map(|l| {
                        l.trim().strip_prefix("name = \"").and_then(|r| r.strip_suffix('"'))
                    })
                })
                .map(str::to_string)
                .unwrap_or_else(|| pkg.replace('-', "_"));
            out.insert(lib, pkg);
        }
        assert!(out.len() > 40, "the crate scan found only {} packages — the scan is broken", out.len());
        out
    }

    /// Every dispatch arm as `(verb, package that serves it)`, read from this file's own source.
    ///
    /// Three arm shapes, all of which occur: `crate::cli::run(...)`; a multi-line BLOCK, used by the
    /// deprecated aliases, where the crate appears on a later line; and a local fn or module, which
    /// is this crate serving the verb itself. The path is not always `cli::run` — `"perf" =>
    /// logs::instrument::run` — so the rule is the FIRST path segment, not the `cli` convention.
    ///
    /// AN ARM IT CANNOT READ IS A FAILURE, never a silent omission. The first version of this scan
    /// resolved 43 of 44 and dropped `version`, whose block calls `bsc_cli_util::version_line`
    /// rather than any `cli::run`; a count mismatch was the only signal that anything was wrong.
    fn dispatched_crates() -> Vec<(String, String)> {
        const SRC: &str = include_str!("main.rs");
        const NOT_A_SURFACE: &[&str] = &["", "help", "-h", "--help", "--version", "-V"];
        let lib2pkg = lib_target_to_package();
        let start = SRC.find("pub(crate) fn dispatch").expect("dispatch is still named `dispatch`");
        let end = start + SRC[start..].find("fn run_mcp").expect("run_mcp still follows dispatch");

        let mut out: Vec<(String, String)> = Vec::new();
        let mut pending: Vec<String> = Vec::new();
        for line in SRC[start..end].lines() {
            let t = line.trim_start();
            if t.starts_with('"') {
                let Some(arrow) = t.find("=>") else { continue };
                let (head, body) = (&t[..arrow], t[arrow + 2..].trim());
                let mut names = Vec::new();
                let mut rest = head;
                while let Some(open) = rest.find('"') {
                    let after = &rest[open + 1..];
                    let Some(close) = after.find('"') else { break };
                    let n = &after[..close];
                    if !NOT_A_SURFACE.contains(&n) {
                        names.push(n.to_string());
                    }
                    rest = &after[close + 1..];
                }
                if body == "{" || body.is_empty() {
                    pending = names; // a block arm: the crate is on a later line
                    continue;
                }
                let seg: String = body.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
                // A bare fn call (`surface_cli(rest)`) or a local module (`serve::run()`) is not a
                // crate — this crate is serving the verb itself.
                let pkg = lib2pkg.get(&seg).cloned().unwrap_or_else(|| "bsc".to_string());
                for n in names {
                    out.push((n, pkg.clone()));
                }
                pending.clear();
            } else if !pending.is_empty() {
                // In a BLOCK the crate is the one whose `cli::run` is called. None means this crate
                // does the work — `version` formats a string with `bsc-cli-util`, but a library it
                // calls is not the crate that serves the verb.
                if let Some(idx) = t.find("::cli::run(") {
                    let seg: String =
                        t[..idx].chars().rev().take_while(|c| c.is_alphanumeric() || *c == '_')
                            .collect::<Vec<_>>().into_iter().rev().collect();
                    let pkg = lib2pkg.get(&seg).cloned().unwrap_or_else(|| "bsc".to_string());
                    for n in pending.drain(..) {
                        out.push((n, pkg.clone()));
                    }
                } else if t.starts_with('}') {
                    for n in pending.drain(..) {
                        out.push((n, "bsc".to_string()));
                    }
                }
            }
        }
        assert!(pending.is_empty(), "the scan could not resolve a crate for {pending:?} — read the arm, do not guess");
        assert!(out.len() > 40, "the dispatch scan found only {} arms — the scan is broken, not the code", out.len());
        out
    }

    fn repo_root() -> std::path::PathBuf {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
    }

    /// THE ROSTER IS EVERY WORKSPACE MEMBER, not every directory and not only the ones with verbs.
    ///
    /// A crate with no surface is PRESENT with an empty verb list — that is the whole point of the
    /// crate-keyed decision (`epic-command-surfaces-are-nodes`, 2026-09-01): the node's job is
    /// maintenance, and `bsc-util` has no verb while being the crate whose change reaches most of
    /// the workspace.
    #[test]
    fn the_roster_is_every_workspace_member() {
        let rows = crate_roster(&repo_root()).expect("the roster reads");
        assert!(rows.len() >= 50, "only {} members — the scan is broken, not the workspace", rows.len());
        assert!(rows.iter().all(|r| !r.package.is_empty()), "a member resolved to an empty package name");

        let verbless = rows.iter().filter(|r| r.verbs.is_empty()).count();
        assert!(verbless > 5, "only {verbless} verbless crates — they are being dropped, not listed");
        assert!(
            rows.iter().any(|r| r.package == "bsc-util" && r.verbs.is_empty()),
            "bsc-util must be PRESENT with no verbs — it is the crate the decision exists for"
        );

        // `crates/graph-materialize` holds only a build.rs and is not a package. It is in the
        // DIRECTORY listing and not in the members list, which is exactly why the roster reads the
        // members list — a listing would mint a node with no package name to key on.
        assert!(
            !rows.iter().any(|r| r.package == "graph-materialize"),
            "graph-materialize is a build script, not a crate — the roster read a directory listing"
        );
        // src-tauri is a member and its PACKAGE is `base-studio-code`, another place the directory
        // name is not the key.
        assert!(
            rows.iter().any(|r| r.package == "base-studio-code" && r.path == "src-tauri"),
            "the app crate must be in the roster under its package name"
        );
    }

    /// THE TWO READS MUST NOT DISAGREE ABOUT WHAT EXISTS. The catalog knows what dispatches; the
    /// roster knows what the workspace contains. A crate the catalog names and the roster cannot
    /// find means one of them is stale, and the node set would file a verb under a crate with no
    /// node.
    #[test]
    fn every_crate_the_catalog_names_is_in_the_roster() {
        let rows = crate_roster(&repo_root()).expect("the roster reads");
        let packages: std::collections::HashSet<&str> = rows.iter().map(|r| r.package.as_str()).collect();
        for c in COMMANDS {
            assert!(
                packages.contains(c.krate),
                "`bsc {}` names crate `{}`, which is not a workspace member — the catalog and the \
                 roster disagree about what exists",
                c.name, c.krate
            );
        }
        // And the join is complete in the other direction: every catalog verb lands on exactly one row.
        for c in COMMANDS {
            let hits = rows.iter().filter(|r| r.verbs.contains(&c.name)).count();
            assert_eq!(hits, 1, "`bsc {}` lands on {hits} roster rows, not 1", c.name);
        }
    }

    /// THE DEPENDENCY EDGE IS THE HALF THAT MAKES THE NODE USEFUL — it is what says touching a
    /// shared util reaches most of the workspace. An empty or trivial graph must not pass.
    #[test]
    fn the_dependency_graph_is_real() {
        let rows = crate_roster(&repo_root()).expect("the roster reads");
        let dependents = |pkg: &str| rows.iter().filter(|r| r.depends_on.iter().any(|d| d == pkg)).count();
        assert!(dependents("bsc-util") > 20, "bsc-util has {} dependents — the dep scan is broken", dependents("bsc-util"));
        assert!(dependents("bsc-cli-util") > 20, "bsc-cli-util has {} dependents", dependents("bsc-cli-util"));
        // Only workspace packages are edges; an external crate has a version, not a path.
        let packages: std::collections::HashSet<&str> = rows.iter().map(|r| r.package.as_str()).collect();
        for r in &rows {
            for d in &r.depends_on {
                assert!(packages.contains(d.as_str()), "{} depends on `{d}`, which is not a member", r.package);
                assert_ne!(d, &r.package, "{} depends on itself", r.package);
            }
        }
    }

    /// AN UNREADABLE ROOT IS AN ERROR, NEVER AN EMPTY LIST. A staged binary outside the repo has no
    /// workspace to read, and an empty roster that looks like an answer is the failure shape this
    /// repo keeps hitting.
    #[test]
    fn a_root_with_no_workspace_is_an_error_not_an_empty_roster() {
        let tmp = std::env::temp_dir().join(format!("bsc-roster-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        let err = roster_root(Some(&tmp.to_string_lossy())).expect_err("a dir with no Cargo.toml must fail");
        assert!(err.contains("--root") || err.contains("BSC_REPO_ROOT"), "the error must say how to fix it: {err}");

        // A Cargo.toml that is not the workspace root is also refused, rather than read as empty.
        std::fs::write(tmp.join("Cargo.toml"), "[package]\nname = \"nope\"\n").unwrap();
        let err = roster_root(Some(&tmp.to_string_lossy())).expect_err("a non-workspace manifest must fail");
        assert!(err.contains("[workspace]"), "the error must name what is missing: {err}");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// THE CATALOG NAMES THE CRATE THAT ACTUALLY DISPATCHES.
    ///
    /// The crate is what the Glance surface node is keyed on, so a wrong one puts a verb under the
    /// wrong node — and unlike a missing row, nothing else would ever notice. `krate` is a const
    /// beside a `match`, exactly as `name` is; this test is the mechanism that keeps them equal, and
    /// there is no build step deriving it.
    #[test]
    fn the_catalog_names_the_crate_that_dispatches() {
        let dispatched = dispatched_crates();
        for (verb, pkg) in &dispatched {
            let Some(row) = COMMANDS.iter().find(|c| c.name == verb) else { continue };
            assert_eq!(
                &row.krate, pkg,
                "`bsc {verb}` dispatches to `{pkg}` but its catalog row says `{}` — the surface node \
                 would be filed under the wrong crate",
                row.krate
            );
        }
        // Every row must have been checked: a row whose verb the scan never saw is the silent case.
        for c in COMMANDS {
            assert!(
                dispatched.iter().any(|(v, _)| v == c.name),
                "the catalog row `{}` names crate `{}` but the dispatch scan never saw that verb",
                c.name, c.krate
            );
        }
        assert!(!COMMANDS.iter().any(|c| c.krate.is_empty()), "a row left its crate blank");
    }

    /// THE CATALOG AND DISPATCH MAY NOT DISAGREE (`command-surface-catalog-is-one-source`).
    ///
    /// Both directions, because both have bitten. A command that dispatches with no catalog row is
    /// undiscoverable — `bsc perf` and `bsc serve` were exactly that, working commands absent from
    /// `bsc help`, the same shape as `bsc plan brief` in
    /// `the-architects-only-outbound-channel-is-undiscoverable`. A catalog row that does not dispatch
    /// is the #82 failure: an overview naming a door that is not there.
    ///
    /// Verified to BITE by deleting the `perf` row and watching this fail — a guard nobody has seen
    /// fail is a guard nobody knows works.
    #[test]
    fn the_catalog_and_the_dispatch_match_agree() {
        // Spellings that are aliases or the help fallthrough, not surfaces in their own right.
        // `version` is deliberately NOT here: it is a real command and carries a real row.
        const NOT_A_SURFACE: &[&str] = &["", "help", "-h", "--help", "--version", "-V"];

        let dispatched: Vec<String> =
            dispatched_names().into_iter().filter(|n| !NOT_A_SURFACE.contains(&n.as_str())).collect();

        for name in &dispatched {
            assert!(
                COMMANDS.iter().any(|c| c.name == name),
                "`bsc {name}` dispatches but has no catalog row, so `bsc help` never mentions it \
                 and nothing reading the surface can discover it — add a row rather than deleting \
                 this assertion"
            );
        }
        for c in COMMANDS {
            assert!(
                dispatched.iter().any(|n| n == c.name),
                "the catalog advertises `bsc {}` but nothing dispatches it — an overview that names \
                 a verb the CLI lacks is a map to a door that is not there (#82)",
                c.name
            );
        }
    }

    /// `bsc surface list --json` is the GENERATION source for consumers, so its shape is a contract:
    /// a Glance node is built per row (`command-surfaces-are-glance-nodes`). Pins the keys and that
    /// every row round-trips, rather than eyeballing the output.
    #[test]
    fn surface_list_json_carries_every_row_with_its_status_and_store() {
        let (res, out) = bsc_util::capture_output(|| surface_cli(vec!["list".into(), "--json".into()]));
        res.expect("the catalog renders");
        let rows: Vec<serde_json::Value> = serde_json::from_str(out.trim()).expect("valid JSON");

        assert_eq!(rows.len(), COMMANDS.len(), "every catalog row is emitted");
        for (row, c) in rows.iter().zip(COMMANDS) {
            assert_eq!(row["name"], c.name);
            assert_eq!(row["status"], c.status.as_str());
            match c.store {
                Some(s) => assert_eq!(row["store"], s, "`{}` states its store", c.name),
                None => assert!(row["store"].is_null(), "`{}` touches no store", c.name),
            }
        }
        // The two statuses a consumer must be able to tell apart WITHOUT its own list of which
        // commands are which — that is the whole reason status is data.
        assert!(rows.iter().any(|r| r["status"] == "deprecated"), "deprecated aliases are marked");
        assert!(rows.iter().any(|r| r["status"] == "internal"), "internal commands are marked");
    }

    #[test]
    fn mcp_help_lists_the_mock_marketing_channel() {
        let h = mcp_help();
        assert!(h.contains("channel-mock"), "the bundled mock marketing channel is listed (#3146)");
        assert!(h.contains("research") && h.contains("compliance"), "the existing servers stay listed");
    }

    /// THE OVERVIEW MAY NOT NAME A VERB THE SUBCOMMAND DOES NOT HAVE (#82, designer request).
    ///
    /// The `files` row advertised `read/write/edit/list/info`; only `read` was real. A designer
    /// followed it, ran `bsc files list`, got `unknown command 'list'`, and filed a request for the
    /// directory listing `tree` had been providing all along. Prose cannot be checked in general —
    /// but this row is a verb LIST, so it can be checked against the catalog it claims to summarise.
    #[test]
    fn the_files_overview_names_only_verbs_the_files_cli_actually_has() {
        let row = COMMANDS.iter().find(|c| c.name == "files").expect("a files row").summary;
        let real = bsc_files::cli::command_names();
        assert!(!real.is_empty(), "the files catalog is reachable");
        for verb in &real {
            assert!(row.contains(verb), "the overview omits the real verb `{verb}`: {row}");
        }
        // …and none of the four it used to invent.
        for ghost in ["write", "edit", "list", "info"] {
            assert!(
                !real.contains(&ghost), // guard the guard: if one is ever added, this test must be updated
                "`{ghost}` is now a real verb — update this assertion rather than deleting it"
            );
            assert!(!row.contains(ghost), "the overview names `{ghost}`, which does not exist: {row}");
        }
    }

    #[test]
    fn top_help_marks_component_deprecated_and_points_at_ui() {
        let h = top_help();
        assert!(h.contains("DEPRECATED (#2469)"), "component row carries the deprecation pointer");
        assert!(h.contains("`bsc ui`"), "... aimed at the merged `bsc ui` surface");
        assert!(h.contains("UI design surface"), "the ui row describes the merged surface");
    }

    #[test]
    fn ui_and_the_component_alias_both_dispatch() {
        // Help paths — no store required. The alias still works (delegating + warning on stderr).
        assert!(dispatch("ui", vec!["help".into()]).is_ok());
        assert!(dispatch("component", vec!["help".into()]).is_ok());
    }

    #[test]
    fn top_help_marks_org_deprecated_and_points_at_teams() {
        let h = top_help();
        assert!(h.contains("DEPRECATED (#2700)"), "the org row carries the deprecation pointer");
        assert!(h.contains("`bsc teams`"), "... aimed at the renamed teams store");
        assert!(h.contains("user teams store"), "the teams row describes the store");
    }

    #[test]
    fn studio_dispatches_and_appears_in_the_overview() {
        // #2890: the Studio store is mounted + listed. Help path — no store required.
        assert!(dispatch("studio", vec!["help".into()]).is_ok());
        assert!(top_help().contains("Studio store"), "the studio row describes the store");
    }

    #[test]
    fn sound_dispatches_and_appears_in_the_overview() {
        // #3080: the sound-kit store is mounted + listed. Help path — no store required.
        assert!(dispatch("sound", vec!["help".into()]).is_ok());
        assert!(top_help().contains("user sound-kit store"), "the sound row describes the store");
    }

    #[test]
    fn loop_dispatches_and_appears_in_the_overview() {
        // #3262: the conversation loop store is mounted + listed. Help path — no store required.
        assert!(dispatch("loop", vec!["help".into()]).is_ok());
        assert!(top_help().contains("conversation loop store"), "the loop row describes the store");
    }

    #[test]
    fn request_dispatches_and_appears_in_the_overview() {
        // #3295: the improvement-request store is mounted + listed. Help path — no store required.
        assert!(dispatch("request", vec!["help".into()]).is_ok());
        assert!(top_help().contains("improvement-request store"), "the request row describes the store");
    }

    #[test]
    fn cad_dispatches_and_appears_in_the_overview() {
        // #3387: the geometry kernel (#2621) is mounted + listed, so a live session reaches it via
        // $BSC_BIN with no PATH changes. Help path — no spec file required.
        assert!(dispatch("cad", vec!["help".into()]).is_ok());
        assert!(top_help().contains("mesh/SDF geometry kernel"), "the cad row describes the kernel");
    }

    #[test]
    fn cve_dispatches_and_appears_in_the_overview() {
        // #3797: the OSV.dev vulnerability data layer is mounted + listed, and its MCP server is
        // reachable via `bsc mcp cve`. Help paths — no cache/network required.
        assert!(dispatch("cve", vec!["help".into()]).is_ok());
        assert!(top_help().contains("vulnerability data"), "the cve row describes the data layer");
        assert!(mcp_help().contains("cve"), "bsc mcp cve is listed as a bundled server");
    }

    #[test]
    fn usage_dispatches_and_appears_in_the_overview() {
        // #3812 (epic #3809): the per-project usage-events store is mounted + listed. Help path — no db.
        assert!(dispatch("usage", vec!["help".into()]).is_ok());
        assert!(top_help().contains("usage-events store"), "the usage row describes the store");
    }

    #[test]
    fn an_unmounted_command_is_still_refused() {
        // The counterpart to every "X dispatches" test: adding `cad` must not have widened the
        // fallthrough. An unknown command errors with the overview attached.
        let e = dispatch("cadd", vec![]).unwrap_err();
        assert!(e.contains("unknown command 'cadd'"));
        assert!(e.contains("COMMANDS:"), "the refusal carries the command overview");
    }

    #[test]
    fn teams_and_the_org_alias_both_dispatch() {
        // #2700: `bsc teams` is the primary verb; `bsc org` stays a deprecated alias onto the same
        // store handler (delegating + warning on stderr). Help paths — no store required.
        assert!(dispatch("teams", vec!["help".into()]).is_ok());
        assert!(dispatch("network", vec!["help".into()]).is_ok());
        assert!(dispatch("org", vec!["help".into()]).is_ok());
    }
}
