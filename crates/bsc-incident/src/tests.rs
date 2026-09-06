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
