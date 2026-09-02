//! `navigate` (#3274, epic #3260) — steer the RUNNING app to a view, so a capture can target something
//! instead of photographing whatever happens to be on screen.
//!
//! ## Why this one crosses into the frontend
//! A shot ends at the compositor, so Rust answers it alone. Navigation changes **frontend** state (the
//! Zustand store), which Rust cannot touch. So:
//!
//! ```text
//! watcher → emit `bsc://navigate` → the frontend applies it → invokes `navigate_ack` → we reply
//! ```
//!
//! The ack is the whole point. Without it `bsc navigate … && bsc shot take` would race: the capture
//! could fire against the previous view while every log line looked correct — the exact failure shape
//! this epic keeps hitting. So the handler BLOCKS on the frontend's ack and reports the view that
//! actually landed.
//!
//! A frontend that never acks (no window, mid-reload, a listener that threw) must TIME OUT with a stated
//! error rather than hang the watcher — one wedged request would stop every future one.

use serde::Deserialize;
use std::time::Duration;
use tauri::Emitter;

/// How long to wait for the frontend to apply + ack. Shorter than the CLI's 8s so the caller gets our
/// real error ("the frontend did not ack") rather than a bare timeout that reads as "app not running".
const ACK_TIMEOUT: Duration = Duration::from_millis(5_000);

/// What the frontend sends back once it has applied the navigation — the view that ACTUALLY landed.
/// Deserialized straight into the CLI's result shape so there is one contract, not two.
///
/// EVERY field the frontend sends must be declared here. Serde drops unknown fields silently, so a field
/// added on the TS side and not here is not a compile error, not a runtime error, and not visible in any
/// log — it simply never reaches the caller. That is what happened to `declined`: #4248 shipped a refusal
/// message explaining why a background steer left the view alone, the frontend has been sending it ever
/// since, and no caller has ever seen it. The designer loop consequently read a decline as an ordinary
/// success with the wrong view and "fixed" it by forcing `navigate page designs` every few seconds — the
/// exact yank #4248 was written to stop.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NavAck {
    pub id: String,
    /// Set when the frontend could not do it (unknown component, unknown workspace, …).
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub workspace: Option<String>,
    #[serde(default)]
    pub page: Option<String>,
    #[serde(default)]
    pub kit: Option<String>,
    #[serde(default)]
    pub component: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    #[serde(default)]
    pub state: Option<String>,
    /// Set when the navigation deliberately left the VIEW alone (#3599/#4248) — a background follow-along
    /// off the Studio, or a steer refused because a human is using the app. Not an error: the focus did
    /// land. It exists so a decline reads as a decline instead of as a success with the wrong view.
    #[serde(default)]
    pub declined: Option<String>,
    /// What the preview frame is actually SHOWING once it settled — read from the frame registry, never
    /// echoed from the request or from the store selection. Absent when no frame was expected to rebuild
    /// (a declined navigate) or when it had not settled in time; then `mount_error` says which.
    #[serde(default)]
    pub mounted: Option<String>,
    /// Why the selected component is not on screen — the preview refused to build it, the bundle threw,
    /// or the frame did not settle within the frontend's budget.
    #[serde(default)]
    pub mount_error: Option<String>,
    /// #54 — the notices the frontend cleared. DECLARED here, not merely sent: serde drops an undeclared
    /// field silently, which is exactly how `declined` reached no caller for as long as it existed.
    #[serde(default)]
    pub dismissed: Option<Vec<String>>,
}

/// In-flight navigations, keyed by request id. The watcher parks on the receiver; `navigate_ack`
/// (invoked by the frontend) delivers into the sender.
pub type NavPending = crate::app::ack::AckPending<NavAck>;

/// Ask the frontend to navigate, and block until it acks.
pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_navigate::NavRequest,
) -> Result<bsc_navigate::NavResult, String> {
    let rx = crate::app::ack::register::<NavAck>(app, id);

    // The payload carries the id so the frontend can correlate its ack — several navigations could be
    // in flight (a loop firing while a human clicks), and an ack for the wrong one would report a view
    // that was never asked for.
    let mut payload = serde_json::to_value(req).map_err(|e| e.to_string())?;
    payload
        .as_object_mut()
        .ok_or("navigate request did not serialize to an object")?
        .insert("id".into(), serde_json::Value::String(id.to_string()));

    app.emit("bsc://navigate", payload).map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        crate::app::ack::unregister::<NavAck>(app, id); // don't leak the slot when nobody ever answers
        ack_timeout_message()
    })?;
    crate::app::ack::unregister::<NavAck>(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    Ok(bsc_navigate::NavResult {
        // The frontend always reports its workspace; if it somehow didn't, say so rather than inventing
        // a plausible default — a wrong answer here silently mis-aims every capture that follows.
        workspace: ack.workspace.ok_or("the frontend acked without naming the workspace it landed on")?,
        page: ack.page,
        kit: ack.kit,
        component: ack.component,
        theme: ack.theme,
        state: ack.state,
        declined: ack.declined,
        mounted: ack.mounted,
        mount_error: ack.mount_error,
        dismissed: ack.dismissed,
    })
}

/// What to say when the ack never arrived. Extracted so a test can pin what it does — and does NOT —
/// claim.
///
/// It used to assert a cause it had not established: *"is a window open, or was it mid-reload?"*. For
/// every unknown component id the real cause was neither — the frontend's miss-retry hydrate (a 1.72 MB
/// read measured at up to 8s) simply outran this budget, so the ack arrived after nobody was waiting.
/// Designer request #104 read the sentence literally, concluded the preview was hanging, and debugged a
/// component that was fine; it then filed the same symptom a second time. One message covered three
/// different outcomes — unknown id, torn-down bridge, and a navigation that had actually LANDED with a
/// late ack — and named none of them.
///
/// A timeout knows exactly one thing: no ack in time. So the message says that, says the navigation may
/// still have landed, and names the command that settles which.
fn ack_timeout_message() -> String {
    format!(
        "the frontend did not ack within {}ms. It may still have LANDED — check `bsc navigate show` \
         before concluding it failed. (The app IS running; this is not a 'no app' timeout.)",
        ACK_TIMEOUT.as_millis()
    )
}

/// The frontend's ack: "I applied it, and here is what landed."
///
/// An ack for an id nobody is waiting on is DROPPED, not an error — the waiter may have already timed
/// out, and failing here would surface a confusing error in the app for a request that is already dead.
#[tauri::command]
pub(crate) fn navigate_ack(ack: NavAck, state: tauri::State<'_, NavPending>) {
    let tx = state.take(&ack.id);
    match tx {
        Some(tx) => {
            let _ = tx.send(ack);
        }
        None => log::debug!("navigate: ack for {} had no waiter (timed out?)", ack.id),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_ack_deserializes_from_the_frontends_shape() {
        let ack: NavAck = serde_json::from_str(
            r#"{"id":"a","workspace":"projects","page":"designs","kit":"react-d3","component":"Heatmap"}"#,
        )
        .unwrap();
        assert_eq!(ack.id, "a");
        assert_eq!(ack.workspace.as_deref(), Some("projects"));
        assert_eq!(ack.component.as_deref(), Some("Heatmap"));
        assert!(ack.error.is_none());
        assert!(ack.theme.is_none(), "an absent field is absent, not an error");
    }

    /// REGRESSION. Serde drops an undeclared field silently, so a field the frontend sends and this
    /// struct does not name never reaches the caller and nothing anywhere reports it. `declined` lived
    /// in exactly that gap: #4248 shipped the refusal message, the frontend has sent it ever since, and
    /// no caller ever saw one — so a decline read as a success with an unexpected view, and the designer
    /// loop "corrected" it by forcing `navigate page designs` every few seconds.
    #[test]
    fn every_field_the_frontend_sends_survives_the_boundary() {
        let ack: NavAck = serde_json::from_str(
            r#"{"id":"a","workspace":"github","component":"plan-body-deployment",
                "declined":"view unchanged: the Studio is not showing",
                "mountError":"the preview refused to build it"}"#,
        )
        .unwrap();
        assert_eq!(ack.declined.as_deref(), Some("view unchanged: the Studio is not showing"));
        assert_eq!(ack.mount_error.as_deref(), Some("the preview refused to build it"));
        // Nothing mounted, so nothing is claimed — the caller must not photograph this view.
        assert!(ack.mounted.is_none());
    }

    /// The camelCase rename is load-bearing: the frontend sends `mountError`, and a snake_case-only
    /// struct would deserialize it to `None` with no error — the same silent drop, one rename later.
    #[test]
    fn the_mount_report_is_read_from_the_frontends_camel_case_spelling() {
        let ack: NavAck =
            serde_json::from_str(r#"{"id":"a","mounted":"Heatmap","mountError":null}"#).unwrap();
        assert_eq!(ack.mounted.as_deref(), Some("Heatmap"));
        assert!(ack.mount_error.is_none());
    }

    #[test]
    fn an_error_ack_deserializes_and_carries_no_view() {
        let ack: NavAck = serde_json::from_str(r#"{"id":"a","error":"no such component: Nope"}"#).unwrap();
        assert_eq!(ack.error.as_deref(), Some("no such component: Nope"));
        assert!(ack.workspace.is_none());
    }

    #[test]
    fn a_waiter_receives_its_own_ack_and_is_then_unregistered() {
        let pending = NavPending::default();
        let rx = pending.register("a");

        // navigate_ack's core: take the waiter out and deliver.
        let taken = pending.take("a").expect("the waiter is parked");
        taken.send(NavAck {
            id: "a".into(),
            error: None,
            workspace: Some("projects".into()),
            page: None,
            kit: None,
            component: None,
            theme: None,
            state: None,
            declined: None,
            mounted: None,
            mount_error: None,
            dismissed: None,
        })
        .unwrap();

        assert_eq!(rx.recv().unwrap().workspace.as_deref(), Some("projects"));
        assert!(pending.is_empty(), "the slot must not leak once delivered");
    }

    #[test]
    fn an_ack_for_an_unknown_id_is_dropped_not_an_error() {
        // The waiter may have already timed out; erroring here would surface a confusing failure in the
        // app for a request that is already dead.
        let pending = NavPending::default();
        assert!(pending.take("ghost").is_none());
    }

    /// REGRESSION, designer request #104. The message asserted a cause — "is a window open, or was it
    /// mid-reload?" — that a timeout cannot know, and for every unknown component id it was WRONG: the
    /// frontend's miss-retry hydrate outran the budget and acked to nobody. The reporter believed the
    /// sentence, went debugging a component that was fine, and filed the same symptom twice. What a
    /// timeout may say is that no ack arrived, that the navigation may nevertheless have landed, and how
    /// to find out.
    #[test]
    fn the_timeout_message_states_only_what_a_timeout_knows() {
        let m = ack_timeout_message();
        assert!(m.contains("5000ms"), "it names the budget it waited: {m}");
        assert!(m.contains("bsc navigate show"), "…and the command that settles it: {m}");
        assert!(
            m.contains("may still have LANDED"),
            "a late ack is one of the three outcomes this covers, so it must not read as failure: {m}"
        );
        for claim in ["is a window open", "mid-reload", "did not apply the navigation"] {
            assert!(!m.contains(claim), "a timeout has not established '{claim}': {m}");
        }
    }
}
