//! Typed leaf values that stand in for the bare strings and integers that
//! would otherwise reach an adapter call. See [`crate::target`] for how they
//! compose into a [`crate::target::Target`].

use std::fmt;
use std::str::FromStr;

/// A validated IEEE 802 MAC address.
///
/// Parsed from the usual colon- or hyphen-separated hex forms
/// (`aa:bb:cc:dd:ee:ff`, `AA-BB-CC-DD-EE-FF`); nothing else is accepted, so a
/// malformed or attacker-supplied string can never silently become "close
/// enough" to a real address.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct MacAddr([u8; 6]);

impl MacAddr {
    pub fn new(octets: [u8; 6]) -> Self {
        Self(octets)
    }

    pub fn octets(&self) -> [u8; 6] {
        self.0
    }

    /// A MAC that is locally administered rather than burned into hardware
    /// by a manufacturer -- the bit pattern several household phones use
    /// when they randomise their address. Used to seed
    /// [`crate::asset::IdentityStability`] rather than trusted on its own.
    pub fn is_locally_administered(&self) -> bool {
        self.0[0] & 0b0000_0010 != 0
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid MAC address {input:?}: {reason}")]
pub struct MacAddrParseError {
    input: String,
    reason: &'static str,
}

impl FromStr for MacAddr {
    type Err = MacAddrParseError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let err = |reason: &'static str| MacAddrParseError {
            input: s.to_string(),
            reason,
        };

        let sep = if s.contains(':') {
            ':'
        } else if s.contains('-') {
            '-'
        } else {
            return Err(err("expected six colon- or hyphen-separated hex octets"));
        };

        let parts: Vec<&str> = s.split(sep).collect();
        if parts.len() != 6 {
            return Err(err("expected exactly six octets"));
        }

        let mut octets = [0u8; 6];
        for (i, part) in parts.iter().enumerate() {
            if part.len() != 2 {
                return Err(err("each octet must be exactly two hex digits"));
            }
            octets[i] = u8::from_str_radix(part, 16).map_err(|_| err("octet is not valid hex"))?;
        }
        Ok(Self(octets))
    }
}

impl fmt::Display for MacAddr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let [a, b, c, d, e, g] = self.0;
        write!(f, "{a:02x}:{b:02x}:{c:02x}:{d:02x}:{e:02x}:{g:02x}")
    }
}

/// An 802.1Q VLAN id. Valid range is 1..=4094; 0 and 4095 are reserved by
/// the standard and are rejected here rather than left for an adapter to
/// discover is nonsense.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct VlanId(u16);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("invalid VLAN id {0}: must be in 1..=4094")]
pub struct VlanIdError(u16);

impl VlanId {
    pub fn new(id: u16) -> Result<Self, VlanIdError> {
        if (1..=4094).contains(&id) {
            Ok(Self(id))
        } else {
            Err(VlanIdError(id))
        }
    }

    pub fn get(&self) -> u16 {
        self.0
    }
}

impl fmt::Display for VlanId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl TryFrom<u16> for VlanId {
    type Error = VlanIdError;
    fn try_from(value: u16) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

/// A physical switch port number (the SG2008P has eight; this type is kept
/// generic rather than hard-coding that count, since the permitted range is
/// a never-touch/config concern for `bsc-lan-policy`, not a domain fact).
///
/// This is deliberately **not** a TCP/UDP port -- those appear as a plain
/// validated `u16` on the firewall-rule types in [`crate::action`], since a
/// raw number carries none of the string-injection risk that motivates the
/// typed-value rule.
#[derive(
    Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct PortNumber(u8);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("invalid switch port number {0}: must be in 1..=255")]
pub struct PortNumberError(u8);

impl PortNumber {
    pub fn new(port: u8) -> Result<Self, PortNumberError> {
        if port >= 1 {
            Ok(Self(port))
        } else {
            Err(PortNumberError(port))
        }
    }

    pub fn get(&self) -> u8 {
        self.0
    }
}

impl fmt::Display for PortNumber {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl TryFrom<u8> for PortNumber {
    type Error = PortNumberError;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        Self::new(value)
    }
}

/// A validated DNS hostname (RFC 1035/1123 label rules): 1..=253 characters
/// total, each dot-separated label 1..=63 characters of ASCII alphanumerics
/// and hyphens, no leading or trailing hyphen on any label.
///
/// This is the type that stands between an attacker-controlled reverse-DNS
/// name or TLS SNI value and a command line -- constructing one requires
/// passing this validation, so a hostile string is rejected here rather than
/// trusted downstream.
#[derive(
    Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, serde::Serialize, serde::Deserialize,
)]
pub struct Hostname(String);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid hostname {input:?}: {reason}")]
pub struct HostnameError {
    input: String,
    reason: &'static str,
}

impl Hostname {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn valid_label(label: &str) -> bool {
    if label.is_empty() || label.len() > 63 {
        return false;
    }
    let bytes = label.as_bytes();
    let is_label_char = |b: u8| b.is_ascii_alphanumeric() || b == b'-';
    bytes.iter().all(|&b| is_label_char(b)) && bytes[0] != b'-' && bytes[bytes.len() - 1] != b'-'
}

impl FromStr for Hostname {
    type Err = HostnameError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let err = |reason: &'static str| HostnameError {
            input: s.to_string(),
            reason,
        };

        if s.is_empty() || s.len() > 253 {
            return Err(err("must be 1..=253 characters"));
        }
        let trimmed = s.strip_suffix('.').unwrap_or(s);
        if trimmed.is_empty() {
            return Err(err("must be 1..=253 characters"));
        }
        for label in trimmed.split('.') {
            if !valid_label(label) {
                return Err(err(
                    "each label must be 1..=63 alphanumeric/hyphen characters, not starting or ending with a hyphen",
                ));
            }
        }
        Ok(Self(s.to_string()))
    }
}

impl fmt::Display for Hostname {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// An L4 transport protocol. Kept separate from raw TCP/UDP port numbers so
/// a `None` port unambiguously means "any port for this protocol".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
pub enum L4Protocol {
    Tcp,
    Udp,
    Icmp,
}

impl fmt::Display for L4Protocol {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            L4Protocol::Tcp => "tcp",
            L4Protocol::Udp => "udp",
            L4Protocol::Icmp => "icmp",
        };
        write!(f, "{s}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mac_round_trips() {
        let mac: MacAddr = "aa:bb:cc:dd:ee:ff".parse().unwrap();
        assert_eq!(mac.to_string(), "aa:bb:cc:dd:ee:ff");
        let mac2: MacAddr = "AA-BB-CC-DD-EE-FF".parse().unwrap();
        assert_eq!(mac, mac2);
    }

    #[test]
    fn mac_rejects_garbage() {
        assert!("not-a-mac".parse::<MacAddr>().is_err());
        assert!("aa:bb:cc:dd:ee".parse::<MacAddr>().is_err());
        assert!("aa:bb:cc:dd:ee:zz".parse::<MacAddr>().is_err());
        assert!("aa:bb:cc:dd:ee:ff; id".parse::<MacAddr>().is_err());
    }

    #[test]
    fn locally_administered_bit() {
        let random: MacAddr = "02:00:00:00:00:01".parse().unwrap();
        assert!(random.is_locally_administered());
        let vendor: MacAddr = "b8:fb:b3:a3:3c:38".parse().unwrap();
        assert!(!vendor.is_locally_administered());
    }

    #[test]
    fn vlan_range() {
        assert!(VlanId::new(0).is_err());
        assert!(VlanId::new(1).is_ok());
        assert!(VlanId::new(4094).is_ok());
        assert!(VlanId::new(4095).is_err());
    }

    #[test]
    fn hostname_accepts_real_names() {
        assert!("lumpy-space.lan".parse::<Hostname>().is_ok());
        assert!("10.99.6.10".parse::<Hostname>().is_ok());
        assert!("a".parse::<Hostname>().is_ok());
        assert!("assistant.".parse::<Hostname>().is_ok());
    }

    #[test]
    fn hostname_rejects_shell_metacharacters() {
        assert!("evil.com; cat /etc/passwd".parse::<Hostname>().is_err());
        assert!("$(whoami).evil.com".parse::<Hostname>().is_err());
        assert!("evil.com\n".parse::<Hostname>().is_err());
        assert!("-leading-hyphen.com".parse::<Hostname>().is_err());
        assert!("trailing-hyphen-.com".parse::<Hostname>().is_err());
        assert!("".parse::<Hostname>().is_err());
        assert!("a".repeat(64).parse::<Hostname>().is_err());
    }

    #[test]
    fn hostname_rejects_backtick_injection() {
        let hostile = format!("{}id{}.evil.com", '`', '`');
        assert!(hostile.parse::<Hostname>().is_err());
    }
}
