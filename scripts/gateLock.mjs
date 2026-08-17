// The full-gate concurrency lock (#ten-parallel-rust-sessions-will-oom-the-box).
//
// The decision rules live in the pure `gate-lock-plan.mjs`; this is the filesystem half.
//
// One full gate peaks at ~8 GB (jobs = 4) because `cargo nextest run --workspace` links ~41 test
// binaries. This box has ~16 GB free, so two fit and ten do not. Locks are SHARED ACROSS WORKTREES —
// they live under `~/.base-studio-code/locks/` rather than in `target/` — because the whole point is
// to bound the fleet's total memory, and every tree has its own `target/`.
//
// ## Fail-OPEN, deliberately
//
// If the lock mechanism itself breaks — unwritable directory, a permissions oddity — the gate RUNS
// rather than refusing. A gate that cannot start is a worse outcome than a memory risk: it blocks the
// one command standing between a change and `develop`. "Slots are busy" is not a failure and does
// wait; only an *error* in the machinery is waived.

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { lockIsStale, slotCount } from "./gate-lock-plan.mjs";

const LOCK_DIR = join(homedir(), ".base-studio-code", "locks");

/** A holder that has not finished in this long is treated as wedged. Generous on purpose: a genuinely
 *  slow full gate on a loaded box has been measured at ~180s, so this is an order of magnitude above
 *  the honest worst case and will only ever fire on something actually stuck. */
const MAX_HOLD_MS = 30 * 60_000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and belongs to someone else — still alive, so not stealable.
    return e.code === "EPERM";
  }
}

/** Try to claim `slot`. Returns the lock path on success, null if a live holder has it. */
function claim(slot) {
  const path = join(LOCK_DIR, `gate-${slot}.lock`);
  const record = JSON.stringify({ pid: process.pid, at: Date.now(), cwd: process.cwd() });
  try {
    writeFileSync(path, record, { flag: "wx" }); // exclusive create — the atomic part
    return path;
  } catch {
    // Occupied. Decide whether the holder is gone or wedged.
  }
  let held;
  try {
    held = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    held = null; // unreadable or truncated — treat as abandoned
  }
  const stale = lockIsStale({
    pidAlive: pidAlive(held?.pid),
    ageMs: Date.now() - (held?.at ?? 0),
    maxAgeMs: MAX_HOLD_MS,
  });
  if (!stale) return null;
  try {
    unlinkSync(path);
    writeFileSync(path, record, { flag: "wx" });
    return path;
  } catch {
    return null; // someone else won the race to steal it; that is fine, we retry another slot
  }
}

/**
 * Block until a gate slot is free, then return a release function.
 *
 * @param {(msg: string) => void} log used for the WAITING notice — a silent wait is indistinguishable
 *   from a hang, and an agent that cannot tell those apart will kill the gate.
 * @returns {Promise<() => void>}
 */
export async function acquireGateSlot(log) {
  const slots = slotCount(process.env.BSC_GATE_SLOTS);
  try {
    mkdirSync(LOCK_DIR, { recursive: true });
  } catch (e) {
    log(`gate lock unavailable (${e?.message ?? e}) — running anyway`);
    return () => {};
  }

  let announced = false;
  for (;;) {
    for (let slot = 0; slot < slots; slot += 1) {
      const path = claim(slot);
      if (path !== null) {
        return () => {
          try {
            unlinkSync(path);
          } catch {
            // already gone (stolen as stale, or cleaned by hand) — nothing to undo
          }
        };
      }
    }
    if (!announced) {
      announced = true;
      const holders = readdirSync(LOCK_DIR)
        .filter((f) => f.startsWith("gate-"))
        .length;
      log(
        `waiting for a full-gate slot (${holders}/${slots} in use) — a full gate peaks at ~8 GB and ` +
          `this machine fits ${slots}. Set BSC_GATE_SLOTS to change the limit.`
      );
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}
