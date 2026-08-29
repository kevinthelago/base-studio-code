//! `bsc mem` — the MEMORY surface, and the counterpart to `bsc perf`.
//!
//! # Why this exists
//!
//! `bsc perf` was added because "the fleet could change performance but never measure it". That
//! argument was only half-served. A worker could read the frontend instrumentation — render commits,
//! phases, jank — and still had no way to answer the other two questions it is judged on:
//!
//! * **did my change cost memory?** Nothing on the surface answered it. The one real source of heap
//!   truth was `e2e/glanceProfile.spec.ts`, reachable only by someone able to run an npm script and
//!   read a printed table — which is precisely the shape
//!   `record-operations-belong-on-the-bsc-surface-not-in-scripts` exists to correct.
//! * **did my change cost build time?** Nothing recorded it. `bsc errors run` wrapped every build and
//!   kept only the failures, so a clean 90-second 8 GB build and a clean 20-second 2 GB build were the
//!   same event afterwards.
//!
//! # One noun, because a worker should not have to know which store holds the answer
//!
//! The measurements genuinely live in different places — build cost in the project's `error.db` (see
//! [`errordb`], written by `bsc errors run`), session RSS in the app's `perf.db`, heap in a browser
//! that has to be driven. Making a worker learn that map is how a surface goes unused. So: one noun.
//!
//! | verb | answers | source |
//! |---|---|---|
//! | `build` | what do builds cost, and is it moving? | `runs` in `error.db` |
//! | `compare` | did MY change help? | the same rows, split at a boundary |
//! | `growth` | is this live session leaking? | `perf.db`, via [`logs::perf`] |
//! | `app` | what does the running app hold? | the Chromium harness |
//!
//! # A READ surface
//!
//! Nothing here takes a write scope. `bsc mem` only ever reports what something else already recorded,
//! which is what lets it be given to every role without a grant.

pub mod app;
pub mod cli;
pub mod stats;
