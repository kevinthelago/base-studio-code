//! Every shipped `examples/*.json` spec must actually parse and mesh — this is the shape a maker or
//! an AI session copies first, so a broken example is a broken first impression. Deliberately
//! iterates the directory rather than naming files, so a new example is covered without editing this
//! test.
use bsc_cad::{polygonize, Node};
use std::fs;
use std::path::Path;

#[test]
fn every_example_spec_parses_and_meshes_watertight() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("examples");
    let entries: Vec<_> = fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", dir.display()))
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|ext| ext == "json"))
        .collect();
    assert!(!entries.is_empty(), "no example specs found under {}", dir.display());

    for path in entries {
        let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        let node: Node = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{} is not a valid op-tree: {e}", path.display()));
        let mesh = polygonize(&node, 24); // low-res: this is a schema/sanity check, not a precision one
        assert!(!mesh.is_empty(), "{} polygonizes to nothing", path.display());
        assert!(mesh.is_watertight(), "{} does not mesh watertight", path.display());
    }
}
