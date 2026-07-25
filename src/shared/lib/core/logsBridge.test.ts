// In-process log-stream reads (#3630).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { logsTail, logsPaneActivity, logsDonePanes, canonicalStream, logEventName } from "./logsBridge";

describe("logsTail", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("invokes logs_tail with the stream/limit/oldest and returns the lines", async () => {
    vi.mocked(invoke).mockResolvedValue(["a", "b"]);
    expect(await logsTail("audit", 300)).toEqual(["a", "b"]);
    expect(invoke).toHaveBeenCalledWith("logs_tail", { stream: "audit", limit: 300, oldest: false });
  });

  it("passes oldest=true for the chronological (coord/ui) streams", async () => {
    vi.mocked(invoke).mockResolvedValue([]);
    await logsTail("coord", 1000, true);
    expect(invoke).toHaveBeenCalledWith("logs_tail", { stream: "coord", limit: 1000, oldest: true });
  });

  it("degrades to [] on a rejection by default", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc down"));
    expect(await logsTail("audit", 300)).toEqual([]);
  });

  it("honors a custom fallback (null) so callers can skip a tick on read failure", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc down"));
    expect(await logsTail("coord", 1000, true, null)).toBeNull();
  });
});

describe("logsPaneActivity", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("invokes logs_pane_activity (no args) and returns the rows", async () => {
    const rows = [{ pane: "p1", state: "run", at: 5 }];
    vi.mocked(invoke).mockResolvedValue(rows);
    expect(await logsPaneActivity()).toEqual(rows);
    expect(invoke).toHaveBeenCalledWith("logs_pane_activity", undefined);
  });

  it("degrades to [] on a rejection", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc down"));
    expect(await logsPaneActivity()).toEqual([]);
  });
});

describe("logsDonePanes", () => {
  beforeEach(() => vi.mocked(invoke).mockReset());

  it("invokes logs_done_panes (no args) and returns the panes", async () => {
    vi.mocked(invoke).mockResolvedValue(["pane-a"]);
    expect(await logsDonePanes()).toEqual(["pane-a"]);
    expect(invoke).toHaveBeenCalledWith("logs_done_panes", undefined);
  });

  it("degrades to [] on a rejection", async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error("ipc down"));
    expect(await logsDonePanes()).toEqual([]);
  });
});

describe("canonicalStream / logEventName (#3638)", () => {
  it("maps the read aliases to their canonical stream (mirrors Rust canonical_stream)", () => {
    expect(canonicalStream("audit")).toBe("tool");
    expect(canonicalStream("tools")).toBe("tool");
    expect(canonicalStream("skills")).toBe("skill");
  });

  it("passes canonical names through unchanged", () => {
    for (const s of ["coord", "activity", "done", "ui", "tool", "hook", "mcp", "skill", "perm"]) {
      expect(canonicalStream(s)).toBe(s);
    }
  });

  it("builds the logs:// event name off the CANONICAL stream, so a subscriber lines up with the emit", () => {
    expect(logEventName("coord")).toBe("logs://coord");
    expect(logEventName("activity")).toBe("logs://activity");
    expect(logEventName("audit")).toBe("logs://tool"); // aliased read → canonical event
  });
});
