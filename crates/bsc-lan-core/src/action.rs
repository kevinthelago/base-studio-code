//! `Action`: the catalog of every function this system can perform, from a
//! Tier 0 read to a Tier 2 mutation. Every variant carries its own typed
//! arguments -- see [`crate::target`] and [`crate::primitives`] -- and four
//! dispatch functions below (`tier`, `target`, `render`, `inverse_kind`) are
//! written as exhaustive matches with no wildcard arm, so adding a variant
//! without updating all four is a compile error (`E0004`), not a runtime
//! surprise. `wildcard_enum_match_arm` is denied crate-wide in `lib.rs` so a
//! later contributor cannot quietly defeat this by adding a `_ =>` arm.
//!
//! The 52-item catalog was assembled from the acceptance criteria of the
//! thirteen action- and tool-owning feature streams (no single document
//! lists it); the grouping below preserves that provenance so a variant's
//! owning stream is traceable.

use std::net::IpAddr;

use crate::primitives::{Hostname, L4Protocol, MacAddr, PortNumber, VlanId};
use crate::target::{FlowTuple, Target, TimeWindow};
use crate::tier::Tier;
use crate::ttl::Ttl;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("id must not be empty")]
pub struct EmptyIdError;

fn non_empty(id: String) -> Result<String, EmptyIdError> {
    if id.is_empty() {
        Err(EmptyIdError)
    } else {
        Ok(id)
    }
}

/// An opaque identifier for a previously-raised incident. Construction only
/// guarantees "not obviously wrong" (non-empty) -- ids are minted by
/// `bsc-lan-store`, a different crate, so this type does not claim to know
/// which ids actually exist.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct IncidentId(String);
impl IncidentId {
    pub fn new(id: impl Into<String>) -> Result<Self, EmptyIdError> {
        non_empty(id.into()).map(Self)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// An opaque identifier for a previously-raised silence.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct SilenceId(String);
impl SilenceId {
    pub fn new(id: impl Into<String>) -> Result<Self, EmptyIdError> {
        non_empty(id.into()).map(Self)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// An opaque stamp naming one `backup_config` snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct BackupStamp(String);
impl BackupStamp {
    pub fn new(id: impl Into<String>) -> Result<Self, EmptyIdError> {
        non_empty(id.into()).map(Self)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// An identifier for a previously-added firewall rule (an OPNsense rule
/// tracker/UUID).
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct FirewallRuleId(String);
impl FirewallRuleId {
    pub fn new(id: impl Into<String>) -> Result<Self, EmptyIdError> {
        non_empty(id.into()).map(Self)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A friendly device name (`rename_device`). Bounded and control-character
/// free so it is safe to display and to write into `devices.overrides.csv`,
/// but not a [`Hostname`] -- friendly names are free text ("Kevin's
/// Laptop"), not DNS labels.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FriendlyName(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum FriendlyNameError {
    #[error("friendly name must not be empty")]
    Empty,
    #[error("friendly name must be at most 64 characters")]
    TooLong,
    #[error("friendly name must not contain control characters")]
    ControlCharacter,
}

impl FriendlyName {
    pub fn new(name: impl Into<String>) -> Result<Self, FriendlyNameError> {
        let name = name.into();
        if name.is_empty() {
            return Err(FriendlyNameError::Empty);
        }
        if name.chars().count() > 64 {
            return Err(FriendlyNameError::TooLong);
        }
        if name.chars().any(|c| c.is_control()) {
            return Err(FriendlyNameError::ControlCharacter);
        }
        Ok(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A systemd unit name (`restart_service`). Validated against systemd's own
/// naming grammar subset -- alphanumerics, `-_.@:\` -- so a hostile string
/// cannot smuggle a shell metacharacter into an adapter's `systemctl`
/// invocation.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct ServiceUnit(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid systemd unit name {0:?}")]
pub struct ServiceUnitError(String);

impl ServiceUnit {
    pub fn new(name: impl Into<String>) -> Result<Self, ServiceUnitError> {
        let name = name.into();
        let valid = !name.is_empty()
            && name.len() <= 256
            && name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.@:\\".contains(c));
        if valid {
            Ok(Self(name))
        } else {
            Err(ServiceUnitError(name))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A rate limit, in kilobits per second. Zero is rejected -- a "limit" of
/// zero is a block, which is what `block_dest` / `quarantine` are for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BandwidthLimit(u32);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("bandwidth limit must be non-zero kbps")]
pub struct BandwidthLimitError;

impl BandwidthLimit {
    pub fn kbps(value: u32) -> Result<Self, BandwidthLimitError> {
        if value == 0 {
            Err(BandwidthLimitError)
        } else {
            Ok(Self(value))
        }
    }

    pub fn get_kbps(&self) -> u32 {
        self.0
    }
}

/// How urgently `open_incident` should be treated.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum IncidentSeverity {
    Info,
    Warning,
    Critical,
}

/// Suricata/alert severity, as consumed by the `alerts()` Tier 0 tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum AlertSeverity {
    Low,
    Medium,
    High,
}

/// A caller-authored LogQL query string for the `query()` escape hatch.
/// Unlike [`Hostname`], this text is authored by the calling identity (an
/// operator or the LLM under Tier 0), not reflected from attacker-
/// controlled telemetry, so it is not put through the same hostile-string
/// validation -- Loki's own parser is the authority on whether it is well
/// formed. It is still refused for guests by the policy engine.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LogQlQuery(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("LogQL query must not be empty")]
pub struct LogQlQueryError;

impl LogQlQuery {
    pub fn new(query: impl Into<String>) -> Result<Self, LogQlQueryError> {
        let query = query.into();
        if query.trim().is_empty() {
            Err(LogQlQueryError)
        } else {
            Ok(Self(query))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A caller-authored BPF filter, recorded at proposal-raise time as part of
/// the `evidence()`/`freeze_evidence()` coordinates. Same trust boundary
/// reasoning as [`LogQlQuery`]: authored by the caller, not telemetry.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct BpfFilter(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("BPF filter must not be empty")]
pub struct BpfFilterError;

impl BpfFilter {
    pub fn new(filter: impl Into<String>) -> Result<Self, BpfFilterError> {
        let filter = filter.into();
        if filter.trim().is_empty() {
            Err(BpfFilterError)
        } else {
            Ok(Self(filter))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// How long frozen evidence is kept before it becomes a purge candidate.
/// Deliberately not the same type as [`crate::ttl::Ttl`]: a `Ttl` is an
/// auto-revert deadline registered on a live target system, while retention
/// is a purge-eligibility window enforced by `data-retention-and-purge`
/// against durable storage -- conflating them would let a retention class
/// accidentally satisfy the auto-revert Ttl requirement, or vice versa.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct RetentionClass {
    days: u32,
}

impl RetentionClass {
    /// The documented default for frozen evidence.
    pub const DEFAULT_DAYS: u32 = 90;

    pub fn days(days: u32) -> Self {
        Self { days }
    }

    pub fn default_evidence_retention() -> Self {
        Self {
            days: Self::DEFAULT_DAYS,
        }
    }

    pub fn get_days(&self) -> u32 {
        self.days
    }
}

/// A named pf table (e.g. `"quarantine"`), validated as a plain identifier
/// so it can never carry pf syntax.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct PfTable(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid pf table name {0:?}: must be a non-empty ASCII identifier")]
pub struct PfTableError(String);

impl PfTable {
    pub fn new(name: impl Into<String>) -> Result<Self, PfTableError> {
        let name = name.into();
        let valid = !name.is_empty()
            && name.len() <= 32
            && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if valid {
            Ok(Self(name))
        } else {
            Err(PfTableError(name))
        }
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// pf's rule action: `pass` or `block`. There is no `Delete` anywhere in
/// this catalog -- firewall rules are only ever added or toggled, per the
/// dhcp-and-firewall-rule-actions contract ("deletion is Tier 3 and is not
/// built at all"), so the absence of a delete path is a property of this
/// enum, not a convention layered on top of it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FirewallRuleAction {
    Pass,
    Block,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum FirewallDirection {
    In,
    Out,
}

/// What a firewall rule's source or destination matches.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum NetworkSelector {
    Any,
    Target(Target),
}

/// A proposed firewall rule, as passed to `firewall_rule_add`. The
/// destination port is a plain `u16` (see the module docs on `PortNumber`
/// vs. L4 ports) rather than a wrapper type, since a bare number carries no
/// string-injection risk.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct FirewallRuleSpec {
    pub description: String,
    pub action: FirewallRuleAction,
    pub direction: FirewallDirection,
    pub source: NetworkSelector,
    pub destination: NetworkSelector,
    pub protocol: Option<L4Protocol>,
    pub destination_port: Option<u16>,
}

/// Every function this system can perform. See the module docs for how
/// exhaustiveness is enforced, and `tier()` below for the full Tier 0/1/2
/// grouping with the owning stream noted per item.
///
/// Matching on `Action` without a wildcard arm and without covering every
/// variant is a compile error (E0004) -- the same mechanism that keeps
/// `tier`/`target`/`name`/`render`/`inverse_kind` honest as the catalog
/// grows:
///
/// ```compile_fail,E0004
/// # use bsc_lan_core::Action;
/// fn handle(a: &Action) -> &'static str {
///     match a {
///         Action::Health => "health",
///         // every other variant omitted, and no `_` arm: E0004
///         // non-exhaustive patterns
///     }
/// }
/// ```
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Action {
    // ---- Tier 0: flow-and-session-telemetry-tools -------------------
    Flows {
        target: Option<Target>,
        window: TimeWindow,
    },
    Talkers {
        window: TimeWindow,
        vlan: Option<VlanId>,
    },
    Sessions {
        target: Option<Target>,
        window: TimeWindow,
    },
    Timeline {
        target: Target,
        window: TimeWindow,
    },
    DnsQueries {
        target: Option<Target>,
        window: TimeWindow,
    },
    Alerts {
        window: TimeWindow,
        severity: Option<AlertSeverity>,
    },
    PortProfile {
        target: Target,
        window: TimeWindow,
    },
    Query {
        logql: LogQlQuery,
    },

    // ---- Tier 0: asset-and-device-identity-tools ---------------------
    Asset {
        identity: Target,
    },
    DeviceProfile {
        identity: Target,
    },

    // ---- Tier 0: topology-health-and-capacity-tools -------------------
    Topology,
    Health,
    Updates,
    Capacity,
    RuleExplain {
        flow: FlowTuple,
    },
    BaselineDiff {
        target: Option<Target>,
        window: TimeWindow,
    },

    // ---- Tier 0: declared-intent-and-drift-engine ---------------------
    Drift,

    // ---- Tier 0: scheduled-assurance-jobs (checks only) ----------------
    VerifyRules,
    CertCheck,

    // ---- Tier 1: containment-and-temporary-access-actions --------------
    BlockDest {
        target: Target,
    },
    Quarantine {
        target: Target,
    },
    DnsBlock {
        domain: Hostname,
    },
    RateLimit {
        target: Target,
        limit: BandwidthLimit,
    },
    AllowTemp {
        target: Target,
        ports: Vec<u16>,
    },
    KickClient {
        target: Target,
    },

    // ---- Tier 1: incident-and-alert-workflow ---------------------------
    OpenIncident {
        title: String,
        severity: IncidentSeverity,
    },
    CloseIncident {
        incident: IncidentId,
    },
    Silence {
        target: Option<Target>,
        reason: String,
    },
    Unsilence {
        silence: SilenceId,
    },
    Acknowledge {
        incident: IncidentId,
    },

    // ---- Tier 1: evidence-capture-and-freezing --------------------------
    Evidence {
        bpf: BpfFilter,
        window: TimeWindow,
    },
    FreezeEvidence {
        bpf: BpfFilter,
        window: TimeWindow,
        incident: IncidentId,
        retention: RetentionClass,
    },
    Snapshot {
        incident: IncidentId,
    },

    // ---- Tier 1: config-backup-and-restore (the backup half) ------------
    BackupConfig,

    // ---- Tier 1: scheduled-assurance-jobs (mutating maintenance) --------
    SuricataUpdate,
    ReloadRules,
    PrunePcap,

    // ---- Tier 2: device-authorisation-actions ---------------------------
    ApproveDevice {
        target: Target,
        vlan: VlanId,
    },
    DenyDevice {
        target: Target,
    },
    RenameDevice {
        target: Target,
        name: FriendlyName,
    },

    // ---- Tier 2: switch-port-control-actions -----------------------------
    SetPortVlan {
        switch: Hostname,
        port: PortNumber,
        vlan: VlanId,
    },
    SetPortState {
        switch: Hostname,
        port: PortNumber,
        enabled: bool,
    },
    SetPoe {
        switch: Hostname,
        port: PortNumber,
        enabled: bool,
    },

    // ---- Tier 2: dhcp-and-firewall-rule-actions ---------------------------
    ReserveDhcp {
        mac: MacAddr,
        ip: IpAddr,
        hostname: Option<Hostname>,
    },
    ReleaseLease {
        mac: MacAddr,
    },
    FirewallRuleAdd {
        spec: FirewallRuleSpec,
    },
    FirewallRuleDisable {
        rule: FirewallRuleId,
    },
    FirewallRuleEnable {
        rule: FirewallRuleId,
    },

    // ---- Tier 2: host-control-actions --------------------------------------
    RestartService {
        host: Hostname,
        unit: ServiceUnit,
    },
    RebootHost {
        host: Hostname,
    },

    // ---- Tier 2: config-backup-and-restore (the restore half) -------------
    RestoreConfig {
        stamp: BackupStamp,
    },

    // ---- Tier 2: data-retention-and-purge ----------------------------------
    PurgeDevice {
        target: Target,
    },
}

impl Action {
    /// The authorisation tier this action requires. Exhaustive over every
    /// variant with no wildcard arm -- see the module docs.
    pub fn tier(&self) -> Tier {
        match self {
            Action::Flows { .. }
            | Action::Talkers { .. }
            | Action::Sessions { .. }
            | Action::Timeline { .. }
            | Action::DnsQueries { .. }
            | Action::Alerts { .. }
            | Action::PortProfile { .. }
            | Action::Query { .. }
            | Action::Asset { .. }
            | Action::DeviceProfile { .. }
            | Action::Topology
            | Action::Health
            | Action::Updates
            | Action::Capacity
            | Action::RuleExplain { .. }
            | Action::BaselineDiff { .. }
            | Action::Drift
            | Action::VerifyRules
            | Action::CertCheck => Tier::Zero,

            Action::BlockDest { .. }
            | Action::Quarantine { .. }
            | Action::DnsBlock { .. }
            | Action::RateLimit { .. }
            | Action::AllowTemp { .. }
            | Action::KickClient { .. }
            | Action::OpenIncident { .. }
            | Action::CloseIncident { .. }
            | Action::Silence { .. }
            | Action::Unsilence { .. }
            | Action::Acknowledge { .. }
            | Action::Evidence { .. }
            | Action::FreezeEvidence { .. }
            | Action::Snapshot { .. }
            | Action::BackupConfig
            | Action::SuricataUpdate
            | Action::ReloadRules
            | Action::PrunePcap => Tier::One,

            Action::ApproveDevice { .. }
            | Action::DenyDevice { .. }
            | Action::RenameDevice { .. }
            | Action::SetPortVlan { .. }
            | Action::SetPortState { .. }
            | Action::SetPoe { .. }
            | Action::ReserveDhcp { .. }
            | Action::ReleaseLease { .. }
            | Action::FirewallRuleAdd { .. }
            | Action::FirewallRuleDisable { .. }
            | Action::FirewallRuleEnable { .. }
            | Action::RestartService { .. }
            | Action::RebootHost { .. }
            | Action::RestoreConfig { .. }
            | Action::PurgeDevice { .. } => Tier::Two,
        }
    }

    /// Whether this Tier 1 action installs revocable state on a live target
    /// system and therefore must be wrapped in a [`TimeBoundedAction`]
    /// before it can execute. Deliberately narrower than "is Tier 1":
    /// `open_incident`/`close_incident`/`unsilence`/`acknowledge` are
    /// store-local workflow transitions with no live state to auto-revert,
    /// and `evidence`/`freeze_evidence`/`snapshot`/`backup_config`/
    /// `suricata_update`/`reload_rules`/`prune_pcap` are one-shot reads or
    /// maintenance operations, not installed state. Forcing a `Ttl` onto
    /// those would be fabricated data, not a safety property -- see the
    /// crate's `bsc-note` history for the full reasoning.
    pub fn requires_ttl(&self) -> bool {
        matches!(
            self,
            Action::BlockDest { .. }
                | Action::Quarantine { .. }
                | Action::DnsBlock { .. }
                | Action::RateLimit { .. }
                | Action::AllowTemp { .. }
                | Action::KickClient { .. }
                | Action::Silence { .. }
        )
    }
}

impl Action {
    /// The [`Target`] this action refers to, if any -- what `bsc-lan-policy`
    /// matches against the never-touch list before an adapter is
    /// constructed. `None` means the action has no target to check (a
    /// system-wide read or maintenance operation); it is never used to mean
    /// "target intentionally omitted" for an action that has one.
    ///
    /// Exhaustive over every variant with no wildcard arm.
    pub fn target(&self) -> Option<Target> {
        match self {
            Action::Flows { target, .. } => target.clone(),
            Action::Talkers { .. } => None,
            Action::Sessions { target, .. } => target.clone(),
            Action::Timeline { target, .. } => Some(target.clone()),
            Action::DnsQueries { target, .. } => target.clone(),
            Action::Alerts { .. } => None,
            Action::PortProfile { target, .. } => Some(target.clone()),
            Action::Query { .. } => None,
            Action::Asset { identity } => Some(identity.clone()),
            Action::DeviceProfile { identity } => Some(identity.clone()),
            Action::Topology => None,
            Action::Health => None,
            Action::Updates => None,
            Action::Capacity => None,
            Action::RuleExplain { .. } => None,
            Action::BaselineDiff { target, .. } => target.clone(),
            Action::Drift => None,
            Action::VerifyRules => None,
            Action::CertCheck => None,

            Action::BlockDest { target } => Some(target.clone()),
            Action::Quarantine { target } => Some(target.clone()),
            Action::DnsBlock { domain } => Some(Target::Domain(domain.clone())),
            Action::RateLimit { target, .. } => Some(target.clone()),
            Action::AllowTemp { target, .. } => Some(target.clone()),
            Action::KickClient { target } => Some(target.clone()),
            Action::OpenIncident { .. } => None,
            Action::CloseIncident { .. } => None,
            Action::Silence { target, .. } => target.clone(),
            Action::Unsilence { .. } => None,
            Action::Acknowledge { .. } => None,
            Action::Evidence { .. } => None,
            Action::FreezeEvidence { .. } => None,
            Action::Snapshot { .. } => None,
            Action::BackupConfig => None,
            Action::SuricataUpdate => None,
            Action::ReloadRules => None,
            Action::PrunePcap => None,

            Action::ApproveDevice { target, .. } => Some(target.clone()),
            Action::DenyDevice { target } => Some(target.clone()),
            Action::RenameDevice { target, .. } => Some(target.clone()),
            Action::SetPortVlan { switch, port, .. } => Some(Target::SwitchPort {
                switch: switch.clone(),
                port: *port,
            }),
            Action::SetPortState { switch, port, .. } => Some(Target::SwitchPort {
                switch: switch.clone(),
                port: *port,
            }),
            Action::SetPoe { switch, port, .. } => Some(Target::SwitchPort {
                switch: switch.clone(),
                port: *port,
            }),
            Action::ReserveDhcp { mac, .. } => Some(Target::Mac(*mac)),
            Action::ReleaseLease { mac } => Some(Target::Mac(*mac)),
            Action::FirewallRuleAdd { .. } => None,
            Action::FirewallRuleDisable { .. } => None,
            Action::FirewallRuleEnable { .. } => None,
            Action::RestartService { host, .. } => Some(Target::Host(host.clone())),
            Action::RebootHost { host } => Some(Target::Host(host.clone())),
            Action::RestoreConfig { .. } => None,
            Action::PurgeDevice { target } => Some(target.clone()),
        }
    }
}

impl Action {
    /// The catalog name every surface, audit row and dry-run rendering uses
    /// to refer to this action. A hand-written match (not derived), so it
    /// is one of the four dispatches that must grow an arm before a new
    /// variant compiles -- deriving this from the variant name via a macro
    /// would silently track new variants and defeat that guarantee.
    ///
    /// Exhaustive over every variant with no wildcard arm.
    pub fn name(&self) -> &'static str {
        match self {
            Action::Flows { .. } => "flows",
            Action::Talkers { .. } => "talkers",
            Action::Sessions { .. } => "sessions",
            Action::Timeline { .. } => "timeline",
            Action::DnsQueries { .. } => "dns_queries",
            Action::Alerts { .. } => "alerts",
            Action::PortProfile { .. } => "port_profile",
            Action::Query { .. } => "query",
            Action::Asset { .. } => "asset",
            Action::DeviceProfile { .. } => "device_profile",
            Action::Topology => "topology",
            Action::Health => "health",
            Action::Updates => "updates",
            Action::Capacity => "capacity",
            Action::RuleExplain { .. } => "rule_explain",
            Action::BaselineDiff { .. } => "baseline_diff",
            Action::Drift => "drift",
            Action::VerifyRules => "verify_rules",
            Action::CertCheck => "cert_check",

            Action::BlockDest { .. } => "block_dest",
            Action::Quarantine { .. } => "quarantine",
            Action::DnsBlock { .. } => "dns_block",
            Action::RateLimit { .. } => "rate_limit",
            Action::AllowTemp { .. } => "allow_temp",
            Action::KickClient { .. } => "kick_client",
            Action::OpenIncident { .. } => "open_incident",
            Action::CloseIncident { .. } => "close_incident",
            Action::Silence { .. } => "silence",
            Action::Unsilence { .. } => "unsilence",
            Action::Acknowledge { .. } => "acknowledge",
            Action::Evidence { .. } => "evidence",
            Action::FreezeEvidence { .. } => "freeze_evidence",
            Action::Snapshot { .. } => "snapshot",
            Action::BackupConfig => "backup_config",
            Action::SuricataUpdate => "suricata_update",
            Action::ReloadRules => "reload_rules",
            Action::PrunePcap => "prune_pcap",

            Action::ApproveDevice { .. } => "approve_device",
            Action::DenyDevice { .. } => "deny_device",
            Action::RenameDevice { .. } => "rename_device",
            Action::SetPortVlan { .. } => "set_port_vlan",
            Action::SetPortState { .. } => "set_port_state",
            Action::SetPoe { .. } => "set_poe",
            Action::ReserveDhcp { .. } => "reserve_dhcp",
            Action::ReleaseLease { .. } => "release_lease",
            Action::FirewallRuleAdd { .. } => "firewall_rule_add",
            Action::FirewallRuleDisable { .. } => "firewall_rule_disable",
            Action::FirewallRuleEnable { .. } => "firewall_rule_enable",
            Action::RestartService { .. } => "restart_service",
            Action::RebootHost { .. } => "reboot_host",
            Action::RestoreConfig { .. } => "restore_config",
            Action::PurgeDevice { .. } => "purge_device",
        }
    }

    /// A generic, adapter-agnostic dry-run rendering: the catalog name plus
    /// the typed arguments' `Debug` form and the resolved target, if any.
    /// This is the base rendering every proposal carries; an adapter may
    /// additionally render its own byte-exact command text (e.g. the
    /// literal switch CLI commands), which this crate has no way to know
    /// since it performs no I/O and holds no adapter state.
    pub fn render(&self) -> String {
        match self.target() {
            Some(target) => format!("{}({target}) {:?}", self.name(), self),
            None => format!("{}() {:?}", self.name(), self),
        }
    }
}

/// The shape of an action's undo, independent of the concrete prior-state
/// value (which the adapter captures at execution time, per
/// `contracts/adapter-traits.md` rule 4 -- this crate performs no I/O and
/// so never holds that value itself).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InverseKind {
    /// Undo restores whatever state existed immediately before this action
    /// ran, captured from the pre-change read (a table entry removed, a
    /// PVID set back, a mapping restored, an artifact deleted).
    RestoresPriorState,
    /// A different, specifically-named catalog action performs the undo
    /// rather than a generic prior-state restore.
    DistinctInverseAction { inverse_action_name: &'static str },
    /// No true inverse exists. Any recorded "inverse" is a documented
    /// recovery path, not an undo, and must never be presented as undoable
    /// on any surface.
    Irreversible,
    /// Nothing to undo: a pure read, or an action that is itself already
    /// the undo/terminal half of a pair.
    NotApplicable,
}

impl Action {
    /// How this action's undo is shaped. See [`InverseKind`].
    ///
    /// Exhaustive over every variant with no wildcard arm.
    pub fn inverse_kind(&self) -> InverseKind {
        match self {
            Action::Flows { .. }
            | Action::Talkers { .. }
            | Action::Sessions { .. }
            | Action::Timeline { .. }
            | Action::DnsQueries { .. }
            | Action::Alerts { .. }
            | Action::PortProfile { .. }
            | Action::Query { .. }
            | Action::Asset { .. }
            | Action::DeviceProfile { .. }
            | Action::Topology
            | Action::Health
            | Action::Updates
            | Action::Capacity
            | Action::RuleExplain { .. }
            | Action::BaselineDiff { .. }
            | Action::Drift
            | Action::VerifyRules
            | Action::CertCheck
            | Action::Evidence { .. } => InverseKind::NotApplicable,

            Action::BlockDest { .. }
            | Action::Quarantine { .. }
            | Action::DnsBlock { .. }
            | Action::RateLimit { .. }
            | Action::AllowTemp { .. }
            | Action::KickClient { .. } => InverseKind::RestoresPriorState,

            Action::OpenIncident { .. } => InverseKind::DistinctInverseAction {
                inverse_action_name: "close_incident",
            },
            Action::CloseIncident { .. } => InverseKind::RestoresPriorState,
            Action::Silence { .. } => InverseKind::DistinctInverseAction {
                inverse_action_name: "unsilence",
            },
            Action::Unsilence { .. } => InverseKind::NotApplicable,
            Action::Acknowledge { .. } => InverseKind::RestoresPriorState,

            Action::FreezeEvidence { .. } => InverseKind::RestoresPriorState,
            Action::Snapshot { .. } => InverseKind::RestoresPriorState,
            Action::BackupConfig => InverseKind::RestoresPriorState,
            Action::SuricataUpdate | Action::ReloadRules | Action::PrunePcap => {
                InverseKind::Irreversible
            }

            Action::ApproveDevice { .. } => InverseKind::DistinctInverseAction {
                inverse_action_name: "deny_device",
            },
            Action::DenyDevice { .. } => InverseKind::RestoresPriorState,
            Action::RenameDevice { .. } => InverseKind::RestoresPriorState,
            Action::SetPortVlan { .. } => InverseKind::RestoresPriorState,
            Action::SetPortState { .. } => InverseKind::RestoresPriorState,
            Action::SetPoe { .. } => InverseKind::RestoresPriorState,
            Action::ReserveDhcp { .. } => InverseKind::RestoresPriorState,
            Action::ReleaseLease { .. } => InverseKind::RestoresPriorState,
            Action::FirewallRuleAdd { .. } => InverseKind::DistinctInverseAction {
                inverse_action_name: "firewall_rule_disable",
            },
            Action::FirewallRuleDisable { .. } => InverseKind::DistinctInverseAction {
                inverse_action_name: "firewall_rule_enable",
            },
            Action::FirewallRuleEnable { .. } => InverseKind::DistinctInverseAction {
                inverse_action_name: "firewall_rule_disable",
            },
            Action::RestartService { .. } => InverseKind::Irreversible,
            Action::RebootHost { .. } => InverseKind::Irreversible,
            Action::RestoreConfig { .. } => InverseKind::RestoresPriorState,
            Action::PurgeDevice { .. } => InverseKind::Irreversible,
        }
    }
}

/// A Tier 1 action that installs revocable state, paired with its
/// expiry. The only constructor, [`TimeBoundedAction::new`], takes both an
/// [`Action`] and a [`Ttl`] and rejects any action for which
/// [`Action::requires_ttl`] is false -- there is no way to obtain a
/// `TimeBoundedAction` without supplying an expiry, which is what makes a
/// non-expiring installed-state Tier 1 action unrepresentable.
#[derive(Debug, Clone, PartialEq)]
pub struct TimeBoundedAction {
    action: Action,
    ttl: Ttl,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{action_name} does not install revocable target state and cannot be time-bounded")]
pub struct NotTimeBoundableError {
    action_name: &'static str,
}

impl TimeBoundedAction {
    pub fn new(action: Action, ttl: Ttl) -> Result<Self, NotTimeBoundableError> {
        if action.requires_ttl() {
            Ok(Self { action, ttl })
        } else {
            Err(NotTimeBoundableError {
                action_name: action.name(),
            })
        }
    }

    pub fn action(&self) -> &Action {
        &self.action
    }

    pub fn ttl(&self) -> Ttl {
        self.ttl
    }

    pub fn into_parts(self) -> (Action, Ttl) {
        (self.action, self.ttl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn mac() -> MacAddr {
        "aa:bb:cc:dd:ee:ff".parse().unwrap()
    }

    fn host() -> Hostname {
        "switch.lan".parse().unwrap()
    }

    fn vlan() -> VlanId {
        VlanId::new(6).unwrap()
    }

    fn port() -> PortNumber {
        PortNumber::new(5).unwrap()
    }

    fn ip() -> IpAddr {
        "10.99.6.10".parse().unwrap()
    }

    fn window() -> TimeWindow {
        let end = SystemTime::UNIX_EPOCH + Duration::from_secs(2_000);
        let start = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000);
        TimeWindow::new(start, end).unwrap()
    }

    fn target() -> Target {
        Target::Mac(mac())
    }

    fn incident_id() -> IncidentId {
        IncidentId::new("inc-1").unwrap()
    }

    /// One instance of every `Action` variant, in the same order as the
    /// enum definition. Exists so the dispatch functions below can be
    /// regression-tested against the whole catalog at once.
    fn all_actions() -> Vec<Action> {
        vec![
            Action::Flows {
                target: Some(target()),
                window: window(),
            },
            Action::Talkers {
                window: window(),
                vlan: Some(vlan()),
            },
            Action::Sessions {
                target: None,
                window: window(),
            },
            Action::Timeline {
                target: target(),
                window: window(),
            },
            Action::DnsQueries {
                target: None,
                window: window(),
            },
            Action::Alerts {
                window: window(),
                severity: Some(AlertSeverity::High),
            },
            Action::PortProfile {
                target: target(),
                window: window(),
            },
            Action::Query {
                logql: LogQlQuery::new("job suricata").unwrap(),
            },
            Action::Asset { identity: target() },
            Action::DeviceProfile { identity: target() },
            Action::Topology,
            Action::Health,
            Action::Updates,
            Action::Capacity,
            Action::RuleExplain {
                flow: FlowTuple {
                    source: ip(),
                    destination: ip(),
                    destination_port: Some(443),
                    protocol: L4Protocol::Tcp,
                },
            },
            Action::BaselineDiff {
                target: None,
                window: window(),
            },
            Action::Drift,
            Action::VerifyRules,
            Action::CertCheck,
            Action::BlockDest { target: target() },
            Action::Quarantine { target: target() },
            Action::DnsBlock { domain: host() },
            Action::RateLimit {
                target: target(),
                limit: BandwidthLimit::kbps(1000).unwrap(),
            },
            Action::AllowTemp {
                target: target(),
                ports: vec![80, 443],
            },
            Action::KickClient { target: target() },
            Action::OpenIncident {
                title: String::from("test"),
                severity: IncidentSeverity::Warning,
            },
            Action::CloseIncident {
                incident: incident_id(),
            },
            Action::Silence {
                target: Some(target()),
                reason: String::from("maintenance"),
            },
            Action::Unsilence {
                silence: SilenceId::new("sil-1").unwrap(),
            },
            Action::Acknowledge {
                incident: incident_id(),
            },
            Action::Evidence {
                bpf: BpfFilter::new("host lumpy-space").unwrap(),
                window: window(),
            },
            Action::FreezeEvidence {
                bpf: BpfFilter::new("host lumpy-space").unwrap(),
                window: window(),
                incident: incident_id(),
                retention: RetentionClass::default_evidence_retention(),
            },
            Action::Snapshot {
                incident: incident_id(),
            },
            Action::BackupConfig,
            Action::SuricataUpdate,
            Action::ReloadRules,
            Action::PrunePcap,
            Action::ApproveDevice {
                target: target(),
                vlan: vlan(),
            },
            Action::DenyDevice { target: target() },
            Action::RenameDevice {
                target: target(),
                name: FriendlyName::new("Kevins Laptop").unwrap(),
            },
            Action::SetPortVlan {
                switch: host(),
                port: port(),
                vlan: vlan(),
            },
            Action::SetPortState {
                switch: host(),
                port: port(),
                enabled: true,
            },
            Action::SetPoe {
                switch: host(),
                port: port(),
                enabled: true,
            },
            Action::ReserveDhcp {
                mac: mac(),
                ip: ip(),
                hostname: Some(host()),
            },
            Action::ReleaseLease { mac: mac() },
            Action::FirewallRuleAdd {
                spec: FirewallRuleSpec {
                    description: String::from("test rule"),
                    action: FirewallRuleAction::Block,
                    direction: FirewallDirection::Out,
                    source: NetworkSelector::Target(target()),
                    destination: NetworkSelector::Any,
                    protocol: Some(L4Protocol::Tcp),
                    destination_port: Some(443),
                },
            },
            Action::FirewallRuleDisable {
                rule: FirewallRuleId::new("rule-1").unwrap(),
            },
            Action::FirewallRuleEnable {
                rule: FirewallRuleId::new("rule-1").unwrap(),
            },
            Action::RestartService {
                host: host(),
                unit: ServiceUnit::new("suricata.service").unwrap(),
            },
            Action::RebootHost { host: host() },
            Action::RestoreConfig {
                stamp: BackupStamp::new("2026-07-28T12-00-00").unwrap(),
            },
            Action::PurgeDevice { target: target() },
        ]
    }

    #[test]
    fn catalog_has_exactly_fifty_two_actions() {
        assert_eq!(all_actions().len(), 52);
    }

    #[test]
    fn every_action_dispatches_without_panicking() {
        for action in all_actions() {
            let _ = action.tier();
            let _ = action.target();
            let _ = action.name();
            let _ = action.render();
            let _ = action.inverse_kind();
            let _ = action.requires_ttl();
        }
    }

    #[test]
    fn tier_counts_match_the_reconstructed_catalog() {
        let actions = all_actions();
        let count = |t: Tier| actions.iter().filter(|a| a.tier() == t).count();
        assert_eq!(count(Tier::Zero), 19);
        assert_eq!(count(Tier::One), 18);
        assert_eq!(count(Tier::Two), 15);
    }

    #[test]
    fn names_are_unique_and_snake_case() {
        let actions = all_actions();
        let mut names: Vec<&str> = actions.iter().map(|a| a.name()).collect();
        let before = names.len();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), before, "duplicate Action::name()");
        for n in names {
            assert!(
                n.chars().all(|c| c.is_ascii_lowercase() || c == '_'),
                "not snake_case: {n}"
            );
        }
    }

    #[test]
    fn requires_ttl_is_exactly_the_seven_revocable_installs() {
        let actions = all_actions();
        let mut ttl_names: Vec<&str> = actions
            .iter()
            .filter(|a| a.requires_ttl())
            .map(|a| a.name())
            .collect();
        ttl_names.sort_unstable();
        assert_eq!(
            ttl_names,
            vec![
                "allow_temp",
                "block_dest",
                "dns_block",
                "kick_client",
                "quarantine",
                "rate_limit",
                "silence"
            ]
        );
        for action in &actions {
            if action.requires_ttl() {
                assert_eq!(action.tier(), Tier::One, "not tier1: {}", action.name());
            }
        }
    }

    #[test]
    fn time_bounded_action_requires_ttl_for_revocable_actions() {
        let ttl = Ttl::from_mins(30).unwrap();
        assert!(TimeBoundedAction::new(Action::BlockDest { target: target() }, ttl).is_ok());
    }

    #[test]
    fn time_bounded_action_rejects_actions_that_do_not_install_state() {
        let ttl = Ttl::from_mins(30).unwrap();
        let err = TimeBoundedAction::new(Action::Health, ttl).unwrap_err();
        assert_eq!(err.action_name, "health");

        let action2 = Action::OpenIncident {
            title: String::from("x"),
            severity: IncidentSeverity::Info,
        };
        let err2 = TimeBoundedAction::new(action2, ttl).unwrap_err();
        assert_eq!(err2.action_name, "open_incident");
    }

    #[test]
    fn never_touch_target_is_none_for_untargeted_actions() {
        assert_eq!(Action::Health.target(), None);
        assert_eq!(Action::Drift.target(), None);
        assert_eq!(Action::BackupConfig.target(), None);
    }

    #[test]
    fn switch_port_actions_expose_a_switch_port_target() {
        let action = Action::SetPortVlan {
            switch: host(),
            port: port(),
            vlan: vlan(),
        };
        assert_eq!(
            action.target(),
            Some(Target::SwitchPort {
                switch: host(),
                port: port()
            })
        );
    }

    #[test]
    fn irreversible_actions_are_flagged_and_never_replay() {
        assert_eq!(
            Action::RebootHost { host: host() }.inverse_kind(),
            InverseKind::Irreversible
        );
        assert_eq!(
            Action::PurgeDevice { target: target() }.inverse_kind(),
            InverseKind::Irreversible
        );
        assert_eq!(Action::PrunePcap.inverse_kind(), InverseKind::Irreversible);
    }

    #[test]
    fn dry_run_render_is_deterministic() {
        let a = Action::BlockDest { target: target() };
        let b = Action::BlockDest { target: target() };
        assert_eq!(a.render(), b.render());
        assert!(a.render().starts_with("block_dest("));
    }
}
