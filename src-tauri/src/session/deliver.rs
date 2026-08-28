//! How an ask REACHES its target (#an-ask-is-delivered-not-left-to-be-found).
//!
//! # Why this exists
//!
//! `bsc session ask` put the loop id into the target's LAUNCH prompt and nowhere else. A session that
//! was already running when the ask arrived was therefore never told about it — and the discovery half
//! (`bsc loop watch --as <you>`) does not close that on its own: it lets a session FIND a waiting
//! request, and a session that never looks still never sees one. Four real asks
//! (loops 7, 8, 9, 10 — `designerReact` and `librarianTypescript`) sat open with zero turns.
//!
//! The maintainer's call (2026-08-27) was that delivery is the sender's job:
//!
//! > an idle session should be started with the prompt, a stopped session should be woken up WITH the
//! > prompt (we shouldn't expect the session to know to look for it) and finally we should have the
//! > ability to completely interrupt a session with a prompt
//!
//! # THE STANDING DECISION THIS CROSSES
//!
//! `#only-the-user-resumes-a-session`. `injectPrompt` has no callers and `pty_write` is ratchet-guarded
//! (`src/shared/lib/fleet/injectCallers.test.ts`) to user-action paths plus ONE unattended exception —
//! a cron automation the user configured, which won on the argument that the user set it up, so it is
//! their standing instruction rather than the app deciding. A director commissioning a designer at the
//! user's direction is that same argument, and the call was made explicitly rather than inferred.
//!
//! It is written here because the guard's whole purpose is that nobody adds an injector quietly — and
//! that guard greps `src/`, so it cannot see a Rust-side writer at all. `rust_injectors_are_ratcheted`
//! in `crate::tests` is the equivalent for this side; a new Rust injector has to argue its way onto
//! that list the way a frontend one does.
//!
//! # The decision is pure
//!
//! [`plan`] maps `(live, working, interrupt requested)` to an [`Action`] with no I/O, so the whole
//! policy — including the case that does nothing — is a table a test can read. The effectful half only
//! carries it out.

use bsc_session::deliver::{plan, submission, Action, INTERRUPT_KEY, INTERRUPT_SETTLE_MS};
use tauri::Manager;

// ── The effectful half ───────────────────────────────────────────────────────

/// Deliver `text` to a system session, choosing the route from the session's measured state.
///
/// Owns all three routes so the caller makes ONE round trip and is told which happened:
///   - not running  → started WITH the request in its launch prompt (via the frontend, as before);
///   - idle         → the request written straight in;
///   - working      → left alone, unless the caller asked to interrupt.
pub fn deliver(
    app: &tauri::AppHandle,
    req_id: &str,
    req: &bsc_session::DeliverRequest,
) -> Result<bsc_session::DeliverResult, String> {
    // THE BOUNDARY, re-crossed here for the same reason `apply` re-crosses it: anything that can write
    // the channel dir reaches this line, so the closed set is enforced where the action happens.
    let session = bsc_session::resolve(&req.id)?;

    let state = app.state::<crate::console::pty::PtyState>();
    let probe = crate::console::pty::pane_liveness(vec![session.pane_id.to_string()], &state)
        .into_iter()
        .next();
    let live = probe.as_ref().is_some_and(|p| p.live);
    // The AGENT-level probe. `busy` is permanently true for an agent session, so routing on it would
    // send every ask to `LeaveWorking` — the bug fixed in
    // #session-list-reports-every-agent-session-as-busy, and the reason this reads `working`.
    let working = probe.as_ref().is_some_and(|p| p.working);
    let action = plan(live, working, req.interrupt);

    match action {
        // Wake it holding the request. Unchanged from the path that has never failed — the frontend
        // mounts the session and `askDirective` rides in on its persona prompt.
        Action::StartWith => {
            crate::session::system::apply(
                app,
                req_id,
                &bsc_session::LifecycleRequest {
                    id: session.id.to_string(),
                    action: bsc_session::LifecycleAction::Start,
                    loop_id: req.loop_id,
                },
            )?;
        }
        Action::Inject | Action::InterruptWith => {
            if action == Action::InterruptWith {
                // Interrupt, then let the turn unwind before the request arrives — otherwise the text
                // is typed into a turn that is still tearing down rather than at a prompt.
                crate::console::pty::write_pane(session.pane_id, INTERRUPT_KEY, &state);
                std::thread::sleep(std::time::Duration::from_millis(INTERRUPT_SETTLE_MS));
            }
            // #only-the-user-resumes-a-session: every unattended write into a live session is audited,
            // so the crossing leaves a trail rather than being invisible after the fact.
            log::info!(
                "session[{}] delivering an ask by {:?} (crosses only-the-user-resumes-a-session, by maintainer decision)",
                session.id,
                action
            );
            if !crate::console::pty::write_pane(session.pane_id, &submission(&req.text), &state) {
                // The probe said live and the write found nothing: a teardown race. Reported rather
                // than returned as success, because a caller told "delivered" would wait forever.
                return Err(format!(
                    "'{}' reported live but its PTY was gone when the request was written — it is \
                     being torn down; re-send once it has settled",
                    session.id
                ));
            }
        }
        // Nothing to do, and that is the point: the caller is TOLD rather than left to assume.
        Action::LeaveWorking => {}
    }

    Ok(bsc_session::DeliverResult {
        session_id: session.id.to_string(),
        pane_id: session.pane_id.to_string(),
        action,
        detail: action.describe().to_string(),
    })
}
