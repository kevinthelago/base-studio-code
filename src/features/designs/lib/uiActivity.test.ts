/**
 * @vitest-environment jsdom
 *
 * This file lives under `lib/`, which vitest's `node` project covers, but it genuinely needs a DOM.
 * A per-file docblock beats the project's environment, so the requirement is stated where a reader
 * meets it. See the `projects` split in vitest.config.ts for why the default is `node` here.
 */
// UI-activity live-focus (#2525) — the parser + poll hook that drives the designer AI's `ui-touch`
// stream into the store (setAiFocused). The bridge (`invoke("bsc", …)`) is the shared mock from
// src/test/setup.ts; here we drive its return per-test.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { parseUiActivityLine, parseUiTouches, latestUiTouch, touchesSince, touchKey, useUiActivity } from "@/features/designs/lib/uiActivity";
import { useAppStore } from "@/store";

const line = (collection: string, id: string, ts = "2026-07-07T00:00:00Z", pane = "design-studio:designer", kind = "ui-touch") =>
  `${ts}\t${pane}\t${kind}\t${collection}\t${id}`;

/** A 6-column line — the kit rides as the last field (#live-focus-is-kit-filtered). */
const kitLine = (collection: string, id: string, kitId: string, ts = "2026-07-07T00:00:00Z", kind = "ui-touch") =>
  `${line(collection, id, ts, "design-studio:designer", kind)}\t${kitId}`;

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

describe("the kit column (#live-focus-is-kit-filtered)", () => {
  it("parses the 6th column as kitId, so a touch can be placed in a kit the app hasn't hydrated", () => {
    expect(parseUiActivityLine(kitLine("component", "chip", "mobile-studio-code"))).toMatchObject({
      collection: "component", id: "chip", kitId: "mobile-studio-code",
    });
  });

  it("still parses a legacy 5-column line, leaving kitId absent", () => {
    // The emitter gained a column; an existing ui-activity.log must not be orphaned by that. Absent
    // rather than "" so a consumer can tell "no kit reported" from "reported as empty" and fall back
    // to resolving the kit from the store.
    const t = parseUiActivityLine(line("component", "chip"));
    expect(t).toMatchObject({ id: "chip" });
    expect(t?.kitId).toBeUndefined();
  });

  it("treats a trailing EMPTY kit column as absent, not as a kit named \"\"", () => {
    // `ui_activity_line` omits the column when there is no kit, but a hand-written or truncated line
    // can still carry a bare trailing tab — and a kit id of "" would match no kit and silently block
    // the follow, which is the exact failure this work exists to remove.
    expect(parseUiActivityLine(`${line("theme", "neon")}\t`)?.kitId).toBeUndefined();
  });
});

describe("parseUiTouches / touchesSince (#live-focus-is-kit-filtered)", () => {
  it("returns EVERY parseable touch, so two events in the same second both survive", () => {
    // The old reader kept only the newest line per poll. Two writes inside one poll window meant one
    // was never displayed at all — observed twice in a real 200-line tail.
    const lines = [
      line("component", "compositiongraph", "2026-07-07T00:00:05Z"),
      line("component", "serverrow", "2026-07-07T00:00:05Z"),
    ];
    expect(parseUiTouches(lines).map((t) => t.id)).toEqual(["compositiongraph", "serverrow"]);
  });

  it("skips junk without dropping the batch", () => {
    expect(parseUiTouches([line("component", "a"), "garbage", line("theme", "neon")]).map((t) => t.id))
      .toEqual(["a", "neon"]);
  });

  it("returns only what arrived AFTER the marker", () => {
    const all = parseUiTouches([
      line("component", "a", "2026-07-07T00:00:01Z"),
      line("component", "b", "2026-07-07T00:00:02Z"),
      line("component", "c", "2026-07-07T00:00:03Z"),
    ]);
    expect(touchesSince(all, touchKey(all[0])).map((t) => t.id)).toEqual(["b", "c"]);
    expect(touchesSince(all, touchKey(all[2]))).toEqual([]);       // a quiet tick sees nothing new
  });

  it("returns EVERYTHING when the marker has rolled out of the window", () => {
    // More happened than the tail can show. Under-reporting a burst is the failure mode here, so the
    // visible remainder is returned rather than nothing.
    const all = parseUiTouches([line("component", "x"), line("component", "y")]);
    expect(touchesSince(all, "999:touch:component:gone").map((t) => t.id)).toEqual(["x", "y"]);
  });

  it("returns everything for an empty marker (the first tick primes from history)", () => {
    const all = parseUiTouches([line("component", "x"), line("component", "y")]);
    expect(touchesSince(all, "")).toHaveLength(2);
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
    useAppStore.setState({ aiFocusedId: null, aiTouches: [] });
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

  // These two pin the hook→store PLUMBING, not the kit rule, so they name the touched kit and put the
  // Studio in it. Before #auto-focus-in-kit-and-drop-the-activity-pills the focus was written whatever
  // the kit was, so a 5-column line with no kit happened to pass; now the kit has to actually match,
  // and stating it is better than depending on which kit the seed happens to list first.
  it("drives the most-recent touch into the store when the session is booted", async () => {
    useAppStore.setState({ designsKitId: "base-studio-code" });
    mockBridge([kitLine("component", "button", "base-studio-code"), kitLine("component", "chip", "base-studio-code")]);
    renderHook(() => useUiActivity(true, 10));
    await waitFor(() => expect(useAppStore.getState().aiFocusedId).toBe("chip"));
  });

  it("drives a ui-focus (READ, #3545) into the store, so the preview follows Claude's inspection", async () => {
    useAppStore.setState({ designsKitId: "base-studio-code" });
    mockBridge([kitLine("component", "chip", "base-studio-code", "2026-07-07T00:00:00Z", "ui-focus")]);
    renderHook(() => useUiActivity(true, 10));
    await waitFor(() => expect(useAppStore.getState().aiFocusedId).toBe("chip"));
  });

  it("drives the WHOLE window into the ring, so concurrent sessions are all visible (#live-focus-is-kit-filtered)", async () => {
    // Three sessions writing in one poll window. The old hook kept only the last, so the other two were
    // invisible — the reason a page full of live fleet work read as blank.
    mockBridge([
      kitLine("component", "workercard", "mobile-studio-code", "2026-07-07T00:00:01Z"),
      kitLine("component", "settings-security", "base-studio-code", "2026-07-07T00:00:02Z"),
      kitLine("component", "ui-btn", "mobile-studio-code", "2026-07-07T00:00:03Z"),
    ]);
    useAppStore.setState({ designsKitId: "base-studio-code", aiFocusedId: null });
    renderHook(() => useUiActivity(true, 10));
    await waitFor(() => expect(useAppStore.getState().aiTouches).toHaveLength(3));
    // Newest FIRST — every session's work reaches the ring, which is what feeds the decaying pulse.
    expect(useAppStore.getState().aiTouches.map((t) => t.id)).toEqual(["ui-btn", "settings-security", "workercard"]);
    // …but the head is in ANOTHER kit, so it does not take the focus
    // (#auto-focus-in-kit-and-drop-the-activity-pills). Writing an out-of-kit id here is what used to
    // empty the Inspector, so "ignored" has to mean the value is never written.
    expect(useAppStore.getState().aiFocusedId).toBeNull();
    // The kit rides through to the ring, which is what lets the store make that judgement at all.
    expect(useAppStore.getState().aiTouches[0].kitId).toBe("mobile-studio-code");
  });

  it("primes from history WITHOUT re-hydrating (the first tick is replaying the past)", async () => {
    // The tail is up to 50 lines the boot hydrate already loaded. Paying a full library reload for it
    // on every visit to the Studio buys nothing.
    const hydrateComponents = vi.fn();
    useAppStore.setState({ hydrateComponents });
    mockBridge([line("component", "chip"), line("component", "button")]);
    renderHook(() => useUiActivity(true, 10));
    await waitFor(() => expect(useAppStore.getState().aiTouches.length).toBeGreaterThan(0));
    expect(hydrateComponents).not.toHaveBeenCalled();
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
