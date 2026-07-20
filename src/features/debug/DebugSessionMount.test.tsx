import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { DEBUG_INIT_CMD, DEBUG_START_PROMPT, DEBUG_PANE_ID, DebugSessionMount } from "./DebugSessionMount";
import { useAppStore } from "@/store";

// The mount resolves the repo root over IPC and parks a TerminalSlot; neither is what this file is
// about, so both are stubbed to leave the LAUNCH CONTRACT (charter + resume flag) observable.
vi.mock("@/shared/lib/core/safeInvoke", () => ({
  safeInvoke: vi.fn(async () => "C:/repo"),
}));
vi.mock("@/app/console/terminal/TerminalSlot", () => ({
  TerminalSlot: () => null,
}));

describe("the debug session's launch contract (#3497)", () => {
  it("NEVER resumes a conversation — it launches fresh, always", () => {
    // THE regression. This pane's cwd is the repo root, shared with every other Claude session on the
    // machine, and `claude --continue` resumes the most recent conversation for a DIRECTORY. So a
    // resume here attaches to a stranger's session, and — because the charter is delivered fresh-only
    // — silently drops the instruction that makes this pane the debugger at all.
    expect(DEBUG_INIT_CMD).not.toMatch(/--continue/);
    expect(DEBUG_INIT_CMD).not.toMatch(/--resume/);
    expect(DEBUG_INIT_CMD).not.toMatch(/-c\b/);
    expect(DEBUG_INIT_CMD.trim()).toBe("claude");
  });

  it("carries the charter that sends it at the request queue", () => {
    // The charter is the ONLY thing that makes this session the debugger. If it stops naming the queue
    // command, the pane launches and does nothing — the exact silent failure #3497 was.
    expect(DEBUG_START_PROMPT).toContain("bsc request list --open");
    expect(DEBUG_START_PROMPT).toContain("bsc request resolve");
    expect(DEBUG_START_PROMPT).toMatch(/DEBUG session/);
  });

  it("keeps its stable, app-owned pane id", () => {
    expect(DEBUG_PANE_ID).toBe("debug-studio:debugger");
  });
});

describe("what the debug mount actually seeds into the store (#3497)", () => {
  beforeEach(() => useAppStore.setState({ debugSession: true, paneContinue: {}, paneStartupPromptText: {} }));

  it("seeds paneContinue FALSE — the flag TerminalView turns into `claude --continue`", () => {
    // THE mechanism the bug really lived in. `DEBUG_INIT_CMD` is only half the story: TerminalView
    // reads `paneContinue` at pty_create, so leaving it true would keep the pane resuming a foreign
    // conversation even with a fresh initCmd. Fixing only the initCmd would have looked right and
    // changed nothing.
    render(<DebugSessionMount />);
    return waitFor(() => {
      expect(useAppStore.getState().paneContinue[DEBUG_PANE_ID]).toBe(false);
    });
  });

  it("seeds the charter, so a fresh launch is told what it is", () => {
    render(<DebugSessionMount />);
    return waitFor(() => {
      expect(useAppStore.getState().paneStartupPromptText[DEBUG_PANE_ID]).toBe(DEBUG_START_PROMPT);
    });
  });
});
