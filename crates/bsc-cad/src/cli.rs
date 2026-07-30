//! The `bsc cad` subcommand (#3387, kernel #2621) — mesh a declarative op-tree spec (JSON) into a
//! binary STL or a glTF/GLB (#3389) and report the stats a maker cares about (bounds in mm, triangle
//! count, watertightness, volume).
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

use crate::{polygonize_with, to_binary_stl, to_glb, to_gltf_json, Method, Node};
use bsc_cli_util::CmdDoc;
use serde::Serialize;

const TAGLINE: &str =
    "Rust-native mesh/SDF geometry kernel (mm) — mesh an op-tree spec into STL or glTF (#2621)";

/// Cells along the longest axis when `--res` is absent. Matches the standalone binary's default so a
/// spec meshed before this move yields the same mesh.
const DEFAULT_RES: usize = 96;

const COMMANDS: &[CmdDoc] = &[CmdDoc {
    name: "mesh",
    summary: "mesh a spec.json into an STL or glTF; prints the stats",
    usage: "\
USAGE:
  bsc cad mesh <spec.json> [-o <out>] [--res <N>] [--format stl|gltf|glb] [--json|--pretty]

Evaluates the declarative op-tree in <spec.json> as a signed-distance field, polygonizes it
(dual contouring) into a watertight mesh, and writes it out. Everything is MILLIMETRES.

  <spec.json>      the op-tree, e.g. {\"op\":\"box\",\"size\":[20,10,5]}
  -o, --out <f>    output path (default: <spec-stem>.<ext> for the format, in the CURRENT directory)
  --res <N>        cells along the longest axis (default: 96) — higher = finer, and cost grows
                   roughly with N³, so raise it only once the shape is right.
  --format <f>     stl (default) · gltf · glb. Omit it and the format is inferred from --out's
                   extension, so `-o part.glb` just works.

FORMATS
  stl   binary STL — what slicers and every CAD tool read. No colour, no normals worth trusting,
        no scene. This is the MAKER format.
  gltf  a self-contained glTF 2.0 text file: indexed vertices, smooth per-vertex normals, and the
        buffer embedded as a base64 data: URI, so it is ONE file with nothing to resolve. This is
        the VIEWER format (#3389) — what an in-app preview renders.
  glb   the same model in the standard binary glTF container. Smaller than gltf (no base64), and
        what external viewers/engines expect.

  glTF is metres/Y-up while the kernel is mm/Z-up; the conversion rides on the scene NODE's matrix
  rather than being baked into the vertices, so the POSITION accessor's min/max stay in mm and line
  up with the bounds_mm reported below.

THE OP-TREE
  Primitives (mm):  box{size:[x,y,z]} · sphere{r} · cylinder{r,h}
  Transforms:       translate{by,node} · rotate{axis,angle,node} · scale{by,node}
  Booleans:         union{nodes} · difference{base,tools} · intersect{nodes}
  Fillet blend:     smooth_union{k,nodes} — k is the blend radius in mm (SDF smooth-min)
  Sketch-based:     extrude{profile,height} · revolve{profile} — profile is a closed 2D polygon,
                    e.g. [[0,0],[10,0],[10,10],[0,10]] (mm, implicitly closed). extrude sweeps it
                    along Z by height, centred on z=0; revolve sweeps it a full 360° about Z, reading
                    the profile's first coordinate as the radius (keep it >= 0) and the second as Z.
  Shell:            shell{thickness,node} — hollow node, keeping its outer surface fixed and
                    removing material beyond thickness mm inward.
  Pattern:          linear_pattern{by,count,node} · radial_pattern{axis,count,node} — count copies
                    of node, spaced by [x,y,z] mm per step (linear) or evenly around a full turn
                    about axis (radial).
  Round fillet:     fillet{r,node} — round node's own convex edges/corners with radius r mm by
                    dilating its whole surface outward (grows the envelope by r; a DIFFERENT op
                    from smooth_union, which blends the seam between distinct solids instead).

  Describe WHAT THE PART IS, not vertices. A worked example ships at
  crates/bsc-cad/examples/bracket.json.

OUTPUT
  Lean text (default) prints the stats block. --json/--pretty emit them structured:
  { spec, out, format, resolution, method, bounds_mm, vertices, triangles, watertight, volume_mm3,
    max_deviation_mm, mean_deviation_mm, bytes,
    empty }.

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
    /// `stl` · `gltf` · `glb` — which writer produced `out`.
    format: &'static str,
    resolution: usize,
    /// Bounding-box size in mm, `[x, y, z]` — from the op-tree's analytic bbox, not the mesh.
    bounds_mm: [f64; 3],
    vertices: usize,
    triangles: usize,
    watertight: bool,
    volume_mm3: f64,
    /// Which polygonizer produced the mesh (#3388).
    method: &'static str,
    /// Max distance from a mesh vertex to the TRUE surface (mm) — the number that discriminates
    /// a feature-preserving polygonizer from a rounding one. Surface nets holds a fixed ~2/3 cell
    /// at EVERY resolution, so refining never sharpens the feature; dual contouring is exact.
    max_deviation_mm: f64,
    /// Mean vertex-to-surface distance (mm). Small under either method — flat faces are easy —
    /// which is why `max_deviation_mm` is the one that tells them apart.
    mean_deviation_mm: f64,
    /// Size of the written STL in bytes.
    bytes: usize,
    /// Zero-triangle mesh — a valid outcome (see the `mesh` help), surfaced so a caller can branch.
    empty: bool,
}

/// Which writer runs. STL is the maker/slicer interchange; glTF and GLB are the viewer formats the
/// in-app preview renders (#3389).
#[derive(Clone, Copy, Debug, PartialEq)]
enum Format {
    Stl,
    Gltf,
    Glb,
}

impl Format {
    fn parse(s: &str) -> Result<Self, String> {
        match s.to_ascii_lowercase().as_str() {
            "stl" => Ok(Format::Stl),
            "gltf" => Ok(Format::Gltf),
            "glb" => Ok(Format::Glb),
            other => Err(format!("unknown --format '{other}' (expected: stl, gltf, glb)")),
        }
    }
    fn ext(self) -> &'static str {
        match self {
            Format::Stl => "stl",
            Format::Gltf => "gltf",
            Format::Glb => "glb",
        }
    }
    fn name(self) -> &'static str {
        self.ext()
    }
}

#[derive(Default)]
struct Args {
    positional: Vec<String>,
    out: Option<String>,
    res: Option<usize>,
    format: Option<Format>,
    /// Which polygonizer runs (#3388). `dual` preserves sharp features; `surface-nets` is the
    /// original placement, kept only so the difference stays measurable.
    method: Option<Method>,
    json: bool,
    pretty: bool,
}

impl Args {
    /// Explicit `--format` wins; otherwise the `--out` extension decides (so `-o part.glb` needs no
    /// second flag); otherwise STL, which is what the command did before glTF existed.
    fn format(&self) -> Format {
        self.format
            .or_else(|| {
                let out = self.out.as_ref()?;
                let ext = std::path::Path::new(out).extension()?.to_str()?;
                Format::parse(ext).ok()
            })
            .unwrap_or(Format::Stl)
    }
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
            "--method" => {
                let v = it.next().ok_or("--method needs a name: dual | surface-nets")?;
                a.method = Some(Method::parse(&v).ok_or_else(|| {
                    format!("--method: unknown polygonizer '{v}' (expected: dual | surface-nets)")
                })?);
            }
            "--format" => {
                let v = it.next().ok_or("--format needs a value (stl, gltf, glb)")?;
                a.format = Some(Format::parse(&v)?);
            }
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
    let method = args.method.unwrap_or_default();
    let mesh = polygonize_with(&node, res, method);
    let (max_dev, mean_dev) = mesh.surface_deviation(&node);
    let format = args.format();
    let out_path = args.out.clone().unwrap_or_else(|| default_out(spec_path, format));
    // The part's name in the glTF scene graph — the spec's stem, so a viewer's outliner shows
    // "bracket" rather than "mesh_0".
    let name = stem(spec_path);
    let bytes = match format {
        Format::Stl => to_binary_stl(&mesh),
        Format::Gltf => to_gltf_json(&mesh, &name).into_bytes(),
        Format::Glb => to_glb(&mesh, &name),
    };
    std::fs::write(&out_path, &bytes).map_err(|e| format!("cannot write '{out_path}': {e}"))?;

    let sz = node.bbox().size();
    let stats = MeshStats {
        spec: spec_path.clone(),
        out: out_path,
        format: format.name(),
        resolution: res,
        bounds_mm: [sz.x, sz.y, sz.z],
        vertices: mesh.positions.len(),
        triangles: mesh.triangle_count(),
        watertight: mesh.is_watertight(),
        volume_mm3: mesh.volume(),
        method: method.as_str(),
        max_deviation_mm: max_dev,
        mean_deviation_mm: mean_dev,
        bytes: bytes.len(),
        empty: mesh.is_empty(),
    };
    bsc_cli_util::emit(args.pretty, args.json, &stats, || lean(&stats));
    Ok(())
}

/// The spec's file stem — the part's name, and the base of the default output path.
fn stem(spec_path: &str) -> String {
    std::path::Path::new(spec_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("object")
        .to_string()
}

/// `<spec-stem>.<ext>` when `--out` is absent. For STL this is byte-for-byte the standalone binary's
/// rule, so an invocation written before glTF existed still lands the same file.
fn default_out(spec_path: &str, format: Format) -> String {
    format!("{}.{}", stem(spec_path), format.ext())
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
         wrote       {}  ({} bytes, {})",
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
        s.format,
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
            format: "stl",
            resolution: 96,
            bounds_mm: [40.0, 24.0, 20.0],
            vertices: 12,
            triangles: 4,
            watertight: true,
            volume_mm3: 2500.0,
            method: "dual-contouring",
            // A sharp-feature-preserving polygonizer sits essentially ON the true surface; these are
            // the shape of real dual-contouring numbers, not placeholders (#3388).
            max_deviation_mm: 0.0012,
            mean_deviation_mm: 0.0003,
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
        assert!(one.contains("--format stl|gltf|glb"), "the export formats are discoverable");
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
    fn default_out_is_the_spec_stem_with_the_formats_extension() {
        assert_eq!(default_out("bracket.json", Format::Stl), "bracket.stl");
        assert_eq!(default_out("/tmp/parts/mount.json", Format::Stl), "mount.stl");
        assert_eq!(default_out("", Format::Stl), "object.stl");
        assert_eq!(default_out("bracket.json", Format::Gltf), "bracket.gltf");
        assert_eq!(default_out("bracket.json", Format::Glb), "bracket.glb");
    }

    #[test]
    fn format_defaults_to_stl_and_is_inferred_from_the_out_extension() {
        // Backwards compatibility: no flags at all still means STL, so every pre-#3389 invocation
        // lands exactly the file it used to.
        assert_eq!(Args::default().format(), Format::Stl);

        let inferred = |out: &str| {
            parse_args(vec!["mesh".into(), "s.json".into(), "-o".into(), out.into()])
                .unwrap()
                .format()
        };
        assert_eq!(inferred("part.glb"), Format::Glb, "-o part.glb needs no --format");
        assert_eq!(inferred("part.gltf"), Format::Gltf);
        assert_eq!(inferred("part.stl"), Format::Stl);
        assert_eq!(inferred("part.obj"), Format::Stl, "an unknown extension falls back, not errors");
        assert_eq!(inferred("part"), Format::Stl, "no extension at all falls back");

        // An explicit --format overrides the extension rather than the other way round.
        let a = parse_args(vec![
            "mesh".into(),
            "s.json".into(),
            "-o".into(),
            "part.stl".into(),
            "--format".into(),
            "glb".into(),
        ])
        .unwrap();
        assert_eq!(a.format(), Format::Glb);
    }

    #[test]
    fn format_values_parse_case_insensitively_and_bad_ones_are_refused() {
        assert_eq!(Format::parse("GLTF").unwrap(), Format::Gltf);
        assert_eq!(Format::parse("Glb").unwrap(), Format::Glb);
        let err = Format::parse("step").unwrap_err();
        assert!(err.contains("unknown --format 'step'"));
        assert!(err.contains("stl, gltf, glb"), "the refusal lists what IS accepted: {err}");
        assert!(parse_args(vec!["mesh".into(), "--format".into()]).is_err(), "--format needs a value");
        assert!(parse_args(vec!["mesh".into(), "--format".into(), "nope".into()]).is_err());
    }

    #[test]
    fn lean_reports_the_numbers_and_flags_an_empty_mesh() {
        let s = lean(&stats());
        assert!(s.contains("40.00 × 24.00 × 20.00 mm"));
        assert!(s.contains("triangles   4"));
        assert!(s.contains("bracket.stl  (284 bytes, stl)"));
        assert!(!s.contains("empty mesh"), "a real mesh carries no empty note");

        let empty = lean(&MeshStats { triangles: 0, empty: true, ..stats() });
        assert!(empty.contains("empty mesh"), "an empty mesh says so rather than looking fine");
    }
}
