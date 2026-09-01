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
/// The worker-end verdict, decided where the PTY exits rather than in the renderer
/// (`the-worker-end-is-classified-where-the-pty-exits`). Caller for
/// `bsc_fleet::worker_end::classify_worker_end`.
pub mod worker_end;
