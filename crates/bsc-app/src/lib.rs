//! `bsc app` — the application's own lifecycle.
//!
//! ## Why this is a `bsc` surface and not six scripts
//!
//! It was six `.mjs` files in `scripts/` (1,022 LOC), and that is where this logic could not be
//! reached from. `src-tauri/data/permissions/base.json` puts `bsc` in the 3-command MANDATORY tier —
//! auto-runnable by every role, no grant needed — while `node` sits in the 50-command BUILD tier. So
//! `bsc app status` runs unprompted for any session and `node scripts/app-status.mjs` does not. They
//! were also undiscoverable: `bsc help` advertises its nouns, `ls scripts/` is not a surface.
//!
//! ## The shape it keeps from the JavaScript, deliberately
//!
//! Each operation was already split into a PURE decision and a thin driver, and that split is the
//! only reason these policies are testable at all. It survives the port:
//!
//! | pure (no git, no fs)                        | driver              | verb               |
//! |---------------------------------------------|---------------------|--------------------|
//! | [`promote::plan_promote`] · `classify_gate_failure` · `gate_tree_moved` | [`promote::run`] | `bsc app promote` |
//! | [`status::judge_app_binary`]                | [`status::run`]     | `bsc app status`   |
//! | [`rebuild::kill_patterns`] · `should_kill`  | [`rebuild::run`]    | `bsc app rebuild`  |
//! | [`release::next_version`]                   | [`release::run`]    | `bsc app release`  |
//! | —                                           | [`hooks::run`]      | `bsc app hooks`    |
//!
//! ## WHICH WAY EACH VERB FAILS — they are not the same, and saying so is the point
//!
//! A boundary can fail, and which way it fails is a design choice rather than a detail:
//!
//! - **`promote` REFUSES ON DOUBT.** It moves the ref the running app is checked out at, so every
//!   uncertainty resolves to "stop". An unreadable gate verdict, a stale one, a gate tree that moved
//!   mid-run, an unreadable HEAD — each refuses. Nothing is moved on any refusal, and it says so,
//!   because the reader's next question is always "did it half-do it?".
//! - **`status` ANSWERS, NEVER ACTS**, and an error reads as "cannot tell", never as "current". It
//!   exists precisely because `--no-watch` traded a loud interruption for a quiet staleness.
//! - **`rebuild` STOPS on a real build error** rather than launching a stale app.
//! - **`release` REFUSES a dirty tracked tree.** It writes a commit and a tag.
//! - **`hooks` is EXPLICIT** — a hook that refuses operations must be something you chose, which is
//!   why it was never a postinstall.
//!
//! None of these is fail-safe in the way a janitor is. `bsc disk gc` swallows everything and exits 0
//! because it runs from the gate and its worst outcome is a rebuild; nothing here may borrow that
//! contract, because every verb in this crate either moves a ref or answers a question someone is
//! about to act on.
//!
//! ## Ported from
//!
//! `scripts/{promote-plan,promote-app,app-status,rebuild,release,install-hooks}.mjs`, all deleted
//! with this change. Their three colocated `.test.ts` files (43 assertions) are carried over into the
//! `#[cfg(test)]` modules beside each port — see `the-app-lifecycle-surface-moves-into-a-rust-crate`.

pub mod cli;
pub mod hooks;
pub mod promote;
pub mod rebuild;
pub mod release;
pub mod repo;
pub mod status;
