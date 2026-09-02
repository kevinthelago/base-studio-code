//! `bsc disk` + `bsc worktree` — everything that reclaims space from a build tree.
//!
//! ## Why this is a `bsc` surface and not nine scripts
//!
//! It was nine `.mjs` files in `scripts/` (1,289 LOC), and that is where this logic could not be
//! reached from. `src-tauri/data/permissions/base.json` puts `bsc` in the 3-command MANDATORY tier —
//! auto-runnable by every role, no grant needed — while `node` sits in the 50-command BUILD tier. So
//! `bsc disk gc` runs unprompted for any session and `node scripts/gc.mjs` does not. They were also
//! undiscoverable: `bsc help` advertises its nouns, `ls scripts/` is not a surface.
//!
//! ## The shape it keeps from the JavaScript, deliberately
//!
//! Each operation was already split into a PURE decision module and a thin filesystem driver, and
//! that split is the reason the policies here are testable at all. It survives the port:
//!
//! | pure (no fs, no git)                    | driver                    | verb                |
//! |-----------------------------------------|---------------------------|---------------------|
//! | [`prune::plan_prune`] · `crate_name_of` | [`sweep::prune_incremental`] | `bsc disk prune` |
//! | [`unit::group_units`] · `parse_unit_file` | [`sweep::sweep_deps`]   | `bsc disk sweep`    |
//! | [`dedupe::plan_dedupe`]                 | [`link::run`]             | `bsc disk dedupe`   |
//! | [`pool::plan_cap`]                      | [`worktree::run_cap`]     | `bsc worktree cap`  |
//!
//! ## FAIL-SAFE BY CONTRACT — `gc`, `prune` and `sweep` only
//!
//! Those three run from the gate and from `build:plan`, i.e. ahead of every `npm run tauri -- dev`.
//! They swallow every error and return `Ok(())`. A janitor that can redden a gate or block a dev
//! launch would be worse than the garbage it collects; the worst outcome of a bug in them is that
//! nothing is swept.
//!
//! `dedupe` and `worktree cap` are NOT in that contract and must not be given it. They are explicit
//! commands — one rewrites files several trees share, the other deletes working trees — and a caller
//! that cannot tell "nothing to do" from "I failed and said nothing" would be the whole hazard.
//!
//! ## Ported from
//!
//! `scripts/{gc,prune-incremental,incremental-prune-plan,sweep-target,target-units,dedupe-deps,
//! dedupe-plan,cap-worktrees,worktree-pool-plan}.mjs`, all deleted with this change. Their four
//! colocated `.test.ts` files are carried over assertion-for-assertion into the `#[cfg(test)]`
//! modules beside each port — see `the-disk-janitors-move-to-bsc-disk-and-bsc-worktree`.

pub mod cli;
pub mod dedupe;
pub mod gc;
pub mod link;
pub mod pool;
pub mod prune;
pub mod root;
pub mod sweep;
pub mod unit;
pub mod worktree;

pub use root::repo_root;
