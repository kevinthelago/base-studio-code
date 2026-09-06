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
mod tests;
