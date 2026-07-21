// reviewShot (#2623 slice 5c) — the I/O actuator that turns one captured preview shot into review
// findings. It composes the pure review prompts + parser (slice 5a, previewReview.ts) with the multimodal
// LLM call (oneShotVision): send the screenshot to Claude, parse the JSON reply into ReviewFinding[]. The
// caller (the inbox, slice 5d) folds the result into the confirm-gated inbox via mergeFindings. Kept thin
// so the pure logic stays in previewReview.ts and the only side effect here is the model call.

import type { LlmConfig } from "@/shared/lib/core/llmConfig";
import { oneShotVision } from "@/shared/lib/core/claudeComplete";
import {
  reviewSystemPrompt,
  reviewUserPrompt,
  parseFindings,
  type PreviewShot,
  type ReviewFinding,
} from "./previewReview";

/** Mint a stable-enough id for a finding of `shot` — the inbox dedups by shot+title (findingKey), so this
 *  only needs to be unique per (shot, review pass). `seq` disambiguates a batch that lands in one pass. */
function findingId(shot: PreviewShot, index: number, seq: number): string {
  return `${shot.id}:${seq}:${index}`;
}

/**
 * Review one captured shot with the vision model → its findings (all `status: "pending"`). Throws only on
 * a call failure (no key / unsupported provider / network) — a well-formed-but-unparseable reply yields
 * `[]` (parseFindings is tolerant), so a bad review surfaces as "no findings", never a crash.
 *
 * @param seq  a per-pass discriminator for the minted finding ids (default `0`); pass the shot index when
 *             reviewing several shots so their ids don't collide.
 */
export async function reviewShot(cfg: LlmConfig, shot: PreviewShot, seq = 0): Promise<ReviewFinding[]> {
  const reply = await oneShotVision(cfg, reviewSystemPrompt(), reviewUserPrompt(shot), [shot.image]);
  return parseFindings(reply, shot.id, (i) => findingId(shot, i, seq));
}
