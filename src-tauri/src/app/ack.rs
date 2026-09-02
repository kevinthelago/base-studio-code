//! ONE pending-ack registry, generic over the payload.
//!
//! ## What this replaces
//!
//! `bsc graph dupes src-tauri/src` reported `register` and `unregister` as the two LARGEST same-shape
//! groups in this tree, seven members each. Behind them sat EIGHT structurally identical registries —
//! `DebugPending`, `WakePending`, `DirectorPending`, `StartPending`, `NavPending`, `LifecyclePending`,
//! `PersonaUsePending`, `WhatamiPending` — every one of them a
//! `Mutex<HashMap<String, Sender<SomeAck>>>` with its own `register`, its own `unregister`, and its
//! own ack path that locks and drains. The bodies differed only in the payload type.
//!
//! ## Why the eight newtypes could go ENTIRELY, rather than becoming eight one-line wrappers
//!
//! The thing that usually forces a newtype here is Tauri: managed state is looked up BY TYPE, so two
//! registries must be two types. But a generic INSTANTIATION already is one — `AckPending<DebugAck>`
//! and `AckPending<WakeAck>` are as distinct to `try_state` as the old structs were. So the wrapper
//! buys nothing and the whole layer disappears.
//!
//! ## No Tauri below this line, deliberately
//!
//! The registry is a `Mutex<HashMap<String, Sender<T>>>` and nothing more. Only the LOOKUP is Tauri,
//! and it stays at the call site in [`register`] / [`unregister`]. That keeps the part with the
//! interesting concurrency behaviour testable without an `AppHandle`, which is what let the drop and
//! poison guards below be pinned on the GENERIC instead of at one of eight call sites.
//!
//! ## The two behaviours that must survive the fold
//!
//! 1. **An ack for an id nobody waits on is DROPPED, not an error.** The waiter may already have
//!    timed out, and failing would surface a confusing error in the app for a request that is
//!    already dead. This was documented at ONE of the eight sites; it is now true by construction at
//!    all of them.
//! 2. **A poisoned mutex degrades, it does not panic.** Every old site wrote `if let Ok(..)` around
//!    the lock. A registry that panicked on a poisoned lock would take the app down over a dead
//!    request, which is strictly worse than losing the ack.

use std::collections::HashMap;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
// `try_state` is a `Manager` method, not an inherent one on `AppHandle`.
use tauri::Manager;

/// In-flight requests keyed by id: the waiter parks on the receiver, the frontend's ack delivers into
/// the sender.
pub struct AckPending<T>(Mutex<HashMap<String, Sender<T>>>);

/// Hand-written rather than `#[derive(Default)]`, and the difference is load-bearing: the derive
/// would add a `T: Default` bound, and none of the eight ack payloads is `Default`. An empty registry
/// does not need its payload to have a default.
impl<T> Default for AckPending<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<T> AckPending<T> {
    /// Park a waiter under `id` and hand back the receiver it should block on.
    ///
    /// A poisoned lock yields a receiver whose sender was never stored — so the caller times out
    /// rather than blocking forever, which is the same outcome the old per-site code produced.
    pub fn register(&self, id: &str) -> Receiver<T> {
        let (tx, rx) = channel();
        if let Ok(mut map) = self.0.lock() {
            map.insert(id.to_string(), tx);
        }
        rx
    }

    /// Drop the waiter for `id`, if any. Idempotent: unregistering an absent id is not an error, and
    /// every call site relies on that when it cleans up after a timeout.
    pub fn unregister(&self, id: &str) {
        if let Ok(mut map) = self.0.lock() {
            map.remove(id);
        }
    }

    /// Take the waiter for `id`, if any, WITHOUT delivering to it.
    ///
    /// [`deliver`](Self::deliver) is the better shape and most callers want it. This exists because
    /// the eight ack paths each carry their OWN drop branch — some log, one is deliberately silent,
    /// two carry a message worded for their surface — and folding those into one behaviour would
    /// have been a change smuggled in under a refactor. So the fold takes the part that is genuinely
    /// identical (lock, remove, hand back) and leaves each site's drop wording alone.
    pub fn take(&self, id: &str) -> Option<Sender<T>> {
        self.0.lock().ok().and_then(|mut m| m.remove(id))
    }

    /// Deliver `value` to whoever registered `id`.
    ///
    /// Returns whether anyone was actually waiting, so a caller that wants to log the drop can —
    /// WITHOUT being able to turn it into an error, which is the behaviour being preserved.
    pub fn deliver(&self, id: &str, value: T) -> bool {
        let tx = self.0.lock().ok().and_then(|mut m| m.remove(id));
        match tx {
            // A closed receiver is the timed-out case again: the send fails and that is not an error.
            Some(tx) => tx.send(value).is_ok(),
            None => false,
        }
    }

    /// Is a waiter parked under `id`? Read-only; an unreadable registry answers `false` rather than
    /// panicking, for the same reason every other accessor here degrades.
    ///
    /// TEST-ONLY, and deliberately so: production code registers, delivers and unregisters, and a
    /// caller that needed to ASK whether a waiter exists would be racing the answer. It is compiled
    /// in for tests because the cross-talk assertions the eight sites already had — "b's ack reaches
    /// b and leaves a parked" — are worth keeping, and they need to see the registry's contents.
    #[cfg(test)]
    pub fn contains(&self, id: &str) -> bool {
        self.0.lock().map(|m| m.contains_key(id)).unwrap_or(false)
    }

    /// How many waiters are parked. Test-only, for the same reason as `contains`; a lock we cannot
    /// take reports 0 rather than panicking.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.0.lock().map(|m| m.len()).unwrap_or(0)
    }

    #[cfg(test)]
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Park a waiter on the registry Tauri holds for `T`.
///
/// A MISSING registry still returns a receiver, exactly as the eight hand-written versions did: the
/// sender is simply dropped, so the caller's `recv_timeout` ends in a disconnect instead of a hang.
/// Returning an error here would make every call site handle a case that cannot happen in a running
/// app, and would have changed behaviour rather than folding it.
pub fn register<T: Send + 'static>(app: &tauri::AppHandle, id: &str) -> Receiver<T> {
    match app.try_state::<AckPending<T>>() {
        Some(state) => state.register(id),
        None => channel().1,
    }
}

/// Drop the waiter for `id` on the registry Tauri holds for `T`.
pub fn unregister<T: Send + 'static>(app: &tauri::AppHandle, id: &str) {
    if let Some(state) = app.try_state::<AckPending<T>>() {
        state.unregister(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for the eight real ack payloads. Deliberately NOT `Default`, so that the manual
    /// `Default` impl above is exercised rather than assumed.
    #[derive(Debug, PartialEq)]
    struct Ack(&'static str);

    #[test]
    fn a_registered_waiter_receives_its_ack() {
        let p: AckPending<Ack> = AckPending::default();
        let rx = p.register("req-1");
        assert_eq!(p.len(), 1);
        assert!(p.deliver("req-1", Ack("done")), "a parked waiter must be reported as delivered");
        assert_eq!(rx.recv().expect("the waiter receives"), Ack("done"));
    }

    #[test]
    fn an_ack_for_an_id_nobody_waits_on_is_dropped_not_an_error() {
        // BEHAVIOUR 1, and the whole reason `deliver` returns a bool rather than a Result. The waiter
        // may already have timed out; failing here would surface a confusing error in the app for a
        // request that is already dead. This was documented at ONE of the eight old sites and is now
        // true by construction at all of them.
        let p: AckPending<Ack> = AckPending::default();
        assert!(!p.deliver("nobody", Ack("x")), "an unknown id reports 'no waiter', never an error");
        assert!(p.is_empty());
    }

    #[test]
    fn a_delivered_ack_is_consumed_so_a_second_delivery_finds_nobody() {
        // The old code did `map.remove(&id)` on the ack path, not `get`. A registry that left the
        // sender in place would let a duplicate ack deliver twice.
        let p: AckPending<Ack> = AckPending::default();
        let _rx = p.register("req-1");
        assert!(p.deliver("req-1", Ack("first")));
        assert!(!p.deliver("req-1", Ack("second")), "the waiter must be consumed by the first ack");
    }

    #[test]
    fn a_timed_out_waiter_reports_as_undelivered_rather_than_erroring() {
        // The receiver is gone but the sender is still parked — `send` fails, and that is not an
        // error either.
        let p: AckPending<Ack> = AckPending::default();
        let rx = p.register("req-1");
        drop(rx);
        assert!(!p.deliver("req-1", Ack("late")), "a dropped receiver is a drop, not a failure");
    }

    #[test]
    fn unregister_is_idempotent_and_removes_the_waiter() {
        let p: AckPending<Ack> = AckPending::default();
        let _rx = p.register("req-1");
        p.unregister("req-1");
        p.unregister("req-1"); // every call site does this after a timeout; twice must be safe
        assert!(p.is_empty());
        assert!(!p.deliver("req-1", Ack("x")));
    }

    #[test]
    fn a_poisoned_lock_degrades_rather_than_panicking() {
        // BEHAVIOUR 2. Every old site wrapped its lock in `if let Ok(..)`. A registry that panicked
        // on a poisoned lock would take the app down over a dead request — strictly worse than
        // losing one ack.
        let p: AckPending<Ack> = AckPending::default();
        let _rx = p.register("req-1");
        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = p.0.lock().unwrap();
            panic!("poison the mutex");
        }));
        assert!(poisoned.is_err(), "the fixture must actually poison the lock");

        // None of these may panic.
        assert_eq!(p.len(), 0, "an unreadable registry reports empty rather than exploding");
        p.unregister("req-1");
        assert!(!p.deliver("req-1", Ack("x")));
        let _rx2 = p.register("req-2");
    }

    #[test]
    fn two_payload_types_are_two_independent_registries() {
        // This is what lets the eight newtypes go: a generic instantiation is already a distinct
        // type, so Tauri's by-type `try_state` lookup keeps them apart without a wrapper.
        #[derive(Debug, PartialEq)]
        struct Other(u8);
        let a: AckPending<Ack> = AckPending::default();
        let b: AckPending<Other> = AckPending::default();
        let _ra = a.register("same-id");
        assert_eq!(a.len(), 1);
        assert_eq!(b.len(), 0, "a same-named id in another registry must not collide");
        assert!(!b.deliver("same-id", Other(1)));
    }
}
