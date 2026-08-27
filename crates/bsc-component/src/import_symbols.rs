//! Whether a NAMED import actually names something the target module exports (#149, bsc request #149)
//! — the SYMBOL-level counterpart to `unresolvable-import`, which only asks whether the specifier
//! resolves to a module at all.
//!
//! `bsc ui doctor` checked 1276 records for `untyped`/`missing-viz` and — via `unresolvable-import` —
//! whether an internal specifier resolves to SOME record. Neither asked the sharper question: once it
//! resolves, does the target actually EXPORT the name being imported? Three separate store/seed drifts
//! (glance-fleet, surface-catalog, role-model) each broke the Glance page at RUNTIME with nothing in
//! `doctor`, no typecheck error and no failing test — because `tsc`/`vitest` compile the SEED file while
//! the running app loads the STORE record, and the two had drifted apart on exactly this axis. A checker
//! that stops at the first barrel it meets, or reads only a declaration's first comma-separated name,
//! reports clean on precisely this bug — so [`resolved_export_names`] follows `export * from` chains
//! (`crate::exports::star_reexport_specifiers`) and reads every declarator
//! (`crate::exports::exported_names`, now multi-declarator-aware) before answering.
//!
//! Scope: only specifiers that resolve to a RECORD (component, sibling, or algorithm impl) are judged —
//! [`resolved_export_names`] returns `None` for anything else (the platform boundary, or nothing at all),
//! and the caller skips it. A specifier that resolves to NO record is `unresolvable-import`'s finding,
//! not this one's; reporting both would name the same defect twice.

use crate::closure::Index;
use std::collections::BTreeSet;

/// One `import { … } from "spec"` clause's VALUE bindings — the ORIGINAL (pre-`as`) names it asks `spec`
/// to export. Type-only bindings (`import type { X }`, a per-binding `type X`) are excluded: they are
/// erased before resolution (#4076) and the loader never asks the target module for them. A bare default
/// import contributes the name `"default"`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NamedImport {
    pub spec: String,
    pub names: Vec<String>,
}

/// Every `import { … } from "@/…"` clause in `source` naming a VALUE — the shape [`resolved_export_names`]
/// can judge. Non-internal specifiers (bare npm, `@bsc/…` library refs) are skipped: the store has no
/// export surface to check them against. A namespace (`* as X`) or bare side-effect import contributes no
/// clause at all — there is nothing to verify a name against.
pub(crate) fn named_value_imports(source: &str) -> Vec<NamedImport> {
    scan_import_clauses(source)
        .into_iter()
        .filter(|(_, spec, type_only)| !*type_only && spec.starts_with("@/"))
        .filter_map(|(clause, spec, _)| {
            let names = clause_names(&clause);
            (!names.is_empty()).then_some(NamedImport { spec, names })
        })
        .collect()
}

/// `(clause, specifier, statement-level type-only)` for every `import { … } from "…"` statement in
/// `source` that carries a NAMED clause — a bare default/namespace/side-effect import has no braces and
/// is skipped up front, so nothing here ever hunts for a `from` across an unbounded run of lines.
///
/// The clause is read from COMMENT/STRING-BLANKED text (so a `//`/`/* */` inside a multi-line `{ … }`
/// list can't inject a phantom name); the specifier is read from the matching span of the ORIGINAL text
/// (blanking erases string bodies, and the specifier IS one) at the SAME byte offset — safe because
/// blanking only ever substitutes ASCII spaces for characters already inside that line, so a line with no
/// non-ASCII content keeps identical byte positions in both. Import clauses are that content essentially
/// always; a non-ASCII collision degrades to a skipped clause, never a wrong one (`.get` over slicing).
fn scan_import_clauses(source: &str) -> Vec<(String, String, bool)> {
    let blanked = crate::exports::blank_comments_and_strings(source);
    let bl: Vec<&str> = blanked.lines().collect();
    let ol: Vec<&str> = source.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bl.len() {
        let line = bl[i];
        if line.starts_with(char::is_whitespace) {
            i += 1;
            continue;
        }
        let Some(rest) = line.strip_prefix("import") else {
            i += 1;
            continue;
        };
        if !rest.starts_with(|c: char| c.is_whitespace() || c == '{') {
            i += 1; // `import(` dynamic, `import.meta`, or not an import at all
            continue;
        }
        let rest_trim = rest.trim_start();
        let (type_only, clause_head) = match rest_trim.strip_prefix("type") {
            Some(r) if r.starts_with(|c: char| c.is_whitespace() || c == '{' || c == '*') => (true, r.trim_start()),
            _ => (false, rest_trim),
        };
        if !clause_head.starts_with('{') {
            i += 1; // default-only / namespace-only / side-effect — no clause to verify
            continue;
        }
        // Gather (blanked) lines until the clause closes. `start` is the line "import" began on —
        // captured BEFORE `i` advances, since it anchors the parallel ORIGINAL-text span below.
        // `head_offset` is where `clause_head` starts WITHIN `line` — every step that produced it
        // (`strip_prefix`, `trim_start`) only ever drops a PREFIX, so it is always an exact suffix.
        let start = i;
        let head_offset = line.len() - clause_head.len();
        let mut bbody = clause_head.to_string();
        let mut j = i;
        while !bbody.contains('}') {
            j += 1;
            if j >= bl.len() {
                break;
            }
            bbody.push(' ');
            bbody.push_str(bl[j]);
        }
        i = j + 1;
        let Some(close) = bbody.find('}') else { continue };
        // `bbody[0..1]` is always `{` (that is what qualified this statement above) — stripped here so
        // `clause_names` receives the BODY, not the body plus its own opening brace as a phantom name.
        let clause = bbody[1..close].to_string();
        if !bbody[close + 1..].contains("from") {
            continue; // no `from` on the lines the clause spanned — malformed or not a real import
        }
        // The ORIGINAL text is built the SAME way `bbody` was — the first line sliced at the SAME
        // offset `clause_head` started at, then whole subsequent lines — so `close`'s byte offset lines
        // up unless a blanked line changed length (only possible via non-ASCII content), in which case
        // `.get` below fails closed rather than reading a wrong specifier.
        let Some(ohead) = ol.get(start).and_then(|l| l.get(head_offset..)) else { continue };
        let mut obody = ohead.to_string();
        for k in (start + 1)..=j {
            obody.push(' ');
            obody.push_str(ol.get(k).copied().unwrap_or_default());
        }
        let Some(otail) = obody.get(close + 1..) else { continue };
        let Some(spec) = quoted_after(otail, "from") else { continue };
        out.push((clause, spec, type_only));
    }
    out
}

/// The first quoted string literal following the whole word `word` in `s`.
fn quoted_after(s: &str, word: &str) -> Option<String> {
    let idx = s.find(word)?;
    let after = s[idx + word.len()..].trim_start();
    let quote = after.chars().next().filter(|c| matches!(c, '"' | '\'' | '`'))?;
    let body = &after[quote.len_utf8()..];
    let end = body.find(quote)?;
    Some(body[..end].to_string())
}

/// The VALUE names a `{ … }` clause body (the text between the braces) binds — an entry prefixed `type `
/// (per-binding erasure, #4076) is dropped, and `X as W` asks the target for `X`, the ORIGINAL exported
/// name, never the local alias `W`.
fn clause_names(clause_body: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in clause_body.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        if part.strip_prefix("type").is_some_and(|r| r.starts_with(char::is_whitespace)) {
            continue;
        }
        let name = part.split(" as ").next().unwrap_or(part).trim();
        if !name.is_empty() {
            out.push(name.to_string());
        }
    }
    out
}

/// Every name `spec` resolves to once its record's exports are followed through `export * from` BARRELS
/// (#149) — the honest export surface, wider than reading one module's own [`crate::exports::exported_names`]
/// alone. `None` when `spec` resolves to no RECORD at all (the platform boundary, or nothing) — not this
/// check's business; `unresolvable-import` already owns that question — OR when the closure is
/// INCOMPLETE: `spec` (or a barrel it `export * from`s, at any depth) forwards through a specifier that
/// itself resolves to no record.
///
/// That second case is not hypothetical — it is the FIRST false positive this check produced against the
/// real store: `blueprints.ts` is `export * from "@/features/planner/stages/blueprintBuiltins"` among
/// others, and `blueprintBuiltins` is not yet a record (still a plain file). A version of this function
/// that read `blueprintBuiltins` as contributing NO names (rather than "names unknown") reported
/// `STAGE_DEFS`/`mkStage`/`uid`/`dedupeSections`/`makeBlueprints` as missing — every one of them plainly
/// exported by that file. Silence about a branch is not evidence of absence, so an unresolvable branch
/// anywhere in the chain makes the WHOLE closure unusable for judging rather than letting the resolved
/// remainder stand in for it — the same caution `doctor_with_entities` uses when an entity list is empty
/// (skip the check rather than condemn every declaration).
pub(crate) fn resolved_export_names(spec: &str, index: &Index<'_>) -> Option<BTreeSet<String>> {
    let base = spec.strip_prefix("@/")?;
    index.lookup(spec, base)?;
    let mut visited = BTreeSet::new();
    let (names, complete) = collect_export_names(spec, base, index, &mut visited);
    complete.then_some(names)
}

/// `(names, complete)` — `complete` is `false` the moment ANY `export * from` target, at any depth,
/// fails to resolve to a record (or its base cannot even be computed). Propagated up through every
/// caller: one unresolvable leaf makes every ancestor's closure incomplete too, since an ancestor's
/// "exports" are honestly unknown while one of its declared sources is.
fn collect_export_names(
    spec: &str,
    base: &str,
    index: &Index<'_>,
    visited: &mut BTreeSet<String>,
) -> (BTreeSet<String>, bool) {
    let mut out = BTreeSet::new();
    if !visited.insert(spec.to_string()) {
        return (out, true); // a barrel cycle — already walked; nothing new, and not itself a gap
    }
    let Some((_, _, source, _)) = index.lookup(spec, base) else { return (out, false) };
    out.extend(crate::exports::exported_names(&source));
    let mut complete = true;
    for star_spec in crate::exports::star_reexport_specifiers(&source) {
        let Some(star_base) = crate::graph_health::resolve_internal_base(&star_spec, base) else {
            complete = false; // can't even locate what this barrel forwards to
            continue;
        };
        let key = format!("@/{star_base}");
        let (inner_names, inner_complete) = collect_export_names(&key, &star_base, index, visited);
        out.extend(inner_names);
        complete &= inner_complete;
    }
    (out, complete)
}

/// The `unresolved-import-symbol` findings (#149): for each `(kit, id, name, source)` record, does every
/// VALUE name it imports from an internal `@/…` specifier actually appear in that specifier's resolved
/// export surface (barrels followed)? A specifier [`resolved_export_names`] can't resolve to a record is
/// skipped — that gap is `unresolvable-import`'s to report.
pub(crate) fn unresolved_import_symbol_findings(
    records: &[(String, String, String, String)],
    index: &Index<'_>,
) -> Vec<crate::graph_health::Finding> {
    let mut out = Vec::new();
    for (kit, id, name, source) in records {
        for imp in named_value_imports(source) {
            let Some(exported) = resolved_export_names(&imp.spec, index) else { continue };
            let missing: Vec<&str> = imp.names.iter().map(String::as_str).filter(|n| !exported.contains(*n)).collect();
            if missing.is_empty() {
                continue;
            }
            let list = missing.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ");
            out.push(crate::graph_health::Finding {
                category: "unresolved-import-symbol",
                severity: 4,
                kit: kit.clone(),
                node_ids: vec![id.clone()],
                node_names: vec![name.clone()],
                why: format!(
                    "imports {list} from `{}`, which resolves but does not export {} — the module (or the \
                     barrel it re-exports through) never declares {}",
                    imp.spec,
                    if missing.len() == 1 { "it" } else { "them" },
                    if missing.len() == 1 { "that name" } else { "those names" },
                ),
                suggested_action: format!(
                    "export {list} from `{}` (directly, or through a re-export barrel), or fix the import \
                     to name what it actually publishes",
                    imp.spec,
                ),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn no_platform() -> &'static std::collections::BTreeSet<String> {
        static E: std::sync::OnceLock<std::collections::BTreeSet<String>> = std::sync::OnceLock::new();
        E.get_or_init(std::collections::BTreeSet::new)
    }

    #[test]
    fn a_single_line_named_import_is_read() {
        let src = "import { Foo, Bar as Baz, type Qux } from \"@/x/mod\";\n";
        let imps = named_value_imports(src);
        assert_eq!(imps.len(), 1);
        assert_eq!(imps[0].spec, "@/x/mod");
        // `Baz` is the LOCAL alias; the module was asked for `Bar`. `Qux` is type-only — erased.
        assert_eq!(imps[0].names, vec!["Foo", "Bar"]);
    }

    #[test]
    fn a_multi_line_named_import_is_read() {
        let src = "import {\n  Foo,\n  Bar,\n} from \"@/x/mod\";\nexport const R = 1;\n";
        let imps = named_value_imports(src);
        assert_eq!(imps.len(), 1);
        assert_eq!(imps[0].spec, "@/x/mod");
        assert_eq!(imps[0].names, vec!["Foo", "Bar"]);
    }

    #[test]
    fn a_statement_level_type_import_is_fully_erased() {
        let src = "import type { Foo, Bar } from \"@/x/mod\";\nexport const R = 1;\n";
        assert!(named_value_imports(src).is_empty());
    }

    #[test]
    fn a_default_only_import_is_not_a_named_clause() {
        let src = "import Foo from \"@/x/mod\";\nexport const R = 1;\n";
        assert!(named_value_imports(src).is_empty(), "no braces — nothing here to symbol-check");
    }

    #[test]
    fn a_bare_specifier_import_is_ignored() {
        let src = "import { useState } from \"react\";\nexport const R = 1;\n";
        assert!(named_value_imports(src).is_empty(), "the store has no export surface for a bare package");
    }

    #[test]
    fn resolved_export_names_reads_the_targets_own_exports() {
        let comps = vec![json!({
            "id": "a", "provides": "@/x/A", "src": "src/x/A.tsx",
            "srcText": "export const A = 1;\nexport const B = 2;",
        })];
        let index = Index::new(&comps, &[], no_platform(), None);
        let names = resolved_export_names("@/x/A", &index).unwrap();
        assert!(names.contains("A") && names.contains("B"));
    }

    /// #149 — the sharp end: a barrel that re-exports from another module, where the direct export list
    /// alone would miss the name entirely.
    #[test]
    fn resolved_export_names_follows_a_star_barrel() {
        let comps = vec![
            json!({ "id": "barrel", "provides": "@/x/barrel", "src": "src/x/barrel.ts",
                    "srcText": "export * from \"./inner\";" }),
            json!({ "id": "inner", "provides": "@/x/inner", "src": "src/x/inner.ts",
                    "srcText": "export const Deep = 1;" }),
        ];
        let index = Index::new(&comps, &[], no_platform(), None);
        let names = resolved_export_names("@/x/barrel", &index).unwrap();
        assert!(names.contains("Deep"), "the barrel's target export should be visible through it: {names:?}");
    }

    #[test]
    fn resolved_export_names_terminates_on_a_barrel_cycle() {
        let comps = vec![
            json!({ "id": "a", "provides": "@/x/a", "src": "src/x/a.ts", "srcText": "export * from \"./b\";" }),
            json!({ "id": "b", "provides": "@/x/b", "src": "src/x/b.ts", "srcText": "export * from \"./a\";\nexport const Real = 1;" }),
        ];
        let index = Index::new(&comps, &[], no_platform(), None);
        let names = resolved_export_names("@/x/a", &index).unwrap();
        assert_eq!(names, std::collections::BTreeSet::from(["Real".to_string()]));
    }

    #[test]
    fn resolved_export_names_is_none_for_a_specifier_no_record_claims() {
        let index = Index::new(&[], &[], no_platform(), None);
        assert!(resolved_export_names("@/nowhere", &index).is_none());
    }

    /// #149, the real false positive this fix exists for: a component barrel is
    /// `export * from "@/features/planner/stages/blueprintBuiltins"`, and `blueprintBuiltins` is not yet
    /// a record — still a plain, unmigrated file. The first cut of this function read that branch as
    /// contributing NO names and reported `STAGE_DEFS`/`mkStage`/`uid` as missing from `blueprints.ts`,
    /// even though the real file plainly exports all three. Silence about an unresolvable branch must
    /// suppress judgment, not stand in for "this branch has nothing."
    #[test]
    fn resolved_export_names_is_none_when_a_star_barrel_target_is_not_a_record() {
        let comps = vec![json!({
            "id": "barrel", "provides": "@/x/barrel", "src": "src/x/barrel.ts",
            "srcText": "export * from \"./unmigrated\";\nexport const Shallow = 1;",
        })];
        let index = Index::new(&comps, &[], no_platform(), None);
        assert!(
            resolved_export_names("@/x/barrel", &index).is_none(),
            "one unresolvable star-from branch makes the whole closure unusable for judging, even \
             though `barrel` itself IS a record and `Shallow` IS a direct export"
        );
    }

    #[test]
    fn unresolved_import_symbol_findings_does_not_flag_a_name_behind_an_unresolvable_star_branch() {
        let comps = vec![
            json!({ "id": "barrel", "provides": "@/x/barrel", "src": "src/x/barrel.ts",
                    "srcText": "export * from \"./unmigrated\";" }),
        ];
        let index = Index::new(&comps, &[], no_platform(), None);
        let records = vec![(
            String::new(),
            "importer".to_string(),
            "Importer".to_string(),
            "import { STAGE_DEFS } from \"@/x/barrel\";\nexport const R = STAGE_DEFS;".to_string(),
        )];
        assert!(
            unresolved_import_symbol_findings(&records, &index).is_empty(),
            "the barrel's target is unmigrated, not proven absent — must not report a false positive"
        );
    }

    #[test]
    fn unresolved_import_symbol_findings_flags_a_missing_export_but_not_a_present_one() {
        let comps = vec![
            json!({ "id": "target", "provides": "@/x/target", "src": "src/x/target.ts", "srcText": "export const Real = 1;" }),
        ];
        let index = Index::new(&comps, &[], no_platform(), None);
        let records = vec![(
            "kit1".to_string(),
            "importer".to_string(),
            "Importer".to_string(),
            "import { Real, Ghost } from \"@/x/target\";\nexport const R = [Real, Ghost];".to_string(),
        )];
        let fs = unresolved_import_symbol_findings(&records, &index);
        assert_eq!(fs.len(), 1);
        assert_eq!(fs[0].category, "unresolved-import-symbol");
        assert!(fs[0].why.contains("Ghost"), "{}", fs[0].why);
        assert!(!fs[0].why.contains("Real"), "the present export must not be named as missing: {}", fs[0].why);
    }

    #[test]
    fn unresolved_import_symbol_findings_skips_an_unresolvable_specifier() {
        // The specifier resolves to NO record at all — `unresolvable-import`'s finding, not this one's.
        let index = Index::new(&[], &[], no_platform(), None);
        let records = vec![(
            String::new(),
            "importer".to_string(),
            "Importer".to_string(),
            "import { Ghost } from \"@/nowhere\";\nexport const R = Ghost;".to_string(),
        )];
        assert!(unresolved_import_symbol_findings(&records, &index).is_empty());
    }

    #[test]
    fn unresolved_import_symbol_findings_follows_a_barrel_before_judging() {
        let comps = vec![
            json!({ "id": "barrel", "provides": "@/x/barrel", "src": "src/x/barrel.ts",
                    "srcText": "export * from \"./inner\";" }),
            json!({ "id": "inner", "provides": "@/x/inner", "src": "src/x/inner.ts",
                    "srcText": "export const Deep = 1;" }),
        ];
        let index = Index::new(&comps, &[], no_platform(), None);
        let records = vec![(
            String::new(),
            "importer".to_string(),
            "Importer".to_string(),
            "import { Deep } from \"@/x/barrel\";\nexport const R = Deep;".to_string(),
        )];
        assert!(
            unresolved_import_symbol_findings(&records, &index).is_empty(),
            "a name reachable only through the barrel must not be reported missing"
        );
    }

    /// #149, end-to-end: the real false positive this feature shipped with (`aider.ts`, live in the
    /// store) — a module whose EARLIER declaration's template literal nests another template literal
    /// inside a `${…}` interpolation. Before `exports::template_literal_end` existed, the naive scan
    /// stopped at the nested literal's own backtick, corrupted everything scanned after it, and made a
    /// plainly-exported later name (`aiderProvider`) report as missing.
    #[test]
    fn a_nested_template_literal_earlier_in_the_target_does_not_produce_a_false_positive() {
        let comps = vec![json!({
            "id": "aider.ts", "provides": "@/x/aider", "src": "src/x/aider.ts",
            "srcText": "\
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\\\''`)}'`;
}

export const aiderProvider = { id: \"aider\" };
",
        })];
        let index = Index::new(&comps, &[], no_platform(), None);
        let records = vec![(
            String::new(),
            "importer".to_string(),
            "Importer".to_string(),
            "import { aiderProvider } from \"@/x/aider\";\nexport const R = aiderProvider;".to_string(),
        )];
        assert!(
            unresolved_import_symbol_findings(&records, &index).is_empty(),
            "aiderProvider IS exported — a nested template literal earlier in the file must not hide it"
        );
    }
}
