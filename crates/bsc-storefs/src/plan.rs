//! The plan store, projected as a read-only file tree at `/plan`.
//!
//! Layout:
//! ```text
//! items/<ref>/{status,title,body,acceptance,labels,dependsOn}
//! by-status/<status>/<ref>   contains the title — `ls` it to see what is in that state
//! README                     states the staleness where a reader meets it
//! ```
//!
//! Consumes the JSON `bsc plan list --FULL --json` emits. Plain `--json` is the LEAN summary
//! shape, where `acceptance` is a COUNT rather than an array and `body` is absent entirely — it
//! does not deserialize into [`PlanItem`] and fails at parse time.


use crate::{id_is_safe, lines, Tree};
use serde::Deserialize;
use std::collections::BTreeMap;

/// One plan item, in the shape `bsc plan get --json` emits.
#[derive(Debug, Clone, Deserialize, Default, PartialEq, Eq)]
pub struct PlanItem {
    #[serde(rename = "ref")]
    pub reference: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub acceptance: Vec<String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default, rename = "dependsOn")]
    pub depends_on: Vec<String>,
}



/// Render the tree. `generated_at` is passed in rather than read from the clock so the projection
/// stays pure and its tests are deterministic.
pub fn project(items: &[PlanItem], generated_at: &str) -> Tree {
    let mut t = Tree::new();
    let mut by_status: BTreeMap<&str, Vec<&PlanItem>> = BTreeMap::new();

    for it in items.iter().filter(|i| id_is_safe(&i.reference)) {
        let base = format!("items/{}", it.reference);
        // Every field is always present, even when empty: a predictable shape means `cat` returns
        // nothing rather than failing, and an agent never has to test for a file's existence.
        t.insert(format!("{base}/status"), format!("{}\n", it.status));
        t.insert(format!("{base}/title"), format!("{}\n", it.title));
        t.insert(format!("{base}/body"), it.body.clone());
        t.insert(format!("{base}/acceptance"), lines(&it.acceptance));
        t.insert(format!("{base}/labels"), lines(&it.labels));
        t.insert(format!("{base}/dependsOn"), lines(&it.depends_on));
        by_status.entry(it.status.as_str()).or_default().push(it);
    }

    // `ls /plan/by-status/open` answers "what is available" without a query language.
    for (status, group) in &by_status {
        if status.is_empty() {
            continue;
        }
        for it in group {
            t.insert(
                format!("by-status/{}/{}", status, it.reference),
                format!("{}\n", it.title),
            );
        }
    }

    t.insert("README".into(), readme(items.len(), generated_at));
    t
}

fn readme(count: usize, generated_at: &str) -> String {
    format!(
        "The plan store, as files.\n\
         \n\
         items/<ref>/status       open | in_progress | blocked | complete | verified | failed\n\
         items/<ref>/title\n\
         items/<ref>/body         markdown\n\
         items/<ref>/acceptance   one criterion per line\n\
         items/<ref>/labels       one per line\n\
         items/<ref>/dependsOn    one per line\n\
         by-status/<status>/<ref> contains the title — ls it to see what is in that state\n\
         \n\
         THIS IS A SNAPSHOT, NOT A LIVE VIEW.\n\
         {count} item(s), projected at {generated_at}. It does not change when the store does.\n\
         It is mounted read-only, so a write is refused by the mount rather than being lost.\n\
         \n\
         THERE IS NO `bsc` IN THIS SESSION. That is the point of the projection, not an oversight:\n\
         a read surface can exist here precisely because no writable database is bound into the\n\
         namespace. This snapshot is the whole of what you can read of the plan.\n\
         There is no plan WRITE path from inside the cage yet — no /plan/out to match /coord/out.\n\
         To raise something you cannot do from here, emit it on the coordination outbox\n\
         (bsc-ask); the host is what reaches the store.\n"
    )
}

/// Parse the JSON array `bsc plan list --json` emits.
pub fn from_json(s: &str) -> Result<Vec<PlanItem>, serde_json::Error> {
    serde_json::from_str(s)
}


#[cfg(test)]
mod readme_tests {
    /// The README used to close with "For live reads or any write, use the bsc plan CLI" — in the
    /// only place this projection is ever mounted, there is no `bsc`. It is not bound on purpose:
    /// a writable store inside the namespace is the ambient authority the isolation exists to
    /// remove, which is the same reason the projection exists at all.
    #[test]
    fn the_readme_does_not_send_a_caged_reader_to_a_cli_it_lacks() {
        let readme = super::readme(3, "2026-01-01T00:00:00Z");
        assert!(
            readme.contains("NO `bsc` IN THIS SESSION"),
            "the reader must be told the CLI is absent: {readme}",
        );
        assert!(
            !readme.contains("use the bsc plan CLI"),
            "and must not be sent to it anyway: {readme}",
        );
        // The plan store has no /plan/out to match /coord/out, so the honest answer is the
        // coordination channel — not silence, and not a command that cannot run.
        assert!(readme.contains("bsc-ask"), "name the escalation that DOES work: {readme}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn items() -> Vec<PlanItem> {
        vec![
            PlanItem {
                reference: "phase-1-linux-host".into(),
                title: "Delete the Windows tax".into(),
                status: "open".into(),
                body: "## Why\n\nBecause.\n".into(),
                acceptance: vec!["gate is green".into(), "no cfg(windows) remains".into()],
                labels: vec!["linux".into()],
                depends_on: vec!["phase-0".into()],
                },
            PlanItem {
                reference: "phase-0".into(),
                title: "Price the port".into(),
                status: "complete".into(),
                ..Default::default()
            },
        ]
    }

    #[test]
    fn every_field_is_a_file_even_when_empty() {
        // A predictable shape means an agent never tests for existence first.
        let t = project(&items(), "T");
        for f in ["status", "title", "body", "acceptance", "labels", "dependsOn"] {
            assert!(t.contains_key(&format!("items/phase-0/{f}")), "missing {f}");
        }
        assert_eq!(t["items/phase-0/acceptance"], "");
        assert_eq!(t["items/phase-0/labels"], "");
    }

    #[test]
    fn status_and_title_read_cleanly() {
        let t = project(&items(), "T");
        assert_eq!(t["items/phase-1-linux-host/status"], "open\n");
        assert_eq!(t["items/phase-1-linux-host/title"], "Delete the Windows tax\n");
    }

    #[test]
    fn acceptance_is_one_criterion_per_line() {
        let t = project(&items(), "T");
        assert_eq!(
            t["items/phase-1-linux-host/acceptance"],
            "gate is green\nno cfg(windows) remains\n"
        );
    }

    #[test]
    fn by_status_answers_what_is_available_without_a_query_language() {
        let t = project(&items(), "T");
        assert_eq!(
            t["by-status/open/phase-1-linux-host"],
            "Delete the Windows tax\n"
        );
        assert_eq!(t["by-status/complete/phase-0"], "Price the port\n");
        assert!(!t.contains_key("by-status/open/phase-0"));
    }

    #[test]
    fn paths_use_forward_slashes_on_every_host() {
        // These are GUEST paths in a Linux namespace. PathBuf would render with the host
        // separator, which is how Path::is_absolute() silently broke bsc-sandbox on Windows.
        let t = project(&items(), "T");
        assert!(t.keys().all(|k| !k.contains('\\')), "a key used a host separator");
        assert!(t.contains_key("items/phase-0/status"));
    }

    #[test]
    fn readme_states_the_staleness_where_a_reader_meets_it() {
        let t = project(&items(), "2026-08-20T00:00:00Z");
        let r = &t["README"];
        assert!(r.contains("SNAPSHOT, NOT A LIVE VIEW"));
        assert!(r.contains("2026-08-20T00:00:00Z"));
        assert!(r.contains("2 item(s)"));
    }

    #[test]
    fn a_ref_cannot_escape_its_directory() {
        let mut v = items();
        v.push(PlanItem { reference: "../../etc/passwd".into(), ..Default::default() });
        v.push(PlanItem { reference: ".hidden".into(), ..Default::default() });
        let t = project(&v, "T");
        assert!(t.keys().all(|k| !k.contains("..")), "a ref escaped its directory");
        assert!(t.keys().all(|k| !k.contains(".hidden")));
    }

    #[test]
    fn output_is_deterministic() {
        // A projection that reordered between runs would make any diff of it useless.
        assert_eq!(project(&items(), "T"), project(&items(), "T"));
    }

    #[test]
    fn parses_the_json_bsc_plan_emits() {
        let json = r#"[{"ref":"a","title":"A","status":"open","body":"b",
                        "acceptance":["x"],"labels":[],"dependsOn":[]}]"#;
        let v = from_json(json).unwrap();
        assert_eq!(v[0].reference, "a");
        assert_eq!(v[0].acceptance, vec!["x".to_string()]);
    }

    #[test]
    fn missing_optional_fields_are_tolerated() {
        // bsc omits empty arrays in some shapes; a projection must not fail on that.
        let v = from_json(r#"[{"ref":"a"}]"#).unwrap();
        assert_eq!(v[0].reference, "a");
        assert!(v[0].acceptance.is_empty());
    }
}
