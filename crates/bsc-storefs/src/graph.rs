//! The algorithms knowledge graph, projected at `/graph`.
//!
//! ```text
//! impl/<id>/{code,name,role,summary,domain,tech,composes}
//! by-role/<role>/<id>       contains the name
//! by-domain/<domain>/<id>   contains the name
//! README
//! ```
//!
//! Consumes `bsc graph impl list` (a JSON array). That output is large — every node carries its
//! full `code` — so the projection is correspondingly large on disk. That is the right trade: the
//! code IS the node here ("a node is its implementation"), and a projection that omitted it would
//! be an index rather than a store.

use crate::{id_is_safe, line, lines, slug, Tree};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct Impl {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub domain: String,
    #[serde(default)]
    pub tech: String,
    #[serde(default)]
    pub code: String,
    #[serde(default)]
    pub composes: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

pub fn from_json(s: &str) -> Result<Vec<Impl>, serde_json::Error> {
    serde_json::from_str(s)
}

pub fn project(impls: &[Impl], generated_at: &str) -> Tree {
    let mut t = Tree::new();
    let mut by_role: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_domain: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for i in impls.iter().filter(|i| id_is_safe(&i.id)) {
        let base = format!("impl/{}", i.id);
        // `code` is written WITHOUT a trailing newline forced on it — it is source, and appending
        // to it would change the file the record actually holds.
        t.insert(format!("{base}/code"), i.code.clone());
        t.insert(format!("{base}/name"), line(&i.name));
        t.insert(format!("{base}/role"), line(&i.role));
        t.insert(format!("{base}/summary"), line(&i.summary));
        t.insert(format!("{base}/domain"), line(&i.domain));
        t.insert(format!("{base}/tech"), line(&i.tech));
        t.insert(format!("{base}/composes"), lines(&i.composes));
        t.insert(format!("{base}/tags"), lines(&i.tags));

        if !i.role.is_empty() {
            by_role.entry(slug(&i.role)).or_default().push(format!("{}\t{}", i.id, i.name));
        }
        if !i.domain.is_empty() {
            by_domain.entry(slug(&i.domain)).or_default().push(format!("{}\t{}", i.id, i.name));
        }
    }

    for (k, v) in by_role {
        t.insert(format!("by-role/{k}"), lines(&v));
    }
    for (k, v) in by_domain {
        t.insert(format!("by-domain/{k}"), lines(&v));
    }
    t.insert("README".into(), readme(impls.len(), generated_at));
    t
}

fn readme(count: usize, generated_at: &str) -> String {
    format!(
        "The algorithms graph, as files. A node IS its implementation.\n\
         \n\
         impl/<id>/code       the implementation source, byte-for-byte as stored\n\
         impl/<id>/name       .../role .../summary .../domain .../tech\n\
         impl/<id>/composes   ids this one composes, one per line\n\
         by-role/<role>       id and name, tab-separated\n\
         by-domain/<domain>   id and name, tab-separated\n\
         \n\
         THIS IS A SNAPSHOT, NOT A LIVE VIEW.\n\
         {count} implementation(s), projected at {generated_at}.\n\
         \n\
         THERE IS NO `bsc` IN THIS SESSION. That is the point of the projection, not an oversight:\n\
         a read surface can exist here precisely because no writable database is bound into the\n\
         namespace. Unlike /ui, the implementation SOURCE is projected — impl/<id>/code is the\n\
         record byte-for-byte, so reading is complete here.\n\
         There is no graph WRITE path from inside the cage. To raise a change, emit it on the\n\
         coordination outbox; the host is what reaches the store.\n"
    )
}

#[cfg(test)]
mod readme_tests {
    /// The README used to close with "To WRITE, or to read the live store, use `bsc graph`" — a
    /// command absent from the only place this is mounted. Unlike `/ui`, the READ half here is
    /// genuinely complete (`impl/<id>/code` is the record byte-for-byte), so the correction is to
    /// say that rather than to point at a CLI.
    #[test]
    fn the_readme_does_not_send_a_caged_reader_to_a_cli_it_lacks() {
        let readme = super::readme(2, "2026-01-01T00:00:00Z");
        assert!(
            readme.contains("NO `bsc` IN THIS SESSION"),
            "the reader must be told the CLI is absent: {readme}",
        );
        assert!(
            !readme.contains("use `bsc graph`"),
            "and must not be sent to it anyway: {readme}",
        );
        assert!(
            readme.contains("impl/<id>/code"),
            "reading IS complete here, unlike /ui — say so: {readme}",
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn impls() -> Vec<Impl> {
        vec![
            Impl {
                id: "a-star.rs".into(),
                name: "a_star".into(),
                role: "algorithm".into(),
                summary: "Dijkstra guided by a heuristic".into(),
                domain: "logistics".into(),
                tech: "rust".into(),
                code: "pub fn a_star() {}".into(),
                composes: vec!["rust.hashmap".into(), "rust.vec".into()],
                tags: vec![],
            },
            Impl { id: "vec.rs".into(), name: "vec".into(), role: "primitive".into(), tech: "rust".into(), ..Default::default() },
        ]
    }

    #[test]
    fn code_is_stored_byte_for_byte() {
        // It is source. Forcing a trailing newline would change the file the record holds.
        let t = project(&impls(), "T");
        assert_eq!(t["impl/a-star.rs/code"], "pub fn a_star() {}");
    }

    #[test]
    fn every_field_is_a_file_even_when_empty() {
        let t = project(&impls(), "T");
        for f in ["code", "name", "role", "summary", "domain", "tech", "composes", "tags"] {
            assert!(t.contains_key(&format!("impl/vec.rs/{f}")), "missing {f}");
        }
        assert_eq!(t["impl/vec.rs/composes"], "");
        assert_eq!(t["impl/vec.rs/summary"], "\n");
    }

    #[test]
    fn indexes_group_by_role_and_domain() {
        let t = project(&impls(), "T");
        assert_eq!(t["by-role/algorithm"], "a-star.rs\ta_star\n");
        assert_eq!(t["by-role/primitive"], "vec.rs\tvec\n");
        assert_eq!(t["by-domain/logistics"], "a-star.rs\ta_star\n");
        // vec has no domain, so it must not invent one.
        assert!(!t.keys().any(|k| k.starts_with("by-domain/unspecified")));
    }

    #[test]
    fn an_unsafe_id_is_dropped_rather_than_escaping() {
        let mut v = impls();
        v.push(Impl { id: "../../etc/passwd".into(), ..Default::default() });
        let t = project(&v, "T");
        assert!(t.keys().all(|k| !k.contains("..")));
    }

    #[test]
    fn parses_the_json_bsc_graph_emits() {
        let j = r#"[{"code":"fn x(){}","composes":["a"],"domain":"d","id":"x.rs",
                     "name":"x","role":"algorithm","summary":"s"}]"#;
        let v = from_json(j).unwrap();
        assert_eq!(v[0].id, "x.rs");
        assert_eq!(v[0].composes, vec!["a".to_string()]);
        // `tech` is absent in that payload and must default rather than fail.
        assert_eq!(v[0].tech, "");
    }

    #[test]
    fn output_is_deterministic() {
        assert_eq!(project(&impls(), "T"), project(&impls(), "T"));
    }
}
