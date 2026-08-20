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
    t.insert("schema".into(), write_schema());
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

// ── WRITES ──────────────────────────────────────────────────────────────────────────────────
//
// `/ui` is a read-only snapshot, so an author cannot write into it. The write surface is a
// separate WRITABLE outbox at `/ui/out`, drained host-side into `bsc ui set`.
//
// This is what closes the designer hole: that role's whole surface is `bsc ui`, which WRITES, so
// before this it had to bind the `bsc` binary and carry ambient authority.
//
// ── A DIRECTORY, where coord used a single file ─────────────────────────────────────────────
//
// `/coord/out` could use *filename = verb, contents = message*, because a message is one short
// line. A component's `srcText` is SOURCE, often thousands of lines. Putting it inside a JSON
// blob means escaping it, and CLAUDE.md is explicit about the cost: source on a command line
// "is corrupted SILENTLY by the shell — a backtick or a dollar-brace is substituted away and a
// literal backslash-n never becomes a newline". `bsc ui set` grew `--file` for that reason.
//
// So the source gets its OWN FILE, byte-for-byte, and the drain assembles the JSON:
//
//     /ui/out/<id>/srcText   the component source
//     /ui/out/<id>/name      optional
//     /ui/out/<id>/role      optional — primitive | composite | layout
//     /ui/out/<id>/kit       optional
//     /ui/out/<id>/folder    optional
//
// ── Two rules the drain must respect ────────────────────────────────────────────────────────
//
// A write is a MERGE: `bsc ui set` overlays what it is sent and preserves the rest, so a partial
// `{id, srcText}` is safe and is the common case. The drain must NOT fabricate fields the author
// did not supply.
//
// `role: page` is GATED — `bsc ui set --force` exists to "store a role: page the gate would
// refuse (a deliberate spec)". The outbox refuses it and names the fix rather than forcing it.

/// Roles the outbox accepts. `page` is deliberately absent — see above.
pub const WRITABLE_ROLES: &[&str] = &["primitive", "composite", "layout"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteRejection {
    UnsafeId(String),
    MissingSource(String),
    GatedRole { id: String, role: String },
    UnknownRole { id: String, role: String },
}

impl WriteRejection {
    /// The text written back beside the refused entry. It must NAME THE FIX — a rejection an
    /// author cannot act on is a silent drop, only slower.
    pub fn fix(&self) -> String {
        match self {
            WriteRejection::UnsafeId(id) => format!(
                "rejected: {id:?} cannot be a component id.\n\nfix: use only letters, digits, '-', '_' and '.', and do not start with '.'\n"
            ),
            WriteRejection::MissingSource(id) => format!(
                "rejected: {id:?} has no srcText.\n\nfix: the source goes in its own file, unescaped:\n  cat > /ui/out/{id}/srcText\n"
            ),
            WriteRejection::GatedRole { id, role } => format!(
                "rejected: {id:?} asks for role {role:?}, which is gated.\n\nfix: write one of: {}\na page is a deliberate spec and needs a human to run: bsc ui set --force\n",
                WRITABLE_ROLES.join(" ")
            ),
            WriteRejection::UnknownRole { id, role } => format!(
                "rejected: {id:?} asks for role {role:?}.\n\nfix: write one of: {}\n",
                WRITABLE_ROLES.join(" ")
            ),
        }
    }
}

/// One accepted write, ready to hand to `bsc ui set` as JSON.
///
/// Only fields the author actually supplied are present — the write is a merge, so an absent
/// field means "leave the stored one alone", never "clear it".
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ComponentWrite {
    pub id: String,
    pub src_text: String,
    pub name: Option<String>,
    pub role: Option<String>,
    pub kit: Option<String>,
    pub folder: Option<String>,
}

impl ComponentWrite {
    /// Serialize exactly what was supplied, and nothing else — the merge semantics live here.
    pub fn to_json(&self) -> String {
        let mut m = serde_json::Map::new();
        m.insert("id".into(), serde_json::Value::String(self.id.clone()));
        m.insert("srcText".into(), serde_json::Value::String(self.src_text.clone()));
        for (k, v) in [
            ("name", &self.name),
            ("role", &self.role),
            ("kitId", &self.kit),
            ("folder", &self.folder),
        ] {
            if let Some(val) = v {
                m.insert(k.into(), serde_json::Value::String(val.clone()));
            }
        }
        serde_json::Value::Object(m).to_string()
    }
}

fn trimmed(fields: &[(String, String)], key: &str) -> Option<String> {
    fields
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Validate one outbox entry. `fields` is `(filename, contents)` read from `/ui/out/<id>/`.
pub fn accept_write(id: &str, fields: &[(String, String)]) -> Result<ComponentWrite, WriteRejection> {
    if !crate::id_is_safe(id) {
        return Err(WriteRejection::UnsafeId(id.to_string()));
    }
    // srcText is NOT trimmed: it is source, and its leading/trailing whitespace is the author's.
    let src_text = fields
        .iter()
        .find(|(k, _)| k == "srcText")
        .map(|(_, v)| v.clone())
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| WriteRejection::MissingSource(id.to_string()))?;

    let role = trimmed(fields, "role");
    if let Some(r) = &role {
        if r == "page" {
            return Err(WriteRejection::GatedRole { id: id.into(), role: r.clone() });
        }
        if !WRITABLE_ROLES.contains(&r.as_str()) {
            return Err(WriteRejection::UnknownRole { id: id.into(), role: r.clone() });
        }
    }

    Ok(ComponentWrite {
        id: id.to_string(),
        src_text,
        name: trimmed(fields, "name"),
        role,
        kit: trimmed(fields, "kit"),
        folder: trimmed(fields, "folder"),
    })
}

/// Drain an outbox: accepted writes, and `(name.rejected, fix-text)` pairs to write back.
pub fn drain_writes(
    entries: &[(String, Vec<(String, String)>)],
) -> (Vec<ComponentWrite>, Vec<(String, String)>) {
    let mut ok = Vec::new();
    let mut rejected = Vec::new();
    for (id, fields) in entries {
        if id.ends_with(".rejected") {
            continue; // our own feedback, not a new entry
        }
        match accept_write(id, fields) {
            Ok(w) => ok.push(w),
            Err(r) => rejected.push((format!("{id}.rejected"), r.fix())),
        }
    }
    (ok, rejected)
}

/// The readable contract, projected at `/ui/schema`. Prevention, so an author can be right the
/// first time rather than learning the vocabulary by being refused.
pub fn write_schema() -> String {
    let mut out: Vec<String> = [
        "How to author a component.",
        "",
        "One DIRECTORY per component under /ui/out. The source goes in its own file so it is",
        "never escaped - a backtick or a dollar-brace in real TSX survives byte-for-byte.",
        "",
        "  mkdir -p /ui/out/mycard",
        "  cat > /ui/out/mycard/srcText   # then the source, verbatim",
        "  echo MyCard    > /ui/out/mycard/name",
        "  echo composite > /ui/out/mycard/role",
        "",
        "FIELDS",
        "  srcText   required - the component source, byte-for-byte",
        "  name      optional",
        "  role      optional",
        "  kit       optional",
        "  folder    optional",
        "",
        "ACCEPTED ROLES",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    out.push(format!("  {}", WRITABLE_ROLES.join(" ")));
    out.extend(
        [
            "",
            "role: page is REFUSED here. A page is a deliberate spec and needs a human to run",
            "bsc ui set --force.",
            "",
            "A WRITE IS A MERGE. Fields you do not send are PRESERVED on the stored record, so",
            "sending only srcText changes the source and leaves kit, role, composes and props",
            "exactly as they were. Omitting a field never clears it.",
            "",
            "A refused entry comes back as <id>.rejected, whose text names the fix. That feedback",
            "is ASYNCHRONOUS: it appears after the next drain, not when you write.",
            "",
            "/ui/out is the only writable path here. Everything else under /ui is a read-only",
            "snapshot and writing to it will fail.",
            "",
        ]
        .iter()
        .map(|s| s.to_string()),
    );
    out.join("\n")
}

#[cfg(test)]
mod write_tests {
    use super::*;

    fn f(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn source_survives_byte_for_byte() {
        // THE POINT of a directory-per-component: real TSX contains backticks and dollar-braces,
        // and escaping it into JSON is the silent corruption CLAUDE.md warns about.
        let src = "export const x = `a ${b} c`;\nconst s = \"line\\nnot-a-newline\";\n";
        let w = accept_write("mycard", &f(&[("srcText", src)])).unwrap();
        assert_eq!(w.src_text, src, "source must not be normalized or trimmed");
        let json = w.to_json();
        let back: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(back["srcText"].as_str().unwrap(), src, "round-trip must be lossless");
    }

    #[test]
    fn a_write_is_a_merge_so_absent_fields_are_not_fabricated() {
        // bsc ui set preserves what it is not sent. Emitting an empty name would CLEAR the
        // stored one, turning a source edit into silent data loss.
        let w = accept_write("mycard", &f(&[("srcText", "x")])).unwrap();
        let v: serde_json::Value = serde_json::from_str(&w.to_json()).unwrap();
        assert_eq!(v.as_object().unwrap().len(), 2, "only id and srcText");
        assert!(v.get("name").is_none());
        assert!(v.get("role").is_none());
        assert!(v.get("kitId").is_none());
    }

    #[test]
    fn supplied_fields_are_carried_through() {
        let w = accept_write(
            "mycard",
            &f(&[("srcText", "x"), ("name", "MyCard\n"), ("role", "composite\n"), ("kit", "base-studio-code")]),
        )
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&w.to_json()).unwrap();
        assert_eq!(v["name"], "MyCard");
        assert_eq!(v["role"], "composite");
        assert_eq!(v["kitId"], "base-studio-code");
    }

    #[test]
    fn a_page_is_refused_rather_than_forced() {
        // bsc ui set --force exists precisely because a page is a deliberate spec. The outbox
        // must not quietly do on an agent's behalf what the CLI makes a human ask for.
        let e = accept_write("p", &f(&[("srcText", "x"), ("role", "page")])).unwrap_err();
        assert_eq!(e, WriteRejection::GatedRole { id: "p".into(), role: "page".into() });
        let fix = e.fix();
        assert!(fix.contains("gated"));
        assert!(fix.contains("bsc ui set --force"));
        assert!(fix.contains("composite"), "the fix must list what IS accepted");
    }

    #[test]
    fn an_unknown_role_is_refused_with_the_accepted_set() {
        let e = accept_write("c", &f(&[("srcText", "x"), ("role", "widget")])).unwrap_err();
        assert!(matches!(e, WriteRejection::UnknownRole { .. }));
        assert!(e.fix().contains("primitive composite layout"));
    }

    #[test]
    fn a_write_without_source_is_refused() {
        for fields in [vec![], f(&[("srcText", "   \n")]), f(&[("name", "X")])] {
            let e = accept_write("c", &fields).unwrap_err();
            assert_eq!(e, WriteRejection::MissingSource("c".into()));
            assert!(e.fix().contains("its own file"));
        }
    }

    #[test]
    fn an_id_cannot_escape_its_directory() {
        let e = accept_write("../../etc/passwd", &f(&[("srcText", "x")])).unwrap_err();
        assert!(matches!(e, WriteRejection::UnsafeId(_)));
    }

    #[test]
    fn drain_splits_accepted_from_refused_and_ignores_its_own_feedback() {
        let entries = vec![
            ("good".to_string(), f(&[("srcText", "x")])),
            ("bad".to_string(), f(&[("srcText", "x"), ("role", "page")])),
            ("bad.rejected".to_string(), f(&[("srcText", "noise")])),
        ];
        let (ok, refused) = drain_writes(&entries);
        assert_eq!(ok.len(), 1);
        assert_eq!(ok[0].id, "good");
        assert_eq!(refused.len(), 1);
        assert_eq!(refused[0].0, "bad.rejected");
    }

    #[test]
    fn schema_is_projected_and_states_the_merge_and_the_gate() {
        let t = project(&[], "T");
        let s = &t["schema"];
        assert!(s.contains("One DIRECTORY per component"));
        assert!(s.contains("A WRITE IS A MERGE"));
        assert!(s.contains("role: page is REFUSED"));
        assert!(s.contains("ASYNCHRONOUS"));
        for r in WRITABLE_ROLES {
            assert!(s.contains(r), "schema must list {r}");
        }
    }
}
