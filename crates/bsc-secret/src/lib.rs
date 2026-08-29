//! `bsc-secret` — the credential store behind the Credentials workspace and the `bsc secret` CLI.
//!
//! # The split this crate exists to enforce
//!
//! A paired service credential is TWO things, and they live in two different places on purpose:
//!
//! | | what it is | where it lives |
//! |---|---|---|
//! | the **secret** | the token / key / password itself | the **OS keychain** (`keyring`), reached only through [`vault`] |
//! | the **metadata** | what the credential IS (service, label, kind, expiry) and how it last BEHAVED | this store — `~/.base-studio-code/secrets.db` |
//!
//! [`Credential`] is the metadata half, and it has **no field that can hold a secret**. That is the
//! guarantee, expressed as a type rather than as a convention: `bsc secret list` cannot leak a value
//! it has no place to put. [`reject_secret_bearing`] closes the other direction — a `set` payload
//! carrying a `value`/`secret`/`password`-shaped key is refused before anything is written, so a
//! secret cannot arrive in the metadata store by accident either.
//!
//! # Status is DERIVED, never stored
//!
//! [`status`] folds the stamped result, the declared expiry and the presence of a keychain entry into
//! one [`Status`]. Storing it would let the stored value and the facts disagree — and a credential
//! whose recorded state disagrees with reality is precisely the failure the Credentials screen exists
//! to surface. See [`status`] for the precedence order and why it is that way.

pub mod cli;
pub mod vault;

use serde::{Deserialize, Serialize};

/// The keychain service namespace for every `bsc secret` credential.
///
/// Deliberately DISTINCT from `base-studio-code.source` (the migration-connector secrets in
/// `src-tauri/src/sources/credentials.rs`). Those are keyed per project+source+field and owned by the
/// Source pane; these are user-level and keyed by credential id. Sharing one namespace would let a
/// `bsc secret forget` delete a connector's secret out from under the scan that needs it.
pub const KEYCHAIN_SERVICE: &str = "base-studio-code.secret";

/// The store's directory segment under `~/.base-studio-code/` (the live db is the sibling
/// `secrets.db`; see `bsc_json_store`).
pub const STORE_SEGMENT: &str = "secrets";

/// How long before [`Credential::expires_at`] a credential starts reporting [`Status::Expiring`].
///
/// Seven days: long enough that a weekly-cadence user sees the warning at least once before the
/// credential actually dies, short enough that it is not permanently amber.
pub const EXPIRING_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;

/// The METADATA half of a paired credential. **Never the secret** — see the module docs.
///
/// Every field but `id` is optional and `#[serde(default)]`, because this is a verbatim-JSON store
/// with no schema migration: a record written today is read forever, and a field added later must not
/// turn every existing record into a parse error.
#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    /// The stable id — the store key AND the keychain account for this credential's secret.
    pub id: String,
    /// The service this authenticates against, as a lowercase slug (`github`, `salesforce`,
    /// `resend`, …). This is what selects the row's icon on the Credentials screen, so an unknown
    /// service is fine — it falls back to a generic key glyph rather than failing to render.
    #[serde(default)]
    pub service: String,
    /// Human label for the row. Falls back to the id when empty.
    #[serde(default)]
    pub label: String,
    /// `apikey` | `token` | `oauth` | `basic` — free-form, since a new auth shape should not need a
    /// store change. Rendered as-is.
    #[serde(default)]
    pub kind: String,
    /// Which account/tenant this credential belongs to (`ops@acme.com`, an org slug). An identifier,
    /// never a secret — it is the thing that tells two otherwise identical rows apart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub account: Option<String>,
    /// Unix seconds at which the credential stops being valid, when the provider tells us. `None`
    /// means "no declared expiry", which is not the same as "never expires" — it is why an
    /// unverified credential reports [`Status::Unverified`] rather than [`Status::Ok`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<i64>,
    /// Unix seconds of the last `bsc secret ok` / `bsc secret fail` stamp.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_verified_at: Option<i64>,
    /// [`RESULT_OK`] or [`RESULT_FAILED`] — what that last stamp said. `None` = never used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<String>,
    /// The failure message from the last `fail` stamp, kept so the screen can say WHY rather than
    /// just showing a red dot. Cleared by a subsequent `ok`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    /// Unix seconds the credential was created/registered.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// Free-form operator note.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// The `last_result` value meaning the last observed use succeeded.
pub const RESULT_OK: &str = "ok";
/// The `last_result` value meaning the last observed use failed.
pub const RESULT_FAILED: &str = "failed";

/// A credential's derived state — what the Credentials screen renders and what `bsc secret list`
/// reports. Never stored; always computed by [`status`].
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    /// The store holds a record but the keychain holds no secret for it — the two disagree, and the
    /// credential cannot be used at all.
    Missing,
    /// Past its declared expiry.
    Expired,
    /// The last observed use failed.
    Failing,
    /// Within [`EXPIRING_WINDOW_SECS`] of its declared expiry, and not otherwise broken.
    Expiring,
    /// Last observed use succeeded and nothing else is wrong.
    Ok,
    /// A secret is present but nothing has ever used it, so we have no evidence either way.
    Unverified,
}

impl Status {
    /// The lowercase wire/CSS token (`"ok"`, `"expiring"`, …) — the same string `serde` emits, so the
    /// screen's class names and the CLI's JSON can never drift apart.
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Missing => "missing",
            Status::Expired => "expired",
            Status::Failing => "failing",
            Status::Expiring => "expiring",
            Status::Ok => "ok",
            Status::Unverified => "unverified",
        }
    }

    /// Whether this state needs someone to DO something. The screen counts these for its header, and
    /// it is the one judgement worth centralising: `expiring` is deliberately included (it is
    /// actionable precisely because the credential still works), `unverified` deliberately is not.
    pub fn needs_attention(self) -> bool {
        matches!(self, Status::Missing | Status::Expired | Status::Failing | Status::Expiring)
    }
}

/// Derive a credential's [`Status`] from the record, whether the keychain actually holds its secret,
/// and the current time (unix seconds).
///
/// # Precedence, and why
///
/// Checked in this order, most-disqualifying first — each state means the ones below it cannot be
/// acted on yet:
///
/// 1. **`missing`** — no keychain entry. Nothing else is meaningful: the credential cannot be
///    presented to anything, whatever the record claims about it.
/// 2. **`expired`** — past its declared expiry. More specific than "failing", so it wins: it names
///    the cause and the fix (rotate) rather than just the symptom.
/// 3. **`failing`** — the last observed use failed. An observation of the present beats a claim
///    about the future, which is why `expiring` sits below it.
/// 4. **`expiring`** — inside the warning window. It still works; it just will not for long.
/// 5. **`ok`** / **`unverified`** — nothing wrong, and the split is whether we have any evidence.
///
/// # The one place an observation overrides a claim
///
/// An expiry is a claim about the future; a verification is an observation of the past. If we
/// verified the credential OK *after* the instant it supposedly expired, the claim is demonstrably
/// wrong — the provider rotated it, or the stored expiry was never right. Reporting `expired` there
/// would be telling the user to fix a credential we just watched work. So a verified-ok-after-expiry
/// record disregards its own `expires_at` rather than contradicting the evidence.
pub fn status(c: &Credential, has_secret: bool, now: i64) -> Status {
    if !has_secret {
        return Status::Missing;
    }
    let verified_ok = c.last_result.as_deref() == Some(RESULT_OK);
    // The expiry claim is disproved when a successful use was observed at or after it.
    let expiry_stands = match (verified_ok, c.last_verified_at, c.expires_at) {
        (true, Some(verified), Some(expires)) => verified < expires,
        _ => true,
    };
    if let Some(expires) = c.expires_at.filter(|_| expiry_stands) {
        if expires <= now {
            return Status::Expired;
        }
    }
    if c.last_result.as_deref() == Some(RESULT_FAILED) {
        return Status::Failing;
    }
    if let Some(expires) = c.expires_at.filter(|_| expiry_stands) {
        if expires - now <= EXPIRING_WINDOW_SECS {
            return Status::Expiring;
        }
    }
    if verified_ok {
        Status::Ok
    } else {
        Status::Unverified
    }
}

/// The JSON object keys a `bsc secret set` payload may NOT carry — the write-time half of the
/// no-secrets-in-the-metadata-store guarantee.
///
/// Matched case-insensitively against each key, as a SUBSTRING: `accessToken`, `refresh_token` and
/// `clientSecret` all have to be caught, and enumerating every casing of every provider's field name
/// is a list that would always be one name short. The cost of the substring rule is false positives
/// on innocent keys, which is the right way for this to be wrong.
///
/// `account` is exempt by construction — it is an identifier, and no needle is a substring of it.
pub const SECRET_BEARING_KEYS: &[&str] = &["secret", "token", "password", "passwd", "apikey", "api_key", "credential", "private"];

/// Reject a `set` payload that carries a secret-bearing key, before anything is written.
///
/// Scans NESTED objects and arrays too: a secret one level down in `{"auth": {"token": "…"}}` is
/// exactly as leaked as a top-level one, and the store writes the record verbatim either way.
///
/// # Errors
/// Names the offending key path so the caller can see what to remove — the key, never its value.
pub fn reject_secret_bearing(record: &serde_json::Value, prog: &str) -> Result<(), String> {
    fn walk(v: &serde_json::Value, path: &str, prog: &str) -> Result<(), String> {
        match v {
            serde_json::Value::Object(map) => {
                for (k, val) in map {
                    let lower = k.to_ascii_lowercase();
                    if let Some(hit) = SECRET_BEARING_KEYS.iter().find(|n| lower.contains(**n)) {
                        let at = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                        return Err(format!(
                            "{prog}: refusing to store `{at}` — it looks like it carries a secret (matched \"{hit}\").\n\
                             The metadata store never holds a secret value; put it in the keychain with `{prog} put <id>` instead."
                        ));
                    }
                    let at = if path.is_empty() { k.clone() } else { format!("{path}.{k}") };
                    walk(val, &at, prog)?;
                }
                Ok(())
            }
            serde_json::Value::Array(items) => {
                for (i, item) in items.iter().enumerate() {
                    walk(item, &format!("{path}[{i}]"), prog)?;
                }
                Ok(())
            }
            _ => Ok(()),
        }
    }
    walk(record, "", prog)
}

/// Current unix seconds. One definition so the CLI's stamps and [`status`]'s comparisons cannot use
/// two different clocks.
pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_800_000_000;
    const DAY: i64 = 24 * 60 * 60;

    /// A credential with a secret present and nothing else asserted.
    fn cred() -> Credential {
        Credential { id: "c".into(), service: "github".into(), ..Default::default() }
    }

    #[test]
    fn a_credential_with_no_keychain_entry_is_missing_whatever_else_it_claims() {
        // The record can claim a healthy, freshly-verified, far-from-expiry credential and it does
        // not matter — without a secret there is nothing to present. This is the store/keychain
        // disagreement the screen exists to show.
        let healthy = Credential {
            last_result: Some(RESULT_OK.into()),
            last_verified_at: Some(NOW),
            expires_at: Some(NOW + 365 * DAY),
            ..cred()
        };
        assert_eq!(status(&healthy, false, NOW), Status::Missing);
    }

    #[test]
    fn a_secret_nothing_has_used_is_unverified_not_ok() {
        // The distinction is the point: we have no evidence, and reporting `ok` would manufacture some.
        assert_eq!(status(&cred(), true, NOW), Status::Unverified);
    }

    #[test]
    fn a_stamped_success_is_ok_and_a_stamped_failure_is_failing() {
        let good = Credential { last_result: Some(RESULT_OK.into()), last_verified_at: Some(NOW), ..cred() };
        assert_eq!(status(&good, true, NOW), Status::Ok);
        let bad = Credential {
            last_result: Some(RESULT_FAILED.into()),
            last_verified_at: Some(NOW),
            last_error: Some("401".into()),
            ..cred()
        };
        assert_eq!(status(&bad, true, NOW), Status::Failing);
    }

    #[test]
    fn the_expiring_window_opens_exactly_seven_days_out() {
        // The cutover, from both sides of the boundary — an off-by-one here is a warning that either
        // never fires or fires forever.
        let at = |expires: i64| status(&Credential { expires_at: Some(expires), ..cred() }, true, NOW);
        assert_eq!(at(NOW + EXPIRING_WINDOW_SECS + 1), Status::Unverified, "just outside the window");
        assert_eq!(at(NOW + EXPIRING_WINDOW_SECS), Status::Expiring, "exactly on the window edge");
        assert_eq!(at(NOW + 1), Status::Expiring, "one second of life left is still alive");
    }

    #[test]
    fn expiry_is_inclusive_at_the_instant_it_lands() {
        let at = |expires: i64| status(&Credential { expires_at: Some(expires), ..cred() }, true, NOW);
        assert_eq!(at(NOW), Status::Expired, "the expiry instant itself is expired, not expiring");
        assert_eq!(at(NOW - 1), Status::Expired);
    }

    #[test]
    fn expired_outranks_failing_because_it_names_the_cause() {
        let c = Credential {
            expires_at: Some(NOW - DAY),
            last_result: Some(RESULT_FAILED.into()),
            last_verified_at: Some(NOW - 2 * DAY),
            ..cred()
        };
        assert_eq!(status(&c, true, NOW), Status::Expired);
    }

    #[test]
    fn failing_outranks_expiring_because_an_observation_beats_a_forecast() {
        // It is inside the warning window AND it just failed. "Expiring" would tell the user it still
        // works, which we have direct evidence it does not.
        let c = Credential {
            expires_at: Some(NOW + DAY),
            last_result: Some(RESULT_FAILED.into()),
            last_verified_at: Some(NOW),
            ..cred()
        };
        assert_eq!(status(&c, true, NOW), Status::Failing);
    }

    #[test]
    fn a_success_observed_after_the_declared_expiry_disproves_the_expiry() {
        // The provider rotated it, or the stored expiry was never right. Reporting `expired` here
        // would tell the user to fix a credential we just watched work.
        let c = Credential {
            expires_at: Some(NOW - 30 * DAY),
            last_result: Some(RESULT_OK.into()),
            last_verified_at: Some(NOW - DAY),
            ..cred()
        };
        assert_eq!(status(&c, true, NOW), Status::Ok);
    }

    #[test]
    fn a_success_observed_before_the_expiry_does_not_disprove_it() {
        // The mirror of the case above, and the one that keeps that override narrow: a use that
        // succeeded while the credential was still valid says nothing about it now.
        let c = Credential {
            expires_at: Some(NOW - DAY),
            last_result: Some(RESULT_OK.into()),
            last_verified_at: Some(NOW - 10 * DAY),
            ..cred()
        };
        assert_eq!(status(&c, true, NOW), Status::Expired);
    }

    #[test]
    fn a_failure_never_disproves_an_expiry() {
        // Only a SUCCESS is evidence the credential outlived its declared expiry. A failure after it
        // is exactly what expiry predicts.
        let c = Credential {
            expires_at: Some(NOW - DAY),
            last_result: Some(RESULT_FAILED.into()),
            last_verified_at: Some(NOW),
            ..cred()
        };
        assert_eq!(status(&c, true, NOW), Status::Expired);
    }

    #[test]
    fn every_status_token_matches_what_serde_emits() {
        // The screen's CSS classes are built from `as_str`, and its data comes from serde. If these
        // two ever disagree, every row silently loses its styling.
        for s in [Status::Missing, Status::Expired, Status::Failing, Status::Expiring, Status::Ok, Status::Unverified] {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()), "serde and as_str disagree for {s:?}");
        }
    }

    #[test]
    fn the_credential_type_has_no_field_that_could_hold_a_secret() {
        // The structural half of the guarantee: `bsc secret list` cannot leak a value it has nowhere
        // to put. Asserted over the SERIALIZED keys, since that is what actually reaches stdout.
        let full = Credential {
            id: "c".into(), service: "s".into(), label: "l".into(), kind: "oauth".into(),
            account: Some("a".into()), expires_at: Some(1), last_verified_at: Some(1),
            last_result: Some(RESULT_OK.into()), last_error: Some("e".into()),
            created_at: Some(1), note: Some("n".into()),
        };
        let json = serde_json::to_value(&full).unwrap();
        let keys: Vec<&str> = json.as_object().unwrap().keys().map(String::as_str).collect();
        for key in &keys {
            let lower = key.to_ascii_lowercase();
            assert!(
                !SECRET_BEARING_KEYS.iter().any(|n| lower.contains(n)),
                "Credential serializes a secret-bearing key `{key}` — the metadata store must never carry a value",
            );
        }
        // And the fields we DO expect are all there, so this test fails loudly if the shape is gutted
        // rather than passing vacuously on an empty key list.
        assert!(keys.contains(&"service") && keys.contains(&"lastResult") && keys.contains(&"expiresAt"));
    }

    #[test]
    fn a_record_is_read_back_unchanged_and_tolerates_a_bare_one() {
        let c = Credential { id: "x".into(), service: "resend".into(), kind: "apikey".into(), ..Default::default() };
        let round: Credential = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
        assert_eq!(round, c);
        // Every field but `id` defaults, so a record written before a field existed still parses —
        // this is a verbatim-JSON store with no schema migration.
        let bare: Credential = serde_json::from_str(r#"{"id":"only"}"#).unwrap();
        assert_eq!(bare.id, "only");
        assert_eq!(bare.last_result, None);
    }

    #[test]
    fn a_set_payload_carrying_a_secret_is_refused_at_any_depth() {
        let prog = "bsc secret";
        for body in [
            r#"{"id":"a","token":"ghp_xxx"}"#,
            r#"{"id":"a","accessToken":"x"}"#,
            r#"{"id":"a","refresh_token":"x"}"#,
            r#"{"id":"a","clientSecret":"x"}"#,
            r#"{"id":"a","API_KEY":"x"}"#,
            r#"{"id":"a","auth":{"password":"x"}}"#,
            r#"{"id":"a","list":[{"nested":{"privateKey":"x"}}]}"#,
        ] {
            let v: serde_json::Value = serde_json::from_str(body).unwrap();
            let err = reject_secret_bearing(&v, prog).expect_err(&format!("must refuse {body}"));
            assert!(err.contains("refusing to store"), "unhelpful error: {err}");
        }
    }

    #[test]
    fn the_refusal_names_the_key_and_never_echoes_the_value() {
        // The error goes to a terminal and into logs. Naming the value would leak the exact thing the
        // check exists to keep out of places it does not belong.
        let v: serde_json::Value = serde_json::from_str(r#"{"id":"a","auth":{"token":"ghp_SUPERSECRET"}}"#).unwrap();
        let err = reject_secret_bearing(&v, "bsc secret").unwrap_err();
        assert!(err.contains("auth.token"), "the key path should be named: {err}");
        assert!(!err.contains("ghp_SUPERSECRET"), "the refusal echoed the secret: {err}");
    }

    #[test]
    fn an_ordinary_credential_record_passes_the_gate() {
        // The guard has to admit the shape the store is actually for — including `account`, which is
        // an identifier and must not trip the substring rule.
        let v = serde_json::to_value(Credential {
            id: "gh".into(), service: "github".into(), label: "GitHub".into(), kind: "oauth".into(),
            account: Some("ops@acme.com".into()), expires_at: Some(1), ..Default::default()
        })
        .unwrap();
        assert!(reject_secret_bearing(&v, "bsc secret").is_ok());
    }

    #[test]
    fn needs_attention_covers_exactly_the_actionable_states() {
        assert!(Status::Missing.needs_attention());
        assert!(Status::Expired.needs_attention());
        assert!(Status::Failing.needs_attention());
        assert!(Status::Expiring.needs_attention(), "still works, but only for a few more days");
        assert!(!Status::Ok.needs_attention());
        assert!(!Status::Unverified.needs_attention(), "no evidence is not the same as bad news");
    }
}
