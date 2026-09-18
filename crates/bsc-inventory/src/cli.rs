//! `bsc inventory` — the verbs.

use crate::store::DevicePatch;
use crate::{segment_of, Device, Inventory, Segment, Sighting};
use bsc_cli_util::{args, CmdDoc};
use serde::Serialize;
use std::path::PathBuf;

pub const TAGLINE: &str =
    "the LAN asset inventory — every device, what it is, and when the wire last showed it";

pub const COMMANDS: &[CmdDoc] = &[
    CmdDoc {
        name: "list",
        summary: "every device, the segments, and the addresses the wire showed that no device claims",
        usage: "\
bsc inventory list [--unclaimed] [--db PATH] [--json|--pretty]

Devices first, each with its addresses, its VLAN (declared, else its address's segment) and when the
wire last showed it. Then the UNCLAIMED sightings — private addresses the sensor saw that no device
claims. That list is the finding: an unauthorised device, a forgotten test box, or a device nobody has
named yet. --unclaimed prints only it.

Read-only. A missing store reads as empty and is not created.",
    },
    CmdDoc {
        name: "get",
        summary: "one device by id or by any address it claims, with what the wire showed at each address",
        usage: "\
bsc inventory get <device-id | ip | mac> [--db PATH] [--json|--pretty]

An address no device claims returns its sighting alone, marked unclaimed.",
    },
    CmdDoc {
        name: "set",
        summary: "create or update a device, and claim addresses for it",
        usage: "\
bsc inventory set <device-id> [--name N] [--role R] [--owner O] [--vlan N] [--expected yes|no]
                              [--notes T] [--addr ip-or-mac[,…]] [--db PATH] [--json|--pretty]

A MERGE: a flag you leave out keeps its current value; pass an empty value (--name \"\") to clear one.
The id is a slug (a-z, 0-9, '-'): addresses change, the id does not.

--addr CLAIMS each address for this device. An address another device holds is REFUSED, naming that
device — release it there first. Moving an address silently would change what every past sighting of
it means without anyone deciding to. A MAC with the locally-administered bit set is recorded as
RANDOMIZED, the privacy-MAC pattern phones rotate through, so nobody reads continuity into it.",
    },
    CmdDoc {
        name: "release",
        summary: "release an address from whichever device claims it",
        usage: "\
bsc inventory release <ip-or-mac> [--db PATH] [--json|--pretty]",
    },
    CmdDoc {
        name: "forget",
        summary: "delete a device and its claims — what the wire showed stays",
        usage: "\
bsc inventory forget <device-id> [--db PATH] [--json|--pretty]

The device and its address claims go. Its sightings stay, and read as unclaimed again: forgetting what
we called a device does not undo what the wire showed.",
    },
    CmdDoc {
        name: "observe",
        summary: "record what a `bsc lan graph` saw — the sensor's half of the inventory",
        usage: "\
bsc inventory observe --graph <file|-> [--db PATH] [--json|--pretty]

Reads the JSON `bsc lan graph --json` prints and records a SIGHTING for every private and link-local
address in it: its VLAN tags and served ports (accumulated across observations), its names, and its
first/last WIRE time. Public destinations are not assets and are skipped, counted.

  bsc lan graph --eve /var/log/suricata/eve.json --json | bsc inventory observe --graph -

Prints what was NEW and which new addresses no device claims. An observation that examined zero
records says so rather than reporting a quiet network.",
    },
    CmdDoc {
        name: "segment",
        summary: "which subnet is which VLAN: list · set <cidr> --vlan N --name X · remove <cidr>",
        usage: "\
bsc inventory segment [list] [--db PATH] [--json|--pretty]
bsc inventory segment set <a.b.c.d/n> --vlan <1-4094> --name <label> [--db PATH]
bsc inventory segment remove <a.b.c.d/n> [--db PATH]

DECLARED, NOT OBSERVED. The management VLAN here is the switch trunk's untagged native VLAN, so its
frames carry no 802.1Q tag and a host's VLAN cannot be read off the wire for exactly the segment where
it matters most. A device's VLAN is its declared --vlan, else the most specific segment its IP falls in.",
    },
];

#[derive(Default)]
struct Args {
    json: bool,
    pretty: bool,
    db: Option<String>,
    graph: Option<String>,
    name: Option<String>,
    role: Option<String>,
    owner: Option<String>,
    vlan: Option<String>,
    expected: Option<String>,
    notes: Option<String>,
    addr: Option<String>,
    unclaimed: bool,
    positional: Vec<String>,
}

fn parse_args(raw: Vec<String>) -> Result<Args, String> {
    let (mut a, positional) = args::walk(raw, Args::default(), |flag, a: &mut Args, rest| {
        match flag {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            "--unclaimed" => a.unclaimed = true,
            "--db" => a.db = Some(rest.value("--db needs a path to an inventory.db")?),
            "--graph" => a.graph = Some(rest.value("--graph needs a file of `bsc lan graph --json`, or - for stdin")?),
            "--name" => a.name = Some(rest.value("--name needs a value (\"\" clears it)")?),
            "--role" => a.role = Some(rest.value("--role needs a value (\"\" clears it)")?),
            "--owner" => a.owner = Some(rest.value("--owner needs a value (\"\" clears it)")?),
            "--vlan" => a.vlan = Some(rest.value("--vlan needs a VLAN id 1-4094 (\"\" clears it)")?),
            "--expected" => a.expected = Some(rest.value("--expected needs yes or no (\"\" clears it)")?),
            "--notes" => a.notes = Some(rest.value("--notes needs text (\"\" clears it)")?),
            "--addr" => a.addr = Some(rest.value("--addr needs an IP or MAC, comma-separated for several")?),
            _ => return Ok(false),
        }
        Ok(true)
    })?;
    a.positional = positional;
    Ok(a)
}

fn db_path(a: &Args) -> Result<PathBuf, String> {
    match &a.db {
        Some(p) => Ok(PathBuf::from(p)),
        None => Inventory::default_path().ok_or_else(|| "no home directory — pass --db PATH".to_string()),
    }
}

/// Open for READING: a missing store is an empty inventory, never created by a read.
fn open_read(a: &Args) -> Result<Option<Inventory>, String> {
    let p = db_path(a)?;
    if !p.exists() {
        return Ok(None);
    }
    Inventory::open(&p).map(Some)
}

fn open_write(a: &Args) -> Result<Inventory, String> {
    Inventory::open(&db_path(a)?)
}

pub fn run(argv: Vec<String>, prog: &str) -> Result<(), String> {
    let a = parse_args(argv)?;
    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &a.positional) {
        return Ok(());
    }
    match a.positional.first().map(String::as_str) {
        Some("list") => cmd_list(&a),
        Some("get") => cmd_get(&a),
        Some("set") => cmd_set(&a),
        Some("release") => cmd_release(&a),
        Some("forget") => cmd_forget(&a),
        Some("observe") => cmd_observe(&a),
        Some("segment") => cmd_segment(&a),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other.unwrap_or(""))),
    }
}

/// Everything the LAN screen needs from the inventory, in one read.
#[derive(Serialize, Default)]
pub struct Listing {
    pub devices: Vec<DeviceView>,
    pub unclaimed: Vec<Sighting>,
    pub segments: Vec<Segment>,
}

/// A device with its effective VLAN and what the wire showed at each of its addresses.
#[derive(Serialize)]
pub struct DeviceView {
    #[serde(flatten)]
    pub device: Device,
    /// Declared `vlan`, else the segment of its first IP. `None`: nobody knows.
    pub effective_vlan: Option<u16>,
    pub sightings: Vec<Sighting>,
    /// Latest wire time across its addresses.
    pub last_seen_ms: Option<i64>,
}

pub fn listing(inv: &Inventory) -> Result<Listing, String> {
    let segments = inv.segments()?;
    let all = inv.sightings(false)?;
    let devices = inv
        .devices()?
        .into_iter()
        .map(|d| view(d, &all, &segments))
        .collect();
    let unclaimed = all.into_iter().filter(|s| s.device.is_none()).collect();
    Ok(Listing { devices, unclaimed, segments })
}

fn view(device: Device, all: &[Sighting], segments: &[Segment]) -> DeviceView {
    let sightings: Vec<Sighting> =
        all.iter().filter(|s| s.device.as_deref() == Some(device.id.as_str())).cloned().collect();
    let effective_vlan = device.vlan.or_else(|| {
        device
            .addresses
            .iter()
            .find_map(|a| segment_of(&a.addr, segments))
            .map(|s| s.vlan)
    });
    let last_seen_ms = sightings.iter().filter_map(|s| s.last_seen_ms).max();
    DeviceView { device, effective_vlan, sightings, last_seen_ms }
}

fn cmd_list(a: &Args) -> Result<(), String> {
    let l = match open_read(a)? {
        Some(inv) => listing(&inv)?,
        None => Listing::default(),
    };
    if a.unclaimed {
        let u = &l.unclaimed;
        bsc_cli_util::emit(a.pretty, a.json, u, || render_unclaimed(u, &l.segments));
    } else {
        bsc_cli_util::emit(a.pretty, a.json, &l, || render_listing(&l));
    }
    Ok(())
}

fn vlan_label(v: Option<u16>, segments: &[Segment]) -> String {
    match v {
        Some(v) => match segments.iter().find(|s| s.vlan == v) {
            Some(s) => format!("{v} {}", s.name),
            None => v.to_string(),
        },
        None => "-".into(),
    }
}

fn ago(ms: Option<i64>) -> String {
    let Some(ms) = ms else { return "never seen".into() };
    let s = (crate::now_ms() - ms).max(0) / 1000;
    match s {
        0..=59 => format!("{s}s ago"),
        60..=3599 => format!("{}m ago", s / 60),
        3600..=86_399 => format!("{}h ago", s / 3600),
        _ => format!("{}d ago", s / 86_400),
    }
}

pub fn render_listing(l: &Listing) -> String {
    let mut s = format!("{} device(s) · {} unclaimed address(es) · {} segment(s)\n", l.devices.len(), l.unclaimed.len(), l.segments.len());
    if !l.devices.is_empty() {
        s.push_str("\n  DEVICES\n");
    }
    for d in &l.devices {
        let addrs: Vec<String> = d
            .device
            .addresses
            .iter()
            .map(|a| if a.randomized { format!("{} (randomized)", a.addr) } else { a.addr.clone() })
            .collect();
        s.push_str(&format!(
            "    {:<22} vlan {:<12} {:<14} {}  {}\n",
            d.device.id,
            vlan_label(d.effective_vlan, &l.segments),
            ago(d.last_seen_ms),
            addrs.join(", "),
            d.device.name.as_deref().unwrap_or("")
        ));
    }
    if !l.unclaimed.is_empty() {
        s.push('\n');
        s.push_str(&render_unclaimed(&l.unclaimed, &l.segments));
    }
    if l.segments.is_empty() {
        s.push_str("\n  no segments declared — `bsc inventory segment set <cidr> --vlan N --name X`\n");
    }
    s
}

pub fn render_unclaimed(u: &[Sighting], segments: &[Segment]) -> String {
    if u.is_empty() {
        return "  no unclaimed addresses\n".into();
    }
    let mut s = format!("  UNCLAIMED — {} address(es) the wire showed that no device claims:\n", u.len());
    for x in u {
        let vlan = segment_of(&x.addr, segments).map(|g| format!("{} {}", g.vlan, g.name)).unwrap_or_else(|| "-".into());
        let name = x.names.first().map(|n| n.name.as_str()).unwrap_or("");
        let serves = x.serves.iter().map(|p| p.to_string()).collect::<Vec<_>>().join(",");
        s.push_str(&format!("    {:<18} vlan {:<12} {:<14} serves [{}]  {}\n", x.addr, vlan, ago(x.last_seen_ms), serves, name));
    }
    s
}

fn cmd_get(a: &Args) -> Result<(), String> {
    let key = a.positional.get(1).ok_or("get needs a device id, an IP or a MAC")?;
    let inv = open_read(a)?.ok_or_else(|| format!("no inventory yet — nothing is known about `{key}`"))?;
    let segments = inv.segments()?;
    if let Some(d) = inv.resolve(key)? {
        let v = view(d, &inv.sightings(false)?, &segments);
        bsc_cli_util::emit(a.pretty, a.json, &v, || {
            let mut s = String::new();
            s.push_str(&format!("{}  vlan {}  last seen {}\n", v.device.id, vlan_label(v.effective_vlan, &segments), ago(v.last_seen_ms)));
            for (k, val) in [("name", &v.device.name), ("role", &v.device.role), ("owner", &v.device.owner), ("notes", &v.device.notes)] {
                if let Some(val) = val {
                    s.push_str(&format!("  {k:<6} {val}\n"));
                }
            }
            if let Some(e) = v.device.expected {
                s.push_str(&format!("  expected {}\n", if e { "yes" } else { "NO" }));
            }
            for addr in &v.device.addresses {
                let seen = v.sightings.iter().find(|x| x.addr == addr.addr);
                s.push_str(&format!(
                    "  {} {}{}  {}\n",
                    if addr.kind == crate::AddrKind::Mac { "mac" } else { "ip " },
                    addr.addr,
                    if addr.randomized { " (randomized)" } else { "" },
                    seen.map(|x| format!("seen {} · serves {:?}", ago(x.last_seen_ms), x.serves)).unwrap_or_else(|| "never seen on the wire".into())
                ));
            }
            s
        });
        return Ok(());
    }
    let (addr, _, _) = crate::parse_addr(key).map_err(|_| format!("no device `{key}`"))?;
    let seen = inv.sighting(&addr)?.ok_or_else(|| format!("nothing is known about {addr}"))?;
    bsc_cli_util::emit(a.pretty, a.json, &seen, || render_unclaimed(std::slice::from_ref(&seen), &segments));
    Ok(())
}

/// A flag's value as a patch: absent keeps, "" clears, anything else sets.
fn patch_text(v: &Option<String>) -> Option<Option<String>> {
    v.as_ref().map(|s| {
        let t = s.trim();
        (!t.is_empty()).then(|| t.to_string())
    })
}

fn cmd_set(a: &Args) -> Result<(), String> {
    let id = a.positional.get(1).ok_or("set needs a device id")?;
    let vlan = match a.vlan.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some(v) => Some(Some(
            v.parse::<u16>().ok().filter(|v| (1..=4094).contains(v)).ok_or_else(|| format!("--vlan `{v}` is not 1-4094"))?,
        )),
    };
    let expected = match a.expected.as_deref().map(str::trim) {
        None => None,
        Some("") => Some(None),
        Some("yes" | "true") => Some(Some(true)),
        Some("no" | "false") => Some(Some(false)),
        Some(v) => return Err(format!("--expected `{v}` must be yes or no")),
    };
    let patch = DevicePatch {
        name: patch_text(&a.name),
        role: patch_text(&a.role),
        owner: patch_text(&a.owner),
        notes: patch_text(&a.notes),
        vlan,
        expected,
    };
    let inv = open_write(a)?;
    inv.set_device(id, &patch)?;
    for addr in a.addr.as_deref().unwrap_or("").split(',').map(str::trim).filter(|s| !s.is_empty()) {
        inv.claim(id, addr)?;
    }
    let d = inv.device(id)?.ok_or_else(|| format!("device {id} vanished"))?;
    bsc_cli_util::emit(a.pretty, a.json, &d, || {
        let addrs: Vec<&str> = d.addresses.iter().map(|x| x.addr.as_str()).collect();
        format!("set {} — {} address(es): {}", d.id, addrs.len(), addrs.join(", "))
    });
    Ok(())
}

fn cmd_release(a: &Args) -> Result<(), String> {
    let addr = a.positional.get(1).ok_or("release needs an IP or MAC")?;
    let from = open_write(a)?.release(addr)?;
    let out = serde_json::json!({ "addr": addr, "releasedFrom": from });
    bsc_cli_util::emit(a.pretty, a.json, &out, || match &from {
        Some(d) => format!("released {addr} from {d}"),
        None => format!("{addr} was not claimed — nothing to release"),
    });
    Ok(())
}

fn cmd_forget(a: &Args) -> Result<(), String> {
    let id = a.positional.get(1).ok_or("forget needs a device id")?;
    if !open_write(a)?.forget(id)? {
        return Err(format!("no device `{id}`"));
    }
    let out = serde_json::json!({ "forgot": id });
    bsc_cli_util::emit(a.pretty, a.json, &out, || format!("forgot {id} — its sightings stay, now unclaimed"));
    Ok(())
}

fn cmd_observe(a: &Args) -> Result<(), String> {
    use std::io::Read;
    let src = a.graph.as_deref().ok_or("observe needs --graph <file>, or --graph - for stdin")?;
    let text = if src == "-" {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).map_err(|e| format!("reading stdin: {e}"))?;
        s
    } else {
        std::fs::read_to_string(src).map_err(|e| format!("could not read {src}: {e}"))?
    };
    let g: bsc_lan_sense::graph::LanGraph =
        serde_json::from_str(&text).map_err(|e| format!("{src} is not `bsc lan graph --json` output: {e}"))?;
    let r = open_write(a)?.observe(&g)?;
    bsc_cli_util::emit(a.pretty, a.json, &r, || {
        if r.records_examined == 0 {
            return "NOTHING PARSED — the graph examined 0 records, so this observed nothing. Not a quiet network.".into();
        }
        let mut s = format!(
            "observed {} record(s): {} new address(es), {} refreshed, {} not ours (public/multicast/…)\n",
            r.records_examined,
            r.new.len(),
            r.refreshed,
            r.not_assets
        );
        if r.graph_dropped > 0 {
            s.push_str(&format!("  PARTIAL — the graph dropped {} item(s) at a cap\n", r.graph_dropped));
        }
        if !r.new_unclaimed.is_empty() {
            s.push_str(&format!("  NEW AND UNCLAIMED ({}): {}\n", r.new_unclaimed.len(), r.new_unclaimed.join(", ")));
        }
        s
    });
    Ok(())
}

fn cmd_segment(a: &Args) -> Result<(), String> {
    match a.positional.get(1).map(String::as_str) {
        None | Some("list") => {
            let segs = match open_read(a)? {
                Some(inv) => inv.segments()?,
                None => Vec::new(),
            };
            bsc_cli_util::emit(a.pretty, a.json, &segs, || {
                if segs.is_empty() {
                    return "no segments declared".into();
                }
                segs.iter().map(|s| format!("  {:<18} vlan {:<5} {}", s.cidr, s.vlan, s.name)).collect::<Vec<_>>().join("\n")
            });
            Ok(())
        }
        Some("set") => {
            let cidr = a.positional.get(2).ok_or("segment set needs <a.b.c.d/n>")?;
            let vlan: u16 = a
                .vlan
                .as_deref()
                .ok_or("segment set needs --vlan <1-4094>")?
                .trim()
                .parse()
                .map_err(|_| "--vlan must be a number 1-4094".to_string())?;
            let name = a.name.as_deref().ok_or("segment set needs --name <label>")?;
            let s = open_write(a)?.set_segment(cidr, vlan, name)?;
            bsc_cli_util::emit(a.pretty, a.json, &s, || format!("segment {} = vlan {} {}", s.cidr, s.vlan, s.name));
            Ok(())
        }
        Some("remove") => {
            let cidr = a.positional.get(2).ok_or("segment remove needs <a.b.c.d/n>")?;
            if !open_write(a)?.remove_segment(cidr)? {
                return Err(format!("no segment {cidr}"));
            }
            let out = serde_json::json!({ "removed": cidr });
            bsc_cli_util::emit(a.pretty, a.json, &out, || format!("removed segment {cidr}"));
            Ok(())
        }
        Some(other) => Err(format!("segment has no verb `{other}` — list · set · remove")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_db(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("bsc-inventory-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = dir.join("inventory.db");
        let _ = std::fs::remove_file(&db);
        (dir, db.display().to_string())
    }

    fn go(args: &[&str], db: &str) -> Result<(), String> {
        let mut v: Vec<String> = args.iter().map(|s| s.to_string()).collect();
        v.extend(["--db".to_string(), db.to_string(), "--json".to_string()]);
        run(v, "bsc inventory")
    }

    #[test]
    fn every_verb_is_documented_and_dispatched() {
        let names: Vec<_> = COMMANDS.iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["list", "get", "set", "release", "forget", "observe", "segment"]);
        for c in COMMANDS {
            assert!(c.usage.contains(c.name), "{}'s usage does not name it", c.name);
        }
        let e = run(vec!["nope".into()], "bsc inventory").unwrap_err();
        assert!(e.contains("nope"), "{e}");
    }

    #[test]
    fn a_read_never_creates_the_store() {
        let (dir, db) = tmp_db("read");
        go(&["list"], &db).unwrap();
        go(&["segment"], &db).unwrap();
        assert!(!std::path::Path::new(&db).exists(), "listing an absent inventory must not create one");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn set_claim_observe_and_forget_end_to_end() {
        let (dir, db) = tmp_db("e2e");
        go(&["set", "assistant-pi", "--name", "Assistant Pi", "--addr", "10.99.2.100"], &db).unwrap();
        go(&["segment", "set", "10.99.2.0/24", "--vlan", "2", "--name", "MGMT"], &db).unwrap();
        let graph = dir.join("g.json");
        let g = bsc_lan_sense::graph::fold(
            r#"{"event_type":"flow","src_ip":"10.99.2.118","src_port":1,"dest_ip":"10.99.2.100","dest_port":22,"proto":"TCP","flow":{"pkts_toclient":5}}"#,
        );
        std::fs::write(&graph, serde_json::to_string(&g).unwrap()).unwrap();
        go(&["observe", "--graph", graph.to_str().unwrap()], &db).unwrap();

        let inv = Inventory::open(std::path::Path::new(&db)).unwrap();
        let l = listing(&inv).unwrap();
        assert_eq!(l.devices.len(), 1);
        assert_eq!(l.devices[0].effective_vlan, Some(2), "no declared VLAN, so the segment decides");
        assert_eq!(l.devices[0].sightings.len(), 1);
        assert_eq!(l.unclaimed.iter().map(|s| s.addr.as_str()).collect::<Vec<_>>(), vec!["10.99.2.118"]);

        let e = go(&["set", "kali", "--addr", "10.99.2.100"], &db).unwrap_err();
        assert!(e.contains("assistant-pi"), "{e}");
        go(&["forget", "assistant-pi"], &db).unwrap();
        assert_eq!(listing(&inv).unwrap().unclaimed.len(), 2, "forgotten, so its address is unclaimed again");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_set_flag_left_out_keeps_and_an_empty_one_clears() {
        let (dir, db) = tmp_db("merge");
        go(&["set", "pi", "--name", "Pi", "--role", "dns"], &db).unwrap();
        go(&["set", "pi", "--role", ""], &db).unwrap();
        let d = Inventory::open(std::path::Path::new(&db)).unwrap().device("pi").unwrap().unwrap();
        assert_eq!((d.name.as_deref(), d.role), (Some("Pi"), None));
        assert!(go(&["set", "pi", "--vlan", "5000"], &db).unwrap_err().contains("1-4094"));
        assert!(go(&["set", "pi", "--expected", "maybe"], &db).unwrap_err().contains("yes or no"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn observe_refuses_input_that_is_not_a_graph() {
        let (dir, db) = tmp_db("bad");
        let f = dir.join("x.json");
        std::fs::write(&f, "{\"hello\":1}").unwrap();
        let e = go(&["observe", "--graph", f.to_str().unwrap()], &db).unwrap_err();
        assert!(e.contains("bsc lan graph"), "{e}");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unclaimed_renders_as_the_finding() {
        let s = render_unclaimed(&[], &[]);
        assert!(s.contains("no unclaimed"));
    }
}
