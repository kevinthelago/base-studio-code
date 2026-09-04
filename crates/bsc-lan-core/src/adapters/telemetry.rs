//! [`TelemetryAdapter`]: Loki (LogQL), Zeek logs, Suricata EVE and the PCAP
//! ring. Implemented by `bsc-lan-adapter-telemetry`. The read path every
//! Tier 0 tool sits on -- `flows`/`talkers`/`sessions`/`timeline`/
//! `port_profile` are all composed by the tools layer from
//! [`TelemetryAdapter::read_flows`] and friends rather than each getting
//! its own adapter method, per `topology-health-and-capacity-tools`'s
//! approach note: "the tools own presentation and tiering while the
//! adapter owns sourcing".

use std::net::IpAddr;

use crate::action::{AlertSeverity, BpfFilter, LogQlQuery};
use crate::error::ObservationError;
use crate::evidence::Observed;
use crate::primitives::{Hostname, L4Protocol};
use crate::target::{Target, TimeWindow};

/// One flow record. Which side of [`FlowObservation`] it appears in *is*
/// its disposition -- there is deliberately no `disposition` field here to
/// collapse, per the flow-tools contract ("no endpoint returns a merged
/// list with a disposition flag").
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowRecord {
    pub source: IpAddr,
    pub destination: IpAddr,
    pub destination_port: Option<u16>,
    pub protocol: L4Protocol,
    pub bytes: u64,
    pub packets: u64,
}

/// The result of a flow query: attempted and passed flows as two distinct
/// fields. Mirror-sourced data can only ever populate `attempted` --
/// [`crate::evidence::Disposition::Passed`] requires firewall-log evidence
/// that a mirror read cannot produce, and this type mirrors that split at
/// the collection level so a caller cannot flatten them back into one list
/// without explicitly choosing to.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FlowObservation {
    pub attempted: Vec<FlowRecord>,
    pub passed: Vec<FlowRecord>,
}

/// One IDS alert (Suricata EVE).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertRecord {
    pub source: IpAddr,
    pub destination: IpAddr,
    pub severity: AlertSeverity,
    pub signature: String,
}

/// One resolved DNS query, as read from the DNS-facing side of telemetry
/// (Zeek `dns.log` / Suricata). Distinct from
/// [`crate::adapters::dns::DnsQueryRecord`], which reads Unbound's own
/// query log directly -- the two can disagree, and that disagreement is
/// itself interesting, so they are not unified into one type.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TelemetryDnsQuery {
    pub source: IpAddr,
    pub query: String,
}

/// The result of a PCAP-ring read: how much was captured. Zero packets is
/// a valid, successful value here -- "a capture that yields zero packets is
/// reported as a successful capture of zero packets", per the
/// evidence-capture-and-freezing contract. A window that has rotated out
/// of the ring entirely is a distinct outcome
/// ([`ObservationError::OutsideWindow`]), not an empty `PcapCapture`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PcapCapture {
    pub packet_count: u64,
    pub byte_count: u64,
}

pub trait TelemetryAdapter: Send + Sync {
    /// The raw LogQL escape hatch (`query()`). Built from a caller-authored
    /// [`LogQlQuery`], never from string concatenation of telemetry data.
    fn query_logql(
        &self,
        query: &LogQlQuery,
        window: TimeWindow,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<serde_json::Value>>, ObservationError>>
           + Send;

    /// Flows, split into attempted/passed. `target: None` means
    /// network-wide (refused for guests by the policy engine, not by this
    /// trait).
    fn read_flows(
        &self,
        target: Option<&Target>,
        window: TimeWindow,
    ) -> impl std::future::Future<Output = Result<Observed<FlowObservation>, ObservationError>> + Send;

    fn read_alerts(
        &self,
        window: TimeWindow,
        severity: Option<AlertSeverity>,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<AlertRecord>>, ObservationError>> + Send;

    fn read_dns_queries(
        &self,
        target: Option<&Target>,
        window: TimeWindow,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<TelemetryDnsQuery>>, ObservationError>>
           + Send;

    /// Read a window out of the PCAP ring for `evidence()`. `Err(
    /// ObservationError::OutsideWindow)` when the window has rotated out of
    /// the ring; `Ok` with `packet_count: 0` when the window is covered but
    /// nothing matched the filter -- these are different answers and must
    /// stay different answers.
    fn read_pcap_window(
        &self,
        bpf: &BpfFilter,
        window: TimeWindow,
    ) -> impl std::future::Future<Output = Result<Observed<PcapCapture>, ObservationError>> + Send;

    /// Copy the raw packet bytes for `bpf`/`window` out of the ring, for
    /// `freeze_evidence()` to persist before rotation. Same outside-window
    /// distinction as `read_pcap_window`; writing the copy to durable
    /// storage with its incident/retention metadata is
    /// `evidence-capture-and-freezing`'s job, not this adapter's.
    fn capture_pcap_bytes(
        &self,
        bpf: &BpfFilter,
        window: TimeWindow,
    ) -> impl std::future::Future<Output = Result<Observed<Vec<u8>>, ObservationError>> + Send;

    /// Reads the mirror's own hostname, for callers that need to name the
    /// sensor (e.g. never-touch checks that must never target it).
    fn sensor_host(&self) -> &Hostname;
}
