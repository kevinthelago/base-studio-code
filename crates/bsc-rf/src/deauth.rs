//! Deauthentication and disassociation floods — Tier 2.
//!
//! ## Why this is the tier that matters, and not the fanciest one
//!
//! A deauth flood is **jamming performed with entirely legal frames**. It
//! radiates no excess energy, so channel occupancy ([`crate::survey`], Tier 1)
//! and spectral FFT (Tier 3) are both blind to it *by construction* — there is
//! nothing anomalous in the spectrum to find. Only frame inspection sees it.
//!
//! That inverts the usual assumption that the higher tier is the more capable
//! one, and on this hardware it is doubly true: measured 2026-09-04, Tier 1 is
//! unsupported by both drivers (no `get_survey` op) and Tier 3 is absent from
//! the kernel build, so Tier 2 is the only tier available at all.
//!
//! ## The sensor cannot react, and that shapes the output
//!
//! The monitor Pi is emit-only by decision — nothing inbound, updates by
//! physical SD swap. So it detects and *emits*; a subscriber reacts. A verdict
//! therefore carries everything a reaction needs: which client, which BSSID,
//! the rate, and the window it was measured over. There is no back channel on
//! which a subscriber could ask a follow-up question.
//!
//! ## Telling an attack from a busy evening
//!
//! Networks legitimately emit these frames: clients roam, APs reboot, sessions
//! time out. What does not happen legitimately is a **broadcast** deauth — an
//! access point disconnecting one client addresses *that client*, so
//! `ff:ff:ff:ff:ff:ff` is close to a signature on its own, and is weighted far
//! above unicast here.
//!
//! The bias is deliberately toward speaking up: a missed flood is an outage
//! nobody can explain, while a false positive costs one look at a screen that
//! names its own reasoning.

/// The 802.11 management subtypes this module cares about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FrameKind {
    /// Subtype 12. The classic disconnect attack.
    Deauthentication,
    /// Subtype 10. Same effect for the client, and often used interchangeably
    /// by attack tooling, so it is counted alongside rather than ignored.
    Disassociation,
}

/// One management frame the radio saw.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FrameObservation {
    /// Monotonic milliseconds, supplied by the caller — this module holds no
    /// clock, so every threshold is testable exactly rather than by sleeping.
    pub at_ms: u64,
    pub kind: FrameKind,
    /// The BSSID the frame claims to come from. "Claims" is the operative
    /// word: it is trivially spoofed, which is the attack.
    pub bssid: String,
    /// Destination. `ff:ff:ff:ff:ff:ff` is a broadcast disconnect.
    pub target: String,
    /// The 802.11 reason code, when the capture carried one.
    pub reason: Option<u16>,
}

impl FrameObservation {
    pub fn is_broadcast(&self) -> bool {
        self.target.eq_ignore_ascii_case("ff:ff:ff:ff:ff:ff")
    }
}

/// How the detector judges. Every field is a policy choice a reader can argue
/// with, which is why they are named rather than buried as literals.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Policy {
    /// The window observations are counted over.
    pub window_ms: u64,
    /// Unicast frames in one window before it reads as elevated.
    pub elevated_frames: u32,
    /// Unicast frames in one window before it reads as a flood.
    pub flood_frames: u32,
    /// Broadcast disconnects tolerated in a window before it is a flood
    /// regardless of volume. An AP disconnecting a client addresses that
    /// client, so this is deliberately tiny.
    pub broadcast_flood_frames: u32,
}

impl Policy {
    /// Defaults chosen to speak up. A home network sees a handful of these an
    /// hour; thirty in ten seconds is not roaming.
    pub const fn sensible() -> Self {
        Self {
            window_ms: 10_000,
            elevated_frames: 10,
            flood_frames: 30,
            broadcast_flood_frames: 3,
        }
    }
}

/// What the detector concluded, with the evidence a subscriber will act on.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum Verdict {
    /// **Nothing was observed at all.** Not the same as quiet: a radio that is
    /// not in monitor mode, or a capture that never started, produces exactly
    /// this and must never be read as "no attack".
    NotObserved,
    /// Frames were seen, below any threshold.
    Quiet { frames: u32, window_ms: u64 },
    /// Above the elevated threshold. Worth a look, not yet an alarm.
    Elevated(Evidence),
    /// A flood. Act.
    Flood(Evidence),
}

/// Everything a subscriber needs to react without asking a question.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Evidence {
    pub frames: u32,
    pub broadcast_frames: u32,
    pub window_ms: u64,
    /// Frames per second across the window, scaled by 100 so the wire carries
    /// no float — a rate of 12.34/s is 1234 here.
    pub rate_centi_per_s: u64,
    /// The BSSID seen most often. Spoofable, and named as such.
    pub top_bssid: String,
    /// The most-targeted client, or the broadcast address.
    pub top_target: String,
    /// Distinct clients targeted — one client is harassment, many is a sweep.
    pub distinct_targets: u32,
    /// Reason codes seen, most common first.
    pub reasons: Vec<u16>,
}

impl Verdict {
    /// Whether this warrants waking somebody. `NotObserved` does: on a sensor
    /// that is supposed to be watching, "I saw nothing at all" is a fault.
    pub fn needs_attention(&self) -> bool {
        match self {
            Verdict::Quiet { .. } => false,
            Verdict::NotObserved | Verdict::Elevated(_) | Verdict::Flood(_) => true,
        }
    }
}

fn most_common<'a>(items: impl Iterator<Item = &'a String>) -> (String, u32) {
    let mut counts: std::collections::BTreeMap<&str, u32> = std::collections::BTreeMap::new();
    for i in items {
        *counts.entry(i.as_str()).or_insert(0) += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(name, n)| (*n, std::cmp::Reverse(*name)))
        .map(|(name, n)| (name.to_string(), n))
        .unwrap_or_default()
}

/// Judge the frames observed in `[now_ms - policy.window_ms, now_ms]`.
///
/// Takes the whole observation list and windows it here rather than expecting a
/// pre-filtered slice: the caller would otherwise have to reimplement the
/// window to interpret the verdict, and two windows that disagree is worse
/// than one that is slightly wasteful.
pub fn assess(observations: &[FrameObservation], now_ms: u64, policy: Policy) -> Verdict {
    if observations.is_empty() {
        return Verdict::NotObserved;
    }
    let floor = now_ms.saturating_sub(policy.window_ms);
    let win: Vec<&FrameObservation> =
        observations.iter().filter(|o| o.at_ms >= floor && o.at_ms <= now_ms).collect();

    if win.is_empty() {
        return Verdict::Quiet { frames: 0, window_ms: policy.window_ms };
    }

    let frames = win.len() as u32;
    let broadcast_frames = win.iter().filter(|o| o.is_broadcast()).count() as u32;
    let (top_bssid, _) = most_common(win.iter().map(|o| &o.bssid));
    let (top_target, _) = most_common(win.iter().map(|o| &o.target));
    let distinct_targets = win
        .iter()
        .map(|o| o.target.to_ascii_lowercase())
        .collect::<std::collections::BTreeSet<_>>()
        .len() as u32;

    let mut reason_counts: std::collections::BTreeMap<u16, u32> = std::collections::BTreeMap::new();
    for r in win.iter().filter_map(|o| o.reason) {
        *reason_counts.entry(r).or_insert(0) += 1;
    }
    let mut reasons: Vec<(u16, u32)> = reason_counts.into_iter().collect();
    reasons.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));

    let evidence = Evidence {
        frames,
        broadcast_frames,
        window_ms: policy.window_ms,
        rate_centi_per_s: (u64::from(frames) * 100_000) / policy.window_ms.max(1),
        top_bssid,
        top_target,
        distinct_targets,
        reasons: reasons.into_iter().map(|(r, _)| r).collect(),
    };

    // Broadcast is judged FIRST and on its own count. A handful of broadcast
    // disconnects is a flood however small the total, because an AP
    // disconnecting a client addresses that client.
    if broadcast_frames >= policy.broadcast_flood_frames || frames >= policy.flood_frames {
        return Verdict::Flood(evidence);
    }
    if frames >= policy.elevated_frames {
        return Verdict::Elevated(evidence);
    }
    Verdict::Quiet { frames, window_ms: policy.window_ms }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obs(at_ms: u64, target: &str) -> FrameObservation {
        FrameObservation {
            at_ms,
            kind: FrameKind::Deauthentication,
            bssid: "aa:bb:cc:dd:ee:ff".into(),
            target: target.into(),
            reason: Some(7),
        }
    }

    const CLIENT: &str = "11:22:33:44:55:66";
    const BCAST: &str = "ff:ff:ff:ff:ff:ff";

    #[test]
    fn nothing_observed_is_not_quiet_and_wants_attention() {
        // A radio not in monitor mode, or a capture that never started,
        // produces exactly this — and must never read as "no attack".
        let v = assess(&[], 10_000, Policy::sensible());
        assert_eq!(v, Verdict::NotObserved);
        assert!(v.needs_attention(), "a sensor that saw nothing at all is a fault, not an all-clear");
    }

    #[test]
    fn a_handful_of_unicast_disconnects_is_quiet() {
        // Clients roam and sessions time out. This is a normal evening.
        let o: Vec<_> = (0..4).map(|i| obs(1_000 + i * 500, CLIENT)).collect();
        assert!(matches!(assess(&o, 10_000, Policy::sensible()), Verdict::Quiet { .. }));
    }

    #[test]
    fn three_broadcast_disconnects_are_a_flood_however_small_the_total() {
        // The signature: an AP disconnecting a client addresses that client.
        let o: Vec<_> = (0..3).map(|i| obs(1_000 + i * 100, BCAST)).collect();
        match assess(&o, 10_000, Policy::sensible()) {
            Verdict::Flood(e) => {
                assert_eq!(e.broadcast_frames, 3);
                assert_eq!(e.top_target, BCAST);
            }
            other => panic!("broadcast deauth must be a flood on volume alone: {other:?}"),
        }
    }

    #[test]
    fn a_sustained_unicast_burst_is_a_flood_and_carries_what_a_reaction_needs() {
        let o: Vec<_> = (0..40).map(|i| obs(1_000 + i * 100, CLIENT)).collect();
        match assess(&o, 10_000, Policy::sensible()) {
            Verdict::Flood(e) => {
                assert_eq!(e.frames, 40);
                assert_eq!(e.top_target, CLIENT, "a subscriber must know WHICH client to act for");
                assert_eq!(e.top_bssid, "aa:bb:cc:dd:ee:ff");
                assert_eq!(e.distinct_targets, 1, "one client is harassment, many is a sweep");
                assert_eq!(e.reasons, vec![7]);
                assert!(e.rate_centi_per_s > 0, "the rate must be reportable without a float");
                assert_eq!(e.window_ms, 10_000, "the window the rate was measured over must travel with it");
            }
            other => panic!("expected a flood, got {other:?}"),
        }
    }

    /// The false-positive shape worth getting right: an AP rebooting drops its
    /// clients at once. Distinct targets, unicast, one short burst.
    #[test]
    fn an_ap_reboot_dropping_many_clients_is_distinguishable_from_a_sweep() {
        let clients = ["11:11:11:11:11:11", "22:22:22:22:22:22", "33:33:33:33:33:33"];
        let o: Vec<_> = clients.iter().map(|c| obs(1_000, c)).collect();
        let v = assess(&o, 10_000, Policy::sensible());
        assert!(
            matches!(v, Verdict::Quiet { .. }),
            "three unicast disconnects at a reboot must not read as an attack: {v:?}"
        );
    }

    #[test]
    fn a_sweep_across_many_clients_is_reported_with_the_target_count() {
        let o: Vec<_> = (0..40)
            .map(|i| obs(1_000 + i * 100, &format!("11:22:33:44:55:{:02x}", i)))
            .collect();
        match assess(&o, 10_000, Policy::sensible()) {
            Verdict::Flood(e) => assert_eq!(e.distinct_targets, 40, "a sweep must be visible as one"),
            other => panic!("expected a flood, got {other:?}"),
        }
    }

    #[test]
    fn frames_outside_the_window_do_not_count() {
        // An hour-old burst must not keep firing forever.
        let o: Vec<_> = (0..40).map(|i| obs(1_000 + i * 10, CLIENT)).collect();
        assert!(matches!(assess(&o, 3_600_000, Policy::sensible()), Verdict::Quiet { frames: 0, .. }));
    }

    #[test]
    fn disassociation_counts_alongside_deauthentication() {
        // Attack tooling uses them interchangeably; ignoring one halves the
        // detector for no reason.
        let o: Vec<_> = (0..3)
            .map(|i| FrameObservation { kind: FrameKind::Disassociation, ..obs(1_000 + i * 100, BCAST) })
            .collect();
        assert!(matches!(assess(&o, 10_000, Policy::sensible()), Verdict::Flood(_)));
    }

    #[test]
    fn a_broadcast_target_is_recognised_whatever_its_case() {
        assert!(obs(0, "FF:FF:FF:FF:FF:FF").is_broadcast());
        assert!(obs(0, "ff:ff:ff:ff:ff:ff").is_broadcast());
        assert!(!obs(0, CLIENT).is_broadcast());
    }
}
