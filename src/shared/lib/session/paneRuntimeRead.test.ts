// Live pane facts come from the PTY host, and the ways that read can fail stay distinguishable
// (`frontend-state-6-live-pane-facts-come-from-the-pty-host`).
//
// The thing worth pinning is not that the read works. It is that nothing here can strand a live session
// or keep a dead one alive — the two directions a wrong status breaks, because the same word drives the
// idle reaper's clock AND the pane chrome:
//
//   · a pane the host is TRACKING must never read `idle`  (the reaper would take a live session, and
//     Glance would draw a working agent as never-launched);
//   · a pane the host has FORGOTTEN must never keep reading `run` (a stale "running" dot forever, and a
//     studio session whose kill is deferred indefinitely);
//   · a read that DID NOT HAPPEN must not look like either of those.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  readPaneRuntimes, readAllPaneRuntimes, readLiveSessionCount, isPaneWorking, isPanePresent,
  paneStatusMap, runStateMap, isKnownRunState, KNOWN_RUN_STATES,
} from "@/shared/lib/session/paneRuntimeRead";

/** Every `pty_activity` call the reader made. */
const activityCalls = (): unknown[] =>
  vi.mocked(invoke).mock.calls.filter(([cmd]) => cmd === "pty_activity");

/** Reply as the host does: one `[paneId, silentMs, runState]` row per pane it is tracking. */
function reply(rows: [string, number, string][]): void {
  vi.mocked(invoke).mockResolvedValue(rows as never);
}

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("the pane runtime read", () => {
  it("asks the host ONCE for the whole list, deduped, and answers every id asked", async () => {
    reply([
      ["proj:api", 1_200, "run"],
      ["proj:ui", 45_000, "idle"],
    ]);
    const got = await readPaneRuntimes(["proj:api", "proj:ui", "proj:api", ""]);

    // One round trip for the whole list — `pty_activity` takes no ids and returns the whole registry.
    expect(activityCalls()).toHaveLength(1);
    expect(activityCalls()[0]).toEqual(["pty_activity", undefined]);
    expect(got?.size).toBe(2);
    expect(got?.get("proj:api")?.status).toBe("run");
    expect(got?.get("proj:ui")?.status).toBe("on");
  });

  it("reports a pane the host is NOT tracking as idle and not present — not as a missing entry", async () => {
    reply([["proj:api", 1_200, "run"]]);
    const got = await readPaneRuntimes(["proj:api", "proj:reaped"]);
    const gone = got?.get("proj:reaped");

    // Asked about, so it MUST be in the answer: a missing entry is not a possible answer, so no caller
    // has to decide what an absent pane meant.
    expect(got?.size).toBe(2);
    expect(gone).toBeDefined();
    expect(gone?.present).toBe(false);
    expect(gone?.status).toBe("idle");
    expect(gone?.runState).toBeUndefined();
    expect(gone?.silentMs).toBeUndefined();
    expect(isPanePresent(gone)).toBe(false);
    // THE LATCH DIRECTION: a forgotten pane must not go on reading `run`.
    expect(isPaneWorking(gone)).toBe(false);
  });

  it("never reads a TRACKED pane as idle — the host holding a session is at least `on`", async () => {
    // `idle` and `unknown` are the host's words for a session whose agent has exited or never marked
    // itself. Both still mean the session EXISTS, which is `on`. Reading either as `idle` would strand
    // a live session: the reaper ages it and Glance draws it as never-launched.
    reply([
      ["proj:exited", 90_000, "idle"],
      ["proj:nomarker", 5_000, "unknown"],
    ]);
    const got = await readPaneRuntimes(["proj:exited", "proj:nomarker"]);

    expect(got?.get("proj:exited")?.status).toBe("on");
    expect(got?.get("proj:nomarker")?.status).toBe("on");
    expect(got?.get("proj:exited")?.present).toBe(true);
    expect(got?.get("proj:nomarker")?.present).toBe(true);
    expect(paneStatusMap(got!)).toEqual({ "proj:exited": "on", "proj:nomarker": "on" });
  });

  it("says the READ failed with null, rather than reporting that every session is dead", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no bridge") as never);
    expect(await readPaneRuntimes(["proj:api"])).toBeNull();
    expect(await readLiveSessionCount()).toBeNull();
  });

  it("treats an unusable answer as a failed read, not as an empty machine", async () => {
    // The bridge resolved, but with something that is not a row list. Reporting `idle` for every pane
    // here is the same lie as reporting it for a dead bridge.
    vi.mocked(invoke).mockResolvedValue({ panes: [] } as never);
    expect(await readPaneRuntimes(["proj:api"])).toBeNull();
  });

  it("answers an empty request with an empty map and asks the host nothing", async () => {
    const got = await readPaneRuntimes([]);
    expect(got).not.toBeNull();
    expect(got?.size).toBe(0);
    expect(activityCalls()).toHaveLength(0);
  });

  it("keeps an UNRECOGNISED host word visible, and reads it as `on` rather than resting or working", async () => {
    reply([["proj:api", 3_000, "sleeping"]]);
    const got = await readPaneRuntimes(["proj:api"]);
    const view = got?.get("proj:api");

    // Neither `idle` (would strand it) nor `run` (would defer its reap forever). `on` is the floor the
    // host's own row already justifies: a session exists.
    expect(view?.status).toBe("on");
    expect(view?.runState).toBe("sleeping");
    expect(isKnownRunState("sleeping")).toBe(false);
    expect(isKnownRunState("run")).toBe(true);
    expect(KNOWN_RUN_STATES).toEqual(["run", "idle", "unknown"]);
  });

  it("carries the host's silence clock, which is last OUTPUT and not a status change", async () => {
    reply([["proj:api", 45_000, "run"]]);
    const got = await readPaneRuntimes(["proj:api"]);
    expect(got?.get("proj:api")?.silentMs).toBe(45_000);
  });

  it("counts live sessions from the host's registry rather than from mounted terminals", async () => {
    reply([
      ["proj:api", 1, "run"],
      ["proj:ui", 2, "idle"],
      ["design-studio:designer-react", 3, "unknown"],
    ]);
    // Every tracked pane counts, whatever it is doing and whether or not a terminal is mounted on it.
    expect(await readLiveSessionCount()).toBe(3);
  });

  it("omits an untracked pane from the run-state map, so no overlay reads it as reported-on", async () => {
    reply([["proj:api", 1_200, "run"]]);
    const got = await readPaneRuntimes(["proj:api", "proj:reaped"]);

    // The studio/crate overlays test MEMBERSHIP (`sid in signals.runState`) to mean "the host reported
    // on this pane", so a word here for a pane with no session would make a dead node read live.
    expect(runStateMap(got!)).toEqual({ "proj:api": "run" });
    expect("proj:reaped" in runStateMap(got!)).toBe(false);
    // …while the STATUS map does mention it, because `idle` there is the host's answer and not a default.
    expect(paneStatusMap(got!)).toEqual({ "proj:api": "run", "proj:reaped": "idle" });
  });

  it("reports EVERY pane the host tracks, including one no roster mentions", async () => {
    // The case this form exists for: a session launched headlessly is in no tab cell and has no
    // mounted terminal, so no list the frontend could pass would name it.
    reply([
      ["proj:api", 1_000, "run"],
      ["orphan:operator", 2_000, "idle"],
    ]);
    const got = await readAllPaneRuntimes();

    expect(got?.size).toBe(2);
    expect(got?.get("orphan:operator")?.present).toBe(true);
    expect(got?.get("orphan:operator")?.status).toBe("on");
    expect(paneStatusMap(got!)).toEqual({ "proj:api": "run", "orphan:operator": "on" });
  });

  it("says the whole-registry read failed with null rather than an empty registry", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("no bridge") as never);
    expect(await readAllPaneRuntimes()).toBeNull();
  });

  it("distinguishes a host holding NO sessions from a read that failed", async () => {
    reply([]);
    const got = await readAllPaneRuntimes();
    // An empty registry is a real answer — the machine has nothing running — and must not be `null`.
    expect(got).not.toBeNull();
    expect(got?.size).toBe(0);
  });

  it("ignores a malformed row instead of minting a pane from it", async () => {
    reply([["", 1, "run"], ["proj:api", 1, "run"]] as [string, number, string][]);
    const got = await readPaneRuntimes(["proj:api"]);
    expect(got?.size).toBe(1);
    expect(got?.get("proj:api")?.status).toBe("run");
  });
});
