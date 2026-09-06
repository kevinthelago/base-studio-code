//! The incident ledger — the alerting brain.
//!
//! Detections (a deauth flood, a network scan, a DHCP lease flip-flop) arrive as
//! [`Detection`]s. The [`Ledger`] COALESCES repeated detections of the same thing into a
//! single [`Incident`] — a scan is a legitimate cluster, not sixty alarms — tracks its
//! severity and lifecycle, honours SILENCES so it never nags, and decides, exactly once per
//! episode, whether an observation is worth a notification.
//!
//! # Why this is the join point
//!
//! Every detector in the system (RF deauth, Suricata scans, the DHCP-lease audit) speaks the
//! same small vocabulary: "I saw X, its identity is KEY, it is THIS severe." The ledger is the
//! one place that turns that firehose into the short list a human should actually see, and the
//! one place the phone reads. Detectors feed IN; the mobile transport reads OUT. Neither needs
//! to know about the other.
//!
//! # Pure on purpose
//!
//! No I/O, no clock, no database. Time arrives as a millisecond argument and the store is a
//! `Vec` in memory, so every rule below is answerable from a constructed sequence with no
//! runtime, no sleeping, and no flakiness. Persistence and delivery WRAP this crate — a SQLite
//! table that mirrors the incidents, a tunnel that ships the notify-worthy ones — and that
//! separation is the point: the decisions live where they can be tested, the plumbing lives
//! elsewhere.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// How much a human should care. Ordered: `Info < Low < Medium < High < Critical`, so a
/// notification floor is a simple `>=` and coalescing keeps the *highest* severity seen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Severity {
    Info,
    Low,
    Medium,
    High,
    Critical,
}

/// What was detected. Deliberately a closed set the detectors share, so the phone can render
/// each kind knowingly rather than parsing a free-text label. `Other` is the escape hatch for a
/// detector that has no home here yet — it still coalesces and notifies like anything else.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum Kind {
    /// An 802.11 deauthentication / disassociation flood.
    DeauthFlood,
    /// RF jamming — energy holding a channel busy that does not decode into frames.
    Jamming,
    /// A network / port scan.
    ScanDetected,
    /// A DHCP server answering that is not the sanctioned one.
    RogueDhcp,
    /// A MAC/IP binding taken from another device (spoof / flip-flop).
    LeaseTheft,
    /// A device seen on the network for the first time.
    NewDevice,
    /// Anything a detector raises that has no dedicated kind yet.
    Other,
}

/// Where an incident is in its life. `Closed` is the only terminal state; a detection for a
/// closed incident's key opens a fresh one, because the old episode is over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum State {
    /// Live and unacknowledged.
    Open,
    /// A human has seen it; it stays live but stops paging.
    Acknowledged,
    /// Muted by a silence on its key; still recorded, never paged.
    Silenced,
    /// Done. A new detection for this key starts a new incident.
    Closed,
}

/// What a detector observed — the evidence that made it fire. `summary` is the human line;
/// `fields` are the structured key/values a UI or query can lean on (frequency, MAC, dBm…).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub summary: String,
    pub fields: Vec<(String, String)>,
}

impl Evidence {
    /// A summary-only evidence, for the common case where there is nothing structured to add.
    pub fn line(summary: impl Into<String>) -> Self {
        Evidence { summary: summary.into(), fields: Vec::new() }
    }
}

/// One thing a detector saw. `key` is the identity the ledger coalesces on: two detections
/// with the SAME key are the same incident. The caller chooses it — e.g. a deauth flood keys on
/// `"deauth:<freq>:<transmitter>"`, a scan on `"scan:<src>"` — so what counts as "the same
/// attack" is the detector's judgement, not a guess made here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Detection {
    pub kind: Kind,
    pub key: String,
    pub severity: Severity,
    pub source: String,
    pub at_ms: i64,
    pub evidence: Evidence,
}

/// A coalesced incident — one row a human might act on, however many detections fed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Incident {
    pub id: u64,
    pub kind: Kind,
    pub key: String,
    /// The HIGHEST severity any feeding detection carried — an incident that ever went critical
    /// stays critical in the list even if it later calms.
    pub severity: Severity,
    pub source: String,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
    /// How many detections coalesced into this incident. A count of 400 with one row is exactly
    /// the point: the burst is visible without 400 alarms.
    pub count: u64,
    pub state: State,
    /// The most recent evidence, so the row shows the latest picture.
    pub evidence: Evidence,
    /// Whether a notification has been raised for the CURRENT episode. Reset when a new burst
    /// re-fires after a lull, so a resumed attack pages again; held true through a burst so it
    /// does not.
    pub notified: bool,
}

/// What observing a detection did — enough for the caller to persist the change and decide
/// whether to ship a notification, without re-deriving any of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Outcome {
    pub incident_id: u64,
    /// A brand-new incident opened (first time this key was seen, or the first since it closed).
    pub opened: bool,
    /// Merged into an already-open incident for this key.
    pub coalesced: bool,
    /// The caller should raise a notification for this observation. True at most once per
    /// episode: on open, on a post-lull re-fire, and on an escalation across the floor.
    pub notify: bool,
}

#[derive(Debug, Clone, Copy)]
struct Silence {
    /// `None` means "until explicitly lifted"; `Some(ms)` means "until this instant".
    until_ms: Option<i64>,
}

/// The ledger. Holds every incident, the open one per key, and the active silences.
///
/// Two knobs, both explained where they are used:
/// - `coalesce_window_ms`: within this gap, repeated detections are one quiet burst; beyond it,
///   a detection is a new episode that re-fires.
/// - `notify_floor`: the least severity that may ever page. Everything below is still recorded
///   — the auto-investigator triages the quiet ones — but it does not reach the phone.
#[derive(Debug)]
pub struct Ledger {
    incidents: Vec<Incident>,
    /// key -> index into `incidents` of the OPEN (non-closed) incident for that key.
    by_key: HashMap<String, usize>,
    silences: HashMap<String, Silence>,
    next_id: u64,
    coalesce_window_ms: i64,
    notify_floor: Severity,
}

impl Ledger {
    /// A ledger that coalesces bursts within `coalesce_window_ms` and pages at or above
    /// `notify_floor`.
    pub fn new(coalesce_window_ms: i64, notify_floor: Severity) -> Self {
        Ledger {
            incidents: Vec::new(),
            by_key: HashMap::new(),
            silences: HashMap::new(),
            next_id: 1,
            coalesce_window_ms,
            notify_floor,
        }
    }

    /// Is this key silenced as of `at_ms`? A timed silence that has passed is treated as lifted.
    fn silenced(&self, key: &str, at_ms: i64) -> bool {
        match self.silences.get(key) {
            None => false,
            Some(Silence { until_ms: None }) => true,
            Some(Silence { until_ms: Some(until) }) => at_ms < *until,
        }
    }

    /// Observe a detection. Coalesces or opens, updates state, and returns whether to notify.
    pub fn observe(&mut self, d: Detection) -> Outcome {
        let silenced = self.silenced(&d.key, d.at_ms);

        if let Some(&idx) = self.by_key.get(&d.key) {
            // An episode is already open for this key.
            let within = d.at_ms.saturating_sub(self.incidents[idx].last_seen_ms) <= self.coalesce_window_ms;
            let inc = &mut self.incidents[idx];
            inc.count += 1;
            inc.last_seen_ms = d.at_ms;
            inc.evidence = d.evidence;
            if d.severity > inc.severity {
                inc.severity = d.severity;
            }
            // Notify again only when this is NOT just more of the same burst: a new burst after
            // a lull, or an escalation across the floor that has not yet paged. A steady flood
            // pages once, not per packet.
            let escalated_unnotified = !inc.notified;
            let notify = !silenced
                && d.severity >= self.notify_floor
                && inc.state != State::Acknowledged
                && (!within || escalated_unnotified);
            if silenced {
                inc.state = State::Silenced;
            } else if inc.state == State::Silenced {
                // A silence lapsed; the incident is live again (unless a human had acked it).
                inc.state = State::Open;
            }
            if notify {
                inc.notified = true;
            }
            Outcome { incident_id: inc.id, opened: false, coalesced: true, notify }
        } else {
            // First sighting of this key (ever, or since it last closed).
            let id = self.next_id;
            self.next_id += 1;
            let notify = !silenced && d.severity >= self.notify_floor;
            let inc = Incident {
                id,
                kind: d.kind,
                key: d.key.clone(),
                severity: d.severity,
                source: d.source,
                first_seen_ms: d.at_ms,
                last_seen_ms: d.at_ms,
                count: 1,
                state: if silenced { State::Silenced } else { State::Open },
                evidence: d.evidence,
                notified: notify,
            };
            self.incidents.push(inc);
            self.by_key.insert(d.key, self.incidents.len() - 1);
            Outcome { incident_id: id, opened: true, coalesced: false, notify }
        }
    }

    /// Mark an incident acknowledged: it stays live and in the list, but stops paging until
    /// closed. Returns false if the id is unknown or already closed.
    pub fn acknowledge(&mut self, id: u64) -> bool {
        match self.incidents.iter_mut().find(|i| i.id == id) {
            Some(i) if i.state != State::Closed => {
                i.state = State::Acknowledged;
                true
            }
            _ => false,
        }
    }

    /// Silence a key. `until_ms = None` mutes it until explicitly unsilenced; `Some(ms)` until
    /// that instant. An open incident for the key is muted immediately.
    pub fn silence(&mut self, key: impl Into<String>, until_ms: Option<i64>) {
        let key = key.into();
        if let Some(&idx) = self.by_key.get(&key) {
            self.incidents[idx].state = State::Silenced;
        }
        self.silences.insert(key, Silence { until_ms });
    }

    /// Lift a silence on a key. A currently-open incident goes back to `Open` (a human still has
    /// to acknowledge it).
    pub fn unsilence(&mut self, key: &str) {
        self.silences.remove(key);
        if let Some(&idx) = self.by_key.get(key) {
            if self.incidents[idx].state == State::Silenced {
                self.incidents[idx].state = State::Open;
            }
        }
    }

    /// Close an incident. The next detection for its key opens a fresh incident. Returns false
    /// if the id is unknown or already closed.
    pub fn close(&mut self, id: u64) -> bool {
        let Some(inc) = self.incidents.iter_mut().find(|i| i.id == id) else {
            return false;
        };
        if inc.state == State::Closed {
            return false;
        }
        inc.state = State::Closed;
        let key = inc.key.clone();
        // Only forget the key if THIS incident is the open one for it.
        if self.by_key.get(&key) == Some(&self.incidents.iter().position(|i| i.id == id).unwrap()) {
            self.by_key.remove(&key);
        }
        true
    }

    /// Every incident that is not closed, newest activity first — the list a human sees.
    pub fn live(&self) -> Vec<&Incident> {
        let mut v: Vec<&Incident> = self.incidents.iter().filter(|i| i.state != State::Closed).collect();
        v.sort_by_key(|i| std::cmp::Reverse(i.last_seen_ms));
        v
    }

    /// Every incident ever, in id order — for a full audit / persistence sweep.
    pub fn all(&self) -> &[Incident] {
        &self.incidents
    }

    /// One incident by id.
    pub fn get(&self, id: u64) -> Option<&Incident> {
        self.incidents.iter().find(|i| i.id == id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn det(key: &str, sev: Severity, at_ms: i64) -> Detection {
        Detection {
            kind: Kind::DeauthFlood,
            key: key.into(),
            severity: sev,
            source: "garage".into(),
            at_ms,
            evidence: Evidence::line(format!("deauth at {at_ms}")),
        }
    }

    fn ledger() -> Ledger {
        // 5s burst window, page at High and above.
        Ledger::new(5_000, Severity::High)
    }

    #[test]
    fn a_high_severity_detection_opens_and_notifies() {
        let mut l = ledger();
        let o = l.observe(det("deauth:2437:aa", Severity::High, 1_000));
        assert!(o.opened && !o.coalesced && o.notify);
        assert_eq!(l.get(o.incident_id).unwrap().count, 1);
    }

    #[test]
    fn a_burst_coalesces_into_one_incident_and_pages_once() {
        // The signature case: a scan/flood is a legitimate cluster, not N alarms.
        let mut l = ledger();
        let first = l.observe(det("scan:host", Severity::High, 0));
        assert!(first.notify, "the first of a burst pages");
        let mut later_notifies = 0;
        for t in (1..60).map(|n| n * 1000) {
            // every second for a minute, all within the 5s window of the previous
            let o = l.observe(det("scan:host", Severity::High, t));
            assert!(o.coalesced && !o.opened, "same key within window must coalesce");
            if o.notify {
                later_notifies += 1;
            }
        }
        assert_eq!(later_notifies, 0, "a steady burst must never page again");
        let live = l.live();
        assert_eq!(live.len(), 1, "sixty detections, one incident");
        assert_eq!(live[0].count, 60);
    }

    #[test]
    fn a_new_burst_after_a_lull_pages_again() {
        // The attack resumed after quiet — that is worth knowing.
        let mut l = ledger();
        assert!(l.observe(det("deauth:2437:aa", Severity::High, 0)).notify);
        assert!(!l.observe(det("deauth:2437:aa", Severity::High, 2_000)).notify, "still the same burst");
        // 10s later (> 5s window): a fresh episode of the SAME incident.
        let resumed = l.observe(det("deauth:2437:aa", Severity::High, 12_000));
        assert!(resumed.coalesced && resumed.notify, "a post-lull re-fire pages");
        assert_eq!(l.get(resumed.incident_id).unwrap().count, 3);
    }

    #[test]
    fn below_the_floor_records_but_never_pages() {
        // The auto-investigator triages the quiet ones; they must not reach the phone.
        let mut l = ledger();
        let o = l.observe(det("newdev:xx", Severity::Low, 0));
        assert!(o.opened && !o.notify, "low severity is recorded, not paged");
        assert_eq!(l.live().len(), 1);
    }

    #[test]
    fn an_escalation_across_the_floor_pages_even_within_a_burst() {
        // Opened Medium (below the High floor) so it did not page; a Critical arrives inside the
        // window — the escalation itself is the news.
        let mut l = ledger();
        assert!(!l.observe(det("rf:ch6", Severity::Medium, 0)).notify);
        let up = l.observe(det("rf:ch6", Severity::Critical, 1_000));
        assert!(up.coalesced && up.notify, "crossing the floor pages once, even mid-burst");
        assert_eq!(l.get(up.incident_id).unwrap().severity, Severity::Critical);
        // …and it does not keep paging for the rest of the burst.
        assert!(!l.observe(det("rf:ch6", Severity::Critical, 2_000)).notify);
    }

    #[test]
    fn a_silenced_key_is_recorded_but_never_pages() {
        let mut l = ledger();
        l.silence("deauth:2437:aa", None);
        let o = l.observe(det("deauth:2437:aa", Severity::Critical, 0));
        assert!(o.opened && !o.notify, "silence beats severity");
        assert_eq!(l.get(o.incident_id).unwrap().state, State::Silenced);
        assert_eq!(l.get(o.incident_id).unwrap().count, 1, "still counted while silent");
    }

    #[test]
    fn a_timed_silence_lapses_and_the_next_burst_pages() {
        let mut l = ledger();
        l.silence("scan:host", Some(10_000));
        assert!(!l.observe(det("scan:host", Severity::High, 1_000)).notify, "muted before the deadline");
        // after the deadline and after the burst window, it re-fires
        let after = l.observe(det("scan:host", Severity::High, 20_000));
        assert!(after.notify, "a lapsed silence lets the next burst through");
    }

    #[test]
    fn acknowledge_stops_paging_but_keeps_the_incident_live() {
        let mut l = ledger();
        let o = l.observe(det("deauth:2437:aa", Severity::High, 0));
        assert!(l.acknowledge(o.incident_id));
        // a post-lull re-fire would normally page; ack holds it quiet
        let re = l.observe(det("deauth:2437:aa", Severity::High, 12_000));
        assert!(!re.notify, "an acknowledged incident does not page");
        assert_eq!(l.get(o.incident_id).unwrap().state, State::Acknowledged);
        assert!(l.live().iter().any(|i| i.id == o.incident_id), "still on the live list");
    }

    #[test]
    fn closing_ends_the_episode_and_the_next_detection_opens_fresh() {
        let mut l = ledger();
        let a = l.observe(det("deauth:2437:aa", Severity::High, 0));
        assert!(l.close(a.incident_id));
        assert!(!l.live().iter().any(|i| i.id == a.incident_id), "closed leaves the live list");
        let b = l.observe(det("deauth:2437:aa", Severity::High, 1_000));
        assert!(b.opened && b.incident_id != a.incident_id, "a new episode is a new incident");
    }

    #[test]
    fn distinct_keys_are_distinct_incidents() {
        let mut l = ledger();
        let a = l.observe(det("deauth:2437:aa", Severity::High, 0));
        let b = l.observe(det("deauth:5180:bb", Severity::High, 0));
        assert_ne!(a.incident_id, b.incident_id);
        assert_eq!(l.live().len(), 2);
    }

    #[test]
    fn an_incident_keeps_the_highest_severity_it_ever_reached() {
        let mut l = ledger();
        l.observe(det("rf:x", Severity::High, 0));
        l.observe(det("rf:x", Severity::Critical, 1_000));
        l.observe(det("rf:x", Severity::Low, 2_000));
        assert_eq!(l.live()[0].severity, Severity::Critical, "it never calms below its worst");
    }

    #[test]
    fn an_incident_serializes_for_the_wire() {
        // The phone reads incidents as JSON; the shape must round-trip.
        let mut l = ledger();
        let o = l.observe(det("deauth:2437:aa", Severity::High, 42));
        let inc = l.get(o.incident_id).unwrap();
        let json = serde_json::to_string(inc).expect("serialize");
        let back: Incident = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(&back, inc);
    }
}
