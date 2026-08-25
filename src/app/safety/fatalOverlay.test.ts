import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isBenign } from "@/app/safety/fatalOverlay";

type Bridge = { invoke: (cmd: string, args: unknown) => Promise<unknown> };
const g = globalThis as { __TAURI_INTERNALS__?: Bridge };

/** A FRESH copy of the overlay — it latches after the first fatal, so each scenario needs its own. */
async function fresh() {
  vi.resetModules();
  return await import("@/app/safety/fatalOverlay");
}

/** Drive it through a REAL window `error` event — the path a crash actually takes.
 *
 *  Only ever asserted NEGATIVELY (nothing reported), because the listener this module installs at
 *  import cannot be removed: every fresh copy a previous test loaded is still listening, so a positive
 *  count here would be counting instances rather than behaviour. The positive assertions call `show`
 *  on the one instance under test. */
async function fireEvent(message: string) {
  await fresh();
  window.dispatchEvent(new ErrorEvent("error", { message }));
}

// Regression: the crash overlay must NOT fire on benign browser warnings — notably the
// ResizeObserver loop message the planner's resizable split panes emit on resize, which was
// surfacing as a full-screen "Uncaught error" overlay (false crash).
describe("fatalOverlay.isBenign", () => {
  it("ignores the ResizeObserver loop warnings", () => {
    expect(isBenign("ResizeObserver loop completed with undelivered notifications")).toBe(true);
    expect(isBenign("ResizeObserver loop limit exceeded")).toBe(true);
  });

  it("ignores the opaque cross-origin Script error", () => {
    expect(isBenign("Script error.")).toBe(true);
  });

  it("does NOT ignore real errors", () => {
    expect(isBenign("TypeError: Cannot read properties of undefined (reading 'x')")).toBe(false);
    expect(isBenign("")).toBe(false);
  });
});

// The overlay's durable half (the-app-starts-and-never-mounts-and-nothing-says-so).
//
// Everything the overlay knows dies with the window it painted into. Handing it to the backend is what
// turns a boot crash from a `<pre>` nobody can read afterwards into a `launch` fault carrying the real
// error — the alternative being the watchdog's message-less "the UI never mounted".
describe("fatalOverlay: handing the crash to the backend", () => {
  let prev: Bridge | undefined;
  beforeEach(() => {
    prev = g.__TAURI_INTERNALS__;
    document.querySelectorAll("[data-fatal-overlay]").forEach((n) => n.remove());
  });
  afterEach(() => {
    g.__TAURI_INTERNALS__ = prev;
    vi.restoreAllMocks();
  });

  it("reports a real crash through the bridge, with the message first and the stack alongside", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    g.__TAURI_INTERNALS__ = { invoke };
    const { show } = await fresh();
    show("Uncaught error", "TypeError: x is not a function\n  at boot (main.tsx:1:1)");

    expect(invoke).toHaveBeenCalledTimes(1);
    const [cmd, args] = invoke.mock.calls[0] as [string, { message: string; detail: string }];
    expect(cmd).toBe("boot_failed");
    // The title is one line — it becomes a fault title, and a multi-line one would break the TSV that
    // `bsc errors list` prints.
    expect(args.message).not.toContain("\n");
    expect(args.message).toContain("TypeError: x is not a function");
    expect(args.message).toContain("Uncaught error");
    expect(args.detail).toContain("at boot");
    // ...and it still did its own job.
    expect(document.querySelector("[data-fatal-overlay]")).toBeTruthy();
  });

  it("never reports a benign browser warning — a false fault would pin the app node red", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    g.__TAURI_INTERNALS__ = { invoke };
    await fireEvent("ResizeObserver loop completed with undelivered notifications");
    expect(invoke).not.toHaveBeenCalled();
    expect(document.querySelector("[data-fatal-overlay]")).toBeNull();
  });

  it("still paints when there is NO bridge — the case the overlay exists for", async () => {
    // A detached window may have no `__TAURI_INTERNALS__` at all. Reporting is a bonus; rendering the
    // crash is the mechanism, and it must not depend on the bonus succeeding.
    delete g.__TAURI_INTERNALS__;
    const { show } = await fresh();
    expect(() => show("Uncaught error", "TypeError: boom")).not.toThrow();
    expect(document.querySelector("[data-fatal-overlay]")?.textContent).toContain("TypeError: boom");
  });

  it("reports at most ONCE per window — the overlay latches, and so must the fault", async () => {
    const invoke = vi.fn().mockResolvedValue(undefined);
    g.__TAURI_INTERNALS__ = { invoke };
    const { show } = await fresh();
    show("Uncaught error", "TypeError: first");
    show("Uncaught error", "TypeError: second");
    // A crash usually cascades; a fault per cascaded error would bury the one that started it.
    expect(invoke).toHaveBeenCalledTimes(1);
    expect((invoke.mock.calls[0] as [string, { detail: string }])[1].detail).toContain("first");
  });

  it("survives a bridge that rejects — an older backend has no such command", async () => {
    const invoke = vi.fn().mockRejectedValue(new Error("unknown command boot_failed"));
    g.__TAURI_INTERNALS__ = { invoke };
    const { show } = await fresh();
    expect(() => show("Uncaught error", "TypeError: boom")).not.toThrow();
    expect(document.querySelector("[data-fatal-overlay]")).toBeTruthy();
  });
});
