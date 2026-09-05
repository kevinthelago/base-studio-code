//! What was said, and the bound on how much of it we keep.
//!
//! **Append-only JSONL, not a database.** MEASURED on eight real segments: transcript text averages
//! 190 bytes, about 310 with metadata — 60 KB a day at two hundred segments, 21.6 MB a year. The
//! audio those came from is **855 times** the size of its own transcript, and the two-hour window
//! already bounds the only thing that is genuinely large. Adding SQLite and VACUUM management to
//! bound 20 MB a year would be more machinery than the problem deserves, and a line per record stays
//! readable by anything.
//!
//! Bounded by BOTH rows and age, because either alone leaves a hole: a talkative week fills a row
//! budget while a silent month keeps last year's words.

use serde::{Deserialize, Serialize};

/// One thing that was said.
#[derive(Clone, PartialEq, Debug, Serialize, Deserialize)]
pub struct Transcript {
    /// The segment file this came from — the join back to audio, while the audio still exists.
    pub segment: String,
    /// When the speech started, unix ms. Taken from the segment name, so it survives the audio.
    pub started_unix_ms: i64,
    pub seconds: f32,
    /// What Whisper decided the language was. RECORDED, never assumed — it followed a mid-sentence
    /// switch to Portuguese unprompted, and a transcript that hides which language it is in cannot
    /// be searched or coached against.
    pub language: String,
    pub text: String,
    /// Whether a person in the room said this, or a speaker did. `None` where the pairing has no
    /// calibration — the same "unknown rather than a guess" the liveness check itself reports.
    pub live: Option<bool>,
}

/// What the store is allowed to hold.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize, Deserialize)]
pub struct Budget {
    pub max_rows: usize,
    pub max_age_ms: i64,
}

impl Default for Budget {
    /// A year of heavy use, and a hard row ceiling behind it. At the measured 310 bytes a row,
    /// 100_000 rows is about 31 MB — a bound chosen so the store cannot surprise anyone, not
    /// because anything is expected to reach it.
    fn default() -> Self {
        Budget { max_rows: 100_000, max_age_ms: 365 * 24 * 60 * 60 * 1000 }
    }
}

/// Which rows survive, oldest dropped first.
///
/// Pure, and both limits apply: a talkative week would fill the row budget while a silent month
/// would keep last year's words, so neither alone is a bound.
pub fn retain<'a>(rows: &'a [Transcript], now_unix_ms: i64, budget: &Budget) -> Vec<&'a Transcript> {
    let mut kept: Vec<&Transcript> = rows
        .iter()
        .filter(|r| now_unix_ms.saturating_sub(r.started_unix_ms) <= budget.max_age_ms)
        .collect();
    kept.sort_by_key(|r| r.started_unix_ms);
    if kept.len() > budget.max_rows {
        kept.drain(..kept.len() - budget.max_rows);
    }
    kept
}

/// Parse a JSONL store, skipping anything unreadable.
///
/// A corrupt line is SKIPPED rather than fatal. An append-only log can be truncated mid-write by a
/// power cut, and losing one line is not a reason to lose the other ninety-nine thousand — but the
/// count of skipped lines is returned so silent corruption cannot accumulate unnoticed.
pub fn parse(text: &str) -> (Vec<Transcript>, usize) {
    let mut out = Vec::new();
    let mut bad = 0usize;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<Transcript>(line) {
            Ok(t) => out.push(t),
            Err(_) => bad += 1,
        }
    }
    (out, bad)
}

/// Render rows back to JSONL.
pub fn render(rows: &[&Transcript]) -> Result<String, String> {
    let mut s = String::new();
    for r in rows {
        s.push_str(&serde_json::to_string(r).map_err(|e| format!("could not render a row: {e}"))?);
        s.push('\n');
    }
    Ok(s)
}

/// Recover the start time from a segment file name, `seg-<unix_ms>-<seq>.wav`.
pub fn started_from_name(name: &str) -> Option<i64> {
    name.strip_prefix("seg-")?.strip_suffix(".wav")?.split('-').next()?.parse().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(ms: i64, text: &str) -> Transcript {
        Transcript {
            segment: format!("seg-{ms}-001.wav"),
            started_unix_ms: ms,
            seconds: 3.0,
            language: "en".into(),
            text: text.into(),
            live: Some(true),
        }
    }
    const NOW: i64 = 1_800_000_000_000;
    const DAY: i64 = 24 * 60 * 60 * 1000;

    #[test]
    fn both_limits_bind_because_neither_alone_is_a_bound() {
        let rows: Vec<Transcript> = (0..10).map(|i| row(NOW - i * DAY, "x")).collect();
        // Row limit alone.
        let b = Budget { max_rows: 3, max_age_ms: 365 * DAY };
        assert_eq!(retain(&rows, NOW, &b).len(), 3, "a talkative week must hit the row ceiling");
        // Age limit alone.
        let b = Budget { max_rows: 100_000, max_age_ms: 4 * DAY };
        assert_eq!(retain(&rows, NOW, &b).len(), 5, "a silent month must not keep last year");
    }

    #[test]
    fn the_newest_survive_and_they_come_back_in_order() {
        let rows = vec![row(NOW - 5 * DAY, "old"), row(NOW, "new"), row(NOW - 2 * DAY, "mid")];
        let kept = retain(&rows, NOW, &Budget { max_rows: 2, max_age_ms: 365 * DAY });
        assert_eq!(kept.iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), vec!["mid", "new"]);
    }

    /// An append-only log can be truncated mid-write. Losing one line is not a reason to lose the
    /// rest — but the damage is COUNTED, so corruption cannot accumulate unnoticed.
    #[test]
    fn a_truncated_line_costs_one_row_not_the_file() {
        let good = serde_json::to_string(&row(NOW, "kept")).unwrap();
        let text = format!("{good}\n{{\"segment\":\"seg-1-1.wav\",\"star\n\n{good}\n");
        let (rows, bad) = parse(&text);
        assert_eq!(rows.len(), 2, "the intact lines survive");
        assert_eq!(bad, 1, "and the broken one is counted, not ignored");
    }

    #[test]
    fn a_row_round_trips_through_the_file_format() {
        let r = row(NOW, "hello there");
        let (back, bad) = parse(&render(&[&r]).unwrap());
        assert_eq!(bad, 0);
        assert_eq!(back, vec![r]);
    }

    #[test]
    fn a_start_time_is_recovered_from_the_segment_name() {
        assert_eq!(started_from_name("seg-1788616391508-001.wav"), Some(1_788_616_391_508));
        assert_eq!(started_from_name("notes.txt"), None);
        assert_eq!(started_from_name("seg-notanumber-001.wav"), None);
    }

    /// The default is a bound nobody should reach, not a prediction. At the measured 310 bytes a
    /// row it is about 31 MB — stated here so a future change to it is a deliberate one.
    #[test]
    fn the_default_budget_is_about_thirty_megabytes() {
        let b = Budget::default();
        let bytes = b.max_rows * 310;
        assert!(bytes > 25_000_000 && bytes < 40_000_000, "{} bytes", bytes);
        assert_eq!(b.max_age_ms, 365 * DAY);
    }

    #[test]
    fn an_empty_store_is_not_a_special_case() {
        assert!(retain(&[], NOW, &Budget::default()).is_empty());
        assert_eq!(parse(""), (vec![], 0));
        assert_eq!(render(&[]).unwrap(), "");
    }
}
