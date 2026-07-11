//! `bsc graph` (#2761/#2853) — query AND curate the Algorithms knowledge graph from a live session.
//! JSON out (compact by default; `--pretty` indents). READ: enumerate concepts, walk a node's
//! relationships, find the path between two ideas, `dump` the whole graph. WRITE (#2853): the knowledge
//! librarian upserts nodes (`set`), wires relationships (`link`/`unlink`), and removes nodes (`remove`)
//! — persisted to the on-disk store (`~/.base-studio-code/knowledge/algorithms.json`), so a read after
//! a write reflects it.

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
        // `list [--kind K] [--tech T]` — every node, one kind's column, and/or only concepts that
        // carry an implementation in tech T (#2770).
        "list" => {
            let kind = flag_value(&args, "--kind");
            let tech = flag_value(&args, "--tech");
            let nodes: Vec<Value> = crate::nodes()
                .into_iter()
                .filter(|n| match &kind {
                    Some(k) => n.get("kind").and_then(Value::as_str) == Some(k.as_str()),
                    None => true,
                })
                .filter(|n| match &tech {
                    Some(t) => {
                        let id = n.get("id").and_then(Value::as_str).unwrap_or_default();
                        crate::techs_with_impl(id).iter().any(|x| x == t)
                    }
                    None => true,
                })
                .collect();
            emit(&Value::Array(nodes))
        }
        // `impl <concept> --tech <t>` — the concept's implementation in a tech (#2770), or null.
        "impl" => {
            let concept = positional.get(1).ok_or("usage: bsc graph impl <concept> --tech <t>")?;
            let tech = flag_value(&args, "--tech").ok_or("usage: bsc graph impl <concept> --tech <t>")?;
            let found = crate::implementation(concept, &tech).unwrap_or(Value::Null);
            emit(&found)
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
        // `extract <dir> [--tech typescript|rust]` — parse real code (#2775, Phase 2), extract
        // function definitions, and map each onto a seed concept. `matched` = fns with a concept,
        // `unmatched` = fns without, `duplicates` = concepts implemented at more than one site,
        // `calls` = concept→concept call edges lifted from real code (#2779).
        "extract" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph extract <dir> [--tech typescript|rust]")?;
            let tech = flag_value(&args, "--tech");
            let fns: Vec<crate::extract::ExtractedFn> = crate::extract::extract_dir(std::path::Path::new(dir))
                .into_iter()
                .filter(|f| tech.as_deref().is_none_or(|t| f.tech == t))
                .collect();
            let matched: Vec<Value> = fns
                .iter()
                .filter(|f| f.concept.is_some())
                .map(|f| serde_json::json!({ "concept": f.concept, "tech": f.tech, "name": f.name, "file": f.file, "line": f.line }))
                .collect();
            let unmatched: Vec<Value> = fns
                .iter()
                .filter(|f| f.concept.is_none())
                .map(|f| serde_json::json!({ "name": f.name, "tech": f.tech, "file": f.file, "line": f.line }))
                .collect();
            let duplicates: Vec<Value> = crate::extract::dedup(&fns)
                .into_iter()
                .map(|(concept, sites)| {
                    let sites: Vec<Value> = sites
                        .iter()
                        .map(|s| serde_json::json!({ "tech": s.tech, "file": s.file, "line": s.line }))
                        .collect();
                    serde_json::json!({ "concept": concept, "count": sites.len(), "sites": sites })
                })
                .collect();
            // Concept→concept call edges lifted from real code (#2779) — a caller function that maps
            // onto a concept invoking a callee that maps onto a concept. Tech-filtered like the fns.
            let calls: Vec<Value> = crate::extract::extract_calls(std::path::Path::new(dir))
                .into_iter()
                .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                .map(|c| serde_json::json!({ "from": c.from, "to": c.to, "tech": c.tech }))
                .collect();
            emit(&serde_json::json!({ "matched": matched, "unmatched": unmatched, "duplicates": duplicates, "calls": calls }))
        }
        // ── curate the graph (#2853) — load → mutate → save; a read after reflects the write ──
        // `set --id <id> --kind <k> --name <n> [--summary <s>] [--tags a,b] [--complexity <c>]` — upsert a node.
        "set" => {
            let id = flag_value(&args, "--id")
                .ok_or("usage: bsc graph set --id <id> --kind <data-structure|algorithm|concept|output> --name <name> [--summary <s>] [--tags a,b] [--complexity <c>]")?;
            let kind = flag_value(&args, "--kind").ok_or("usage: bsc graph set … --kind data-structure|algorithm|concept|output")?;
            let name = flag_value(&args, "--name").ok_or("usage: bsc graph set … --name <name>")?;
            let mut node = serde_json::json!({ "id": id, "kind": kind, "name": name });
            if let Some(s) = flag_value(&args, "--summary") { node["summary"] = Value::String(s); }
            if let Some(c) = flag_value(&args, "--complexity") { node["complexity"] = Value::String(c); }
            if let Some(t) = flag_value(&args, "--tags") {
                let tags: Vec<Value> = t.split(',').map(str::trim).filter(|x| !x.is_empty()).map(|x| Value::String(x.to_string())).collect();
                node["tags"] = Value::Array(tags);
            }
            let mut g = crate::load();
            let replaced = crate::set_node(&mut g, node.clone())?;
            crate::save(&g)?;
            emit(&serde_json::json!({ "ok": true, "action": if replaced { "updated" } else { "created" }, "node": node }))
        }
        // `link <from> <to> --rel <rel>` — add a relationship edge (endpoints must exist).
        "link" => {
            let from = positional.get(1).ok_or("usage: bsc graph link <from> <to> --rel <operates-on|composes|variant-of|generates|related-to>")?;
            let to = positional.get(2).ok_or("usage: bsc graph link <from> <to> --rel <rel>")?;
            let rel = flag_value(&args, "--rel").ok_or("usage: bsc graph link <from> <to> --rel <operates-on|composes|variant-of|generates|related-to>")?;
            let mut g = crate::load();
            let added = crate::link(&mut g, from, to, &rel)?;
            crate::save(&g)?;
            emit(&serde_json::json!({ "ok": true, "action": if added { "linked" } else { "exists" }, "edge": { "from": from, "to": to, "rel": rel } }))
        }
        // `unlink <from> <to> [--rel <rel>]` — remove matching edges (all rels when --rel is omitted).
        "unlink" => {
            let from = positional.get(1).ok_or("usage: bsc graph unlink <from> <to> [--rel <rel>]")?;
            let to = positional.get(2).ok_or("usage: bsc graph unlink <from> <to> [--rel <rel>]")?;
            let rel = flag_value(&args, "--rel");
            let mut g = crate::load();
            let removed = crate::unlink(&mut g, from, to, rel.as_deref());
            crate::save(&g)?;
            emit(&serde_json::json!({ "ok": true, "removed": removed, "from": from, "to": to, "rel": rel }))
        }
        // `remove <id>` — delete a node + every edge/implementation referencing it.
        "remove" => {
            let id = positional.get(1).ok_or("usage: bsc graph remove <id>")?;
            let mut g = crate::load();
            match crate::remove_node(&mut g, id) {
                Some((edges, impls)) => {
                    crate::save(&g)?;
                    emit(&serde_json::json!({ "ok": true, "removed": id, "edges_removed": edges, "impls_removed": impls }))
                }
                None => Err(format!("unknown node '{id}'")),
            }
        }
        // `dump` — the whole graph document (nodes + edges + implementations), store-or-seed.
        "dump" => emit(&crate::load()),
        "help" | "-h" | "--help" => {
            print!("{}", help(prog));
            Ok(())
        }
        other => Err(format!("unknown graph command '{other}' — read: list | neighbors <id> | path <a> <b> | impl <concept> --tech <t> | dump | extract <dir>; write: set | link | unlink | remove\n\n{}", help(prog))),
    }
}

/// The value following a `--flag`, if present.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the Algorithms knowledge graph (#2761/#2853)\n\n\
         READ:\n  \
         {prog} list [--kind K] [--tech T] [--pretty]   # every concept; filter by kind and/or a tech that implements it\n  \
         {prog} neighbors <id> [--pretty]               # a concept's relationships (rel + direction + other node)\n  \
         {prog} path <a> <b> [--pretty]                 # shortest relationship chain between two concepts\n  \
         {prog} impl <concept> --tech <t> [--pretty]    # the concept's per-tech implementation (#2770), or null\n  \
         {prog} dump [--pretty]                         # the whole graph document (nodes + edges + implementations)\n  \
         {prog} extract <dir> [--tech T] [--pretty]     # parse real code (#2775): matched/unmatched fns + concept duplicates + call edges (#2779)\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} set --id <id> --kind <kind> --name <name> [--summary <s>] [--tags a,b] [--complexity <c>]   # upsert a node\n  \
         {prog} link <from> <to> --rel <rel>            # add a relationship edge (both nodes must exist)\n  \
         {prog} unlink <from> <to> [--rel <rel>]        # remove matching edges (all rels when --rel omitted)\n  \
         {prog} remove <id>                             # delete a node + every edge/implementation referencing it\n\n\
         Node kinds: data-structure · algorithm · concept · output.\n\
         Relationships: operates-on · composes · variant-of · generates · related-to.\n\
         Implementation techs (#2770): typescript · rust — each `implements` a concept and `composes` other same-tech impls.\n\
         The graph is the curated ontology (Graph 1) + the per-tech implementation tier; Phase 2 (#2745/#2775) adds the extracted-from-code `implements` join.\n",
    )
}
