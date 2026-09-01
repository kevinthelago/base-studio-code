//! The turn-open GATE (#1184/#4005) — ported from `src/app/console/lib/paneActivity.ts` under
//! `epic-frontend-logic-over-backend-resources-belongs-in-rust`, proved against
//! `src/app/console/paneActivity.fixtures.json`.
//!
//! # Why this side
//!
//! Rust already RECORDS the turn boundaries and reads them back — `bsc-activity run` on
//! UserPromptSubmit opens a turn, `idle` on Stop closes it, `attn` means Claude Code is blocked on a
//! person, and `logs::pane_activity` returns the latest row per pane. What it did not do is decide what
//! they MEAN: `logs_pane_activity` shipped rows to the renderer and the renderer gated the status dot.
//!
//! It takes the WIRE STATE rather than `logs::PaneActivity` itself, so this leaf crate keeps its
//! no-dependency property and the `logs` crate is untouched.
//!
//! # Two rules where the code and its own doc comment differ
//!
//! The TypeScript is the contract, so both are reproduced rather than tidied:
//!
//!   * The debounce's comment says "a freshly-`idle` pane is still treated as open". The code gates on
//!     `state !== "run"`, so a fresh **`attn`** is held open too. Kept, and pinned by its own case.
//!   * `now - at < grace` is EXCLUSIVE: at exactly the grace the gate has already released.

/// A pane's last recorded turn boundary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TurnState {
    /// A turn is open — the agent is working.
    Run,
    /// The turn closed at a Stop.
    Idle,
    /// STOPPED waiting on a person: a permission prompt, or a long input idle (#4005).
    Attn,
}

impl TurnState {
    /// The wire spelling `logs::PaneActivity` serializes.
    pub fn as_str(self) -> &'static str {
        match self {
            TurnState::Run => "run",
            TurnState::Idle => "idle",
            TurnState::Attn => "attn",
        }
    }

    /// Parse the wire spelling. An unknown value is `None` rather than a silent `Idle` — a state this
    /// side does not know is a disagreement to surface, not one to default away.
    pub fn parse(s: &str) -> Option<TurnState> {
        match s {
            "run" => Some(TurnState::Run),
            "idle" => Some(TurnState::Idle),
            "attn" => Some(TurnState::Attn),
            _ => None,
        }
    }
}

/// One pane's latest turn-boundary record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PaneActivity {
    pub pane: String,
    pub state: TurnState,
    /// Epoch-ms timestamp of the event.
    pub at: i64,
}

/// The grace window after a non-`run` event during which the turn is still treated as open.
///
/// It only ever DELAYS the silence timer and never forces an idle, so at worst a finished pane settles
/// 2.5s later than it could. That is what makes it safe to keep now that its original cause (the
/// `bsc-defer` Stop hook) is gone: the same gap remains wherever a session takes back-to-back turns —
/// the designer loop pump driving a session turn by turn, or a user replying immediately.
pub const ACTIVITY_IDLE_GRACE_MS: i64 = 2500;

/// Whether this pane's turn is still OPEN, i.e. the silence timer must not idle it.
///
/// True only for a `Run`. Absent activity is NOT a turn-open signal — a non-bash session, or a pane
/// that has not taken a turn, leaves the silence timer authoritative and behaviour unchanged.
pub fn is_turn_open(activity: Option<&PaneActivity>) -> bool {
    matches!(activity.map(|a| a.state), Some(TurnState::Run))
}

/// Is this pane STOPPED waiting on a person?
///
/// Distinct from idle in the way that matters: an idle pane is finished, an `Attn` pane is blocked and
/// stays blocked until someone acts. Deliberately NOT turn-open — the agent is not working, so the
/// silence timer stays free to settle the dot. This adds a signal rather than re-gating the existing one.
pub fn needs_attention(activity: Option<&PaneActivity>) -> bool {
    matches!(activity.map(|a| a.state), Some(TurnState::Attn))
}

/// This pane's latest activity out of the flat per-pane list, or `None`.
///
/// FIRST match, matching the TypeScript's `find` — the rows are latest-per-pane, so a duplicate pane id
/// would be a producer bug, and taking the first reproduces what ships rather than papering over it.
pub fn pane_activity_for<'a>(rows: &'a [PaneActivity], pane_id: &str) -> Option<&'a PaneActivity> {
    rows.iter().find(|r| r.pane == pane_id)
}

/// Debounced turn-open check for the poller.
///
/// Like [`is_turn_open`], but a recent non-`run` event still counts as open for `grace_ms` after it.
/// A genuinely done pane (its event older than the grace) releases the gate and the silence timer
/// idles it as normal.
///
/// TWO DETAILS THAT ARE THE SHIPPING BEHAVIOUR, not oversights — see the module docs: the grace applies
/// to `Attn` as well as `Idle`, and the comparison is strict, so exactly `grace_ms` elapsed is closed.
/// A future-dated event (clock skew) yields a negative elapsed, which is below any positive grace and
/// therefore open.
pub fn is_turn_open_debounced(activity: Option<&PaneActivity>, now: i64, grace_ms: i64) -> bool {
    let Some(a) = activity else { return false };
    if a.state == TurnState::Run {
        return true;
    }
    now - a.at < grace_ms
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    /// Resolved BY FILENAME under `src/`, the rule the pane-identity and tunnel contracts already use —
    /// so moving a feature slice does not break this, but RENAMING the fixture means updating this call
    /// in lockstep. Exactly one match: zero or a collision is a hard failure, never a silent first hit.
    fn fixture() -> Value {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src");
        let mut found: Vec<std::path::PathBuf> = Vec::new();
        fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
            let Ok(rd) = std::fs::read_dir(dir) else { return };
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    walk(&p, out);
                } else if p.file_name().and_then(|n| n.to_str()) == Some("paneActivity.fixtures.json") {
                    out.push(p);
                }
            }
        }
        walk(&root, &mut found);
        assert_eq!(found.len(), 1, "expected exactly one paneActivity.fixtures.json, got {found:?}");
        serde_json::from_str(&std::fs::read_to_string(&found[0]).unwrap()).unwrap()
    }

    /// `null` is ABSENT, which is a case in its own right and not an empty record.
    fn activity_of(v: &Value) -> Option<PaneActivity> {
        let o = v.as_object()?;
        let raw = o.get("state")?.as_str()?;
        Some(PaneActivity {
            pane: o.get("pane")?.as_str()?.to_string(),
            state: TurnState::parse(raw).unwrap_or_else(|| panic!("unknown state {raw:?}")),
            at: o.get("at")?.as_i64()?,
        })
    }

    /// Reports EVERY mismatch at once — a wrong port is usually wrong in a pattern, and one failing
    /// assertion hides the shape of it.
    #[test]
    fn the_turn_gate_matches_the_typescript_case_for_case() {
        let doc = fixture();
        let now = doc["now"].as_i64().expect("now");
        let default_grace = doc["graceMs"].as_i64().expect("graceMs");
        assert_eq!(
            default_grace, ACTIVITY_IDLE_GRACE_MS,
            "the constant moved on one side only — the grace is part of the contract"
        );
        let mut bad: Vec<String> = Vec::new();

        for c in doc["gates"].as_array().expect("gates") {
            let label = c["label"].as_str().unwrap();
            let a = activity_of(&c["activity"]);
            let grace = c["graceMs"].as_i64().unwrap_or(default_grace);

            let got = (
                is_turn_open(a.as_ref()),
                needs_attention(a.as_ref()),
                is_turn_open_debounced(a.as_ref(), now, grace),
            );
            let want = (
                c["turnOpen"].as_bool().unwrap(),
                c["needsAttention"].as_bool().unwrap(),
                c["turnOpenDebounced"].as_bool().unwrap(),
            );
            if got != want {
                bad.push(format!("  {label:?}\n    ts   (open,attn,debounced) = {want:?}\n    rust                         = {got:?}"));
            }
        }

        for c in doc["lookups"].as_array().expect("lookups") {
            let label = c["label"].as_str().unwrap();
            let rows: Vec<PaneActivity> = c["rows"]
                .as_array()
                .map(|a| a.iter().filter_map(activity_of).collect())
                .unwrap_or_default();
            let got = pane_activity_for(&rows, c["paneId"].as_str().unwrap()).cloned();
            let want = activity_of(&c["found"]);
            // WHOLE RECORD compared — a lookup returning the wrong row and one returning none are
            // different bugs, and a found/not-found boolean cannot tell them apart.
            if got != want {
                bad.push(format!("  lookup {label:?}: ts {want:?}, rust {got:?}"));
            }
        }

        assert!(bad.is_empty(), "the Rust turn gate disagrees with the live TypeScript:\n{}", bad.join("\n"));
    }

    /// The exclusive boundary, asserted as a PAIR so `<` cannot drift to `<=` unnoticed. A corpus of
    /// realistic ages never lands exactly on the grace.
    #[test]
    fn the_grace_boundary_is_exclusive() {
        let a = PaneActivity { pane: "p".into(), state: TurnState::Idle, at: 0 };
        assert!(is_turn_open_debounced(Some(&a), ACTIVITY_IDLE_GRACE_MS - 1, ACTIVITY_IDLE_GRACE_MS));
        assert!(
            !is_turn_open_debounced(Some(&a), ACTIVITY_IDLE_GRACE_MS, ACTIVITY_IDLE_GRACE_MS),
            "exactly at the grace the gate has already released"
        );
    }

    /// THE DOC/CODE DIVERGENCE. The comment says the grace is for a freshly-IDLE pane; the code gates
    /// on "not run", so a fresh `Attn` is held open too. Pinned so a port cannot tidy it into the doc.
    #[test]
    fn the_grace_covers_attn_too_not_only_idle() {
        let attn = PaneActivity { pane: "p".into(), state: TurnState::Attn, at: 1000 };
        assert!(
            is_turn_open_debounced(Some(&attn), 1000, ACTIVITY_IDLE_GRACE_MS),
            "a fresh attn is held open — the shipping behaviour, not what the doc comment says"
        );
        assert!(!is_turn_open(Some(&attn)), "…while the undebounced gate still says the agent is not working");
        assert!(needs_attention(Some(&attn)));
    }

    /// A zero grace is a SENTINEL that disables the debounce, not a small number.
    #[test]
    fn a_zero_grace_closes_even_a_same_millisecond_idle() {
        let idle = PaneActivity { pane: "p".into(), state: TurnState::Idle, at: 5000 };
        assert!(!is_turn_open_debounced(Some(&idle), 5000, 0));
        let run = PaneActivity { pane: "p".into(), state: TurnState::Run, at: 0 };
        assert!(is_turn_open_debounced(Some(&run), 999_999, 0), "a run is open regardless of the grace");
    }

    /// Absent activity is never open — the non-bash fallback that keeps the silence timer authoritative.
    #[test]
    fn absent_activity_is_never_a_turn_open_signal() {
        assert!(!is_turn_open(None));
        assert!(!needs_attention(None));
        assert!(!is_turn_open_debounced(None, 0, ACTIVITY_IDLE_GRACE_MS));
        assert!(pane_activity_for(&[], "p").is_none());
    }
}
