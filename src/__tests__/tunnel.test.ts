import { describe, it, expect } from "vitest";
import {
  buildPanePayload,
  mapStatus,
  paneCountForLayout,
} from "../lib/tunnel";
import fixtures from "../lib/tunnelProtocol.fixtures.json";

describe("paneCountForLayout", () => {
  it("multiplies cols × rows", () => {
    expect(paneCountForLayout("2×2")).toBe(4);
    expect(paneCountForLayout("3×3")).toBe(9);
    expect(paneCountForLayout("1×1")).toBe(1);
  });
  it("returns 0 for a malformed layout", () => {
    expect(paneCountForLayout("")).toBe(0);
    expect(paneCountForLayout("garbage")).toBe(0);
  });
});

describe("mapStatus", () => {
  it("maps a running pane to running regardless of awaiting", () => {
    expect(mapStatus("run", false)).toBe("running");
    expect(mapStatus("run", true)).toBe("running");
  });
  it("maps idle + awaiting to awaiting_input", () => {
    expect(mapStatus("idle", true)).toBe("awaiting_input");
    expect(mapStatus(undefined, true)).toBe("awaiting_input");
  });
  it("maps idle/on without awaiting to idle", () => {
    expect(mapStatus("idle", false)).toBe("idle");
    expect(mapStatus("on", false)).toBe("idle");
    expect(mapStatus(undefined, false)).toBe("idle");
  });
});

describe("buildPanePayload", () => {
  const base = {
    tabs: [{ layout: "2×1" }],
    paneNames: { 0: { 0: "api" } },
    paneCwds: { t0p0: "/repo/api", t0p1: "/repo/web" },
    paneStatuses: { t0p0: "run", t0p1: "idle" } as Record<string, "run" | "on" | "idle">,
    disabledPanes: {},
    awaiting: new Set<string>(),
    nowIso: "2026-05-29T00:00:00.000Z",
  };

  it("emits one descriptor + session per live pane, in pane order", () => {
    const { panes, sessions } = buildPanePayload(base);
    expect(panes.map((p) => p.id)).toEqual(["t0p0", "t0p1"]);
    expect(sessions.map((s) => s.paneId)).toEqual(["t0p0", "t0p1"]);
  });

  it("uses the stored name, falling back to a console-N-M default", () => {
    const { panes } = buildPanePayload(base);
    expect(panes[0].name).toBe("api"); // from paneNames
    expect(panes[1].name).toBe("console-1-2"); // default for unnamed t0p1
  });

  it("carries cwd and maps status", () => {
    const { panes } = buildPanePayload(base);
    expect(panes[0]).toMatchObject({ cwd: "/repo/api", status: "running" });
    expect(panes[1]).toMatchObject({ cwd: "/repo/web", status: "idle" });
  });

  it("marks awaiting-input panes from the awaiting set", () => {
    const { panes, sessions } = buildPanePayload({ ...base, awaiting: new Set(["t0p1"]) });
    expect(panes[1].status).toBe("awaiting_input");
    expect(sessions[1].status).toBe("awaiting_input");
  });

  it("omits disabled panes entirely", () => {
    const { panes } = buildPanePayload({ ...base, disabledPanes: { t0p1: true } });
    expect(panes.map((p) => p.id)).toEqual(["t0p0"]);
  });

  it("stamps lastActivity and leaves prompt null", () => {
    const { sessions } = buildPanePayload(base);
    expect(sessions[0].lastActivity).toBe("2026-05-29T00:00:00.000Z");
    expect(sessions[0].prompt).toBeNull();
  });
});

// Guards that the shared fixture keeps the exact camelCase wire shape the mobile
// client (mobile-studio-code/src/lib/types.ts) expects. These frames are carried
// unchanged inside the relay's Noise envelope, so a drift here breaks the mobile
// client regardless of transport and both repos must coordinate (#46).
describe("shared protocol fixture", () => {
  const { serverToClient, clientToServer } = fixtures;

  it("server pane_output uses paneId/data/coarse", () => {
    expect(Object.keys(serverToClient.pane_output).sort()).toEqual(
      ["coarse", "data", "paneId", "type"],
    );
  });

  it("server session_state uses the mobile camelCase fields", () => {
    expect(Object.keys(serverToClient.session_state).sort()).toEqual(
      ["currentTask", "lastActivity", "paneId", "prompt", "status", "type"],
    );
  });

  it("client auth carries token (+ optional fcmToken)", () => {
    expect(clientToServer.auth).toMatchObject({ type: "auth", token: expect.any(String), fcmToken: expect.any(String) });
    expect(clientToServer.auth_no_fcm).not.toHaveProperty("fcmToken");
  });

  it("every message is tagged with a snake_case type", () => {
    const all = [...Object.values(serverToClient), ...Object.values(clientToServer)] as { type: string }[];
    for (const m of all) {
      expect(m.type).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});
