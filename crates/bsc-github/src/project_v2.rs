//! The ProjectV2 (GitHub Projects) GraphQL WALK.
//!
//! Ported from `src/shared/lib/github/projectV2.ts` under
//! `the-github-domains-pure-logic-lives-in-bsc-github`, proved against
//! `src/shared/lib/github/projectV2.fixtures.json`, generated from it.
//!
//! ## Why this is Rust
//!
//! This crate already owns the TRANSPORT that fetches a `projectsV2` payload, and
//! [`crate::board_state`] already owns the rules about the board state we persist from it. The
//! parse in between — which field is Status, which items are real issues — lived only in the
//! renderer, so Rust fetched and stored a structure it could not interpret.
//!
//! ## What is NOT ported, and why that is not a gap
//!
//! The TypeScript `parseProjectV2Items` takes a caller-supplied `mapIssue<C, T>` and each screen
//! passes its own. That callback is PRESENTATION — it builds a screen-specific row — and porting a
//! generic higher-order function would be porting the shape rather than the rule. The rule is WHICH
//! items survive the filter and in what ORDER, which is what [`issue_items`] returns and what the
//! fixture records (as the surviving ids, in order).
//!
//! ## WHICH WAY THIS FAILS
//!
//! Every function fails EMPTY: an absent node, an absent field list, an unparseable item all yield
//! `[]` / `None` rather than an error. That is the safe direction for a BOARD READ — showing no
//! columns is visibly wrong and self-correcting on the next fetch, whereas erroring out would take
//! down a screen over one malformed item in a payload GitHub controls. It is the OPPOSITE of the
//! choice [`crate::repo_credentials`] makes, and deliberately so: that one is a credential boundary
//! where an empty answer would be a security decision, this one is a view.

use serde::{Deserialize, Serialize};

/// A single-select option — the Status column values, in BOARD ORDER.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatusOption {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// A ProjectV2 item field-value node; only single-select (Status) values are read.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldValue {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub option_id: Option<String>,
    /// Absent on a field-value that is not a single-select — skipped, never an error.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub field: Option<FieldRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldRef {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct FieldValues {
    #[serde(default)]
    pub nodes: Vec<FieldValue>,
}

/// A ProjectV2 item. `content` is the underlying Issue/PR, and `None` for a DRAFT item.
///
/// `rename_all` IS LOad-BEARING and its absence was a live bug the generated fixture caught: the
/// wire key is `fieldValues`, so without it serde found no such field, took `#[serde(default)]`, and
/// handed every caller an EMPTY field-value list. `status_field_value` then returned `None` for
/// every item on every board — a Status column that silently reads as unset rather than failing.
/// Nothing about that is visible from the type, and a hand-written test that constructed an `Item`
/// in Rust would never have seen it, because the bug is only in the DESERIALIZER.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    #[serde(default)]
    pub field_values: FieldValues,
    #[serde(default)]
    pub content: Option<ItemContent>,
}

/// Typed loosely on purpose: each caller narrows it. Only `__typename` is read here.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct ItemContent {
    #[serde(default, rename = "__typename", skip_serializing_if = "Option::is_none")]
    pub typename: Option<String>,
    /// Everything else the caller narrows, kept so a round trip does not lose it.
    #[serde(flatten, default)]
    pub rest: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Field {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// A Status field with NO options must not match — see [`status_options`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<StatusOption>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Fields {
    #[serde(default)]
    pub nodes: Vec<Field>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Items {
    #[serde(default)]
    pub nodes: Vec<Item>,
}

/// The `node` of a `projectsV2` GraphQL response.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Node {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<Fields>,
    #[serde(default)]
    pub items: Items,
}

/// The `__typename` an item's content must carry to be a real issue.
const ISSUE_TYPENAME: &str = "Issue";

/// The Status single-select field's options in BOARD ORDER (empty when there is no Status field).
///
/// BOTH conditions are required: the name is `Status` AND `options` is present. A Status field with
/// no options must not match, or an earlier degenerate field shadows the real one that follows it
/// and the board loses every column. The FIRST field satisfying both wins.
pub fn status_options(node: Option<&Node>) -> Vec<StatusOption> {
    node.and_then(|n| n.fields.as_ref())
        .and_then(|f| {
            f.nodes
                .iter()
                .find(|f| f.name.as_deref() == Some("Status") && f.options.is_some())
                .and_then(|f| f.options.clone())
        })
        .unwrap_or_default()
}

/// An item's Status field-value, if any. The FIRST match wins; a field-value with no `field` is
/// skipped rather than treated as an error.
pub fn status_field_value(item: &Item) -> Option<&FieldValue> {
    item.field_values.nodes.iter().find(|fv| fv.field.as_ref().is_some_and(|f| f.name == "Status"))
}

/// The items whose content is a real `Issue`, in the order the board returned them.
///
/// Skips a DRAFT item (`content: null`) and anything whose `__typename` is not exactly `Issue` — a
/// PullRequest on a board is ordinary, and treating one as an issue would put it in front of an
/// agent as work to do. The comparison is CASE-SENSITIVE, matching the GraphQL type name.
pub fn issue_items(node: Option<&Node>) -> Vec<&Item> {
    let Some(node) = node else { return Vec::new() };
    node.items
        .nodes
        .iter()
        .filter(|it| it.content.as_ref().and_then(|c| c.typename.as_deref()) == Some(ISSUE_TYPENAME))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("projectV2.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one projectV2.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// `null` means "no node at all", which is a distinct case from an empty one.
    fn node_of(v: &Value) -> Option<Node> {
        if v.is_null() {
            None
        } else {
            Some(serde_json::from_value(v.clone()).expect("the fixture node deserializes"))
        }
    }

    #[test]
    fn the_project_v2_walk_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let mut bad: Vec<String> = Vec::new();

        for c in doc["fields"].as_array().expect("fields") {
            let node = node_of(&c["node"]);
            let got = status_options(node.as_ref());
            let want: Vec<StatusOption> =
                serde_json::from_value(c["options"].clone()).expect("options deserialize");
            // WHOLE VALUES IN ORDER — board order is what the columns render from, so a set
            // comparison would call a reordered board identical.
            if got != want {
                bad.push(format!("  fields {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        for c in doc["items"].as_array().expect("items") {
            let node = node_of(&c["node"]);
            let got: Vec<String> = issue_items(node.as_ref()).iter().map(|i| i.id.clone()).collect();
            let want: Vec<String> =
                c["keptIds"].as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect();
            if got != want {
                bad.push(format!("  items {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        for c in doc["status"].as_array().expect("status") {
            let item: Item = serde_json::from_value(c["item"].clone()).expect("item deserializes");
            let got = status_field_value(&item).cloned();
            let want: Option<FieldValue> = if c["value"].is_null() {
                None
            } else {
                Some(serde_json::from_value(c["value"].clone()).expect("value deserializes"))
            };
            if got != want {
                bad.push(format!("  status {:?}: ts {want:?}, rust {got:?}", c["label"]));
            }
        }

        assert!(bad.is_empty(), "the Rust ProjectV2 walk disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// THE SENTINEL. An optionless Status field must not shadow the real one behind it — the failure
    /// is a board that renders with no columns at all, and a corpus of well-formed payloads never
    /// separates the two implementations.
    #[test]
    fn an_optionless_status_field_does_not_shadow_the_real_one() {
        let node = Node {
            fields: Some(Fields {
                nodes: vec![
                    Field { id: Some("f0".into()), name: Some("Status".into()), options: None },
                    Field {
                        id: Some("f1".into()),
                        name: Some("Status".into()),
                        options: Some(vec![StatusOption {
                            id: "o1".into(),
                            name: "Todo".into(),
                            color: "GRAY".into(),
                        }]),
                    },
                ],
            }),
            items: Items::default(),
        };
        let got = status_options(Some(&node));
        assert_eq!(got.len(), 1, "the real Status field must still be found");
        assert_eq!(got[0].name, "Todo");
    }

    /// A PullRequest on a board is ordinary; treating one as an issue would hand an agent work that
    /// is not work. Case matters, because the GraphQL type name is `Issue`.
    #[test]
    fn only_an_exactly_typed_issue_survives_the_filter() {
        let mk = |id: &str, ty: Option<&str>| Item {
            id: id.into(),
            field_values: FieldValues::default(),
            content: ty.map(|t| ItemContent { typename: Some(t.into()), rest: Default::default() }),
        };
        let node = Node {
            fields: None,
            items: Items {
                nodes: vec![
                    mk("draft", None),
                    mk("pr", Some("PullRequest")),
                    mk("lower", Some("issue")),
                    mk("real", Some("Issue")),
                ],
            },
        };
        let kept: Vec<&str> = issue_items(Some(&node)).iter().map(|i| i.id.as_str()).collect();
        assert_eq!(kept, vec!["real"]);
    }

    /// Fails EMPTY rather than erroring — the safe direction for a view.
    #[test]
    fn an_absent_node_yields_empty_rather_than_an_error() {
        assert!(status_options(None).is_empty());
        assert!(issue_items(None).is_empty());
    }
}
