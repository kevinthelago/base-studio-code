//! The `bsc navigate` subcommand (#3274, epic #3260) — steer the RUNNING app to a view and report what
//! landed, so `bsc shot` can target something rather than photograph whatever is on screen.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc navigate help            # compact menu
//!   bsc navigate component help  # detailed help for ONE command
//!
//! Rides the shared [`bsc_appchan`] transport — the same channel `bsc shot` uses. One dir, one watcher.

use crate::{NavRequest, NavResult, KIND};
use bsc_cli_util::CmdDoc;

const TAGLINE: &str = "steer the RUNNING app to a view — so a capture can target something (#3274)";

/// Navigation is a frontend round-trip (watcher → Tauri event → store → ack), so it is slower than a
/// shot's pure-Rust path but still sub-second when the app is up. The bound exists so a request made
/// with NO app running fails fast instead of hanging a loop iteration.
const DEFAULT_TIMEOUT_MS: i64 = 8_000;
const POLL_INTERVAL_MS: u64 = 40;
const STALE_MS: i64 = 60_000;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "component",
        summary: "focus a Design Studio component (implies its workspace + page)",
        usage: "\
USAGE:
  bsc navigate component <kit> <component> [--theme <id>] [--state <s>] [--timeout <ms>] [--json|--pretty]

Selects a component in the Design Studio and reports the view that landed.

It lands the workspace and page ONLY when the Studio is already showing, or when you pass --workspace /
--page explicitly (#3599). Off the Studio it sets the focus and LEAVES THE USER'S VIEW ALONE — a
background follow-along must not yank someone off the page they are working on. The ack reports the view
that actually landed, so check it rather than assuming.

  --theme <id>   also switch the kit theme, for a themed capture (pairs with `bsc ui theme`)
  --state <s>    render a preview DATA-STATE: loaded · empty · loading — so a capture targets a specific
                 render (e.g. the loading skeleton vs the loaded body) instead of whatever state was pinned

THE POINT
  A shot captures what is on screen. This is what makes a targeted capture race-free:

    bsc navigate component react-d3 Heatmap && bsc shot take
    bsc navigate component react-d3 Heatmap --state loading && bsc shot frame   # capture the skeleton

  navigate does not return until the frontend has APPLIED the change and acked, so the capture cannot
  fire against the previous view.

ERRORS
  An unknown kit/component is an error, not a silent no-op — the reply says what could not be found.
  A capture against a view that never landed is exactly the failure this surface exists to prevent.",
    },
    CmdDoc {
        name: "workspace",
        summary: "switch the rail destination",
        usage: "\
USAGE:
  bsc navigate workspace <id> [--timeout <ms>] [--json]

Rail destinations (registry.ts): console · glance · projects · skills · automation · mcp · github ·
security · settings.",
    },
    CmdDoc {
        name: "page",
        summary: "switch the page within the current workspace",
        usage: "\
USAGE:
  bsc navigate page <id> [--timeout <ms>] [--json]

The PageTabs strip within a Workspace — e.g. under the Planner: projects · teams · designs ·
algorithms · sounds.",
    },
    CmdDoc {
        name: "theme",
        summary: "switch the kit theme (for a themed capture)",
        usage: "\
USAGE:
  bsc navigate theme <id> [--timeout <ms>] [--json]

Switches the live kit theme, so a capture shows the component under it. `bsc ui theme active` reads the
theme from persisted state; this CHANGES it in the running app. Reads: `bsc ui theme get <id>`.",
    },
    CmdDoc {
        name: "show",
        summary: "what the app is showing right now (read-only)",
        usage: "\
USAGE:
  bsc navigate show [--json|--pretty]

Reports the LIVE view — workspace, page, kit, component, theme — without changing anything.

Distinct from reading `app-state.json` (as `bsc ui theme active` does): that is the persisted snapshot
and can lag the running app. This asks the app itself.",
    },
];

/// The preview DATA-STATES `--state` accepts — the navigable subset of the Design Studio's state axis
/// (`error` is a render OUTCOME, not something you request). The frontend bridge validates the SAME set.
const NAV_STATES: &[&str] = &["loaded", "empty", "loading"];

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    theme: Option<String>,
    state: Option<String>,
    timeout_ms: Option<i64>,
    json: bool,
    pretty: bool,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = args.into_iter();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--theme" => a.theme = Some(it.next().ok_or("--theme needs an id")?),
            "--state" => a.state = Some(it.next().ok_or("--state needs a value (loaded|empty|loading)")?),
            "--timeout" => {
                let v = it.next().ok_or("--timeout needs a value in ms")?;
                a.timeout_ms = Some(v.parse().map_err(|_| format!("--timeout: not a number: {v}"))?);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag: {other}")),
            other => a.positional.push(other.to_string()),
        }
    }
    Ok(a)
}

/// Build the request for a parsed command line. Pure — the arg→intent mapping is the part worth testing
/// without a running app.
fn plan(cmd: &str, rest: &[String], theme: Option<String>, state: Option<String>) -> Result<NavRequest, String> {
    // `--state` is a component render axis; it is only meaningful with `component`, and its value is
    // validated up front so a typo fails fast at the CLI rather than as a frontend ack error.
    if let Some(st) = &state {
        if cmd != "component" {
            return Err("--state applies only to `bsc navigate component`".into());
        }
        if !NAV_STATES.contains(&st.as_str()) {
            return Err(format!("--state: unknown state '{st}' — one of: {}", NAV_STATES.join(", ")));
        }
    }
    match cmd {
        "component" => {
            let kit = rest.first().ok_or("usage: bsc navigate component <kit> <component>")?;
            let component = rest.get(1).ok_or("usage: bsc navigate component <kit> <component>")?;
            Ok(NavRequest {
                kit: Some(kit.clone()),
                component: Some(component.clone()),
                theme,
                state,
                ..Default::default()
            })
        }
        "workspace" => {
            let id = rest.first().ok_or("usage: bsc navigate workspace <id>")?;
            Ok(NavRequest { workspace: Some(id.clone()), theme, ..Default::default() })
        }
        "page" => {
            let id = rest.first().ok_or("usage: bsc navigate page <id>")?;
            Ok(NavRequest { page: Some(id.clone()), theme, ..Default::default() })
        }
        "theme" => {
            let id = rest.first().ok_or("usage: bsc navigate theme <id>")?;
            Ok(NavRequest { theme: Some(id.clone()), ..Default::default() })
        }
        "show" => Ok(NavRequest::default()),
        other => Err(format!("unknown command '{other}'")),
    }
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }
    if !COMMANDS.iter().any(|c| c.name == cmd) {
        return Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, &cmd));
    }

    let req = plan(&cmd, &args.positional[1..], args.theme.clone(), args.state.clone())?;
    let res = send(&req, args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
    bsc_cli_util::emit(args.pretty, args.json, &res, || lean(&res));
    Ok(())
}

/// Drop the request, wait for the frontend's ack, return the view that landed.
fn send(req: &NavRequest, timeout: i64) -> Result<NavResult, String> {
    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS);

    let id = bsc_appchan::new_id(now);
    bsc_appchan::write_request(&chan, &id, KIND, now, req)?;

    let reply = bsc_appchan::poll_reply(&chan, &id, timeout, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? `bsc` cannot navigate on its own — the app applies it. \
             `bsc shot pending` shows whether the request landed.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    bsc_appchan::take_payload(reply)
}

fn lean(r: &NavResult) -> String {
    let mut parts = vec![format!("workspace={}", r.workspace)];
    if let Some(p) = &r.page {
        parts.push(format!("page={p}"));
    }
    if let Some(k) = &r.kit {
        parts.push(format!("kit={k}"));
    }
    if let Some(c) = &r.component {
        parts.push(format!("component={c}"));
    }
    if let Some(t) = &r.theme {
        parts.push(format!("theme={t}"));
    }
    if let Some(st) = &r.state {
        parts.push(format!("state={st}"));
    }
    parts.join(" · ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn component_takes_kit_and_component_and_can_carry_a_theme() {
        let r = plan("component", &s(&["react-d3", "Heatmap"]), Some("nord".into()), None).unwrap();
        assert_eq!(r.kit.as_deref(), Some("react-d3"));
        assert_eq!(r.component.as_deref(), Some("Heatmap"));
        assert_eq!(r.theme.as_deref(), Some("nord"));
        // It does NOT hard-code the workspace/page: the app resolves them, so a UI reorg can't strand
        // the CLI pointing at a page that moved.
        assert_eq!(r.workspace, None);
        assert_eq!(r.page, None);
    }

    #[test]
    fn component_carries_a_valid_state_and_rejects_a_bad_one_or_a_misplaced_flag() {
        // A valid state rides on the component request.
        let r = plan("component", &s(&["harvested", "mergequeue"]), None, Some("loading".into())).unwrap();
        assert_eq!(r.component.as_deref(), Some("mergequeue"));
        assert_eq!(r.state.as_deref(), Some("loading"));
        // An unknown state value fails fast at the CLI, naming the allowed set.
        let err = plan("component", &s(&["k", "c"]), None, Some("spinning".into())).unwrap_err();
        assert!(err.contains("loaded") && err.contains("empty") && err.contains("loading"), "{err}");
        // `--state` on a non-component command is refused (it is a component render axis).
        assert!(plan("theme", &s(&["nord"]), None, Some("loading".into())).is_err());
    }

    #[test]
    fn component_without_both_args_is_a_usage_error_not_a_partial_request() {
        assert!(plan("component", &s(&["react-d3"]), None, None).is_err());
        assert!(plan("component", &s(&[]), None, None).is_err());
    }

    #[test]
    fn workspace_page_and_theme_each_set_only_their_own_field() {
        assert_eq!(plan("workspace", &s(&["glance"]), None, None).unwrap().workspace.as_deref(), Some("glance"));
        assert_eq!(plan("page", &s(&["designs"]), None, None).unwrap().page.as_deref(), Some("designs"));
        let t = plan("theme", &s(&["nord"]), None, None).unwrap();
        assert_eq!(t.theme.as_deref(), Some("nord"));
        assert!(t.workspace.is_none() && t.page.is_none() && t.component.is_none());
    }

    #[test]
    fn show_asks_for_nothing_so_the_app_treats_it_as_a_read() {
        let r = plan("show", &s(&[]), None, None).unwrap();
        assert!(r.is_read_only(), "show must not mutate the view it is reporting");
    }

    #[test]
    fn unknown_flags_are_rejected_rather_than_ignored() {
        assert!(parse_args(s(&["component", "--nope"])).is_err());
    }

    #[test]
    fn the_lean_line_names_every_landed_field() {
        let out = lean(&NavResult {
            workspace: "projects".into(),
            page: Some("designs".into()),
            kit: Some("react-d3".into()),
            component: Some("Heatmap".into()),
            theme: Some("nord".into()),
            state: Some("loading".into()),
        });
        assert_eq!(
            out,
            "workspace=projects · page=designs · kit=react-d3 · component=Heatmap · theme=nord · state=loading"
        );
    }

    #[test]
    fn the_lean_line_omits_what_did_not_land() {
        let out = lean(&NavResult {
            workspace: "console".into(),
            page: None,
            kit: None,
            component: None,
            theme: None,
            state: None,
        });
        assert_eq!(out, "workspace=console");
    }
}
