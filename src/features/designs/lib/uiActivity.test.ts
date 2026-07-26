// UI-activity live-focus (#2525) — the parser + poll hook that drives the designer AI's `ui-touch`
// stream into the store (setAiFocused). The bridge (`invoke("bsc", …)`) is the shared mock from
// src/test/setup.ts; here we drive its return per-test.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { parseUiActivityLine, latestUiTouch, useUiActivity } from "./uiActivity";
import { useAppStore } from "@/store";

const line = (collection: string, id: string, ts = "2026-07-07T00:00:00Z", pane = "design-studio:designer", kind = "ui-touch") =>
  `${ts}\t${pane}\t${kind}\t${collection}\t${id}`;

describe("parseUiActivityLine (#2525/#3545)", () => {
  it("parses a well-formed ui-touch (WRITE) line into kind + collection + id + ts", () => {
    const t = parseUiActivityLine(line("component", "button", "2026-07-07T00:00:00Z"));
    expect(t).toEqual({ kind: "touch", collection: "component", id: "button", pane: "design-studio:designer", at: Date.parse("2026-07-07T00:00:00Z") });
  });

  it("parses a ui-focus (READ, #3545) line as kind: focus", () => {
    const t = parseUiActivityLine(line("component", "chip", "2026-07-07T00:00:00Z", "design-studio:designer", "ui-focus"));
    expect(t).toMatchObject({ kind: "focus", collection: "component", id: "chip" });
  });

  it("rejects unknown kinds, short rows, an empty id, and tolerates a trailing newline", () => {
    expect(parseUiActivityLine("2026-07-07T00:00:00Z\tp\tlanded\tcomponent\tbutton")).toBeNull(); // wrong kind
    expect(parseUiActivityLine("2026-07-07T00:00:00Z\tp\tui-touch\tcomponent")).toBeNull();        // too few cols
    expect(parseUiActivityLine("2026-07-07T00:00:00Z\tp\tui-touch\tcomponent\t")).toBeNull();       // empty id
    expect(parseUiActivityLine(line("kit", "react-ui") + "\n")?.id).toBe("react-ui");               // trailing \n stripped
  });

  it("falls back to at=0 on an unparseable timestamp", () => {
    expect(parseUiActivityLine("nope\tp\tui-touch\ttheme\tneon")?.at).toBe(0);
  });
});

describe("latestUiTouch (#2525)", () => {
  it("returns the LAST parseable touch (chronological input), skipping junk lines", () => {
    const lines = [line("component", "button"), "garbage", line("theme", "neon")];
    expect(latestUiTouch(lines)).toMatchObject({ collection: "theme", id: "neon" });
  });
  it("returns null for an empty / all-junk log", () => {
    expect(latestUiTouch([])).toBeNull();
    expect(latestUiTouch(["", "not a line"])).toBeNull();
  });
});

describe("useUiActivity (#2525)", () => {
  beforeEach(() => {
    useAppStore.setState({ aiFocusedId: null });
    vi.mocked(invoke).mockReset();
  });

  /** Route the ui-log tail to `lines`; every other call resolves empty.
   *  #3630 moved this read IN-PROCESS: the hook calls `logsTail`, i.e. the `logs_tail` Tauri
   *  command returning a `string[]` — not `bsc logs tail ui` with a JSON-string stdout. */
  const mockBridge = (lines: string[]) =>
    vi.mocked(invoke).mockImplementation(async (cmd, payload) => {
      if (cmd === "logs_tail" && (payload as { stream?: string } | undefined)?.stream === "ui") return lines;
      return ""; // hydrate calls (loadComponents/etc.) degrade to empty → no-op
    });

  it("drives the most-recent touch into the store when the session is booted", async () => {
    mockBridge([line("component", "button"), line("component", "chip")]);
    renderHook(() => useUiActivity(true, 10));
    await waitFor(() => expect(useAppStore.getState().aiFocusedId).toBe("chip"));
  });

  it("drives a ui-focus (READ, #3545) into the store, so the preview follows Claude's inspection", async () => {
    mockBridge([line("component", "chip", "2026-07-07T00:00:00Z", "design-studio:designer", "ui-focus")]);
    renderHook(() => useUiActivity(true, 10));
    await waitFor(() => expect(useAppStore.getState().aiFocusedId).toBe("chip"));
  });

  it("does NOT poll (no bridge call) while inactive", async () => {
    mockBridge([line("component", "chip")]);
    renderHook(() => useUiActivity(false, 10));
    // Give the immediate tick a chance to run; it must early-return before touching the bridge.
    await new Promise((r) => setTimeout(r, 30));
    const logsCalls = vi.mocked(invoke).mock.calls.filter(([c]) => c === "logs_tail");
    expect(logsCalls.length).toBe(0);
    expect(useAppStore.getState().aiFocusedId).toBeNull();
  });
});
