//! Turn a failed command's OUTPUT into a fault's title + detail.
//!
//! ## Why extraction, and not just "store the log"
//!
//! [`crate::fingerprint`] is `stage + normalized title + normalized FIRST stack line`. Handing it a raw
//! build log makes both halves volatile: the first line of a cargo build is whichever crate happened to
//! compile first, and the title would be whatever the log opened with. The same broken build would then
//! mint a new fault on every run, the count would never rise above 1, and the store would fill with
//! near-duplicates of one break. So the producer has to find the DIAGNOSTIC and hand that over.
//!
//! The rule the shape follows: **the title is the error, the location is the first detail line.** A file
//! path with a line number belongs in the detail, where `normalize_frame` masks its digits, and never in
//! the title, where a one-line edit above it would fork the fingerprint.
//!
//! ## Its sibling
//!
//! `src-tauri/src/observability/pty_faults.rs` scrapes faults out of a PTY stream for an app bsc did not
//! generate. It looks similar and is solving a different problem: it hunts RUNTIME shapes — panics,
//! stack traces, `at foo (app.js:1:1)` frames — in a stream that never ends. This reads COMPILER
//! diagnostics from output that has already terminated with a non-zero code. The two share the ANSI
//! strip and the caps, and are otherwise unrelated; unifying them is not obviously right and is
//! deliberately not attempted here.
//!
//! Everything in this module is pure — no I/O, no clock — so the signatures are testable directly.

/// Cap on a recorded title, mirroring the PTY tap's: one monster log line must not become a db row.
const TITLE_CAP: usize = 300;
/// How many lines of context ride along after the matched diagnostic.
const DETAIL_LINES: usize = 24;
/// Hard cap on the stored detail, so a pathological log cannot bloat the store.
const DETAIL_CAP: usize = 4000;

/// What a failed run is filed as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Detected {
    /// The fault title — the diagnostic itself, with any volatile location stripped off the front.
    pub title: String,
    /// The excerpt kept as the sample, starting AT the matched line so the fingerprint's frame is stable.
    pub detail: String,
}

/// Strip ANSI SGR/CSI escapes. Build tools colorize when they think they are on a terminal, and a raw
/// `\x1b[31m` in front of `error` defeats every `starts_with` below — the same reason the PTY tap
/// strips them.
pub fn strip_ansi(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == 0x1b {
            i += 1;
            // CSI … final byte in 0x40..=0x7e; anything else (a bare ESC) just drops the ESC.
            if i < b.len() && b[i] == b'[' {
                i += 1;
                while i < b.len() && !(0x40..=0x7e).contains(&b[i]) {
                    i += 1;
                }
                i += 1; // the final byte
            }
            continue;
        }
        // Rebuild from bytes only for ASCII; anything else is copied as part of the original char.
        let ch = s[i..].chars().next().unwrap_or('\u{fffd}');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// A `tsc` diagnostic — `src/x.ts(12,5): error TS2345: msg` — split into (location, message).
///
/// The location is the volatile half: it moves whenever a line is inserted above it, so it goes to the
/// detail and the message becomes the title. Returns `None` for anything that is not this shape.
fn split_tsc(line: &str) -> Option<(&str, &str)> {
    let at = line.find("): error TS").or_else(|| line.find("): warning TS"))?;
    let msg = line[at + 2..].trim_start();
    Some((&line[..at + 1], msg))
}

/// Is this line a cargo/rustc SUMMARY rather than the diagnostic itself?
///
/// `error: could not compile 'foo' (lib) due to 3 previous errors` is the last thing cargo prints, and
/// it names neither what broke nor where. Taking it as the title would file every failure of a crate
/// under one fault whose text changes with the error COUNT — the worst of both: it merges distinct
/// breaks and forks identical ones.
fn is_cargo_summary(t: &str) -> bool {
    t.starts_with("error: could not compile")
        || t.starts_with("error: aborting due to")
        || t.starts_with("error: build failed")
        || t.starts_with("error: process didn't exit successfully")
}

/// The diagnostic shapes worth filing, tested in order of specificity against each line.
fn match_line(t: &str) -> Option<String> {
    // rustc, with its error code — the most specific and most stable thing cargo emits.
    if t.starts_with("error[") {
        return Some(t.to_string());
    }
    // tsc — the message half only; the location rides in the detail.
    if let Some((_, msg)) = split_tsc(t) {
        return Some(msg.to_string());
    }
    // Bundler resolution failures: the class that retiring a module introduces, and the one
    // `dev-boot-check` already hunts by these exact words.
    for needle in [
        "Failed to resolve import",
        "Failed to resolve entry",
        "Rollup failed to resolve",
        "Could not resolve",
        "Failed to fetch dynamically imported module",
        "does not provide an export named",
        "Cannot find module",
        "Module not found",
    ] {
        if t.contains(needle) {
            return Some(t.to_string());
        }
    }
    // A bare rustc/cargo/tool `error:` — but never its summary line.
    if t.starts_with("error:") && !is_cargo_summary(t) {
        return Some(t.to_string());
    }
    // Node/JS typed throws, the shape a failing build script ends on.
    for prefix in ["Error:", "SyntaxError:", "TypeError:", "ReferenceError:", "RangeError:"] {
        if t.starts_with(prefix) {
            return Some(t.to_string());
        }
    }
    if t.contains("panicked at") {
        return Some(t.to_string());
    }
    None
}

/// Find the diagnostic in `output`, or `None` when nothing recognizable is there.
///
/// `None` is a real answer, not a failure: a command can exit non-zero having printed nothing at all
/// (a missing binary, a killed process), and the caller has something truthful to say about that which
/// this module cannot invent. Guessing a title from unstructured text would be worse than admitting it.
pub fn extract(output: &str) -> Option<Detected> {
    let clean = strip_ansi(output);
    let lines: Vec<&str> = clean.lines().collect();
    let (idx, title) = lines.iter().enumerate().find_map(|(i, l)| match_line(l.trim()).map(|t| (i, t)))?;

    // The detail STARTS at the matched line, so the fingerprint's frame is that line (digits masked)
    // rather than whatever the log happened to open with.
    let detail: String = lines[idx..]
        .iter()
        .take(DETAIL_LINES)
        .map(|l| l.trim_end())
        .collect::<Vec<_>>()
        .join("\n");

    Some(Detected { title: clip(&title, TITLE_CAP), detail: clip(&detail, DETAIL_CAP) })
}

/// Flatten to a single line (title) or keep the shape (detail), capped by CHARACTERS so a multi-byte
/// log can never split a UTF-8 boundary.
fn clip(s: &str, cap: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= cap {
        return t.to_string();
    }
    t.chars().take(cap).collect::<String>() + "…"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_ansi_so_a_colorized_error_still_matches() {
        let colored = "\u{1b}[1m\u{1b}[31merror[E0433]\u{1b}[0m: failed to resolve";
        assert_eq!(strip_ansi(colored), "error[E0433]: failed to resolve");
        let d = extract(colored).expect("a colorized diagnostic is still a diagnostic");
        assert!(d.title.starts_with("error[E0433]"), "{}", d.title);
        assert!(!d.title.contains('\u{1b}'), "no escape survives into the title");
    }

    /// The property the whole module exists for: the same break at a different line is ONE fault.
    #[test]
    fn the_same_break_fingerprints_the_same_after_an_edit_above_it() {
        let run1 = "   Compiling bsc-util v0.1.0\n   Compiling errordb v0.1.0\n\
                    error[E0433]: failed to resolve: use of undeclared crate `foo`\n \
                    --> crates/errordb/src/lib.rs:12:5\n\nerror: could not compile `errordb` due to 1 previous error";
        // A line inserted above moves the location and reorders the (irrelevant) Compiling lines.
        let run2 = "   Compiling errordb v0.1.0\n   Compiling bsc-util v0.1.0\n\
                    error[E0433]: failed to resolve: use of undeclared crate `foo`\n \
                    --> crates/errordb/src/lib.rs:97:9\n\nerror: could not compile `errordb` due to 4 previous errors";
        let a = extract(run1).unwrap();
        let b = extract(run2).unwrap();
        assert_eq!(a.title, b.title);
        assert_eq!(
            crate::fingerprint("compile", &a.title, Some(&a.detail)),
            crate::fingerprint("compile", &b.title, Some(&b.detail)),
            "a shifted line must not mint a second fault",
        );
    }

    /// ...and a DIFFERENT break is a different fault, which is the other half of being useful.
    #[test]
    fn a_different_break_is_a_different_fingerprint() {
        let a = extract("error[E0433]: failed to resolve: use of undeclared crate `foo`").unwrap();
        let b = extract("error[E0308]: mismatched types").unwrap();
        assert_ne!(
            crate::fingerprint("compile", &a.title, Some(&a.detail)),
            crate::fingerprint("compile", &b.title, Some(&b.detail)),
        );
    }

    /// The cargo summary is never the title. It names neither what broke nor where, and its text
    /// carries the error COUNT — so using it would merge distinct breaks AND fork identical ones.
    #[test]
    fn the_cargo_summary_line_is_never_taken_as_the_diagnostic() {
        let out = "error: could not compile `errordb` (lib) due to 2 previous errors";
        assert_eq!(extract(out), None, "a summary alone is not a diagnostic");
        // With a real diagnostic present, that one wins even though the summary also starts `error:`.
        let both = format!("error[E0308]: mismatched types\n --> a.rs:1:1\n{out}");
        assert!(extract(&both).unwrap().title.starts_with("error[E0308]"));
    }

    /// A tsc diagnostic puts its LOCATION first and its message after, so the split matters: the
    /// location is the volatile half and belongs in the detail.
    #[test]
    fn a_tsc_diagnostic_titles_on_the_message_and_keeps_the_location_in_the_detail() {
        let out = "src/app/x.ts(12,5): error TS2345: Argument of type 'string' is not assignable.";
        let d = extract(out).unwrap();
        assert_eq!(d.title, "error TS2345: Argument of type 'string' is not assignable.");
        assert!(d.detail.starts_with("src/app/x.ts(12,5)"), "the location rides in the detail: {}", d.detail);
        // Which means the same error at another line is the same fault.
        let moved = extract("src/app/x.ts(400,9): error TS2345: Argument of type 'string' is not assignable.").unwrap();
        assert_eq!(
            crate::fingerprint("typecheck", &d.title, Some(&d.detail)),
            crate::fingerprint("typecheck", &moved.title, Some(&moved.detail)),
        );
    }

    /// The bundler class — the failure retiring a module introduces, worded several ways.
    #[test]
    fn resolution_failures_are_recognized_however_the_bundler_words_them() {
        for line in [
            "[vite]: Rollup failed to resolve import \"@/app/runtime/appModules\" from \"src/main.tsx\".",
            "Failed to resolve import \"./gone\" from \"src/x.tsx\". Does the file exist?",
            "Error: Failed to fetch dynamically imported module: /src/app/runtime/appModules.ts",
            "SyntaxError: The requested module '/x.ts' does not provide an export named 'Spacer'",
        ] {
            assert!(extract(line).is_some(), "not recognized: {line}");
        }
    }

    /// Nothing recognizable is `None` — the caller says something true about an empty failure rather
    /// than this module inventing a title out of unstructured text.
    #[test]
    fn unrecognizable_output_is_none_rather_than_a_guess() {
        assert_eq!(extract(""), None);
        assert_eq!(extract("   Compiling foo v0.1.0\n    Finished in 3s\n"), None);
    }

    #[test]
    fn a_monster_line_is_capped_without_splitting_a_character() {
        let long = format!("error: {}", "é".repeat(5000));
        let d = extract(&long).unwrap();
        assert!(d.title.chars().count() <= TITLE_CAP + 1, "capped");
        assert!(d.detail.chars().count() <= DETAIL_CAP + 1);
    }
}
