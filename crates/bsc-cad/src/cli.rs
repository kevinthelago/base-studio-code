//! The `bsc cad` subcommand (#3387, kernel #2621) — mesh a declarative op-tree spec (JSON) into a
//! binary STL and report the stats a maker cares about (bounds in mm, triangle count, watertightness,
//! volume).
//!
//! This IS the kernel's whole CLI surface. It was the standalone `bsc-cad` binary through the #2621
//! foundation slice; that binary is now retired in favour of this subcommand, because only `bsc` and
//! `bsc-agent` are bundled with the app (`tauri.conf.json` `externalBin`) — a sidecar nobody ships is
//! a surface no live session can reach. Every other tool crate (`bsc-shot`, `bsc-navigate`,
//! `bsc-graph`, `bsc-ui`, …) is library-plus-`cli::run` with no `[[bin]]`; `bsc-cad` now matches.
//!
//! Dispatched by the unified `bsc` binary (#1877) via [`run`]; the shared per-command help (#1762):
//!   bsc cad help          # compact menu
//!   bsc cad mesh help     # detailed help for ONE command
//!
//! Reachable from a live session with no PATH changes: `bsc` is in the mandatory baseline command set
//! (`data/permissions/base.json`) and is execed by absolute path from `$BSC_BIN`.

use crate::{polygonize, to_binary_stl, Node};
use bsc_cli_util::CmdDoc;
use serde::Serialize;

const TAGLINE: &str =
    "Rust-native mesh/SDF geometry kernel (mm) — mesh an op-tree spec into a binary STL (#2621)";

/// Cells along the longest axis when `--res` is absent. Matches the standalone binary's default so a
/// spec meshed before this move yields the same mesh.
const DEFAULT_RES: usize = 96;

const COMMANDS: &[CmdDoc] = &[CmdDoc {
    name: "mesh",
    summary: "mesh a spec.json into a binary STL; prints the stats",
    usage: "\
USAGE:
  bsc cad mesh <spec.json> [-o <out.stl>] [--res <N>] [--json|--pretty]

Evaluates the declarative op-tree in <spec.json> as a signed-distance field, polygonizes it
(surface nets) into a watertight mesh, and writes a binary STL. Everything is MILLIMETRES.

  <spec.json>      the op-tree, e.g. {\"op\":\"box\",\"size\":[20,10,5]}
  -o, --out <f>    output STL path (default: <spec-stem>.stl, in the CURRENT directory)
  --res <N>        cells along the longest axis (default: 96) — higher = finer, and cost grows
                   roughly with N³, so raise it only once the shape is right.

THE OP-TREE
  Primitives (mm):  box{size:[x,y,z]} · sphere{r} · cylinder{r,h}
  Transforms:       translate{by,node} · rotate{axis,angle,node} · scale{by,node}
  Booleans:         union{nodes} · difference{base,tools} · intersect{nodes}
  Fillet:           smooth_union{k,nodes} — k is the blend radius in mm (SDF smooth-min)

  Describe WHAT THE PART IS, not vertices. A worked example ships at
  crates/bsc-cad/examples/bracket.json.

OUTPUT
  Lean text (default) prints the stats block. --json/--pretty emit them structured:
  { spec, out, resolution, bounds_mm, vertices, triangles, watertight, volume_mm3, bytes, empty }.

EMPTY MESHES ARE NOT AN ERROR
  A spec whose solids never overlap (or whose difference removes everything) polygonizes to zero
  triangles. That writes a valid, empty STL and reports empty=true rather than failing — the
  distinction between \"the kernel broke\" and \"your spec describes nothing\" matters when an agent is
  iterating on a shape.",
}];

/// The stats a maker (or an agent iterating on a spec) reads back after a mesh. Serialized as-is for
/// `--json`; the lean rendering below is the same numbers as a human block.
#[derive(Serialize)]
struct MeshStats {
    spec: String,
    out: String,
    resolution: usize,
    /// Bounding-box size in mm, `[x, y, z]` — from the op-tree's analytic bbox, not the mesh.
    bounds_mm: [f64; 3],
    vertices: usize,
    triangles: usize,
    watertight: bool,
    volume_mm3: f64,
    /// Size of the written STL in bytes.
    bytes: usize,
    /// Zero-triangle mesh — a valid outcome (see the `mesh` help), surfaced so a caller can branch.
    empty: bool,
}

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    out: Option<String>,
    res: Option<usize>,
    json: bool,
    pretty: bool,
}

fn parse_args(args: Vec<String>) -> Result<Args, String> {
    let mut a = Args::default();
    let mut it = args.into_iter();
    while let Some(tok) = it.next() {
        match tok.as_str() {
            "--json" => a.json = true,
            "--pretty" => a.pretty = true,
            // The retired standalone binary accepted `-h`/`--help`; keep them working by folding them
            // into the positional `help` that `bsc_cli_util::handle_help` understands, rather than
            // letting them fall into the unknown-flag branch below.
            "-h" | "--help" => a.positional.insert(0, "help".into()),
            "-o" | "--out" => a.out = Some(it.next().ok_or("--out needs a path")?),
            "--res" => {
                let v = it.next().ok_or("--res needs a cell count")?;
                let n: usize = v.parse().map_err(|_| format!("--res: not a number: {v}"))?;
                if n < 2 {
                    return Err(format!("--res must be at least 2 cells, got {n}"));
                }
                a.res = Some(n);
            }
            other if other.starts_with("--") => return Err(format!("unknown flag: {other}")),
            other => a.positional.push(other.to_string()),
        }
    }
    Ok(a)
}

/// The `cad` subcommand entrypoint: `args` is everything after `bsc cad`; `prog` is the display name
/// for help/errors.
pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let args = parse_args(args)?;
    let cmd = args.positional.first().cloned().unwrap_or_default();

    if bsc_cli_util::handle_help(prog, TAGLINE, COMMANDS, &args.positional) {
        return Ok(());
    }

    match cmd.as_str() {
        "mesh" => cmd_mesh(&args),
        other => Err(bsc_cli_util::unknown_command(prog, TAGLINE, COMMANDS, other)),
    }
}

/// `bsc cad mesh <spec.json>` — the standalone binary's whole behavior: read the op-tree, polygonize,
/// write the STL, report the stats.
fn cmd_mesh(args: &Args) -> Result<(), String> {
    let spec_path = args
        .positional
        .get(1)
        .ok_or("bsc cad mesh needs a spec: `bsc cad mesh <spec.json>` (see `bsc cad mesh help`)")?;

    let text = std::fs::read_to_string(spec_path)
        .map_err(|e| format!("cannot read '{spec_path}': {e}"))?;
    let node: Node =
        serde_json::from_str(&text).map_err(|e| format!("invalid spec '{spec_path}': {e}"))?;

    let res = args.res.unwrap_or(DEFAULT_RES);
    let mesh = polygonize(&node, res);
    let out_path = args.out.clone().unwrap_or_else(|| default_out(spec_path));
    let bytes = to_binary_stl(&mesh);
    std::fs::write(&out_path, &bytes).map_err(|e| format!("cannot write '{out_path}': {e}"))?;

    let sz = node.bbox().size();
    let stats = MeshStats {
        spec: spec_path.clone(),
        out: out_path,
        resolution: res,
        bounds_mm: [sz.x, sz.y, sz.z],
        vertices: mesh.positions.len(),
        triangles: mesh.triangle_count(),
        watertight: mesh.is_watertight(),
        volume_mm3: mesh.volume(),
        bytes: bytes.len(),
        empty: mesh.is_empty(),
    };
    bsc_cli_util::emit(args.pretty, args.json, &stats, || lean(&stats));
    Ok(())
}

/// `<spec-stem>.stl` when `--out` is absent — the standalone binary's rule, kept so an existing
/// invocation lands the same file.
fn default_out(spec_path: &str) -> String {
    let stem = std::path::Path::new(spec_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("object");
    format!("{stem}.stl")
}

/// The human stats block. Pure (takes the stats, returns the text) so it is testable without I/O.
fn lean(s: &MeshStats) -> String {
    let mut out = format!(
        "bsc cad · {}\n  \
         bounds      {:.2} × {:.2} × {:.2} mm\n  \
         resolution  {} cells / longest axis\n  \
         vertices    {}\n  \
         triangles   {}\n  \
         watertight  {}\n  \
         volume      {:.1} mm³  ({:.2} cm³)\n  \
         wrote       {}  ({} bytes)",
        s.spec,
        s.bounds_mm[0],
        s.bounds_mm[1],
        s.bounds_mm[2],
        s.resolution,
        s.vertices,
        s.triangles,
        s.watertight,
        s.volume_mm3,
        s.volume_mm3 / 1000.0,
        s.out,
        s.bytes,
    );
    if s.empty {
        out.push_str("\n  note        empty mesh — check the spec / that solids actually overlap");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stats() -> MeshStats {
        MeshStats {
            spec: "bracket.json".into(),
            out: "bracket.stl".into(),
            resolution: 96,
            bounds_mm: [40.0, 24.0, 20.0],
            vertices: 12,
            triangles: 4,
            watertight: true,
            volume_mm3: 2500.0,
            bytes: 284,
            empty: false,
        }
    }

    #[test]
    fn mesh_dispatches_and_an_unknown_verb_is_refused() {
        // The dispatch contract (#3387): `mesh` routes (it fails on the MISSING SPEC, proving it
        // reached the handler rather than the fallthrough), and anything else is refused with the
        // shared unknown-command text — never silently ignored.
        let missing_spec = run(vec!["mesh".into()], "bsc cad").unwrap_err();
        assert!(missing_spec.contains("needs a spec"), "reached cmd_mesh: {missing_spec}");

        let unknown = run(vec!["extrude".into()], "bsc cad").unwrap_err();
        assert!(unknown.contains("unknown command 'extrude'"));
        assert!(unknown.contains("COMMANDS:"), "the refusal carries the catalog");
        assert!(unknown.contains("mesh"), "... which lists the verb that DOES exist");
    }

    #[test]
    fn help_paths_succeed_without_touching_the_filesystem() {
        assert!(run(vec![], "bsc cad").is_ok(), "bare `bsc cad` prints the overview");
        assert!(run(vec!["help".into()], "bsc cad").is_ok());
        assert!(run(vec!["mesh".into(), "help".into()], "bsc cad").is_ok());
    }

    #[test]
    fn the_standalone_binarys_help_flags_still_work() {
        // `-h`/`--help` were the retired `bsc-cad` binary's help switches. They fold into the
        // positional `help` rather than tripping the unknown-flag branch, so muscle memory (and any
        // model that learned the old surface) still lands on help instead of an error.
        assert!(run(vec!["--help".into()], "bsc cad").is_ok());
        assert!(run(vec!["-h".into()], "bsc cad").is_ok());
        // `<verb> --help` drills into that ONE verb, matching `bsc cad mesh help`.
        let a = parse_args(vec!["mesh".into(), "--help".into()]).unwrap();
        assert_eq!(a.positional, vec!["help", "mesh"], "help leads so handle_help drills into mesh");
        assert!(run(vec!["mesh".into(), "--help".into()], "bsc cad").is_ok());
    }

    #[test]
    fn help_overview_lists_the_verb_and_per_command_help_drills_in() {
        let ov = bsc_cli_util::help_overview("bsc cad", TAGLINE, COMMANDS);
        assert!(ov.contains("mesh"), "overview lists mesh");
        let one = bsc_cli_util::help_for("bsc cad", TAGLINE, COMMANDS, "mesh");
        assert!(one.contains("bsc cad mesh <spec.json>"));
        assert!(one.contains("smooth_union"), "the op-tree vocabulary is discoverable");
    }

    #[test]
    fn flags_parse_off_the_positionals() {
        let a = parse_args(vec![
            "mesh".into(),
            "spec.json".into(),
            "-o".into(),
            "part.stl".into(),
            "--res".into(),
            "128".into(),
            "--json".into(),
        ])
        .unwrap();
        assert_eq!(a.positional, vec!["mesh", "spec.json"]);
        assert_eq!(a.out.as_deref(), Some("part.stl"));
        assert_eq!(a.res, Some(128));
        assert!(a.json);
    }

    #[test]
    fn bad_flags_are_rejected_rather_than_ignored() {
        assert!(parse_args(vec!["mesh".into(), "--nope".into()]).is_err());
        assert!(parse_args(vec!["mesh".into(), "--res".into(), "fine".into()]).is_err());
        // A 0/1-cell grid has no interior samples — caught here so the caller learns why, instead of
        // getting a silently empty mesh back.
        assert!(parse_args(vec!["mesh".into(), "--res".into(), "1".into()]).is_err());
        assert!(parse_args(vec!["mesh".into(), "--out".into()]).is_err(), "--out needs a value");
    }

    #[test]
    fn default_out_is_the_spec_stem() {
        assert_eq!(default_out("bracket.json"), "bracket.stl");
        assert_eq!(default_out("/tmp/parts/mount.json"), "mount.stl");
        assert_eq!(default_out(""), "object.stl");
    }

    #[test]
    fn lean_reports_the_numbers_and_flags_an_empty_mesh() {
        let s = lean(&stats());
        assert!(s.contains("40.00 × 24.00 × 20.00 mm"));
        assert!(s.contains("triangles   4"));
        assert!(s.contains("bracket.stl  (284 bytes)"));
        assert!(!s.contains("empty mesh"), "a real mesh carries no empty note");

        let empty = lean(&MeshStats { triangles: 0, empty: true, ..stats() });
        assert!(empty.contains("empty mesh"), "an empty mesh says so rather than looking fine");
    }
}
