import { describe, it, expect } from "vitest";
import { resolveInitCmd } from "../lib/resumeClaude";

/**
 * #36: panes that had claude running at last shutdown should auto-resume it
 * via `claude --continue` on next mount — but only when no other launch
 * intent already covers it.
 */
describe("resolveInitCmd", () => {
  const base = { paneWasClaude: false, autoResumeClaude: true } as const;

  it("returns '' for a pane that has never run claude — bash prompt as usual", () => {
    expect(resolveInitCmd({ ...base, explicit: undefined, startupPrompt: undefined })).toBe("");
  });

  it("returns 'claude --continue' when the pane had claude and the toggle is on", () => {
    expect(resolveInitCmd({
      explicit: undefined, startupPrompt: undefined,
      paneWasClaude: true, autoResumeClaude: true,
    })).toBe("claude --continue");
  });

  it("returns '' when the pane had claude but the user has disabled auto-resume", () => {
    expect(resolveInitCmd({
      explicit: undefined, startupPrompt: undefined,
      paneWasClaude: true, autoResumeClaude: false,
    })).toBe("");
  });

  it("yields to startupPrompt — triage/fleet kickoff drives its own claude launch", () => {
    // The pty_create backend bakes the prompt into a claude call; mounting
    // `claude --continue` on top would race two claude invocations.
    expect(resolveInitCmd({
      explicit: undefined,
      startupPrompt: "triage the issues",
      paneWasClaude: true, autoResumeClaude: true,
    })).toBe("");
    // Even an empty startup prompt counts — `undefined` means "no prompt
    // path", but an empty string still means the caller is using the prompt
    // channel (just with an empty payload).
    expect(resolveInitCmd({
      explicit: undefined,
      startupPrompt: "",
      paneWasClaude: true, autoResumeClaude: true,
    })).toBe("");
  });

  it("an explicit initCmd wins over everything — internal callers know best", () => {
    expect(resolveInitCmd({
      explicit: "echo hi",
      startupPrompt: "triage the issues",
      paneWasClaude: true, autoResumeClaude: true,
    })).toBe("echo hi");
  });
});
