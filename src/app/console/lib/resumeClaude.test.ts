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
    continueSession: false,
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

describe("resolveInitCmd — fleet/triage resume (#3928)", () => {
  const base = {
    explicit: undefined as string | undefined,
    startupPrompt: undefined as string | undefined,
    continueSession: false,
    paneWasClaude: true,
    autoResumeClaude: false,
    wasUncleanShutdown: false,
    restoreRequested: false,
  };

  it("RESUMES an explicitly-continued fleet pane on a clean restart — the #3928 regression", () => {
    // Without this the flag died between layers: `paneContinue` was set and forwarded to Rust, but
    // `plan_launch` only reads it on the PROMPT arm, so a resume (which carries no startup prompt)
    // fell through to LaunchPlan::None — a bare bash shell, `has_history=true · resumed=false`.
    expect(resolveInitCmd({ ...base, continueSession: true })).toBe("claude --continue");
  });

  it("does NOT continue a pane that never ran claude — there is no conversation to resume", () => {
    expect(resolveInitCmd({ ...base, continueSession: true, paneWasClaude: false })).toBe("");
  });

  it("a KICKOFF still wins — the prompt-baked path must not become a --continue", () => {
    // A startup prompt means claude launches WITH that prompt; layering --continue on top would
    // spawn a second claude before the first finished initialising.
    expect(resolveInitCmd({ ...base, continueSession: true, startupPrompt: "kickoff" })).toBe("");
  });

  it("an explicit init_cmd still outranks everything", () => {
    expect(resolveInitCmd({ ...base, continueSession: true, explicit: "npm run dev" })).toBe("npm run dev");
  });

  it("leaves #1041 intact — no continueSession, clean quit ⇒ still dormant", () => {
    expect(resolveInitCmd({ ...base, autoResumeClaude: true })).toBe("");
  });
});
