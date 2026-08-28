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


/// The READ verb's routing key — answered in Rust.
pub const KIND: &str = "session";

/// The START/STOP routing key. A different request shape AND a different path through the app
/// (frontend emit + ack), so it rides its own key the way `fleet-wake` does next to `fleet`.
pub const LIFECYCLE_KIND: &str = "session-lifecycle";

/// The DELIVER routing key (#an-ask-is-delivered-not-left-to-be-found).
///
/// Its own key rather than a flag on [`LIFECYCLE_KIND`] because it is a different question: lifecycle
/// asks "be running / stop running", delivery asks "take this request", and the answer names which of
/// three routes was taken. It can END in a lifecycle start (a stopped target is woken WITH the
/// request), which is exactly why it is the caller of that rather than a variant of it.
pub const DELIVER_KIND: &str = "session-deliver";

/// Ask the app to put `text` in front of a system session, whatever state it is in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverRequest {
    /// A system-session id, re-resolved against [`SYSTEM_SESSIONS`] by the app — the same closed-set
    /// boundary every other verb here crosses.
    pub id: String,
    /// The request to put in front of it.
    pub text: String,
    /// Cut into work already in progress. Without it a working session is LEFT ALONE and the caller is
    /// told so; this is the maintainer's "ability to completely interrupt a session with a prompt".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interrupt: bool,
    /// The loop this delivery serves, when there is one. Carried into the LAUNCH PROMPT if the target
    /// has to be started, so a session woken for a request comes up already knowing which one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_id: Option<i64>,
}

/// What the delivery did — never silent, because a request that vanished is the failure the whole
/// item exists to end.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliverResult {
    pub session_id: String,
    pub pane_id: String,
    pub action: deliver::Action,
    /// Human-readable, and the line the CLI prints.
    pub detail: String,
}

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

/// **The closed set**, one entry per app-owned session — and since
/// #system-sessions-are-per-technology that is one per TECHNOLOGY for the two studios whose store is
/// partitioned (the librarian by `impl.tech`, the designer by `kit.tech`). A per-tech pane id takes a
/// HYPHEN, never a second colon: the pane grammar is `<key>:<tail>` and the key is read as
/// `paneId.split(":")[0]` in several places.
///
/// Mirrors `STUDIO_SESSIONS` in
/// `src/features/studio-sessions/lib/studioSessions.ts`; the ids and pane ids are the same strings on
/// both sides, and `systemSessionRegistry.test.ts` fails when they drift. Two authorities is one more
/// than ideal, but the alternative — Rust reading a TS module at runtime — trades a compile-time table
/// for a parse that can fail in the field, and a silently-diverged registry shows up as a *valid* id
/// being refused, which the drift test catches at gate time instead.
pub const SYSTEM_SESSIONS: &[SystemSession] = &[
    SystemSession {
        id: "designerReact",
        pane_id: "design-studio:designer-react",
        summary: "the Design Studio for REACT kits — components, pages and animations via `bsc ui`",
        stoppable: true,
    },
    SystemSession {
        id: "designerReactNative",
        pane_id: "design-studio:designer-react-native",
        summary: "the Design Studio for REACT-NATIVE kits",
        stoppable: true,
    },
    SystemSession {
        id: "librarianRust",
        pane_id: "algorithms-studio:librarian-rust",
        summary: "the Algorithms Studio for RUST — `bsc graph impl list --tech rust`",
        stoppable: true,
    },
    SystemSession {
        id: "librarianTypescript",
        pane_id: "algorithms-studio:librarian-typescript",
        summary: "the Algorithms Studio for TYPESCRIPT",
        stoppable: true,
    },
    SystemSession {
        id: "librarianPython",
        pane_id: "algorithms-studio:librarian-python",
        summary: "the Algorithms Studio for PYTHON",
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
    /// The AGENT is running something — it has spawned a child of its own (a tool call, a build).
    ///
    /// This used to be the shell-level "has a live descendant" probe, and the doc here claimed an idle
    /// session would read false. It could not: for an agent session the agent IS a descendant of the
    /// shell, so the field was true for the whole life of the session and merely restated `live`.
    /// Measured on an idle designer whose entire tree was `bash → claude` sitting at its prompt.
    ///
    /// LIMIT: an agent waiting on a model response has no child either, so it reads false. This means
    /// "running something", not "occupied".
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
        // The realistic per-tech near-miss: the pane id is kebab, the studio id is camel.
        assert!(resolve("librarian-rust").is_err(), "the PANE id is not the studio id");
        assert!(resolve("librarian").is_err(), "the un-teched role is not a session any more");
        for id in valid_ids() {
            assert!(err.contains(id), "the refusal lists {id}");
        }
    }

    /// Case and whitespace are NOT normalised away. An id that only matches after being massaged is a
    /// second, looser spelling of the closed set — and the looser the match, the more of the argument
    /// space injected prose can reach.
    #[test]
    fn resolution_is_exact_rather_than_forgiving() {
        for near in ["DesignerReact", "DESIGNERREACT", " designerReact", "designerReact ", "design-studio:designer-react"] {
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

// This crate's modules are IN THE GRAPH, not in this directory.
// src/ask.rs, src/cli.rs do not exist — they are records in the
// committed graph/algorithms.json, materialized into $OUT_DIR by the shared build script.
// To change one, edit the RECORD and promote it; editing a file here would be editing nothing:
//     bsc graph impl get bsc-session--<module>.rs
//     bsc graph impl set --id bsc-session--<module>.rs --code-file <f>
//     bsc graph promote --id bsc-session--<module>.rs
//
// This header stays a file because include! refuses crate-level //! docs and #![…] inner
// attributes (E0753 / "an inner attribute is not permitted in this context").
include!(concat!(env!("OUT_DIR"), "/crate.rs"));

/// The DELIVERY policy for an ask (#an-ask-is-delivered-not-left-to-be-found).
///
/// Lives in this Tauri-free crate rather than in the app because BOTH ends need it: the app decides
/// and carries it out, and the CLI reports what happened. A stringly-typed action on the wire would
/// have the two disagree about the one thing the caller reads.
pub mod deliver {
    use serde::{Deserialize, Serialize};

    /// What delivering an ask to a session should DO, given the state that session is in.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum Action {
        /// The session is not running: start it with the request in its launch prompt.
        ///
        /// The path that has never failed, and the reason it is kept rather than replaced — a session born
        /// with the request cannot miss it.
        StartWith,
        /// The session is up and its agent is at a prompt: write the request in.
        Inject,
        /// The session is up and its agent is running something: interrupt it, then write the request in.
        /// Only ever chosen when the caller explicitly asked for it.
        InterruptWith,
        /// The session is working and the caller did not ask to interrupt. The request stays queued and
        /// the caller is TOLD, because a delivery that silently did nothing is the failure this whole item
        /// exists to end.
        LeaveWorking,
    }

    impl Action {
        /// Whether this action writes into a session that is already running.
        ///
        /// The two that do are exactly the two that cross `#only-the-user-resumes-a-session`, so they are
        /// nameable as a set rather than spelled out at each call site.
        pub fn writes_into_a_live_session(self) -> bool {
            matches!(self, Action::Inject | Action::InterruptWith)
        }

        /// A short phrase for the caller's report — what actually happened to their request.
        pub fn describe(self) -> &'static str {
            match self {
                Action::StartWith => "the session was started with your request in its launch prompt",
                Action::Inject => "your request was delivered to the idle session",
                Action::InterruptWith => "the session was interrupted and given your request",
                Action::LeaveWorking => {
                    "the session is working, so the request was left queued — re-send with --interrupt to \
                     cut in"
                }
            }
        }
    }

    /// Decide how to deliver, from the target's measured state.
    ///
    /// `live` is "a PTY session exists"; `working` is the AGENT-level probe (`busy::agents_doing_work`) —
    /// the agent has spawned a child of its own. Deliberately NOT the shell-level `busy`, which for an
    /// agent session is permanently true because the agent is itself a descendant, and would therefore
    /// route every single ask to [`Action::LeaveWorking`].
    ///
    /// `interrupt` is the caller's explicit request to cut into work in progress. It is honoured ONLY when
    /// the session is actually working: interrupting an idle agent would send a stray interrupt key for no
    /// reason, and starting a stopped one is not an interruption at all.
    pub fn plan(live: bool, working: bool, interrupt: bool) -> Action {
        match (live, working) {
            (false, _) => Action::StartWith,
            (true, false) => Action::Inject,
            (true, true) if interrupt => Action::InterruptWith,
            (true, true) => Action::LeaveWorking,
        }
    }

    /// The keystroke that interrupts an agent mid-turn, and the pause after it.
    ///
    /// ESC is what a Claude Code TUI reads as "stop the current turn"; the pause gives it time to unwind
    /// before the next line arrives, so the request is typed at a prompt rather than into a turn that is
    /// still tearing down. Ctrl-C is deliberately NOT used: in a TUI it is as likely to kill the agent as
    /// to interrupt its turn, and this verb is meant to redirect a session, not end it.
    pub const INTERRUPT_KEY: &str = "\x1b";
    pub const INTERRUPT_SETTLE_MS: u64 = 250;

    /// The bytes that deliver `text` to an agent sitting at its prompt.
    ///
    /// The trailing CR is what SUBMITS the line — without it the request sits in the agent's input box
    /// unsent, which looks identical to a delivery that worked right up until nobody answers. Any interior
    /// CR/LF is flattened to a space for the same reason: a multi-line request would submit at its first
    /// newline and send the remainder as a second, truncated turn.
    pub fn submission(text: &str) -> String {
        let flattened: String = text
            .chars()
            .map(|c| if c == '\r' || c == '\n' { ' ' } else { c })
            .collect();
        format!("{}\r", flattened.trim())
    }

    #[cfg(test)]
        mod tests {
        use super::*;

        #[test]
        fn a_stopped_session_is_started_with_the_request() {
            // The path that has never failed. `interrupt` is irrelevant here — there is nothing to cut in
            // on, and a stopped session cannot miss a request it is born holding.
            assert_eq!(plan(false, false, false), Action::StartWith);
            assert_eq!(plan(false, false, true), Action::StartWith);
            assert_eq!(plan(false, true, true), Action::StartWith, "not live wins over any staleness in `working`");
        }

        #[test]
        fn an_idle_session_is_given_the_request_rather_than_asked_to_look_for_it() {
            // THE REGRESSION. This is the state all four stranded asks were in: up, idle, and never told.
            assert_eq!(plan(true, false, false), Action::Inject);
        }

        #[test]
        fn an_idle_session_is_never_interrupted_even_when_interrupt_is_asked_for() {
            // There is nothing to interrupt, and a stray ESC into an idle agent is a keystroke nobody sent.
            assert_eq!(plan(true, false, true), Action::Inject);
        }

        #[test]
        fn a_working_session_is_left_alone_by_default_and_cut_into_only_on_request() {
            assert_eq!(plan(true, true, false), Action::LeaveWorking);
            assert_eq!(plan(true, true, true), Action::InterruptWith);
        }

        #[test]
        fn leaving_a_working_session_alone_still_tells_the_caller_what_to_do() {
            // A delivery that silently did nothing is the failure this item exists to end, so the one
            // action that delivers nothing has to carry the way to get through.
            let msg = Action::LeaveWorking.describe();
            assert!(msg.contains("--interrupt"), "it names the flag that would cut in: {msg}");
        }

        #[test]
        fn exactly_two_actions_write_into_a_live_session() {
            // These two are what cross #only-the-user-resumes-a-session. Naming them as a set is what lets
            // the guard and the audit line agree about which they are.
            assert!(Action::Inject.writes_into_a_live_session());
            assert!(Action::InterruptWith.writes_into_a_live_session());
            assert!(!Action::StartWith.writes_into_a_live_session(), "a launch prompt is not an injection");
            assert!(!Action::LeaveWorking.writes_into_a_live_session());
        }

        #[test]
        fn a_submission_ends_in_a_carriage_return_or_it_was_never_sent() {
            // Without the CR the text sits in the agent's input box unsent — indistinguishable from a
            // working delivery until nobody ever answers.
            let s = submission("review the kickoff");
            assert!(s.ends_with('\r'), "{s:?}");
            assert_eq!(s, "review the kickoff\r");
        }

        #[test]
        fn interior_newlines_are_flattened_so_a_request_cannot_submit_itself_halfway() {
            // A multi-line request would submit at its FIRST newline and send the rest as a second,
            // truncated turn — the receiving agent would answer half a question.
            let s = submission("line one\nline two\r\nline three");
            assert_eq!(s, "line one line two  line three\r");
            assert_eq!(s.matches('\r').count(), 1, "exactly one submission");
        }

        #[test]
        fn surrounding_whitespace_is_trimmed_but_the_text_is_otherwise_verbatim() {
            assert_eq!(submission("  spaced  "), "spaced\r");
            // Not mangled: the request is prose the receiving agent has to read.
            assert_eq!(submission("use `bsc ui set` — and check --coverage"), "use `bsc ui set` — and check --coverage\r");
        }
    }
}
