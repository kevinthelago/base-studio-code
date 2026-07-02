//! The pure TSV/text renderers behind the `bsc plan` reads (split out of `cli.rs`, #2068). Every
//! function here is a total, side-effect-free formatter — it takes a plan value and returns the exact
//! bytes a command prints. Keeping them together (away from the DB-opening dispatch) makes both the
//! renderers and their unit tests easy to reason about; the output is byte-for-byte what `cli.rs`
//! emitted before the split.

use crate::{IssueSummary, PlanIssue, STATUSES};

/// Sanitize one cell for TSV output: collapse the delimiters (tab / newline / CR) to a single space
/// so a free-text title or body can't break the one-row-per-issue table.
fn tsv(s: &str) -> String {
    s.replace(['\t', '\n', '\r'], " ")
}

/// Render a phase JSON value (a 1-based number, or a name string) to a bare cell.
fn phase_str(p: &Option<serde_json::Value>) -> String {
    match p {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(v) => v.to_string().trim_matches('"').to_string(),
        None => String::new(),
    }
}

/// The lean default for `list`/`mine`: a header row + one tab-separated row per issue. Title is last
/// (it's the free-text column) and every cell is delimiter-sanitized. Value-lists show as counts;
/// the full detail is one `get <ref>` away.
pub(crate) fn render_summary_tsv(rows: &[IssueSummary]) -> String {
    let mut out = String::from("ref\tstatus\tstream\tphase\tacc\towns\tdeps\ttitle\n");
    for r in rows {
        out.push_str(&format!(
            "{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}\n",
            tsv(&r.r#ref),
            tsv(&r.status),
            tsv(r.stream.as_deref().unwrap_or("")),
            tsv(&phase_str(&r.phase)),
            r.acceptance,
            r.owns,
            r.depends_on,
            tsv(&r.title),
        ));
    }
    out
}

/// `list --fields ref,title,status` → TSV of just the named columns (header + rows). Unknown names
/// render as a blank column (a typo is visible, not fatal); `body` is reachable here when explicitly asked.
pub(crate) fn render_fields_tsv(issues: &[PlanIssue], spec: &str) -> String {
    let cols: Vec<&str> = spec.split(',').map(|c| c.trim()).filter(|c| !c.is_empty()).collect();
    let mut out = String::new();
    out.push_str(&cols.join("\t"));
    out.push('\n');
    for i in issues {
        let row: Vec<String> = cols.iter().map(|c| tsv(&issue_field(i, c))).collect();
        out.push_str(&row.join("\t"));
        out.push('\n');
    }
    out
}

/// Resolve one named field of a {@link PlanIssue} to a string cell (for `--fields`). Counts stay full
/// here — `--fields` is an explicit projection, so the caller gets exactly what they named.
fn issue_field(i: &PlanIssue, field: &str) -> String {
    match field {
        "ref" => i.r#ref.clone(),
        "title" => i.title.clone(),
        "status" => i.status.clone(),
        "stream" => i.stream.clone().unwrap_or_default(),
        "repo" => i.repo.clone().unwrap_or_default(),
        "parent" => i.parent.clone().unwrap_or_default(),
        "phase" => phase_str(&i.phase),
        "acceptance" => i.acceptance.join(" | "),
        "owns" => i.owns.join(", "),
        "dependsOn" | "depends_on" | "deps" => i.depends_on.join(", "),
        "labels" => i.labels.join(", "),
        "body" => i.body.clone().unwrap_or_default(),
        _ => String::new(),
    }
}

/// The aggregated plan overview behind the `summary` verb — computed once, rendered as text or JSON.
pub(crate) struct PlanOverview {
    total: usize,
    /// Per-status counts, canonical {@link STATUSES} order, non-zero only.
    status: Vec<(String, usize)>,
    /// Per-stream counts, first-seen order.
    streams: Vec<(String, usize)>,
}

/// Tally a lean issue set into a {@link PlanOverview}.
pub(crate) fn compute_overview(rows: &[IssueSummary]) -> PlanOverview {
    let status: Vec<(String, usize)> = STATUSES
        .iter()
        .filter_map(|st| {
            let n = rows.iter().filter(|r| r.status == *st).count();
            (n > 0).then(|| ((*st).to_string(), n))
        })
        .collect();

    let mut stream_order: Vec<String> = Vec::new();
    let mut stream_count: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for r in rows {
        if let Some(s) = &r.stream {
            if !stream_count.contains_key(s) {
                stream_order.push(s.clone());
            }
            *stream_count.entry(s.clone()).or_default() += 1;
        }
    }
    let streams: Vec<(String, usize)> = stream_order.into_iter().map(|s| {
        let n = stream_count[&s];
        (s, n)
    }).collect();

    PlanOverview { total: rows.len(), status, streams }
}

/// Render the overview as compact lines (totals · streams).
pub(crate) fn render_overview_text(o: &PlanOverview) -> String {
    let mut out = format!("{} issue{}", o.total, if o.total == 1 { "" } else { "s" });
    for (st, n) in &o.status {
        out.push_str(&format!(" · {st} {n}"));
    }
    out.push('\n');
    if !o.streams.is_empty() {
        let parts: Vec<String> = o.streams.iter().map(|(s, n)| format!("{s} {n}")).collect();
        out.push_str(&format!("stream: {}\n", parts.join(" · ")));
    }
    out
}

/// Render the overview as a structured object (for `summary --json`).
pub(crate) fn overview_json(o: &PlanOverview) -> serde_json::Value {
    let status: serde_json::Map<String, serde_json::Value> =
        o.status.iter().map(|(s, n)| (s.clone(), serde_json::json!(n))).collect();
    let streams: serde_json::Map<String, serde_json::Value> =
        o.streams.iter().map(|(s, n)| (s.clone(), serde_json::json!(n))).collect();
    serde_json::json!({ "total": o.total, "status": status, "streams": streams })
}

/// The full human-readable spec of one issue (for `get`).
pub(crate) fn render_issue(i: &PlanIssue) -> String {
    let mut out = format!("{}  [{}]  {}\n", i.r#ref, i.status, i.title);
    let mut meta: Vec<String> = Vec::new();
    if let Some(p) = &i.phase {
        meta.push(format!("phase: {}", p.to_string().trim_matches('"')));
    }
    if let Some(s) = &i.stream {
        meta.push(format!("stream: {s}"));
    }
    if let Some(r) = &i.repo {
        meta.push(format!("repo: {r}"));
    }
    if let Some(p) = &i.parent {
        meta.push(format!("parent: {p}"));
    }
    if !meta.is_empty() {
        out.push_str(&format!("  {}\n", meta.join("   ")));
    }
    if !i.owns.is_empty() {
        out.push_str(&format!("  owns: {}\n", i.owns.join(", ")));
    }
    if !i.depends_on.is_empty() {
        out.push_str(&format!("  depends on: {}\n", i.depends_on.join(", ")));
    }
    if !i.labels.is_empty() {
        out.push_str(&format!("  labels: {}\n", i.labels.join(", ")));
    }
    if !i.acceptance.is_empty() {
        out.push_str("  acceptance:\n");
        for a in &i.acceptance {
            out.push_str(&format!("    - {a}\n"));
        }
    }
    if let Some(b) = &i.body {
        if !b.trim().is_empty() {
            out.push('\n');
            for line in b.lines() {
                out.push_str(&format!("  {line}\n"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Store;

    fn summary(r: &str, stream: Option<&str>, phase: Option<serde_json::Value>, acc: usize) -> IssueSummary {
        IssueSummary {
            r#ref: r.into(), title: r.into(), status: "open".into(),
            stream: stream.map(Into::into), phase, acceptance: acc, owns: 0, depends_on: 0,
        }
    }

    #[test]
    fn summary_tsv_has_header_and_one_row_per_issue_title_last() {
        let rows = vec![summary("F1", Some("auth"), Some(serde_json::json!(2)), 3)];
        let out = render_summary_tsv(&rows);
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "ref\tstatus\tstream\tphase\tacc\towns\tdeps\ttitle");
        let cells: Vec<&str> = lines[1].split('\t').collect();
        assert_eq!(cells[0], "F1");
        assert_eq!(cells[2], "auth");
        assert_eq!(cells[3], "2");
        assert_eq!(cells[4], "3"); // acceptance count
        assert_eq!(cells.last(), Some(&"F1")); // title is the last column
        assert_eq!(cells.len(), 8);
    }

    #[test]
    fn summary_tsv_sanitizes_delimiters_in_title() {
        let mut row = summary("F1", None, None, 0);
        row.title = "has\ta tab\nand newline".into();
        let out = render_summary_tsv(&row_slice(&row));
        // exactly two lines (header + one row) — the embedded tab/newline must NOT split the table
        assert_eq!(out.lines().count(), 2);
        let cells: Vec<&str> = out.lines().nth(1).unwrap().split('\t').collect();
        assert_eq!(cells.len(), 8);
        assert_eq!(cells[7], "has a tab and newline");
    }

    fn row_slice(r: &IssueSummary) -> Vec<IssueSummary> {
        vec![r.clone()]
    }

    #[test]
    fn fields_projection_emits_only_named_columns_unknown_is_blank() {
        let issues = vec![PlanIssue {
            r#ref: "F1".into(), title: "Login".into(), status: "open".into(),
            owns: vec!["src/a".into(), "src/b".into()], ..Default::default()
        }];
        let out = render_fields_tsv(&issues, "ref,owns,nope");
        let lines: Vec<&str> = out.lines().collect();
        assert_eq!(lines[0], "ref\towns\tnope");
        let cells: Vec<&str> = lines[1].split('\t').collect();
        assert_eq!(cells[0], "F1");
        assert_eq!(cells[1], "src/a, src/b");
        assert_eq!(cells[2], ""); // unknown field → blank column, not an error
    }

    #[test]
    fn overview_counts_by_status_and_stream() {
        let rows = vec![
            summary("F1", Some("auth"), Some(serde_json::json!(1)), 0),
            summary("F2", Some("auth"), Some(serde_json::json!(2)), 0),
            summary("F3", Some("ui"), Some(serde_json::json!("Core")), 0),
        ];
        let o = compute_overview(&rows);
        assert_eq!(o.total, 3);
        assert_eq!(o.status, vec![("open".to_string(), 3)]);
        assert_eq!(o.streams, vec![("auth".to_string(), 2), ("ui".to_string(), 1)]);

        let text = render_overview_text(&o);
        assert!(text.starts_with("3 issues · open 3"));
        assert!(text.contains("stream: auth 2 · ui 1"));

        let json = overview_json(&o);
        assert_eq!(json["total"], serde_json::json!(3));
        assert_eq!(json["status"]["open"], serde_json::json!(3));
        assert_eq!(json["streams"]["auth"], serde_json::json!(2));
    }

    #[test]
    fn phase_str_renders_number_and_name() {
        assert_eq!(phase_str(&Some(serde_json::json!(3))), "3");
        assert_eq!(phase_str(&Some(serde_json::json!("auth"))), "auth");
        assert_eq!(phase_str(&None), "");
    }

    #[test]
    fn list_dispatch_lean_vs_full_against_a_real_db() {
        // End-to-end through the Store: lean omits body, full keeps it.
        let s = Store::open_in_memory().unwrap();
        s.upsert(&PlanIssue {
            r#ref: "F1".into(), title: "Add login".into(), stream: Some("auth".into()),
            body: Some("BIGBODY".into()), acceptance: vec!["x".into()], ..Default::default()
        }).unwrap();
        // matches what `list` (lean) feeds render_summary_tsv
        let lean = s.list_summary(None, None, None, None).unwrap();
        let tsv = render_summary_tsv(&lean);
        assert!(!tsv.contains("BIGBODY"));
        assert!(tsv.contains("F1"));
        // matches what `list --full` / `--fields body` can reach
        let full = s.list_filtered(None, None, None, None).unwrap();
        assert!(render_fields_tsv(&full, "ref,body").contains("BIGBODY"));
    }
}
