import { describe, it, expect, vi, beforeEach } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { planResume, ensureClaudeRunning, CONTINUE_OR_FRESH, type PaneRuntime } from "./ensureClaudeRunning";

const rt = (paneId: string, live: boolean, busy: boolean): PaneRuntime => ({ paneId, live, busy });

describe("planResume (#3998)", () => {
  it("starts a pane that is live but idle", () => {
    // The whole bug: a PTY sitting at a bash `$` prompt. `pty_create` reconnects and never runs the
    // resolved init cmd, so this is the only pane state a resume can and must act on.
    expect(planResume([rt("p", true, false)]).get("p")).toBe("started");
  });

  it("leaves a busy pane alone", () => {
    // The safety property. A descendant means something is mid-flight — typing `claude` into a live
    // agent's TUI would corrupt its turn.
    expect(planResume([rt("p", true, true)]).get("p")).toBe("already-running");
  });

  it("leaves a pane with no PTY to the normal launch path", () => {
    // Not an error: the pane's mount runs `pty_create` for real, which honours `--continue` itself.
    // Writing to a session that doesn't exist would be dropped by the backend anyway.
    expect(planResume([rt("p", false, false)]).get("p")).toBe("not-live");
  });

  it("classifies each pane independently", () => {
    const plan = planResume([rt("idle", true, false), rt("working", true, true), rt("gone", false, false)]);
    expect([...plan]).toEqual([["idle", "started"], ["working", "already-running"], ["gone", "not-live"]]);
  });
});

describe("ensureClaudeRunning (#3998)", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  function mockRuntimes(runtimes: PaneRuntime[]) {
    vi.mocked(invoke).mockImplementation(async (cmd: string) =>
      (cmd === "pty_pane_runtime" ? runtimes : undefined) as never);
  }

  it("writes the resume command only into idle live panes", async () => {
    mockRuntimes([rt("idle", true, false), rt("working", true, true), rt("gone", false, false)]);
    await ensureClaudeRunning(["idle", "working", "gone"]);

    const writes = vi.mocked(invoke).mock.calls.filter((c) => c[0] === "pty_write");
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toEqual({ paneId: "idle", data: `${CONTINUE_OR_FRESH}\n` });
  });

  it("submits the command — a write with no newline would sit unexecuted at the prompt", () => {
    // Pinned separately because the failure is invisible: the text appears in the terminal, so the
    // pane LOOKS resumed while no agent ever starts.
    expect(CONTINUE_OR_FRESH.endsWith("\n")).toBe(false);
    expect(`${CONTINUE_OR_FRESH}\n`).toMatch(/\n$/);
  });

  it("degrades to a fresh session when there is no conversation to resume", () => {
    // #3937: `claude --continue` with no history exits 1 having written ZERO bytes, which is what made
    // a resumed pane look like a dead prompt. The `|| claude` is what stops that.
    expect(CONTINUE_OR_FRESH).toBe("claude --continue 2>/dev/null || claude");
  });

  it("asks the backend once for the whole batch", async () => {
    // The busy probe walks the process table; one walk for N panes is the reason the command is
    // batched at all. A regression to per-pane calls would be silent except under load.
    mockRuntimes([rt("a", true, false), rt("b", true, false), rt("c", true, false)]);
    await ensureClaudeRunning(["a", "b", "c"]);
    expect(vi.mocked(invoke).mock.calls.filter((c) => c[0] === "pty_pane_runtime")).toHaveLength(1);
  });

  it("does not call the backend at all for an empty pane list", async () => {
    await ensureClaudeRunning([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});
