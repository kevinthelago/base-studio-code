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
    let is_value_end = |c: char| c.is_alphanumeric() || c == '_' || c == '$' || c == ')' || c == ']';

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
            // regex literal (in expression position) → to the closing unescaped `/` outside a char class
            '/' if last_sig.is_none_or(|p| !is_value_end(p)) => {
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
