// `fireInvoke` must not throw when `invoke` throws SYNCHRONOUSLY.
//
// A SINGLE-TEST FILE ON PURPOSE. Installing a throwing `invoke` and then running a second test in the
// same file fails for a reason that has nothing to do with `fireInvoke` — some other DEFERRED invoker in
// the environment reaches the throwing mock, reproduced with a pair where the first test never calls
// `fireInvoke` at all. Asserting the guard therefore needs a file with nothing after it; the non-thenable
// half of the same bug lives on the record's own paired test, where it is stable.
//
// The bug: `void invoke(...).catch(...)` chains `.catch` onto whatever `invoke` returned. A torn-down
// Tauri mock returns a non-thenable, and a throwing one raises before there is anything to chain — and
// callers fire this from timers and listeners, where nothing is on the stack. That escaped as an uncaught
// exception and turned a run with 7,095 PASSING tests red, blamed on an unrelated test.
import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { fireInvoke } from "@/shared/lib/core/safeInvoke";

describe("fireInvoke survives a backend that throws on call", () => {
  it("swallows a synchronous throw and still reports it through onError", () => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockImplementation(() => {
      throw new Error("backend gone");
    });
    const onError = vi.fn();
    expect(() => fireInvoke("do_x", { a: 1 }, onError)).not.toThrow();
    // SWALLOWED, NOT SILENT: the caller's observer still sees it, so the failure is reportable.
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});
