//! `bsc session ask` (#architect-asks-a-system-session-for-a-service) — a CALL, not a launch.
//!
//! ## The verb the epic says is the common case
//! Start and stop are lifecycle. Requesting is what the architect actually does most: it asks the
//! designer for a kit or the librarian for an implementation and gets an answer back, without owning
//! that session's lifecycle. Collapsing the three into "the architect can spin up sessions" would make
//! every request a lifecycle event and leave the architect owning a fleet of studios it wanted one
//! answer from.
//!
//! ## Why this is compatible with "the app never injects"
//! The channel is [`bsc_loop`], which already exists and already has the property that matters:
//! `bsc loop watch` **blocks**. The callee parks in a read it entered ITSELF, and the caller's turn
//! returns it. Nothing pushes text into a running session — `injectPrompt` keeps its empty caller set.
//!
//! ## The shape of the loop
//! The SESSION is participant `a` and the architect is `b`, because `a` speaks first and the seed is
//! what `a` replies to. So the seed is the REQUEST, the session answers it, and the architect waits as
//! `b`. Getting this backwards would have the architect replying to its own question.
//!
//! ## Where the honest gap is
//! A session that is not running is started with the loop id in its launch prompt, so it comes up
//! already watching. A session that IS running may or may not be parked in `watch` — if it is
//! mid-conversation with the user, it will not see the loop until it next looks. That is the cost of
//! having no injection path, and it is reported rather than hidden: a timeout says the loop is still
//! open and names it, so the answer can be collected later instead of being silently lost.

use crate::{LifecycleAction, LifecycleRequest, LifecycleResult, SessionListRequest, SessionListResult};
use std::time::{Duration, Instant};

/// The caller's participant name in every ask loop.
pub const ARCHITECT_PARTICIPANT: &str = "architect";

/// How long `ask` waits for an answer before reporting the loop is still open.
pub const DEFAULT_ANSWER_TIMEOUT_SECS: u64 = 300;

/// Poll interval while waiting — matches `bsc loop watch`'s own cadence.
const POLL_MS: u64 = 250;

/// The sentinel a session emits to close an ask loop.
///
/// A one-shot request wants a one-shot answer: without a signal the loop would sit open after the
/// answer arrived, and `bsc loop list` would fill with resolved conversations that look pending.
pub const ANSWER_SIGNAL: &str = "ANSWERED";

/// An ask loop is a question and an answer, not a conversation. The ceiling leaves room for one
/// clarifying exchange and then stops — a runaway pair of agents talking to each other is exactly what
/// a turn ceiling is for.
pub const ASK_MAX_TURNS: i64 = 6;

/// What `ask` produced.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AskResult {
    pub id: String,
    /// The loop carrying the exchange — printed on every path, so an unanswered ask can be collected
    /// later with `bsc loop show`.
    pub loop_id: i64,
    /// Whether the session had to be started to serve this ask.
    pub started: bool,
    /// The answer, when one arrived.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
}

/// Resolve the target of an ask.
///
/// Refuses the architect itself. `ask` names the caller as participant `b`, so asking the architect
/// would put `architect` on both sides of one loop and break the strict alternation the store
/// enforces — the request would fail deep inside the loop layer with a message about participants
/// rather than about the actual mistake. It is also, plainly, a session asking itself a question.
pub fn resolve_askable(id: &str) -> Result<&'static crate::SystemSession, String> {
    let s = crate::resolve(id)?;
    if s.id == ARCHITECT_PARTICIPANT {
        return Err(format!(
            "'{}' cannot be asked — it is the caller of this verb, so the request would name the same \
             participant on both sides of one loop.",
            s.id
        ));
    }
    Ok(s)
}

/// Everything `ask` needs from the outside world, injected so the decision logic is testable without
/// a running app or a real store.
pub trait AskEnv {
    /// Is this session live right now?
    fn is_live(&self, session_id: &str) -> Result<bool, String>;
    /// Start it, carrying the loop id so it comes up watching.
    fn start(&self, session_id: &str, loop_id: i64) -> Result<(), String>;
    /// Open a loop; returns its id.
    fn open_loop(&self, session_id: &str, request: &str) -> Result<i64, String>;
    /// Whose turn is it — `None` once the loop is closed.
    fn whose_turn(&self, loop_id: i64) -> Result<Option<String>, String>;
    /// The last turn's message, if any.
    fn last_message(&self, loop_id: i64) -> Result<Option<String>, String>;
}

/// Put a request to a system session and wait for its answer.
///
/// ORDER IS LOAD-BEARING: the loop is opened BEFORE the session is started, so the id exists to hand
/// to the launch. Started first, the session would come up with nothing to watch and the ask would
/// depend on it noticing a loop that appeared afterwards.
pub fn ask(
    env: &dyn AskEnv,
    session_id: &str,
    request: &str,
    timeout: Duration,
) -> Result<AskResult, String> {
    let session = resolve_askable(session_id)?;
    let request = request.trim();
    if request.is_empty() {
        return Err(format!("usage: bsc session ask {} \"<request>\"", session.id));
    }

    let loop_id = env.open_loop(session.id, request)?;

    // Start it only when it is not already up. Asking must not disturb a running session's lifecycle —
    // that is the whole distinction between this verb and `start`.
    let started = if env.is_live(session.id)? {
        false
    } else {
        env.start(session.id, loop_id)?;
        true
    };

    let deadline = Instant::now() + timeout;
    loop {
        // The answer has arrived when the turn comes back to US: the session spoke, so the last message
        // is its reply. A CLOSED loop means the session answered with the sentinel — also an answer,
        // and the common case for a one-shot ask.
        match env.whose_turn(loop_id)? {
            Some(who) if who == ARCHITECT_PARTICIPANT => {
                return Ok(AskResult {
                    id: session.id.to_string(),
                    loop_id,
                    started,
                    answer: env.last_message(loop_id)?,
                });
            }
            None => {
                return Ok(AskResult {
                    id: session.id.to_string(),
                    loop_id,
                    started,
                    answer: env.last_message(loop_id)?,
                });
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            // NOT an error: the request landed and the loop is open, so the answer can still be
            // collected. Saying "failed" would send the caller to re-ask, adding a second loop the
            // session now has to answer twice.
            return Ok(AskResult { id: session.id.to_string(), loop_id, started, answer: None });
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));
    }
}

/// The launch directive a started session comes up with, appended to its persona prompt.
///
/// Written as an instruction to RUN the watch rather than as a description of one, because the session
/// has to enter the blocking read itself — that entering is what makes this a call and not an
/// injection.
pub fn watch_directive(session_id: &str, loop_id: i64) -> String {
    format!(
        "You were started to serve a request on loop {loop_id}.\n\
         Run `bsc loop watch {loop_id} --as {session_id}` to read it, do the work it asks for, then \
         answer with `bsc loop say {loop_id} --as {session_id} \"<your answer>\"`.\n\
         Append {ANSWER_SIGNAL} to your final message to close the loop when the request is fully served."
    )
}

/// The appchan round trip for the two lifecycle calls `ask` makes. Separated from the pure decision
/// above so the wait logic is testable without a running app.
pub struct ChannelEnv {
    pub timeout_ms: i64,
}

impl ChannelEnv {
    fn loop_store() -> Result<bsc_loop::Store, String> {
        let path = bsc_sqlite_util::default_store_path("BSC_LOOP_DB", &["loops.db"])
            .ok_or("cannot locate loops.db — set $BSC_LOOP_DB")?;
        bsc_loop::Store::open(&path).map_err(|e| format!("opening the loop store: {e}"))
    }
}

impl AskEnv for ChannelEnv {
    fn is_live(&self, session_id: &str) -> Result<bool, String> {
        let res: SessionListResult = crate::cli::ask_app(
            crate::KIND,
            &SessionListRequest { ids: vec![session_id.to_string()] },
            self.timeout_ms,
        )?;
        Ok(res.sessions.iter().any(|s| s.id == session_id && s.live))
    }

    fn start(&self, session_id: &str, loop_id: i64) -> Result<(), String> {
        // The loop id rides the START so the session comes up already watching. It is a LAUNCH
        // argument (the same place the persona prompt goes), never a write into a live PTY.
        let req = LifecycleRequest {
            id: session_id.to_string(),
            action: LifecycleAction::Start,
            loop_id: Some(loop_id),
        };
        let _: LifecycleResult = crate::cli::ask_app(crate::LIFECYCLE_KIND, &req, self.timeout_ms)?;
        Ok(())
    }

    fn open_loop(&self, session_id: &str, request: &str) -> Result<i64, String> {
        let store = Self::loop_store()?;
        // The SESSION is `a` — it speaks first, replying to the seed, which IS the request.
        let lp = store
            .create(
                &bsc_loop::NewLoop {
                    a: session_id.to_string(),
                    b: ARCHITECT_PARTICIPANT.to_string(),
                    seed: request.to_string(),
                    until: Some(ANSWER_SIGNAL.to_string()),
                    max_turns: Some(ASK_MAX_TURNS),
                    budget: None,
                    project: None,
                },
                bsc_util::now_ms(),
            )
            .map_err(|e| format!("opening the loop: {e}"))?;
        Ok(lp.id)
    }

    fn whose_turn(&self, loop_id: i64) -> Result<Option<String>, String> {
        Self::loop_store()?.whose_turn(loop_id).map_err(|e| format!("reading the loop: {e}"))
    }

    fn last_message(&self, loop_id: i64) -> Result<Option<String>, String> {
        Ok(Self::loop_store()?
            .turns(loop_id)
            .map_err(|e| format!("reading the loop: {e}"))?
            .last()
            .map(|t| t.message.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// A scripted environment: `turns` is consumed one poll at a time, so a test can make the answer
    /// arrive on the Nth look rather than immediately.
    struct Fake {
        live: bool,
        started: RefCell<Vec<(String, i64)>>,
        opened: RefCell<Vec<(String, String)>>,
        turn_script: RefCell<Vec<Option<String>>>,
        last: Option<String>,
    }

    impl Fake {
        fn new(live: bool, script: Vec<Option<String>>, last: Option<&str>) -> Self {
            Self {
                live,
                started: RefCell::new(vec![]),
                opened: RefCell::new(vec![]),
                turn_script: RefCell::new(script),
                last: last.map(String::from),
            }
        }
    }

    impl AskEnv for Fake {
        fn is_live(&self, _s: &str) -> Result<bool, String> {
            Ok(self.live)
        }
        fn start(&self, s: &str, l: i64) -> Result<(), String> {
            self.started.borrow_mut().push((s.into(), l));
            Ok(())
        }
        fn open_loop(&self, s: &str, r: &str) -> Result<i64, String> {
            self.opened.borrow_mut().push((s.into(), r.into()));
            Ok(77)
        }
        fn whose_turn(&self, _l: i64) -> Result<Option<String>, String> {
            let mut s = self.turn_script.borrow_mut();
            Ok(if s.is_empty() { Some("designerReact".into()) } else { s.remove(0) })
        }
        fn last_message(&self, _l: i64) -> Result<Option<String>, String> {
            Ok(self.last.clone())
        }
    }

    const T: Duration = Duration::from_millis(400);

    #[test]
    fn a_running_session_is_asked_without_being_started() {
        // The distinction that makes this a call and not a launch: asking must not touch lifecycle.
        let f = Fake::new(true, vec![Some(ARCHITECT_PARTICIPANT.into())], Some("here is the kit"));
        let r = ask(&f, "designerReact", "make me a card", T).unwrap();
        assert_eq!(r.answer.as_deref(), Some("here is the kit"));
        assert!(!r.started);
        assert!(f.started.borrow().is_empty(), "a live session is never started");
    }

    #[test]
    fn a_stopped_session_is_started_with_the_loop_id() {
        // Ask COMPOSES with start — and the loop must exist first, or the session comes up with
        // nothing to watch.
        let f = Fake::new(false, vec![Some(ARCHITECT_PARTICIPANT.into())], Some("done"));
        let r = ask(&f, "librarianRust", "implement dijkstra in rust", T).unwrap();
        assert!(r.started);
        assert_eq!(f.started.borrow().as_slice(), &[("librarianRust".to_string(), 77)]);
        assert_eq!(f.opened.borrow()[0].0, "librarianRust", "the SESSION is participant a");
    }

    #[test]
    fn the_request_becomes_the_seed_the_session_replies_to() {
        let f = Fake::new(true, vec![Some(ARCHITECT_PARTICIPANT.into())], Some("ok"));
        ask(&f, "designerReact", "  make me a card  ", T).unwrap();
        assert_eq!(f.opened.borrow()[0].1, "make me a card", "trimmed, and used verbatim as the seed");
    }

    #[test]
    fn it_waits_through_the_sessions_turn_and_returns_the_answer() {
        // The session holds the turn for the first two polls, then answers.
        let f = Fake::new(
            true,
            vec![Some("designerReact".into()), Some("designerReact".into()), Some(ARCHITECT_PARTICIPANT.into())],
            Some("the answer"),
        );
        assert_eq!(ask(&f, "designerReact", "q", T).unwrap().answer.as_deref(), Some("the answer"));
    }

    #[test]
    fn a_closed_loop_is_an_answer_not_a_failure() {
        // The session answered WITH the sentinel, which closes the loop — the one-shot common case.
        let f = Fake::new(true, vec![None], Some("final answer ANSWERED"));
        assert_eq!(ask(&f, "designerReact", "q", T).unwrap().answer.as_deref(), Some("final answer ANSWERED"));
    }

    #[test]
    fn an_unanswered_ask_reports_the_loop_rather_than_failing() {
        // The honest gap: a running session that is not parked in `watch` may not look for a while.
        // Reporting failure would send the caller to re-ask and leave the session two loops to answer.
        let f = Fake::new(true, vec![Some("designerReact".into()); 8], None);
        let r = ask(&f, "designerReact", "q", Duration::from_millis(300)).unwrap();
        assert!(r.answer.is_none());
        assert_eq!(r.loop_id, 77, "the loop id comes back so the answer can be collected later");
    }

    #[test]
    fn the_architect_cannot_ask_itself() {
        let err = resolve_askable("architect").unwrap_err();
        assert!(err.contains("caller of this verb"));
        // And it fails BEFORE a loop is opened — a self-loop would otherwise be created and stranded.
        let f = Fake::new(true, vec![], None);
        assert!(ask(&f, "architect", "q", T).is_err());
        assert!(f.opened.borrow().is_empty(), "no loop is opened for a refused ask");
    }

    #[test]
    fn the_closed_set_still_applies() {
        for candidate in ["studio-code:director", "director", "worker", "Designer"] {
            assert!(resolve_askable(candidate).unwrap_err().contains("is not a system session"));
        }
    }

    #[test]
    fn an_empty_request_is_refused_before_a_loop_is_opened() {
        let f = Fake::new(true, vec![], None);
        assert!(ask(&f, "designerReact", "   ", T).is_err());
        assert!(f.opened.borrow().is_empty());
    }

    /// The directive must tell the session to RUN the watch (it has to enter the blocking read
    /// itself), name the loop, and say how to answer — a session told only "there is a loop" parks
    /// nowhere and the caller waits out its whole timeout.
    #[test]
    fn the_watch_directive_names_the_loop_the_verb_and_the_reply() {
        let d = watch_directive("designerReact", 12);
        assert!(d.contains("bsc loop watch 12 --as designer"));
        assert!(d.contains("bsc loop say 12 --as designer"));
        assert!(d.contains(ANSWER_SIGNAL));
    }
}
