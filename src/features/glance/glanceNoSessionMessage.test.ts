// GLANCE'S NO-SESSION MESSAGE MUST NAME AN ACTION THAT EXISTS (`glance-names-an-action-that-exists`).
//
// THE DEFECT THIS CLOSES. Expanding a node whose pane was never seated reported
// "No session for this node yet — Resume brings the fleet up." — and the project Resume button had
// already been deleted from this workspace. The same record says so nine lines further down ("THE
// PROJECT RESUME BUTTON IS GONE ... `resumeProjectFleet` is no longer called from this workspace at
// all"), so the message was sending the user to a control the record itself documents as removed.
// Observed by the maintainer on politician-review's `lexicographer` node.
//
// WHAT THE STATE ACTUALLY IS, since the message has to be true and not merely inoffensive. The
// `not-live` branch is reached only AFTER `resumePaneSession(paneId)` has returned false, and that
// returns false exactly when `paneCwds[paneId]` is empty — "a pane nothing ever wired has nothing to
// resume" (the console slice's own words). So the node has never been seated by any launch, and
// `not-live` adds that it has no PTY either. `planResume` documents that outcome as BENIGN — "no PTY
// yet. Do nothing: the pane's mount will run the normal launch path" — so the message must not read
// as a failure. What seats such a pane is the project's fleet launch, which is the phrasing the Fleet
// page already uses for this same state ("Launch a fleet from a project's plan to fill the board").
//
// WHY A SOURCE SCAN. The message is set inside `expandNode`, a closure the record does not export, so
// there is nothing to call. Reaching it through a render means standing up a whole drilled fleet with
// a stubbed `pty_pane_runtime` — the expensive kind of test this codebase warns about, green for
// reasons unrelated to the claim. The claim here is about a STRING the record ships, which is a fact
// about the source. This mirrors `expandNeverNavigates.test.ts`, the guard for the sibling defect in
// the same record.
import { describe, it, expect } from "vitest";
import { loadStore } from "@scripts/lib/recordStore.mjs";

/** The message the `not-live` branch sets — captured from the branch itself, so a second
 *  `setResumeMsg` elsewhere in the record can never satisfy this by accident. */
const NOT_LIVE_BRANCH = /out\.get\(paneId\) === "not-live"\)\s*\{\s*setResumeMsg\(\s*"([^"]*)"\s*\)/;

/** Every string LITERAL handed to `setResumeMsg`. A literal is the only thing this guard can judge:
 *  `setResumeMsg(action.reason)` carries its own text, and `expand-node.ts` owns that one. */
const MESSAGE_LITERALS = /setResumeMsg\(\s*"([^"]*)"\s*\)/g;

describe("Glance's no-session message names an action that exists", () => {
  const rec = (loadStore("graph/components.db").implementations ?? []).find(
    (r: { id?: string }) => r.id === "glancepage",
  ) as { srcText?: string } | undefined;
  const src = rec?.srcText ?? "";

  it("reads the glancepage record, so the assertions below are not vacuous", () => {
    // An empty body would satisfy a `not.toMatch` perfectly, and would find no branch to capture.
    expect(src.length).toBeGreaterThan(10_000);
    expect(src).toContain("ensureClaudeRunning");
    expect(src).toMatch(NOT_LIVE_BRANCH);
  });

  it("tells a never-seated node what is TRUE and what actually seats it", () => {
    const msg = src.match(NOT_LIVE_BRANCH)?.[1];
    expect(msg).toBe(
      "No session for this node yet — launch this project's fleet from its plan.",
    );
  });

  it("never sends the user to the deleted project Resume control", () => {
    // The record's PROSE still names `Resume`/`resumeProjectFleet` to explain why they are gone, and a
    // guard that could not tell an explanation from user-facing copy would force the next reader to
    // delete the explanation to keep the gate green. So this reads the MESSAGES only.
    const messages = [...src.matchAll(MESSAGE_LITERALS)].map((m) => m[1]);
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) {
      expect(m, `a resume message names a control this workspace no longer has: "${m}"`)
        .not.toMatch(/\bResume\b/);
    }
  });

  it("does not present the benign `not-live` outcome as a failure", () => {
    // `planResume`: "`not-live` — no PTY yet. Do nothing: the pane's mount will run the normal launch
    // path." Nothing went wrong, so the copy must not say anything did.
    const msg = src.match(NOT_LIVE_BRANCH)?.[1] ?? "";
    expect(msg).not.toMatch(/\b(failed|failure|error|could not|couldn't|unable)\b/i);
  });
});
