import { describe, it, expect } from "vitest";
import { resolveInitCmd } from "./resumeClaude";

/**
 * #36 / #1041: panes that had claude running auto-resume via `claude --continue` — but ONLY as crash
 * recovery (an unclean shutdown with auto-resume opted in, OR a banner "restore" click). A clean quit
 * leaves sessions dormant.
 */
describe("resolveInitCmd", () => {
  // A pane that had claude, the user opted into silent auto-resume, but a CLEAN shutdown + no restore.
  const base = {
    explicit: undefined as string | undefined,
    startupPrompt: undefined as string | undefined,
    paneWasClaude: true,
    autoResumeClaude: true,
    wasUncleanShutdown: false,
    restoreRequested: false,
  };

  it("returns '' for a pane that has never run claude — bash prompt as usual", () => {
    expect(resolveInitCmd({ ...base, paneWasClaude: false, wasUncleanShutdown: true })).toBe("");
  });

  it("does NOT auto-resume after a CLEAN shutdown, even with the toggle on (#1041)", () => {
    expect(resolveInitCmd({ ...base })).toBe("");
  });

  it("silently resumes after an UNCLEAN shutdown when auto-resume is opted in", () => {
    expect(resolveInitCmd({ ...base, wasUncleanShutdown: true })).toBe("claude --continue");
  });

  it("does NOT silently resume on a crash when the toggle is off (the banner offers it instead)", () => {
    expect(resolveInitCmd({ ...base, wasUncleanShutdown: true, autoResumeClaude: false })).toBe("");
  });

  it("resumes on an explicit banner restore, regardless of the toggle or shutdown kind", () => {
    expect(resolveInitCmd({ ...base, autoResumeClaude: false, wasUncleanShutdown: false, restoreRequested: true }))
      .toBe("claude --continue");
  });

  it("yields to startupPrompt — triage/fleet kickoff drives its own claude launch", () => {
    expect(resolveInitCmd({ ...base, startupPrompt: "triage the issues", wasUncleanShutdown: true })).toBe("");
    // An empty startup prompt still means the caller is using the prompt channel.
    expect(resolveInitCmd({ ...base, startupPrompt: "", restoreRequested: true })).toBe("");
  });

  it("an explicit initCmd wins over everything — internal callers know best", () => {
    expect(resolveInitCmd({ ...base, explicit: "echo hi", startupPrompt: "triage", restoreRequested: true })).toBe("echo hi");
  });
});
