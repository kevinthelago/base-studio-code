//! The component store, projected at `/ui` — **the summary tier only**.
//!
//! ```text
//! components/<id>/{name,role,folder,kit}
//! by-role/<role>/<id>    contains the name
//! by-kit/<kit>/<id>      contains the name
//! README
//! ```
//!
//! Consumes `bsc ui list` (a JSON array). That output is deliberately lean — it carries
//! `folder,id,kitId,name,role,shapes` and **not** `srcText`. So this projection is an INDEX, not
//! the component source, and the README says so where a reader meets it. Projecting every
//! component's source would mean a `bsc ui get` per record, and the value of doing that has not
//! been established — the slice-2 measurement said the read-surface gain is bounded.
//!
//! That asymmetry with [`crate::graph`] is deliberate rather than an oversight: for algorithms the
//! code IS the node, so omitting it would leave nothing; for components the source is one field
//! among many and the index answers most questions on its own.

use crate::{id_is_safe, line, lines, slug, Tree};
use serde::Deserialize;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct Component {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default, rename = "kitId")]
    pub kit_id: String,
}

pub fn from_json(s: &str) -> Result<Vec<Component>, serde_json::Error> {
    serde_json::from_str(s)
}

pub fn project(components: &[Component], generated_at: &str) -> Tree {
    let mut t = Tree::new();
    let mut by_role: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut by_kit: BTreeMap<String, Vec<String>> = BTreeMap::new();

    for c in components.iter().filter(|c| id_is_safe(&c.id)) {
        let base = format!("components/{}", c.id);
        t.insert(format!("{base}/name"), line(&c.name));
        t.insert(format!("{base}/role"), line(&c.role));
        t.insert(format!("{base}/folder"), line(&c.folder));
        t.insert(format!("{base}/kit"), line(&c.kit_id));

        if !c.role.is_empty() {
            by_role.entry(slug(&c.role)).or_default().push(format!("{}\t{}", c.id, c.name));
        }
        if !c.kit_id.is_empty() {
            by_kit.entry(slug(&c.kit_id)).or_default().push(format!("{}\t{}", c.id, c.name));
        }
    }

    for (k, v) in by_role {
        t.insert(format!("by-role/{k}"), lines(&v));
    }
    for (k, v) in by_kit {
        t.insert(format!("by-kit/{k}"), lines(&v));
    }
    t.insert("README".into(), readme(components.len(), generated_at));
    t
}

fn readme(count: usize, generated_at: &str) -> String {
    format!(
        "The component store, as files. THIS IS AN INDEX, NOT THE SOURCE.\n\
         \n\
         components/<id>/name    .../role .../folder .../kit\n\
         by-role/<role>          id and name, tab-separated\n\
         by-kit/<kit>            id and name, tab-separated\n\
         \n\
         A component's srcText is NOT projected — `bsc ui list` does not carry it, and pulling it\n\
         would mean one `bsc ui get` per record. To read a component's source, use `bsc ui get <id>`.\n\
         \n\
         THIS IS A SNAPSHOT, NOT A LIVE VIEW.\n\
         {count} component(s), projected at {generated_at}.\n"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comps() -> Vec<Component> {
        vec![
            Component {
                id: "glance-node".into(),
                name: "GlanceNode".into(),
                role: "composite".into(),
                folder: "features/glance".into(),
                kit_id: "base-studio-code".into(),
            },
            Component { id: "alertrow".into(), name: "AlertRow".into(), role: "primitive".into(), folder: "app/(alerts)".into(), kit_id: "mobile-studio-code".into() },
        ]
    }

    #[test]
    fn index_fields_are_present_and_read_cleanly() {
        let t = project(&comps(), "T");
        assert_eq!(t["components/glance-node/name"], "GlanceNode\n");
        assert_eq!(t["components/glance-node/role"], "composite\n");
        assert_eq!(t["components/glance-node/kit"], "base-studio-code\n");
    }

    #[test]
    fn source_is_deliberately_absent_and_the_readme_says_so() {
        // bsc ui list does not carry srcText; claiming otherwise would make /ui look like a store
        // when it is an index.
        let t = project(&comps(), "T");
        assert!(!t.contains_key("components/glance-node/srcText"));
        assert!(t["README"].contains("INDEX, NOT THE SOURCE"));
        assert!(t["README"].contains("bsc ui get"));
    }

    #[test]
    fn folder_with_slashes_is_a_value_not_a_path() {
        // The folder is CONTENT of a file, so it keeps its slashes; only INDEX names are slugged.
        let t = project(&comps(), "T");
        assert_eq!(t["components/alertrow/folder"], "app/(alerts)\n");
        assert_eq!(t["by-kit/mobile-studio-code"], "alertrow\tAlertRow\n");
    }

    #[test]
    fn parses_the_json_bsc_ui_list_emits() {
        let j = r#"[{"folder":"settings/cards","id":"accentcolorcard","kitId":"base-studio-code",
                     "name":"AccentColorCard","role":"primitive","shapes":""}]"#;
        let v = from_json(j).unwrap();
        assert_eq!(v[0].id, "accentcolorcard");
        assert_eq!(v[0].kit_id, "base-studio-code");
    }

    #[test]
    fn a_blank_record_does_not_invent_index_entries() {
        // `bsc ui list` really does emit rows with empty id/kit/role.
        let v = vec![Component { id: "activityfeed".into(), ..Default::default() }];
        let t = project(&v, "T");
        assert!(t.contains_key("components/activityfeed/name"));
        assert!(!t.keys().any(|k| k.starts_with("by-role/")));
        assert!(!t.keys().any(|k| k.starts_with("by-kit/")));
    }

    #[test]
    fn output_is_deterministic() {
        assert_eq!(project(&comps(), "T"), project(&comps(), "T"));
    }
}
