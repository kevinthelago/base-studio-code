// Pure staleness rules for the full-gate concurrency lock (#ten-parallel-rust-sessions-will-oom-the-box).
//
// Side-effect-free and import-free, like the other `*-plan.mjs` helpers, so the rules that decide
// whether a lock may be STOLEN are unit-testable without processes or a filesystem
// (`scripts/gate-lock-plan.test.ts`).
//
// ## Why a lock at all
//
// MEASURED on 8c/16t / 32 GB with ~16 GB actually free: one `cargo nextest run --workspace` links ~41
// test binaries and peaks at 8.04 GB with `jobs = 4` (18.01 GB at the unset default). One app link
// alone peaks at 2.99 GB. So two full gates fit in what this box has free and ten do not — and the
// fleet is meant to run 10+ persona-restricted sessions, several of them editing Rust.
//
// Only the FULL gate is serialized. The scoped gate is what sessions run while iterating, it compiles
// one crate plus its dependents, and making agents queue for that would trade a real cost (waiting)
// against a risk they do not pose.
//
// ## Stealing has to be possible, or the lock is worse than no lock
//
// A holder that is killed — Ctrl-C, a crashed agent, a closed terminal — leaves its file behind. If
// that file were permanent, the first crash would wedge every future gate in the fleet. So a lock is
// stealable on two independent grounds, and both matter:
//   - **the holder is gone** — the normal case, detected by PID liveness;
//   - **the lock is older than `maxAgeMs`** — the belt-and-braces case, for a holder that is still
//     alive but wedged (a hung linker, a paused process), and for the PID-reuse case where some
//     unrelated process now owns that number.

/**
 * May an existing lock be taken over?
 *
 * @param {{pidAlive: boolean, ageMs: number, maxAgeMs: number}} lock
 * @returns {boolean}
 */
export function lockIsStale({ pidAlive, ageMs, maxAgeMs }) {
  if (!pidAlive) return true;
  return ageMs > maxAgeMs;
}

/**
 * How many gates may run at once, from the environment, with a measured default.
 *
 * The default is 2 because a gate is ~8 GB at `jobs = 4` and this box has ~16 GB free. It is an env
 * knob rather than a constant so a bigger machine — or a deliberately serialized run — needs no code
 * change. A non-numeric or non-positive value falls back rather than disabling the lock: `0` slots
 * would mean "no gate may ever run", which is never what someone meant to type.
 *
 * @param {string|undefined} raw
 * @returns {number}
 */
export function slotCount(raw) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : 2;
}
