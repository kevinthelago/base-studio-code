import { describe, it, expect } from "vitest";
import { useAppStore } from "@/store";

// A cold start must keep the three per-pane facts a launch is assembled from. Losing any of them
// produced a session that LOOKED restored and was not:
//
//   paneStartupPromptDocs — the kickoff pointer. Gone ⇒ no task ⇒ `resolveInitCmd` returns the bare
//     harness placeholder ⇒ a bare `bsc-agent` blocks on stdin ⇒ BLANK SCREEN. (Measured on the
//     twitter-clone-test director: kickoff present on disk, pointer gone.)
//   paneInitCmds — the harness, and what carries `--continue`. Gone ⇒ `resumed=false` ⇒ the agent
//     starts cold beside a 54 KB conversation.json it never reads.
//   paneCheckpointDocs — where a handoff is written. Gone ⇒ `$BSC_CHECKPOINT_DOC` unset ⇒ the whole
//     handoff mechanism is inert.
const LAUNCH_FACTS = [
  "paneCwds",
  "paneRoles",
  "paneModels",
  "paneProviders",
  "paneCheckpointDocs",
  "paneStartupPromptDocs",
  "paneInitCmds",
];

describe("a cold start keeps every fact its launch is assembled from", () => {
  const persisted = () =>
    (useAppStore.persist?.getOptions?.().partialize?.(useAppStore.getState() as never) ??
      {}) as Record<string, unknown>;

  it("persists all of them, not most of them", () => {
    // The gap was always PARTIAL — some survived, one did not — which is exactly what made each
    // instance invisible: the pane came back looking right.
    const missing = LAUNCH_FACTS.filter((k) => !Object.prototype.hasOwnProperty.call(persisted(), k));
    expect(missing, `these would be lost on a cold start: ${missing.join(", ")}`).toEqual([]);
  });

  it("keeps the kickoff pointer specifically — its loss is the blank screen", () => {
    expect(Object.prototype.hasOwnProperty.call(persisted(), "paneStartupPromptDocs")).toBe(true);
  });

  it("keeps the harness specifically — its loss is the lost history", () => {
    expect(Object.prototype.hasOwnProperty.call(persisted(), "paneInitCmds")).toBe(true);
  });
});
