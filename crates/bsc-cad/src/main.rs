//! `bsc-cad` CLI (#2621) — mesh a declarative op-tree spec (JSON) into a binary STL, and print the
//! stats a maker cares about (bounds in mm, triangle count, watertightness, volume). The standalone
//! surface for testing the kernel; it folds into the unified `bsc cad` subcommand later.
//!
//! Usage: `bsc-cad <spec.json> [-o out.stl] [--res N]`
use bsc_cad::{polygonize, to_binary_stl, Node};
use std::process::ExitCode;

const USAGE: &str = "\
bsc-cad — mesh a 3D op-tree spec (mm) into a binary STL

USAGE:
    bsc-cad <spec.json> [-o <out.stl>] [--res <N>]

ARGS:
    <spec.json>      the op-tree (e.g. {\"op\":\"box\",\"size\":[20,10,5]})

OPTIONS:
    -o, --out <f>    output STL path (default: <spec>.stl)
    --res <N>        cells along the longest axis (default: 96) — higher = finer
    -h, --help       show this help
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprint!("{USAGE}");
        return ExitCode::FAILURE;
    }

    let mut spec_path: Option<String> = None;
    let mut out: Option<String> = None;
    let mut res: usize = 96;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "-h" | "--help" => {
                print!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "-o" | "--out" => out = it.next().cloned(),
            "--res" => {
                if let Some(v) = it.next().and_then(|v| v.parse().ok()) {
                    res = v;
                }
            }
            _ if spec_path.is_none() => spec_path = Some(a.clone()),
            other => {
                eprintln!("bsc-cad: unexpected argument '{other}'\n\n{USAGE}");
                return ExitCode::FAILURE;
            }
        }
    }

    let Some(spec_path) = spec_path else {
        eprint!("{USAGE}");
        return ExitCode::FAILURE;
    };

    let text = match std::fs::read_to_string(&spec_path) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("bsc-cad: cannot read '{spec_path}': {e}");
            return ExitCode::FAILURE;
        }
    };
    let node: Node = match serde_json::from_str(&text) {
        Ok(n) => n,
        Err(e) => {
            eprintln!("bsc-cad: invalid spec '{spec_path}': {e}");
            return ExitCode::FAILURE;
        }
    };

    let mesh = polygonize(&node, res);
    let out_path = out.unwrap_or_else(|| {
        let stem = std::path::Path::new(&spec_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("object");
        format!("{stem}.stl")
    });
    let bytes = to_binary_stl(&mesh);
    if let Err(e) = std::fs::write(&out_path, &bytes) {
        eprintln!("bsc-cad: cannot write '{out_path}': {e}");
        return ExitCode::FAILURE;
    }

    let sz = node.bbox().size();
    eprintln!("bsc-cad · {spec_path}");
    eprintln!("  bounds      {:.2} × {:.2} × {:.2} mm", sz.x, sz.y, sz.z);
    eprintln!("  resolution  {res} cells / longest axis");
    eprintln!("  vertices    {}", mesh.positions.len());
    eprintln!("  triangles   {}", mesh.triangle_count());
    eprintln!("  watertight  {}", mesh.is_watertight());
    eprintln!(
        "  volume      {:.1} mm³  ({:.2} cm³)",
        mesh.volume(),
        mesh.volume() / 1000.0
    );
    eprintln!("  wrote       {out_path}  ({} bytes)", bytes.len());
    if mesh.is_empty() {
        eprintln!("  note        empty mesh — check the spec / that solids actually overlap");
    }
    ExitCode::SUCCESS
}
