// Pure helper for the warm-pool overflow sessions (#3535) — kept out of the component file so it is
// directly testable and so the mount stays a component-only module.
export { poolPaneId } from "@/shared/lib/session/requestSpawn";
import { DEBUG_START_PROMPT } from "./DebugSessionMount";

/**
 * The charter an OVERFLOW pool session launches with (#3535). Unlike the old per-request charter, it names
 * no specific request — an overflow session is a generic worker that CLAIMS the next available request on
 * startup, so it self-coordinates with the standing session and its pool siblings (the claim is atomic,
 * so no two ever take the same one).
 *
 * `--by "$BSC_AUDIT_PANE"` stamps the session's own pane id on the claim, which is how the pool tells a
 * busy session (holds a claim) from an idle one. The closing instruction is deliberate: a request must
 * never be left open with no explanation — "filed and silently unworked" is the failure this whole
 * feature exists to remove — and the resolve note IS the change log the maintainer reads back.
 */
export function poolCharter(): string {
  return (
    `${DEBUG_START_PROMPT}\n\n` +
    `YOU ARE AN OVERFLOW POOL SESSION. Claim the next available request and work ONLY that one:\n` +
    `  bsc request claim --by "$BSC_AUDIT_PANE" --json\n\n` +
    `If it prints a request, that request is yours — reproduce the failing command, implement the fix ` +
    `in the owning crate with tests, verify the gate, then:\n` +
    `  bsc request resolve <id> --note "<what you changed>"\n\n` +
    `The note is the change log — always leave one, even if it turns out NOT to be a defect (resolve it ` +
    `anyway with a note saying why; a request must never be left open with no explanation). Then STOP — ` +
    `your session is done and the pool will close it. If claim prints nothing, the queue is empty: stop.`
  );
}
