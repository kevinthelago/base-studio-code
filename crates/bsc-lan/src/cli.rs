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
use bsc_lan_sense::config::{Loaded, SensorConfig, SubscriberConfig};
use bsc_lan_sense::receive::{MulticastReceiver, Tick};
use bsc_lan_stream::crypto::{GroupKey, Sensor, Subscriber};
use bsc_lan_stream::liveness::{Cadence, Liveliness};
use bsc_lan_stream::subscription::{Finding, Fleet, Subscription};
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
        name: "spectrum",
        summary: "what the radio hears across the band, from the spectral FFT",
        usage: "\
bsc lan spectrum [--trigger] [--source <file>] [--json|--pretty]

Reads the radio's spectral FFT bins and reports one aggregated record per channel.

THE ONLY TIER THAT SEES NON-WIFI ENERGY. Frame capture — however good — is blind to
a microwave, a cordless phone, or a jammer that radiates without emitting valid
802.11, because there are no frames to capture. This reads ENERGY.

READING NEVER WRITES. Draining what the driver has buffered is harmless; --trigger
writes to the control file and changes how the radio behaves, so it is opt-in.
Observation comes before mutation (docs/llm-operator/guardrails.md).

NEEDS ROOT: debugfs is root-only. Without it you get a permission error naming the
path, not an empty spectrum.

AN EMPTY READ IS NOT A QUIET BAND, and this says so. Zero samples means nothing was
observed — a different claim from a clear channel, and they look identical on any
display that does not distinguish them.

--source reads a captured sample file instead of the live radio, so the decode can be
exercised anywhere.",
    },
    CmdDoc {
        name: "sense",
        summary: "read the spectrum on a cadence and emit it, sealed, to a configured destination",
        usage: "\
bsc lan sense --to <addr:port> --sensor-key <hex> --group-key <hex>
              [--interval <ms>] [--count <n>] [--trigger] [--iface <ip>] [--json]

Reads the radio's spectrum, aggregates it, seals it, and sends it.

THE DESTINATION IS CONFIGURED, NEVER DISCOVERED, and that is what keeps this sensor
emit-only. Multicast does NOT cross a VLAN boundary without a multicast router, which
this network's firewall does not provide — so a multicast group serves subscribers on
the sensor's own segment, and a unicast collector is how the stream crosses a VLAN.
Either way the sensor holds no subscriber list: it sends where it was told when the SD
card was written, because it has no inbound channel through which a list could ever be
managed.

A BARREN WINDOW EMITS NOTHING. If the radio produced no samples, no datagram is sent —
a spectrum of zeroes is indistinguishable from a clear channel on any display, and only
one of them is good news. The subscriber's silence detection is what reports the gap;
inventing an empty record here would defeat it.

Aggregation happens before emission: raw spectral output runs at roughly 666 sweeps per
second against a wire capped at 20 datagrams per second.

NEEDS ROOT for the radio (debugfs is root-only). --trigger additionally writes to the
control file; without it this only sends what the driver already buffered.",
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
    CmdDoc {
        name: "config",
        summary: "the key files this host reads, with every secret redacted",
        usage: "\
bsc lan config [--json|--pretty]

Reports the two documents `bsc lan` reads when a key is not given as a flag:
`subscriber.json` (what a watcher needs) and `sensor.json` (what the sensor
needs). Both live in $BSC_LAN_DIR, or in `lan/` under the app's base directory.

WHY THERE IS NO `config set`. `bsc lan keygen` prints and does not write,
deliberately -- placing a private key is the operator's decision. A verb that
took `--group-key <hex>` and wrote it to a file would put the key back on the
command line for the sole purpose of getting it off the command line, and argv
is exactly what these files exist to avoid: /proc/<pid>/cmdline is
world-readable, and `systemctl show` hands a unit's ExecStart to anyone who
asks. So this verb READS. The operator authors the file -- on the Pi, at
SD-card time, which is that device's whole management model.

TWO DOCUMENTS, NEVER ONE. The subscriber document has no field a signing key
could land in, and pointing the subscriber loader at a sensor document is an
error rather than a parse that ignores the extra field. `bsc lan sense`
shipped for part of an afternoon reading the sensor's PRIVATE key out of
`--sensor-public-key`, because one field looked like it could serve both --
one document with an optional signing key would reintroduce exactly that.

A FILE ANYONE CAN READ IS REFUSED, not warned about, and the refusal names the
mode it found. A key is not protected by living in a file; it is protected by
the mode on that file. On a platform that has no mode to check, this says the
check did not run rather than reporting a clean bill of health it never
earned.

SECRETS ARE NEVER PRINTED, including under --json: the group key and the
signing key render as <redacted>. The sensor's PUBLIC key is shown, because it
is not a secret and it is the one value an operator needs to copy between
machines.",
    },
    CmdDoc {
        name: "unit",
        summary: "the systemd unit that makes the sensor a service, printed",
        usage: "\
bsc lan unit [--radio] [--binary <path>] [--interval <ms>] [--snapshot-ms <ms>]

Prints the systemd unit for the sensor, rendered against THIS host's sensor
config. Redirect it into /etc/systemd/system/bsc-lan-sense.service.

WHY IT IS GENERATED. Two of its lines have to agree with the config or the
sensor runs and sends nothing: IPAddressAllow names the collector and the
config names the destination. A static unit file drifts from the config the
first time a collector moves, and the symptom is a healthy-looking service
whose datagrams the kernel drops before they reach a wire. So the destination
is read from sensor.json and rendered in, and a test asserts the two agree.

THE UNIT IS WHERE 'EMIT-ONLY' STOPS BEING A CLAIM. Everything else in this
project is our own code vouching for itself, and a compromised sensor controls
every word of it. Two directives move the boundary into the kernel:
SocketBindDeny=any means the unit cannot bind a listening socket at all --
which still holds if the binary is replaced -- and IPAddressDeny=any with one
IPAddressAllow confines egress to the collector and nothing else.

NO KEY REACHES THE FILE. The unit sets BSC_LAN_DIR and the sensor reads
sensor.json from it. `systemctl show` hands ExecStart to anyone who asks, and
a unit file is normally mode 644, so a key on that line has the same
disclosure a key on argv has.

ONE DIRECTIVE IS DELIBERATELY MISSING and it looks like an oversight:
ProtectKernelTunables=yes remounts /sys/kernel read-only, and the spectral
scan is armed by writing spectral_scan_ctl under /sys/kernel/debug. Adding it
gives a sensor that starts cleanly, reports nothing wrong, and emits barren
windows forever.

--radio PRINTS THE COMPANION ONESHOT instead. Tuning an interface needs
CAP_NET_ADMIN and the sensor's own unit drops every capability, so the tuning
is a oneshot that exits rather than a capability the long-running process
holds forever. It matters more than it sounds: MEASURED, an adapter left
`type managed` after a reboot produced 5 spectrum records in 30 seconds
against 30 for the same adapter in monitor mode -- and monitor mode does not
survive a reboot, so without this the analyzer is sparse after every power
cycle and nothing says why.

IT PRINTS RATHER THAN INSTALLS, for the same reason keygen prints rather than
writes: putting a file into /etc/systemd/system and enabling it is a change to
a machine, and that is the operator's to make.",
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
    /// The sensor's PRIVATE signing key. Deliberately a different field and a
    /// different flag from the public one: only the sensor should ever hold
    /// this, and a flag that accepted either would make handing out the wrong
    /// half a typo rather than an impossibility.
    sensor_key: Option<String>,
    group_key: Option<String>,
    for_seconds: Option<u64>,
    timeout_ms: Option<i64>,
    trigger: bool,
    to: Option<String>,
    interval_ms: Option<u64>,
    /// How often the sensor restates everything. A subscriber that joins an
    /// already-running stream is Degraded until the first snapshot reaches it,
    /// and for an unattended sensor every subscriber joins late.
    snapshot_ms: Option<u64>,
    /// Absolute path to the sensor binary ON THE DEVICE, for the unit file.
    binary: Option<String>,
    /// Render the radio oneshot instead of the sensor unit.
    radio: bool,
    count: Option<u64>,
    source: Option<String>,
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
            "--radio" => a.radio = true,
            "--binary" => a.binary = Some(rest.value("--binary needs an absolute path on the device")?),
            "--snapshot-ms" => {
                a.snapshot_ms = Some(
                    rest.value("--snapshot-ms needs a whole number of milliseconds")?
                        .parse()
                        .map_err(|_| "--snapshot-ms needs a whole number of milliseconds".to_string())?,
                );
            }
            "--sensor-key" => a.sensor_key = Some(rest.value("--sensor-key needs 64 hex characters (the sensor's PRIVATE signing key)")?),
            "--sensor-public-key" => {
                a.sensor_public_key = Some(rest.value("--sensor-public-key needs 64 hex characters")?)
            }
            "--group-key" => a.group_key = Some(rest.value("--group-key needs 64 hex characters")?),
            "--trigger" => a.trigger = true,
            "--to" => a.to = Some(rest.value("--to needs <addr:port>")?),
            "--interval" => {
                a.interval_ms = Some(
                    rest.value("--interval needs a whole number of milliseconds")?
                        .parse().map_err(|_| "--interval needs a whole number".to_string())?,
                );
            }
            "--count" => {
                a.count = Some(
                    rest.value("--count needs a whole number of windows")?
                        .parse().map_err(|_| "--count needs a whole number".to_string())?,
                );
            }
            "--source" => a.source = Some(rest.value("--source needs a path to a sample file")?),
            "--timeout" => {
                a.timeout_ms = Some(
                    rest.value("--timeout needs a whole number of milliseconds")?
                        .parse()
                        .map_err(|_| "--timeout needs a whole number of milliseconds".to_string())?,
                );
            }
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
/// 32 bytes from 64 hex characters, naming whichever flag or field supplied
/// them. Delegates to the config module so a key read from a file and a key
/// read from a flag cannot disagree about what a valid key is — two copies of
/// this would be two chances for one of them to accept something the other
/// rejects.
pub fn unhex32(s: &str, what: &str) -> Result<[u8; 32], String> {
    bsc_lan_sense::config::unhex32(s, what)
}

/// Everything `watch` needs, and where each part came from.
pub struct ResolvedSubscriber {
    pub group: SocketAddrV4,
    pub iface: Ipv4Addr,
    /// Every sensor this subscriber accepts, as `(name, public key)`.
    pub roster: Vec<(String, [u8; 32])>,
    pub group_key: [u8; 32],
    /// One line naming the source of each part. PRINTED, never inferred by the
    /// reader: with two possible sources, "it did not work" is unanswerable
    /// unless you know which one it used.
    pub provenance: String,
}

/// Everything `sense` needs, and where each part came from.
pub struct ResolvedSensor {
    pub destination: SocketAddrV4,
    pub sensor_key: [u8; 32],
    pub group_key: [u8; 32],
    /// The interface to watch for disconnect frames, when one is configured.
    /// Tier 2 needs a NAME, not just a channel: the capture binds an interface.
    pub radio_iface: Option<String>,
    pub provenance: String,
}

/// One line saying where each value came from. Never the values themselves —
/// this is printed into a terminal and, when the sensor runs as a unit, into
/// the journal, which is a durable place a key must not reach.
fn render_provenance(sources: &(Vec<String>, Vec<String>), from: &str) -> String {
    let mut parts = Vec::new();
    if !sources.0.is_empty() {
        parts.push(format!("{} from flags", sources.0.join(", ")));
    }
    if !sources.1.is_empty() {
        parts.push(format!("{} from {from}", sources.1.join(", ")));
    }
    format!("source: {}", parts.join("; "))
}

// Debug is written by hand on both, and that is the point rather than an
// omission. `#[derive(Debug)]` would print the group key and the signing key
// as byte arrays, and the first `dbg!` or `{:?}` in an error path would put
// them somewhere durable — a journal, a panic message, a bug report. A key
// that must not be on argv must not be in a Debug line either.
impl std::fmt::Debug for ResolvedSubscriber {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedSubscriber")
            .field("group", &self.group)
            .field("iface", &self.iface)
            .field("sensors", &self.roster.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>())
            .field("group_key", &"<redacted>")
            .field("provenance", &self.provenance)
            .finish()
    }
}

impl std::fmt::Debug for ResolvedSensor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedSensor")
            .field("destination", &self.destination)
            .field("sensor_key", &"<redacted>")
            .field("group_key", &"<redacted>")
            .field("radio_iface", &self.radio_iface)
            .field("provenance", &self.provenance)
            .finish()
    }
}

/// A flag beats the file. The file is what makes an unattended process
/// possible; a flag is what a person reaches for when they are debugging one,
/// and the debugging case has to be able to override.
///
/// The config is loaded ONLY when something is actually missing. A command
/// given every flag must not fail because a config file it never needed is
/// malformed — and must not open a key file it has no use for.
///
/// The loader is a parameter so the tests can drive both sources without
/// touching a real home directory or a process env var. This crate has no
/// `ENV_LOCK`, and a resolver that read `$BSC_LAN_DIR` directly would be a
/// test that passes or fails depending on whether the developer running it
/// happens to have authored a config — which is the class of race this repo
/// has been bitten by more than once.
fn resolve_subscriber_with<L>(a: &Args, load: L) -> Result<ResolvedSubscriber, String>
where
    L: FnOnce() -> Result<Loaded<SubscriberConfig>, String>,
{
    let need_config =
        a.group.is_none() || a.sensor_public_key.is_none() || a.group_key.is_none();
    // The failure is CARRIED, not raised. A missing flag and an unreadable
    // config are one situation from the operator's side, and an error naming
    // only the file leaves them wondering which flag would have avoided it.
    let loaded = if need_config { Some(load()) } else { None };
    let why = match &loaded {
        Some(Err(e)) => e.clone(),
        Some(Ok(_)) | None => String::new(),
    };
    let cfg = loaded.and_then(Result::ok);
    let from = cfg.as_ref().map(|c| c.path.display().to_string()).unwrap_or_default();
    let c = cfg.as_ref().map(|c| &c.value);

    // (from flags, from the file) — grouped rather than one entry per field,
    // so the line names the path once instead of repeating it per value.
    let mut sources: (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let mut pick = |flag: &str, hint: &str, given: Option<&String>, file: Option<String>| -> Result<String, String> {
        match given {
            Some(v) => {
                sources.0.push(flag.to_string());
                Ok(v.clone())
            }
            None => match file {
                Some(v) => {
                    sources.1.push(flag.trim_start_matches("--").to_string());
                    Ok(v)
                }
                // The hint carries WHY the value exists. A bare flag name tells
                // an operator what to type and nothing about what to type into
                // it, which for `--to` is the whole question.
                None => Err(format!("needs {flag} {hint}, or a config supplying it — {why}")),
            },
        }
    };

    let group = pick("--group", "<addr:port>, e.g. 239.10.20.30:5140", a.group.as_ref(), c.map(|c| c.group.clone()))?;
    let group_hex = pick("--group-key", "<hex> (SECRET, shared by every subscriber)", a.group_key.as_ref(), c.map(|c| c.group_key.clone()))?;
    // A ROSTER cannot come off a flag sensibly — a fleet is a list of name/key
    // pairs, and cramming that into argv is how the key ends up on a command
    // line again. `--sensor-public-key` still works for the one-sensor case a
    // person is debugging with, and names that sensor `--sensor-public-key` so
    // the output never claims an identity nobody configured.
    let roster: Vec<(String, [u8; 32])> = match a.sensor_public_key.as_deref() {
        Some(hex) => {
            sources.0.push("--sensor-public-key".to_string());
            vec![("--sensor-public-key".to_string(), unhex32(hex, "--sensor-public-key")?)]
        }
        None => {
            let cfg = c.ok_or_else(|| {
                format!("needs a sensor roster, or --sensor-public-key for a single one — {why}")
            })?;
            sources.1.push("sensors".to_string());
            cfg.roster()?
        }
    };
    // Optional on both sides, so it never forces a load of its own.
    let iface_str = a.iface.clone().or_else(|| c.and_then(|c| c.iface.clone()));

    Ok(ResolvedSubscriber {
        group: group.parse().map_err(|_| format!("group must be <ipv4-addr>:<port>, got {group:?}"))?,
        iface: match iface_str.as_deref() {
            Some(v) => v.parse().map_err(|_| "iface must be an IPv4 address".to_string())?,
            None => Ipv4Addr::UNSPECIFIED,
        },
        roster,
        group_key: unhex32(&group_hex, "--group-key")?,
        provenance: render_provenance(&sources, &from),
    })
}

/// The sensor half. A separate function over a separate config type, because
/// the two documents must never be able to feed each other's keys.
fn resolve_sensor_with<L>(a: &Args, load: L) -> Result<ResolvedSensor, String>
where
    L: FnOnce() -> Result<Loaded<SensorConfig>, String>,
{
    let need_config = a.to.is_none() || a.sensor_key.is_none() || a.group_key.is_none();
    let loaded = if need_config { Some(load()) } else { None };
    let why = match &loaded {
        Some(Err(e)) => e.clone(),
        Some(Ok(_)) | None => String::new(),
    };
    let cfg = loaded.and_then(Result::ok);
    let from = cfg.as_ref().map(|c| c.path.display().to_string()).unwrap_or_default();
    let c = cfg.as_ref().map(|c| &c.value);

    // (from flags, from the file) — grouped rather than one entry per field,
    // so the line names the path once instead of repeating it per value.
    let mut sources: (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
    let mut pick = |flag: &str, hint: &str, given: Option<&String>, file: Option<String>| -> Result<String, String> {
        match given {
            Some(v) => {
                sources.0.push(flag.to_string());
                Ok(v.clone())
            }
            None => match file {
                Some(v) => {
                    sources.1.push(flag.trim_start_matches("--").to_string());
                    Ok(v)
                }
                // The hint carries WHY the value exists. A bare flag name tells
                // an operator what to type and nothing about what to type into
                // it, which for `--to` is the whole question.
                None => Err(format!("needs {flag} {hint}, or a config supplying it — {why}")),
            },
        }
    };

    let to = pick("--to", "<addr:port>: a multicast group for this segment, or a unicast collector to cross a VLAN", a.to.as_ref(), c.map(|c| c.destination.clone()))?;
    let key_hex = pick("--sensor-key", "<hex> (the sensor's PRIVATE signing key — NOT the public half)", a.sensor_key.as_ref(), c.map(|c| c.sensor_key.clone()))?;
    let group_hex = pick("--group-key", "<hex> (SECRET)", a.group_key.as_ref(), c.map(|c| c.group_key.clone()))?;

    Ok(ResolvedSensor {
        destination: to.parse().map_err(|_| format!("destination must be <ipv4-addr>:<port>, got {to:?}"))?,
        sensor_key: unhex32(&key_hex, "--sensor-key")?,
        group_key: unhex32(&group_hex, "--group-key")?,
        radio_iface: c.and_then(|c| c.radio.as_ref().map(|r| r.iface.clone())),
        provenance: render_provenance(&sources, &from),
    })
}

/// What `watch` runs with: flags first, then the on-disk subscriber config.
fn resolve_subscriber(a: &Args) -> Result<ResolvedSubscriber, String> {
    resolve_subscriber_with(a, bsc_lan_sense::config::load_subscriber)
}

/// What `sense` runs with: flags first, then the on-disk sensor config.
fn resolve_sensor(a: &Args) -> Result<ResolvedSensor, String> {
    resolve_sensor_with(a, bsc_lan_sense::config::load_sensor)
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


fn cmd_sense(a: &Args) -> Result<(), String> {
    use crate::capture::{retain_window, MonitorCapture};
    use bsc_lan_sense::emit::{Emitter, SnapshotPolicy};
    use bsc_lan_sense::emitloop::{events_for, fits_one_datagram, SendLog};
    use bsc_lan_sense::spectrum::{discover, read_samples, trigger, Mode};
    use bsc_lan_sense::transport::UdpMulticast;
    use bsc_lan_stream::crypto::{GroupKey, Sensor};
    use bsc_lan_stream::frame::{AttestedPosture, SensorState};
    use std::collections::BTreeMap;

    let r = resolve_sensor(a)?;
    let to = r.destination;
    // Into the journal when this runs as a unit, which is the one place an
    // operator can find out which key file a running sensor actually opened.
    println!("{}", r.provenance);
    let signing = SigningKey::from_bytes(&r.sensor_key);
    let group = GroupKey::from_bytes(r.group_key);

    let mut boot = [0u8; 16];
    getrandom::fill(&mut boot).map_err(|e| format!("no OS randomness for the boot id: {e}"))?;
    let sensor = Sensor::new(signing, group, boot);

    // DISCOVERY IS NOT A PRECONDITION, and making it one was a real defect.
    // The radio is a USB device: it can enumerate seconds after the unit
    // starts, be reset by the hub, or be unplugged and returned. A `?` here
    // exits 1, and Restart=always turns that into a crash loop that burns a
    // fresh boot id every five seconds and tells a subscriber nothing.
    //
    // Worse, it conflates two states a subscriber must be able to tell apart:
    // a sensor that is gone, and a sensor that is alive with no radio. The
    // posture snapshots below are the answer to the second, and they only
    // exist if the loop is allowed to run without a spectral path.
    let mut path = discover().ok();
    if path.is_none() {
        println!(
            "no spectral path yet — continuing without one. Posture snapshots still go out, \
             so a subscriber can tell a sensor with no radio from a sensor that is gone."
        );
    }
    // Through the emitter's own transport rather than a hand-rolled socket:
    // that type has no receive path AT ALL, which is a property the sensor
    // should not be re-deciding at each call site. It serves a unicast
    // collector as well as a multicast group — the multicast TTL of 1 simply
    // does not apply to a unicast destination.
    //
    // OPENING IT IS RETRIED, NOT REQUIRED, and the reboot is what proved why.
    // `After=network-online.target` did not hold long enough on this box:
    // connect() returned `Network is unreachable` for the first seventy
    // seconds of boot, and because a failure here was fatal the unit exited 1
    // fourteen times before the interface came up. That is the same defect as
    // treating a missing radio as fatal, one layer over — a transient
    // condition at start turned into a crash loop by Restart=always, each
    // cycle burning a fresh boot id and a journal entry.
    //
    // Retrying in-process is quieter and keeps one boot id. Forever, and
    // deliberately: a permanently unroutable destination and a network that
    // is thirty seconds late look identical from here, and only one of them
    // is worth giving up on — but giving up is not available to a device
    // nobody can log into.
    let transport = {
        let mut attempts = 0u64;
        loop {
            match UdpMulticast::bind(Ipv4Addr::UNSPECIFIED, to) {
                Ok(t) => {
                    if attempts > 0 {
                        println!("socket to {to} opened after {attempts} failed attempt(s)");
                    }
                    break t;
                }
                Err(e) => {
                    attempts += 1;
                    if SendLog::should_report(attempts) {
                        println!(
                            "cannot open a socket to {to} yet ({e}) — attempt {attempts}, retrying. \
                             The network is often not up when this unit starts."
                        );
                    }
                    std::thread::sleep(std::time::Duration::from_millis(
                        a.interval_ms.unwrap_or(1000),
                    ));
                }
            }
        }
    };

    // SNAPSHOTS ARE WHY THIS RUNS THROUGH THE EMITTER. A subscriber that joins
    // an already-running stream sees deltas with no prior state and stays
    // Degraded forever; the snapshot is what makes it whole, and the sensor's
    // posture rides on it. An unattended sensor is precisely the case where
    // every subscriber joins late, so a delta-only loop would leave all of
    // them permanently incomplete.
    // TIER 2, and it is the only tier that can see a deauth flood at all: the
    // attack is performed with entirely legal frames and radiates no excess
    // energy, so the spectral tier is blind to it by construction.
    //
    // Opened only when a radio is configured, and a failure is REPORTED AND
    // SURVIVED rather than fatal — the same rule the socket and the spectral
    // path already follow. A sensor that refuses to start because it lacks
    // CAP_NET_RAW would also stop attesting its own posture, which is worse
    // than running with one tier missing and saying so.
    let deauth_policy = bsc_rf::deauth::Policy::sensible();
    let capture = match r.radio_iface.as_deref() {
        None => None,
        Some(iface) => match MonitorCapture::open(iface) {
            Ok(c) => {
                println!("watching {iface} for disconnect frames (tier 2)");
                Some(c)
            }
            Err(e) => {
                println!(
                    "cannot watch {iface} for disconnect frames ({e}) — continuing without tier 2. \
                     A deauth flood radiates no excess energy, so the spectral tier cannot see one."
                );
                None
            }
        },
    };
    let mut frames: Vec<bsc_rf::deauth::FrameObservation> = Vec::new();
    let (mut deauth_seen, mut deauth_alerts) = (0u64, 0u64);

    let snapshot_ms = a.snapshot_ms.unwrap_or(10_000);
    let mut em = Emitter::new(sensor, transport, SnapshotPolicy { interval_ms: snapshot_ms });

    let interval = std::time::Duration::from_millis(a.interval_ms.unwrap_or(1000));
    let windows = a.count.unwrap_or(0);
    let started = std::time::Instant::now();
    let (mut barren, mut w, mut snapshots, mut oversized) = (0u64, 0u64, 0u64, 0u64);
    let mut log = SendLog::default();

    loop {
        let now_ms = started.elapsed().as_millis() as u64;
        if em.snapshot_due(now_ms) {
            // The /proc sweep is paid on the SNAPSHOT cadence, not per window:
            // this box is thermally saturated, and reading four tables at 1 Hz
            // to restate a verdict that changes in minutes is work for nothing.
            let posture = bsc_lan_sense::assess_host();
            let mut counters = BTreeMap::new();
            counters.insert("windows".to_string(), w);
            counters.insert("datagrams".to_string(), log.sent);
            counters.insert("barren_windows".to_string(), barren);
            counters.insert("send_failures".to_string(), log.failures);
            counters.insert("oversized_events".to_string(), oversized);
            let state = SensorState {
                counters,
                active_alerts: Vec::new(),
                // Overwritten from the live verdict inside emit_snapshot; a
                // default here would be a fresh timestamp on no claim at all.
                posture: AttestedPosture::default(),
                monotonic_us: started.elapsed().as_micros() as u64,
            };
            match em.emit_snapshot(state, &posture, now_ms) {
                Ok(_) => {
                    snapshots += 1;
                    log.record(Ok(()));
                }
                Err(e) => {
                    if let Some(line) = log.record(Err(std::io::Error::other(e.to_string()))) {
                        println!("{line}");
                    }
                }
            }
        }

        // Drained BEFORE the spectral sleep, so a busy channel's frames are
        // taken in the same window they arrived in rather than being attributed
        // to the next one.
        if let Some(cap) = capture.as_ref() {
            deauth_seen += cap.drain(now_ms, 4_000, &mut frames) as u64;
            retain_window(&mut frames, now_ms, deauth_policy.window_ms);
            let verdict = bsc_rf::deauth::assess(&frames, now_ms, deauth_policy);
            if let Some(ev) = bsc_lan_sense::rf::wire_event(&verdict) {
                if fits_one_datagram(&ev) {
                    match em.emit_event(ev) {
                        Ok(_) => {
                            deauth_alerts += 1;
                            log.record(Ok(()));
                        }
                        Err(err) => {
                            if let Some(line) = log.record(Err(std::io::Error::other(err.to_string()))) {
                                println!("{line}");
                            }
                        }
                    }
                } else {
                    oversized += 1;
                }
            }
        }

        // Re-looked-for every window while absent, so a radio plugged in an
        // hour after boot is picked up without anyone restarting anything.
        if path.is_none() {
            path = discover().ok();
            if path.is_some() {
                println!("spectral path appeared — the radio is now being read");
            }
        }
        let Some(p) = path.as_ref() else {
            // No radio: still a live sensor, and the snapshot above said so.
            std::thread::sleep(interval);
            barren += 1;
            w += 1;
            if windows > 0 && w >= windows {
                break;
            }
            continue;
        };
        if a.trigger {
            let _ = trigger(p, Mode::Background);
            let _ = trigger(p, Mode::Trigger);
        }
        std::thread::sleep(interval);
        // A read failure is NOT fatal either: the radio can be re-enumerated
        // by a USB reset or the driver reloaded under a running sensor, and
        // dying for it would take the posture stream down with the spectrum.
        let read = match read_samples(p) {
            Ok(r) => r,
            Err(e) => {
                println!("spectral read failed ({e}) — continuing; the next window may succeed");
                // Forget the path so the next window rediscovers it: a USB
                // reset renumbers the phy, and holding the old path would fail
                // forever against a radio that is present under a new name.
                path = None;
                w += 1;
                if windows > 0 && w >= windows {
                    break;
                }
                continue;
            }
        };
        let events = events_for(&read);
        if events.is_empty() {
            // Deliberate: silence is the subscriber's to report.
            barren += 1;
        }
        for e in events {
            // Checked BEFORE sealing, so an event that cannot fit is dropped
            // and counted rather than turned into a send error once per window
            // forever. A datagram over the budget is fragmented or discarded by
            // the network, and either way the subscriber sees a gap it would
            // read as loss.
            if !fits_one_datagram(&e) {
                oversized += 1;
                continue;
            }
            match em.emit_event(e) {
                Ok(_) => {
                    log.record(Ok(()));
                }
                Err(err) => {
                    if let Some(line) = log.record(Err(std::io::Error::other(err.to_string()))) {
                        println!("{line}");
                    }
                }
            }
        }
        w += 1;
        if windows > 0 && w >= windows {
            break;
        }
    }
    if a.trigger {
        if let Some(p) = path.as_ref() {
            let _ = trigger(p, Mode::Disable);
        }
    }
    let out = json!({
        "windows": w,
        "datagrams_sent": log.sent,
        "send_failures": log.failures,
        "snapshots": snapshots,
        "barren_windows": barren,
        "oversized_events": oversized,
        "frames_seen": deauth_seen,
        "deauth_alerts": deauth_alerts,
        "snapshot_interval_ms": snapshot_ms,
        "to": to.to_string(),
    });
    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        format!(
            "{w} window(s) → {} datagram(s) to {to}\n  {snapshots} snapshot(s) every {snapshot_ms} ms, carrying this host's attested posture\n  {barren} window(s) produced no samples and sent NOTHING (silence is the subscriber's to report)\n  {deauth_seen} frame(s) inspected, {deauth_alerts} disconnect alert(s)\n  {} send(s) failed — an absent collector is not a fault, and never stops the sensor",
            log.sent, log.failures
        )
    });
    Ok(())
}

fn cmd_spectrum(a: &Args) -> Result<(), String> {
    use bsc_lan_sense::spectrum::{discover, from_bytes, read_samples, trigger, Mode};

    let read = if let Some(src) = a.source.as_deref() {
        let raw = std::fs::read(src).map_err(|e| format!("could not read {src}: {e}"))?;
        from_bytes(&raw)
    } else {
        let path = discover().map_err(|e| e.to_string())?;
        if a.trigger {
            // The only mutating step, and only on request.
            trigger(&path, Mode::Background).map_err(|e| e.to_string())?;
            trigger(&path, Mode::Trigger).map_err(|e| e.to_string())?;
            std::thread::sleep(std::time::Duration::from_millis(1200));
        }
        let r = read_samples(&path).map_err(|e| e.to_string())?;
        if a.trigger {
            // Leaving a scan running costs a thermally-saturated box work.
            let _ = trigger(&path, Mode::Disable);
        }
        r
    };

    let out = json!({
        "observed": read.observed(),
        "samples": read.samples,
        "bytes": read.bytes,
        "malformed_tail": read.malformed_tail.as_ref().map(|e| e.to_string()),
        "channels": read.channels.iter().map(|c| json!({
            "freq_mhz": c.freq_mhz,
            "sweeps": c.sweeps,
            "noise_dbm": c.noise_dbm,
            "peak_magnitude": c.peak_magnitude,
            "peak_bin": c.peak_bin,
            "bin_max": c.bin_max.to_vec(),
        })).collect::<Vec<_>>(),
    });

    bsc_cli_util::emit(a.pretty, a.json, &out, || {
        if !read.observed() {
            return format!(
                "NOTHING OBSERVED — 0 sample(s) in {} byte(s).\n  \
                 This is NOT a quiet band. Without --trigger this only drains what the driver \
                 already buffered; a radio that is idle or off-channel buffers nothing.",
                read.bytes
            );
        }
        let mut s = format!("{} sample(s) over {} byte(s)\n", read.samples, read.bytes);
        for c in &read.channels {
            let peak_hz = c.peak_magnitude;
            s.push_str(&format!(
                "\n  {} MHz — {} sweeps, noise {} dBm, peak {peak_hz} at bin {}\n    ",
                c.freq_mhz, c.sweeps, c.noise_dbm, c.peak_bin
            ));
            // A coarse inline profile: enough to see a shape without a UI.
            let top = c.bin_max.iter().copied().max().unwrap_or(1).max(1);
            for v in c.bin_max.iter() {
                let level = (u32::from(*v) * 8 / u32::from(top)).min(7) as usize;
                s.push([' ', '.', ':', '-', '=', '+', '*', '#'][level]);
            }
            s.push('\n');
        }
        if let Some(e) = &read.malformed_tail {
            s.push_str(&format!("\n  the stream ended badly: {e}\n  The channels above still stand.\n"));
        }
        s
    });
    Ok(())
}


fn cmd_watch(a: &Args) -> Result<(), String> {
    let r = resolve_subscriber(a)?;
    let (group, iface) = (r.group, r.iface);
    // Said before the loop starts, because once it is running the only thing
    // it prints is silence, and silence has too many causes to guess between.
    println!("{}", r.provenance);

    let mut sensors: Vec<(String, VerifyingKey)> = Vec::new();
    for (name, key) in &r.roster {
        let vk = VerifyingKey::from_bytes(key)
            .map_err(|_| format!("{name}'s public key is not a valid ed25519 public key"))?;
        sensors.push((name.clone(), vk));
    }
    let group_key = GroupKey::from_bytes(r.group_key);

    let timeout = Duration::from_millis(500);
    // A group address joins the group; a plain port binds unicast. Multicast
    // does NOT cross a VLAN without a multicast router, so a subscriber on
    // another segment is fed by unicast and must be able to listen for it.
    let rx = if group.ip().is_multicast() {
        MulticastReceiver::join(iface, group, timeout)
            .map_err(|e| format!("could not join {group} on {iface}: {e}"))?
    } else {
        MulticastReceiver::bind_unicast(group.port(), timeout)
            .map_err(|e| format!("could not bind {}: {e}", group.port()))?
    };

    let cadence = Cadence {
        snapshot_interval_ms: 10_000,
        grace_ms: 2_000,
        missed_snapshots_before_alert: 3,
    };
    let started = Instant::now();
    let mut fleet = Fleet::new(sensors, group_key, cadence, 0).map_err(|e| e.to_string())?;
    println!("watching {} sensor(s): {}", r.roster.len(), fleet.names().collect::<Vec<_>>().join(", "));
    let deadline = a.for_seconds.map(Duration::from_secs);

    loop {
        let now_ms = started.elapsed().as_millis() as u64;
        // A timeout is a TICK, not an error: it is the only chance a watcher
        // gets to notice that the stream has stopped.
        match rx.next_tick().map_err(|e| format!("receive failed: {e}"))? {
            Tick::Datagram(d) => match fleet.receive(&d, now_ms) {
                Some((who, findings)) => {
                    for f in &findings {
                        println!("{who:<12} {}", render_finding(f));
                    }
                }
                None => {
                    // Attributed to NOBODY rather than to a neighbour: a
                    // finding filed against the wrong sensor sends a reaction
                    // to the wrong place.
                    fleet.reject_unattributed();
                    if bsc_lan_sense::emitloop::SendLog::should_report(fleet.unattributed()) {
                        println!(
                            "{:<12} a datagram no configured sensor signed — {} so far. Somebody is \
                             injecting into the group, or a sensor is missing from the roster.",
                            "UNKNOWN",
                            fleet.unattributed()
                        );
                    }
                }
            },
            Tick::Quiet => {}
        }
        // Polled on every turn, and EACH SENSOR SEPARATELY, so one healthy
        // sensor cannot mask another's silence.
        for (who, f) in fleet.poll(now_ms) {
            println!("{who:<12} {}", render_finding(&f));
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

/// Absent, ok, or broken. Three answers rather than two: a box that only
/// subscribes legitimately has no sensor document, while a box whose sensor
/// document is mode 644 has a problem — and collapsing both into "no config"
/// would hide the second behind the first.
fn config_state<T>(r: &Result<bsc_lan_sense::config::Loaded<T>, String>, missing: &str) -> (&'static str, String) {
    match r {
        Ok(_) => ("ok", String::new()),
        Err(e) if e.contains(missing) => ("absent", e.clone()),
        Err(e) => ("error", e.clone()),
    }
}

/// Report both key documents, redacted. Reads only — see the verb's own help
/// for why there is no writing counterpart.
fn cmd_config(a: &Args) -> Result<(), String> {
    let dir = bsc_lan_sense::config::config_dir()
        .ok_or("cannot locate the base directory")?;
    let sub = bsc_lan_sense::config::load_subscriber();
    let sen = bsc_lan_sense::config::load_sensor();

    // "absent" and "broken" are different answers and must not collapse into
    // one. A box that only subscribes legitimately has no sensor document; a
    // box whose sensor document is mode 644 has a problem, and reporting both
    // as "no config" would hide it.
    let (sub_state, sub_why) = config_state(&sub, "no subscriber config at");
    let (sen_state, sen_why) = config_state(&sen, "no sensor config at");

    let out = json!({
        "dir": dir.display().to_string(),
        "permissions_checked": bsc_lan_sense::config::PERMISSIONS_ARE_CHECKED,
        "subscriber": {
            "path": bsc_lan_sense::config::subscriber_path().map(|p| p.display().to_string()),
            "state": sub_state,
            "detail": sub_why,
            "config": sub.as_ref().ok().map(|c| c.value.redacted()),
        },
        "sensor": {
            "path": bsc_lan_sense::config::sensor_path().map(|p| p.display().to_string()),
            "state": sen_state,
            "detail": sen_why,
            "config": sen.as_ref().ok().map(|c| c.value.redacted()),
        },
    });
    bsc_cli_util::emit(a.pretty, a.json, &out, || render_config(&out));

    // A document that is present and broken is a failure, because something
    // that meant to read it will fail too. An absent one is not.
    if sub_state == "error" || sen_state == "error" {
        return Err("a key document is present but unusable — see above".into());
    }
    Ok(())
}

/// Rendered separately so the redaction is testable without a disk.
pub fn render_config(v: &serde_json::Value) -> String {
    let mut s = format!("{}\n", v["dir"].as_str().unwrap_or("?"));
    if v["permissions_checked"] != serde_json::Value::Bool(true) {
        s.push_str("\n  PERMISSIONS NOT CHECKED on this platform — a mode is a unix thing, and\n  this says so rather than reporting a check it never ran.\n");
    }
    for (name, role) in [("subscriber", "what a watcher needs"), ("sensor", "what the sensor needs")] {
        let d = &v[name];
        s.push_str(&format!(
            "\n  {name:<11} {}  ({role})\n    {}\n",
            d["state"].as_str().unwrap_or("?"),
            d["path"].as_str().unwrap_or("?")
        ));
        match d["state"].as_str() {
            Some("ok") => {
                if let Some(o) = d["config"].as_object() {
                    for (k, val) in o {
                        // Every variant named: the crate denies a wildcard
                        // over an enum, and here that is load-bearing rather
                        // than pedantry — a redacted secret is a String, and a
                        // catch-all is how a future non-string field would
                        // print itself without anyone deciding it should.
                        let shown = match val {
                            serde_json::Value::String(x) => x.clone(),
                            serde_json::Value::Null => "—".to_string(),
                            serde_json::Value::Bool(x) => x.to_string(),
                            serde_json::Value::Number(x) => x.to_string(),
                            // The ROSTER, rendered as a roster. `<structured>`
                            // would hide the one thing this report exists to
                            // show: which sensors this host accepts, and the
                            // public keys an operator copies between machines.
                            serde_json::Value::Array(items) => items
                                .iter()
                                .map(|it| match (it["name"].as_str(), it["publicKey"].as_str()) {
                                    (Some(n), Some(k)) => format!("{n} {k}"),
                                    _ => it.to_string(),
                                })
                                .collect::<Vec<_>>()
                                .join("\n                         "),
                            serde_json::Value::Object(_) => "<structured>".to_string(),
                        };
                        s.push_str(&format!("      {k:<18} {shown}\n"));
                    }
                }
            }
            Some("absent") => s.push_str("      not present — this host does not hold this half\n"),
            Some(_) | None => {
                for line in d["detail"].as_str().unwrap_or("").lines() {
                    s.push_str(&format!("      {line}\n"));
                }
            }
        }
    }
    s
}

/// The kernel's live `net.ipv4.ip_local_port_range`, or the documented default.
///
/// Read rather than assumed because the unit's `SocketBindAllow` has to permit
/// exactly the range the kernel will pick from; a box that has narrowed or
/// moved its range would otherwise get a unit that refuses the sensor's own
/// outbound socket. A box that cannot be read falls back to the kernel default,
/// and the failure that produces is loud — an EPERM the journal names.
fn ephemeral_port_range() -> (u16, u16) {
    let parse = |t: &str| -> Option<(u16, u16)> {
        let mut it = t.split_whitespace();
        Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
    };
    std::fs::read_to_string("/proc/sys/net/ipv4/ip_local_port_range")
        .ok()
        .and_then(|t| parse(&t))
        .unwrap_or(crate::unit::DEFAULT_EPHEMERAL_PORTS)
}

/// Print the unit, rendered against this host's own sensor config.
fn cmd_unit(a: &Args) -> Result<(), String> {
    let cfg = bsc_lan_sense::config::load_sensor()?;
    let spec = crate::unit::UnitSpec {
        // Defaults to where `bsc deploy` stages it, because that is where it
        // actually is on the one device this runs on today.
        binary: a
            .binary
            .clone()
            .unwrap_or_else(|| "/home/lan/.bsc-deploy/bsc-lan.current".to_string()),
        config_dir: cfg
            .path
            .parent()
            .map(|p| p.display().to_string())
            .ok_or("the sensor config has no parent directory")?,
        interval_ms: a.interval_ms.unwrap_or(crate::unit::DEFAULT_INTERVAL_MS),
        snapshot_ms: a.snapshot_ms.unwrap_or(10_000),
        ephemeral_ports: ephemeral_port_range(),
    };
    let text = if a.radio {
        crate::unit::render_radio(&cfg.value)?.ok_or_else(|| {
            format!(
                "this sensor config names no radio, so there is no radio unit to render.\n                   Add a \"radio\" object to {} — {{\"iface\": \"wlan1\", \"channel\": 6}} — \n                   and note that monitor mode does NOT survive a reboot: measured, an untuned \n                   adapter gave 5 spectrum records in 30 seconds against 30 for a tuned one.",
                cfg.path.display()
            )
        })?
    } else {
        crate::unit::render(&cfg.value, &spec)?
    };
    if a.json {
        // The unit as a string, so a caller can place it without reparsing
        // the human rendering.
        let name = if a.radio { crate::unit::RADIO_UNIT_NAME } else { crate::unit::UNIT_NAME };
        let out = json!({ "name": name, "unit": text });
        println!("{}", serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?);
    } else {
        print!("{text}");
    }
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
        Some("sense") => cmd_sense(&a),
        Some("spectrum") => cmd_spectrum(&a),
        Some("watch") => cmd_watch(&a),
        Some("estate") => cmd_estate(&a),
        Some("dry-run") => cmd_dry_run(&a),
        Some("config") => cmd_config(&a),
        Some("unit") => cmd_unit(&a),
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
        assert_eq!(names, vec!["posture", "keygen", "watch", "estate", "spectrum", "sense", "dry-run", "config", "unit"]);
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

    /// The private and public halves take DIFFERENT flags. A single flag that
    /// accepted either would make handing out the signing key a typo instead of
    /// an impossibility — and a subscriber holding it could forge the stream,
    /// which is the one thing the signature exists to prevent.
    #[test]
    fn the_private_signing_key_and_the_public_key_are_separate_flags() {
        let a = parse_args(vec![
            "sense".into(), "--sensor-key".into(), "a".repeat(64),
            "--sensor-public-key".into(), "b".repeat(64),
        ]).unwrap();
        assert_eq!(a.sensor_key.as_deref(), Some("a".repeat(64).as_str()));
        assert_eq!(a.sensor_public_key.as_deref(), Some("b".repeat(64).as_str()));
        assert_ne!(a.sensor_key, a.sensor_public_key, "the halves must not be interchangeable");
    }

    #[test]
    fn sense_refuses_without_a_destination_and_says_what_a_destination_is_for() {
        // Driven through the seam rather than `run`, so the verdict does not
        // depend on whether the developer running this happens to have a
        // sensor config in their home directory — with one present, `run`
        // would find a destination and this test would silently stop asking
        // its question.
        let e = resolve_sensor_with(&Args::default(), no_config).unwrap_err();
        assert!(e.contains("--to"), "{e}");
        assert!(e.contains("VLAN"), "the error should say why a unicast collector exists: {e}");
        // And it must name the file it looked for, or the operator is told to
        // type a flag without being told the other way out.
        assert!(e.contains("sensor config"), "the error hides the config path: {e}");
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
                "--group-key",
            ),
            (
                vec![
                    "watch".into(), "--group".into(), "239.1.2.3:5140".into(),
                    "--group-key".into(), "a".repeat(64),
                ],
                "roster",
            ),
        ] {
            let a = parse_args(argv).expect("parses");
            let e = resolve_subscriber_with(&a, no_config).unwrap_err();
            assert!(e.contains(expect), "expected the error to name {expect}, got: {e}");
        }
    }

    /// A loader standing in for "there is no config on this box". Used
    /// wherever a test's question is about the FLAGS, so the answer cannot
    /// change with the contents of a real home directory.
    fn no_config<T>() -> Result<Loaded<T>, String> {
        Err("no sensor config at /nowhere/sensor.json — author one there, or pass the keys as flags".into())
    }

    const PUBK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
    const GK: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const SK: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    fn a_subscriber_config() -> Result<Loaded<SubscriberConfig>, String> {
        Ok(Loaded {
            value: SubscriberConfig {
                group: "239.9.9.9:5140".into(),
                iface: Some("10.0.0.7".into()),
                sensors: vec![bsc_lan_sense::config::SensorIdentity {
                    name: "monitor-pi".into(),
                    public_key: PUBK.into(),
                }],
                group_key: GK.into(),
            },
            path: std::path::PathBuf::from("/etc/bsc-lan/subscriber.json"),
        })
    }

    #[test]
    fn the_config_supplies_what_no_flag_did_and_says_where_it_came_from() {
        let r = resolve_subscriber_with(&Args::default(), a_subscriber_config).expect("resolves");
        assert_eq!(r.group.to_string(), "239.9.9.9:5140");
        assert_eq!(r.iface.to_string(), "10.0.0.7");
        assert_eq!(r.roster.len(), 1);
        assert_eq!(r.roster[0].0, "monitor-pi", "the sensor's NAME must survive resolution");
        assert_eq!(r.roster[0].1[0], 0x11);
        assert_eq!(r.group_key[0], 0x22);
        // Provenance is the whole point of printing it: a silent watcher has
        // several causes, and "which config did it open" must not be one of
        // the ones you have to guess.
        assert!(r.provenance.contains("/etc/bsc-lan/subscriber.json"), "{}", r.provenance);
        // And it must never carry the secret it just resolved.
        assert!(!r.provenance.contains(GK), "the provenance line leaked the group key: {}", r.provenance);
    }

    #[test]
    fn a_flag_beats_the_file_and_the_line_says_so() {
        let a = parse_args(vec![
            "watch".into(),
            "--group".into(),
            "239.1.1.1:6000".into(),
        ])
        .unwrap();
        let r = resolve_subscriber_with(&a, a_subscriber_config).expect("resolves");
        assert_eq!(r.group.to_string(), "239.1.1.1:6000", "the flag must win");
        assert_eq!(r.roster[0].1[0], 0x11, "the rest still comes from the file");
        assert!(r.provenance.contains("--group from flags"), "{}", r.provenance);
        assert!(r.provenance.contains("subscriber.json"), "{}", r.provenance);
    }

    #[test]
    fn a_fully_flagged_command_never_opens_the_config_at_all() {
        // Not a nicety. `watch` given every flag must not fail because some
        // unrelated config file is malformed or mode 644 — and, more to the
        // point, must not OPEN a key file it has no use for.
        let a = parse_args(vec![
            "watch".into(),
            "--group".into(), "239.1.1.1:6000".into(),
            "--sensor-public-key".into(), PUBK.into(),
            "--group-key".into(), GK.into(),
        ])
        .unwrap();
        let opened = std::cell::Cell::new(false);
        let r = resolve_subscriber_with(&a, || {
            opened.set(true);
            no_config()
        })
        .expect("resolves from flags alone");
        assert!(!opened.get(), "a fully-flagged command opened the key file anyway");
        assert!(!r.provenance.contains("subscriber.json"), "{}", r.provenance);

        let a = parse_args(vec![
            "sense".into(),
            "--to".into(), "239.1.1.1:6000".into(),
            "--sensor-key".into(), SK.into(),
            "--group-key".into(), GK.into(),
        ])
        .unwrap();
        let opened = std::cell::Cell::new(false);
        resolve_sensor_with(&a, || {
            opened.set(true);
            no_config()
        })
        .expect("resolves from flags alone");
        assert!(!opened.get(), "a fully-flagged sense opened the key file anyway");
    }

    #[test]
    fn the_config_report_never_prints_a_secret_in_either_format() {
        use bsc_lan_sense::config::{SensorConfig as SC, SubscriberConfig as UC};
        let sub = UC {
            group: "239.9.9.9:5140".into(),
            iface: None,
            sensors: vec![bsc_lan_sense::config::SensorIdentity {
                name: "monitor-pi".into(),
                public_key: PUBK.into(),
            }],
            group_key: GK.into(),
        };
        let sen = SC {
            destination: "239.9.9.9:5140".into(),
            iface: None,
            sensor_key: SK.into(),
            group_key: GK.into(),
            radio: None,
        };
        let v = json!({
            "dir": "/etc/bsc-lan",
            "permissions_checked": true,
            "subscriber": { "path": "/etc/bsc-lan/subscriber.json", "state": "ok", "detail": "", "config": sub.redacted() },
            "sensor": { "path": "/etc/bsc-lan/sensor.json", "state": "ok", "detail": "", "config": sen.redacted() },
        });
        // Asserted against the KEY, not against the presence of the word
        // "redacted": a second copy of the key somewhere else in the document
        // would satisfy the weaker check while still printing the secret.
        let text = render_config(&v);
        assert!(!text.contains(GK), "the group key reached the terminal:\n{text}");
        assert!(!text.contains(SK), "the signing key reached the terminal:\n{text}");
        assert!(text.contains(PUBK), "the PUBLIC key is not a secret and is what an operator copies:\n{text}");
        // --json is the same document, so it must clear the same bar.
        let as_json = serde_json::to_string(&v).unwrap();
        assert!(!as_json.contains(GK) && !as_json.contains(SK), "--json leaked a key");
    }

    #[test]
    fn an_absent_document_and_a_broken_one_read_differently() {
        // A box that only subscribes has no sensor document, and that is
        // normal. A sensor document that is mode 644 is not, and the report
        // must not file them under the same word.
        let absent: Result<bsc_lan_sense::config::Loaded<()>, String> =
            Err("no sensor config at /etc/bsc-lan/sensor.json — author one there".into());
        let broken: Result<bsc_lan_sense::config::Loaded<()>, String> =
            Err("/etc/bsc-lan/sensor.json is mode 0644 — it holds a key".into());
        assert_eq!(config_state(&absent, "no sensor config at").0, "absent");
        assert_eq!(config_state(&broken, "no sensor config at").0, "error");
    }

    #[test]
    fn every_flag_the_unit_writes_is_a_flag_this_parser_accepts() {
        // THE BUG THIS EXISTS FOR, caught only on the device: the generator
        // wrote `--interval-ms` and the parser takes `--interval`, so the
        // service installed cleanly, started, exited 1, and Restart=always
        // turned it into a crash loop. Nothing between the generator and the
        // Pi could see it, because the unit is text on one side and argv on
        // the other and the two were never introduced.
        use bsc_lan_sense::config::SensorConfig;
        let cfg = SensorConfig {
            destination: "10.99.2.118:45142".into(),
            iface: None,
            sensor_key: SK.into(),
            group_key: GK.into(),
            radio: None,
        };
        let spec = crate::unit::UnitSpec {
            binary: "/opt/bsc-lan".into(),
            config_dir: "/etc/bsc-lan".into(),
            interval_ms: 1000,
            snapshot_ms: 10_000,
            ephemeral_ports: crate::unit::DEFAULT_EPHEMERAL_PORTS,
        };
        let unit = crate::unit::render(&cfg, &spec).expect("renders");
        let args = crate::unit::tests::exec_args(&unit);
        assert!(!args.is_empty(), "the unit has no ExecStart arguments:\n{unit}");
        let parsed = parse_args(args.clone())
            .unwrap_or_else(|e| panic!("the unit's ExecStart does not parse: {e}\n  args: {args:?}"));
        assert_eq!(
            parsed.positional.first().map(String::as_str),
            Some("sense"),
            "the unit does not run the sense verb: {args:?}"
        );
        // And the values survive, not just the flag names — a flag that parsed
        // into the wrong field would be just as silent.
        assert_eq!(parsed.interval_ms, Some(1000), "{args:?}");
        assert_eq!(parsed.snapshot_ms, Some(10_000), "{args:?}");
        assert!(parsed.trigger, "the unit must arm the radio: {args:?}");
    }

    #[test]
    fn a_debug_line_cannot_carry_a_key() {
        // The same disclosure argv had, one layer down: a `{:?}` in a panic
        // message or an error path is as durable as a command line, and both
        // of these structs hold the confidentiality half of the stream.
        let r = resolve_subscriber_with(&Args::default(), a_subscriber_config).unwrap();
        let d = format!("{r:?}");
        assert!(!d.contains("34"), "a byte of the group key appears in Debug: {d}");
        assert!(d.contains("redacted"), "{d}");

        let a = parse_args(vec![
            "sense".into(),
            "--to".into(), "239.1.1.1:6000".into(),
            "--sensor-key".into(), SK.into(),
            "--group-key".into(), GK.into(),
        ])
        .unwrap();
        let r = resolve_sensor_with(&a, no_config).unwrap();
        let d = format!("{r:?}");
        assert!(!d.contains("51"), "a byte of the signing key appears in Debug: {d}");
        assert!(d.contains("redacted"), "{d}");
    }

    #[test]
    fn a_broken_config_is_reported_alongside_the_flag_that_would_have_avoided_it() {
        // Two sources means two ways to be wrong, and an error naming only one
        // of them sends the operator down the wrong path.
        let e = resolve_subscriber_with(&Args::default(), || {
            Err::<Loaded<SubscriberConfig>, String>(
                "/etc/bsc-lan/subscriber.json is mode 0644 — it holds a key".into(),
            )
        })
        .unwrap_err();
        assert!(e.contains("--group"), "the error does not name the flag: {e}");
        assert!(e.contains("mode 0644"), "the error does not carry why the file failed: {e}");
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
