pub(crate) mod wake;
/// On-demand commons/integration lane provisioning `wake` falls back to (#132).
pub(crate) mod commons;
/// `bsc fleet director new` — the architect's create into the project tier
/// (#architect-creates-a-director-with-discovery). Sibling to `wake`: the same emit-and-ack shape,
/// because creating a pane is frontend state Rust cannot touch.
pub(crate) mod director_new;
pub(crate) mod start;
pub mod worktree;
pub mod teardown;
pub mod disk;
pub mod director;
pub mod protocols;
pub mod inspect;
/// The warden's ENFORCEMENT loop, moved off the render loop
/// (`the-warden-quarantines-from-rust-instead-of-the-render-loop`). The decision that hard-pauses a
/// drifting worker now runs on the backend's own schedule, beside the sessions it pauses.
pub mod warden;
