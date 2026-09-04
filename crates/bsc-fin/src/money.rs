//! MONEY IS AN INTEGER COUNT OF MINOR UNITS, NEVER A FLOAT.
//!
//! `0.1 + 0.2` is not a rounding curiosity in a currency: it is a balance that disagrees with itself
//! and a total that fails reconciliation for reasons nobody can see in the numbers. The Rust half of
//! the rule the `finance-money.ts` record states for the frontend — same model, same guarantee, so a
//! figure means the same thing whichever side computes it.

/// A signed amount in minor units — cents for USD. Currency is carried alongside by the row.
pub type Minor = i64;

/// Parse a human-written amount into MINOR UNITS, without ever constructing a float.
///
/// Statements write money a dozen ways and every one of them appears in the four institutions this
/// targets: `1234.56`, `$1,234.56`, `-1234.56`, `(1234.56)` for a credit, `1234.56-` trailing-sign,
/// and a bare `1234` meaning whole units.
///
/// PARSED AS TEXT, DIGIT BY DIGIT. `"0.07".parse::<f64>() * 100.0` is `7.000000000000001`, and
/// rounding that back is a coin flip on the boundary — so the fractional part is read as an integer
/// and scaled, and the value is exact by construction.
pub fn parse_minor(raw: &str) -> Result<Minor, String> {
    let t = raw.trim();
    if t.is_empty() {
        return Err("empty amount".into());
    }
    // Accounting parentheses mean negative, and may wrap the sign or the symbol.
    let (t, paren) = match (t.strip_prefix('('), t.strip_suffix(')')) {
        (Some(inner), _) if t.ends_with(')') => (inner.trim_end_matches(')'), true),
        _ => (t, false),
    };
    // A TRAILING sign is a real convention (`1234.56-`), and reading it as a stray character would
    // silently flip a refund into a charge.
    let (t, trailing_neg) = match t.strip_suffix('-') {
        Some(rest) => (rest.trim(), true),
        None => (t, false),
    };
    let mut neg = paren || trailing_neg;

    let mut digits = String::new();
    let mut frac: Option<String> = None;
    for c in t.chars() {
        match c {
            '-' if digits.is_empty() && frac.is_none() => neg = true,
            '+' => {}
            '.' => {
                if frac.is_some() {
                    return Err(format!("more than one decimal point in {raw:?}"));
                }
                frac = Some(String::new());
            }
            // Thousands separators and the currency symbol carry no value.
            ',' | ' ' | '\u{a0}' | '$' | '£' | '€' => {}
            c if c.is_ascii_digit() => match frac {
                Some(ref mut f) => f.push(c),
                None => digits.push(c),
            },
            c => return Err(format!("unexpected {c:?} in amount {raw:?}")),
        }
    }
    if digits.is_empty() && frac.as_ref().map(|f| f.is_empty()).unwrap_or(true) {
        return Err(format!("no digits in amount {raw:?}"));
    }
    let whole: i64 = if digits.is_empty() { 0 } else { digits.parse().map_err(|_| format!("amount out of range: {raw:?}"))? };

    // Exactly two minor digits, whatever was written. A third is truncated rather than rounded: a
    // statement that prints three has a sub-cent artifact, and inventing a cent from it would put a
    // figure in the store that is not on the statement.
    let cents: i64 = match frac {
        None => 0,
        Some(f) => {
            let f = f.as_str();
            match f.len() {
                0 => 0,
                1 => f.parse::<i64>().map_err(|_| "bad fraction")? * 10,
                _ => f[..2].parse::<i64>().map_err(|_| "bad fraction")?,
            }
        }
    };
    let minor = whole
        .checked_mul(100)
        .and_then(|w| w.checked_add(cents))
        .ok_or_else(|| format!("amount out of range: {raw:?}"))?;
    Ok(if neg { -minor } else { minor })
}

/// Render minor units back for display. Never feed this into arithmetic.
pub fn format_minor(minor: Minor) -> String {
    let sign = if minor < 0 { "-" } else { "" };
    let a = minor.abs();
    format!("{sign}{}.{:02}", a / 100, a % 100)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// EVERY FIXTURE HERE IS SYNTHETIC. No real statement, balance or account number belongs in this
    /// repo — the maintainer's data stays on the maintainer's machine, which is the whole premise of
    /// this crate.
    #[test]
    fn reads_the_shapes_statements_actually_print() {
        assert_eq!(parse_minor("1234.56").unwrap(), 123456);
        assert_eq!(parse_minor("$1,234.56").unwrap(), 123456);
        assert_eq!(parse_minor("-1234.56").unwrap(), -123456);
        assert_eq!(parse_minor("  1234.56  ").unwrap(), 123456);
        // Whole units with no decimal part at all.
        assert_eq!(parse_minor("1234").unwrap(), 123400);
        // One decimal digit means TENTHS, not hundredths — `1234.5` is $1234.50, not $12.345.
        assert_eq!(parse_minor("1234.5").unwrap(), 123450);
    }

    #[test]
    fn honours_both_negative_conventions() {
        // Accounting parentheses and a TRAILING sign are both real. Reading either as a stray
        // character would flip a refund into a charge, and the balance would be wrong by twice it.
        assert_eq!(parse_minor("(1234.56)").unwrap(), -123456);
        assert_eq!(parse_minor("1234.56-").unwrap(), -123456);
        assert_eq!(parse_minor("($1,234.56)").unwrap(), -123456);
    }

    #[test]
    fn is_exact_where_a_float_would_not_be() {
        // `"0.07".parse::<f64>() * 100.0` is 7.000000000000001. Reading the fraction as an integer
        // makes the value exact by construction rather than by luck at the rounding boundary.
        assert_eq!(parse_minor("0.07").unwrap(), 7);
        assert_eq!(parse_minor("0.29").unwrap(), 29);
        assert_eq!(parse_minor("1.10").unwrap(), 110);
        for cents in 0..100 {
            let s = format!("0.{cents:02}");
            assert_eq!(parse_minor(&s).unwrap(), cents, "{s} must be exact");
        }
    }

    #[test]
    fn truncates_a_third_decimal_rather_than_inventing_a_cent() {
        // A statement printing three decimals has a sub-cent artifact. Rounding it up would put a
        // figure in the store that is not on the statement, and reconciliation would fail against
        // the source rather than against the arithmetic.
        assert_eq!(parse_minor("1.999").unwrap(), 199);
        assert_eq!(parse_minor("-1.999").unwrap(), -199);
    }

    #[test]
    fn refuses_what_it_cannot_read_rather_than_guessing() {
        // A row that silently becomes zero is a missing transaction, which is a wrong balance that
        // nobody can find. Every one of these must be reported to the caller.
        assert!(parse_minor("").is_err());
        assert!(parse_minor("   ").is_err());
        assert!(parse_minor("N/A").is_err());
        assert!(parse_minor("--").is_err());
        assert!(parse_minor("1.2.3").is_err());
        assert!(parse_minor("12 34 abc").is_err());
    }

    #[test]
    fn round_trips_through_display() {
        for v in [0i64, 7, -7, 100, -100, 123456, -123456, 999999999] {
            assert_eq!(parse_minor(&format_minor(v)).unwrap(), v, "{v}");
        }
        assert_eq!(format_minor(-7), "-0.07");
        assert_eq!(format_minor(123456), "1234.56");
    }
}
