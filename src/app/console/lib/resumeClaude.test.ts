import { describe, it, expect } from "vitest";
import { resolveInitCmd } from "./resumeClaude";

// #3937: `--continue` is emitted with a shell fallback, because a resume with no conversation exits 1
// having written ZERO bytes to stdout — which showed up as a dead `$` prompt rather than a failed
// command. Asserted as a constant so the three call sites stay in lockstep with resumeClaude.ts.
const CONTINUE_OR_FRESH = "claude --continue 2>/dev/null || claude";

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
    expect(resolveInitCmd({ ...base, wasUncleanShutdown: true })).toBe(CONTINUE_OR_FRESH);
  });

  it("does NOT silently resume on a crash when the toggle is off (the banner offers it instead)", () => {
    expect(resolveInitCmd({ ...base, wasUncleanShutdown: true, autoResumeClaude: false })).toBe("");
  });

  it("resumes on an explicit banner restore, regardless of the toggle or shutdown kind", () => {
    expect(resolveInitCmd({ ...base, autoResumeClaude: false, wasUncleanShutdown: false, restoreRequested: true }))
      .toBe(CONTINUE_OR_FRESH);
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
    expect(resolveInitCmd({ ...base, continueSession: true })).toBe(CONTINUE_OR_FRESH);
  });

  it("DOES start a pane that never ran claude — the premise of the old guard is gone (#3986)", () => {
    // This asserted `""` under #3928, on the reasoning "there is no conversation to resume". That was
    // true when `--continue` was emitted bare and would exit 1 on a pane with no history. #3937 made
    // the command degrade (`--continue … || claude`), so a missing conversation now starts a fresh
    // session — and the guard became a deadlock instead of a safeguard: `paneWasClaude` is set only
    // when claude STARTS, so requiring it blocked the launch that would have set it. 77 of 78 fleet
    // panes were stuck there.
    expect(resolveInitCmd({ ...base, continueSession: true, paneWasClaude: false })).toBe(CONTINUE_OR_FRESH);
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

describe("resolveInitCmd — the --continue fallback (#3937)", () => {
  const base = {
    explicit: undefined as string | undefined,
    startupPrompt: undefined as string | undefined,
    continueSession: false,
    paneWasClaude: false,
    autoResumeClaude: false,
    wasUncleanShutdown: false,
    restoreRequested: false,
  };

  it("NEVER emits a bare `claude --continue` — a missing conversation would leave a dead prompt", () => {
    // `plan_launch`'s history guard only covers the PROMPT arm; an init cmd goes down the INIT arm
    // verbatim. So the degrade has to live in the command itself, not in Rust's launch decision.
    const cmds = [
      resolveInitCmd({ ...base, continueSession: true, paneWasClaude: true }),
      resolveInitCmd({ ...base, paneWasClaude: true, restoreRequested: true }),
      resolveInitCmd({ ...base, paneWasClaude: true, autoResumeClaude: true, wasUncleanShutdown: true }),
    ];
    for (const c of cmds) {
      expect(c).not.toBe("claude --continue");
      expect(c).toContain("|| claude");
    }
  });

  it("an explicit initCmd is still passed through untouched", () => {
    // The override is the caller's business — we must not append a fallback to someone else's command.
    expect(resolveInitCmd({ ...base, explicit: "npm run dev", continueSession: true, paneWasClaude: true }))
      .toBe("npm run dev");
  });

  it("a kickoff (startupPrompt) still wins and emits nothing", () => {
    expect(resolveInitCmd({ ...base, startupPrompt: "go", continueSession: true, paneWasClaude: true })).toBe("");
  });
});

describe("resume does not require a prior claude run (#3986)", () => {
  const base = {
    explicit: undefined as string | undefined,
    startupPrompt: undefined as string | undefined,
    continueSession: false,
    paneWasClaude: false,
    autoResumeClaude: false,
    wasUncleanShutdown: false,
    restoreRequested: false,
  };

  it("starts claude in a pane where it has NEVER run — the deadlock", () => {
    // `paneWasClaude` is set only when claude actually starts, so requiring it meant the gate blocked
    // the very launch that would have set it. Measured: 77 of 78 fleet panes had no `paneWasClaude`,
    // i.e. Resume could not start an agent in any of them.
    expect(resolveInitCmd({ ...base, continueSession: true, paneWasClaude: false }))
      .toBe("claude --continue 2>/dev/null || claude");
  });

  it("still resumes a pane that HAS run claude", () => {
    expect(resolveInitCmd({ ...base, continueSession: true, paneWasClaude: true }))
      .toBe("claude --continue 2>/dev/null || claude");
  });

  it("a no-history pane starts FRESH rather than failing", () => {
    // What made dropping the guard safe: the command degrades on its own (#3937).
    expect(resolveInitCmd({ ...base, continueSession: true })).toContain("|| claude");
  });

  it("does nothing without continueSession — resume is opt-in per pane", () => {
    expect(resolveInitCmd({ ...base, continueSession: false, paneWasClaude: true })).toBe("");
  });

  it("a kickoff still wins over resume", () => {
    expect(resolveInitCmd({ ...base, startupPrompt: "go", continueSession: true })).toBe("");
  });

  it("CRASH recovery still requires paneWasClaude", () => {
    // The flag stays where the question it answers is the real one: after an unclean shutdown, "was
    // this ever a claude pane?" genuinely governs whether to restore it.
    expect(resolveInitCmd({ ...base, paneWasClaude: false, restoreRequested: true })).toBe("");
    expect(resolveInitCmd({ ...base, paneWasClaude: true, restoreRequested: true }))
      .toBe("claude --continue 2>/dev/null || claude");
  });
});
