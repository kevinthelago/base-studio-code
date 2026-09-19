/// Normalise a period bound: `YYYY`, `YYYY-MM`, or — for an end — `present`. A resume prints these, so
/// a malformed one is refused at write time rather than discovered on a rendered page.
pub fn parse_period(raw: &str, allow_present: bool) -> Result<String, String> {
    let s = raw.trim();
    if allow_present && s.eq_ignore_ascii_case("present") {
        return Ok("present".into());
    }
    let (year, month) = match s.split_once('-') {
        Some((y, m)) => (y, Some(m)),
        None => (s, None),
    };
    let year_ok = year.len() == 4 && year.bytes().all(|b| b.is_ascii_digit());
    let month_ok = match month {
        None => true,
        Some(m) => m.len() == 2 && matches!(m.parse::<u8>(), Ok(1..=12)),
    };
    if year_ok && month_ok {
        Ok(s.to_string())
    } else {
        let also = if allow_present { ", or present" } else { "" };
        Err(format!("`{raw}` is not a period — use YYYY or YYYY-MM{also}"))
    }
}
