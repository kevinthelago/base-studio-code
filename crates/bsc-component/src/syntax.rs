//! Module-syntax gate (#2928) — a targeted, low-false-positive lexical check that rejects the
//! escape-collapse corruption class: an UNTERMINATED string literal (a `'`/`"` string with a raw,
//! unescaped newline before its close, or one left open at EOF). Run at `bsc ui set` time on a `srcText`
//! that claims to be a module (`looks_buildable_module`), so a silently-corrupted component source can't
//! be stored (the failure the designer session hit: a `\n` that collapsed into a real newline inside a
//! `.join("…")` string, stored without complaint, only caught later at preview-build time).
//!
//! It tracks string / template / line-comment / block-comment / regex-literal state so a quote inside a
//! comment, template literal, or regex is never mistaken for a string start. It is NOT a full parser —
//! deliberately a small, high-confidence check; a fuller build validation is `bsc ui preview-check` (a
//! separate issue). Known limitation: a regex literal in EXPRESSION position is recognised by the
//! preceding significant char, so `return /re/`-style keyword-then-regex isn't specially handled (rare
//! in component code, and only matters if such a regex also contains an unbalanced quote).

/// Reject `src` if it contains an unterminated string / template / comment / regex literal, naming the
/// 1-based line it opened on. `Ok(())` when the source is lexically well-formed at the token level.
pub fn check_module_syntax(src: &str) -> Result<(), String> {
    let chars: Vec<char> = src.chars().collect();
    let n = chars.len();
    let mut i = 0usize;
    let mut line = 1usize;
    // The last significant (non-whitespace, non-comment) char — decides whether a `/` starts a regex
    // (expression position) or is division (right after a value: an identifier char, `)` or `]`).
    let mut last_sig: Option<char> = None;
    // `}` counts as a value end: it closes an object literal, a block-bodied arrow, or — the case that
    // matters here — a JSX EXPRESSION CONTAINER, all of which are values. So the `/` in
    // `{approvedCount}/{declared.length}` is division, not the start of a regex that then runs to the
    // newline and false-rejects the module.
    let is_value_end =
        |c: char| c.is_alphanumeric() || c == '_' || c == '$' || c == ')' || c == ']' || c == '}';

    while i < n {
        let c = chars[i];
        match c {
            '\n' => {
                line += 1;
                i += 1;
            }
            c if c.is_whitespace() => i += 1,
            // line comment → to end of line (its content, incl. quotes/apostrophes, is inert)
            '/' if i + 1 < n && chars[i + 1] == '/' => {
                i += 2;
                while i < n && chars[i] != '\n' {
                    i += 1;
                }
            }
            // block comment → to `*/`
            '/' if i + 1 < n && chars[i + 1] == '*' => {
                let start = line;
                i += 2;
                loop {
                    if i >= n {
                        return Err(format!("unterminated block comment starting at line {start}"));
                    }
                    if chars[i] == '\n' {
                        line += 1;
                        i += 1;
                    } else if chars[i] == '*' && i + 1 < n && chars[i + 1] == '/' {
                        i += 2;
                        break;
                    } else {
                        i += 1;
                    }
                }
            }
            // regex literal (in expression position) → to the closing unescaped `/` outside a char class.
            // Two JSX slashes are NOT regexes and are excluded, else the `/` opens a "regex" that runs to
            // the newline and false-rejects the whole module:
            //   • `</div>` / `</>` — the `/` sits right after `<` (a closing tag / fragment, #2991).
            //   • `<div … />`      — a self-closing `/>` (the `/` is followed by `>`, #3045). This bites
            //     after a `"…"` / `{…}` attribute, whose last significant char is `"`/`}` (a non-value),
            //     so the `/` read as expression-position — the "unterminated regular expression" the
            //     designer session hit on EVERY JSX-module component (d3 `<rect/>`/`<path/>`, Button, …).
            // A genuine `< /re/` (compare-to-regex) keeps its space, and a literal `/>x/` regex is
            // vanishingly rare in component code, so both exclusions are safe + low-false-positive.
            '/' if last_sig.is_none_or(|p| !is_value_end(p))
                && !(i > 0 && chars[i - 1] == '<')
                && !(i + 1 < n && chars[i + 1] == '>') =>
            {
                let start = line;
                i += 1;
                let mut in_class = false;
                loop {
                    if i >= n {
                        return Err(format!("unterminated regular expression starting at line {start}"));
                    }
                    match chars[i] {
                        '\n' => return Err(format!("unterminated regular expression starting at line {start}")),
                        '\\' => i += 2, // escape: skip the next char
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
                last_sig = Some('/'); // a regex is a value → a following `/` is division
            }
            // An APOSTROPHE IN PROSE, not a string opener. A quote directly after a value end —
            // `you've`, `the repo's`, `can't`, `{source}'s` — cannot start a string literal, because
            // `identifier'…'` / `}'…'` is not valid JS in any position. It is JSX TEXT, where a quote is
            // an ordinary character. Without this the quote opens a string that runs to the newline and
            // false-rejects the whole module — the failure that kept five packaged records out of the
            // store entirely, since a record that cannot be WRITTEN can never be seeded or rendered.
            //
            // Deliberately narrower than a JSX-text state machine. Distinguishing `<div>` from a generic
            // `Map<string, number>` needs a real parser, and guessing wrong there would make the scanner
            // SKIP real code — trading these false positives for false negatives, which is the worse
            // direction for a corruption gate. This rule only ignores positions where a string literal
            // is syntactically impossible, so it cannot hide corruption.
            // ADJACENCY IS THE WHOLE RULE — it must be the IMMEDIATELY preceding character, not
            // `last_sig`, which skips whitespace. `last_sig` would see the `m` of `from` in
            // `import … from "@/x"` as a value end, stop treating the module path as a string, walk into
            // it, and read its `/` as a regex — false-rejecting 30 further records. A keyword before a
            // string always has whitespace; an apostrophe in prose never does.
            // `>` is included because a tag close is the other thing prose follows — `</b>'s blueprints`.
            // It is NOT added to `is_value_end` itself: that would make `x => /re/.test(x)` stop reading
            // as a regex, turning a false positive into a missed one. And an ARROW is excluded here for
            // the same care in the other direction, so a space-less `() =>'x'` still scans as a string.
            '"' | '\''
                if i > 0
                    && (is_value_end(chars[i - 1])
                        || (chars[i - 1] == '>' && !(i > 1 && chars[i - 2] == '='))) =>
            {
                last_sig = Some(c);
                i += 1;
            }
            // string literal — the corruption target: a raw newline before the close is unterminated
            '"' | '\'' => {
                let quote = c;
                let start = line;
                i += 1;
                loop {
                    if i >= n {
                        return Err(format!("unterminated string literal starting at line {start}"));
                    }
                    match chars[i] {
                        '\\' => {
                            // escape: consume the next char; a backslash-newline is a line continuation
                            if i + 1 < n && chars[i + 1] == '\n' {
                                line += 1;
                            }
                            i += 2;
                        }
                        '\n' => return Err(format!("unterminated string literal starting at line {start}")),
                        d if d == quote => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
                last_sig = Some(quote);
            }
            // template literal — MAY span newlines (backticks); only an open-at-EOF is unterminated
            '`' => {
                let start = line;
                i += 1;
                loop {
                    if i >= n {
                        return Err(format!("unterminated template literal starting at line {start}"));
                    }
                    match chars[i] {
                        '\\' => {
                            if i + 1 < n && chars[i + 1] == '\n' {
                                line += 1;
                            }
                            i += 2;
                        }
                        '\n' => {
                            line += 1;
                            i += 1;
                        }
                        '`' => {
                            i += 1;
                            break;
                        }
                        _ => i += 1,
                    }
                }
                last_sig = Some('`');
            }
            other => {
                if !other.is_whitespace() {
                    last_sig = Some(other);
                }
                i += 1;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_well_formed_module() {
        let src = r#"
            import { useState } from "react";
            // a comment with an apostrophe: it's fine
            export function C({ title }: { title: string }) {
              const s = "a \"quoted\" value";
              const t = `line one
line two ${title}`;
              const re = /['"]/g; // regex with quotes must NOT be read as a string
              return <div className="x">{title}{s}{t}{String(re)}</div>;
            }
        "#;
        assert!(check_module_syntax(src).is_ok());
    }

    // ── JSX PROSE (the third instance of the JSX-false-positive class, after #2991 + #3045) ──────────
    // Five packaged records were kept OUT OF THE STORE ENTIRELY by these, because a record that cannot
    // be written can never be seeded, and `bsc ui parity` reported them as `missingFromStore`.

    #[test]
    fn an_apostrophe_in_jsx_text_is_not_a_string_opener() {
        // Real cases, verbatim from the records the gate refused.
        for src in [
            r#"export const C = () => <li>everything you've planned (goal, scope, …)</li>;"#,
            r#"export const C = () => <p>deps reconcile into the repo's single package.json</p>;"#,
            r#"export const C = () => <p>the name is the project's identity</p>;"#,
            r#"export const C = () => <p>so two can't share it.</p>;"#,
        ] {
            assert!(check_module_syntax(src).is_ok(), "false-rejected: {src}");
        }
    }

    #[test]
    fn an_apostrophe_after_a_closing_tag_is_not_a_string_opener() {
        let src = r#"export const C = ({ source }) => <p>All of <b>{source}</b>'s blueprints are downloaded.</p>;"#;
        assert!(check_module_syntax(src).is_ok(), "{:?}", check_module_syntax(src));
    }

    #[test]
    fn an_arrow_before_a_string_still_opens_a_string() {
        // `>` counts as prose-adjacent only when it is a TAG close. A space-less arrow must not be
        // mistaken for one, or `() =>'unterminated` would stop being caught.
        assert!(check_module_syntax("const f = () =>'ok';").is_ok());
        assert!(check_module_syntax("const f = () =>'unterminated\n;").is_err());
    }

    #[test]
    fn an_apostrophe_after_a_jsx_expression_container_is_not_a_string_opener() {
        let src = r#"export const C = ({ source }) => <span>fetching {source}'s blueprints…</span>;"#;
        assert!(check_module_syntax(src).is_ok(), "{:?}", check_module_syntax(src));
    }

    #[test]
    fn a_slash_between_two_jsx_expression_containers_is_division_not_a_regex() {
        let src = r#"export const C = ({ a, b }) => <span>{a}/{b} approved</span>;"#;
        assert!(check_module_syntax(src).is_ok(), "{:?}", check_module_syntax(src));
    }

    // ── …AND THE GATE DID NOT JUST GET WEAKER ────────────────────────────────────────────────────────
    // The whole point of #2928 is the escape-collapse class: a `\n` that collapsed into a REAL newline
    // inside a string. If the rules above had been written loosely, these would now pass — which would
    // trade a visible false positive for a silent false negative, the worse failure for a corruption gate.

    #[test]
    fn still_rejects_the_escape_collapse_corruption_it_exists_for() {
        let src = "export const s = [\"one\", \"two\"].join(\"\nthe newline collapsed here\");";
        assert!(check_module_syntax(src).is_err(), "the #2928 corruption must still be caught");
    }

    #[test]
    fn still_rejects_an_unterminated_string_in_ordinary_expression_position() {
        // `(` is not a value end, so the quote still opens a string — and still runs to the newline.
        let src = "export function f() {\n  return g('unterminated\n}";
        assert!(check_module_syntax(src).is_err());
    }

    #[test]
    fn a_keyword_before_a_string_still_opens_a_string() {
        // The regression the first cut of this fix caused: `last_sig` skips whitespace, so the `m` of
        // `from` read as a value end, the module path stopped being a string, and the scanner walked into
        // it and called its `/` a regex — 30 extra records false-rejected. Adjacency is what separates
        // `you've` from `from "…"`.
        assert!(check_module_syntax("import { X } from \"@/shared/ui/layout/Box\";\nexport const a = 1;").is_ok());
        for src in [
            "const a = typeof 'x';",
            "export function f() { return 'x'; }",
            "switch (k) { case 'a': break; }",
        ] {
            assert!(check_module_syntax(src).is_ok(), "false-rejected: {src}");
        }
        // …and one that is genuinely broken in the same shape must STILL fail.
        assert!(check_module_syntax("import { X } from \"@/unterminated\nexport const a = 1;").is_err());
    }

    #[test]
    fn a_quote_after_an_operator_or_paren_still_opens_a_string() {
        // The new rule must not swallow ordinary string starts: `=`, `(`, `,`, `[` are not value ends.
        for src in [
            "const a = 'unterminated\n;",
            "f('unterminated\n);",
            "const a = ['ok', 'unterminated\n];",
        ] {
            assert!(check_module_syntax(src).is_err(), "should still reject: {src}");
        }
    }

    #[test]
    fn jsx_closing_tag_is_not_read_as_a_regex() {
        // The `/` in `</div>` sits right after `<`, so the old check opened a "regex" that ran to the
        // newline and false-rejected the module (#2991). A closing tag / `</>` fragment must be inert.
        assert!(check_module_syntax("export const C = () => <div>{x}</div>;\n").is_ok());
        assert!(check_module_syntax("export const F = () => <>{x}</>;\n").is_ok(), "fragment close too");
        // A genuine regex (space before `/`) still parses; a real unterminated string still rejects.
        assert!(check_module_syntax("export const re = /a\\/b/g;\nexport const y = 1;\n").is_ok());
        assert!(check_module_syntax("export const s = \"oops\n\";\n").is_err(), "still catches the corruption");
    }

    #[test]
    fn jsx_self_closing_tag_is_not_read_as_a_regex() {
        // #3045: a self-closing `/>` after a `"…"` / `{…}` attribute (a non-value last significant char)
        // was misread as a regex that ran to EOF → "unterminated regular expression" — the exact failure
        // that made `bsc ui set` reject EVERY JSX-module component. All of these must now parse clean:
        assert!(check_module_syntax("export function T(){ return <div className=\"x\" />; }\n").is_ok(), "the reported repro");
        assert!(check_module_syntax("export const I = () => <img src=\"x\"/>;\n").is_ok(), "no space before />");
        assert!(check_module_syntax("export const R = () => <rect x=\"0\" width=\"4\" />;\n").is_ok(), "d3 self-closing SVG");
        assert!(check_module_syntax("export const S = () => <Comp {...props} />;\n").is_ok(), "spread attr then />");
        // The fix must NOT weaken the real checks: a genuine regex still parses, and an unterminated
        // string inside a JSX module is still caught (before the `/>`).
        assert!(check_module_syntax("export const re = /[0-9]+/g;\nexport const A = () => <b/>;\n").is_ok());
        assert!(check_module_syntax("export const C = () => <div title=\"oops\n\" />;\n").unwrap_err().contains("unterminated string"));
    }

    #[test]
    fn rejects_the_escape_collapse_corruption_naming_the_line() {
        // The exact failure class: a `\n` collapsed into a real newline inside a `.join("…")` string.
        let src = "export const rows = [1, 2, 3];\nexport const s = rows.join(\"\n\");\n";
        let err = check_module_syntax(src).unwrap_err();
        assert!(err.contains("unterminated string literal"), "got: {err}");
        assert!(err.contains("line 2"), "should name the offending line; got: {err}");
    }

    #[test]
    fn rejects_a_string_left_open_at_eof() {
        assert!(check_module_syntax("const s = \"abc").unwrap_err().contains("unterminated string"));
        assert!(check_module_syntax("const s = 'abc").unwrap_err().contains("unterminated string"));
    }

    #[test]
    fn allows_a_template_literal_spanning_newlines() {
        assert!(check_module_syntax("const t = `a\nb\nc`;").is_ok());
    }

    #[test]
    fn a_quote_inside_a_comment_or_regex_is_not_a_string() {
        assert!(check_module_syntax("// don't treat this apostrophe as a string\nconst x = 1;").is_ok());
        assert!(check_module_syntax("/* it's a block 'comment' */\nconst x = 1;").is_ok());
        assert!(check_module_syntax("const m = str.match(/[\"']/);").is_ok());
    }

    #[test]
    fn division_after_a_value_is_not_a_regex() {
        // `a / b` — the `/` is division; the trailing `'x'` string is still checked + balanced.
        assert!(check_module_syntax("const r = a / b; const s = 'x';").is_ok());
        // a broken string AFTER a division still gets caught.
        assert!(check_module_syntax("const r = a / b; const s = 'x\n';").unwrap_err().contains("unterminated string"));
    }
}
