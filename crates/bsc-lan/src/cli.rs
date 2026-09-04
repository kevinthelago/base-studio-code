//! `bsc lan` — the verbs.
//!
//! Deliberately ships only what does not depend on the unresolved egress
//! question. Whether the sensor can transmit from `eth0` turns on whether the
//! switch forwards ingress on a mirror destination port, which is unverified.
//! A `sense` verb that actually transmits cannot be written honestly until
//! that is settled, and a verb that half-works is worse than one that is
//! absent — so it is not here.

use bsc_cli_util::{args, CmdDoc};
use bsc_lan_sense::emit::{Emitter, SnapshotPolicy};
use bsc_lan_sense::posture::Posture;
use bsc_lan_sense::run::{RateLimit, SensorRun};
use bsc_lan_sense::transport::Transport;
use bsc_lan_stream::crypto::{GroupKey, Sensor};
use ed25519_dalek::SigningKey;
use serde_json::json;

pub const TAGLINE: &str =
    "the emit-only LAN sensor — what this host exposes, its keys, and what it would send";

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "posture",
        summary: "what THIS host exposes to the network",
        usage: "\
bsc lan posture [--json|--pretty]

Reads /proc/net/{tcp,tcp6,udp,udp6} and reports whether anything on this host is
reachable from the network. Needs no root and no key.

WHY IT EXISTS AS A COMMAND. The sensor attests its own posture into its telemetry
stream, because nobody can log into it — it accepts nothing inbound and is updated by
swapping its SD card. But self-attestation has a hard limit: a COMPROMISED sensor
controls what it attests, and can report itself sealed while listening. This verb is
how a person checks a host's reachability independently of what that host claims about
itself.

A LISTENER ON LOOPBACK IS NOT A WAY IN, and is reported separately from one bound to a
wildcard or routable address. A socket with a peer is an outbound conversation, not a
listening surface — the sensor's own emitter looks exactly like that, and conflating
the two would have the sensor report itself exposed for transmitting.

IT REPORTS 'unknown' RATHER THAN A CLEAN VERDICT when it cannot read the tables or no
longer understands their format. A parser that has silently stopped matching finds no
listeners, which is indistinguishable from a hardened box — so the row count that
justified the verdict is carried with it.",
    },
    CmdDoc {
        name: "keygen",
        summary: "the sensor signing key and the group key",
        usage: "\
bsc lan keygen [--json|--pretty]

Generates the two keys the stream needs, from the OS CSPRNG.

TWO KEYS, BECAUSE THEY DO DIFFERENT JOBS:
  signing key   the SENSOR's private key. It signs every datagram. Only the sensor
                has it. Its public half goes to every subscriber.
  group key     shared by every subscriber, and provides CONFIDENTIALITY only.

The split is the reason a subscriber cannot forge. With a shared key alone, any
subscriber could fabricate a sensor alert that every other subscriber accepts — and
that gets worse with each device added, which is exactly backwards when the goal is to
have everything subscribe. Signed means a compromised subscriber can READ the stream
but never write to it.

KEYS ARE PRINTED, NEVER WRITTEN. A keygen that drops a private key into a file leaves
it wherever the shell happened to be; placing it is the operator's decision, made
deliberately. Both the signing key and the group key are SECRET — the group key is the
confidentiality half, not a public identifier.",
    },
    CmdDoc {
        name: "dry-run",
        summary: "what the sensor WOULD emit for a real EVE file, without a socket",
        usage: "\
bsc lan dry-run <eve-file> [--rate <n>] [--burst <n>] [--json|--pretty]

Drives the real sensor loop over real Suricata EVE output and reports what would go on
the wire. Opens no socket and sends nothing, so it is safe to run anywhere, including
against a copy of a live sensor's log.

WHAT IT IS FOR. It validates the parser and the rate limiter against real traffic
before anything is deployed. Both have failure modes that only real data exposes: an
EVE line whose fields are longer than a datagram can carry, and an alert volume high
enough that the sensor would become an amplifier against its own network.

THE SUPPRESSION COUNT IS THE NUMBER TO READ. Emission is rate-bounded, because alert
volume is chosen by whoever is generating the traffic. A file that reports a large
suppressed count is telling you the cap would bite on this workload — which is the cap
working, not a fault, but it is worth knowing before the sensor is somewhere you
cannot reach.",
    },
];

#[derive(Default)]
struct Args {
    json: bool,
    pretty: bool,
    rate: Option<u32>,
    burst: Option<u32>,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, rest| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--rate" => {
                a.rate = Some(
                    rest.value("--rate needs a whole number of datagrams per second")?
                        .parse()
                        .map_err(|_| "--rate needs a whole number".to_string())?,
                );
            }
            "--burst" => {
                a.burst = Some(
                    rest.value("--burst needs a whole number of datagrams")?
                        .parse()
                        .map_err(|_| "--burst needs a whole number".to_string())?,
                );
            }
            // Anything else is not ours: `walk` refuses unknown `--` flags
            // itself and treats the rest as positionals.
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

/// 32 bytes from the OS CSPRNG.
fn secret_bytes() -> Result<[u8; 32], String> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|e| format!("could not read the OS random source: {e}"))?;
    Ok(b)
}

/// `addr:port`, bracketing IPv6 so the colons are unambiguous.
fn endpoint(addr: &str, port: u16) -> String {
    if addr.contains(':') {
        format!("[{addr}]:{port}")
    } else {
        format!("{addr}:{port}")
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn cmd_posture(a: &Args) -> Result<(), String> {
    let p = bsc_lan_sense::assess_host();
    bsc_cli_util::emit(a.pretty, a.json, &p, || render_posture(&p));
    Ok(())
}

/// Rendered separately so it is unit-testable without touching the host.
pub fn render_posture(p: &Posture) -> String {
    match p {
        Posture::Sealed { loopback_listeners, rows_examined } => {
            let mut s = format!(
                "SEALED — nothing on this host is reachable from the network ({rows_examined} socket row(s) examined)"
            );
            if !loopback_listeners.is_empty() {
                s.push_str(&format!(
                    "\n  {} loopback listener(s), not a way in:",
                    loopback_listeners.len()
                ));
                for l in loopback_listeners {
                    s.push_str(&format!("\n    {}", endpoint(&l.local_addr, l.local_port)));
                }
            }
            s
        }
        Posture::Exposed { reachable, rows_examined } => {
            let mut s = format!(
                "EXPOSED — {} socket(s) reachable from the network ({rows_examined} row(s) examined)",
                reachable.len()
            );
            for r in reachable {
                s.push_str(&format!("\n    {}  {:?}", endpoint(&r.local_addr, r.local_port), r.transport));
            }
            s
        }
        // Not a pass. On a host that cannot be inspected any other way,
        // "I cannot tell" is the alertable answer.
        Posture::Unknown { reason } => {
            format!("UNKNOWN — could not determine this host's posture: {reason}\n  This is NOT a clean result.")
        }
    }
}

fn cmd_keygen(a: &Args) -> Result<(), String> {
    let signing = SigningKey::from_bytes(&secret_bytes()?);
    let group = secret_bytes()?;
    let out = json!({
        "sensor_signing_key_SECRET": hex(&signing.to_bytes()),
        "sensor_public_key": hex(signing.verifying_key().as_bytes()),
        "group_key_SECRET": hex(&group),
    });
    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        format!(
            "sensor signing key (SECRET — the sensor only)\n  {}\n\n\
             sensor public key (give this to every subscriber)\n  {}\n\n\
             group key (SECRET — every subscriber, confidentiality only)\n  {}\n\n\
             Not written to any file. Place these deliberately.",
            hex(&signing.to_bytes()),
            hex(signing.verifying_key().as_bytes()),
            hex(&group),
        )
    });
    Ok(())
}

/// The `timestamp` field of one EVE line, in epoch milliseconds.
fn eve_timestamp(line: &str) -> Option<i64> {
    let v: serde_json::Value = serde_json::from_str(line).ok()?;
    bsc_lan_sense::eve::parse_timestamp_ms(v.get("timestamp")?.as_str()?)
}

/// A transport that counts instead of sending. `dry-run` opens no socket.
#[derive(Default)]
struct Counting {
    datagrams: std::cell::RefCell<Vec<usize>>,
}

impl Transport for Counting {
    fn send(&self, datagram: &[u8]) -> std::io::Result<()> {
        self.datagrams.borrow_mut().push(datagram.len());
        Ok(())
    }
}

fn cmd_dry_run(a: &Args) -> Result<(), String> {
    let path = a
        .positional
        .get(1)
        .ok_or_else(|| "dry-run needs an EVE file: bsc lan dry-run <eve-file>".to_string())?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {e}"))?;

    let limit = RateLimit {
        per_second: a.rate.unwrap_or(RateLimit::conservative().per_second),
        burst: a.burst.unwrap_or(RateLimit::conservative().burst),
    };

    // Ephemeral keys: nothing is transmitted, and a dry run must never need
    // the real sensor key to be present on whatever box is running it.
    let sensor = Sensor::new(
        SigningKey::from_bytes(&secret_bytes()?),
        GroupKey::from_bytes(secret_bytes()?),
        [0u8; 16],
    );
    let mut run = SensorRun::new(
        Emitter::new(sensor, Counting::default(), SnapshotPolicy { interval_ms: 10_000 }),
        limit,
        0,
    );

    // REPLAY AT THE FILE'S OWN CADENCE, from each event's timestamp.
    //
    // Feeding every line at t=0 was the first implementation and it produced a
    // badly misleading number: 3000 lines of live output reported 2712
    // suppressed, because the token bucket never refilled. Those events
    // actually spanned 777 seconds — 3.9/s, comfortably under the cap, so the
    // true answer was that NOTHING would be suppressed. A reader would have
    // concluded the limiter was far too tight and loosened the one control
    // protecting the network from the sensor.
    //
    // A line with no parseable timestamp reuses the previous one rather than
    // resetting the clock, so a malformed line cannot rewind the replay.
    let mut lines = 0u64;
    let mut origin: Option<i64> = None;
    let mut now_ms = 0u64;
    let mut undated = 0u64;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        lines += 1;
        match eve_timestamp(line) {
            Some(ts) => {
                let base = *origin.get_or_insert(ts);
                now_ms = ts.saturating_sub(base).max(0) as u64;
            }
            None => undated += 1,
        }
        run.on_eve_line(line, now_ms).map_err(|e| format!("emit failed: {e}"))?;
    }
    let span_ms = now_ms;

    let c = run.counters();
    let bytes: usize = run.emitter().transport().datagrams.borrow().iter().sum();
    let rate = if span_ms > 0 {
        c.eve.forwarded as f64 * 1000.0 / span_ms as f64
    } else {
        0.0
    };
    let out = json!({
        "lines": lines,
        "span_seconds": span_ms / 1000,
        "events_per_second": (rate * 10.0).round() / 10.0,
        "undated_lines": undated,
        "forwarded": c.eve.forwarded,
        "not_forwarded": c.eve.not_forwarded,
        "malformed": c.eve.malformed,
        "emitted": c.emitted,
        "suppressed": c.suppressed,
        "bytes_on_the_wire": bytes,
        "rate_per_second": limit.per_second,
        "burst": limit.burst,
    });
    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        let mut s = format!(
            "{lines} line(s) read over {}s ({:.1} events/sec)\n  {} parsed into events\n  \
             {} of a type this sensor does not forward\n  {} malformed\n\n\
             {} datagram(s) would go on the wire ({bytes} bytes)\n  {} suppressed by the {}/s cap (burst {})",
            span_ms / 1000, rate,
            c.eve.forwarded, c.eve.not_forwarded, c.eve.malformed,
            c.emitted, c.suppressed, limit.per_second, limit.burst
        );
        if undated > 0 {
            s.push_str(&format!(
                "\n\n{undated} line(s) carried no parseable timestamp and were replayed at the \n\
                 previous event's time, so the cadence above is approximate for those."
            ));
        }
        if c.suppressed > 0 {
            s.push_str(
                "\n\nThe cap bit on this workload. That is the limiter working — alert volume is\n\
                 chosen by whoever generates the traffic, so the ceiling is ours — but the\n\
                 suppressed count is what a subscriber would see, and it is worth knowing before\n\
                 the sensor is somewhere you cannot reach.",
            );
        }
        s
    });
    Ok(())
}

pub fn run(argv: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(argv)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("posture") => cmd_posture(&a),
        Some("keygen") => cmd_keygen(&a),
        Some("dry-run") => cmd_dry_run(&a),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_lan_sense::procnet::{Protocol, Reach, Role, Socket};

    #[test]
    fn every_command_is_documented_so_a_verb_cannot_be_added_silently() {
        for c in COMMANDS {
            assert!(!c.summary.is_empty(), "{} has no summary", c.name);
            assert!(c.usage.contains(c.name), "{}'s usage does not name it", c.name);
        }
        let names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["posture", "keygen", "dry-run"]);
    }

    #[test]
    fn help_renders_and_an_unknown_verb_is_refused() {
        assert!(run(vec!["help".into()], "bsc lan").is_ok());
        let e = run(vec!["nope".into()], "bsc lan").unwrap_err();
        assert!(e.contains("nope"), "the error should name what was typed: {e}");
    }

    #[test]
    fn posture_runs_against_the_live_host_and_never_reports_unknown_as_clean() {
        assert!(run(vec!["posture".into(), "--json".into()], "bsc lan").is_ok());
    }

    #[test]
    fn an_unknown_posture_renders_as_explicitly_not_clean() {
        let p = Posture::Unknown {
            reason: bsc_lan_sense::ProcNetError::Empty,
        };
        let s = render_posture(&p);
        assert!(s.contains("UNKNOWN"));
        assert!(s.contains("NOT a clean result"), "an unknown verdict must not read as a pass");
    }

    #[test]
    fn an_exposed_posture_names_every_reachable_socket() {
        let p = Posture::Exposed {
            reachable: vec![Socket {
                transport: Protocol::Tcp,
                role: Role::Inbound,
                reach: Reach::Wildcard,
                local_port: 22,
                local_addr: "0.0.0.0".into(),
            }],
            rows_examined: 40,
        };
        let s = render_posture(&p);
        assert!(s.contains("EXPOSED"));
        assert!(s.contains("0.0.0.0:22"));
    }

    /// Key material from a fixed or time-seeded source is the kind of mistake
    /// that stays invisible until it is catastrophic.
    #[test]
    fn keygen_is_not_deterministic() {
        let a = secret_bytes().unwrap();
        let b = secret_bytes().unwrap();
        assert_ne!(a, b, "two keygen runs produced identical key material");
        assert_ne!(a, [0u8; 32], "key material was all zeroes");
    }

    #[test]
    fn keygen_runs() {
        assert!(run(vec!["keygen".into(), "--json".into()], "bsc lan").is_ok());
    }

    /// Asserted against the SOURCE rather than by watching the filesystem: a
    /// test that counts files in the working directory cannot tell a keygen
    /// that wrote nothing from one that wrote somewhere else, and key material
    /// landing in an unexpected place is exactly the failure worth preventing.
    /// On this box that could be any of thirty worktrees.
    #[test]
    fn no_command_in_this_module_writes_a_file() {
        // Only the command implementations, not the test module below: the
        // tests legitimately write fixture files, and a scanner that cannot
        // tell the two apart reports a fault in its own scaffolding.
        let whole = include_str!("cli.rs");
        let src = whole.split("\n#[cfg(test)]").next().unwrap_or(whole);
        for writer in ["fs::write", "File::create", "OpenOptions", "fs::copy"] {
            let hit = src.lines().any(|l| {
                let t = l.trim_start();
                !t.starts_with("//") && !t.starts_with("///") && l.contains(writer)
            });
            assert!(
                !hit,
                "cli.rs calls `{writer}`. Key material is PRINTED, never written -- placing it \
                 is the operator's decision, made deliberately."
            );
        }
        // The scanner must be reading the command code, or its silence proves
        // nothing -- and it must have actually stopped before the tests.
        assert!(src.len() > 4000, "the source scan read only {} bytes", src.len());
        assert!(src.len() < whole.len(), "the scan did not stop at the test module");
        assert!(src.contains("fn cmd_keygen"), "the scan did not reach the command it guards");
    }

    /// The defect this guards against shipped once: dry-run fed every line at
    /// t=0, so the token bucket never refilled and 3000 lines of live output
    /// reported 2712 suppressed. The events actually spanned 777 seconds --
    /// 3.5/s, well under the cap -- so the true answer was zero. A reader would
    /// have loosened the one control protecting the network from the sensor.
    #[test]
    fn dry_run_replays_at_the_files_cadence_rather_than_collapsing_it_to_an_instant() {
        let dir = std::env::temp_dir().join(format!("bsc-lan-cadence-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let ev = |ts: &str| format!(
            r#"{{"timestamp":"{ts}","event_type":"alert","src_ip":"10.0.0.1","dest_ip":"10.0.0.2","alert":{{"signature_id":1,"signature":"X","severity":2}}}}"#
        );

        // 60 events spread one second apart: well under a 20/s cap.
        let spread: Vec<String> = (0..60)
            .map(|i| ev(&format!("2026-09-04T12:{:02}:{:02}.000000-0400", i / 60, i % 60)))
            .collect();
        let spread_file = dir.join("spread.json");
        std::fs::write(&spread_file, spread.join("\n")).unwrap();

        // The same 60 events, all at the identical instant.
        let burst: Vec<String> = (0..60).map(|_| ev("2026-09-04T12:00:00.000000-0400")).collect();
        let burst_file = dir.join("burst.json");
        std::fs::write(&burst_file, burst.join("\n")).unwrap();

        let count = |f: &std::path::Path| -> (u64, u64) {
            let text = std::fs::read_to_string(f).unwrap();
            let sensor = Sensor::new(
                SigningKey::from_bytes(&[3u8; 32]),
                GroupKey::from_bytes([7u8; 32]),
                [0u8; 16],
            );
            let mut run = SensorRun::new(
                Emitter::new(sensor, Counting::default(), SnapshotPolicy { interval_ms: 10_000 }),
                RateLimit { per_second: 20, burst: 20 },
                0,
            );
            let (mut origin, mut now) = (None::<i64>, 0u64);
            for line in text.lines() {
                if let Some(ts) = eve_timestamp(line) {
                    let base = *origin.get_or_insert(ts);
                    now = ts.saturating_sub(base).max(0) as u64;
                }
                run.on_eve_line(line, now).unwrap();
            }
            (run.counters().emitted, run.counters().suppressed)
        };

        let (spread_emitted, spread_suppressed) = count(&spread_file);
        assert_eq!(spread_suppressed, 0, "events one second apart must not be throttled");
        assert_eq!(spread_emitted, 60);

        let (_, burst_suppressed) = count(&burst_file);
        assert!(
            burst_suppressed > 0,
            "60 events at one instant must be throttled -- if this is 0 the timestamps are \
             being ignored and the replay has collapsed back to a single moment"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn an_ipv6_endpoint_is_bracketed_so_the_colons_are_unambiguous() {
        assert_eq!(endpoint("::", 41719), "[::]:41719");
        assert_eq!(endpoint("0.0.0.0", 22), "0.0.0.0:22");
    }

    #[test]
    fn dry_run_needs_a_file_and_says_so() {
        let e = run(vec!["dry-run".into()], "bsc lan").unwrap_err();
        assert!(e.contains("eve-file"), "the error should say what is missing: {e}");
    }

    #[test]
    fn dry_run_reports_what_would_be_emitted_and_what_the_cap_suppressed() {
        let dir = std::env::temp_dir().join(format!("bsc-lan-dryrun-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("eve.json");
        let alert = r#"{"event_type":"alert","src_ip":"10.99.4.66","dest_ip":"10.99.2.1","alert":{"signature_id":1,"signature":"ET SCAN","severity":2}}"#;
        let body = std::iter::repeat_n(alert, 100).collect::<Vec<_>>().join("\n");
        std::fs::write(&f, body).unwrap();

        // A cap far below the input, so suppression must be visible.
        assert!(run(
            vec![
                "dry-run".into(),
                f.to_string_lossy().into_owned(),
                "--rate".into(), "1".into(),
                "--burst".into(), "1".into(),
                "--json".into(),
            ],
            "bsc lan"
        )
        .is_ok());
        std::fs::remove_dir_all(&dir).ok();
    }
}
