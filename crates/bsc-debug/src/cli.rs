//! The `bsc debug` subcommand (#3437, epic #3260) — INSPECT the running app's live view.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc debug help        # compact menu
//!   bsc debug hit help    # detailed help for ONE command
//!
//! Rides the shared [`bsc_appchan`] transport — the same dir + watcher `bsc shot` and `bsc navigate`
//! use, routed by [`crate::KIND`].

use crate::{DebugRequest, DebugResult, ElementInfo, KIND};
use bsc_cli_util::CmdDoc;

const TAGLINE: &str = "inspect the RUNNING app's live DOM + preview state — read-only (#3437)";

/// Same bound as `navigate`: this is a frontend round-trip, so it fails fast when no app is up rather
/// than hanging a loop iteration.
const DEFAULT_TIMEOUT_MS: i64 = 8_000;
const POLL_INTERVAL_MS: u64 = 40;
const STALE_MS: i64 = 60_000;

const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "hit",
        summary: "what element is at a viewport point — and what is covering it",
        usage: "\
USAGE:
  bsc debug hit <x> <y> [--timeout <ms>] [--json|--pretty]

Reports the TOPMOST element at that point, then each ancestor outward to <html>. Each entry carries its
rect and the computed styles that decide whether a click reaches it: pointer-events, z-index, opacity,
position, transform, cursor, user-select.

THE QUESTION THIS ANSWERS
  \"The element is right there, the rect is correct, and clicking does nothing.\" That is almost always
  something transparent sitting on top — and from outside the app it is invisible. This names it.

  bsc debug hit 900 430        # what is under that pixel, and what owns the click?

PAIRS WITH
  bsc navigate …   to put the right view on screen first (it does not return until the view landed)
  bsc shot take    to see the pixels this is describing",
    },
    CmdDoc {
        name: "probe",
        summary: "rect + event-relevant styles for a CSS selector, and whether it is really clickable",
        usage: "\
USAGE:
  bsc debug probe <selector> [--all] [--timeout <ms>] [--json|--pretty]

Reports the first match (or every match with --all). Beyond the rect and styles, each entry says whether
the element is the TOPMOST hit at its own centre — i.e. whether a click aimed at its middle would land on
it — and names whatever is on top when it is not.

  bsc debug probe '.ds-frame' --all
  bsc debug probe 'iframe' --json

A selector that matches nothing is a RESULT, not an error: the answer is \"nothing matches\".",
    },
    CmdDoc {
        name: "frames",
        summary: "every mounted component-preview iframe: host geometry + the in-iframe engine's own report",
        usage: "\
USAGE:
  bsc debug frames [--timeout <ms>] [--json|--pretty]

One entry per mounted preview, carrying BOTH sides of the boundary:

  host    the iframe's rect + styles + hit-test, whether the pan/zoom engine was REQUESTED for it
          (the `zoomEngine` prop), and whether the built srcdoc actually CONTAINED the engine
  engine  the engine's own reply — is it listening, what transform has it applied, its scale + pan

SEEING INTO THE SANDBOX
  The preview runs at an opaque origin (sandbox=\"allow-scripts\", no allow-same-origin), so the host
  document cannot read it and querySelector stops at the iframe element. That boundary is deliberate and
  is NOT weakened here: the preview is ASKED to describe itself over the postMessage channel the engine
  already listens on, and volunteers the answer.

READING IT
  engine_requested=false           the host never asked for an engine — a wiring bug upstream
  requested but engine_in_srcdoc=false   the builder dropped it — a bug in buildComponentSrcDoc
  in srcdoc but engine absent      the script is there and NOT RUNNING — it threw, or the srcdoc never
                                   loaded. (Absent is distinct from listening:false, which means it ran
                                   and knows it failed.)",
    },
];

#[derive(Debug)]
struct Args {
    positional: Vec<String>,
    all: bool,
    json: bool,
    pretty: bool,
    timeout_ms: Option<i64>,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let (mut positional, mut all, mut json, mut pretty, mut timeout_ms) =
        (Vec::new(), false, false, false, None);
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--all" => all = true,
            "--json" => json = true,
            "--pretty" => pretty = true,
            "--timeout" => {
                let v = it.next().ok_or("--timeout needs a value in ms")?;
                timeout_ms = Some(v.parse::<i64>().map_err(|_| format!("--timeout: not a number: {v}"))?);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag '{other}'")),
            other => positional.push(other.to_string()),
        }
    }
    Ok(Args { positional, all, json, pretty, timeout_ms })
}

/// Build the request from the parsed command. Split out so the argument contract is testable without a
/// running app — the same split `navigate` uses.
fn plan(cmd: &str, rest: &[String], all: bool) -> Result<DebugRequest, String> {
    match cmd {
        "hit" => {
            let x = rest.first().ok_or("usage: bsc debug hit <x> <y>")?;
            let y = rest.get(1).ok_or("usage: bsc debug hit <x> <y>")?;
            Ok(DebugRequest::Hit {
                x: x.parse().map_err(|_| format!("hit: x is not a number: {x}"))?,
                y: y.parse().map_err(|_| format!("hit: y is not a number: {y}"))?,
            })
        }
        "probe" => {
            let selector = rest.first().ok_or("usage: bsc debug probe <selector> [--all]")?;
            Ok(DebugRequest::Probe { selector: selector.clone(), all })
        }
        "frames" => Ok(DebugRequest::Frames),
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

    let req = plan(&cmd, &args.positional[1..], args.all)?;
    let res = send(&req, args.timeout_ms.unwrap_or(DEFAULT_TIMEOUT_MS))?;
    bsc_cli_util::emit(args.pretty, args.json, &res, || lean(&res));
    Ok(())
}

/// Drop the request, wait for the frontend's answer.
fn send(req: &DebugRequest, timeout: i64) -> Result<DebugResult, String> {
    let chan = bsc_appchan::chan_dir()?;
    let now = bsc_util::now_ms();
    let _ = bsc_appchan::sweep_stale(&chan, now, STALE_MS);

    let id = bsc_appchan::new_id(now);
    bsc_appchan::write_request(&chan, &id, KIND, now, req)?;

    let reply = bsc_appchan::poll_reply(&chan, &id, timeout, POLL_INTERVAL_MS, || {
        format!(
            "timed out after {timeout}ms waiting for the app to answer.\n\
             The request is at {}.\n\
             Is the desktop app running? `bsc` cannot inspect on its own — the app answers. \
             `bsc shot pending` shows whether the request landed.",
            bsc_appchan::request_path(&chan, &id).display()
        )
    })?;
    bsc_appchan::take_payload(reply)
}

/// One element as a single line: the label, its rect, and — when it is NOT the thing a click would
/// reach — what is on top instead. The covered case is the reason to run this, so it is never buried.
fn lean_element(e: &ElementInfo, indent: usize) -> String {
    let pad = " ".repeat(indent);
    let [x, y, w, h] = e.rect;
    let mut line = format!("{pad}{} [{x:.0},{y:.0} {w:.0}x{h:.0}]", e.label);
    for key in ["pointer-events", "z-index", "opacity", "cursor"] {
        if let Some(v) = e.styles.get(key) {
            line.push_str(&format!(" {key}={v}"));
        }
    }
    if !e.topmost_at_centre {
        line.push_str(&format!(
            " ⚠ COVERED BY {}",
            e.covered_by.as_deref().unwrap_or("(something)")
        ));
    }
    line
}

fn lean(r: &DebugResult) -> String {
    match r {
        DebugResult::Hit { chain } => {
            if chain.is_empty() {
                return "nothing at that point (outside the window?)".into();
            }
            let mut out = vec![format!("topmost → outward ({} deep)", chain.len())];
            for (i, e) in chain.iter().enumerate() {
                out.push(lean_element(e, i * 2));
            }
            out.join("\n")
        }
        DebugResult::Probe { matched } => {
            if matched.is_empty() {
                return "no element matches that selector".into();
            }
            matched.iter().map(|e| lean_element(e, 0)).collect::<Vec<_>>().join("\n")
        }
        DebugResult::Frames { frames } => {
            if frames.is_empty() {
                return "no component preview is mounted".into();
            }
            frames
                .iter()
                .map(|f| {
                    let engine = match &f.engine {
                        Some(p) => format!(
                            "engine: listening={} scale={:.2} pan=[{:.0},{:.0}] transform={}",
                            p.listening, p.scale, p.pan[0], p.pan[1], p.transform
                        ),
                        // The distinction that matters most, so it is stated, not implied by absence.
                        None if f.engine_in_srcdoc => {
                            "engine: PRESENT IN SRCDOC BUT SILENT — it threw, or the srcdoc never loaded".into()
                        }
                        None => "engine: none".into(),
                    };
                    format!(
                        "{}\n  {}\n  requested={} in_srcdoc={}\n  {engine}",
                        f.component,
                        lean_element(&f.element, 0),
                        f.engine_requested,
                        f.engine_in_srcdoc,
                    )
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    fn el(label: &str, topmost: bool, covered: Option<&str>) -> ElementInfo {
        ElementInfo {
            label: label.into(),
            rect: [10.0, 20.0, 300.0, 40.0],
            styles: [("pointer-events".to_string(), "auto".to_string())].into_iter().collect(),
            topmost_at_centre: topmost,
            covered_by: covered.map(str::to_string),
        }
    }

    #[test]
    fn hit_parses_a_point_and_rejects_a_non_number() {
        assert_eq!(plan("hit", &s(&["900", "430"]), false).unwrap(), DebugRequest::Hit { x: 900.0, y: 430.0 });
        assert!(plan("hit", &s(&["900"]), false).is_err(), "y is required");
        assert!(plan("hit", &s(&["left", "430"]), false).unwrap_err().contains("not a number"));
    }

    #[test]
    fn probe_carries_the_selector_and_the_all_flag() {
        assert_eq!(
            plan("probe", &s(&[".ds-frame"]), true).unwrap(),
            DebugRequest::Probe { selector: ".ds-frame".into(), all: true }
        );
        assert!(plan("probe", &[], false).is_err(), "a selector is required");
    }

    #[test]
    fn frames_takes_no_arguments() {
        assert_eq!(plan("frames", &[], false).unwrap(), DebugRequest::Frames);
    }

    #[test]
    fn an_unknown_command_is_named() {
        assert!(plan("evaluate", &[], false).unwrap_err().contains("evaluate"));
    }

    #[test]
    fn there_is_no_eval_verb() {
        // Guards the read-only contract (#2471): a JS-evaluation verb on this binary would be a back
        // door around the designer role's `bsc ui`-only surface. If someone adds one, this fails.
        for c in COMMANDS {
            assert!(
                !matches!(c.name, "eval" | "exec" | "run" | "js"),
                "`bsc debug` must stay read-only; found an execution verb: {}",
                c.name,
            );
        }
    }

    #[test]
    fn the_lean_hit_output_leads_with_the_coverer() {
        // The one line a human scans for. If an element is covered, that must be impossible to miss.
        let out = lean(&DebugResult::Hit {
            chain: vec![el("div.scrim", true, None), el("iframe#preview", false, Some("div.scrim"))],
        });
        assert!(out.contains("COVERED BY div.scrim"), "names the coverer: {out}");
        assert!(out.contains("topmost → outward (2 deep)"), "states the chain depth: {out}");
    }

    #[test]
    fn an_empty_match_reads_as_an_answer_not_a_failure() {
        assert_eq!(lean(&DebugResult::Probe { matched: vec![] }), "no element matches that selector");
        assert_eq!(lean(&DebugResult::Frames { frames: vec![] }), "no component preview is mounted");
    }

    #[test]
    fn a_silent_engine_is_reported_distinctly_from_absent() {
        let frame = |in_srcdoc: bool, engine: Option<crate::EngineProbe>| crate::FrameInfo {
            component: "invoicespage".into(),
            element: el("iframe", true, None),
            engine_requested: true,
            engine_in_srcdoc: in_srcdoc,
            engine,
        };
        let silent = lean(&DebugResult::Frames { frames: vec![frame(true, None)] });
        assert!(silent.contains("PRESENT IN SRCDOC BUT SILENT"), "the killer distinction: {silent}");

        let none = lean(&DebugResult::Frames { frames: vec![frame(false, None)] });
        assert!(none.contains("engine: none"), "no engine at all reads differently: {none}");

        let live = lean(&DebugResult::Frames {
            frames: vec![frame(
                true,
                Some(crate::EngineProbe { listening: true, transform: "matrix(1,0,0,1,-60,0)".into(), scale: 1.15, pan: [-60.0, 0.0] }),
            )],
        });
        assert!(live.contains("listening=true") && live.contains("scale=1.15"), "a live engine reports itself: {live}");
    }

    #[test]
    fn unknown_flags_are_refused_rather_than_ignored() {
        assert!(parse_args(s(&["hit", "--nope"])).unwrap_err().contains("--nope"));
        assert!(parse_args(s(&["hit", "--timeout", "abc"])).unwrap_err().contains("not a number"));
    }
}
