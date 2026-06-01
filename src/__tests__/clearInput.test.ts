import { describe, it, expect } from "vitest";
import { CLEAR_INPUT_BYTES } from "../lib/clearInput";

/**
 * #192: the Ctrl+Shift+Backspace shortcut sends these bytes to the PTY to wipe
 * pending input. Pin the choice — flipping the byte changes user-visible
 * behavior in both bash and claude.
 */
describe("CLEAR_INPUT_BYTES", () => {
  it("is Ctrl+U — the portable readline 'kill to start of line' control byte", () => {
    expect(CLEAR_INPUT_BYTES).toBe("\x15");
  });

  it("is a single byte — the PTY broadcast/write call should never fragment", () => {
    expect(CLEAR_INPUT_BYTES.length).toBe(1);
  });
});
