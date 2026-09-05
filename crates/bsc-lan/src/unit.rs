//! The systemd unit that makes the sensor a service rather than something
//! somebody typed.
//!
//! ## Why this is generated rather than a file in the repo
//!
//! Two of its lines have to agree with the sensor's own config or the sensor
//! runs and sends nothing: `IPAddressAllow` names the collector, and the config
//! names the destination. A unit checked in as static text would drift from the
//! config the first time a collector moved, and the symptom is a healthy-looking
//! service whose datagrams are dropped by the kernel before they reach a wire.
//! So the destination is READ FROM THE CONFIG and rendered in — one source, and
//! a test asserts the two lines match.
//!
//! ## The unit is where "emit-only" stops being a claim
//!
//! Everything else in this project argues the sensor cannot be reached: the
//! transport type has no receive path, the socket is connected, the posture is
//! attested. All of that is our own code vouching for itself, and a compromised
//! sensor controls every word of it. Two directives move the boundary into the
//! kernel:
//!
//! - `SocketBindDeny=any` — the unit cannot bind a listening socket AT ALL,
//!   whatever the binary is or becomes. This is the one line that would still
//!   hold if the binary were replaced.
//! - `IPAddressDeny=any` with a single `IPAddressAllow` — egress is confined to
//!   the collector, so the sensor cannot talk to anything else on the network
//!   even if something inside it wanted to.
//!
//! ## One directive is deliberately ABSENT, and it looks like an omission
//!
//! `ProtectKernelTunables=yes` belongs in almost every hardened unit and must
//! NOT be here: it remounts `/sys/kernel` read-only, and the spectral scan is
//! armed by writing `spectral_scan_ctl` under `/sys/kernel/debug`. Adding it
//! produces a sensor that starts cleanly, reports no error, and emits nothing
//! but barren windows forever. [`render`]'s tests assert its absence together
//! with this reason, so a later hardening pass reads the reason instead of
//! rediscovering it.
//!
//! ## Root, and why the alternative is not available
//!
//! Every spectral file under `/sys/kernel/debug/ieee80211/*/ath9k_htc/` is
//! `root:root` mode 0600, and debugfs has no persistent way to widen that. So
//! the unit runs as root and gives the capabilities back: an empty
//! `CapabilityBoundingSet` drops `CAP_DAC_OVERRIDE` and everything else, and
//! uid 0 still reads those files by OWNERSHIP rather than by capability.

use bsc_lan_sense::config::SensorConfig;

/// What the unit needs beyond the sensor's own config.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnitSpec {
    /// Absolute path to the `bsc-lan` binary ON THE DEVICE.
    pub binary: String,
    /// Directory holding `sensor.json` on the device.
    pub config_dir: String,
    /// Seconds between spectral windows, as milliseconds.
    pub interval_ms: u64,
    /// Snapshot cadence, as milliseconds.
    pub snapshot_ms: u64,
    /// Retained for the record; see [`DEFAULT_EPHEMERAL_PORTS`] for why a port
    /// range cannot express what this unit needs.
    pub ephemeral_ports: (u16, u16),
}

/// The kernel's default `net.ipv4.ip_local_port_range`.
///
/// **A PORT RANGE CANNOT WORK HERE, and this constant exists to record why so
/// the next reader does not try it again.** `SocketBindDeny=any` blocks
/// `bind(2)` outright, and the sensor's outbound socket binds `0.0.0.0:0`
/// before it connects. systemd's hook is `BPF_CGROUP_INET4_BIND`, which fires
/// with the port the caller ASKED for — zero — before the kernel picks one.
/// Zero is in no range, so `SocketBindAllow=ipv4:udp:32768-60999` refuses the
/// sensor's own socket. Bisected on the device: baseline runs, `+socketbind`
/// gives `cannot open a socket to 10.99.2.118:45142: Operation not
/// permitted`, and every other directive in this unit is innocent.
pub const DEFAULT_EPHEMERAL_PORTS: (u16, u16) = (32768, 60999);

/// The unit's canonical name, without the `.service` suffix.
pub const UNIT_NAME: &str = "bsc-lan-sense";

/// How often the sensor aggregates a window and emits it, in milliseconds.
///
/// THIS NUMBER IS THE WATERFALL'S TIME RESOLUTION: one emitted window is one
/// row, so a 1000 ms interval means every row is a second of air smeared
/// together and a burst shorter than that cannot be told from a steady signal.
///
/// 250 ms costs almost nothing. The radio produces roughly 666 sweeps a second
/// and the aggregation keeps the per-bin MAXIMUM, so a shorter window discards
/// less rather than more; the wire is capped at 20 datagrams a second and this
/// uses four. What it buys is four times the vertical resolution and a burst
/// that survives aggregation instead of being averaged into its neighbours.
pub const DEFAULT_INTERVAL_MS: u64 = 250;

/// The companion oneshot that tunes the radio, without the `.service` suffix.
pub const RADIO_UNIT_NAME: &str = "bsc-lan-radio";

/// Directives that must never appear, each with the reason.
///
/// A list rather than a comment, because the failure mode of adding one is a
/// service that starts, reports nothing wrong, and emits barren windows for
/// the rest of its life — which nobody debugs by reading a unit file.
pub const FORBIDDEN: &[(&str, &str)] = &[
    (
        "ProtectKernelTunables",
        "remounts /sys/kernel read-only, and the spectral scan is armed by writing \
         spectral_scan_ctl under /sys/kernel/debug — the sensor would start cleanly \
         and emit nothing but barren windows",
    ),
    (
        "PrivateNetwork",
        "gives the unit its own network namespace, so its datagrams never reach a wire",
    ),
    (
        "ProtectHome=yes",
        "the deployed binary lives under the operator's home (bsc deploy stages it at \
         ~/.bsc-deploy/bsc-lan.current), so the unit could not exec the thing it exists \
         to run — read-only is the strongest setting that works",
    ),
];

/// Render the unit for one sensor config.
///
/// Takes the config rather than a bare address so `IPAddressAllow` and the
/// destination the sensor will actually use cannot disagree.
pub fn render(cfg: &SensorConfig, spec: &UnitSpec) -> Result<String, String> {
    let dest = cfg.destination_addr()?;
    let ip = dest.ip();
    // A /32 for a unicast collector; a multicast group is also a single
    // address from the kernel's point of view, so the same form serves both.
    let allow = format!("{ip}/32");

    // Ordering, not a hard dependency: a radio that fails to tune leaves a
    // sensor that still attests its posture, and that is strictly better than
    // no sensor. The reverse -- refusing to start -- would trade a partial
    // stream for none over a USB device that may simply be slow to enumerate.
    // TIER 2 COSTS EXACTLY ONE CAPABILITY AND ONE ADDRESS FAMILY, and saying so
    // is the point: this unit's whole claim is that it holds nothing. A radio
    // configured means the sensor watches for disconnect frames, which needs an
    // AF_PACKET raw socket, which needs CAP_NET_RAW. Nothing else is added, the
    // bounding set still names exactly that one, and a sensor with no radio
    // keeps the empty set it had.
    //
    // The trade is worth stating rather than burying: a deauth flood is jamming
    // performed with entirely legal frames and radiates no excess energy, so the
    // spectral tier is blind to it BY CONSTRUCTION. Without this the sensor
    // cannot see the attack at all.
    let (caps, families) = match &cfg.radio {
        Some(_) => (
            "         CapabilityBoundingSet=CAP_NET_RAW\n         AmbientCapabilities=CAP_NET_RAW\n",
            "         RestrictAddressFamilies=AF_INET AF_PACKET\n",
        ),
        None => (
            "         CapabilityBoundingSet=\n         AmbientCapabilities=\n",
            "         RestrictAddressFamilies=AF_INET\n",
        ),
    };

    let radio_ordering = match &cfg.radio {
        Some(_) => format!(
            "After={RADIO_UNIT_NAME}.service\nWants={RADIO_UNIT_NAME}.service\n"
        ),
        None => String::new(),
    };

    Ok(format!(
        "# Generated by `bsc lan unit`. The destination below is read from the\n\
         # sensor config, so this file and {config_dir}/sensor.json cannot disagree.\n\
         #\n\
         # NOTE ProtectKernelTunables is deliberately absent: it remounts\n\
         # /sys/kernel read-only and the spectral scan is armed by writing\n\
         # spectral_scan_ctl under /sys/kernel/debug.\n\
         [Unit]\n\
         Description=bsc lan — the emit-only LAN sensor\n\
         After=network-online.target\n\
         Wants=network-online.target\n\
         {radio_ordering}
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={binary} sense --trigger --interval {interval_ms} --snapshot-ms {snapshot_ms}\n\
         Environment=BSC_LAN_DIR={config_dir}\n\
         # The keys are NOT here. They are read from {config_dir}/sensor.json,\n\
         # because `systemctl show` hands this line to anyone who asks and a\n\
         # unit file is normally mode 644.\n\
         \n\
         # A sensor that dies quietly is indistinguishable from a quiet network.\n\
         Restart=always\n\
         RestartSec=5\n\
         \n\
         # Root only because every spectral debugfs file is root:root 0600 and\n\
         # debugfs cannot persistently widen that. The capabilities go back:\n\
         # uid 0 reads those files by ownership, not by CAP_DAC_OVERRIDE.\n\
         User=root\n\
{caps}\
         NoNewPrivileges=yes\n\
         \n\
         # Where emit-only stops being a claim this code makes about itself.\n\
         # A TCP bind is impossible at any port, whatever the binary is or\n\
         # becomes. UDP has to stay open because the sensor binds 0.0.0.0:0\n\
         # before it connects, and systemd sees the port asked for -- zero --\n\
         # so no port range can name it. What remains is bounded by\n\
         # IPAddressDeny below, which filters BOTH directions: the only host\n\
         # this unit can exchange a packet with is the collector.\n\
         SocketBindDeny=any\n\
         SocketBindAllow=ipv4:udp\n\
{families}\
         IPAddressDeny=any\n\
         IPAddressAllow={allow}\n\
         \n\
         ProtectSystem=strict\n\
         ProtectHome=read-only\n\
         PrivateTmp=yes\n\
         ProtectClock=yes\n\
         ProtectControlGroups=yes\n\
         ProtectKernelLogs=yes\n\
         ProtectKernelModules=yes\n\
         RestrictNamespaces=yes\n\
         RestrictRealtime=yes\n\
         RestrictSUIDSGID=yes\n\
         LockPersonality=yes\n\
         MemoryDenyWriteExecute=yes\n\
         SystemCallArchitectures=native\n\
         SystemCallFilter=@system-service\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        binary = spec.binary,
        config_dir = spec.config_dir,
        interval_ms = spec.interval_ms,
        snapshot_ms = spec.snapshot_ms,
        allow = allow,
        radio_ordering = radio_ordering,
        caps = caps,
        families = families,
    ))
}

/// The companion oneshot that puts the radio into monitor mode.
///
/// `None` when the config names no radio — a sensor that only attests its
/// posture needs nothing tuned.
///
/// ## Why this is a separate unit
///
/// Tuning an interface needs `CAP_NET_ADMIN`, and the sensor's own unit drops
/// every capability it has. Folding the tuning into the sensor would mean
/// handing the long-running process a capability it needs for the first
/// hundred milliseconds of its life and never again. A oneshot that exits
/// keeps that blast radius at four commands.
///
/// ## Why it re-runs when the radio is re-plugged
///
/// `BindsTo=` the device unit ties this to the interface's existence, so
/// unplugging and returning the USB adapter re-tunes it. Without that, a radio
/// that came back would be `type managed` again and the sensor would produce
/// the sparse stream this exists to prevent — with nothing in any log saying
/// why the rate dropped.
pub fn render_radio(cfg: &SensorConfig) -> Result<Option<String>, String> {
    let Some(r) = &cfg.radio else { return Ok(None) };
    // Validated again HERE rather than trusted from the load: this is the
    // function that writes the name into a root-run file, and a guard that
    // lives only at the other end of the program is a guard that a future
    // caller can walk around.
    r.validate()?;
    let dev = format!("sys-subsystem-net-devices-{}.device", r.iface);
    Ok(Some(format!(
        "# Generated by `bsc lan unit --radio`.\n\
         #\n\
         # MEASURED: with this adapter left `type managed` and unassociated\n\
         # after a reboot the sensor produced 5 spectrum records in 30\n\
         # seconds; in monitor mode on its channel, 30 in 30 -- one per\n\
         # window, the design rate. Monitor mode does not survive a reboot.\n\
         [Unit]\n\
         Description=bsc lan — park {iface} in monitor mode on channel {channel}\n\
         Before={sense}.service\n\
         After={dev}\n\
         BindsTo={dev}\n\
         \n\
         [Service]\n\
         Type=oneshot\n\
         RemainAfterExit=yes\n\
         ExecStart=/usr/sbin/ip link set {iface} down\n\
         ExecStart=/usr/sbin/iw dev {iface} set type monitor\n\
         ExecStart=/usr/sbin/ip link set {iface} up\n\
         ExecStart=/usr/sbin/iw dev {iface} set channel {channel}\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        iface = r.iface,
        channel = r.channel,
        sense = UNIT_NAME,
        dev = dev,
    )))
}

#[cfg(test)]
pub mod tests {
    use super::*;

    const GK: &str = "2222222222222222222222222222222222222222222222222222222222222222";
    const SK: &str = "3333333333333333333333333333333333333333333333333333333333333333";

    fn cfg(dest: &str) -> SensorConfig {
        SensorConfig {
            destination: dest.into(),
            iface: None,
            sensor_key: SK.into(),
            group_key: GK.into(),
            radio: None,
        }
    }

    fn cfg_with_radio(iface: &str, channel: u16) -> SensorConfig {
        let mut c = cfg("10.99.2.118:45142");
        c.radio = Some(bsc_lan_sense::config::RadioConfig { iface: iface.into(), channel });
        c
    }

    fn spec() -> UnitSpec {
        UnitSpec {
            binary: "/home/lan/.bsc-deploy/bsc-lan.current".into(),
            config_dir: "/etc/bsc-lan".into(),
            interval_ms: DEFAULT_INTERVAL_MS,
            snapshot_ms: 10_000,
            ephemeral_ports: DEFAULT_EPHEMERAL_PORTS,
        }
    }

    #[test]
    fn no_key_material_reaches_the_unit_file() {
        // The unit is what `systemctl show` prints and what a 644 file on disk
        // holds. It is the same disclosure argv had, and the reason the config
        // file exists at all.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(!u.contains(GK), "the group key is in the unit file");
        assert!(!u.contains(SK), "the signing key is in the unit file");
        assert!(!u.contains("--group-key") && !u.contains("--sensor-key"), "{u}");
        assert!(u.contains("BSC_LAN_DIR=/etc/bsc-lan"), "the unit must say where to read them from");
    }

    #[test]
    fn the_allowed_address_is_the_destination_the_sensor_will_actually_use() {
        // The drift this generator exists to prevent: an allow-list naming one
        // collector and a config naming another produces a service that runs,
        // reports nothing wrong, and has every datagram dropped by the kernel.
        for dest in ["10.99.2.118:45142", "239.10.20.30:5140", "10.4.4.4:9"] {
            let c = cfg(dest);
            let u = render(&c, &spec()).unwrap();
            let ip = c.destination_addr().unwrap().ip().to_string();
            assert!(
                u.contains(&format!("IPAddressAllow={ip}/32")),
                "the allow-list does not name {ip}:\n{u}"
            );
        }
    }

    #[test]
    fn egress_is_denied_before_it_is_allowed() {
        // Order matters to systemd's own parser only in that both must be
        // present; the property asserted here is that the deny is not missing,
        // because IPAddressAllow alone permits everything else.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("IPAddressDeny=any"), "egress is not denied by default:\n{u}");
        let deny = u.find("IPAddressDeny=any").unwrap();
        let allow = u.find("IPAddressAllow=").unwrap();
        assert!(deny < allow, "the allow must narrow a deny, not the other way round");
    }

    #[test]
    fn the_unit_cannot_open_a_listening_socket() {
        // The user's stated requirement — nothing in, one stream out — moved
        // from our code's word into the kernel's. This line survives the binary
        // being replaced, which nothing else in this project does.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("SocketBindDeny=any"), "{u}");
        assert!(u.contains("RestrictAddressFamilies=AF_INET"), "{u}");
        // The deny is narrowed by exactly the ephemeral range and nothing
        // else, so a TCP listener is impossible at any port and a UDP listener
        // is impossible at every well-known one. Measured on the device: a
        // bare SocketBindDeny=any refuses the sensor's OWN outbound socket,
        // because connecting one still binds a source port first.
        // UDP has to stay open: the sensor binds 0.0.0.0:0 and systemd's hook
        // sees the requested port, so no range can name it (bisected on the
        // device — see DEFAULT_EPHEMERAL_PORTS). TCP is the half that stays
        // impossible, and it is the half that matters: every inbound service
        // anyone would reach for is TCP.
        assert!(u.contains("SocketBindAllow=ipv4:udp"), "{u}");
        assert!(!u.contains("tcp"), "a TCP bind must never be allowed:\n{u}");
        let deny = u.find("SocketBindDeny=any").unwrap();
        let allow = u.find("SocketBindAllow=").unwrap();
        assert!(deny < allow, "the allow must narrow a deny, not stand alone");
    }

    #[test]
    fn what_the_udp_allowance_costs_is_bounded_by_the_address_filter() {
        // The honest statement of the trade. UDP bind stays possible inside
        // this unit; what a hypothetical listener could talk to does not,
        // because IPAddressAllow filters BOTH directions and names exactly
        // one host. So the residue of allowing a UDP bind is a socket that
        // could only ever exchange packets with the collector.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("IPAddressDeny=any"), "{u}");
        assert_eq!(
            u.matches("IPAddressAllow=").count(),
            1,
            "exactly one host may be reached, or the bound above is not a bound:\n{u}"
        );
    }

    #[test]
    fn a_directive_that_would_silently_break_the_scan_is_absent_with_its_reason() {
        // The whole point of FORBIDDEN being data: a later hardening pass that
        // adds ProtectKernelTunables gets a red test naming what it breaks,
        // rather than shipping a sensor that emits barren windows forever.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        for (directive, why) in FORBIDDEN {
            assert!(
                !u.contains(&format!("\n{directive}=yes")),
                "{directive} is in the unit — {why}"
            );
            assert!(!why.is_empty(), "{directive} is forbidden with no reason recorded");
        }
        // And the one whose absence looks most like a mistake carries its
        // reason in the file itself, where somebody editing it will see it.
        assert!(u.contains("ProtectKernelTunables is deliberately absent"), "{u}");
    }

    #[test]
    fn a_dying_sensor_is_restarted_because_a_quiet_one_looks_like_a_quiet_network() {
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("Restart=always"), "{u}");
        assert!(u.contains("RestartSec=5"), "{u}");
    }

    #[test]
    fn the_home_protection_is_read_only_so_the_deployed_binary_can_still_be_run() {
        // bsc deploy stages the artifact at ~/.bsc-deploy/bsc-lan.current, so
        // ProtectHome=yes would make the unit unable to exec what it exists to
        // run — a failure at start, not a silent one, but a confusing one.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("ProtectHome=read-only"), "{u}");
        assert!(!u.contains("ProtectHome=yes"), "{u}");
        assert!(u.contains("ExecStart=/home/lan/.bsc-deploy/bsc-lan.current sense"), "{u}");
    }

    /// The ExecStart arguments, as a shell would split them. Used by the CLI's
    /// own tests to feed them straight to the real argument parser.
    pub fn exec_args(unit: &str) -> Vec<String> {
        unit.lines()
            .find_map(|l| l.strip_prefix("ExecStart="))
            .map(|l| l.split_whitespace().skip(1).map(str::to_string).collect())
            .unwrap_or_default()
    }

    #[test]
    fn the_exec_args_are_extracted_from_the_line_the_unit_actually_carries() {
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        let args = exec_args(&u);
        assert_eq!(args.first().map(String::as_str), Some("sense"), "{args:?}");
    }

    #[test]
    fn the_unit_advertises_no_documentation_it_does_not_have() {
        // `Documentation=man:bsc-lan(1)` was in here, and `systemd-analyze
        // verify` refused it on the device: `Command 'man bsc-lan(1)' failed
        // with code 16`. There is no man page. A unit pointing at
        // documentation that does not exist sends the next operator looking
        // for something nobody wrote, and it is the one line in the file that
        // a standard tool will actively complain about.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(!u.contains("man:"), "the unit points at a man page that does not exist:\n{u}");
    }

    #[test]
    fn the_emit_interval_is_the_waterfalls_time_resolution() {
        // One emitted window is one row on the display, so this constant is not
        // a tuning knob — it decides whether a burst can be told from a steady
        // signal at all. Pinned so a later "quieter default" is a decision
        // somebody makes rather than a regression nobody sees.
        assert_eq!(DEFAULT_INTERVAL_MS, 250);
        // Four a second against a wire capped at twenty: the headroom is the
        // reason this is affordable.
        assert!(1_000 / DEFAULT_INTERVAL_MS <= 20);
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("--interval 250"), "{u}");
    }

    #[test]
    fn a_radio_costs_exactly_one_capability_and_one_address_family() {
        // The unit's whole claim is that it holds nothing, so what tier 2 costs
        // has to be visible and bounded rather than a quiet widening.
        let u = render(&cfg_with_radio("wlan1", 6), &spec()).unwrap();
        assert!(u.contains("CapabilityBoundingSet=CAP_NET_RAW"), "{u}");
        assert!(u.contains("AmbientCapabilities=CAP_NET_RAW"), "{u}");
        assert!(u.contains("RestrictAddressFamilies=AF_INET AF_PACKET"), "{u}");
        // And NOTHING else came with it.
        for over in ["CAP_NET_ADMIN", "CAP_SYS_ADMIN", "AF_NETLINK", "AF_UNIX"] {
            assert!(!u.contains(over), "{over} was granted alongside: {u}");
        }
    }

    #[test]
    fn a_sensor_with_no_radio_keeps_the_empty_capability_set() {
        // A box that only attests its posture must not pay for a tier it does
        // not run.
        let u = render(&cfg("10.99.2.118:45142"), &spec()).unwrap();
        assert!(u.contains("CapabilityBoundingSet=\n"), "{u}");
        assert!(!u.contains("CAP_NET_RAW"), "{u}");
        assert!(u.contains("RestrictAddressFamilies=AF_INET\n"), "{u}");
        assert!(!u.contains("AF_PACKET"), "{u}");
    }

    #[test]
    fn a_sensor_with_no_radio_gets_no_radio_unit_and_no_ordering_on_one() {
        let c = cfg("10.99.2.118:45142");
        assert!(render_radio(&c).unwrap().is_none());
        let u = render(&c, &spec()).unwrap();
        assert!(!u.contains(RADIO_UNIT_NAME), "an ordering on a unit that will not exist:\n{u}");
    }

    #[test]
    fn a_configured_radio_gets_a_oneshot_and_the_sensor_waits_for_it() {
        let c = cfg_with_radio("wlan1", 6);
        let r = render_radio(&c).unwrap().expect("a radio unit");
        assert!(r.contains("set type monitor"), "{r}");
        assert!(r.contains("set channel 6"), "{r}");
        assert!(r.contains("Type=oneshot") && r.contains("RemainAfterExit=yes"), "{r}");
        // Re-tuned when the adapter is re-plugged, or a radio that came back
        // would be `managed` again and the rate would drop with no explanation.
        assert!(r.contains("BindsTo=sys-subsystem-net-devices-wlan1.device"), "{r}");

        let u = render(&c, &spec()).unwrap();
        assert!(u.contains(&format!("After={RADIO_UNIT_NAME}.service")), "{u}");
        // Wants, not Requires: a radio that fails to tune must still leave a
        // sensor attesting its posture.
        assert!(u.contains(&format!("Wants={RADIO_UNIT_NAME}.service")), "{u}");
        assert!(!u.contains(&format!("Requires={RADIO_UNIT_NAME}")), "{u}");
    }

    #[test]
    fn an_interface_name_cannot_inject_directives_at_the_point_it_is_written() {
        // Guarded at BOTH ends. The config validates on load, and this
        // validates again here — because this is the function that writes the
        // name into a file systemd runs as root, and a guard that lives only
        // at the other end of the program is one a future caller walks around.
        let c = cfg_with_radio("wlan1\nExecStart=/bin/sh -c evil", 6);
        let e = render_radio(&c).unwrap_err();
        assert!(e.contains("radio.iface"), "{e}");
    }

    #[test]
    fn a_malformed_destination_refuses_to_render_a_unit() {
        // Better than a unit with an empty allow-list, which would install
        // cleanly and drop every datagram.
        assert!(render(&cfg("not-an-address"), &spec()).is_err());
    }
}
