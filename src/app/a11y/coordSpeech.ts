// Which coordination alerts to speak, by verbosity (#3804, a11y epic #2725 Tier 1). Pure so the
// policy is unit-tested without the engine. `AlertKind`/verbosity are the same taxonomy the ARIA
// announcer + mobile alerts use, so spoken output stays consistent with the rest of the app.
import type { AlertKind } from "@/features/tunnel";
import type { TtsVerbosity } from "@/shared/lib/a11y/speech";

// The needs-you / went-wrong alerts — the actionable ones, always spoken. `verbose` ADDS the progress
// alerts (`fleet-landed`, `gate-ready`) so a user driving by ear hears the fleet make headway too.
const TERSE_KINDS: readonly AlertKind[] = [
  "agent-paused",
  "prompt-waiting",
  "worker-question",
  "planner-waiting",
  "fleet-failed",
];

/** Whether an alert of `kind` should be spoken at the chosen `verbosity`. */
export function shouldSpeak(kind: AlertKind, verbosity: TtsVerbosity): boolean {
  return verbosity === "verbose" || TERSE_KINDS.includes(kind);
}
