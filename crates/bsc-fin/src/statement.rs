//! Statement ingest — read what a bank exports, without asking anyone what it is.
//!
//! THE INSTITUTION IS INFERRED FROM THE HEADER ROW, never from a flag. Partly because a flag is one
//! more thing to get wrong, and partly for a reason particular to this crate: the less the tool has
//! to be told about someone's accounts, the less of someone's accounts has to be said out loud.
//!
//! # The one contract every profile normalises to
//!
//! **A stored amount is signed from the ACCOUNT HOLDER's point of view: negative is money leaving.**
//!
//! That is not how the exports are written, and they disagree with each other, which is exactly why
//! this has to be stated once and enforced per profile:
//!
//! - Chase writes a purchase NEGATIVE.
//! - Discover writes a purchase POSITIVE — a charge is a positive number on the card's own terms.
//! - Capital One does not sign at all: it uses separate `Debit` and `Credit` columns.
//! - Bank of America signs like Chase, but its checking and card exports carry different columns.
//!
//! Get one of these backwards and every balance built on it is wrong by twice the amount, in the
//! direction that looks like good news. So the sign rule is per profile, named, and tested.
//!
//! # Nothing is dropped quietly
//!
//! A row that cannot be read is REPORTED, never skipped. A missing transaction is a wrong balance
//! that nobody can find by looking at the balance.
use crate::money::{parse_minor, Minor};

/// Which export this is. `Unknown` is a first-class outcome: a header nobody recognises should say so
/// rather than be forced through the closest-looking profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Institution {
    Chase,
    Discover,
    CapitalOne,
    BankOfAmerica,
    Unknown,
}

impl Institution {
    pub fn name(self) -> &'static str {
        match self {
            Institution::Chase => "chase",
            Institution::Discover => "discover",
            Institution::CapitalOne => "capital-one",
            Institution::BankOfAmerica => "bank-of-america",
            Institution::Unknown => "unknown",
        }
    }
}

/// How one export lays its columns out, and which way its amounts point.
#[derive(Debug, Clone)]
pub struct Profile {
    pub institution: Institution,
    /// Human label for the report — which export shape matched.
    pub label: &'static str,
    /// Header names that must ALL be present for this profile to match, lowercased.
    pub required: &'static [&'static str],
    pub date: &'static str,
    pub description: &'static str,
    /// A single signed amount column…
    pub amount: Option<&'static str>,
    /// …or a separate debit/credit pair, which is Capital One's shape.
    pub debit_credit: Option<(&'static str, &'static str)>,
    /// TRUE when the export writes a purchase as a POSITIVE number, so the sign must be flipped to
    /// reach "negative is money leaving". Discover is the case this exists for.
    pub charge_is_positive: bool,
}

/// The known export shapes.
///
/// DATA, not code, and deliberately: verifying these against a real export is a one-line correction
/// rather than a patch to a parser. They are written from published formats and SHOULD be checked
/// against an actual download before anyone trusts a balance built on them.
pub const PROFILES: &[Profile] = &[
    Profile {
        institution: Institution::CapitalOne,
        label: "capital-one (debit/credit columns)",
        required: &["transaction date", "description", "debit", "credit"],
        date: "transaction date",
        description: "description",
        amount: None,
        debit_credit: Some(("debit", "credit")),
        charge_is_positive: false,
    },
    Profile {
        institution: Institution::Discover,
        label: "discover (charge positive)",
        required: &["trans. date", "description", "amount"],
        date: "trans. date",
        description: "description",
        amount: Some("amount"),
        debit_credit: None,
        // A charge is written POSITIVE. Without this flip every purchase would read as income.
        charge_is_positive: true,
    },
    Profile {
        institution: Institution::Chase,
        label: "chase card",
        required: &["transaction date", "post date", "description", "amount"],
        date: "transaction date",
        description: "description",
        amount: Some("amount"),
        debit_credit: None,
        charge_is_positive: false,
    },
    Profile {
        institution: Institution::Chase,
        label: "chase checking",
        required: &["posting date", "description", "amount"],
        date: "posting date",
        description: "description",
        amount: Some("amount"),
        debit_credit: None,
        charge_is_positive: false,
    },
    Profile {
        institution: Institution::BankOfAmerica,
        label: "bank-of-america card",
        required: &["posted date", "payee", "amount"],
        date: "posted date",
        description: "payee",
        amount: Some("amount"),
        debit_credit: None,
        charge_is_positive: false,
    },
    Profile {
        institution: Institution::BankOfAmerica,
        label: "bank-of-america checking",
        required: &["date", "description", "amount", "running bal."],
        date: "date",
        description: "description",
        amount: Some("amount"),
        debit_credit: None,
        charge_is_positive: false,
    },
];

/// One transaction, normalised.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Txn {
    /// As written in the export. Not reformatted here — normalising a date is a separate decision
    /// from reading one, and guessing between `01/02` conventions silently is how a year goes wrong.
    pub date: String,
    pub description: String,
    /// Minor units, NEGATIVE for money leaving the account holder.
    pub minor: Minor,
}

/// A row that could not be read, and why. Carried out rather than logged, so the caller decides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rejected {
    /// 1-based line number in the file, counting the header — what a person would see in an editor.
    pub line: usize,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct Parsed {
    pub institution: Institution,
    pub profile: &'static str,
    pub txns: Vec<Txn>,
    pub rejected: Vec<Rejected>,
}

/// Split ONE csv line, honouring quoted fields.
///
/// A description containing a comma is not exotic — it is most of them ("SQUARE, INC"). Splitting on
/// every comma would shift every later column by one and put a date where an amount goes.
fn split_csv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            c => cur.push(c),
        }
    }
    out.push(cur);
    out.into_iter().map(|s| s.trim().to_string()).collect()
}

/// The profile whose required columns are all present. Most specific first — `PROFILES` is ordered so
/// a shape with more required columns is tried before a looser one it would also satisfy.
pub fn detect(header: &[String]) -> Option<&'static Profile> {
    let have: Vec<String> = header.iter().map(|h| h.trim().to_lowercase()).collect();
    PROFILES.iter().find(|p| p.required.iter().all(|r| have.iter().any(|h| h == r)))
}

/// Parse a whole CSV export.
pub fn parse_csv(text: &str) -> Result<Parsed, String> {
    let mut lines = text.lines().enumerate().filter(|(_, l)| !l.trim().is_empty());
    let (header_line, header_raw) = lines.next().ok_or_else(|| "the file is empty".to_string())?;
    let header = split_csv(header_raw);
    let profile = detect(&header).ok_or_else(|| {
        format!(
            "no known export shape matches this header: [{}]. Add a Profile for it rather than \
             forcing it through the closest one — a mis-mapped column reads as a plausible number.",
            header.join(", ")
        )
    })?;

    let col = |name: &str| header.iter().position(|h| h.trim().eq_ignore_ascii_case(name));
    let (di, ci) = (col(profile.date), col(profile.description));
    let (Some(di), Some(ci)) = (di, ci) else {
        return Err(format!("{}: the header lost a column between detection and read", profile.label));
    };

    let mut txns = Vec::new();
    let mut rejected = Vec::new();
    for (idx, raw) in lines {
        let line = idx + 1; // 1-based, as an editor shows it
        let f = split_csv(raw);
        let get = |i: usize| f.get(i).map(String::as_str).unwrap_or("").trim();
        if f.len() < header.len() {
            rejected.push(Rejected { line, reason: format!("{} columns, expected {}", f.len(), header.len()) });
            continue;
        }
        let minor = match (profile.amount, profile.debit_credit) {
            (Some(a), _) => {
                let Some(ai) = col(a) else {
                    rejected.push(Rejected { line, reason: format!("no `{a}` column") });
                    continue;
                };
                match parse_minor(get(ai)) {
                    Ok(v) => {
                        // Discover's convention: a charge is written positive. Flip so the store's
                        // rule holds — negative is money leaving.
                        if profile.charge_is_positive { -v } else { v }
                    }
                    Err(e) => {
                        rejected.push(Rejected { line, reason: e });
                        continue;
                    }
                }
            }
            (None, Some((d, c))) => {
                // Capital One: exactly one of the two carries a value. Both, or neither, is a row
                // this parser does not understand — and guessing which to believe would be inventing
                // a transaction.
                let (Some(dbi), Some(cri)) = (col(d), col(c)) else {
                    rejected.push(Rejected { line, reason: format!("no `{d}`/`{c}` columns") });
                    continue;
                };
                let (dv, cv) = (get(dbi), get(cri));
                match (dv.is_empty(), cv.is_empty()) {
                    (false, true) => match parse_minor(dv) {
                        Ok(v) => -v.abs(), // a debit is money leaving
                        Err(e) => { rejected.push(Rejected { line, reason: e }); continue; }
                    },
                    (true, false) => match parse_minor(cv) {
                        Ok(v) => v.abs(), // a credit is money arriving
                        Err(e) => { rejected.push(Rejected { line, reason: e }); continue; }
                    },
                    (true, true) => { rejected.push(Rejected { line, reason: "neither debit nor credit has a value".into() }); continue; }
                    (false, false) => { rejected.push(Rejected { line, reason: "both debit and credit have values".into() }); continue; }
                }
            }
            (None, None) => return Err(format!("{}: profile declares no amount column", profile.label)),
        };
        let date = get(di).to_string();
        if date.is_empty() {
            rejected.push(Rejected { line, reason: "no date".into() });
            continue;
        }
        txns.push(Txn { date, description: get(ci).to_string(), minor });
    }
    let _ = header_line;
    Ok(Parsed { institution: profile.institution, profile: profile.label, txns, rejected })
}

#[cfg(test)]
mod tests {
    use super::*;

    // EVERY FIXTURE IS SYNTHETIC — invented merchants, round-ish amounts, no account numbers. The
    // maintainer's statements never enter this repo, and a test that needed a real one would be
    // telling us the design is wrong.

    #[test]
    fn a_quoted_comma_does_not_shift_every_later_column() {
        // "SQUARE, INC" is most descriptions, not an exotic case. Splitting on every comma puts a
        // date where an amount goes, and the row still parses — as a plausible wrong number.
        let f = split_csv(r#"01/02/2026,"SQUARE, INC",-12.34"#);
        assert_eq!(f, vec!["01/02/2026", "SQUARE, INC", "-12.34"]);
        assert_eq!(split_csv(r#""a""b",c"#), vec![r#"a"b"#, "c"]);
    }

    #[test]
    fn chase_a_purchase_is_money_leaving() {
        let csv = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n\
                   01/02/2026,01/03/2026,COFFEE BAR,Food,Sale,-4.50,\n\
                   01/04/2026,01/05/2026,PAYMENT THANK YOU,,Payment,250.00,\n";
        let p = parse_csv(csv).unwrap();
        assert_eq!(p.institution, Institution::Chase);
        assert_eq!(p.txns[0].minor, -450, "a purchase must be negative");
        assert_eq!(p.txns[1].minor, 25000, "a payment to the card is money arriving on it");
        assert!(p.rejected.is_empty());
    }

    #[test]
    fn discover_writes_a_charge_positive_and_it_is_flipped() {
        // THE SIGN BUG THIS FILE EXISTS FOR. Without the flip every Discover purchase reads as
        // income, and the balance is wrong by twice the amount in the direction that looks like good
        // news — which is the direction nobody double-checks.
        let csv = "Trans. Date,Post Date,Description,Amount,Category\n\
                   01/02/2026,01/03/2026,HARDWARE STORE,89.99,Merchandise\n\
                   01/06/2026,01/06/2026,DIRECTPAY FULL BALANCE,-200.00,Payments\n";
        let p = parse_csv(csv).unwrap();
        assert_eq!(p.institution, Institution::Discover);
        assert_eq!(p.txns[0].minor, -8999, "a Discover charge is written positive and must flip");
        assert_eq!(p.txns[1].minor, 20000, "and a payment flips the other way");
    }

    #[test]
    fn capital_one_uses_separate_debit_and_credit_columns() {
        let csv = "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n\
                   2026-01-02,2026-01-03,1234,GROCERY,Merchandise,54.20,\n\
                   2026-01-05,2026-01-06,1234,CREDIT BALANCE REFUND,Other,,15.00\n";
        let p = parse_csv(csv).unwrap();
        assert_eq!(p.institution, Institution::CapitalOne);
        assert_eq!(p.txns[0].minor, -5420, "a debit is money leaving");
        assert_eq!(p.txns[1].minor, 1500, "a credit is money arriving");
    }

    #[test]
    fn capital_one_refuses_a_row_that_fills_both_or_neither() {
        // Guessing which column to believe would be inventing a transaction.
        let csv = "Transaction Date,Posted Date,Card No.,Description,Category,Debit,Credit\n\
                   2026-01-02,2026-01-03,1234,BOTH,Other,10.00,10.00\n\
                   2026-01-04,2026-01-05,1234,NEITHER,Other,,\n";
        let p = parse_csv(csv).unwrap();
        assert!(p.txns.is_empty());
        assert_eq!(p.rejected.len(), 2);
        assert!(p.rejected[0].reason.contains("both"));
        assert!(p.rejected[1].reason.contains("neither"));
    }

    #[test]
    fn bank_of_america_checking_and_card_are_different_shapes() {
        let checking = "Date,Description,Amount,Running Bal.\n01/02/2026,RENT,-1450.00,3210.55\n";
        assert_eq!(parse_csv(checking).unwrap().institution, Institution::BankOfAmerica);
        let card = "Posted Date,Reference Number,Payee,Address,Amount\n01/02/2026,000123,PHARMACY,,-23.40\n";
        let p = parse_csv(card).unwrap();
        assert_eq!(p.institution, Institution::BankOfAmerica);
        assert_eq!(p.txns[0].description, "PHARMACY", "the card export calls it Payee, not Description");
    }

    #[test]
    fn an_unreadable_row_is_reported_not_dropped() {
        // A row that silently vanishes is a wrong balance nobody can find by looking at the balance.
        let csv = "Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n\
                   01/02/2026,01/03/2026,GOOD,Food,Sale,-4.50,\n\
                   01/04/2026,01/05/2026,BAD AMOUNT,Food,Sale,N/A,\n\
                   ,01/06/2026,NO DATE,Food,Sale,-1.00,\n";
        let p = parse_csv(csv).unwrap();
        assert_eq!(p.txns.len(), 1);
        assert_eq!(p.rejected.len(), 2);
        // The line number is what a person would see in an editor, header included.
        assert_eq!(p.rejected[0].line, 3);
        assert_eq!(p.rejected[1].line, 4);
    }

    #[test]
    fn an_unknown_header_says_so_rather_than_guessing() {
        // Forcing an unrecognised export through the closest-looking profile produces numbers that
        // are wrong and plausible, which is the worst combination available.
        let err = parse_csv("Foo,Bar,Baz\n1,2,3\n").unwrap_err();
        assert!(err.contains("no known export shape"), "{err}");
        assert!(err.contains("Foo"), "the error must show the header it could not place");
    }

    #[test]
    fn every_profile_is_reachable_and_distinct() {
        // A profile no header can select is dead configuration that reads as coverage. Each one's own
        // required columns must select IT — if a looser profile shadows a stricter one, ordering is
        // wrong and some institution silently parses as another.
        for p in PROFILES {
            let header: Vec<String> = p.required.iter().map(|s| s.to_string()).collect();
            let got = detect(&header).unwrap_or_else(|| panic!("{} matches no profile", p.label));
            assert_eq!(got.label, p.label, "{} is shadowed by {}", p.label, got.label);
        }
    }

    #[test]
    fn the_empty_file_is_an_error_not_an_empty_statement() {
        // An empty result would read as "this account had no activity", which is a different claim.
        assert!(parse_csv("").is_err());
        assert!(parse_csv("   \n\n").is_err());
    }
}
