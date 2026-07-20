// Pure helpers for the per-request debug sessions (#3498) — kept out of the component file so they are
// directly testable and so the mount stays a component-only module.
import type { OpenRequest } from "@/shared/lib/session/requestSpawn";
export { requestPaneId } from "@/shared/lib/session/requestSpawn";
import { DEBUG_START_PROMPT } from "./DebugSessionMount";

/**
 * The charter a request session launches with: the standing debug charter, narrowed to THIS request.
 *
 * It names the request id so the session knows exactly what to resolve, and inlines the reported text
 * so it starts from the problem instead of re-deriving it from the queue. The closing instruction is
 * deliberate — a request must never be left open with no explanation, because "filed and silently
 * unworked" is the failure this whole feature exists to remove.
 */
export function requestCharter(r: OpenRequest): string {
  const cited = r.cmd ? `\n\nThe exact command that failed: ${r.cmd}` : "";
  return (
    `${DEBUG_START_PROMPT}\n\n` +
    `YOU ARE WORKING REQUEST #${r.id} SPECIFICALLY — not the whole queue. Do not pick a different one.\n\n` +
    `Surface: ${r.surface}\nReported:\n${r.text}${cited}\n\n` +
    `When it is fixed and verified, run: bsc request resolve ${r.id} --note "<what changed>". ` +
    `If it turns out NOT to be a defect, resolve it anyway with a note saying why — a request must ` +
    `never be left open with no explanation.`
  );
}
