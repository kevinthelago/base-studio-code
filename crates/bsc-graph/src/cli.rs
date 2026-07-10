//! `bsc graph` (#2761) — query the Algorithms knowledge graph from a live session. Read-only JSON out
//! (compact by default; `--pretty` indents), so an agent can enumerate concepts, walk a node's
//! relationships, or find the path between two ideas "when required".

use serde_json::Value;

pub fn run(args: Vec<String>, prog: &str) -> Result<(), String> {
    let pretty = args.iter().any(|a| a == "--pretty");
    let positional: Vec<&str> = args.iter().filter(|a| !a.starts_with("--")).map(String::as_str).collect();
    let verb = positional.first().copied().unwrap_or("list");
    let emit = |v: &Value| -> Result<(), String> {
        let s = if pretty { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) };
        println!("{}", s.map_err(|e| e.to_string())?);
        Ok(())
    };
    match verb {
        // `list [--kind K]` — every node, or one kind's column.
        "list" => {
            let kind = flag_value(&args, "--kind");
            let nodes: Vec<Value> = crate::nodes()
                .into_iter()
                .filter(|n| match &kind {
                    Some(k) => n.get("kind").and_then(Value::as_str) == Some(k.as_str()),
                    None => true,
                })
                .collect();
            emit(&Value::Array(nodes))
        }
        // `neighbors <id>` — the concept's relationships, each with the other endpoint + direction.
        "neighbors" => {
            let id = positional.get(1).ok_or("usage: bsc graph neighbors <id>")?;
            if crate::node(id).is_none() {
                return Err(format!("unknown node '{id}'"));
            }
            emit(&serde_json::json!({ "id": id, "neighbors": crate::neighbors(id) }))
        }
        // `path <a> <b>` — the shortest relationship chain between two concepts (or null).
        "path" => {
            let a = positional.get(1).ok_or("usage: bsc graph path <a> <b>")?;
            let b = positional.get(2).ok_or("usage: bsc graph path <a> <b>")?;
            emit(&serde_json::json!({ "from": a, "to": b, "path": crate::path(a, b) }))
        }
        "help" | "-h" | "--help" => {
            print!("{}", help(prog));
            Ok(())
        }
        other => Err(format!("unknown graph command '{other}' — want: list | neighbors <id> | path <a> <b>\n\n{}", help(prog))),
    }
}

/// The value following a `--flag`, if present.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the Algorithms knowledge graph (#2761)\n\n\
         USAGE:\n  \
         {prog} list [--kind K] [--pretty]   # every concept, or one kind's column\n  \
         {prog} neighbors <id> [--pretty]    # a concept's relationships (rel + direction + other node)\n  \
         {prog} path <a> <b> [--pretty]      # shortest relationship chain between two concepts\n\n\
         Node kinds: data-structure · algorithm · concept · output.\n\
         Relationships: operates-on · composes · variant-of · generates · related-to.\n\
         The graph is the curated ontology (Graph 1); Phase 2 (#2745) adds the extracted-code join.\n",
    )
}
