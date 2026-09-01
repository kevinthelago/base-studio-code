//! THE RECORD↔FILE PROVENANCE RECONCILE — `bsc ui backing reconcile`, ported from
//! `scripts/reconcile-record-src.cjs`.
//!
//! WHY IT EXISTS. Deleting a migrated file whose record is the OLDER copy is a silent revert of real
//! work, with nothing to notice it. #4235 found that when a record and its file disagree, the FILE was
//! the newer copy in NINE OF NINE cases — including #3775's Tier-0 keyboard operability, which had
//! reached the files while the records still rendered pre-a11y markup. So every record's `src` has to be
//! resolved before ANY file in that set can be deleted, which is the gate in front of the whole
//! file-retirement track.
//!
//! IT READS THE SEED, not the store. `bsc ui backing audit` covers the store (what the running app
//! renders); this covers `data/components/app/**`, which is what ships to a fresh install. They are
//! DIFFERENT POPULATIONS — the store carries harvested and de-seeded records the seed has never held —
//! and a fix to one leaves the other wrong, so both are reported.
//!
//! It reports on every run and writes only under a flag, so the same command answers "what is wrong" and
//! "fix what can be fixed mechanically", and answers the first one again afterwards.

use std::collections::HashSet;

/// How many substantive lines the FILE's definition may hold that the record's does not, before "preview
/// parameterization" stops being a full explanation. Above this the record may ALSO be behind, and
/// annotating it would bury real staleness under a reason that is true but incomplete.
pub const BEHIND_MAX: usize = 8;
/// Below this the winner is not really "the same module".
pub const REPOINT_MIN: f64 = 0.35;
/// ...and it must be this many times the runner-up.
pub const REPOINT_LEAD: f64 = 1.5;
/// Required when the candidate does NOT define the record's symbol: 0.35 was too permissive by exactly
/// one case — `mcppage` re-pointed to a BARREL at 0.419, which shares a record's import block and little
/// else. `skillspage` scored similarly and was CORRECT, so the score alone cannot separate them.
pub const REPOINT_NOSYM: f64 = 0.55;
/// How close a record must still be to its file to count as describing it.
pub const DRIFT_MIN: f64 = 0.8;

/// The symbols a module exports, in FIRST-SEEN order.
///
/// Deliberately textual — this runs where esbuild cannot, and it only needs the NAMES. ORDER IS
/// LOAD-BEARING: [`record_symbol`] falls back to the first export, and the rename search takes the first
/// of equal scores, both of which a sorted set would silently change.
pub fn exported_symbols(src: &str) -> Vec<String> {
    static DECL: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static BRACE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let decl = DECL.get_or_init(|| {
        regex::Regex::new(
            r"export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)",
        )
        .expect("decl")
    });
    let brace = BRACE.get_or_init(|| regex::Regex::new(r"export\s*\{([^}]*)\}").expect("brace"));

    let mut out: Vec<String> = Vec::new();
    let mut push = |n: &str| {
        if !n.is_empty() && !out.iter().any(|x| x == n) {
            out.push(n.to_string());
        }
    };
    for c in decl.captures_iter(src) {
        push(&c[1]);
    }
    static AS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let as_re = AS.get_or_init(|| regex::Regex::new(r"\s+as\s+").expect("as"));
    for c in brace.captures_iter(src) {
        for part in c[1].split(',') {
            // `a as b` exports under `b` — the LAST segment is the exported name. Split on the same
            // `\s+as\s+` the JS uses, so a line-wrapped alias reads the same.
            let name = as_re.split(part.trim()).last().unwrap_or("").trim();
            push(name);
        }
    }
    out
}

fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    cs.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// A record's own component symbol — what it must still contain for the record to be describing the same
/// thing its `src` does.
///
/// `name` only counts if the RECORD ITSELF defines it. A MULTI-SYMBOL record is named for its MODULE, not
/// for any one export — `ui-charts` is called `Charts` while defining LineArea/Bars/Donut/HBars/Swimlane,
/// which are exactly `Charts.tsx`'s exports. Trusting the name there made the check look for a `Charts`
/// symbol that exists in neither side and report the record as MOVED, when its pointer is correct.
pub fn record_symbol(name: Option<&str>, src_text: &str) -> Option<String> {
    let own = exported_symbols(src_text);
    if let Some(n) = name.filter(|n| is_ident(n)) {
        if own.iter().any(|x| x == n) {
            return Some(n.to_string());
        }
    }
    own.first().cloned().or_else(|| name.filter(|n| is_ident(n)).map(str::to_string))
}

/// The "significant lines" of a module — the comparison unit for similarity. Short lines (`}`, `);`,
/// blanks) are dropped: they are identical in every React file and would float every score.
pub fn line_set(src: &str) -> HashSet<String> {
    src.lines().map(str::trim).filter(|t| t.chars().count() > 12).map(str::to_string).collect()
}

/// The comparison unit for a REGION: statements, not lines.
///
/// WHY NOT LINES. Two things that are not content differences were being counted as content —
/// REFORMATTING (`collapsiblecard` collapses its props interface onto one line where the file spreads it
/// over twelve) and COMMENTS (the file's JSDoc is documentation; a record dropping it is not drift).
/// `export` is stripped for the same reason: a record MUST export what it renders, while a file is free to
/// keep the same function private — `infochip` is byte-identical apart from that keyword.
pub fn stmt_set(src: &str) -> HashSet<String> {
    static BLOCK: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static LINE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static WS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let block = BLOCK.get_or_init(|| regex::Regex::new(r"(?s)/\*.*?\*/").expect("block"));
    // `(^|[^:])//…` — the `[^:]` keeps a `://` inside a URL from being read as a comment.
    let line = LINE.get_or_init(|| regex::Regex::new(r"(?m)(^|[^:])//[^\n]*").expect("line"));
    let ws = WS.get_or_init(|| regex::Regex::new(r"\s+").expect("ws"));

    let no_comments = line.replace_all(&block.replace_all(src, " "), "$1").into_owned();
    no_comments
        .split(['\n', ';'])
        .map(|piece| {
            let t = ws.replace_all(piece.trim(), " ").into_owned();
            t.strip_prefix("export ").map(str::to_string).unwrap_or(t)
        })
        .filter(|t| t.chars().count() > 12)
        .collect()
}

/// Jaccard overlap of two sets — 1.0 identical, 0.0 disjoint.
///
/// WHY SIMILARITY AND NOT SYMBOL MATCHING, for the rename case: the first cut looked for a file exporting
/// the record's symbol and reported "no candidate" for 40 of 44 stale pointers. `GitHubPulse.tsx` →
/// `Pulse.tsx` renamed the file AND the symbol. Content survives a rename; a name does not.
pub fn similarity(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let inter = a.iter().filter(|x| b.contains(*x)).count() as f64;
    inter / (a.len() as f64 + b.len() as f64 - inter)
}

/// How much of the RECORD still lives in the file: |A∩B| / |A|.
///
/// THIS, not Jaccard, is the drift measure. Many records are a component LIFTED OUT of a larger file, so
/// the file legitimately holds far more. Jaccard read that size gap as disagreement and flagged 205 of 384
/// records as drifted — mostly records perfectly faithful to the part of the file they describe.
pub fn containment(rec: &HashSet<String>, file: &HashSet<String>) -> f64 {
    if rec.is_empty() {
        return 1.0;
    }
    rec.iter().filter(|x| file.contains(*x)).count() as f64 / rec.len() as f64
}

/// The SOURCE REGION of one symbol's definition — from its keyword to the matching close brace.
///
/// WHY REGION-SCOPED COMPARISON IS THE ONLY HONEST DRIFT SIGNAL. A whole-file comparison cannot separate a
/// record that is STALE from one that differs BY CONSTRUCTION, and almost all of them differ by
/// construction: 72 of 143 whole-file "drifted" records VENDOR symbols the file merely imports, and most of
/// the rest are a small leaf lifted out of a large file.
pub fn symbol_region(src: &str, sym: Option<&str>) -> Option<String> {
    let sym = sym?;
    let re = regex::Regex::new(&format!(
        r"(?:^|\n)\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|class)\s+{}\b",
        regex::escape(sym)
    ))
    .ok()?;
    let start = re.find(src)?.start();

    // Find the BODY brace, not the first one. `function LogView({ paneId }: Props) {` opens a brace inside
    // the parameter list, and matching from there returns just the destructuring pattern — which scored 0.00
    // for 79 records and read as "the body changed completely" when nothing had.
    let mut parens = 0i32;
    let mut open: Option<usize> = None;
    for (i, c) in src[start..].char_indices() {
        match c {
            '(' => parens += 1,
            ')' => parens -= 1,
            '{' if parens == 0 => {
                open = Some(start + i);
                break;
            }
            ';' if parens == 0 => return Some(src[start..start + i + 1].to_string()),
            _ => {}
        }
    }
    let Some(open) = open else {
        let end = src.len().min(start + 400);
        let end = (end..=src.len()).find(|e| src.is_char_boundary(*e)).unwrap_or(src.len());
        return Some(src[start..end].to_string());
    };
    let mut depth = 0i32;
    for (i, c) in src[open..].char_indices() {
        if c == '{' {
            depth += 1;
        } else if c == '}' {
            depth -= 1;
            if depth == 0 {
                return Some(src[start..open + i + 1].to_string());
            }
        }
    }
    Some(src[start..].to_string())
}

/// The parameter list of a definition — everything between the first `(` and its matching `)`.
pub fn signature_of(region: &str) -> String {
    let Some(i) = region.find('(') else { return String::new() };
    let mut depth = 0i32;
    for (j, c) in region[i..].char_indices() {
        if c == '(' {
            depth += 1;
        } else if c == ')' {
            depth -= 1;
            if depth == 0 {
                return region[i..i + j + 1].to_string();
            }
        }
    }
    region[i..].to_string()
}

/// Parameter names the definition gives a DEFAULT value. Top level only: a default that is itself an
/// object/JSX literal must not have its inner commas read as further parameters.
pub fn defaulted_params(sig: &str) -> Vec<String> {
    let body = sig.strip_prefix('(').unwrap_or(sig);
    let body = body.strip_suffix(')').unwrap_or(body);
    let mut parts: Vec<String> = Vec::new();
    let (mut depth, mut start) = (0i32, 0usize);
    for (i, c) in body.char_indices() {
        if "([{<".contains(c) {
            depth += 1;
        } else if ")]}>".contains(c) {
            depth -= 1;
        } else if c == ',' && depth <= 1 {
            parts.push(body[start..i].to_string());
            start = i + 1;
        }
    }
    parts.push(body[start..].to_string());

    static A: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static B: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let a = A.get_or_init(|| regex::Regex::new(r"^\s*\{?\s*(\w+)\s*=").expect("a"));
    let b = B.get_or_init(|| regex::Regex::new(r"^\s*(\w+)\s*=").expect("b"));
    static LEAD: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let lead = LEAD.get_or_init(|| regex::Regex::new(r"^\s*\{").expect("lead"));
    let mut names: Vec<String> = Vec::new();
    for p in &parts {
        // Two reads of the same part, in the JS's order: the first tolerates a leading `{`, and the
        // fallback strips one before trying the tighter pattern.
        let found = a
            .captures(p)
            .map(|c| c[1].to_string())
            .or_else(|| b.captures(&lead.replace(p, "")).map(|c| c[1].to_string()));
        if let Some(n) = found {
            if !names.contains(&n) {
                names.push(n);
            }
        }
    }
    names
}

/// WHY THE RECORD AND THE FILE DISAGREE, when the answer is "by construction" and can be evidenced.
///
/// Returns `None` when the difference is NOT fully explained — either there is no added default, or the
/// file's definition still holds substantive lines the record lacks, which means the record may ALSO be
/// stale and needs a human. Annotating those would bury a real defect under a reason that is true but
/// incomplete.
pub fn divergence_reason(rec_region: &str, file_region: &str, sym: &str) -> Option<String> {
    static LIVE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static SAMPLE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let live = LIVE.get_or_init(|| {
        regex::Regex::new(r"\binvoke\s*\(|\buseAppStore\s*\(|\bsafeInvoke\s*\(|\bfireInvoke\s*\(")
            .expect("live")
    });
    let sample = SAMPLE.get_or_init(|| {
        regex::Regex::new(r"\b(?:SAMPLE|DEMO|MOCK)_[A-Z0-9_]+\b").expect("sample")
    });

    // ── CLASS 2: PREVIEW DATA SUBSTITUTION ────────────────────────────────────────────────────────
    // The preview mounts a record with no Tauri backend and no app store, so a record that called
    // `invoke(…)` or `useAppStore()` would throw on mount. Records swap the DATA layer for sample
    // constants while keeping the render layer.
    let markup = |r: &str| -> HashSet<String> {
        r.lines()
            .map(str::trim)
            .filter(|l| l.contains('<') && l.chars().count() > 12)
            .map(str::to_string)
            .collect()
    };
    let rec_samples: Vec<String> =
        sample.find_iter(rec_region).map(|m| m.as_str().to_string()).collect();
    let file_samples: HashSet<String> =
        sample.find_iter(file_region).map(|m| m.as_str().to_string()).collect();
    let mut own_samples: Vec<String> = Vec::new();
    for s in rec_samples {
        if !file_samples.contains(&s) && !own_samples.contains(&s) {
            own_samples.push(s);
        }
    }
    let goes_live = live.is_match(file_region) && !live.is_match(rec_region);
    if goes_live || !own_samples.is_empty() {
        let (rj, fj) = (markup(rec_region), markup(file_region));
        let jsx = similarity(&rj, &fj);
        // The honesty check is DIFFERENT from class 1's: the file's live-data lines are legitimately
        // absent, so a line count says nothing — but the RENDER layer should still agree. `tabstrip`
        // proves it, 21 record lines against 34, having gained tab-id identity the record never got.
        if jsx >= 0.6 {
            let what = if goes_live {
                "the file reaches live data (a Tauri `invoke` / the app store) where the record uses inert stand-ins".to_string()
            } else {
                format!(
                    "the record uses the sample constant(s) {}",
                    own_samples.iter().map(|s| format!("`{s}`")).collect::<Vec<_>>().join(", ")
                )
            };
            return Some(format!(
                "Deliberate, not stale — preview DATA SUBSTITUTION. In `{sym}`, {what}, because the \
                 preview mounts a record with no Tauri backend and no app store, so a live call would \
                 throw on mount. The RENDER layer still agrees ({:.0}% of markup lines shared), which is \
                 what says the divergence is confined to the data layer rather than the record being \
                 behind on UI. Refreshing from the file would import modules the loader cannot resolve \
                 and make the record un-previewable. Written by `bsc ui backing reconcile --annotate`.",
                jsx * 100.0
            ));
        }
        // The markup moved on too — so substitution is not a FULL explanation, but it may not be the only
        // thing going on. FALL THROUGH to class 1 rather than returning: `tablepage` carries DEMO_ ids,
        // failed the render gate, and is in fact a straightforward parameterization case. A record can be
        // parameterized AND sample-carrying; whichever class fires first must not veto the other.
    }

    // ── CLASS 1: PREVIEW PARAMETERIZATION ─────────────────────────────────────────────────────────
    let file_defaults = defaulted_params(&signature_of(file_region));
    let added: Vec<String> = defaulted_params(&signature_of(rec_region))
        .into_iter()
        .filter(|n| !file_defaults.contains(n))
        .collect();
    static LS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let ls = LS.get_or_init(|| regex::Regex::new(r"\b(loading|error)\b").expect("ls"));
    let states = ls.is_match(rec_region) && !ls.is_match(file_region);
    if added.is_empty() && !states {
        return None;
    }

    // Statements, not lines — `collapsiblecard` collapses its props interface onto one line where the file
    // spreads it over twelve, and counting lines pushed a pure-parameterization record past the threshold.
    let rec_stmts = stmt_set(rec_region);
    let behind = stmt_set(file_region)
        .iter()
        .filter(|t| !rec_stmts.contains(*t) && !t.starts_with("import "))
        .count();
    if behind > BEHIND_MAX {
        return None;
    }

    let mut bits: Vec<String> = Vec::new();
    if !added.is_empty() {
        bits.push(format!(
            "defaults {}",
            added.iter().map(|n| format!("`{n}`")).collect::<Vec<_>>().join(", ")
        ));
    }
    if states {
        bits.push("adds loading/error states".to_string());
    }
    // The residual is stated honestly. `behind` is under the threshold, NOT necessarily zero — and if the
    // file ever gained real behaviour, those lines are exactly where it would be.
    let residual = if behind == 0 {
        format!(
            "Region-scoped check: the file's `{sym}` holds NO substantive line the record lacks, so \
             nothing would be gained by refreshing and the parameterization would be lost."
        )
    } else {
        format!(
            "Region-scoped check: the file's `{sym}` holds {behind} substantive line(s) the record lacks \
             — under the {BEHIND_MAX}-line threshold at which parameterization stops being a full \
             explanation, so it is treated as explained. NOT zero, though: if this component ever gained \
             behaviour the record missed, those {behind} line(s) are where to look."
        )
    };
    Some(format!(
        "Deliberate, not stale — preview parameterization. The record's `{sym}` {}, so it renders \
         standalone in a preview that mounts records with no props; the file's takes them as required \
         props from its caller. {residual} Refreshing from the file would discard the parameterization. \
         Written by `bsc ui backing reconcile --annotate`.",
        bits.join(" and ")
    ))
}

/// One indexed source file.
pub struct SrcFile {
    pub rel: String,
    pub lines: HashSet<String>,
}

/// The best file for a record's content, and the runner-up — a re-point is only safe when the winner is
/// strong AND clearly ahead, so a near-tie is reported for a human rather than guessed at.
///
/// `files` is expected SORTED: the script inherited `readdirSync` order, which is unspecified, so a tie
/// resolved differently on two machines. Sorting makes the winner reproducible.
pub fn best_match(rec_lines: &HashSet<String>, files: &[SrcFile]) -> ((Option<String>, f64), (Option<String>, f64)) {
    let (mut best, mut second) = ((None, 0.0f64), (None, 0.0f64));
    for f in files {
        // Containment for the same reason drift uses it: a lifted record is fully inside a larger file.
        let score = containment(rec_lines, &f.lines);
        if score > best.1 {
            second = best;
            best = (Some(f.rel.clone()), score);
        } else if score > second.1 {
            second = (Some(f.rel.clone()), score);
        }
    }
    (best, second)
}

/// One record's verdict.
#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// `ok` · `null-src` · `stale-pointer` · `moved` · `drifted` · `intentional`.
    pub verdict: &'static str,
    pub symbol: Option<String>,
    pub score: Option<f64>,
    pub region: Option<f64>,
    pub by: Option<&'static str>,
    pub best: Option<String>,
    pub best_score: Option<f64>,
    pub runner_up: Option<String>,
    pub runner_up_score: Option<f64>,
    pub confident: bool,
    pub renamed_to: Option<String>,
    pub reason: Option<String>,
    /// The keys this verdict actually SETS, so `--json` emits the same shape the script did: it spread a
    /// per-verdict object, so a key a branch never set was ABSENT rather than null. A consumer that
    /// distinguishes the two would read every record as confident-false otherwise.
    pub keys: &'static [&'static str],
}

impl Verdict {
    fn of(verdict: &'static str, symbol: Option<String>) -> Self {
        Self {
            verdict,
            symbol,
            score: None,
            region: None,
            by: None,
            best: None,
            best_score: None,
            runner_up: None,
            runner_up_score: None,
            confident: false,
            renamed_to: None,
            reason: None,
            keys: &[],
        }
    }
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

fn defines(src: &str, sym: &str) -> bool {
    regex::Regex::new(&format!(r"\b(?:function|const|class)\s+{}\b", regex::escape(sym)))
        .map(|re| re.is_match(src))
        .unwrap_or(false)
        || exported_symbols(src).iter().any(|s| s == sym)
}

/// Classify one seed record. `read_file` returns a `src/`-relative file's text, or `None` when absent.
pub fn classify(
    name: Option<&str>,
    src: Option<&str>,
    src_text: &str,
    src_divergence: Option<&str>,
    files: &[SrcFile],
    read_file: &dyn Fn(&str) -> Option<String>,
) -> Verdict {
    let sym = record_symbol(name, src_text);
    let rec_lines = line_set(src_text);
    let src = src.map(str::trim).filter(|s| !s.is_empty());
    let Some(src) = src else { return Verdict::of("null-src", sym) };

    let Some(file_src) = read_file(src) else {
        // A RENAME is the usual cause, and content is what survives one.
        let (best, second) = best_match(&rec_lines, files);
        // A candidate that DEFINES the record's symbol is trusted at REPOINT_MIN; one that does not must
        // clear the higher bar, because a barrel shares a record's import block and scores on that alone.
        let def = match (best.0.as_deref(), sym.as_deref()) {
            (Some(rel), Some(s)) => read_file(rel).is_some_and(|c| defines(&c, s)),
            _ => false,
        };
        let floor = if def { REPOINT_MIN } else { REPOINT_NOSYM };
        let confident = best.0.is_some() && best.1 >= floor && best.1 >= second.1 * REPOINT_LEAD;
        let mut v = Verdict::of("stale-pointer", sym);
        v.keys = &["score", "best", "runnerUp", "runnerUpScore", "confident"];
        v.score = Some(round3(best.1));
        v.best = best.0;
        v.runner_up = second.0;
        v.runner_up_score = Some(round3(second.1));
        v.confident = confident;
        return v;
    };

    let score = containment(&rec_lines, &line_set(&file_src));
    if score >= DRIFT_MIN {
        let mut v = Verdict::of("ok", sym);
        v.keys = &["score"];
        v.score = Some(round3(score));
        return v;
    }
    if let Some(d) = src_divergence.filter(|d| !d.is_empty()) {
        let mut v = Verdict::of("intentional", sym);
        v.keys = &["score", "reason"];
        v.score = Some(round3(score));
        v.reason = Some(d.to_string());
        return v;
    }

    // MOVED vs DRIFTED — a distinction the score alone cannot make, and they need OPPOSITE remedies.
    // `folderglyph` points at a file that still exists while its symbol moved: re-point.
    // `teams-org-legend` points at a file where its symbol IS still there: refresh. Treating a move as
    // drift would refresh the record from a file that no longer describes it.
    let still_here = sym.as_deref().is_some_and(|s| defines(&file_src, s));

    // A RENAMED SYMBOL is not a moved one. The prefix-drop wave renamed exports as well as files
    // (`GitHubCrossRepoActivity` → `CrossRepoActivity`), and the record keeps its own name — so a lookup
    // BY NAME finds nothing and reads as "the component left this file" when the pointer is correct.
    if !still_here && !rec_lines.is_empty() {
        let (mut best_sym, mut best_score) = (None::<String>, 0.0f64);
        for cand in exported_symbols(&file_src) {
            let Some(region) = symbol_region(&file_src, Some(&cand)) else { continue };
            let s = similarity(&rec_lines, &line_set(&region));
            if s > best_score {
                best_score = s;
                best_sym = Some(cand);
            }
        }
        if let Some(bs) = best_sym.filter(|_| best_score >= 0.4) {
            let rec_region = symbol_region(src_text, sym.as_deref());
            let file_region = symbol_region(&file_src, Some(&bs));
            let r_score = match (&rec_region, &file_region) {
                (Some(r), Some(f)) => similarity(&stmt_set(r), &stmt_set(f)),
                _ => best_score,
            };
            let reason = match (&rec_region, &file_region, sym.as_deref()) {
                (Some(r), Some(f), Some(s)) => divergence_reason(r, f, s),
                _ => None,
            };
            let mut v =
                Verdict::of(if r_score >= DRIFT_MIN { "ok" } else { "drifted" }, sym);
            v.keys = &["renamedTo", "score", "region", "by", "reason"];
            v.renamed_to = Some(bs);
            v.score = Some(round3(score));
            v.region = Some(round3(r_score));
            v.by = Some("renamed-symbol");
            v.reason = reason;
            return v;
        }
    }

    if !still_here {
        let (best, second) = best_match(&rec_lines, files);
        let confident = best.0.as_deref().is_some_and(|b| b != src)
            && best.1 >= REPOINT_MIN
            && best.1 >= second.1 * REPOINT_LEAD;
        let mut v = Verdict::of("moved", sym);
        v.keys = &["score", "best", "bestScore", "runnerUp", "runnerUpScore", "confident"];
        v.score = Some(round3(score));
        v.best = best.0;
        v.best_score = Some(round3(best.1));
        v.runner_up = second.0;
        v.runner_up_score = Some(round3(second.1));
        v.confident = confident;
        return v;
    }

    // The symbol is in BOTH — so compare DEFINITION to DEFINITION. This is the only comparison not
    // swamped by vendoring and lifting, and it is what decides drift.
    let file_region = symbol_region(&file_src, sym.as_deref());
    let rec_region = symbol_region(src_text, sym.as_deref());
    if let (Some(f), Some(r)) = (&file_region, &rec_region) {
        let r_score = similarity(&stmt_set(r), &stmt_set(f));
        let mut v = Verdict::of(if r_score >= DRIFT_MIN { "ok" } else { "drifted" }, sym.clone());
        v.keys = if r_score >= DRIFT_MIN {
            &["score", "region", "by"]
        } else {
            &["score", "region", "by", "reason"]
        };
        v.score = Some(round3(score));
        v.region = Some(round3(r_score));
        v.by = Some("region");
        if r_score < DRIFT_MIN {
            v.reason = sym.as_deref().and_then(|s| divergence_reason(r, f, s));
        }
        return v;
    }
    let mut v = Verdict::of("drifted", sym);
    v.keys = &["score"];
    v.score = Some(round3(score));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(list: &[(&str, &str)]) -> Vec<SrcFile> {
        list.iter().map(|(rel, body)| SrcFile { rel: (*rel).to_string(), lines: line_set(body) }).collect()
    }
    /// A body long enough that its lines survive the >12-char floor `line_set` applies.
    fn body(sym: &str, extra: &str) -> String {
        format!(
            "export function {sym}() {{\n  const somethingWithLength = 1;\n  const anotherLongEnoughLine = 2;\n{extra}  return null;\n}}\n"
        )
    }

    /// NON-VACUITY: a record that still matches its file is `ok`.
    #[test]
    fn a_record_that_matches_its_file_is_ok() {
        let b = body("Thing", "");
        let read = |_: &str| Some(b.clone());
        let v = classify(Some("Thing"), Some("src/a/Thing.tsx"), &b, None, &[], &read);
        assert_eq!(v.verdict, "ok");
        assert_eq!(v.symbol.as_deref(), Some("Thing"));
    }

    /// `null-src` is the CONVENTION for a record with no file counterpart, not an error.
    #[test]
    fn a_record_with_no_src_is_null_src() {
        let read = |_: &str| None;
        for src in [None, Some(""), Some("   ")] {
            let v = classify(Some("Thing"), src, &body("Thing", ""), None, &[], &read);
            assert_eq!(v.verdict, "null-src", "src {src:?}");
        }
    }

    /// STALE POINTER, with the re-point decided by CONTENT — a rename changes the name, not the body.
    #[test]
    fn a_stale_pointer_repoints_confidently_only_on_a_strong_clear_winner() {
        let b = body("Thing", "");
        let idx = files(&[("src/a/Renamed.tsx", &b), ("src/a/Unrelated.tsx", "const x = 111111111111111;\n")]);
        let read = |rel: &str| (rel == "src/a/Renamed.tsx").then(|| b.clone());
        let v = classify(Some("Thing"), Some("src/a/Gone.tsx"), &b, None, &idx, &read);
        assert_eq!(v.verdict, "stale-pointer");
        assert_eq!(v.best.as_deref(), Some("src/a/Renamed.tsx"));
        assert!(v.confident, "a strong, clearly-leading match that DEFINES the symbol re-points: {v:?}");
    }

    /// ...and a TIE is reported for a human rather than guessed at.
    #[test]
    fn a_stale_pointer_with_two_equal_candidates_is_not_confident() {
        let b = body("Thing", "");
        let idx = files(&[("src/a/One.tsx", &b), ("src/a/Two.tsx", &b)]);
        let read = |_: &str| None;
        let v = classify(Some("Thing"), Some("src/a/Gone.tsx"), &b, None, &idx, &read);
        assert_eq!(v.verdict, "stale-pointer");
        assert!(!v.confident, "a near-tie must not re-point: {v:?}");
    }

    /// MOVED — the file resolves but the record's symbol is not in it. The remedy is the OPPOSITE of
    /// drift's: re-point, never refresh, or the record is rewritten from a file that no longer describes it.
    #[test]
    fn a_symbol_that_left_its_file_is_moved_not_drifted() {
        let rec_src = body("FolderGlyph", "");
        let other = "export function SomethingEntirelyDifferent() {\n  const nothingInCommonHere = 1;\n  return null;\n}\n";
        let idx = files(&[("src/a/RailFolderRow.tsx", &rec_src)]);
        let read = |rel: &str| {
            if rel == "src/a/RailTree.tsx" { Some(other.to_string()) } else { Some(rec_src.clone()) }
        };
        let v = classify(Some("FolderGlyph"), Some("src/a/RailTree.tsx"), &rec_src, None, &idx, &read);
        assert_eq!(v.verdict, "moved", "{v:?}");
    }

    /// DRIFTED — the symbol is in BOTH, and the definitions disagree.
    #[test]
    fn a_symbol_present_in_both_with_different_bodies_is_drifted() {
        // The record must hold lines the FILE LACKS — a file that is merely a SUPERSET is `ok`, because
        // containment asks whether the record still lives in the file, not whether the file grew.
        let rec_src = body("Thing", "  const recordOnlyLineRightHere = 3;\n  const anotherRecordOnlyOne = 4;\n");
        let file_src = body("Thing", "  const fileOnlyLineRightHere = 3;\n  const anotherFileOnlyOne = 4;\n");
        let read = |_: &str| Some(file_src.clone());
        let v = classify(Some("Thing"), Some("src/a/Thing.tsx"), &rec_src, None, &[], &read);
        assert_eq!(v.verdict, "drifted", "{v:?}");
        assert_eq!(v.by, Some("region"), "drift is decided REGION-scoped, not whole-file");

        // ...and the superset case really is `ok`, so the assertion above is about divergence rather
        // than about any two differing strings.
        let bigger = body("Thing", "  const theFileSimplyGrewHere = 9;\n");
        let grew = |_: &str| Some(bigger.clone());
        assert_eq!(
            classify(Some("Thing"), Some("src/a/Thing.tsx"), &body("Thing", ""), None, &[], &grew).verdict,
            "ok",
            "a file that only GREW has not drifted from the record"
        );
    }

    /// INTENTIONAL — drifted, with the reason recorded ON THE RECORD. The criterion is that the reason
    /// lives where a future sweep reads it, never only in a commit message.
    #[test]
    fn a_drifted_record_carrying_src_divergence_is_intentional() {
        let rec_src = body("Thing", "  const recordOnlyLineRightHere = 3;\n  const anotherRecordOnlyOne = 4;\n");
        let file_src = body("Thing", "  const fileOnlyLineRightHere = 3;\n  const anotherFileOnlyOne = 4;\n");
        let read = |_: &str| Some(file_src.clone());
        let v = classify(
            Some("Thing"),
            Some("src/a/Thing.tsx"),
            &rec_src,
            Some("Deliberate — preview parameterization."),
            &[],
            &read,
        );
        assert_eq!(v.verdict, "intentional");
        assert!(v.reason.is_some(), "the recorded reason is carried through");
    }

    /// A MULTI-SYMBOL record is named for its MODULE, not any one export. Trusting `name` there made the
    /// check look for a `Charts` symbol in neither side and report a correct pointer as MOVED.
    #[test]
    fn record_symbol_falls_through_a_name_the_record_does_not_define() {
        let src = "export function LineArea() {}\nexport function Bars() {}\n";
        assert_eq!(record_symbol(Some("Charts"), src).as_deref(), Some("LineArea"));
        // ...and it TAKES the name when the record really defines it.
        assert_eq!(record_symbol(Some("Bars"), src).as_deref(), Some("Bars"));
    }

    /// `stmt_set` must see through REFORMATTING and COMMENTS, and past the `export` keyword — a record
    /// MUST export what it renders while a file may keep it private (`infochip` is exactly that).
    #[test]
    fn stmt_set_ignores_comments_reformatting_and_the_export_keyword() {
        let a = stmt_set("export const somethingLongEnough = 1;\n// a comment about it\n");
        let b = stmt_set("/** JSDoc instead */\nconst somethingLongEnough = 1;\n");
        assert_eq!(a, b, "comments and `export` are not content");
        // A `://` inside a URL is not a line comment.
        assert!(
            stmt_set("const u = \"https://example.com/aLongEnoughPath\";").iter().any(|t| t.contains("https")),
            "a URL must survive comment stripping"
        );
    }

    /// The body brace is the first `{` at PAREN DEPTH 0 — matching from the first brace returns just the
    /// destructuring pattern, which scored 0.00 for 79 records and read as a total rewrite.
    #[test]
    fn symbol_region_finds_the_body_brace_not_a_destructured_parameter() {
        let src = "export function LogView({ paneId }: Props) {\n  const inner = 1;\n}\n";
        let r = symbol_region(src, Some("LogView")).expect("region");
        assert!(r.contains("const inner = 1;"), "the BODY must be in the region: {r}");
    }

    #[test]
    fn containment_and_similarity_answer_different_questions() {
        let small: HashSet<String> = ["aaaaaaaaaaaaaaa".to_string()].into_iter().collect();
        let large: HashSet<String> =
            ["aaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbb", "ccccccccccccccc"].iter().map(|s| s.to_string()).collect();
        // A record fully inside a much larger file is fully CONTAINED...
        assert_eq!(containment(&small, &large), 1.0);
        // ...while Jaccard reads the size gap as disagreement, which flagged 205 of 384 records.
        assert!(similarity(&small, &large) < 0.4);
        // An empty record is vacuously contained rather than 0/0.
        assert_eq!(containment(&HashSet::new(), &large), 1.0);
    }
    /// THE RETIRE REWRITE'S KEY ORDER, which no verdict test can see and which a real-file comparison
    /// caught: with `preserve_order` on, `Map::remove` is a SWAP-remove — it moves the LAST entry into the
    /// removed slot, so appending `srcRetired` and then removing `src` put the new key where the old one
    /// had been. The record is equivalent; the FILE is not, and every seed retired before this carries
    /// `srcRetired` at the END, so a swap would leave two conventions in one tree.
    #[test]
    fn retiring_a_pointer_appends_src_retired_and_shift_removes_src() {
        let mut rec: serde_json::Value = serde_json::from_str(
            r#"{"id":"a","src":"src/a/Gone.tsx","folder":"app","feature":"shell"}"#,
        )
        .expect("json");
        rec["srcRetired"] = serde_json::Value::String("src/a/Gone.tsx".into());
        rec.as_object_mut().expect("obj").shift_remove("src");

        let keys: Vec<&str> = rec.as_object().expect("obj").keys().map(String::as_str).collect();
        assert_eq!(keys, vec!["id", "folder", "feature", "srcRetired"], "srcRetired belongs LAST");

        // ...and the swap the bug used would have produced this instead, which is what to compare against.
        let mut swapped: serde_json::Value = serde_json::from_str(
            r#"{"id":"a","src":"src/a/Gone.tsx","folder":"app","feature":"shell"}"#,
        )
        .expect("json");
        swapped["srcRetired"] = serde_json::Value::String("src/a/Gone.tsx".into());
        swapped.as_object_mut().expect("obj").remove("src");
        let swapped_keys: Vec<&str> =
            swapped.as_object().expect("obj").keys().map(String::as_str).collect();
        assert_ne!(swapped_keys, keys, "if these ever agree, `remove` stopped swapping and this guard is moot");
    }
}
