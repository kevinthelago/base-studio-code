//! Suricata EVE JSON into the events the sensor emits.
//!
//! ## This is an attack surface, not a format reader
//!
//! Every interesting field here — the signature message, a DNS `rrname`, the
//! addresses — derives from traffic **somebody else chose to send**. An
//! adversary writes the input to this parser. Two consequences shape the whole
//! module.
//!
//! ### An un-emittable event is a silencing attack
//!
//! The datagram plaintext budget is [`MAX_PLAINTEXT_BYTES`] — about 1100
//! bytes. A DNS query name may be 253 bytes, a Suricata signature can run to
//! hundreds, and one EVE line carries several such fields at once. If a
//! crafted event exceeds the budget, `seal()` correctly refuses it and the
//! event is **dropped** — so an attacker who can shape traffic can generate
//! alerts that are physically un-emittable, and the alert about the attack
//! becomes the thing the attack suppresses.
//!
//! Nothing else in the design catches it: the emitter is right to refuse to
//! fragment, and the subscriber reports nothing missing, because from the
//! stream's point of view the event never existed. So every field is bounded
//! **at parse time** such that any event this module can produce fits one
//! datagram, and [`fits_one_datagram`] is asserted against maximal adversarial
//! input rather than argued for in a comment.
//!
//! ### Naive truncation is a remote panic
//!
//! Rust panics if a slice range falls inside a multi-byte UTF-8 character. So
//! `&s[..N]` on an attacker-controlled string is a remote crash on the sensor
//! — a cheaper silencing attack than the first one, and a DNS name is an
//! entirely ordinary place to find multi-byte characters. [`truncate_marked`]
//! respects character boundaries, and a test puts one exactly on the cut.

use bsc_lan_stream::envelope::MAX_PLAINTEXT_BYTES;
use bsc_lan_stream::frame::Event;

/// Longest EVE line this parser will even look at.
///
/// EVE lines are normally a few hundred bytes; the largest legitimate ones
/// (TLS with a full certificate chain) stay well under this. Refusing beyond
/// it bounds the work an adversary can cause on a 4 GB box that is already
/// thermally saturated, before any parsing happens.
pub const MAX_LINE_BYTES: usize = 64 * 1024;

/// Bounds chosen so the worst case still fits one datagram. See
/// [`fits_one_datagram`], which proves it rather than trusting it.
pub const MAX_SIGNATURE_BYTES: usize = 160;
pub const MAX_NAME_BYTES: usize = 160;
pub const MAX_ADDR_BYTES: usize = 45; // an IPv6 literal with a zone id
pub const MAX_PROTO_BYTES: usize = 8;

/// Appended when a field was cut, so a reader can tell a short value from a
/// long one that was shortened. Silent truncation would make an attacker's
/// 300-byte signature indistinguishable from a genuine 160-byte one.
pub const TRUNCATION_MARK: &str = "…";

#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum EveError {
    #[error("line is {got} bytes, over the {max}-byte limit -- refused before parsing")]
    TooLong { got: usize, max: usize },
    #[error("not valid JSON: {0}")]
    NotJson(String),
    #[error("no event_type field")]
    NoEventType,
    #[error("event_type {0:?} is missing the fields it needs")]
    Incomplete(String),
}

/// What one line produced.
#[derive(Debug, Clone, PartialEq)]
pub enum Parsed {
    /// An event to emit.
    Event(Event),
    /// A known `event_type` this sensor does not forward (`stats`, `http`,
    /// `tls`, …). Deliberately NOT an error: ignoring a type we chose not to
    /// carry is not a parse failure, and counting it as one would bury the
    /// real malformed-line count under ordinary traffic.
    NotForwarded(String),
}

/// Truncate to at most `max` bytes without ever splitting a character.
///
/// `&s[..max]` panics when `max` lands inside a multi-byte character, and this
/// function's input is attacker-controlled, so that would be a remote panic.
pub fn truncate_marked(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    // Leave room for the mark, then walk back to a character boundary.
    let budget = max.saturating_sub(TRUNCATION_MARK.len());
    let mut cut = 0;
    for (i, c) in s.char_indices() {
        if i + c.len_utf8() > budget {
            break;
        }
        cut = i + c.len_utf8();
    }
    let mut out = String::with_capacity(cut + TRUNCATION_MARK.len());
    out.push_str(&s[..cut]);
    out.push_str(TRUNCATION_MARK);
    out
}

fn str_field(v: &serde_json::Value, key: &str, max: usize) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| truncate_marked(s, max))
}

/// Parse one EVE line.
pub fn parse_line(line: &str) -> Result<Parsed, EveError> {
    if line.len() > MAX_LINE_BYTES {
        return Err(EveError::TooLong { got: line.len(), max: MAX_LINE_BYTES });
    }

    let v: serde_json::Value =
        serde_json::from_str(line).map_err(|e| EveError::NotJson(e.to_string()))?;

    let event_type = v.get("event_type").and_then(|x| x.as_str()).ok_or(EveError::NoEventType)?;

    match event_type {
        "alert" => {
            let alert = v.get("alert").ok_or_else(|| EveError::Incomplete("alert".into()))?;
            let sid = alert.get("signature_id").and_then(|x| x.as_u64()).unwrap_or(0) as u32;
            let msg = str_field(alert, "signature", MAX_SIGNATURE_BYTES).unwrap_or_default();
            let severity = alert.get("severity").and_then(|x| x.as_u64()).unwrap_or(3).min(255) as u8;
            Ok(Parsed::Event(Event::Alert {
                sid,
                msg,
                src: str_field(&v, "src_ip", MAX_ADDR_BYTES).unwrap_or_default(),
                dst: str_field(&v, "dest_ip", MAX_ADDR_BYTES).unwrap_or_default(),
                severity,
            }))
        }
        "flow" => {
            let flow = v.get("flow").ok_or_else(|| EveError::Incomplete("flow".into()))?;
            let to_server = flow.get("bytes_toserver").and_then(|x| x.as_u64()).unwrap_or(0);
            let to_client = flow.get("bytes_toclient").and_then(|x| x.as_u64()).unwrap_or(0);
            Ok(Parsed::Event(Event::Flow {
                src: str_field(&v, "src_ip", MAX_ADDR_BYTES).unwrap_or_default(),
                dst: str_field(&v, "dest_ip", MAX_ADDR_BYTES).unwrap_or_default(),
                proto: str_field(&v, "proto", MAX_PROTO_BYTES).unwrap_or_default(),
                bytes: to_server.saturating_add(to_client),
            }))
        }
        "dns" => {
            let dns = v.get("dns").ok_or_else(|| EveError::Incomplete("dns".into()))?;
            // A DNS name is the most attacker-controlled string on the wire:
            // the adversary picks every byte, and 253 is the protocol maximum.
            let name = str_field(dns, "rrname", MAX_NAME_BYTES).unwrap_or_default();
            Ok(Parsed::Event(Event::Alert {
                sid: 0,
                msg: format!("dns {name}"),
                src: str_field(&v, "src_ip", MAX_ADDR_BYTES).unwrap_or_default(),
                dst: str_field(&v, "dest_ip", MAX_ADDR_BYTES).unwrap_or_default(),
                severity: 4,
            }))
        }
        other => Ok(Parsed::NotForwarded(other.to_string())),
    }
}

/// Whether an event, once framed, fits inside one datagram's plaintext budget.
///
/// The bound that makes "no packet can silence the sensor" true. Called by the
/// tests against deliberately maximal input; cheap enough to call in anger.
pub fn fits_one_datagram(event: &Event) -> bool {
    bsc_lan_stream::frame::Frame::Delta(event.clone())
        .encode()
        .map(|b| b.len() <= MAX_PLAINTEXT_BYTES)
        .unwrap_or(false)
}

/// Running tally of what a stream of lines produced.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EveCounters {
    pub forwarded: u64,
    pub not_forwarded: u64,
    /// Lines that could not be parsed. Counted rather than silently skipped:
    /// a parser that quietly discards what it cannot read reports a clean
    /// stream while seeing nothing.
    pub malformed: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures in Suricata's real EVE shape.
    const ALERT: &str = r#"{"timestamp":"2026-09-04T10:00:00.000000+0000","flow_id":1587,"in_iface":"eth0","event_type":"alert","src_ip":"10.99.4.66","src_port":54321,"dest_ip":"10.99.2.1","dest_port":22,"proto":"TCP","alert":{"action":"allowed","gid":1,"signature_id":2010935,"rev":3,"signature":"ET SCAN Potential SSH Scan OUTBOUND","category":"Attempted Information Leak","severity":2}}"#;
    const FLOW: &str = r#"{"timestamp":"2026-09-04T10:00:00.000000+0000","event_type":"flow","src_ip":"10.99.3.20","src_port":443,"dest_ip":"10.99.2.118","dest_port":51000,"proto":"TCP","flow":{"pkts_toserver":10,"pkts_toclient":8,"bytes_toserver":1000,"bytes_toclient":2000,"state":"closed","reason":"timeout"}}"#;
    const DNS: &str = r#"{"timestamp":"2026-09-04T10:00:00.000000+0000","event_type":"dns","src_ip":"10.99.4.66","dest_ip":"10.99.2.1","dns":{"type":"query","id":1,"rrname":"telemetry.example.com","rrtype":"A"}}"#;
    const STATS: &str = r#"{"timestamp":"2026-09-04T10:00:00.000000+0000","event_type":"stats","stats":{"uptime":91}}"#;

    #[test]
    fn a_real_alert_line_parses() {
        match parse_line(ALERT).unwrap() {
            Parsed::Event(Event::Alert { sid, msg, src, dst, severity }) => {
                assert_eq!(sid, 2010935);
                assert_eq!(msg, "ET SCAN Potential SSH Scan OUTBOUND");
                assert_eq!(src, "10.99.4.66");
                assert_eq!(dst, "10.99.2.1");
                assert_eq!(severity, 2);
            }
            Parsed::Event(e) => panic!("expected an Alert, got {e:?}"),
            Parsed::NotForwarded(t) => panic!("expected an alert, but {t} was not forwarded"),
        }
    }

    #[test]
    fn a_real_flow_line_parses_and_sums_both_directions() {
        match parse_line(FLOW).unwrap() {
            Parsed::Event(Event::Flow { bytes, proto, .. }) => {
                assert_eq!(bytes, 3000);
                assert_eq!(proto, "TCP");
            }
            Parsed::Event(e) => panic!("expected a Flow, got {e:?}"),
            Parsed::NotForwarded(t) => panic!("expected a flow, but {t} was not forwarded"),
        }
    }

    #[test]
    fn a_real_dns_line_parses() {
        match parse_line(DNS).unwrap() {
            Parsed::Event(Event::Alert { msg, .. }) => assert!(msg.contains("telemetry.example.com")),
            Parsed::Event(e) => panic!("expected a dns-derived Alert, got {e:?}"),
            Parsed::NotForwarded(t) => panic!("expected a dns event, but {t} was not forwarded"),
        }
    }

    #[test]
    fn a_type_we_do_not_forward_is_not_a_parse_failure() {
        // Counting `stats` as malformed would bury the real malformed count
        // under entirely ordinary traffic.
        assert_eq!(parse_line(STATS).unwrap(), Parsed::NotForwarded("stats".into()));
    }

    #[test]
    fn a_malformed_line_is_an_error_rather_than_a_silent_skip() {
        assert!(matches!(parse_line("{not json"), Err(EveError::NotJson(_))));
        assert!(matches!(parse_line(""), Err(EveError::NotJson(_))));
        assert!(matches!(parse_line("{}"), Err(EveError::NoEventType)));
        assert!(matches!(
            parse_line(r#"{"event_type":"alert"}"#),
            Err(EveError::Incomplete(_))
        ));
    }

    #[test]
    fn an_absurdly_long_line_is_refused_before_it_is_parsed() {
        let huge = format!(r#"{{"event_type":"alert","pad":"{}"}}"#, "x".repeat(MAX_LINE_BYTES));
        assert!(matches!(parse_line(&huge), Err(EveError::TooLong { .. })));
    }

    // ---- the silencing attack ---------------------------------------------

    /// THE PROPERTY THIS MODULE IS NAMED FOR. Maximal adversarial input in
    /// every field at once must still produce an emittable event.
    #[test]
    fn no_crafted_packet_can_produce_an_un_emittable_event() {
        // Longest legal DNS name (253), a signature far longer than any real
        // one, and full-length IPv6 literals — all in the same event.
        let name = "a".repeat(253);
        let signature = "S".repeat(2_000);
        let addr = "2001:0db8:85a3:0000:0000:8a2e:0370:7334%eth0";

        let alert = format!(
            r#"{{"event_type":"alert","src_ip":"{addr}","dest_ip":"{addr}","alert":{{"signature_id":4294967295,"signature":"{signature}","severity":255}}}}"#
        );
        let dns = format!(
            r#"{{"event_type":"dns","src_ip":"{addr}","dest_ip":"{addr}","dns":{{"rrname":"{name}","rrtype":"A"}}}}"#
        );
        let flow = format!(
            r#"{{"event_type":"flow","src_ip":"{addr}","dest_ip":"{addr}","proto":"PROTOCOLX","flow":{{"bytes_toserver":18446744073709551615,"bytes_toclient":18446744073709551615}}}}"#
        );

        for (what, line) in [("alert", alert), ("dns", dns), ("flow", flow)] {
            match parse_line(&line).unwrap() {
                Parsed::Event(e) => assert!(
                    fits_one_datagram(&e),
                    "a crafted {what} produced an event that cannot be emitted -- an attacker \
                     could shape traffic to silence the sensor for exactly the events worth \
                     reporting, and nothing downstream would notice, because from the stream's \
                     point of view the event never existed"
                ),
                Parsed::NotForwarded(t) => panic!("{what} was not forwarded ({t})"),
            }
        }
    }

    // ---- the panic vector --------------------------------------------------

    #[test]
    fn truncation_never_splits_a_multi_byte_character() {
        // Place a 3-byte character so the naive cut lands inside it. `&s[..N]`
        // would panic here, and the input is attacker-controlled.
        for pad in 0..8usize {
            let s = format!("{}{}", "a".repeat(pad), "☃".repeat(200));
            let out = truncate_marked(&s, 64);
            assert!(out.len() <= 64, "pad {pad}: {} bytes", out.len());
            assert!(out.is_char_boundary(out.len()));
        }
    }

    #[test]
    fn truncation_is_marked_so_a_cut_value_is_distinguishable() {
        let long = "S".repeat(500);
        let out = truncate_marked(&long, MAX_SIGNATURE_BYTES);
        assert!(out.ends_with(TRUNCATION_MARK), "a cut field must say so");
        assert!(out.len() <= MAX_SIGNATURE_BYTES);

        let short = "ET SCAN";
        assert_eq!(truncate_marked(short, MAX_SIGNATURE_BYTES), short);
        assert!(!truncate_marked(short, MAX_SIGNATURE_BYTES).ends_with(TRUNCATION_MARK));
    }

    #[test]
    fn a_multi_byte_name_survives_parsing_without_panicking() {
        let name = "☃".repeat(300);
        let line = format!(
            r#"{{"event_type":"dns","src_ip":"1.2.3.4","dest_ip":"5.6.7.8","dns":{{"rrname":"{name}"}}}}"#
        );
        match parse_line(&line).unwrap() {
            Parsed::Event(e) => assert!(fits_one_datagram(&e)),
            Parsed::NotForwarded(t) => panic!("expected an event, but {t} was not forwarded"),
        }
    }
}
