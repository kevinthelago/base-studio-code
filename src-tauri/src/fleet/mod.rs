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
/// The boot worktree reconciliation, wired to the Rust decision
/// (`a-reclaimed-worktree-reports-why-it-was-reclaimed`).
pub mod worktree_reconcile;
pub mod disk;
pub mod director;
pub mod protocols;
pub mod inspect;
