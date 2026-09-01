//! The node-URN grammar, derived in Rust
//! (`epic-frontend-logic-over-backend-resources-belongs-in-rust`).
//!
//! ## Why it moved
//!
//! The graph STORE is Rust's — `bsc graph impl get` resolves ids, `bsc ui get` resolves components —
//! but the grammar saying what a URN IS lived only in the renderer. The backend could hold every
//! record and still not parse a reference to one.
//!
//! It is load-bearing for cross-graph resolution: `@bsc/algorithms/fibonacci` is kit-less, so a React
//! component resolves a TypeScript implementation across BOTH pillar and technology.
//!
//! ## The two shapes
//!
//! - a **URN** — `<graph>:<kit>/<id>`, where the kit is split on the LAST slash, so `algo:rust/nested/fib`
//!   is kit `rust/nested`, id `fib`. That is what lets a kit be a path.
//! - a **library spec** — `@bsc/<segment>/<name>`, kit-less by design, where the segment maps back to a
//!   graph (`algorithms`→algo, `ui`→ui, `sounds`→sound).
//!
//! Proved equal to the live TypeScript by `nodeUrn.fixtures.json`, generated from it — including the
//! REJECTIONS, because a grammar is defined as much by what it refuses.
#![allow(dead_code)] // wired by its own slice — nothing calls this yet, by design

/// The three graphs a node can belong to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum NodeGraph {
    Algo,
    Ui,
    Sound,
}

impl NodeGraph {
    /// The wire name, as it appears before the colon in a URN.
    pub fn as_str(self) -> &'static str {
        match self {
            NodeGraph::Algo => "algo",
            NodeGraph::Ui => "ui",
            NodeGraph::Sound => "sound",
        }
    }

    /// Parse a graph name. Case-sensitive: `ALGO` is not a graph, matching the TypeScript.
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "algo" => Some(NodeGraph::Algo),
            "ui" => Some(NodeGraph::Ui),
            "sound" => Some(NodeGraph::Sound),
            _ => None,
        }
    }

    /// The `@bsc/<segment>` path segment this graph uses in a library import.
    pub fn library_segment(self) -> &'static str {
        match self {
            NodeGraph::Algo => "algorithms",
            NodeGraph::Ui => "ui",
            NodeGraph::Sound => "sounds",
        }
    }

    /// The reverse of [`library_segment`].
    pub fn from_library_segment(seg: &str) -> Option<Self> {
        match seg {
            "algorithms" => Some(NodeGraph::Algo),
            "ui" => Some(NodeGraph::Ui),
            "sounds" => Some(NodeGraph::Sound),
            _ => None,
        }
    }
}

/// The reserved npm-style root for a library import, chosen so it can never collide with a real
/// package a user installs.
pub const LIBRARY_ROOT: &str = "@bsc";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeUrnParts {
    pub graph: NodeGraph,
    pub kit: String,
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LibrarySpec {
    pub graph: NodeGraph,
    pub name: String,
}

/// Build a URN, or `None` when any part is missing or the graph is unknown.
pub fn format_node_urn(graph: NodeGraph, kit: &str, id: &str) -> Option<String> {
    if kit.is_empty() || id.is_empty() {
        return None;
    }
    Some(format!("{}:{}/{}", graph.as_str(), kit, id))
}

/// Parse `<graph>:<kit>/<id>`.
///
/// THE KIT SPLITS ON THE LAST SLASH, not the first — that is what lets a kit be a path
/// (`algo:rust/nested/fib` is kit `rust/nested`). Both halves must be non-empty, and the colon may
/// not be at index 0, so `:rust/fib` is refused rather than parsed with an empty graph.
pub fn parse_node_urn(urn: &str) -> Option<NodeUrnParts> {
    let colon = urn.find(':')?;
    // BELT AND BRACES, and knowing that matters: an empty graph name never parses, so this guard
    // changes no outcome — removing it leaves the parity test green. It is kept because the
    // TypeScript has the same `colon <= 0` check and the two are read side by side; a reader
    // comparing them should not have to work out that the shapes diverged for no reason.
    if colon == 0 {
        return None;
    }
    let graph = NodeGraph::parse(&urn[..colon])?;
    let rest = &urn[colon + 1..];
    let slash = rest.rfind('/')?;
    if slash == 0 {
        return None; // a non-empty kit is required before the last '/'
    }
    let kit = &rest[..slash];
    let id = &rest[slash + 1..];
    if kit.is_empty() || id.is_empty() {
        return None;
    }
    Some(NodeUrnParts { graph, kit: kit.to_string(), id: id.to_string() })
}

pub fn is_node_urn(s: &str) -> bool {
    parse_node_urn(s).is_some()
}

/// Whether a specifier is under the reserved library root. A PREFIX test only — `@bscx/...` is not,
/// and neither is a bare `@bsc` with no slash.
pub fn is_library_spec(spec: &str) -> bool {
    spec.starts_with(&format!("{LIBRARY_ROOT}/"))
}

/// Parse `@bsc/<segment>/<name>`. The name may itself contain slashes; the SEGMENT splits on the
/// first one, which is the mirror of the URN's last-slash rule and deliberately not the same.
pub fn parse_library_spec(spec: &str) -> Option<LibrarySpec> {
    if !is_library_spec(spec) {
        return None;
    }
    let after = &spec[LIBRARY_ROOT.len() + 1..];
    let slash = after.find('/')?;
    if slash == 0 {
        return None;
    }
    let graph = NodeGraph::from_library_segment(&after[..slash])?;
    let name = &after[slash + 1..];
    if name.is_empty() {
        return None;
    }
    Some(LibrarySpec { graph, name: name.to_string() })
}

/// A URN as the import specifier that resolves it. KIT-LESS by design — that is what makes a
/// reference resolve across technologies.
pub fn urn_to_import_spec(urn: &str) -> Option<String> {
    let p = parse_node_urn(urn)?;
    Some(format!("{LIBRARY_ROOT}/{}/{}", p.graph.library_segment(), p.id))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// THE GRAMMAR IS PROVED EQUAL, NOT INSPECTED. `nodeUrn.fixtures.json` is GENERATED from the live
    /// TypeScript over 24 subjects and 5 format triples — accepts AND rejections, because a grammar
    /// is defined as much by what it refuses.
    ///
    /// Resolved by FILENAME under `src/`, the rule the tunnel contract uses.
    #[test]
    fn rust_parses_the_same_grammar_as_the_typescript() {
        fn find(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    find(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("nodeUrn.fixtures.json") {
                    out.push(p);
                }
            }
        }
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found = Vec::new();
        find(&root, &mut found);
        assert_eq!(found.len(), 1, "expected one nodeUrn.fixtures.json, got {found:?}");
        let doc: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap();

        // The constants themselves must not drift.
        assert_eq!(doc["libraryRoot"].as_str().unwrap(), LIBRARY_ROOT);
        let graphs: Vec<&str> =
            doc["graphs"].as_array().unwrap().iter().map(|g| g.as_str().unwrap()).collect();
        assert_eq!(graphs, vec!["algo", "ui", "sound"], "the graph set moved");
        for g in [NodeGraph::Algo, NodeGraph::Ui, NodeGraph::Sound] {
            assert_eq!(
                doc["librarySegment"][g.as_str()].as_str().unwrap(),
                g.library_segment(),
                "library segment for {}",
                g.as_str()
            );
        }

        for p in doc["graphPredicate"].as_array().unwrap() {
            let v = p["value"].as_str().unwrap();
            assert_eq!(
                NodeGraph::parse(v).is_some(),
                p["isNodeGraph"].as_bool().unwrap(),
                "isNodeGraph({v:?})"
            );
        }

        for f in doc["formats"].as_array().unwrap() {
            let why = f["why"].as_str().unwrap();
            let got = NodeGraph::parse(f["graph"].as_str().unwrap())
                .and_then(|g| format_node_urn(g, f["kit"].as_str().unwrap(), f["id"].as_str().unwrap()));
            let want = f["formatted"].as_str().map(str::to_string);
            assert_eq!(got, want, "format differs for `{why}`");
        }

        for s in doc["subjects"].as_array().unwrap() {
            let why = s["why"].as_str().unwrap();
            let subject = s["subject"].as_str().unwrap();

            let got = parse_node_urn(subject);
            match s["parseNodeUrn"].as_object() {
                Some(w) => {
                    let g = got.as_ref().unwrap_or_else(|| panic!("expected a parse for `{why}`"));
                    assert_eq!(g.graph.as_str(), w["graph"].as_str().unwrap(), "graph for `{why}`");
                    assert_eq!(g.kit, w["kit"].as_str().unwrap(), "kit for `{why}`");
                    assert_eq!(g.id, w["id"].as_str().unwrap(), "id for `{why}`");
                }
                None => assert!(got.is_none(), "`{why}` must be REFUSED, got {got:?}"),
            }

            assert_eq!(is_node_urn(subject), s["isNodeUrn"].as_bool().unwrap(), "isNodeUrn `{why}`");
            assert_eq!(
                is_library_spec(subject),
                s["isLibrarySpec"].as_bool().unwrap(),
                "isLibrarySpec `{why}`"
            );

            let lib = parse_library_spec(subject);
            match s["parseLibrarySpec"].as_object() {
                Some(w) => {
                    let l = lib.as_ref().unwrap_or_else(|| panic!("expected a library spec for `{why}`"));
                    assert_eq!(l.graph.as_str(), w["graph"].as_str().unwrap(), "lib graph `{why}`");
                    assert_eq!(l.name, w["name"].as_str().unwrap(), "lib name `{why}`");
                }
                None => assert!(lib.is_none(), "`{why}` must not be a library spec, got {lib:?}"),
            }

            assert_eq!(
                urn_to_import_spec(subject),
                s["urnToImportSpec"].as_str().map(str::to_string),
                "urnToImportSpec `{why}`"
            );
        }
    }

    /// The two slash rules are DELIBERATELY different, and confusing them is the likely port bug: a
    /// URN's kit takes the LAST slash so the kit can be a path, while a library spec's segment takes
    /// the FIRST so the name can be.
    #[test]
    fn the_urn_splits_last_and_the_library_spec_splits_first() {
        let u = parse_node_urn("algo:rust/nested/fib").expect("parses");
        assert_eq!(u.kit, "rust/nested", "the kit takes everything before the LAST slash");
        assert_eq!(u.id, "fib");

        let l = parse_library_spec("@bsc/algorithms/a/b").expect("parses");
        assert_eq!(l.name, "a/b", "the name takes everything after the FIRST slash");
    }
}
