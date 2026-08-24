//! A record's PUBLIC SURFACE — what its module exports, grouped into the ITEMS those exports name
//! (#a-record-holds-one-item-not-a-module-of-them).
//!
//! The library's standing rule is **one record, one item**: a record called `Card` exports the `Card`
//! component and the things that belong to `Card` — its props type, its variant enum, a `useCard` hook.
//! It does not export `ListItemCard`. The record's id is the only handle anything has on what it holds:
//! the preview mounts by id, `composes` edges resolve by id, `rename`/`merge` move a record whole, and
//! `provides` binds ONE specifier to ONE record. Every export beyond the record's own item is therefore
//! reachable by import but invisible to all of that — it has no id, never previews, is never an edge, and
//! a merge carries it off silently.
//!
//! This module answers the question that rule implies and nothing else could: **how many items does this
//! record's module actually expose?** It is deliberately a different question from
//! `graph_health::top_level_components`, which counts component DEFINITIONS whether or not they are
//! exported. The two disagree in both directions, and the disagreement is the point:
//!
//! | record | definitions | items | the truth |
//! |---|---|---|---|
//! | `ttscard` | 4 | 1 | `ToggleRow`/`SettingsRow`/`SettingsSelect` are PRIVATE — no consumer can reach them |
//! | `teams-canvas` | 1 | 5 | one component plus four exported domain types that belong elsewhere |
//! | `projectsworkspace` | ~2 | 34 | four `register*Platform` registrars and a manifest validator ride along |
//!
//! A definition count is an observation about COMPOSITION (should this file have been split?). An item
//! count is an observation about API (does this id name one thing?). They want opposite fixes — inline
//! the helper, versus extract the record — so they stay separate findings.

use std::collections::BTreeSet;

/// One exported name, classified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Export {
    /// The exported identifier, as written (`CardProps`, `TextField`, `default`).
    pub name: String,
    /// The item it belongs to — its normalized stem after decorations are stripped (see [`stem`]).
    pub item: String,
    /// Whether the source defines it as a component (PascalCase `function`/`const … =>` at column 0).
    pub component: bool,
    /// Whether its item differs from the record's own — i.e. it is a SECOND thing living in this record.
    pub foreign: bool,
}

/// A record's public surface: its exports, and the distinct items they name.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Surface {
    pub exports: Vec<Export>,
    /// The distinct item stems, in first-export order. `len()` is the count the rule is about.
    pub items: Vec<String>,
}

impl Surface {
    /// The exported names whose item is not the record's own — the extras the id does not name.
    pub fn foreign(&self) -> Vec<&Export> {
        self.exports.iter().filter(|e| e.foreign).collect()
    }
    /// The foreign exports that are COMPONENTS — another component's whole public API inside this record.
    /// The sharpest form of the finding: a component is a thing that should own an id, preview on its
    /// own, and appear as a `composes` edge, and none of that is true while it rides inside another record.
    pub fn foreign_components(&self) -> Vec<&Export> {
        self.exports.iter().filter(|e| e.foreign && e.component).collect()
    }
}

/// The decorations a name may carry while still belonging to its item. `Card`/`CardProps`/`CardVariant`
/// are one item; `Card`/`ListItemCard` are two.
///
/// Suffix-stripping only, and only when something is left over — `Props` alone is its own item, not an
/// empty stem that would then swallow every name by prefix. The list is the conventions this library
/// actually uses; it is not trying to be exhaustive, because a missed decoration over-reports by one
/// item (visible, arguable) while a wrong one under-reports by hiding a real second item (invisible).
const DECORATIONS: &[&str] = &[
    "props", "options", "option", "config", "state", "handlers", "handler", "variants", "variant",
    "kinds", "kind", "types", "type", "ref", "context", "provider", "result", "args", "input",
    "defaults", "default",
];

/// `name` reduced to its item stem: lowercased, non-alphanumerics dropped, a leading `use` (a hook on
/// the item) and one trailing decoration removed.
///
/// `Card` · `CardProps` · `useCard` · `CARD_DEFAULTS` all reduce to `card`. `TextField` reduces to
/// `textfield`, which is deliberately NOT `field` — a prefix, not a substring, is what separates "this
/// name decorates Field" from "this is a different component whose name happens to end in Field".
pub fn stem(name: &str) -> String {
    let mut s: String = name.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>().to_lowercase();
    if let Some(rest) = s.strip_prefix("use") {
        if !rest.is_empty() {
            s = rest.to_string();
        }
    }
    for d in DECORATIONS {
        if s.len() > d.len() && s.ends_with(d) {
            s.truncate(s.len() - d.len());
            break;
        }
    }
    s
}

/// Do two stems name the same item? One being a PREFIX of the other is the test — it folds a stem whose
/// decoration this list does not know (`CardHeader` → `card`) into its owner, while keeping `TextField`
/// (which merely CONTAINS `field`) apart from `Field`.
fn same_item(a: &str, b: &str) -> bool {
    !a.is_empty() && !b.is_empty() && (a.starts_with(b) || b.starts_with(a))
}

/// Every name `src` exports, in source order, deduplicated.
///
/// Covers the four forms this library's records actually use — a declaration (`export const X`,
/// `export function X`, `export class X`, `export type|interface|enum X`), a re-export list
/// (`export { X, type Y, Z as W }`, with or without a `from`), `export default function X`, and a bare
/// `export default` (recorded as `default`, since it IS a public entry point even unnamed).
///
/// Column 0 only, and over comment/string-blanked source, so the word `export` inside a doc comment or a
/// template literal cannot mint a phantom export. A `export * from` is skipped: it names nothing here,
/// and guessing at the other module's surface would be inventing exports rather than reading them.
pub fn exported_names(src: &str) -> Vec<String> {
    let blanked = blank_comments_and_strings(src);
    let mut out: Vec<String> = Vec::new();
    let mut push = |n: &str| {
        let n = n.trim();
        if !n.is_empty() && !out.iter().any(|x| x == n) {
            out.push(n.to_string());
        }
    };
    let mut lines = blanked.lines().peekable();
    while let Some(line) = lines.next() {
        if line.starts_with(char::is_whitespace) {
            continue; // not top level
        }
        let Some(rest) = line.strip_prefix("export") else { continue };
        // `export` must be a whole word — `exported` / `exports.foo` are not export statements.
        if !rest.starts_with(|c: char| c.is_whitespace() || c == '{') {
            continue;
        }
        let rest = rest.trim_start();
        if rest.starts_with('*') {
            continue; // `export * from` names nothing readable here
        }
        // A re-export list may wrap across lines; gather until the closing brace.
        if let Some(after) = rest.strip_prefix('{') {
            let mut body = after.to_string();
            while !body.contains('}') {
                match lines.next() {
                    Some(l) => {
                        body.push(' ');
                        body.push_str(l);
                    }
                    None => break,
                }
            }
            let body = body.split('}').next().unwrap_or("");
            for part in body.split(',') {
                let part = part.trim();
                if part.is_empty() {
                    continue;
                }
                // `X as W` exports W; a bare `type X` exports X.
                let name = part.rsplit(" as ").next().unwrap_or(part).trim();
                let name = name.strip_prefix("type ").unwrap_or(name).trim();
                push(name);
            }
            continue;
        }
        let rest = rest.strip_prefix("default").map(str::trim_start).unwrap_or(rest);
        let after_kw = ["async function*", "async function", "function*", "function", "const", "let",
                        "var", "abstract class", "class", "interface", "enum", "type"]
            .iter()
            .find_map(|kw| rest.strip_prefix(kw).filter(|r| r.starts_with(char::is_whitespace)));
        match after_kw {
            Some(r) => {
                let name: String =
                    r.trim_start().chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
                push(&name);
            }
            // `export default <expr>` — unnamed, but still the module's public entry point.
            None if line.starts_with("export default") => push("default"),
            None => {}
        }
    }
    out
}

/// The record's public [`Surface`]: its exports classified against `own_name` (the record's own name),
/// with `components` naming the definitions the source makes that are components.
pub fn surface(src: &str, own_name: &str, components: &BTreeSet<String>) -> Surface {
    let own = stem(own_name);
    let mut items: Vec<String> = Vec::new();
    let mut exports = Vec::new();
    for name in exported_names(src) {
        let s = stem(&name);
        if !s.is_empty() && !items.iter().any(|i| same_item(i, &s)) {
            items.push(s.clone());
        }
        exports.push(Export {
            component: components.contains(&name),
            foreign: !same_item(&s, &own),
            item: s,
            name,
        });
    }
    Surface { exports, items }
}

/// `src` with every comment body and every string/template body blanked to spaces, newlines preserved —
/// so a column-0 scan still sees real columns and the word `export` inside prose cannot be read as code.
///
/// A smaller sibling of `graph_health::blank_code`, which does the same for the prop-signature parser.
/// Kept separate rather than shared because that one is tuned for JSX prose (its quote-adjacency rule
/// exists so `don't` inside markup is not a string opener) and this one only ever needs to survive the
/// leading tokens of a line.
fn blank_comments_and_strings(src: &str) -> String {
    let b: Vec<char> = src.chars().collect();
    let mut out = b.clone();
    let mut i = 0;
    let n = b.len();
    let blank = |out: &mut Vec<char>, from: usize, to: usize| {
        for c in out.iter_mut().take(to.min(n)).skip(from) {
            if *c != '\n' {
                *c = ' ';
            }
        }
    };
    while i < n {
        match b[i] {
            '/' if i + 1 < n && b[i + 1] == '/' => {
                let start = i;
                while i < n && b[i] != '\n' {
                    i += 1;
                }
                blank(&mut out, start, i);
            }
            '/' if i + 1 < n && b[i + 1] == '*' => {
                let start = i;
                i += 2;
                while i + 1 < n && !(b[i] == '*' && b[i + 1] == '/') {
                    i += 1;
                }
                i = (i + 2).min(n);
                blank(&mut out, start, i);
            }
            q @ ('\'' | '"' | '`') => {
                let start = i;
                i += 1;
                while i < n && b[i] != q {
                    if b[i] == '\\' {
                        i += 1;
                    } else if b[i] == '\n' && q != '`' {
                        break; // an unterminated quote on one line is prose, not a string
                    }
                    i += 1;
                }
                i = (i + 1).min(n);
                blank(&mut out, start, i);
            }
            _ => i += 1,
        }
    }
    out.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn comps(names: &[&str]) -> BTreeSet<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn reads_every_export_form_this_library_uses() {
        let src = r#"
import { thing } from "./thing";
export type CardProps = { title: string };
export interface CardHandle { focus(): void }
export const Card = ({ title }: CardProps) => <div>{title}</div>;
export function useCard() { return 1; }
export class CardStore {}
export enum CardTone { Quiet, Loud }
export { Inner as Outer, type Wire } from "./other";
const private = 1;
export default Card;
"#;
        assert_eq!(
            exported_names(src),
            vec!["CardProps", "CardHandle", "Card", "useCard", "CardStore", "CardTone", "Outer", "Wire", "default"],
        );
    }

    #[test]
    fn export_inside_prose_or_a_template_is_not_an_export() {
        let src = "\
// export const Ghost = () => null;
/* export function AlsoGhost() {} */
const doc = `\nexport const TemplateGhost = 1;\n`;
export const Real = () => null;
";
        assert_eq!(exported_names(src), vec!["Real"], "only the column-0 code export counts");
    }

    #[test]
    fn an_indented_export_is_not_top_level_and_a_star_names_nothing() {
        let src = "  export const Nested = 1;\nexport * from \"./barrel\";\nexport const Real = 1;\n";
        assert_eq!(exported_names(src), vec!["Real"]);
    }

    #[test]
    fn a_multi_line_reexport_list_is_gathered_whole() {
        let src = "export {\n  Alpha,\n  type Beta,\n  Gamma as Delta,\n} from \"./x\";\n";
        assert_eq!(exported_names(src), vec!["Alpha", "Beta", "Delta"]);
    }

    #[test]
    fn a_name_and_its_decorations_are_one_item() {
        for n in ["Card", "CardProps", "CardVariant", "useCard", "CARD_DEFAULTS", "CardOptions"] {
            assert!(same_item(&stem(n), "card"), "{n} should belong to `card`, got {}", stem(n));
        }
    }

    #[test]
    fn a_name_that_merely_ends_in_the_stem_is_a_different_item() {
        // The `ui-field` case: three components rode inside the `Field` record for want of this rule.
        assert!(!same_item(&stem("TextField"), &stem("Field")));
        assert!(!same_item(&stem("SelectField"), &stem("Field")));
        assert!(!same_item(&stem("ListItemCard"), &stem("Card")));
    }

    #[test]
    fn a_decoration_alone_keeps_its_own_stem() {
        // Stripping `Props` off `Props` would leave an empty stem, which every name then prefixes.
        assert_eq!(stem("Props"), "props");
        assert!(!same_item(&stem("Props"), &stem("Card")));
    }

    #[test]
    fn a_well_formed_record_holds_exactly_one_item() {
        let src = "export type CardProps = { a: string };\nexport const Card = (p: CardProps) => <div />;\n";
        let s = surface(src, "Card", &comps(&["Card"]));
        assert_eq!(s.items, vec!["card"], "the props type is part of Card, not a second item");
        assert!(s.foreign().is_empty());
        assert!(s.foreign_components().is_empty());
    }

    #[test]
    fn a_record_carrying_another_components_api_reports_it() {
        // `ui-field`, verbatim in shape: four components and their props types under one id.
        let src = "\
export type FieldProps = {};
export const Field = (p: FieldProps) => <div />;
export type TextFieldProps = {};
export const TextField = (p: TextFieldProps) => <Field />;
export const SelectField = (p: {}) => <Field />;
";
        let s = surface(src, "Field", &comps(&["Field", "TextField", "SelectField"]));
        assert_eq!(s.items, vec!["field", "textfield", "selectfield"]);
        let foreign: Vec<&str> = s.foreign_components().iter().map(|e| e.name.as_str()).collect();
        assert_eq!(foreign, vec!["TextField", "SelectField"]);
    }

    #[test]
    fn a_private_helper_is_not_a_second_item() {
        // `ttscard`: the definition count says 3, the item count says 1, and the item count is right —
        // nothing outside the record can reach `ToggleRow`.
        let src = "\
const ToggleRow = ({ on }: { on: boolean }) => <input checked={on} />;
const SettingsRow = () => <div />;
export const TtsCard = () => <ToggleRow on />;
";
        let s = surface(src, "TtsCard", &comps(&["ToggleRow", "SettingsRow", "TtsCard"]));
        assert_eq!(s.items, vec!["ttscard"]);
        assert!(s.foreign_components().is_empty(), "an unexported sibling is a composition question, not an API one");
    }

    #[test]
    fn an_exported_type_is_foreign_but_is_not_a_foreign_component() {
        // `teams-canvas`: five exported domain types beside the component. Worth reporting as items;
        // not the same severity as shipping another component's API.
        let src = "\
export type Position = {};
export type Relationship = {};
export const TeamsCanvas = () => <div />;
";
        let s = surface(src, "TeamsCanvas", &comps(&["TeamsCanvas"]));
        assert_eq!(s.items.len(), 3);
        assert_eq!(s.foreign().len(), 2);
        assert!(s.foreign_components().is_empty());
    }
}
