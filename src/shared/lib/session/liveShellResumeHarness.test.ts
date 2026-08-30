import { describe, it, expect } from "vitest";
import { continueOrFresh, CONTINUE_OR_FRESH } from "@/shared/lib/session/ensureClaudeRunning";

// A resume reaches a pane by EITHER of two routes — the mount-time launch (`resolveInitCmd`) or a
// direct write into an already-live shell (`ensureClaudeRunning`). The module's own docs say both
// must emit the byte-identical command. `resolveInitCmd` was made harness-aware and the live-shell
// path was not, so `claude --continue` was typed into a `bsc-agent` pane: the wrong program started,
// exited, the pane went idle, the reaper reclaimed it, and the relaunch did it again — a session
// that would not start, on a terminal showing the typed command.
describe("both resume routes speak the pane's own harness", () => {
  it("builds the command from the harness it is given", () => {
    expect(continueOrFresh("bsc-agent")).toBe("bsc-agent --continue 2>/dev/null || bsc-agent");
    expect(continueOrFresh("claude")).toBe(CONTINUE_OR_FRESH);
  });

  it("never emits claude's command for a local pane", () => {
    // The specific regression: a bsc-agent pane must not be handed `claude` in any form.
    const cmd = continueOrFresh("bsc-agent");
    expect(cmd).not.toContain("claude");
  });

  it("falls back to the claude command only when no harness is known", () => {
    // A blank harness is the one case where the historical default is right — it is what every pane
    // carried before providers existed.
    expect(continueOrFresh("")).toBe(CONTINUE_OR_FRESH);
    expect(continueOrFresh("   ")).toBe(CONTINUE_OR_FRESH);
  });

  it("is shell-safe: one command, no newline that would run something unintended", () => {
    // It is typed into a live bash prompt and terminated with a newline by the caller, so an
    // embedded newline here would execute a second command.
    expect(continueOrFresh("bsc-agent")).not.toContain("\n");
  });
});
