//! `bsc persona use` — change which persona a pane runs as.
//!
//! ```text
//! bsc persona use → request file → appchan watcher → emit `bsc://persona-use` → the frontend
//!                 → sets panePersonas (+ relaunches) → invokes `persona_use_ack` → we reply
//! ```
//!
//! ## Why it is not answered in Rust
//! The assignment lives in the frontend store (`panePersonas`), and the persona is what every
//! "what does this pane get" question resolves through — capability, MCP servers, hooks. Rust cannot
//! write the zustand store, so the frontend applies it and reports what happened.
//!
//! ## Why it relaunches, and why BUSY is decided here
//! A persona is read at LAUNCH. Rewriting the map under a running session changes nothing the agent
//! can observe, so a `use` that only set the map would report success for a no-op. It therefore
//! relaunches by default — which kills the PTY, which is why a BUSY pane is refused without `--force`.
//!
//! That refusal is resolved HERE rather than in the frontend, for the reason `fleet wake` states: the
//! store cannot see whether a shell has a live descendant, and `PtyState` + `shells_with_descendants`
//! is the same authority `bsc fleet list` reports from. Two opinions about what is running is exactly
//! how `list` and this verb would come to disagree.

use serde::Deserialize;
use std::time::Duration;
use tauri::{Emitter, Manager};

/// Shorter than the CLI's timeout, so a caller gets the real reason ("the frontend did not ack")
/// rather than a bare timeout that reads as "the app is not running".
const ACK_TIMEOUT: Duration = Duration::from_millis(5_000);

/// What the frontend sends back once it has tried to apply the change.
#[derive(Debug, Clone, Deserialize)]
pub struct PersonaUseAck {
    pub id: String,
    /// Set when the frontend could not apply it at all (it threw). The BUSY refusal is decided in
    /// Rust, before the request is ever emitted.
    #[serde(default)]
    pub error: Option<String>,
    /// Whether the assignment landed.
    #[serde(default)]
    pub applied: bool,
    /// The persona the pane was running as, so the change is reversible from the output alone.
    #[serde(default)]
    pub previous: Option<String>,
    /// Whether the session was actually restarted.
    #[serde(default)]
    pub relaunched: bool,
}

/// In-flight requests, keyed by request id.
pub type PersonaUsePending = crate::app::ack::AckPending<PersonaUseAck>;

/// Ask the frontend to change a pane's persona, and block until it acks.
pub fn apply(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_persona::UseRequest,
) -> Result<bsc_persona::UseResult, String> {
    if req.pane_id.trim().is_empty() {
        return Err("persona use: no pane id".into());
    }
    if req.persona_id.trim().is_empty() {
        return Err("persona use: no persona id".into());
    }

    // Only a RELAUNCH can destroy work, so only a relaunch has to care whether the pane is busy.
    // `--no-relaunch` is safe against a working agent by construction.
    let was_busy = req.relaunch
        && app
            .try_state::<crate::console::pty::PtyState>()
            .map(|st| crate::console::pty::pane_liveness(vec![req.pane_id.clone()], &st))
            .and_then(|v| v.into_iter().next())
            .is_some_and(|p| p.busy);
    if was_busy && !req.force {
        return Err(format!(
            "persona use: '{}' is BUSY — something is running in it. Applying a persona relaunches the \
             session, so this needs --force (or --no-relaunch to stage it for next time). \
             `bsc fleet list` shows what is busy.",
            req.pane_id
        ));
    }

    let rx = crate::app::ack::register::<PersonaUseAck>(app, id);

    // The id rides in the payload so the frontend can correlate its ack — two callers could each have
    // one in flight, and an ack for the wrong one would report the wrong pane changed.
    let mut payload = serde_json::to_value(req).map_err(|e| e.to_string())?;
    payload
        .as_object_mut()
        .ok_or("persona use request did not serialize to an object")?
        .insert("id".into(), serde_json::Value::String(id.to_string()));

    app.emit("bsc://persona-use", payload)
        .map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        crate::app::ack::unregister::<PersonaUseAck>(app, id); // don't leak the slot when nobody ever answers
        format!(
            "the frontend did not apply the persona within {}ms — is a window open, or was it \
             mid-reload? (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    crate::app::ack::unregister::<PersonaUseAck>(app, id);

    if let Some(e) = ack.error {
        return Err(e);
    }
    if !ack.applied {
        return Err(format!(
            "persona use: the app could not apply '{}' to '{}' — the pane resolved to no open tab, or \
             the persona is not in its library.",
            req.persona_id, req.pane_id
        ));
    }
    Ok(bsc_persona::UseResult {
        pane_id: req.pane_id.clone(),
        persona_id: req.persona_id.clone(),
        previous: ack.previous,
        relaunched: ack.relaunched,
        was_busy,
    })
}

/// The frontend's answer, handed back to the blocked [`apply`].
#[tauri::command]
pub(crate) fn persona_use_ack(ack: PersonaUseAck, state: tauri::State<'_, PersonaUsePending>) {
    let tx = state.take(&ack.id);
    if let Some(tx) = tx {
        let _ = tx.send(ack);
    } else {
        // Late or duplicate: the waiter already timed out and unregistered. Not an error — but worth
        // saying, since it is the difference between "nobody answered" and "the answer arrived late".
        log::debug!("persona_use_ack: no waiter for {} (timed out already?)", ack.id);
    }
}

/// What the frontend sends back for a whatami.
///
/// `camelCase` IS LOAD-BEARING. The frontend sends `personaId`, `personaName`, `startPrompt` and
/// `pageTab`; without the rename those four silently deserialize to `None` while `id`, `error`,
/// `role`, `viewing` and `workspace` — the single-word fields — come through fine. The result reads
/// exactly like a pane that HAS a role and HAS no persona, which is what a designer session reported
/// when its persona had been assigned all along.
///
/// Nothing catches it by type: every field is `Option` with `#[serde(default)]`, precisely so a
/// partial ack is tolerated, so a missing field is indistinguishable from an absent value. The
/// sibling [`PersonaUseAck`] is not affected only because all of its fields happen to be one word,
/// which is luck rather than design — so the test below pins the wire shape rather than the struct.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhatamiAck {
    pub id: String,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub persona_id: Option<String>,
    #[serde(default)]
    pub persona_name: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub start_prompt: Option<String>,
    /// What the user is looking at, as the titlebar words it — the app's own `locationCrumb`.
    #[serde(default)]
    pub viewing: Option<String>,
    /// The rail destination being rendered.
    #[serde(default)]
    pub workspace: Option<String>,
    /// The active tab id — the graph's axis value.
    #[serde(default)]
    pub page_tab: Option<String>,
}

/// In-flight whatami requests, keyed by request id.
pub type WhatamiPending = crate::app::ack::AckPending<WhatamiAck>;

/// Ask the frontend what a pane is running as, and block until it answers.
///
/// The READ beside [`apply`]'s write, and it needs the same round trip for the same reason:
/// `paneRoles` and `panePersonas` are zustand state that Rust cannot see.
pub fn whatami(
    app: &tauri::AppHandle,
    id: &str,
    req: &bsc_persona::WhatamiRequest,
) -> Result<bsc_persona::WhatamiResult, String> {
    if req.pane_id.trim().is_empty() {
        return Err("persona whatami: no pane id".into());
    }

    let rx = crate::app::ack::register::<WhatamiAck>(app, id);

    let mut payload = serde_json::to_value(req).map_err(|e| e.to_string())?;
    payload
        .as_object_mut()
        .ok_or("persona whatami request did not serialize to an object")?
        .insert("id".into(), serde_json::Value::String(id.to_string()));

    app.emit("bsc://persona-whatami", payload)
        .map_err(|e| format!("cannot reach the frontend: {e}"))?;

    let drop_slot = || crate::app::ack::unregister::<WhatamiAck>(app, id);
    let ack = rx.recv_timeout(ACK_TIMEOUT).map_err(|_| {
        drop_slot();
        format!(
            "the frontend did not answer within {}ms — is a window open, or was it mid-reload? \
             (the app IS running; this is not a 'no app' timeout)",
            ACK_TIMEOUT.as_millis()
        )
    })?;
    drop_slot();

    if let Some(e) = ack.error {
        return Err(e);
    }
    Ok(bsc_persona::WhatamiResult {
        pane_id: req.pane_id.clone(),
        persona_id: ack.persona_id,
        persona_name: ack.persona_name,
        role: ack.role,
        start_prompt: ack.start_prompt,
        // Passed through verbatim rather than defaulted: an app that answers with no view has said
        // "I do not know", and inventing one here would be the same lie in a different place.
        viewing: ack.viewing,
        workspace: ack.workspace,
        page_tab: ack.page_tab,
    })
}

/// The frontend's answer, handed back to the blocked [`whatami`].
#[tauri::command]
pub(crate) fn persona_whatami_ack(ack: WhatamiAck, state: tauri::State<'_, WhatamiPending>) {
    let tx = state.take(&ack.id);
    if let Some(tx) = tx {
        let _ = tx.send(ack);
    } else {
        log::debug!("persona_whatami_ack: no waiter for {} (timed out already?)", ack.id);
    }
}

#[cfg(test)]
mod ack_wire_tests {
    use super::*;

    /// The EXACT payload the frontend sends must deserialize whole.
    ///
    /// THE BUG: `WhatamiAck` derived `Deserialize` with no `rename_all`, so `personaId`,
    /// `personaName`, `startPrompt` and `pageTab` all landed as `None` while `role` — one word —
    /// came through. `bsc persona whatami` then reported a pane with a role and no persona, and the
    /// persona had been assigned the whole time.
    ///
    /// Written as a literal JSON string rather than by serializing a Rust struct, because a
    /// round-trip through our own types would agree with itself whatever the names are. This is the
    /// FRONTEND's shape, copied from `describePane`'s return, and that is the thing that has to parse.
    #[test]
    fn the_frontends_camel_case_ack_deserializes_whole() {
        let sent = r#"{
            "id": "req-1",
            "personaId": "persona-designer",
            "personaName": "Designer",
            "role": "designer",
            "startPrompt": "You are the UI-kit designer",
            "viewing": "Components — React — bsc-kit",
            "workspace": "components",
            "pageTab": "react"
        }"#;
        let a: WhatamiAck = serde_json::from_str(sent).expect("the frontend's ack must parse");
        assert_eq!(a.persona_id.as_deref(), Some("persona-designer"));
        assert_eq!(a.persona_name.as_deref(), Some("Designer"));
        assert_eq!(a.role.as_deref(), Some("designer"));
        assert_eq!(a.start_prompt.as_deref(), Some("You are the UI-kit designer"));
        assert_eq!(a.viewing.as_deref(), Some("Components — React — bsc-kit"));
        assert_eq!(a.workspace.as_deref(), Some("components"));
        assert_eq!(a.page_tab.as_deref(), Some("react"));
    }

    /// A pane that genuinely has no persona still parses — the `Option`s are real, not a workaround
    /// for the rename. Both states have to be expressible or the fix above would just hide the bug.
    #[test]
    fn an_ack_for_a_pane_with_no_persona_still_parses() {
        let a: WhatamiAck = serde_json::from_str(r#"{"id":"r","role":"worker"}"#).unwrap();
        assert_eq!(a.role.as_deref(), Some("worker"));
        assert!(a.persona_id.is_none() && a.persona_name.is_none() && a.start_prompt.is_none());
    }

    /// The sibling ack is unaffected ONLY because its fields are single-word. Pinned so that adding a
    /// multi-word field to it fails here rather than silently dropping at runtime.
    ///
    /// The source is RESOLVED by [`crate::testutil::module_source`], never `include_str!`'d: this
    /// module's file is one `bsc graph migrate-crate src-tauri` deletes, and the resolver reads the
    /// materialized `$OUT_DIR/crate.rs` section once it has.
    #[test]
    fn the_sibling_ack_has_no_multi_word_field_to_lose() {
        let src = crate::testutil::module_source("session/persona_use.rs");
        let start = src.find("pub struct PersonaUseAck {").expect("struct present");
        let body = &src[start..start + src[start..].find('}').expect("closing brace")];
        let multi: Vec<&str> = body
            .lines()
            .filter_map(|l| l.trim().strip_prefix("pub "))
            .filter_map(|l| l.split(':').next())
            .filter(|f| f.contains('_'))
            .collect();
        assert!(
            multi.is_empty(),
            "PersonaUseAck gained a multi-word field ({multi:?}) — it needs \
             #[serde(rename_all = \"camelCase\")] like WhatamiAck, or that field will arrive as None",
        );
    }
}
