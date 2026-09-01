//! THE SHADOW CATALOGUE — `bsc ui shadow`, ported from `scripts/sync-shadow-catalogue.mjs`.
//!
//! Reconciles `src/app/runtime/shadowPages.ts` with what is actually on disk: an entry naming a file
//! that no longer exists becomes `file: null`, and the module's basename leaves the brace-expansion
//! glob that pairs with it.
//!
//! `file: null` is the DESIGNED end state, not a special case — it is what `fleetpage` has carried
//! since its files went in #3636, and it reads as "no file baseline", so only the binding half of the
//! shadow report applies. `shadowPages.test.ts` asserts both halves move together, because a declared
//! path the glob does not match ALSO loads as `null`, which would be indistinguishable from a
//! deliberate deletion.
//!
//! This is a sweep rather than a per-module step because doing it by hand failed on two tranches
//! running.

use std::sync::OnceLock;

/// The `/src/…` paths the catalogue declares, in source order.
pub fn declared(text: &str) -> Vec<String> {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#"file:\s*"(/src/[^"]+)""#).expect("declared"));
    re.captures_iter(text).map(|c| c[1].to_string()).collect()
}

/// Reconcile the catalogue text. `exists` is asked about a REPO-RELATIVE path (`src/…`, no leading
/// slash). Returns the new text and the declarations that were retired.
///
/// The caller decides whether to write, and MUST decide on the text having moved rather than on the
/// retirement count — see `sync_writes_when_the_text_moved_even_with_no_retirement`.
pub fn sync(text: &str, exists: impl Fn(&str) -> bool) -> (String, Vec<String>) {
    let retired: Vec<String> =
        declared(text).into_iter().filter(|p| !exists(p.trim_start_matches('/'))).collect();

    let mut out = text.to_string();
    for p in &retired {
        // `${1}`, not `$1`: `$1file` would parse as a group NAMED `1file` and expand to nothing,
        // silently deleting the `file: null` this whole sweep exists to write.
        let entry = regex::Regex::new(&format!(
            r#"(\{{\s*recordId:\s*"[^"]+",\s*)file:\s*"{}"(\s*\}})"#,
            regex::escape(p)
        ))
        .expect("entry");
        out = entry
            .replace(&out, "${1}file: null${2}, // RETIRED — the record is the only copy")
            .into_owned();

        // Out of the glob it pairs with. These are brace-expansion lists, so the module's basename is
        // one alternative among many: `{A,B,C}.tsx`. Drop the name and the separator it brought with
        // it. The JS used a LOOKAHEAD to leave the trailing `,`/`}` in place; Rust's regex has none,
        // so the trailing character is captured and put straight back.
        let name = p.rsplit('/').next().unwrap_or(p);
        let name = name.strip_suffix(".tsx").or_else(|| name.strip_suffix(".ts")).unwrap_or(name);
        let alt = regex::Regex::new(&format!(r"([{{,]){}([,}}])", regex::escape(name))).expect("alt");
        out = alt.replace(&out, "${1}${2}").into_owned();
    }

    (tidy(&out), retired)
}

/// The brace arithmetic the removals leave behind. Separated from `sync` because each rule here has
/// been wrong at least once and each is pinned by its own test.
fn tidy(text: &str) -> String {
    static LEAD: OnceLock<regex::Regex> = OnceLock::new();
    static TRAIL: OnceLock<regex::Regex> = OnceLock::new();
    static RUN: OnceLock<regex::Regex> = OnceLock::new();
    static LONE: OnceLock<regex::Regex> = OnceLock::new();
    static EMPTY: OnceLock<regex::Regex> = OnceLock::new();

    let lead = LEAD.get_or_init(|| regex::Regex::new(r"\{,").expect("lead"));
    let trail = TRAIL.get_or_init(|| regex::Regex::new(r",\}").expect("trail"));
    let run = RUN.get_or_init(|| regex::Regex::new(r",{2,}").expect("run"));

    // TO A FIXED POINT, which is the one place this DIVERGES from the script it replaces. The JS applied
    // the three exactly once each, in this order — so `{,,Gamma}`, which is what removing two adjacent
    // alternatives from the HEAD of a list produces, came out as `{,Gamma}`: still a brace list, with an
    // empty alternative, so the lone-unwrap below cannot fire and the glob goes on matching `.tsx`. Two
    // retirements from one directory is the ordinary tranche, not a corner. Bounded by the fact that
    // every rule strictly shortens the text.
    let mut out = text.to_string();
    loop {
        let next = run.replace_all(&trail.replace_all(&lead.replace_all(&out, "{"), "}"), ",").into_owned();
        if next == out {
            break;
        }
        out = next;
    }

    // A brace list worn down to ONE alternative does not expand — `{FocusedBodies}.tsx` matches
    // nothing, and the catalogue then reports its own entry as "declared, but the glob missed it".
    out = LONE
        .get_or_init(|| regex::Regex::new(r"\{([A-Za-z0-9_$.-]+)\}").expect("lone"))
        .replace_all(&out, "${1}")
        .into_owned();
    // ...and one worn down to NONE means every module under that directory is retired, so the whole
    // pattern goes rather than being left to match nothing.
    EMPTY
        .get_or_init(|| {
            regex::Regex::new(r#"(?m)^[ \t]*"[^"]*\{\}[^"]*",?[ \t]*\r?\n"#).expect("empty")
        })
        .replace_all(&out, "")
        .into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    const CAT: &str = r#"export const shadowPages = [
  { recordId: "alpha", file: "/src/app/pages/Alpha.tsx" },
  { recordId: "beta", file: "/src/app/pages/Beta.tsx" },
];
export const globs = ["/src/app/pages/{Alpha,Beta,Gamma}.tsx"];
"#;

    /// NON-VACUITY. A catalogue whose files all exist must come back BYTE-IDENTICAL — otherwise every
    /// assertion below could be satisfied by a sweep that mangles the file unconditionally.
    #[test]
    fn a_catalogue_with_nothing_retired_is_returned_unchanged() {
        let (out, retired) = sync(CAT, |_| true);
        assert!(retired.is_empty());
        assert_eq!(out, CAT, "an in-sync catalogue must not be rewritten");
    }

    #[test]
    fn a_retired_entry_becomes_file_null_and_leaves_the_glob() {
        let (out, retired) = sync(CAT, |p| p != "src/app/pages/Alpha.tsx");
        assert_eq!(retired, vec!["/src/app/pages/Alpha.tsx".to_string()]);
        assert!(out.contains(r#"{ recordId: "alpha", file: null }, // RETIRED"#), "{out}");
        // ...and its name is out of the glob, with the list still a valid expansion.
        assert!(out.contains("{Beta,Gamma}.tsx"), "{out}");
        // The entry that stayed is untouched.
        assert!(out.contains(r#"{ recordId: "beta", file: "/src/app/pages/Beta.tsx" }"#), "{out}");
    }

    /// A list worn down to ONE alternative does not expand: `{Gamma}.tsx` matches nothing, and the
    /// catalogue then reports its own surviving entry as "declared, but the glob missed it" — which is
    /// indistinguishable from a deliberate deletion.
    #[test]
    fn a_list_worn_down_to_one_alternative_unwraps() {
        let (out, _) = sync(CAT, |p| !p.ends_with("Alpha.tsx") && !p.ends_with("Beta.tsx"));
        assert!(out.contains("/src/app/pages/Gamma.tsx"), "the brace must be GONE, not `{{Gamma}}`: {out}");
        assert!(!out.contains('{') || !out.contains("Gamma}"), "{out}");
    }

    /// ...and one worn down to NONE means every module under that directory is retired, so the whole
    /// pattern line goes rather than staying as a glob that can never match.
    #[test]
    fn a_list_worn_down_to_nothing_drops_its_whole_pattern() {
        let cat = "export const globs = [\n  \"/src/app/pages/{Alpha}.tsx\",\n  \"/src/keep/{A,B}.tsx\",\n];\n";
        let text = cat.replace("{Alpha}", "{}");
        let out = tidy(&text);
        assert!(!out.contains("/src/app/pages/"), "the empty pattern's LINE must go: {out}");
        assert!(out.contains("/src/keep/{A,B}.tsx"), "and its neighbour must survive: {out}");
    }

    /// The three separator tidies, each on its own — `{,` and `,}` come from removing the first or last
    /// alternative, and a `,,` run from removing one in the middle.
    #[test]
    fn the_separator_tidies_each_fire() {
        assert_eq!(tidy("{,A,B}"), "{A,B}");
        assert_eq!(tidy("{A,B,}"), "{A,B}");
        assert_eq!(tidy("{A,,B}"), "{A,B}");
        assert_eq!(tidy("{A,,,B}"), "{A,B}");
        // ...and the fixed-point case the script got wrong: two alternatives removed from the HEAD.
        // The JS applied each rule once, leaving `{,Gamma}` — a list with an empty alternative, which
        // the lone-unwrap cannot reach and which goes on matching `.tsx`.
        assert_eq!(tidy("{,,Gamma}"), "Gamma", "the empty alternative must not survive");
        assert_eq!(tidy("{A,,}"), "A");
    }

    /// THE WRITE IS GATED ON THE TEXT, NEVER ON THE COUNT. An earlier run can leave a one-alternative
    /// `{X}` behind; gating the write on `retired.len()` made the re-run a no-op that reported success
    /// while the glob stayed broken.
    #[test]
    fn sync_writes_when_the_text_moved_even_with_no_retirement() {
        let cat = "export const globs = [\"/src/app/pages/{Alpha}.tsx\"];\n";
        let (out, retired) = sync(cat, |_| true);
        assert!(retired.is_empty(), "nothing is retired on this pass");
        assert_ne!(out, cat, "yet the text MOVED — the leftover brace was unwrapped");
        assert!(out.contains("/src/app/pages/Alpha.tsx"), "{out}");
    }

    #[test]
    fn declared_reads_every_path_in_source_order() {
        assert_eq!(
            declared(CAT),
            vec!["/src/app/pages/Alpha.tsx".to_string(), "/src/app/pages/Beta.tsx".to_string()]
        );
        // A `file: null` entry declares nothing and must not be reported as a path.
        assert!(declared(r#"{ recordId: "x", file: null }"#).is_empty());
    }
}
