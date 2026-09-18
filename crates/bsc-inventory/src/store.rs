//! `inventory.db` — the one place devices, sightings and segments are written.

use crate::{is_asset_scope, is_segment_broadcast, now_ms, parse_addr, parse_cidr, valid_id, AddrKind, Address, Device, Segment, Sighting};
use bsc_lan_sense::graph::{LanGraph, LanName, Scope};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const SCHEMA: &str = "
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS devices (
    id          TEXT PRIMARY KEY,
    name        TEXT,
    role        TEXT,
    owner       TEXT,
    vlan        INTEGER,
    expected    INTEGER,
    notes       TEXT,
    created_ms  INTEGER NOT NULL,
    updated_ms  INTEGER NOT NULL
);
-- An address belongs to at most ONE device at a time: the primary key is the address.
CREATE TABLE IF NOT EXISTS addresses (
    addr        TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    randomized  INTEGER NOT NULL,
    device_id   TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    claimed_ms  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sightings (
    addr           TEXT PRIMARY KEY,
    scope          TEXT NOT NULL,
    vlans          TEXT NOT NULL,
    serves         TEXT NOT NULL,
    names          TEXT NOT NULL,
    records        INTEGER NOT NULL,
    first_seen_ms  INTEGER,
    last_seen_ms   INTEGER,
    observed_ms    INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS segments (
    cidr  TEXT PRIMARY KEY,
    vlan  INTEGER NOT NULL,
    name  TEXT NOT NULL
);
";

/// What one `observe` changed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ObserveReport {
    /// Addresses seen for the first time ever.
    pub new: Vec<String>,
    /// Addresses already known, refreshed.
    pub refreshed: u64,
    /// Nodes skipped because they are not ours (public, multicast, broadcast, a declared segment's
    /// directed-broadcast address, …).
    pub not_assets: u64,
    /// Of the new addresses, those no device claims — the finding.
    pub new_unclaimed: Vec<String>,
    /// Carried from the graph, so an observe of an empty or partial read says so.
    pub records_examined: u64,
    pub graph_dropped: u64,
}

/// A device's fields to write. `None` leaves a field as it is; `Some(None)` clears it.
#[derive(Debug, Clone, Default)]
pub struct DevicePatch {
    pub name: Option<Option<String>>,
    pub role: Option<Option<String>>,
    pub owner: Option<Option<String>>,
    pub vlan: Option<Option<u16>>,
    pub expected: Option<Option<bool>>,
    pub notes: Option<Option<String>>,
}

pub struct Inventory {
    conn: Connection,
}

impl Inventory {
    /// `$BSC_INVENTORY_DB`, else `~/.base-studio-code/inventory.db`.
    pub fn default_path() -> Option<PathBuf> {
        bsc_sqlite_util::default_store_path("BSC_INVENTORY_DB", &["inventory.db"])
    }

    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = bsc_sqlite_util::open_migrated(path, |c| c.execute_batch(SCHEMA))
            .map_err(|e| format!("open inventory {}: {e}", path.display()))?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = bsc_sqlite_util::open_in_memory_migrated(|c| c.execute_batch(SCHEMA))
            .map_err(|e| format!("open inventory: {e}"))?;
        Ok(Self { conn })
    }

    /// Create or update a device. Merges: an unset field keeps its value.
    pub fn set_device(&self, id: &str, patch: &DevicePatch) -> Result<Device, String> {
        if !valid_id(id) {
            return Err(format!("`{id}` is not a device id — use a slug: a-z, 0-9 and '-', 1-60 chars"));
        }
        let now = now_ms();
        let existing = self.device(id)?;
        let pick = |new: &Option<Option<String>>, old: Option<String>| match new {
            Some(v) => v.clone(),
            None => old,
        };
        let (name, role, owner, notes, vlan, expected, created) = match existing {
            Some(d) => (
                pick(&patch.name, d.name),
                pick(&patch.role, d.role),
                pick(&patch.owner, d.owner),
                pick(&patch.notes, d.notes),
                patch.vlan.unwrap_or(d.vlan),
                patch.expected.unwrap_or(d.expected),
                d.created_ms,
            ),
            None => (
                pick(&patch.name, None),
                pick(&patch.role, None),
                pick(&patch.owner, None),
                pick(&patch.notes, None),
                patch.vlan.unwrap_or(None),
                patch.expected.unwrap_or(None),
                now,
            ),
        };
        self.conn
            .execute(
                "INSERT INTO devices (id, name, role, owner, vlan, expected, notes, created_ms, updated_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET name = ?2, role = ?3, owner = ?4, vlan = ?5,
                   expected = ?6, notes = ?7, updated_ms = ?9",
                params![id, name, role, owner, vlan, expected, notes, created, now],
            )
            .map_err(|e| format!("write device {id}: {e}"))?;
        self.device(id)?.ok_or_else(|| format!("device {id} vanished after writing it"))
    }

    /// Claim an address for a device. REFUSES an address another device already holds, naming it —
    /// moving an address silently would rewrite what a sighting means with nobody deciding to.
    pub fn claim(&self, id: &str, raw_addr: &str) -> Result<Address, String> {
        let (addr, kind, randomized) = parse_addr(raw_addr)?;
        if self.device(id)?.is_none() {
            return Err(format!("no device `{id}` — create it first with `bsc inventory set {id}`"));
        }
        if let Some(owner) = self.owner_of(&addr)? {
            if owner == id {
                return self
                    .device(id)?
                    .and_then(|d| d.addresses.into_iter().find(|a| a.addr == addr))
                    .ok_or_else(|| format!("{addr} vanished from {id}"));
            }
            return Err(format!("{addr} is already claimed by `{owner}` — release it there first"));
        }
        let now = now_ms();
        let kind_s = match kind {
            AddrKind::Ip => "ip",
            AddrKind::Mac => "mac",
        };
        self.conn
            .execute(
                "INSERT INTO addresses (addr, kind, randomized, device_id, claimed_ms) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![addr, kind_s, randomized, id, now],
            )
            .map_err(|e| format!("claim {addr}: {e}"))?;
        Ok(Address { addr, kind, randomized, claimed_ms: now })
    }

    /// Release an address from whichever device holds it. Returns that device, or `None`.
    pub fn release(&self, raw_addr: &str) -> Result<Option<String>, String> {
        let (addr, _, _) = parse_addr(raw_addr)?;
        let owner = self.owner_of(&addr)?;
        self.conn
            .execute("DELETE FROM addresses WHERE addr = ?1", params![addr])
            .map_err(|e| format!("release {addr}: {e}"))?;
        Ok(owner)
    }

    /// Delete a device and its claims. Sightings stay: what the wire showed is not undone by
    /// forgetting what we called it.
    pub fn forget(&self, id: &str) -> Result<bool, String> {
        let n = self
            .conn
            .execute("DELETE FROM devices WHERE id = ?1", params![id])
            .map_err(|e| format!("forget {id}: {e}"))?;
        Ok(n > 0)
    }

    fn owner_of(&self, addr: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT device_id FROM addresses WHERE addr = ?1", params![addr], |r| r.get(0))
            .optional()
            .map_err(|e| format!("read {addr}: {e}"))
    }

    pub fn device(&self, id: &str) -> Result<Option<Device>, String> {
        let row = self
            .conn
            .query_row(
                "SELECT id, name, role, owner, vlan, expected, notes, created_ms, updated_ms FROM devices WHERE id = ?1",
                params![id],
                |r| {
                    Ok(Device {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        role: r.get(2)?,
                        owner: r.get(3)?,
                        vlan: r.get(4)?,
                        expected: r.get(5)?,
                        notes: r.get(6)?,
                        created_ms: r.get(7)?,
                        updated_ms: r.get(8)?,
                        addresses: Vec::new(),
                    })
                },
            )
            .optional()
            .map_err(|e| format!("read device {id}: {e}"))?;
        let Some(mut d) = row else { return Ok(None) };
        d.addresses = self.addresses_of(id)?;
        Ok(Some(d))
    }

    /// A device by id, or the device claiming an address.
    pub fn resolve(&self, key: &str) -> Result<Option<Device>, String> {
        if let Some(d) = self.device(key)? {
            return Ok(Some(d));
        }
        let Ok((addr, _, _)) = parse_addr(key) else { return Ok(None) };
        match self.owner_of(&addr)? {
            Some(id) => self.device(&id),
            None => Ok(None),
        }
    }

    fn addresses_of(&self, id: &str) -> Result<Vec<Address>, String> {
        let mut st = self
            .conn
            .prepare("SELECT addr, kind, randomized, claimed_ms FROM addresses WHERE device_id = ?1 ORDER BY kind, addr")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map(params![id], |r| {
                let kind: String = r.get(1)?;
                Ok(Address {
                    addr: r.get(0)?,
                    kind: if kind == "mac" { AddrKind::Mac } else { AddrKind::Ip },
                    randomized: r.get(2)?,
                    claimed_ms: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn devices(&self) -> Result<Vec<Device>, String> {
        let ids: Vec<String> = {
            let mut st = self.conn.prepare("SELECT id FROM devices ORDER BY id").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| r.get(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        ids.iter().filter_map(|id| self.device(id).transpose()).collect()
    }

    /// Fold a `bsc lan graph` into the sightings. Only private and link-local nodes are kept.
    pub fn observe(&self, g: &LanGraph) -> Result<ObserveReport, String> {
        let now = now_ms();
        let mut report = ObserveReport {
            records_examined: g.records_examined,
            graph_dropped: g.dropped,
            ..Default::default()
        };
        let segments = self.segments()?;
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for n in &g.nodes {
            if !is_asset_scope(n.scope) || is_segment_broadcast(&n.addr, &segments) {
                report.not_assets += 1;
                continue;
            }
            match self.sighting(&n.addr)? {
                Some(old) => {
                    let vlans: BTreeSet<u16> = old.vlans.union(&n.vlans).copied().collect();
                    let serves: BTreeSet<u16> = old.serves.union(&n.serves).copied().collect();
                    let first = min_opt(old.first_seen_ms, n.first_seen_ms);
                    let last = max_opt(old.last_seen_ms, n.last_seen_ms);
                    // Names: the latest observation's, unless it carried none — an observation
                    // that happened to see no DNS must not erase a name an earlier one learned.
                    let names = if n.names.is_empty() { old.names } else { n.names.clone() };
                    self.write_sighting(&n.addr, n.scope, &vlans, &serves, &names, n.records, first, last, now)?;
                    report.refreshed += 1;
                }
                None => {
                    self.write_sighting(
                        &n.addr,
                        n.scope,
                        &n.vlans,
                        &n.serves,
                        &n.names,
                        n.records,
                        n.first_seen_ms,
                        n.last_seen_ms,
                        now,
                    )?;
                    if self.owner_of(&n.addr)?.is_none() {
                        report.new_unclaimed.push(n.addr.clone());
                    }
                    report.new.push(n.addr.clone());
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(report)
    }

    #[allow(clippy::too_many_arguments)]
    fn write_sighting(
        &self,
        addr: &str,
        scope: Scope,
        vlans: &BTreeSet<u16>,
        serves: &BTreeSet<u16>,
        names: &[LanName],
        records: u64,
        first: Option<i64>,
        last: Option<i64>,
        now: i64,
    ) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO sightings (addr, scope, vlans, serves, names, records, first_seen_ms, last_seen_ms, observed_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(addr) DO UPDATE SET scope = ?2, vlans = ?3, serves = ?4, names = ?5, records = ?6,
                   first_seen_ms = ?7, last_seen_ms = ?8, observed_ms = ?9",
                params![addr, json(&scope), json(vlans), json(serves), json(names), records as i64, first, last, now],
            )
            .map_err(|e| format!("write sighting {addr}: {e}"))?;
        Ok(())
    }

    pub fn sighting(&self, addr: &str) -> Result<Option<Sighting>, String> {
        Ok(self.sightings_where("WHERE s.addr = ?1", params![addr])?.into_iter().next())
    }

    /// Every sighting, most recently seen first. `unclaimed` keeps only the ones no device claims.
    pub fn sightings(&self, unclaimed: bool) -> Result<Vec<Sighting>, String> {
        let filter = if unclaimed { "WHERE a.device_id IS NULL" } else { "" };
        self.sightings_where(filter, params![])
    }

    fn sightings_where(&self, filter: &str, p: &[&dyn rusqlite::ToSql]) -> Result<Vec<Sighting>, String> {
        let sql = format!(
            "SELECT s.addr, s.scope, s.vlans, s.serves, s.names, s.records, s.first_seen_ms, s.last_seen_ms,
                    s.observed_ms, a.device_id
             FROM sightings s LEFT JOIN addresses a ON a.addr = s.addr {filter}
             ORDER BY s.last_seen_ms DESC NULLS LAST, s.addr"
        );
        let mut st = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = st
            .query_map(p, |r| {
                let text = |i: usize| r.get::<_, String>(i);
                Ok((
                    r.get::<_, String>(0)?,
                    text(1)?,
                    text(2)?,
                    text(3)?,
                    text(4)?,
                    r.get::<_, i64>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<i64>>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (addr, scope, vlans, serves, names, records, first, last, observed, device) = row.map_err(|e| e.to_string())?;
            let bad = |what: &str, e: serde_json::Error| format!("sighting {addr}: unreadable {what}: {e}");
            out.push(Sighting {
                scope: serde_json::from_str(&scope).map_err(|e| bad("scope", e))?,
                vlans: serde_json::from_str(&vlans).map_err(|e| bad("vlans", e))?,
                serves: serde_json::from_str(&serves).map_err(|e| bad("serves", e))?,
                names: serde_json::from_str(&names).map_err(|e| bad("names", e))?,
                records: records.max(0) as u64,
                first_seen_ms: first,
                last_seen_ms: last,
                observed_ms: observed,
                device,
                addr,
            });
        }
        Ok(out)
    }

    pub fn set_segment(&self, cidr: &str, vlan: u16, name: &str) -> Result<Segment, String> {
        let (net, len) = parse_cidr(cidr)?;
        if !(1..=4094).contains(&vlan) {
            return Err(format!("VLAN {vlan} is outside 1-4094"));
        }
        let name = name.trim();
        if name.is_empty() {
            return Err("a segment needs a --name".into());
        }
        let cidr = format!("{net}/{len}");
        self.conn
            .execute(
                "INSERT INTO segments (cidr, vlan, name) VALUES (?1, ?2, ?3)
                 ON CONFLICT(cidr) DO UPDATE SET vlan = ?2, name = ?3",
                params![cidr, vlan, name],
            )
            .map_err(|e| format!("write segment {cidr}: {e}"))?;
        Ok(Segment { cidr, vlan, name: name.to_string() })
    }

    pub fn remove_segment(&self, cidr: &str) -> Result<bool, String> {
        let (net, len) = parse_cidr(cidr)?;
        let n = self
            .conn
            .execute("DELETE FROM segments WHERE cidr = ?1", params![format!("{net}/{len}")])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn segments(&self) -> Result<Vec<Segment>, String> {
        let mut st = self.conn.prepare("SELECT cidr, vlan, name FROM segments ORDER BY vlan, cidr").map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| Ok(Segment { cidr: r.get(0)?, vlan: r.get(1)?, name: r.get(2)? }))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }
}

fn min_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

fn max_opt(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.max(y)),
        (x, y) => x.or(y),
    }
}

/// A column value as its JSON text. Every type written here serialises infallibly.
fn json<T: Serialize + ?Sized>(v: &T) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bsc_lan_sense::graph::fold;

    const PI_SSH: &str = r#"{"event_type":"flow","vlan":[5],"src_ip":"10.99.2.118","src_port":1,"dest_ip":"10.99.2.100","dest_port":22,"proto":"TCP","app_proto":"ssh","flow":{"pkts_toclient":9,"start":"2026-09-18T10:00:00.000000-0400","end":"2026-09-18T10:00:05.000000-0400"}}"#;
    const WEB: &str = r#"{"event_type":"flow","src_ip":"10.99.3.20","src_port":2,"dest_ip":"203.0.113.7","dest_port":443,"proto":"TCP","flow":{"pkts_toclient":9}}"#;

    fn inv() -> Inventory {
        Inventory::open_in_memory().unwrap()
    }

    #[test]
    fn a_device_round_trips_and_a_patch_merges() {
        let i = inv();
        let d = i
            .set_device("assistant-pi", &DevicePatch { name: Some(Some("Assistant Pi".into())), vlan: Some(Some(2)), ..Default::default() })
            .unwrap();
        assert_eq!((d.name.as_deref(), d.vlan), (Some("Assistant Pi"), Some(2)));
        let d = i.set_device("assistant-pi", &DevicePatch { role: Some(Some("dns".into())), ..Default::default() }).unwrap();
        assert_eq!(d.name.as_deref(), Some("Assistant Pi"), "an unset field keeps its value");
        assert_eq!(d.role.as_deref(), Some("dns"));
        let d = i.set_device("assistant-pi", &DevicePatch { name: Some(None), ..Default::default() }).unwrap();
        assert_eq!(d.name, None, "Some(None) clears");
        assert!(i.set_device("Not A Slug", &DevicePatch::default()).is_err());
    }

    #[test]
    fn an_address_belongs_to_one_device_and_a_second_claim_is_refused_by_name() {
        let i = inv();
        i.set_device("pi", &DevicePatch::default()).unwrap();
        i.set_device("kali", &DevicePatch::default()).unwrap();
        i.claim("pi", "10.99.2.100").unwrap();
        i.claim("pi", "10.99.2.100").expect("re-claiming your own address is a no-op");
        let e = i.claim("kali", "10.99.2.100").unwrap_err();
        assert!(e.contains("`pi`"), "the refusal must name the holder: {e}");
        assert_eq!(i.resolve("10.99.2.100").unwrap().unwrap().id, "pi");
        assert_eq!(i.release("10.99.2.100").unwrap().as_deref(), Some("pi"));
        i.claim("kali", "10.99.2.100").expect("released, so claimable");
        assert!(i.claim("ghost", "10.0.0.1").unwrap_err().contains("no device"));
    }

    #[test]
    fn a_randomized_mac_says_so() {
        let i = inv();
        i.set_device("phone", &DevicePatch::default()).unwrap();
        let a = i.claim("phone", "DA:11:22:33:44:55").unwrap();
        assert_eq!((a.addr.as_str(), a.kind, a.randomized), ("da:11:22:33:44:55", AddrKind::Mac, true));
    }

    #[test]
    fn observing_keeps_our_addresses_and_reports_the_unclaimed_ones() {
        let i = inv();
        i.set_device("pi", &DevicePatch::default()).unwrap();
        i.claim("pi", "10.99.2.100").unwrap();
        let r = i.observe(&fold(&[PI_SSH, WEB].join("\n"))).unwrap();
        assert_eq!(r.not_assets, 1, "the public destination is not an asset");
        assert_eq!(r.new.len(), 3);
        assert_eq!(r.new_unclaimed, vec!["10.99.2.118".to_string(), "10.99.3.20".to_string()]);
        let unclaimed: Vec<String> = i.sightings(true).unwrap().into_iter().map(|s| s.addr).collect();
        assert!(!unclaimed.contains(&"10.99.2.100".to_string()));
        let pi = i.sighting("10.99.2.100").unwrap().unwrap();
        assert_eq!(pi.device.as_deref(), Some("pi"));
        assert_eq!(pi.serves.iter().copied().collect::<Vec<_>>(), vec![22]);
        assert_eq!(pi.last_seen_ms.unwrap() - pi.first_seen_ms.unwrap(), 5_000, "wire time, not ingest time");
    }

    #[test]
    fn a_second_observation_widens_rather_than_forgets() {
        let i = inv();
        i.observe(&fold(PI_SSH)).unwrap();
        let later = PI_SSH.replace("\"dest_port\":22", "\"dest_port\":53").replace("10:00:05", "11:00:00");
        let r = i.observe(&fold(&later)).unwrap();
        assert_eq!((r.new.len(), r.refreshed), (0, 2));
        let pi = i.sighting("10.99.2.100").unwrap().unwrap();
        assert_eq!(pi.serves.iter().copied().collect::<Vec<_>>(), vec![22, 53], "services accumulate");
        assert_eq!(pi.last_seen_ms.unwrap() - pi.first_seen_ms.unwrap(), 3_600_000);
    }

    #[test]
    fn forgetting_a_device_keeps_what_the_wire_showed() {
        let i = inv();
        i.set_device("pi", &DevicePatch::default()).unwrap();
        i.claim("pi", "10.99.2.100").unwrap();
        i.observe(&fold(PI_SSH)).unwrap();
        assert!(i.forget("pi").unwrap());
        let s = i.sighting("10.99.2.100").unwrap().expect("the sighting survives");
        assert_eq!(s.device, None, "and is unclaimed again — the claim cascaded away");
    }

    #[test]
    fn a_segment_normalises_and_validates() {
        let i = inv();
        let s = i.set_segment("10.99.2.1/24", 2, "MGMT").unwrap();
        assert_eq!(s.cidr, "10.99.2.0/24");
        assert!(i.set_segment("10.99.8.0/24", 0, "GUEST").is_err());
        assert!(i.set_segment("10.99.8.0/24", 8, " ").is_err());
        assert_eq!(i.segments().unwrap().len(), 1);
        assert!(i.remove_segment("10.99.2.0/24").unwrap());
    }

    #[test]
    fn a_declared_segments_broadcast_is_not_an_asset() {
        let i = inv();
        i.set_segment("10.99.6.0/24", 6, "LAB").unwrap();
        let bcast = r#"{"event_type":"flow","src_ip":"10.99.6.10","src_port":137,"dest_ip":"10.99.6.255","dest_port":137,"proto":"UDP","flow":{}}"#;
        let r = i.observe(&fold(bcast)).unwrap();
        assert_eq!(r.new, vec!["10.99.6.10".to_string()]);
        assert_eq!(r.not_assets, 1);
    }

    #[test]
    fn an_observation_that_read_nothing_says_so() {
        let r = inv().observe(&fold("not json")).unwrap();
        assert_eq!(r.records_examined, 0);
        assert!(r.new.is_empty());
    }
}
