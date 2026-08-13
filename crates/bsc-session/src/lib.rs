//! `bsc session` (#architect-starts-and-stops-system-sessions) — start · stop · list the app-owned
//! SYSTEM SESSIONS.
//!
//! ## Why this verb exists
//! The architect is the funnel's first tier: it ingests the user's raw prose and hands work down. Epic
//! `architect-orchestrates-the-system-sessions` gives it the power to bring up the sessions that produce
//! the material a build runs on — the designer's kits, the librarian's algorithms, the integrator's
//! connectors — instead of only being able to describe them.
//!
//! ## Why the id is an ENUM and not a string
//! That grant widens the app's highest prompt-injection surface: the architect is `none` on git, github,
//! code, net and ui *because* it reads untrusted prose, and being the least capable session was the
//! mitigation. The replacement mitigation is one property — **the architect can only cause what a user
//! clicking in the app can already cause** — and this module is where its first clause lives:
//!
//! > Every argument is an id from a registry the app owns. No verb takes a command, a path, or prose
//! > that becomes execution.
//!
//! So [`SYSTEM_SESSIONS`] is a fixed table, [`resolve`] refuses anything outside it, and the refusal
//! names the valid set. Injected prose can at worst start a legitimate system session — a cheap,
//! reversible, visible act.
//!
//! ## Why stop cannot reach a director
//! Not by a check that could be forgotten: a director pane id is simply **not expressible** in this
//! verb's argument space. `stop` takes a system-session id, and `studio-code:director` is not one. The
//! epic settles the asymmetry — stopping a studio is cheap and reversible (a stable pane id means a
//! later start resumes the same conversation), while stopping a director ends coordination of a running
//! fleet whose workers have no route back except the user's click.
//!
//! ## Two routing kinds, on the `bsc fleet` precedent
//! [`KIND`] is answered in pure Rust (liveness lives in `PtyState`, exactly as `bsc fleet list` reads
//! it). [`LIFECYCLE_KIND`] is an emit-and-ack round trip, because bringing a studio up is a frontend
//! store action (`openStudio` → `StudioSessionHosts` mounts its `TerminalSlot`) that Rust cannot
//! perform.

use serde::{Deserialize, Serialize};

pub mod ask;
pub mod cli;

/// The READ verb's routing key — answered in Rust.
pub const KIND: &str = "session";

/// The START/STOP routing key. A different request shape AND a different path through the app
/// (frontend emit + ack), so it rides its own key the way `fleet-wake` does next to `fleet`.
pub const LIFECYCLE_KIND: &str = "session-lifecycle";

/// One app-owned system session: the id the CLI takes, the fixed pane id its session runs on, and what
/// it is for (printed by `list`, and in the refusal — a caller that named the wrong one should be able
/// to pick the right one without a second command).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SystemSession {
    pub id: &'static str,
    pub pane_id: &'static str,
    pub summary: &'static str,
    /// Whether `stop` may name it. False for the ARCHITECT alone — see [`resolve_stoppable`].
    pub stoppable: bool,
}

/// **The closed set.** Mirrors `STUDIO_SESSIONS` in
/// `src/features/studio-sessions/lib/studioSessions.ts`; the ids and pane ids are the same strings on
/// both sides, and `systemSessionRegistry.test.ts` fails when they drift. Two authorities is one more
/// than ideal, but the alternative — Rust reading a TS module at runtime — trades a compile-time table
/// for a parse that can fail in the field, and a silently-diverged registry shows up as a *valid* id
/// being refused, which the drift test catches at gate time instead.
pub const SYSTEM_SESSIONS: &[SystemSession] = &[
    SystemSession {
        id: "designer",
        pane_id: "design-studio:designer",
        summary: "the Design Studio — components, pages and animations via `bsc ui`",
        stoppable: true,
    },
    SystemSession {
        id: "librarian",
        pane_id: "algorithms-studio:librarian",
        summary: "the Algorithms Studio — the per-language implementation graph via `bsc graph`",
        stoppable: true,
    },
    SystemSession {
        id: "architect",
        pane_id: "teams-studio:architect",
        summary: "the Teams Studio — personas and team graphs via `bsc teams` / `bsc persona`",
        stoppable: false,
    },
    SystemSession {
        id: "soundDesigner",
        pane_id: "sound-studio:sound-designer",
        summary: "the Sound Studio — synthesis descriptors via `bsc sound`",
        stoppable: true,
    },
    SystemSession {
        id: "integrator",
        pane_id: "integration-studio:integrator",
        summary: "the Integration Studio — connector manifests via `bsc data connector`",
        stoppable: true,
    },
];

/// Every valid id, for a refusal message.
pub fn valid_ids() -> Vec<&'static str> {
    SYSTEM_SESSIONS.iter().map(|s| s.id).collect()
}

/// Resolve an id against the closed set.
///
/// **This is the injection boundary.** Everything downstream — the pane id, the emit, the store action —
/// works from the returned [`SystemSession`], never from the caller's string, so no argument reaches the
/// app as text. The error names the valid set rather than saying "unknown": a caller that guessed
/// `sound-designer` for `soundDesigner` should be corrected, not left to guess again.
pub fn resolve(id: &str) -> Result<&'static SystemSession, String> {
    SYSTEM_SESSIONS.iter().find(|s| s.id == id).ok_or_else(|| {
        format!(
            "'{id}' is not a system session. Valid ids: {}.\n\
             This verb reaches ONLY the app-owned system sessions — not fleet workers, and not a \
             project's director (a director owns a running fleet, so ending one is the user's act, \
             not the architect's).",
            valid_ids().join(" · ")
        )
    })
}

/// Resolve an id that `stop` may act on.
///
/// The architect is the one exclusion, and it is a self-reference rather than a capability question.
/// The architect is the session that HOLDS the orchestration conversation and the one this verb is
/// granted to, so `bsc session stop architect` is a caller killing itself: the frontend kills the PTY,
/// the CLI process inside that PTY dies before it can read the reply, and the request looks like a
/// timeout while having actually succeeded. Making it inexpressible costs one field and removes the
/// only self-referential case in the set — the alternative is discovering it at runtime as a bug
/// report about a command that "fails" and works.
///
/// `start` deliberately has no such exclusion: starting an already-running architect is a no-op, and
/// starting a stopped one is the ordinary thing another actor might want.
pub fn resolve_stoppable(id: &str) -> Result<&'static SystemSession, String> {
    let s = resolve(id)?;
    if !s.stoppable {
        return Err(format!(
            "'{}' cannot be stopped through this verb — it is the session that holds the \
             orchestration conversation, and stopping it here would kill the caller mid-request. \
             Close it from the app if that is really what you want.",
            s.id
        ));
    }
    Ok(s)
}

/// Which sessions to report on. Empty ⇒ all of them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListRequest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub ids: Vec<String>,
}

/// One system session's real state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemSessionState {
    pub id: String,
    pub pane_id: String,
    /// A PTY session exists — `pty_create` would RECONNECT rather than launch.
    pub live: bool,
    /// Its shell has a live descendant, i.e. something is actually running in it. Distinct from
    /// `live`: a session parked in `bsc loop watch` is live AND busy; an idle one is live, not busy.
    pub busy: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionListResult {
    pub sessions: Vec<SystemSessionState>,
}

/// What to do to a system session's lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LifecycleAction {
    Start,
    Stop,
}

/// Ask the app to start or stop one system session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleRequest {
    /// Already resolved against [`SYSTEM_SESSIONS`] by the CLI — but the app resolves it AGAIN before
    /// acting. The channel is a directory any process can write to, so the app cannot treat the CLI as
    /// the only writer; re-resolving is what keeps the closed set closed rather than merely tidy.
    pub id: String,
    pub action: LifecycleAction,
    /// Set by `bsc session ask` when this start exists to SERVE a loop. The app turns it into a launch
    /// directive appended to the session's persona prompt, so the session comes up already running
    /// `bsc loop watch` — which is what makes ask compose with start rather than racing it.
    ///
    /// A launch ARGUMENT, not a write into a live terminal: it goes exactly where the persona prompt
    /// goes. `injectPrompt` keeps its empty caller set.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_id: Option<i64>,
}

/// What actually happened — distinguished, not collapsed into a bare success.
///
/// `bsc fleet wake` earned this the hard way (#4025): a false success left a caller acting on a session
/// that was not running. Here the interesting cases are the no-ops — starting something already up, or
/// stopping something that was never up — because a caller told "started" when nothing changed will
/// wait for a session it thinks it just created.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleOutcome {
    /// It was not running; it is now.
    Started,
    /// It was already running — nothing was done, and nothing needed to be.
    AlreadyRunning,
    /// It was running; it has been stopped.
    Stopped,
    /// It was not running — nothing to stop.
    NotRunning,
}

impl LifecycleOutcome {
    /// Whether this outcome CHANGED anything, for a caller that wants the one-bit answer.
    pub fn changed(self) -> bool {
        matches!(self, Self::Started | Self::Stopped)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleResult {
    pub id: String,
    pub pane_id: String,
    pub outcome: LifecycleOutcome,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The routing keys must not collide with each other or with any sibling verb's — one channel,
    /// routed by kind, so a collision silently sends a request to the wrong handler.
    #[test]
    fn the_two_routing_keys_are_distinct() {
        assert_eq!(KIND, "session");
        assert_eq!(LIFECYCLE_KIND, "session-lifecycle");
        assert_ne!(KIND, LIFECYCLE_KIND);
    }

    /// The closed set is the mitigation, so its shape is pinned: unique ids, unique pane ids, and every
    /// pane id in the `<key>:<tail>` grammar the app's studio registry uses.
    #[test]
    fn the_registry_is_a_well_formed_closed_set() {
        let mut ids: Vec<_> = SYSTEM_SESSIONS.iter().map(|s| s.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n, "duplicate id in the registry");

        let mut panes: Vec<_> = SYSTEM_SESSIONS.iter().map(|s| s.pane_id).collect();
        panes.sort_unstable();
        panes.dedup();
        assert_eq!(panes.len(), n, "two sessions sharing a pane id would fight over one PTY");

        for s in SYSTEM_SESSIONS {
            assert_eq!(s.pane_id.matches(':').count(), 1, "{}: pane id is `<key>:<tail>`", s.id);
            assert!(!s.summary.is_empty(), "{}: needs a summary — it is printed in the refusal", s.id);
        }
    }

    #[test]
    fn resolve_accepts_exactly_the_registry() {
        for s in SYSTEM_SESSIONS {
            assert_eq!(resolve(s.id).unwrap().pane_id, s.pane_id);
        }
    }

    /// The whole point of the verb's argument space: a DIRECTOR is not expressible. Stopping a director
    /// is not refused by a check somewhere downstream that could be dropped in a refactor — there is no
    /// spelling of this argument that names one.
    #[test]
    fn a_director_pane_id_is_not_expressible() {
        for candidate in [
            "studio-code:director",
            "director",
            "base-studio-code:director",
            "studio-code:api", // nor any other fleet worker
        ] {
            let err = resolve(candidate).unwrap_err();
            assert!(err.contains("is not a system session"), "{candidate} must be refused");
            assert!(err.contains("director"), "the refusal explains WHY a director is out of scope");
        }
    }

    /// A near-miss is the realistic mistake (the id is camelCase, the pane id is kebab). The refusal has
    /// to carry the valid set or the caller just guesses again.
    #[test]
    fn a_near_miss_is_refused_and_told_the_valid_set() {
        let err = resolve("sound-designer").unwrap_err();
        assert!(err.contains("soundDesigner"), "the refusal names the id the caller meant");
        for id in valid_ids() {
            assert!(err.contains(id), "the refusal lists {id}");
        }
    }

    /// Case and whitespace are NOT normalised away. An id that only matches after being massaged is a
    /// second, looser spelling of the closed set — and the looser the match, the more of the argument
    /// space injected prose can reach.
    #[test]
    fn resolution_is_exact_rather_than_forgiving() {
        for near in ["Designer", "DESIGNER", " designer", "designer ", "design-studio:designer"] {
            assert!(resolve(near).is_err(), "{near} must not resolve");
        }
    }

    /// Both wire shapes survive a JSON round trip verbatim — the app deserializes the request and the
    /// CLI deserializes the result back, so a rename on either side has to fail here rather than in the
    /// field as "the app did nothing".
    #[test]
    fn the_wire_contract_round_trips() {
        let req = LifecycleRequest { id: "designer".into(), action: LifecycleAction::Stop, loop_id: None };
        let back: LifecycleRequest = serde_json::from_str(&serde_json::to_string(&req).unwrap()).unwrap();
        assert_eq!(back, req);

        let res = LifecycleResult {
            id: "designer".into(),
            pane_id: "design-studio:designer".into(),
            outcome: LifecycleOutcome::AlreadyRunning,
        };
        let json = serde_json::to_string(&res).unwrap();
        assert!(json.contains("\"paneId\""), "camelCase on the wire, like every other appchan result");
        assert!(json.contains("\"already-running\""), "the outcome is kebab-case on the wire");
        let back: LifecycleResult = serde_json::from_str(&json).unwrap();
        assert_eq!(back, res);

        let list = SessionListResult {
            sessions: vec![SystemSessionState {
                id: "librarian".into(),
                pane_id: "algorithms-studio:librarian".into(),
                live: true,
                busy: false,
                pid: Some(42),
            }],
        };
        let back: SessionListResult =
            serde_json::from_str(&serde_json::to_string(&list).unwrap()).unwrap();
        assert_eq!(back, list);
    }

    /// `stop` excludes exactly one session, and `start` excludes none. Pinned as a pair: the
    /// exclusion exists because the architect would be killing its own caller, NOT because stopping it
    /// is dangerous — so making `start` symmetrical with it would be the wrong fix.
    #[test]
    fn stop_excludes_only_the_architect_and_start_excludes_nobody() {
        for s in SYSTEM_SESSIONS {
            assert!(resolve(s.id).is_ok(), "{} must always be startable", s.id);
            assert_eq!(
                resolve_stoppable(s.id).is_ok(),
                s.id != "architect",
                "{} stoppability",
                s.id
            );
        }
        let err = resolve_stoppable("architect").unwrap_err();
        assert!(err.contains("kill the caller"), "the refusal says WHY, not just no");
    }

    /// The exclusion must not become a second, looser spelling of the closed set: an id outside the
    /// registry fails the same way through both doors.
    #[test]
    fn the_stop_door_is_no_wider_than_the_closed_set() {
        for candidate in ["studio-code:director", "director", "Designer", ""] {
            assert!(resolve_stoppable(candidate).unwrap_err().contains("is not a system session"));
        }
    }

    #[test]
    fn only_the_acting_outcomes_report_a_change() {
        assert!(LifecycleOutcome::Started.changed());
        assert!(LifecycleOutcome::Stopped.changed());
        assert!(!LifecycleOutcome::AlreadyRunning.changed());
        assert!(!LifecycleOutcome::NotRunning.changed());
    }
}
