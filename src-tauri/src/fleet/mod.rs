pub(crate) mod wake;
/// `bsc fleet director new` — the architect's create into the project tier
/// (#architect-creates-a-director-with-discovery). Sibling to `wake`: the same emit-and-ack shape,
/// because creating a pane is frontend state Rust cannot touch.
pub(crate) mod director_new;
pub mod worktree;
pub mod teardown;
pub mod disk;
pub mod director;
pub mod protocols;
pub mod inspect;
