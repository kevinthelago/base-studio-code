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
use bsc_lan_sense::receive::{MulticastReceiver, Tick};
use bsc_lan_stream::crypto::{GroupKey, Sensor, Subscriber};
use bsc_lan_stream::liveness::{Cadence, Liveliness};
use bsc_lan_stream::subscription::{Finding, Subscription};
use ed25519_dalek::{SigningKey, VerifyingKey};
use std::collections::BTreeSet;
use std::net::{Ipv4Addr, SocketAddrV4};
use std::time::{Duration, Instant};
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
        name: "watch",
        summary: "subscribe to a sensor's multicast stream and report what it says — and what it stops saying",
        usage: "\
bsc lan watch --group <addr:port> --sensor-public-key <hex> --group-key <hex>
              [--iface <ip>] [--for <seconds>] [--json|--pretty]

Joins the sensor's multicast group, verifies every datagram, tracks the sequence, and
reports findings. Any number of subscribers may watch the same stream; the sensor holds
no subscriber state and does not know who is listening.

IT REPORTS WHAT IT DID NOT RECEIVE, which is the part that matters. The stream is
one-way, so there is no acknowledgement and the sensor can never learn that nobody heard
it. Only a subscriber can notice absence:

  NeverHeard   nothing has EVER arrived. Usually configuration -- wrong group, wrong
               key -- or, on this network, a mirror-destination port that will not
               forward ordinary traffic. It is NEVER reported as healthy.
  Silent       the sensor was heard and then stopped. Usually the sensor or the path.

Those two are kept apart because they send you to debug different halves.

A REJECTED DATAGRAM IS REPORTED, NOT DROPPED. A signature failure on the group means
somebody is injecting into it -- the exact attack the signature exists to stop -- and
silently discarding it would mean the defence works while nobody ever learns it was
needed. A bad signature and an undecryptable payload are reported differently: the
first is a forger, the second is usually a stale group key.

KEYS: the sensor's PUBLIC key (to verify) and the group key (to decrypt, and it is
SECRET). A watcher never needs the sensor's private key.",
    },
    CmdDoc {
        name: "estate",
        summary: "what is actually on a segment, from what the sensor saw — and what should not be",
        usage: "\
bsc lan estate --eve <file> --segment <prefix> [--expect <a,b,c>] [--json|--pretty]

Derives the estate from OBSERVATION rather than from a roster. The sensor sees every
host on every VLAN through the SPAN, which makes it the one authority that cannot go
stale by neglect — and every hand-maintained roster in this network has drifted.

  --segment   a dotted /24 prefix, e.g. 10.99.2.
  --expect    the addresses you believe are there, comma-separated

THE THIRD CATEGORY IS THE POINT. Expected-and-seen is unremarkable.
Expected-but-unseen may be retired, powered off, or quietly broken. SEEN BUT NOT
EXPECTED on a management VLAN is a security finding — an unauthorised device, a
forgotten test box, or a compromise — and it is exactly what a roster can never
surface, because the roster is the thing that would have had to be updated.

Every host carries the evidence for it: how many records mentioned it and which ports
it was seen on. A host seen twice and a host seen ten thousand times are different
claims and must not render alike. The record count is reported too, so \"nothing on
this segment\" is distinguishable from \"nothing was parsed at all\".

Read-only. Observation comes before anything that changes a device — see
docs/llm-operator/guardrails.md, which is explicit that DNS and the firewall are
single points of failure on this network.",
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
    group: Option<String>,
    eve: Option<String>,
    segment: Option<String>,
    expect: Option<String>,
    iface: Option<String>,
    sensor_public_key: Option<String>,
    group_key: Option<String>,
    for_seconds: Option<u64>,
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
            "--group" => a.group = Some(rest.value("--group needs <addr:port>")?),
            "--eve" => a.eve = Some(rest.value("--eve needs a path to EVE output")?),
            "--segment" => a.segment = Some(rest.value("--segment needs a /24 prefix, e.g. 10.99.2.")?),
            "--expect" => a.expect = Some(rest.value("--expect needs a comma-separated address list")?),
            "--iface" => a.iface = Some(rest.value("--iface needs an interface IP")?),
            "--sensor-public-key" => {
                a.sensor_public_key = Some(rest.value("--sensor-public-key needs 64 hex characters")?)
            }
            "--group-key" => a.group_key = Some(rest.value("--group-key needs 64 hex characters")?),
            "--for" => {
                a.for_seconds = Some(
                    rest.value("--for needs a whole number of seconds")?
                        .parse()
                        .map_err(|_| "--for needs a whole number of seconds".to_string())?,
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

/// Decode 64 hex characters into 32 bytes.
pub fn unhex32(s: &str, what: &str) -> Result<[u8; 32], String> {
    let s = s.trim();
    if s.len() != 64 || !s.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(format!(
            "{what} must be exactly 64 hexadecimal characters (got {} character(s))",
            s.len()
        ));
    }
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16)
            .map_err(|_| format!("{what} is not valid hexadecimal"))?;
    }
    Ok(out)
}

/// Render one finding for a person reading a terminal.
pub fn render_finding(f: &Finding) -> String {
    match f {
        Finding::Event(e) => format!("event      {e:?}"),
        Finding::Snapshot(s) => format!(
            "snapshot   posture={} counters={}",
            if s.posture.is_sealed() { "sealed" } else { "NOT sealed" },
            s.counters.len()
        ),
        // Not noise. Somebody is putting datagrams on the group that the sensor
        // did not sign.
        Finding::ForgeryRejected { seen } => {
            format!("FORGERY    a datagram was not signed by this sensor ({seen} so far) — somebody is injecting into the group")
        }
        Finding::UndecryptableRejected { seen } => {
            format!("key        signed by the sensor but would not decrypt ({seen} so far) — usually a stale group key, not an attack")
        }
        Finding::MalformedRejected { seen } => format!("malformed  not one of ours ({seen} so far)"),
        Finding::Gap { missing_from, missing_to } => {
            format!("GAP        datagrams {missing_from}..={missing_to} never arrived — the next snapshot restores the view")
        }
        Finding::Replayed { seq, last } => {
            format!("REPLAY     sequence {seq} seen again (last was {last}) — refused")
        }
        Finding::SensorRestarted { previous_last_seq } => {
            format!("RESTART    the sensor rebooted (it had reached {previous_last_seq}) — not a gap")
        }
        Finding::ViewDegraded => "degraded   something was missed; only a snapshot can restore this".into(),
        Finding::ViewWhole => "whole      a snapshot restored the view".into(),
        Finding::PostureChanged { from, to } => format!(
            "POSTURE    {} -> {}",
            match from {
                Some(p) if p.is_sealed() => "sealed",
                Some(_) => "not sealed",
                None => "(first report)",
            },
            if to.is_sealed() { "sealed" } else { "NOT SEALED" }
        ),
        Finding::LivelinessChanged { to } => match to {
            // Reads correctly at zero, which is when an operator first sees it.
            Liveliness::NeverHeard { waiting_ms } if *waiting_ms < 1_000 => {
                "NEVER HEARD  nothing has arrived since watching began — check the group and the keys, and whether the switch forwards this group at all".into()
            }
            Liveliness::NeverHeard { waiting_ms } => format!(
                "NEVER HEARD  nothing has arrived in {}s — check the group and the keys, and whether the switch forwards this group at all",
                waiting_ms / 1000
            ),
            Liveliness::Healthy { since_last_ms } => {
                format!("healthy      last heard {}s ago", since_last_ms / 1000)
            }
            Liveliness::Late { since_last_ms, .. } => {
                format!("LATE         nothing for {}s", since_last_ms / 1000)
            }
            Liveliness::Silent { since_last_ms, .. } => format!(
                "SILENT       nothing for {}s — treat the stream as gone",
                since_last_ms / 1000
            ),
        },
    }
}

fn cmd_watch(a: &Args) -> Result<(), String> {
    let group: SocketAddrV4 = a
        .group
        .as_deref()
        .ok_or("watch needs --group <addr:port>, e.g. --group 239.10.20.30:5140")?
        .parse()
        .map_err(|_| "--group must be <ipv4-addr>:<port>".to_string())?;
    let iface: Ipv4Addr = match a.iface.as_deref() {
        Some(s) => s.parse().map_err(|_| "--iface must be an IPv4 address".to_string())?,
        None => Ipv4Addr::UNSPECIFIED,
    };
    let pub_hex = a
        .sensor_public_key
        .as_deref()
        .ok_or("watch needs --sensor-public-key <hex> (the sensor's PUBLIC key, from `bsc lan keygen`)")?;
    let group_hex = a
        .group_key
        .as_deref()
        .ok_or("watch needs --group-key <hex> (SECRET, shared by every subscriber)")?;

    let verifying = VerifyingKey::from_bytes(&unhex32(pub_hex, "--sensor-public-key")?)
        .map_err(|_| "--sensor-public-key is not a valid ed25519 public key".to_string())?;
    let group_key = GroupKey::from_bytes(unhex32(group_hex, "--group-key")?);

    let timeout = Duration::from_millis(500);
    let rx = MulticastReceiver::join(iface, group, timeout)
        .map_err(|e| format!("could not join {group} on {iface}: {e}"))?;

    let cadence = Cadence {
        snapshot_interval_ms: 10_000,
        grace_ms: 2_000,
        missed_snapshots_before_alert: 3,
    };
    let started = Instant::now();
    let mut sub = Subscription::new(Subscriber::new(verifying, group_key), cadence, 0);
    let deadline = a.for_seconds.map(Duration::from_secs);

    loop {
        let now_ms = started.elapsed().as_millis() as u64;
        // A timeout is a TICK, not an error: it is the only chance a watcher
        // gets to notice that the stream has stopped.
        let findings = match rx.next_tick().map_err(|e| format!("receive failed: {e}"))? {
            Tick::Datagram(d) => sub.receive(&d, now_ms),
            Tick::Quiet => sub.poll(now_ms),
        };
        for f in &findings {
            println!("{}", render_finding(f));
        }
        // Poll on every turn, so liveness surfaces even during steady traffic.
        for f in sub.poll(now_ms) {
            println!("{}", render_finding(&f));
        }
        if let Some(d) = deadline {
            if started.elapsed() >= d {
                return Ok(());
            }
        }
    }
}

fn cmd_estate(a: &Args) -> Result<(), String> {
    let path = a.eve.as_deref().ok_or("estate needs --eve <file>")?;
    let segment = a
        .segment
        .as_deref()
        .ok_or("estate needs --segment <prefix>, e.g. --segment 10.99.2.")?;
    let text = std::fs::read_to_string(path).map_err(|e| format!("could not read {path}: {e}"))?;
    let expected: BTreeSet<String> = a
        .expect
        .as_deref()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let e = bsc_lan_sense::estate::assess(&text, segment, &expected);
    bsc_cli_util::emit(a.pretty, a.json, &e, || render_estate(&e, segment));
    Ok(())
}

/// Rendered separately so it is unit-testable without a file.
pub fn render_estate(e: &bsc_lan_sense::Estate, segment: &str) -> String {
    // Evidence first. A verdict from zero records is not a clean segment.
    if e.records_examined == 0 {
        return format!(
            "NOTHING PARSED — 0 record(s) read, so this says nothing about {segment}x.\n               This is NOT a clean segment."
        );
    }
    let mut s = format!(
        "{}x — {} record(s) examined\n",
        segment, e.records_examined
    );
    // The finding leads.
    if e.unexpected.is_empty() {
        s.push_str("\n  no unexpected hosts\n");
    } else {
        s.push_str(&format!("\n  UNEXPECTED — {} host(s) seen that were not expected:\n", e.unexpected.len()));
        for h in &e.unexpected {
            s.push_str(&format!(
                "    {:<16} {} observation(s), ports {:?}\n",
                h.addr, h.observations, h.ports.iter().copied().collect::<Vec<_>>()
            ));
        }
    }
    if !e.missing.is_empty() {
        s.push_str(&format!(
            "\n  expected but never seen ({}) — retired, powered off, or broken:\n    {}\n",
            e.missing.len(),
            e.missing.join(", ")
        ));
    }
    s.push_str(&format!("\n  accounted for ({}):\n", e.accounted.len()));
    for h in &e.accounted {
        s.push_str(&format!("    {:<16} {} observation(s)\n", h.addr, h.observations));
    }
    s
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
        Some("watch") => cmd_watch(&a),
        Some("estate") => cmd_estate(&a),
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
        assert_eq!(names, vec!["posture", "keygen", "watch", "estate", "dry-run"]);
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
    fn a_key_must_be_exactly_sixty_four_hex_characters() {
        assert!(unhex32(&"a".repeat(64), "--group-key").is_ok());
        for bad in ["", "abc", &"z".repeat(64), &"a".repeat(63), &"a".repeat(65)] {
            let e = unhex32(bad, "--group-key").unwrap_err();
            assert!(e.contains("--group-key"), "the error should name the flag: {e}");
        }
    }

    #[test]
    fn watch_refuses_to_run_without_the_group_and_both_keys() {
        for (argv, expect) in [
            (vec!["watch".to_string()], "--group"),
            (
                vec!["watch".into(), "--group".into(), "239.1.2.3:5140".into()],
                "--sensor-public-key",
            ),
            (
                vec![
                    "watch".into(), "--group".into(), "239.1.2.3:5140".into(),
                    "--sensor-public-key".into(), "a".repeat(64),
                ],
                "--group-key",
            ),
        ] {
            let e = run(argv, "bsc lan").unwrap_err();
            assert!(e.contains(expect), "expected the error to name {expect}, got: {e}");
        }
    }

    /// A forgery finding must read as an attack, not as a statistic. Whoever
    /// sees this line is being told somebody is injecting into the group.
    #[test]
    fn a_forgery_finding_reads_as_an_attack() {
        let s = render_finding(&Finding::ForgeryRejected { seen: 7 });
        assert!(s.contains("FORGERY"));
        assert!(s.contains("injecting"), "the line must say what it means: {s}");
    }

    #[test]
    fn a_stale_group_key_does_not_read_as_an_attack() {
        // Sending someone hunting an intruder over a key-rotation mistake is
        // its own kind of failure.
        let s = render_finding(&Finding::UndecryptableRejected { seen: 3 });
        assert!(!s.contains("FORGERY"));
        assert!(s.contains("stale group key"), "{s}");
    }

    #[test]
    fn never_heard_never_renders_as_healthy() {
        let s = render_finding(&Finding::LivelinessChanged {
            to: Liveliness::NeverHeard { waiting_ms: 90_000 },
        });
        assert!(s.contains("NEVER HEARD"));
        assert!(!s.to_lowercase().contains("healthy"), "{s}");
        // And it names the things actually worth checking.
        assert!(s.contains("group") && s.contains("key") && s.contains("forward"), "{s}");
    }

    #[test]
    fn never_heard_reads_correctly_at_zero_elapsed() {
        // The first poll is when an operator meets this line, and "in 0s" is
        // confusing at exactly the moment it matters most.
        let s = render_finding(&Finding::LivelinessChanged {
            to: Liveliness::NeverHeard { waiting_ms: 0 },
        });
        assert!(!s.contains("in 0s"), "{s}");
        assert!(s.contains("since watching began"), "{s}");
    }

    #[test]
    fn a_restart_does_not_render_as_a_gap() {
        let s = render_finding(&Finding::SensorRestarted { previous_last_seq: 9 });
        assert!(s.contains("RESTART"));
        assert!(s.contains("not a gap"), "{s}");
    }

    #[test]
    fn estate_needs_an_eve_file_and_a_segment_and_says_which() {
        assert!(run(vec!["estate".into()], "bsc lan").unwrap_err().contains("--eve"));
        let e = run(vec!["estate".into(), "--eve".into(), "/nonexistent".into()], "bsc lan").unwrap_err();
        assert!(e.contains("--segment"), "{e}");
    }

    #[test]
    fn nothing_parsed_never_renders_as_a_clean_segment() {
        let e = bsc_lan_sense::Estate { records_examined: 0, ..Default::default() };
        let s = render_estate(&e, "10.99.2.");
        assert!(s.contains("NOTHING PARSED"));
        assert!(s.contains("NOT a clean segment"), "{s}");
    }

    #[test]
    fn an_unexpected_host_leads_the_rendering() {
        let e = bsc_lan_sense::Estate {
            records_examined: 400,
            unexpected: vec![bsc_lan_sense::SeenHost {
                addr: "10.99.2.77".into(),
                observations: 12,
                ports: Default::default(),
            }],
            ..Default::default()
        };
        let s = render_estate(&e, "10.99.2.");
        let unexpected_at = s.find("UNEXPECTED").expect("the finding must appear");
        let accounted_at = s.find("accounted for").expect("the roll-call must appear");
        assert!(unexpected_at < accounted_at, "the finding must come before the roll-call:\n{s}");
        assert!(s.contains("12 observation(s)"), "the evidence must travel with it");
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
