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
}

const fn active(name: &'static str, summary: &'static str, store: Option<&'static str>) -> Surface {
    Surface { name, summary, store, status: Status::Active }
}
const fn deprecated(name: &'static str, summary: &'static str, store: Option<&'static str>) -> Surface {
    Surface { name, summary, store, status: Status::Deprecated }
}
const fn internal(name: &'static str, summary: &'static str, store: Option<&'static str>) -> Surface {
    Surface { name, summary, store, status: Status::Internal }
}

const COMMANDS: &[Surface] = &[
    active("plan", "per-project plan store: issues, features, fleet, sections", Some("plan.db — per-project, $BSC_PLAN_DB")),
    active("publish", "push a plan's GitHub structure — repos, board, one issue per plan row", Some("plan.db + GitHub")),
    active("errors", "per-project runtime-fault store: fingerprinted errors + alerts", Some("error.db — per-project hub")),
    active("usage", "per-project usage-events store: record + query what users do (epic #3809)", Some("usage.db — per-project hub")),
    active("project", "cross-project hub: list local projects + the .published marker", Some("the project hub list + the .published marker")),
    active("skill", "global skills + task-groups store", Some("skills.db — global")),
    active("compliance", "compliance standards corpus", Some("the packaged compliance corpus")),
    active("atlas", "product feature inventories: domains · products · capabilities (relational)", Some("atlas.db — global")),
    active("blueprint", "user blueprint store", Some("blueprints/ — user")),
    active("persona", "user persona store: agent identities (prompt + skills + model over a role)", Some("personas/ — user")),
    active("sound", "user sound-kit store: synthesized cues (primitives + voices + cues)", Some("sounds/ — user")),
    active("teams", "user teams store: persona-relationship graph (positions + relationships)", Some("orgs/ — user; the on-disk dir keeps its pre-rename name")),
    active("studio", "Studio store: shareable snapshots of the app's library state (save · apply · list · get · remove)", Some("the Studio snapshot store — user")),
    deprecated("org", "DEPRECATED (#2700) → use `bsc teams` (the store, renamed org → teams)", Some("orgs/ — the same store `bsc teams` serves")),
    deprecated("component", "DEPRECATED (#2469) → use `bsc ui` (the component verbs now live there)", Some("the component library — the same store `bsc ui` serves")),
    active("ui", "UI design surface: the primitive contract + themes (#1852) + the component library (#2469) + the released-kit store (release, #2465)", Some("the component library + themes + released kits")),
    active("logs", "unified logs + perf + cost (read-only) + `logs scope` runtime console-scope control", Some("the unified log / perf / cost engine")),
    // #82: this line USED to advertise `read/write/edit/list/info` — four of which have never
    // existed. A designer followed it, ran `bsc files list`, got `unknown command 'list'`, and filed
    // a request for the directory listing that `tree` had been providing all along. An overview that
    // names verbs the CLI lacks is worse than no overview: it is a map to a door that is not there.
    active("files", "read-only file toolkit: tree (folder structure) · stat · read · refs", None),
    active("shot", "capture the RUNNING app's real pixels — a webview snapshot (needs the app running)", None),
    active("navigate", "steer the RUNNING app to a view — so a capture can target something", None),
    active("fleet", "which fleet panes are ACTUALLY alive — real liveness + pid from the running app", None),
    active("sandbox", "a caged session's rendered launch argv: inspect or replay it outside the app (#135)", Some("the pane's sandbox-stores dir — per-session, cleared with the pane")),
    active("session", "the app-owned SYSTEM SESSIONS: start · stop · list (designer, librarian, …)", None),
    active("metrics", "fleet-wide generation scoreboard — $ / tokens / cache-hit / wall-clock per project", Some("the unified log / perf / cost engine")),
    // #command-surface-catalog-is-one-source: `perf` DISPATCHED but was absent from this catalog, so
    // `bsc help` never mentioned it. Same shape as `bsc plan brief` being undiscoverable.
    active("perf", "the FRONTEND instrumentation — render commits, named phases, jank windows, bsc spawns (read-only)", Some("the frontend instrumentation store")),
    active("debug", "inspect the RUNNING app's live DOM + preview state (read-only)", None),
    active("loop", "conversation loop store: two participants exchange turns until a signal ends it, or never (#3262)", Some("the conversation-loop store — user")),
    active("request", "improvement-request store: the designer→debug channel for bsc ui surface gaps (#3295)", Some("the improvement-request store — user")),
    active("runtime", "runtime attestations: which RECORD actually served each module while the app ran", Some("the runtime-attestation store")),
    active("graph", "algorithms knowledge library: per-language implementations (impl list · dump · harvest · curate)", Some("knowledge/algorithms.json — packaged seed + writable store, $BSC_GRAPH_STORE")),
    active("cad", "mesh/SDF geometry kernel (mm): mesh an op-tree spec into a binary STL", None),
    active("data", "canonical data model (DuckDB): model · scan · tables · connector", Some("the canonical data model — DuckDB")),
    active("cve", "vulnerability data (OSV.dev): scan a lockfile · check a package · advisory detail (supply-chain #2433)", Some("the OSV.dev advisory cache")),
    active("surface", "THIS catalog: every bsc command surface as data (list · --json) — one source for help, the node set and drift checks", Some("the command-surface catalog, compiled into this binary")),
    active("mcp", "MCP: the server store (`server`) + the bundled stdio servers (research/compliance/cve)", None),
    internal("hook", "internal PreToolUse deny hooks (run by Claude Code, not by hand)", None),
    // #command-surface-catalog-is-one-source: `serve` (#4152) dispatched but was likewise absent.
    internal("serve", "internal WARM server (#4152) — one long-lived process answering many requests; the desktop spawns it", None),
    active("version", "which build this binary IS — its build time + path (#92, tells a stale sidecar from a missing verb)", None),
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
fn surface_cli(rest: Vec<String>) -> Result<(), String> {
    let verb = rest.first().map(String::as_str).unwrap_or("list");
    match verb {
        "list" => {
            if rest.iter().any(|a| a == "--json") {
                let rows: Vec<serde_json::Value> = COMMANDS
                    .iter()
                    .map(|c| {
                        serde_json::json!({
                            "name": c.name,
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
        "help" | "-h" | "--help" => {
            bsc_cli_util::print_raw(surface_help().trim_end());
            Ok(())
        }
        other => Err(format!("unknown command '{other}'\n\n{}", surface_help())),
    }
}

fn surface_help() -> String {
    String::from(
        "bsc surface — every bsc command surface, as data\n\n\
         USAGE:\n  \
         bsc surface list           # name · status · the store it touches\n  \
         bsc surface list --json    # the catalog as JSON — GENERATE from this, do not restate it\n\n\
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
        "persona" => bsc_persona::cli::run(rest, "bsc persona"),
        // The RELATIONAL corpus store — product feature inventories. Distinct from `bsc data`, which
        // is per-project and whose rows come from connectors scanning a live system.
        "atlas" => atlasdb::cli::run(rest, "bsc atlas"),
        "sound" => bsc_sound::cli::run(rest, "bsc sound"),
        "teams" => bsc_teams::cli::run(rest, "bsc teams"),
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
        "graph" => bsc_graph::cli::run(rest, "bsc graph"),
        "cad" => bsc_cad::cli::run(rest, "bsc cad"),
        #[cfg(feature = "data")]
        "data" => bsc_data::cli::run(rest, "bsc data"),
        "cve" => cve::cli::run(rest, "bsc cve"),
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
        assert!(dispatch("org", vec!["help".into()]).is_ok());
    }
}
