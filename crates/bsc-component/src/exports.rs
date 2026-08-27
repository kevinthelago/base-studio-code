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
        // `const`/`let`/`var` can bind MULTIPLE names in one statement (`export const a = 1, b = 2;`) —
        // handled separately from the single-name keywords below, since none of the others can.
        if let Some(body) = ["const", "let", "var"]
            .iter()
            .find_map(|kw| rest.strip_prefix(kw).filter(|r| r.starts_with(char::is_whitespace)))
        {
            for name in declarator_names(body) {
                push(&name);
            }
            continue;
        }
        let after_kw = ["async function*", "async function", "function*", "function",
                        "abstract class", "class", "interface", "enum", "type"]
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

/// The names an `export const/let/var …` declaration list binds — one per top-level, comma-separated
/// DECLARATOR. `export const a = 1, b = 2;` exports BOTH `a` and `b`; a parser that reads only the first
/// reports a record's second binding clean when that is the one a broken import actually needed (#149,
/// "a checker that stops at the barrel reports clean on exactly this bug" — this is the sibling gap the
/// same request named: stopping at the FIRST declarator).
///
/// Scoped to ONE LINE: depth-balanced `(){}[]` comma-splitting over what remains after the keyword, up to
/// that line's own top-level `;` if it has one. An initializer that itself spans further lines (an object
/// literal opened here and closed later) is not followed past this line — the FIRST declarator is still
/// read correctly either way, and a LATER declarator after such a multi-line initializer is missed. Rare
/// enough in this library's style to leave as a known gap rather than growing this into a real expression
/// parser. A destructuring pattern (`{ a, b }` / `[a, b]`) is not a plain declarator name and is skipped —
/// no destructured export existed in the store when this was written, so behavior is unchanged for it.
fn declarator_names(body: &str) -> Vec<String> {
    let stmt = trim_to_statement(body);
    let mut out = Vec::new();
    for decl in split_top_level_commas(stmt) {
        let decl = decl.trim_start();
        if decl.starts_with('{') || decl.starts_with('[') {
            continue;
        }
        let name: String =
            decl.chars().take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$').collect();
        if !name.is_empty() {
            out.push(name);
        }
    }
    out
}

/// `body` up to (not including) a `;` that sits at bracket depth 0, or the whole string when none does.
fn trim_to_statement(body: &str) -> &str {
    let mut depth = 0i32;
    for (i, c) in body.char_indices() {
        match c {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            ';' if depth <= 0 => return &body[..i],
            _ => {}
        }
    }
    body
}

/// Split `s` on commas that sit at bracket depth 0 — the declarator boundaries of `const a = f(1, 2), b`,
/// where the first comma is an argument separator and must not split anything.
fn split_top_level_commas(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut depth = 0i32;
    let mut start = 0usize;
    for (i, c) in s.char_indices() {
        match c {
            '(' | '{' | '[' => depth += 1,
            ')' | '}' | ']' => depth -= 1,
            ',' if depth <= 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out
}

/// The specifiers named by an `export * from "…"` (or `export * as NS from "…"`) BARREL, in source
/// order — code position only (column 0, never inside a comment). Deliberately separate from
/// [`exported_names`], which treats `export *` as naming nothing readable: a barrel names no LOCAL
/// binding of its own, but its target module's exports still belong to THIS module's public surface, and
/// walking that chain is [`crate::import_symbols::resolved_export_names`]'s job (#149) — this function
/// only says where to look.
///
/// A line scan, like [`crate::cli::component_specifiers`] — not comment/string-blanked, so a `*` inside a
/// doc comment reading literally "export * from "x"" could false-positive. Accepted the same way that
/// sibling function accepts it: the cost of a false hit here is a barrel lookup that resolves to nothing,
/// not a wrong finding.
pub fn star_reexport_specifiers(src: &str) -> Vec<String> {
    let mut out = Vec::new();
    for line in src.lines() {
        if line.starts_with(char::is_whitespace) {
            continue; // not top level
        }
        let Some(rest) = line.strip_prefix("export") else { continue };
        if !rest.starts_with(|c: char| c.is_whitespace() || c == '{') {
            continue;
        }
        // `export type * from "…"` re-exports only the target's TYPE-level names, but a named import
        // this checker judges may legitimately import a type through a value-shaped clause (`import { P }
        // from …` — the sibling `exported_names` doc explains why that is NOT type-erasable), so the
        // barrel must still be followed rather than silently treated as naming nothing.
        let after_export = rest.trim_start();
        let after_export = after_export
            .strip_prefix("type")
            .filter(|r| r.starts_with(|c: char| c.is_whitespace() || c == '*'))
            .map(str::trim_start)
            .unwrap_or(after_export);
        let Some(after_star) = after_export.strip_prefix('*') else { continue };
        let after_star = after_star.trim();
        let Some(quote_pos) = after_star.find(['"', '\'', '`']) else { continue };
        let clause = after_star[..quote_pos].trim();
        // `from`, or `as <ident> from` — the only two shapes a real barrel re-export takes here.
        let is_barrel = clause == "from"
            || (clause.starts_with("as ") && clause.trim_end().ends_with("from"));
        if !is_barrel {
            continue;
        }
        let quote = after_star.as_bytes()[quote_pos] as char;
        let rest_after_quote = &after_star[quote_pos + quote.len_utf8()..];
        if let Some(end) = rest_after_quote.find(quote) {
            out.push(rest_after_quote[..end].to_string());
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
///
/// `pub(crate)`, not private: [`crate::import_symbols`] (#149) reuses this exact blanking pass rather
/// than keep a second copy — a template literal's `${…}` interpolation (below) is genuinely tricky to
/// get right, and two copies of tricky code drift (see [`template_literal_end`]'s doc comment for the
/// bug that drift would have reintroduced).
pub(crate) fn blank_comments_and_strings(src: &str) -> String {
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
            // A template literal gets its OWN closing search (#149): naively scanning for the next
            // backtick misreads a NESTED template inside a `${…}` interpolation as the closer of the
            // OUTER one — see [`template_literal_end`].
            '`' => {
                let start = i;
                i = template_literal_end(&b, start);
                blank(&mut out, start, i);
            }
            q @ ('\'' | '"') => {
                let start = i;
                i += 1;
                while i < n && b[i] != q {
                    if b[i] == '\\' {
                        i += 1;
                    } else if b[i] == '\n' {
                        break; // an unterminated quote on one line is prose, not a string
                    }
                    i += 1;
                }
                i = (i + 1).min(n);
                blank(&mut out, start, i);
            }
            // A REGEX LITERAL can hold a quote or backtick (`/`/g`, real shape from `recover-issues.ts`,
            // #149) that is not a string/template opener at all — reading it as one desyncs everything
            // scanned afterward, exactly the corruption `skip_balanced_interpolation` already guards
            // against INSIDE a `${…}` interpolation. This is the same hazard at the TOP LEVEL: a
            // top-level regex containing a backtick was misread as opening a template literal, and
            // `template_literal_end` then blanked the rest of the file looking for a closer, silently
            // dropping every export after it (`recoverIssue`/`recoverIssues` both vanished this way).
            '/' if is_regex_context(&b, i) => {
                let start = i;
                i = skip_regex_literal(&b, i);
                blank(&mut out, start, i);
            }
            _ => i += 1,
        }
    }
    out.into_iter().collect()
}

/// The index just past the CLOSING backtick of the template literal opening at `chars[start]`.
/// Understands `${…}` interpolation: an interpolation may itself contain a NESTED template literal (or
/// a plain string, or a further `{…}`), so a scan that just looks for "the next backtick" reads that
/// nested literal's OWN backtick as the outer one's close.
///
/// Real, not hypothetical (#149, bsc request #149): `` `'${s.replace(/'/g, `'\\''`)}'` `` in a packaged
/// record — the naive scan stopped at the SECOND backtick (the nested literal's own opener), leaving
/// everything after it un-blanked and desynchronized, which silently dropped every export the doctor's
/// symbol check (or `bsc ui doctor`'s `no-tests`/`multi-export`, which also read [`exported_names`])
/// scanned afterward — a component that plainly exports `aiderProvider` was reported as not exporting it.
///
/// `start + 1` is EOF-safe: `n` returned from an inner call always ends the outer loop the same way.
fn template_literal_end(chars: &[char], start: usize) -> usize {
    let n = chars.len();
    let mut i = start + 1; // past the opening backtick
    while i < n {
        match chars[i] {
            '\\' => i += 2,
            '`' => return i + 1,
            '$' if i + 1 < n && chars[i + 1] == '{' => {
                i = skip_balanced_interpolation(chars, i + 2);
            }
            _ => i += 1,
        }
    }
    n // unterminated — the caller's blank-to-EOF matches how an unterminated `'`/`"` is already handled
}

/// The index just past the `}` matching a `${` whose own `{` sat at `from - 1` (i.e. `from` is the index
/// right after that `{`). Tracks further `{…}` nesting (an object literal, another `${…}`) and skips over
/// any nested string/template/REGEX literal so a `}` — or, for a regex, a stray quote — INSIDE one of
/// those can't end the interpolation early or be misread as a string opener — mutually recursive with
/// [`template_literal_end`], since the interpolation may itself hold a template.
fn skip_balanced_interpolation(chars: &[char], from: usize) -> usize {
    let n = chars.len();
    let mut i = from;
    let mut depth = 0i32; // `{` opened INSIDE this interpolation, beyond the one already consumed
    while i < n {
        match chars[i] {
            '\\' => i += 2,
            '{' => {
                depth += 1;
                i += 1;
            }
            '}' if depth == 0 => return i + 1,
            '}' => {
                depth -= 1;
                i += 1;
            }
            '`' => i = template_literal_end(chars, i),
            // A REGEX LITERAL can hold a quote character (`/'/g`, real shape from `aider.ts`, #149) that
            // is not a string opener at all — reading it as one desyncs everything scanned after it,
            // including a NESTED template a few characters later. `is_regex_context` disambiguates from
            // division the same way any hand-rolled JS scanner must: by what token precedes the `/`.
            '/' if is_regex_context(chars, i) => i = skip_regex_literal(chars, i),
            q @ ('\'' | '"') => {
                i += 1;
                while i < n && chars[i] != q {
                    if chars[i] == '\\' {
                        i += 1;
                    }
                    i += 1;
                }
                i = (i + 1).min(n);
            }
            _ => i += 1,
        }
    }
    n
}

/// Whether the `/` at `chars[slash_at]` opens a REGEX literal rather than dividing — decided the way any
/// small JS scanner must, since the grammar is genuinely ambiguous without a real parser: look back past
/// whitespace to the last significant character. A regex follows an operator/punctuator/opening bracket
/// (or nothing at all — the start of the interpolation); division follows an operand (an identifier,
/// digit, `)` or `]`).
fn is_regex_context(chars: &[char], slash_at: usize) -> bool {
    let mut j = slash_at;
    while j > 0 {
        j -= 1;
        if chars[j].is_whitespace() {
            continue;
        }
        return !(chars[j].is_ascii_alphanumeric() || matches!(chars[j], '_' | '$' | ')' | ']'));
    }
    true
}

/// The index just past a REGEX LITERAL opening at `chars[start]` (a `/` [`is_regex_context`] already
/// confirmed), including its trailing flags (`/…/g`). A `[…]` character class is tracked so a `/` INSIDE
/// one (`/[/]/`) does not end the literal early, mirroring how a real tokenizer reads one. An unterminated
/// literal (hits a newline first) bails at the newline — same "prose, not code" fallback the plain-quote
/// scanners in this file use for an unterminated `'`/`"`.
fn skip_regex_literal(chars: &[char], start: usize) -> usize {
    let n = chars.len();
    let mut i = start + 1; // past the opening `/`
    let mut in_class = false;
    while i < n {
        match chars[i] {
            '\\' => i += 2,
            '\n' => return i,
            '[' => {
                in_class = true;
                i += 1;
            }
            ']' => {
                in_class = false;
                i += 1;
            }
            '/' if !in_class => {
                i += 1;
                break;
            }
            _ => i += 1,
        }
    }
    while i < n && chars[i].is_ascii_alphabetic() {
        i += 1; // flags: g, i, m, s, u, y, d, v …
    }
    i
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

    /// #149: a checker that reads only the FIRST declarator reports `b` clean when `b` is the export a
    /// broken import actually needed.
    #[test]
    fn a_multi_declarator_const_exports_every_name() {
        let src = "export const a = 1, b = 2, c = f(1, 2);\n";
        assert_eq!(exported_names(src), vec!["a", "b", "c"]);
    }

    #[test]
    fn a_typed_multi_declarator_export_still_reads_every_name() {
        let src = "export let a: number = 1, b: string = \"x\";\n";
        assert_eq!(exported_names(src), vec!["a", "b"]);
    }

    /// #149, the real failure: a template literal containing a NESTED template literal inside a `${…}`
    /// interpolation. The naive scan reads the nested literal's own backtick as the outer one's close,
    /// desyncs, and silently drops every export that follows — `bsc ui doctor --imports` reported
    /// `aiderProvider` as unexported when the record plainly exports it, verbatim shape from `aider.ts`.
    #[test]
    fn a_template_literal_with_a_nested_template_in_its_interpolation_does_not_swallow_later_exports() {
        let src = "\
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\\\''`)}'`;
}

export const aiderProvider = { id: \"aider\" };
";
        assert_eq!(
            exported_names(src),
            vec!["aiderProvider"],
            "the nested backtick inside ${{…}} must not truncate the outer template literal early"
        );
    }

    #[test]
    fn a_single_declarator_const_is_unaffected() {
        let src = "export const Card = () => null;\n";
        assert_eq!(exported_names(src), vec!["Card"]);
    }

    #[test]
    fn a_destructured_export_declarator_is_skipped_not_misread() {
        let src = "export const { a, b } = obj, c = 1;\n";
        assert_eq!(exported_names(src), vec!["c"], "the destructured group is skipped; the plain one after it is not");
    }

    /// #149, the second real false positive from the live store: `recoverIssues.ts` has
    /// `bullet[1].replace(/`/g, "")` — a TOP-LEVEL regex literal (not inside a `${…}` interpolation) whose
    /// body is a single backtick. Before the top-level scan in `blank_comments_and_strings` understood
    /// regex context, that backtick was read as OPENING a template literal, and the naive close-search
    /// then ran to the NEXT backtick in the file — here, the one inside `` `#${gh.number}` `` several
    /// lines later — blanking every export in between, including `recoverIssue` and `recoverIssues`.
    #[test]
    fn a_top_level_regex_literal_holding_a_backtick_does_not_swallow_later_exports() {
        let src = "\
function parseIssueBody(raw: string) {
  return raw.replace(/`/g, \"\");
}

export function recoverIssue(gh: { number: number }) {
  const ref = `#${gh.number}`;
  return ref;
}

export function recoverIssues() {
  return [];
}
";
        assert_eq!(exported_names(src), vec!["recoverIssue", "recoverIssues"]);
    }

    #[test]
    fn star_reexport_specifiers_reads_plain_and_aliased_barrels() {
        let src = "export * from \"./sub\";\nexport * as NS from \"@/x/other\";\nexport const Real = 1;\n";
        assert_eq!(star_reexport_specifiers(src), vec!["./sub", "@/x/other"]);
    }

    #[test]
    fn star_reexport_specifiers_ignores_an_indented_or_non_barrel_star() {
        let src = "  export * from \"./nested\";\nexport const Ghost = 1; // export * from \"./nope\"\n";
        assert!(star_reexport_specifiers(src).is_empty());
    }

    #[test]
    fn star_reexport_specifiers_follows_a_type_only_barrel_too() {
        // A named import this checker judges may still ask a `export type * from` barrel for a type
        // (importing a type through a value-shaped clause is not type-erasable — see the note on
        // `clause_is_type_only`), so the barrel must be walked rather than treated as naming nothing.
        let src = "export type * from \"./types\";\nexport type * as NS from \"@/x/other\";\n";
        assert_eq!(star_reexport_specifiers(src), vec!["./types", "@/x/other"]);
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
