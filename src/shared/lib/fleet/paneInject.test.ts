// Injection into a live pane (#375, #4253). The ORDER and SEPARATION of the writes is the whole
// contract — every one of these assertions corresponds to a way the delivery has silently failed.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { injectPrompt, injectRedirect } from "./paneInject";
import * as invoker from "@/shared/lib/core/safeInvoke";

const ESC = String.fromCharCode(27);
const CR = String.fromCharCode(13);

type InvokeSpy = ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };

/** The `pty_write` calls, in order. */
function ptyWrites(spy: InvokeSpy): { paneId: string; data: string }[] {
  return spy.mock.calls
    .filter((c) => c[0] === "pty_write")
    .map((c) => c[1] as { paneId: string; data: string });
}

/** Just the `data` payloads, in order. */
function writes(spy: InvokeSpy): string[] {
  return ptyWrites(spy).map((w) => w.data);
}

describe("injectPrompt", () => {
  let spy: InvokeSpy;
  beforeEach(() => {
    vi.restoreAllMocks();
    spy = vi.spyOn(invoker, "safeInvoke").mockResolvedValue(undefined as never) as unknown as InvokeSpy;
  });

  it("pastes atomically, then submits with a SEPARATE Enter", async () => {
    await injectPrompt("p", "hello");
    const w = writes(spy);
    expect(w).toHaveLength(2);
    // Bracketed paste, so the TUI takes the whole string as one atomic paste rather than N keystrokes.
    expect(w[0]).toBe(`${ESC}[200~hello${ESC}[201~`);
    // A CR glued onto the same write is swallowed as content (a trailing newline) — the message then
    // sits in the composer, unsent.
    expect(w[1]).toBe(CR);
  });

  it("does NOT send ESC by default — a passive message must not interrupt a running turn", async () => {
    await injectPrompt("p", "hello");
    expect(writes(spy).some((d) => d === ESC)).toBe(false);
  });

  /** #4253: a pane STOPPED on a permission dialog is not in its composer. The paste lands in the dialog
   *  and the Enter confirms whatever option is highlighted — so the redirect was swallowed while the
   *  coordination log recorded it delivered, and the submit could answer a permission question nobody
   *  read. ESC must come FIRST and ALONE. */
  it("clearPending sends ESC first, as its own write, before the paste", async () => {
    await injectPrompt("p", "hello", { clearPending: true });
    const w = writes(spy);
    expect(w).toHaveLength(3);
    expect(w[0]).toBe(ESC);
    expect(w[1]).toBe(`${ESC}[200~hello${ESC}[201~`);
    expect(w[2]).toBe(CR);
  });

  it("clearPending: false behaves exactly like the default", async () => {
    await injectPrompt("p", "hello", { clearPending: false });
    expect(writes(spy)).toHaveLength(2);
  });
});

describe("injectRedirect", () => {
  let spy: InvokeSpy;
  beforeEach(() => {
    vi.restoreAllMocks();
    spy = vi.spyOn(invoker, "safeInvoke").mockResolvedValue(undefined as never) as unknown as InvokeSpy;
  });

  /** The named form exists so a call site declares INTENT ("this must land") rather than remembering a
   *  flag — the reason the wake paths kept using the passive form and kept failing to wake anything. */
  it("is the interrupting form: ESC, paste, Enter", async () => {
    await injectRedirect("p", "go");
    expect(writes(spy)).toEqual([ESC, `${ESC}[200~go${ESC}[201~`, CR]);
  });

  it("targets the pane it was given", async () => {
    await injectRedirect("proj:stream-a", "go");
    for (const w of ptyWrites(spy)) expect(w.paneId).toBe("proj:stream-a");
  });
});
