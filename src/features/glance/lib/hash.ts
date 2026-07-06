// The glance sample-data hash (#2421) — the one home for the private copies glanceData.ts and
// glanceFleet.ts each carried, derived from the shared `hashString` (shared/lib/core/format.ts)
// instead of re-implementing the loop.
//
// NOT plain `hashString`: the glance copies truncated each step with `| 0` (signed) and took a
// final `Math.abs`, while `hashString` truncates with `>>> 0` (unsigned). The per-step low 32 bits
// track identically either way (the 2^32 offset vanishes mod 2^32 under `* 31 + c`), so the two
// differ only in the FINAL reduction: when the sign bit is set, `Math.abs(h | 0)` = 2^32 − hashString.
// Reinterpreting `hashString`'s result as signed and abs-ing it therefore reproduces the historical
// values EXACTLY — which matters because the sample role / worker-count / status assignments
// (`hashAbs(id) % n`) must stay stable for existing projects.
import { hashString } from "@/shared/lib/core/format";

/** Stable small hash of a string → non-negative int (deterministic sample role/status/count
 *  assignment). Same outputs as the former private `hash()` copies — see the header. */
export function hashAbs(s: string): number {
  return Math.abs(hashString(s) | 0);
}
