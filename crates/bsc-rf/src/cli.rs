//! `bsc rf` — the command surface.

use bsc_cli_util::{args, CmdDoc};
use serde_json::json;

use crate::detect::{self, Baseline, Level};
use crate::device::Tristate;
use crate::survey::{channel_for, SurveyReading};

pub const TAGLINE: &str = "defensive RF monitoring — detect jamming from the radio's own telemetry";

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "devices",
        summary: "every wireless radio: driver, rfkill, monitor + spectral capability",
        usage: "\
bsc rf devices [--json|--pretty]

Enumerates every wireless interface from sysfs. Needs no root.

Reports the states that MIMIC broken hardware rather than only the states that are:
  rfkill    a SOFT block makes a working adapter look dead — no LED, 'unavailable',
            every interface down. Cleared with `nmcli radio wifi on`, no root needed.
  link      an UP but unassociated interface shows operstate 'down'. That is normal.
  spectral  whether real FFT bins are reachable, and if not WHY — silicon that never
            had the feature is a different problem from a kernel built without the path,
            and only the second is fixed by a module rebuild.

A capability that cannot be determined reads as 'unknown', never as 'no'.",
    },
    CmdDoc {
        name: "survey",
        summary: "one channel-occupancy reading (Tier 1)",
        usage: "\
bsc rf survey [--iface <name>] [--json|--pretty]

One nl80211 survey reading: per channel, how long the radio was there, how long the
medium was busy, and how much of that busy time decoded into frames.

A SINGLE reading proves very little — the counters are cumulative since the interface
came up, so they describe an average since boot rather than now. Use `bsc rf watch` for
a verdict; this is for inspecting what the driver reports at all.

NOT ALL DRIVERS SUPPORT THIS. A driver with no get_survey op returns nothing, and this
command says 'unsupported' rather than reporting a quiet channel — measured on both
ath9k_htc and rtw89.",
    },
    CmdDoc {
        name: "watch",
        summary: "sample occupancy over time and score it for jamming",
        usage: "\
bsc rf watch [--iface <name>] [--interval <sec>] [--count <n>] [--noise-baseline <dbm>]
             [--json|--pretty]

Samples the survey counters repeatedly, differences consecutive samples, and scores each
interval. Because the counters are cumulative, the FIRST sample only establishes a
reference — verdicts start at the second.

The discrimination it exists for:
  congested  the medium is saturated AND most of that busy time decodes into frames.
             Loud, not hostile. Congestion is made of frames.
  jamming    the medium is saturated and almost NONE of it decodes. Energy without
             traffic is not a state ordinary congestion can produce.
  suspect    between the two — worse than congestion explains, short of conclusive.
  unknown    the driver cannot report receive time, so energy cannot be separated from
             traffic on this radio. NOT the same as 'clear'.

--noise-baseline gives the scorer a known-clean noise floor to state elevation against.
Without it the noise signal is reported as having no reference rather than assumed.",
    },
];

#[derive(Default, Debug)]
struct Args {
    json: bool,
    pretty: bool,
    iface: Option<String>,
    interval: u64,
    count: u64,
    noise_baseline: Option<i32>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let base = Args { interval: 2, count: 0, ..Default::default() };
    let (mut a, positional) = args::walk(raw, base, |flag, a: &mut Args, rest| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--iface" => a.iface = Some(rest.value("--iface needs an interface name")?),
            "--interval" => {
                a.interval = rest
                    .value("--interval needs a whole number of seconds")?
                    .parse()
                    .map_err(|_| "--interval needs a whole number of seconds".to_string())?;
            }
            "--count" => {
                a.count = rest
                    .value("--count needs a whole number of intervals")?
                    .parse()
                    .map_err(|_| "--count needs a whole number of intervals".to_string())?;
            }
            "--noise-baseline" => {
                a.noise_baseline = Some(
                    rest.value("--noise-baseline needs a noise floor in dBm, e.g. -95")?
                        .parse()
                        .map_err(|_| "--noise-baseline needs a noise floor in dBm, e.g. -95".to_string())?,
                );
            }
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    if a.interval == 0 {
        return Err("--interval must be at least 1 second".into());
    }
    a.positional = positional;
    Ok(a)
}

/// The interface to work on: the one named, else the first monitor-capable radio, else the first
/// radio at all. Refuses rather than picking arbitrarily when there are none.
fn resolve_iface(a: &Args) -> Result<String, String> {
    if let Some(i) = &a.iface {
        return Ok(i.clone());
    }
    let devices = crate::probe::enumerate();
    if devices.is_empty() {
        return Err("no wireless interfaces found — `bsc rf devices` shows what the kernel sees".into());
    }
    let pick = devices
        .iter()
        .find(|d| d.monitor_capable == Tristate::Yes)
        .or_else(|| devices.first())
        .expect("non-empty");
    Ok(pick.iface.clone())
}

fn cmd_devices(a: &Args) -> Result<(), String> {
    let devices = crate::probe::enumerate();

    bsc_cli_util::emit(a.pretty, a.json, &json!({ "devices": &devices }), || {
        if devices.is_empty() {
            return "no wireless interfaces found (a netdev is wireless iff it has a phy80211 link)".into();
        }
        let mut out = Vec::new();
        for d in &devices {
            out.push(format!("{}  [{}]", d.iface, d.phy.as_deref().unwrap_or("no phy")));
            out.push(format!("  driver     {}", d.driver.as_deref().unwrap_or("∅")));
            out.push(format!(
                "  mac        {}{}",
                d.mac.as_deref().unwrap_or("∅"),
                d.permanent_mac
                    .as_deref()
                    .map(|p| format!("  (randomized; permanent {p})"))
                    .unwrap_or_default()
            ));
            out.push(format!(
                "  link       {}, operstate {}",
                if d.up { "UP" } else { "DOWN" },
                d.operstate.as_deref().unwrap_or("∅")
            ));
            out.push(format!(
                "  rfkill     {}",
                match d.rfkill.remedy() {
                    Some(r) => r.to_string(),
                    None => "not blocked".into(),
                }
            ));
            out.push(format!("  monitor    {}", d.monitor_capable.as_str()));
            out.push(format!("  spectral   {}", d.spectral.explain()));
            if let Some(b) = d.blocker() {
                out.push(format!("  BLOCKED    {b}"));
            }
            out.push(String::new());
        }
        out.join("\n")
    });
    Ok(())
}

/// Render one survey reading, keeping the unsupported case distinct from an empty one.
fn render_survey(r: &SurveyReading) -> String {
    match r {
        SurveyReading::Unsupported => "\
survey UNSUPPORTED — this driver has no get_survey op, so nl80211 returned nothing.

That is NOT a quiet channel. Tier 1 occupancy is unavailable on this radio; use
monitor-mode frame statistics instead."
            .to_string(),
        SurveyReading::Channels(chans) if chans.is_empty() => {
            "the driver answered but reported no channels — the radio may not have visited one yet \
             (try a scan first)"
                .to_string()
        }
        SurveyReading::Channels(chans) => {
            let n = |v: Option<u64>| v.map(|x| x.to_string()).unwrap_or_else(|| "∅".into());
            let mut lines = vec!["freq\tch\tin_use\tnoise\tactive_ms\tbusy_ms\trx_ms\ttx_ms".to_string()];
            lines.extend(chans.iter().map(|c| {
                format!(
                    "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                    c.frequency_mhz,
                    channel_for(c.frequency_mhz).map(|x| x.to_string()).unwrap_or_else(|| "∅".into()),
                    if c.in_use { "*" } else { "" },
                    c.noise_dbm.map(|x| x.to_string()).unwrap_or_else(|| "∅".into()),
                    n(c.active_ms),
                    n(c.busy_ms),
                    n(c.rx_ms),
                    n(c.tx_ms),
                )
            }));
            lines.push("\n∅ = the driver did not report this counter — absent, not zero".into());
            lines.join("\n")
        }
    }
}

fn cmd_survey(a: &Args) -> Result<(), String> {
    let iface = resolve_iface(a)?;
    let reading = crate::probe::survey(&iface).ok_or_else(|| {
        "could not run `iw` — install it (Debian: `sudo apt install iw`; it lands in /usr/sbin)".to_string()
    })?;
    bsc_cli_util::emit(a.pretty, a.json, &json!({ "iface": &iface, "survey": &reading }), || {
        format!("{iface}\n{}", render_survey(&reading))
    });
    Ok(())
}

fn cmd_watch(a: &Args) -> Result<(), String> {
    let iface = resolve_iface(a)?;
    let baseline = a.noise_baseline.map(|n| Baseline { frequency_mhz: 0, noise_dbm: Some(n) });

    let first = crate::probe::survey(&iface).ok_or_else(|| {
        "could not run `iw` — install it (Debian: `sudo apt install iw`; it lands in /usr/sbin)".to_string()
    })?;
    if matches!(first, SurveyReading::Unsupported) {
        return Err(format!(
            "{iface}: this driver has no get_survey op, so channel-occupancy monitoring is unavailable \
             on this radio. That is a driver limitation, not a quiet channel — use monitor-mode frame \
             statistics instead. `bsc rf devices` shows which radios you have."
        ));
    }

    if !a.json && !a.pretty {
        println!("watching {iface} every {}s — the first sample only sets a reference", a.interval);
    }

    let mut prev = first.in_use().cloned();
    let mut done = 0u64;
    loop {
        std::thread::sleep(std::time::Duration::from_secs(a.interval));

        let Some(reading) = crate::probe::survey(&iface) else { continue };
        let Some(cur) = reading.in_use().cloned() else { continue };

        if let Some(p) = &prev {
            // A refused delta (channel change, counter reset) is skipped, never scored — see
            // `detect::delta`. Silence here is correct: there is nothing to report about an
            // interval we cannot measure.
            if let Some(d) = detect::delta(p, &cur) {
                let mut b = baseline;
                if let Some(bl) = b.as_mut() {
                    bl.frequency_mhz = d.frequency_mhz;
                }
                let v = detect::score(&d, b);

                bsc_cli_util::emit(a.pretty, a.json, &json!({"iface": &iface, "verdict": &v}), || {
                    let mark = match v.level {
                        Level::Jamming => "!!",
                        Level::Suspect => "! ",
                        Level::Unknown => "? ",
                        _ => "  ",
                    };
                    let ch = channel_for(v.frequency_mhz)
                        .map(|c| format!("ch{c}"))
                        .unwrap_or_else(|| format!("{}MHz", v.frequency_mhz));
                    let fired: Vec<_> =
                        v.signals.iter().filter(|s| s.fired).map(|s| s.name).collect();
                    format!(
                        "{mark}{ch}\t{}\t{}{}",
                        v.level.as_str(),
                        v.summary,
                        if fired.is_empty() { String::new() } else { format!("  [{}]", fired.join(", ")) }
                    )
                });
            }
        }
        prev = Some(cur);

        done += 1;
        if a.count > 0 && done >= a.count {
            return Ok(());
        }
    }
}

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(args)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("devices") => cmd_devices(&a),
        Some("survey") => cmd_survey(&a),
        Some("watch") => cmd_watch(&a),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_sane_and_interval_zero_is_refused() {
        let a = parse_args(vec!["watch".into()]).unwrap();
        assert_eq!(a.interval, 2);
        assert_eq!(a.count, 0, "0 means run until interrupted");
        assert!(parse_args(vec!["watch".into(), "--interval".into(), "0".into()]).is_err());
    }

    #[test]
    fn flags_parse() {
        let a = parse_args(vec![
            "watch".into(),
            "--iface".into(),
            "wlan0".into(),
            "--interval".into(),
            "5".into(),
            "--noise-baseline".into(),
            "-95".into(),
            "--json".into(),
        ])
        .unwrap();
        assert_eq!(a.iface.as_deref(), Some("wlan0"));
        assert_eq!(a.interval, 5);
        assert_eq!(a.noise_baseline, Some(-95));
        assert!(a.json);
    }

    #[test]
    fn a_bad_number_is_refused_with_a_usable_message() {
        let e = parse_args(vec!["watch".into(), "--interval".into(), "soon".into()]).unwrap_err();
        assert!(e.contains("whole number"), "the refusal must say what a good value looks like");
    }

    /// The unsupported case must render as a driver limitation with the alternative named — never
    /// as a quiet channel. This is the absent-vs-zero rule at the point a human reads it.
    #[test]
    fn unsupported_renders_as_a_limitation_not_a_clear_channel() {
        let text = render_survey(&SurveyReading::Unsupported);
        assert!(text.contains("UNSUPPORTED"));
        assert!(text.contains("NOT a quiet channel"), "the misreading must be pre-empted explicitly");
        assert!(text.contains("monitor-mode"), "and the alternative named");
    }

    /// A driver that answered with no channels is a DIFFERENT situation from one with no survey op,
    /// and the two must not render alike.
    #[test]
    fn an_empty_channel_list_is_distinct_from_unsupported() {
        let empty = render_survey(&SurveyReading::Channels(vec![]));
        let unsupported = render_survey(&SurveyReading::Unsupported);
        assert_ne!(empty, unsupported);
        assert!(!empty.contains("UNSUPPORTED"));
    }

    #[test]
    fn absent_counters_render_as_absent_not_zero() {
        let r = SurveyReading::Channels(vec![crate::survey::ChannelSurvey {
            frequency_mhz: 2437,
            in_use: true,
            noise_dbm: None,
            active_ms: None,
            busy_ms: None,
            rx_ms: None,
            tx_ms: None,
            ext_busy_ms: None,
        }]);
        let text = render_survey(&r);
        assert!(text.contains('∅'), "an absent counter must not render as 0");
        assert!(!text.contains("\t0\t"), "nothing here was measured as zero");
    }

    #[test]
    fn every_command_has_help_and_the_catalog_is_covered() {
        for c in COMMANDS {
            assert!(!c.usage.is_empty(), "{} has no usage text", c.name);
            assert!(!c.summary.is_empty(), "{} has no summary", c.name);
        }
        // The dispatch and the catalog must agree — an advertised command that does not dispatch is
        // the surface lying about itself.
        let names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["devices", "survey", "watch"]);
        for name in names {
            let e = run(vec![name.into(), "--iface".into(), "definitely-not-a-real-iface-xyz".into()], "bsc rf");
            // It may fail for want of hardware, but it must NOT fail as an unknown command.
            if let Err(msg) = e {
                assert!(!msg.contains("unknown command"), "{name} is advertised but does not dispatch");
            }
        }
    }

    #[test]
    fn an_unknown_command_is_refused_with_the_menu() {
        let e = run(vec!["jam".into()], "bsc rf").unwrap_err();
        assert!(e.contains("jam"));
        assert!(e.contains("devices"), "the refusal shows what does exist");
    }
}
