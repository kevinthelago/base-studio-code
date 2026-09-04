//! `Target`: the one and only way an [`crate::action::Action`] names what it
//! acts on. Every arm is a typed value -- there is no `Target::Raw(String)`
//! and there never should be one; a bare-string arm would be exactly the
//! escape hatch this type exists to close.

use std::fmt;
use std::net::IpAddr;
use std::time::SystemTime;

use crate::primitives::{Hostname, L4Protocol, MacAddr, PortNumber, VlanId};

/// What an action or a never-touch rule refers to.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum Target {
    /// A single IP address (v4 or v6).
    Ip(IpAddr),
    /// A device identified by MAC -- the primary key for wireless/NAC
    /// operations, where IP can rotate under DHCP.
    Mac(MacAddr),
    /// A VLAN as a whole.
    Vlan(VlanId),
    /// A specific port on a specific switch -- distinct from `Mac`/`Ip`
    /// because never-touch protection for "the trunk port" or "the
    /// sensor's PoE port" is keyed on physical port, not on whatever
    /// happens to be plugged into it that day.
    SwitchPort { switch: Hostname, port: PortNumber },
    /// A host, named by its management hostname (e.g. for host-operations
    /// actions: `restart_service`, `reboot_host`).
    Host(Hostname),
    /// A DNS domain (e.g. for `dns_block`), reusing the same validated
    /// hostname grammar since a domain name is syntactically a hostname.
    Domain(Hostname),
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Target::Ip(ip) => write!(f, "ip:{ip}"),
            Target::Mac(mac) => write!(f, "mac:{mac}"),
            Target::Vlan(vlan) => write!(f, "vlan:{vlan}"),
            Target::SwitchPort { switch, port } => write!(f, "switch-port:{switch}/{port}"),
            Target::Host(host) => write!(f, "host:{host}"),
            Target::Domain(domain) => write!(f, "domain:{domain}"),
        }
    }
}

/// A closed, inclusive time range. `start` must not be after `end`;
/// construct through [`TimeWindow::new`] rather than the tuple directly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TimeWindow {
    start: SystemTime,
    end: SystemTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("time window start must not be after end")]
pub struct TimeWindowError;

impl TimeWindow {
    pub fn new(start: SystemTime, end: SystemTime) -> Result<Self, TimeWindowError> {
        if start > end {
            Err(TimeWindowError)
        } else {
            Ok(Self { start, end })
        }
    }

    pub fn start(&self) -> SystemTime {
        self.start
    }

    pub fn end(&self) -> SystemTime {
        self.end
    }
}

/// The typed 5-tuple `rule_explain()` evaluates against a fetched pf
/// ruleset. Kept here rather than in `bsc-lan-adapter-opnsense` since the
/// tuple is pure domain data, not an adapter concern.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub struct FlowTuple {
    pub source: IpAddr,
    pub destination: IpAddr,
    pub destination_port: Option<u16>,
    pub protocol: L4Protocol,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn time_window_rejects_inverted_range() {
        let now = SystemTime::UNIX_EPOCH + Duration::from_secs(1000);
        let earlier = SystemTime::UNIX_EPOCH + Duration::from_secs(500);
        assert!(TimeWindow::new(now, earlier).is_err());
        assert!(TimeWindow::new(earlier, now).is_ok());
        assert!(TimeWindow::new(now, now).is_ok());
    }

    #[test]
    fn target_display_is_stable() {
        let mac: MacAddr = "aa:bb:cc:dd:ee:ff".parse().unwrap();
        assert_eq!(Target::Mac(mac).to_string(), "mac:aa:bb:cc:dd:ee:ff");
    }
}
