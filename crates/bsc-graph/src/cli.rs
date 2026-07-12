//! `bsc graph` (#2761/#2853) — query AND curate the Algorithms knowledge graph from a live session.
//! JSON out (compact by default; `--pretty` indents). READ: enumerate concepts, walk a node's
//! relationships, find the path between two ideas, `dump` the whole graph. WRITE (#2853): the knowledge
//! librarian upserts nodes (`set`), wires relationships (`link`/`unlink`), removes nodes (`remove`), and
//! curates the per-language kit tier — `impl set`/`impl remove`/`impl list` (#2863): implementations
//! carry a `role` (primitive | algorithm) and, for primitives, may be free-standing (no `concept`).
//! All persisted to the on-disk store (`~/.base-studio-code/knowledge/algorithms.json`), so a read
//! after a write reflects it.

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
        // `impl …` — read a concept's per-tech impl (#2770), OR curate the language-kit tier (#2863):
        //   impl <concept> --tech <t>          # the concept's implementation in a tech, or null
        //   impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> --code <c> [--concept <c>] [--composes a,b] [--pairs x,y] [--summary <s>]
        //   impl remove <id>                   # delete an implementation + scrub it from every composes/pairs
        //   impl list [--tech <t>] [--role r]  # a language kit's implementations
        "impl" => match positional.get(1).copied() {
            Some("set") => {
                let id = flag_value(&args, "--id").ok_or("usage: bsc graph impl set --tech <lang> --id <id> --role primitive|algorithm --name <name> --code <code> [--concept <c>] [--composes a,b] [--pairs x,y] [--summary <s>]")?;
                let tech = flag_value(&args, "--tech").ok_or("usage: bsc graph impl set … --tech <language>")?;
                let role = flag_value(&args, "--role").ok_or("usage: bsc graph impl set … --role primitive|algorithm")?;
                let name = flag_value(&args, "--name").ok_or("usage: bsc graph impl set … --name <name>")?;
                let mut im = serde_json::json!({ "id": id, "tech": tech, "role": role, "name": name, "composes": list_flag(flag_value(&args, "--composes").as_deref()) });
                if let Some(c) = flag_value(&args, "--concept") { im["concept"] = Value::String(c); }
                if let Some(s) = flag_value(&args, "--summary") { im["summary"] = Value::String(s); }
                if let Some(code) = flag_value(&args, "--code") { im["code"] = Value::String(code); }
                if let Some(p) = flag_value(&args, "--pairs") { im["pairs"] = list_flag(Some(&p)); }
                let mut g = crate::load();
                let replaced = crate::set_impl(&mut g, im.clone())?;
                crate::save(&g)?;
                emit(&serde_json::json!({ "ok": true, "action": if replaced { "updated" } else { "created" }, "impl": im }))
            }
            Some("remove") => {
                let id = positional.get(2).ok_or("usage: bsc graph impl remove <id>")?;
                let mut g = crate::load();
                if crate::remove_impl(&mut g, id) {
                    crate::save(&g)?;
                    emit(&serde_json::json!({ "ok": true, "removed": id }))
                } else {
                    Err(format!("unknown implementation '{id}'"))
                }
            }
            Some("list") => {
                let tech = flag_value(&args, "--tech");
                let role = flag_value(&args, "--role");
                let impls: Vec<Value> = crate::implementations()
                    .into_iter()
                    .filter(|im| tech.as_deref().is_none_or(|t| im.get("tech").and_then(Value::as_str) == Some(t)))
                    .filter(|im| role.as_deref().is_none_or(|r| im.get("role").and_then(Value::as_str) == Some(r)))
                    .collect();
                emit(&Value::Array(impls))
            }
            Some(concept) => {
                let tech = flag_value(&args, "--tech").ok_or("usage: bsc graph impl <concept> --tech <t>")?;
                emit(&crate::implementation(concept, &tech).unwrap_or(Value::Null))
            }
            None => Err("usage: bsc graph impl <concept> --tech <t> | impl set … | impl remove <id> | impl list [--tech <t>] [--role r]".to_string()),
        },
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
        // `harvest <dir> [--tech typescript|rust] [--worthy-only]` — the extract-to-harvest feeder
        // (#2745): parse a project's real code and lift each function into a CANDIDATE library
        // implementation (id/name/tech/concept?/role/composes/code), each CLASSIFIED library-worthy vs.
        // project-glue with a score + reasons (#2745 slice 2). `--worthy-only` keeps just the worthy
        // ones. Emits candidates ONLY — storing them into the library is the curation gate, never here.
        "harvest" => {
            let dir = positional
                .get(1)
                .ok_or("usage: bsc graph harvest <dir> [--tech typescript|rust] [--worthy-only]")?;
            let tech = flag_value(&args, "--tech");
            let worthy_only = args.iter().any(|a| a == "--worthy-only");
            let candidates: Vec<Value> = crate::extract::harvest(std::path::Path::new(dir))
                .into_iter()
                .filter(|c| tech.as_deref().is_none_or(|t| c.tech == t))
                .filter(|c| !worthy_only || c.classification.worthy)
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "tech": c.tech,
                        "concept": c.concept,
                        "role": c.role,
                        "composes": c.composes,
                        "code": c.code,
                        "worthy": c.classification.worthy,
                        "score": c.classification.score,
                        "reasons": c.classification.reasons,
                    })
                })
                .collect();
            emit(&serde_json::json!({ "candidates": candidates, "count": candidates.len() }))
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
        other => Err(format!("unknown graph command '{other}' — read: list | neighbors <id> | path <a> <b> | impl <concept> --tech <t> | impl list | dump | harvest <dir>; write: set | link | unlink | remove | impl set | impl remove\n\n{}", help(prog))),
    }
}

/// The value following a `--flag`, if present.
fn flag_value(args: &[String], flag: &str) -> Option<String> {
    args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned()
}

/// Split a `--flag a,b,c` value into a JSON string array (empty when absent/blank) — for `--composes`
/// and `--pairs` on `impl set` (#2863).
fn list_flag(s: Option<&str>) -> Value {
    Value::Array(
        s.unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|x| !x.is_empty())
            .map(|x| Value::String(x.to_string()))
            .collect(),
    )
}

fn help(prog: &str) -> String {
    format!(
        "{prog} — the Algorithms knowledge graph (#2761/#2853)\n\n\
         READ:\n  \
         {prog} list [--kind K] [--tech T] [--pretty]   # every concept; filter by kind and/or a tech that implements it\n  \
         {prog} neighbors <id> [--pretty]               # a concept's relationships (rel + direction + other node)\n  \
         {prog} path <a> <b> [--pretty]                 # shortest relationship chain between two concepts\n  \
         {prog} impl <concept> --tech <t> [--pretty]    # the concept's per-tech implementation (#2770), or null\n  \
         {prog} impl list [--tech <t>] [--role r]       # a language kit's implementations (#2863)\n  \
         {prog} dump [--pretty]                         # the whole graph document (nodes + edges + implementations)\n  \
         {prog} harvest <dir> [--tech T] [--worthy-only] [--pretty]   # harvest a project's functions into candidate library implementations, each classified worthy vs. glue (#2745)\n\n\
         WRITE (#2853) — curate the store; a read after reflects the write:\n  \
         {prog} set --id <id> --kind <kind> --name <name> [--summary <s>] [--tags a,b] [--complexity <c>]   # upsert a node\n  \
         {prog} link <from> <to> --rel <rel>            # add a relationship edge (both nodes must exist)\n  \
         {prog} unlink <from> <to> [--rel <rel>]        # remove matching edges (all rels when --rel omitted)\n  \
         {prog} remove <id>                             # delete a node + every edge/implementation referencing it\n  \
         {prog} impl set --tech <lang> --id <id> --role primitive|algorithm --name <n> --code <c> [--concept <c>] [--composes a,b] [--pairs x,y]   # upsert a language-kit impl (#2863)\n  \
         {prog} impl remove <id>                        # delete an implementation + scrub it from every composes/pairs\n\n\
         Node kinds: data-structure · algorithm · concept · output.\n\
         Implementation roles (#2863): primitive (a language building block, free-standing) · algorithm (composes primitives up).\n\
         Relationships: operates-on · composes · variant-of · generates · related-to.\n\
         Implementation techs (#2770): typescript · rust — each `implements` a concept and `composes` other same-tech impls.\n\
         The graph is the curated ontology + the per-tech implementation tier; `harvest` (#2745) mines a project's real code into candidate implementations for the library.\n",
    )
}
