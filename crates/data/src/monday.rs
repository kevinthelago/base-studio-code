//! Read-only monday.com connector (native first-party, #1197).
//!
//! monday.com speaks a single GraphQL endpoint (`https://api.monday.com/v2`). The transport
//! is injected as a closure (GraphQL query → parsed JSON) so tests replay fixtures with no
//! network; production captures the API token in the closure — the connector never stores or
//! logs it (#782 / #1194).
//!
//! - **Data:** boards → objects, columns → fields, items → rows.
//! - **Behavior:** a board's **status columns** encode its workflow stages, captured as
//!   [`BusinessProcess`] steps. (monday's automation *recipes* are not enumerable through the
//!   public read API, so they are out of scope for the scan — the status-driven process is the
//!   behavior monday actually exposes.)

use serde_json::Value;

use crate::behavior::{BusinessProcess, PlatformScan};
use crate::connector::{json_id_as_string, Connector, FetchFn, RowSet, SourceObject};
use crate::{DataError, Result};

/// Read-only monday.com connector.
///
/// Credentials are owned exclusively by the `fetch` closure supplied at construction; the
/// connector struct never stores, logs, or persists the API token (#782).
pub struct MondayConnector {
    name: String,
    fetch: FetchFn,
}

impl MondayConnector {
    /// Build a connector backed by a caller-supplied GraphQL fetch closure.
    ///
    /// `fetch` receives a GraphQL query string and must return the parsed JSON response body
    /// (including the `data` envelope). Any authentication (API token) must be captured by the
    /// closure — the connector never stores or logs credentials.
    pub fn new(
        name: impl Into<String>,
        fetch: impl Fn(&str) -> Result<Value> + Send + Sync + 'static,
    ) -> Self {
        MondayConnector { name: name.into(), fetch: Box::new(fetch) }
    }

    /// POST a GraphQL query, returning the parsed response body.
    fn query(&self, gql: &str) -> Result<Value> {
        (self.fetch)(gql)
    }

    /// All boards with their columns.
    fn boards(&self) -> Result<Vec<Value>> {
        let body = self.query(
            "query { boards(limit: 100) { id name columns { id title type settings_str } } }",
        )?;
        Ok(body["data"]["boards"].as_array().cloned().unwrap_or_default())
    }

    fn board_by_name(&self, name: &str) -> Result<Value> {
        self.boards()?
            .into_iter()
            .find(|b| b["name"].as_str() == Some(name))
            .ok_or_else(|| DataError::Schema(format!("monday: board '{name}' not found")))
    }
}

/// `(column id, column title)` pairs for a board, keeping only columns that carry both.
fn column_pairs(board: &Value) -> Vec<(String, String)> {
    board["columns"]
        .as_array()
        .map(|cols| {
            cols.iter()
                .filter_map(|c| Some((c["id"].as_str()?.to_string(), c["title"].as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn board_id(board: &Value) -> Result<String> {
    json_id_as_string(&board["id"])
        .ok_or_else(|| DataError::Schema("monday: board missing id".into()))
}

impl Connector for MondayConnector {
    fn name(&self) -> &str {
        &self.name
    }

    fn objects(&self) -> Result<Vec<SourceObject>> {
        Ok(self
            .boards()?
            .iter()
            .filter_map(|b| {
                let name = b["name"].as_str()?.to_string();
                let columns = column_pairs(b).into_iter().map(|(_, title)| title).collect();
                Some(SourceObject { name, columns })
            })
            .collect())
    }

    fn read(&self, object: &str) -> Result<RowSet> {
        let board = self.board_by_name(object)?;
        let id = board_id(&board)?;
        let pairs = column_pairs(&board);

        // The built-in item title ("name") leads, then the board's columns in order.
        let mut columns = vec!["name".to_string()];
        columns.extend(pairs.iter().map(|(_, title)| title.clone()));

        let body = self.query(&format!(
            "query {{ boards(ids: [{id}]) {{ items_page(limit: 200) {{ items {{ name column_values {{ id text }} }} }} }} }}"
        ))?;
        let items = body["data"]["boards"][0]["items_page"]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();

        let rows = items
            .iter()
            .map(|it| {
                let mut row = vec![it["name"].as_str().unwrap_or("").to_string()];
                let cvs = it["column_values"].as_array().cloned().unwrap_or_default();
                for (cid, _) in &pairs {
                    let text = cvs
                        .iter()
                        .find(|cv| cv["id"].as_str() == Some(cid.as_str()))
                        .and_then(|cv| cv["text"].as_str())
                        .unwrap_or("")
                        .to_string();
                    row.push(text);
                }
                row
            })
            .collect();

        Ok(RowSet { columns, rows })
    }

    /// Capture each board's status-column workflows as business processes.
    fn scan_platform(&self) -> Result<PlatformScan> {
        let mut processes = Vec::new();
        for board in self.boards()? {
            let board_name = board["name"].as_str().unwrap_or("").to_string();
            for col in board["columns"].as_array().cloned().unwrap_or_default() {
                if col["type"].as_str() != Some("status") {
                    continue;
                }
                let title = col["title"].as_str().unwrap_or("").to_string();
                let steps = status_labels(col["settings_str"].as_str().unwrap_or(""));
                if steps.is_empty() {
                    continue;
                }
                processes.push(BusinessProcess {
                    source: self.name.clone(),
                    name: format!("{board_name} · {title}"),
                    object: board_name.clone(),
                    active: true,
                    steps,
                });
            }
        }
        Ok(PlatformScan { business_processes: processes, ..Default::default() })
    }
}

/// Parse a status column's `settings_str` (a JSON string) into ordered stage labels.
/// Status settings look like `{"labels":{"0":"Working on it","1":"Done","2":"Stuck"}}`.
fn status_labels(settings_str: &str) -> Vec<String> {
    let parsed: Value = match serde_json::from_str(settings_str) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    match &parsed["labels"] {
        Value::Object(map) => {
            let mut entries: Vec<(i64, String)> = map
                .iter()
                .filter_map(|(k, v)| Some((k.parse::<i64>().ok()?, v.as_str()?.to_string())))
                .collect();
            entries.sort_by_key(|(i, _)| *i);
            entries.into_iter().map(|(_, v)| v).collect()
        }
        _ => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    const BOARDS: &str = r#"{ "data": { "boards": [
        {"id": "101", "name": "Projects", "columns": [
            {"id": "status", "title": "Status", "type": "status",
             "settings_str": "{\"labels\":{\"0\":\"Working on it\",\"1\":\"Done\",\"2\":\"Stuck\"}}"},
            {"id": "owner",  "title": "Owner",  "type": "people", "settings_str": "{}"},
            {"id": "due",    "title": "Due",    "type": "date",   "settings_str": "{}"}
        ]},
        {"id": "102", "name": "Tickets", "columns": [
            {"id": "prio", "title": "Priority", "type": "status",
             "settings_str": "{\"labels\":{\"0\":\"Low\",\"1\":\"High\"}}"}
        ]}
    ] } }"#;

    const ITEMS: &str = r#"{ "data": { "boards": [ { "items_page": { "items": [
        {"name": "Build login", "column_values": [
            {"id": "status", "text": "Working on it"},
            {"id": "owner",  "text": "Kai"},
            {"id": "due",    "text": "2026-07-01"}
        ]},
        {"name": "Ship export", "column_values": [
            {"id": "status", "text": "Done"},
            {"id": "owner",  "text": ""},
            {"id": "due",    "text": "2026-07-09"}
        ]}
    ] } } ] } }"#;

    fn fixture_connector() -> MondayConnector {
        MondayConnector::new("acme-monday", move |gql| {
            // The items query is the only one mentioning items_page; everything else lists boards.
            let body = if gql.contains("items_page") { ITEMS } else { BOARDS };
            Ok(serde_json::from_str(body).unwrap())
        })
    }

    #[test]
    fn objects_lists_boards_with_column_titles() {
        let c = fixture_connector();
        let objs = c.objects().unwrap();
        let names: Vec<&str> = objs.iter().map(|o| o.name.as_str()).collect();
        assert!(names.contains(&"Projects"));
        assert!(names.contains(&"Tickets"));
        let projects = objs.iter().find(|o| o.name == "Projects").unwrap();
        assert_eq!(projects.columns, vec!["Status", "Owner", "Due"]);
    }

    #[test]
    fn read_maps_items_to_rows_by_column() {
        let c = fixture_connector();
        let rs = c.read("Projects").unwrap();
        assert_eq!(rs.columns, vec!["name", "Status", "Owner", "Due"]);
        assert_eq!(rs.rows.len(), 2);
        assert_eq!(rs.rows[0], vec!["Build login", "Working on it", "Kai", "2026-07-01"]);
        // Empty owner preserved as an empty cell.
        assert_eq!(rs.rows[1], vec!["Ship export", "Done", "", "2026-07-09"]);
    }

    #[test]
    fn scan_captures_status_columns_as_business_processes() {
        let c = fixture_connector();
        let scan = c.scan_platform().unwrap();

        // One process per status column across both boards.
        assert_eq!(scan.business_processes.len(), 2);
        let proj = scan
            .business_processes
            .iter()
            .find(|p| p.name == "Projects · Status")
            .unwrap();
        assert_eq!(proj.object, "Projects");
        assert_eq!(proj.source, "acme-monday");
        assert_eq!(proj.steps, vec!["Working on it", "Done", "Stuck"]);

        // monday's automation recipes aren't exposed by the read API — those stay empty.
        assert!(scan.automations.is_empty());
        assert!(scan.derived_logic.is_empty());
    }

    #[test]
    fn api_token_not_stored_or_leaked_into_queries() {
        let token = "MONDAY_SECRET_TOKEN_123";
        let seen: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(vec![]));
        let seen2 = seen.clone();
        let c = MondayConnector::new("sec", move |gql| {
            seen2.lock().unwrap().push(gql.to_string());
            Ok(serde_json::from_str(BOARDS).unwrap())
        });
        let _ = c.objects();
        assert!(!c.name.contains(token));
        for q in seen.lock().unwrap().iter() {
            assert!(!q.contains(token), "token leaked into query: {q}");
        }
    }
}
