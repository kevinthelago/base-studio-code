// Invoke round-trip timing (#3626).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { slowInvokeLine, startInvokeTimer, bscLabel, SLOW_INVOKE_MS } from "./invokeTiming";

describe("slowInvokeLine", () => {
  it("returns null under the threshold", () => {
    expect(slowInvokeLine("read_x", SLOW_INVOKE_MS - 1)).toBeNull();
    expect(slowInvokeLine("read_x", 0)).toBeNull();
  });

  it("formats a rounded [invoke] line at/over the threshold", () => {
    expect(slowInvokeLine("read_x", SLOW_INVOKE_MS)).toBe(`[invoke] read_x ${SLOW_INVOKE_MS}ms`);
    expect(slowInvokeLine("bsc ui list", 152.7)).toBe("[invoke] bsc ui list 153ms");
  });

  it("excludes the logging subsystem's own commands regardless of duration", () => {
    expect(slowInvokeLine("frontend_log", 5000)).toBeNull();
    expect(slowInvokeLine("log_get_scopes", 5000)).toBeNull();
  });

  it("checks exclusion against the real command, not the label", () => {
    // A bsc call is labelled `bsc …` but its command is "bsc" — never excluded.
    expect(slowInvokeLine("bsc ui list", 5000, "bsc")).toBe("[invoke] bsc ui list 5000ms");
    // A slow log_get_scopes is still excluded when the command is passed explicitly.
    expect(slowInvokeLine("log_get_scopes", 5000, "log_get_scopes")).toBeNull();
  });
});

describe("bscLabel", () => {
  it("labels by the first two args (subcommand + verb)", () => {
    expect(bscLabel(["ui", "list"])).toBe("bsc ui list");
    expect(bscLabel(["plan", "issue", "add", "x"])).toBe("bsc plan issue"); // extra args dropped
    expect(bscLabel(["skill"])).toBe("bsc skill");
    expect(bscLabel([])).toBe("bsc");
  });
});

describe("startInvokeTimer", () => {
  let nowSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(invoke).mockResolvedValue(undefined);
    nowSpy = vi.spyOn(performance, "now");
  });
  afterEach(() => nowSpy.mockRestore());

  it("emits a [invoke] warn line to the perf scope when the call ran slow", () => {
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1000 + SLOW_INVOKE_MS + 50);
    const done = startInvokeTimer("read_x");
    done();
    expect(invoke).toHaveBeenCalledWith("frontend_log", {
      level: "warn",
      scope: "perf",
      message: `[invoke] read_x ${SLOW_INVOKE_MS + 50}ms`,
    });
  });

  it("stays silent for a fast call", () => {
    nowSpy.mockReturnValueOnce(1000).mockReturnValueOnce(1010);
    const done = startInvokeTimer("read_x");
    done();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses the bsc command for exclusion so bsc labels always log when slow", () => {
    nowSpy.mockReturnValueOnce(0).mockReturnValueOnce(500);
    const done = startInvokeTimer(bscLabel(["ui", "list"]), "bsc");
    done();
    expect(invoke).toHaveBeenCalledWith("frontend_log", {
      level: "warn",
      scope: "perf",
      message: "[invoke] bsc ui list 500ms",
    });
  });
});
