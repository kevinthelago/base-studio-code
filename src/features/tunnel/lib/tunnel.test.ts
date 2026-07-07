import { describe, it, expect } from "vitest";
import {
  buildPanePayload,
  mapStatus,
  paneCountForLayout,
  paneKindFor,
  pairingPayload,
  TUNNEL_PROTOCOL_VERSION,
  type TunnelStatus,
  type PlanStateFrame,
  type PlanEventFrame,
  type PlanStatusFrame,
  type PlanAdvanceFrame,
  type PlanConfirmFrame,
  type PlanChatFrame,
  type PlanMessage,
} from "./tunnel";
import { STORE_DOMAINS } from "./tunnelClient";
import fixtures from "./tunnelProtocol.fixtures.json";

describe("pairingPayload", () => {
  const ready: TunnelStatus = {
    running: true,
    relayUrl: "wss://msc-tunnel-relay.me.workers.dev",
    room: "ROOMID0123456789",
    hostPubKey: "aG9zdC1rZXk=",
    psk: "0123456789abcdef",
    clientCount: 0,
    inputGranted: false,
  };

  it("returns the relay payload when connected with a room + keys", () => {
    expect(pairingPayload(ready)).toEqual({
      relayUrl: "wss://msc-tunnel-relay.me.workers.dev",
      room: "ROOMID0123456789",
      hostPubKey: "aG9zdC1rZXk=",
      psk: "0123456789abcdef",
    });
  });

  it("returns null until every field needed to pair is present", () => {
    expect(pairingPayload({ ...ready, running: false })).toBeNull();
    expect(pairingPayload({ ...ready, relayUrl: null })).toBeNull();
    expect(pairingPayload({ ...ready, room: null })).toBeNull();
    expect(pairingPayload({ ...ready, hostPubKey: "" })).toBeNull();
    expect(pairingPayload({ ...ready, psk: "" })).toBeNull();
  });
});

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

  it("appends extraPanes (e.g. the planner pane) with a matching session (#801)", () => {
    const { panes, sessions } = buildPanePayload({
      ...base,
      extraPanes: [{ id: "planning_proj", cwd: "/hub/proj", name: "Planner — Proj", status: "running" }],
    });
    expect(panes.map((p) => p.id)).toEqual(["t0p0", "t0p1", "planning_proj"]);
    const sess = sessions.find((s) => s.paneId === "planning_proj")!;
    expect(sess).toMatchObject({ status: "running", currentTask: "Planner — Proj" });
  });

  it("omits a disabled extra pane", () => {
    const { panes } = buildPanePayload({
      ...base,
      disabledPanes: { planning_proj: true },
      extraPanes: [{ id: "planning_proj", cwd: "/hub/proj", name: "Planner", status: "running" }],
    });
    expect(panes.map((p) => p.id)).toEqual(["t0p0", "t0p1"]);
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

  it("server pane_size uses paneId/cols/rows", () => {
    expect(Object.keys(serverToClient.pane_size).sort()).toEqual(
      ["cols", "paneId", "rows", "type"],
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

  it("client set_fcm_token carries the refreshed token (#846)", () => {
    expect(clientToServer.set_fcm_token).toMatchObject({ type: "set_fcm_token", fcmToken: expect.any(String) });
  });

  it("every message is tagged with a snake_case type", () => {
    const all = [...Object.values(serverToClient), ...Object.values(clientToServer)] as { type: string }[];
    for (const m of all) {
      expect(m.type).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });
});

// The live planning-session frames (#985 / #934). The fixture JSON below is the cross-repo
// sync source — keep it BYTE-IDENTICAL with mobile-studio-code/src/lib/planner/sync/fixtures
// (its fixtures.test.ts asserts the same payloads against the mobile TunnelServerMessage
// variants). Each test type-narrows a fixture against its frame interface (a compile-time
// check) plus a runtime shape guard.
describe("plan-session frames (#985 / #934)", () => {
  const { serverToClient, clientToServer } = fixtures;

  it("plan_state parses against PlanStateFrame (one file, one message, one run)", () => {
    const f = serverToClient.plan_state;
    const frame: PlanStateFrame = {
      type: "plan_state",
      projectId: f.projectId,
      currentStage: f.currentStage,
      confirmedSections: f.confirmedSections,
      files: f.files,
      messages: f.messages.map((m): PlanMessage => ({ role: m.role as PlanMessage["role"], text: m.text, at: m.at })),
      pipelineRuns: f.pipelineRuns,
    };
    expect(frame.files).toHaveLength(1);
    expect(frame.files[0].relpath).toBe("goal.md");
    expect(frame.messages[0].role).toBe("assistant");
    expect(frame.pipelineRuns[0]).toMatchObject({ id: "build", stage: "test", status: "running" });
  });

  it("plan_event parses against PlanEventFrame (section_confirmed)", () => {
    const f = serverToClient.plan_event;
    const frame: PlanEventFrame = {
      type: "plan_event",
      projectId: f.projectId,
      kind: f.kind as PlanEventFrame["kind"],
      at: f.at,
      section: f.section,
    };
    expect(frame.kind).toBe("section_confirmed");
    expect(frame.section).toBe("goal");
  });

  it("plan_status parses against PlanStatusFrame", () => {
    const f = serverToClient.plan_status;
    const frame: PlanStatusFrame = { type: "plan_status", projectId: f.projectId, currentStage: f.currentStage, status: f.status };
    expect(frame).toMatchObject({ currentStage: "scope", status: "in_progress" });
  });

  it("inbound drive frames parse against their interfaces", () => {
    const adv: PlanAdvanceFrame = { type: "plan_advance", projectId: clientToServer.plan_advance.projectId, stageKey: clientToServer.plan_advance.stageKey };
    const con: PlanConfirmFrame = { type: "plan_confirm", projectId: clientToServer.plan_confirm.projectId, section: clientToServer.plan_confirm.section };
    const chat: PlanChatFrame = { type: "plan_chat", projectId: clientToServer.plan_chat.projectId, text: clientToServer.plan_chat.text };
    expect(adv.stageKey).toBe("scope");
    expect(con.section).toBe("goal");
    expect(chat.text).toContain("specific");
  });

  it("plan_state keeps the camelCase wire fields the mobile client expects", () => {
    expect(Object.keys(serverToClient.plan_state).sort()).toEqual(
      ["confirmedSections", "currentStage", "files", "messages", "pipelineRuns", "projectId", "type"],
    );
  });
});

// ── Contract v2 (#2497): protocol version, store_state, pane kind, plan_sync shapes ──
describe("contract v2 fixtures (#2497)", () => {
  const { serverToClient, clientToServer } = fixtures;

  it("auth carries protocolVersion; auth_no_fcm pins BOTH optional fields absent", () => {
    expect(clientToServer.auth).toMatchObject({ type: "auth", protocolVersion: TUNNEL_PROTOCOL_VERSION });
    expect(clientToServer.auth_no_fcm).not.toHaveProperty("protocolVersion");
    expect(clientToServer.auth_no_fcm).not.toHaveProperty("fcmToken");
  });

  it("auth_ok echoes the desktop's protocolVersion + the connect-time input grant (#2511)", () => {
    expect(serverToClient.auth_ok).toEqual({
      type: "auth_ok",
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
      inputGranted: false,
    });
  });

  it("auth_ok_pre_grant pins the pre-#2511 shape (inputGranted optional for old desktops)", () => {
    expect(serverToClient.auth_ok_pre_grant).toEqual({
      type: "auth_ok",
      protocolVersion: TUNNEL_PROTOCOL_VERSION,
    });
  });

  it("input_grant_changed carries the bare granted flag (#2511, additive within v2)", () => {
    expect(serverToClient.input_grant_changed).toEqual({ type: "input_grant_changed", granted: true });
  });

  it("store_state is the domain-agnostic {domain, rev, json} projection frame", () => {
    expect(Object.keys(serverToClient.store_state).sort()).toEqual(["domain", "json", "rev", "type"]);
    // The fixture's domain is one of the registered vocabulary (the frame accepts any string).
    expect(STORE_DOMAINS).toContain(serverToClient.store_state.domain);
    expect(() => JSON.parse(serverToClient.store_state.json)).not.toThrow();
  });

  it("pane_list panes carry an OPTIONAL kind (v1 descriptors still valid)", () => {
    const panes = serverToClient.pane_list.panes as Array<{ id: string; kind?: string }>;
    expect(panes.find((p) => p.id === "t0p0")?.kind).toBe("console");
    expect(panes.find((p) => p.id === "t0p1")).not.toHaveProperty("kind"); // optionality pinned
    expect(panes.find((p) => p.id === "proj:api-core")?.kind).toBe("worker");
    expect(panes.find((p) => p.id === "planning_proj")?.kind).toBe("planner");
  });

  it("plan_sync frames are pinned to the Rust shapes (single project; files as arrays)", () => {
    // server → client
    expect(Object.keys(serverToClient.plan_sync_manifest).sort()).toEqual(["files", "projectId", "type"]);
    expect(serverToClient.plan_sync_manifest.files).toEqual({ "goal.md": "bf9cf968" });
    expect(Object.keys(serverToClient.plan_sync_files).sort()).toEqual(["files", "projectId", "type"]);
    expect(serverToClient.plan_sync_files.files).toEqual([{ relpath: "goal.md", content: "foobar" }]);
    expect(serverToClient.plan_sync_ack).toEqual({
      type: "plan_sync_ack", projectId: "proj-bf9cf968", applied: true,
    });
    // client → server
    expect(clientToServer.plan_sync_manifest_request).toEqual({
      type: "plan_sync_manifest_request", projectId: "proj-bf9cf968",
    });
    expect(clientToServer.plan_sync_pull).toEqual({
      type: "plan_sync_pull", projectId: "proj-bf9cf968", paths: ["goal.md"],
    });
    expect(clientToServer.plan_sync_push).toEqual({
      type: "plan_sync_push", projectId: "proj-bf9cf968", files: [{ relpath: "goal.md", content: "foobar" }],
    });
  });
});

// ── Session roster (#2497): identity ids + kind ───────────────────────────────
describe("paneKindFor — id grammar → wire kind", () => {
  it("maps worker AND director identity ids to worker (fleet sessions)", () => {
    expect(paneKindFor("proj:api-core")).toBe("worker");
    expect(paneKindFor("proj:director")).toBe("worker");
  });
  it("maps triage / planner ids", () => {
    expect(paneKindFor("proj:owner/repo:triage")).toBe("triage");
    expect(paneKindFor("planning_proj")).toBe("planner");
  });
  it("maps manual + legacy positional console ids to console", () => {
    expect(paneKindFor("man:tab-uuid:p0")).toBe("console");
    expect(paneKindFor("t0p0")).toBe("console");
  });
});

describe("buildPanePayload — identity roster (#2497)", () => {
  it("keys fleet-tab panes by their minted identity ids with kind worker", () => {
    const { panes } = buildPanePayload({
      tabs: [{ layout: "2×1", kind: "build", paneIds: ["proj:director", "proj:api-core"] }],
      paneNames: { 0: { 0: "director", 1: "api-core" } },
      paneCwds: { "proj:director": "/hub/proj", "proj:api-core": "/wt/api--api-core" },
      paneStatuses: { "proj:director": "run", "proj:api-core": "run" },
      disabledPanes: {},
      awaiting: new Set<string>(),
      nowIso: "2026-05-29T00:00:00.000Z",
    });
    expect(panes.map((p) => p.id)).toEqual(["proj:director", "proj:api-core"]);
    expect(panes.map((p) => p.kind)).toEqual(["worker", "worker"]);
    expect(panes[1].cwd).toBe("/wt/api--api-core"); // cwd resolved by IDENTITY id
  });

  it("keys manual-tab panes by their man:<tabId> identity ids with kind console", () => {
    const { panes, sessions } = buildPanePayload({
      tabs: [{ layout: "1×1", id: "tab-uuid" }],
      paneNames: {},
      paneCwds: { "man:tab-uuid:p0": "/repo" },
      paneStatuses: { "man:tab-uuid:p0": "run" },
      disabledPanes: {},
      awaiting: new Set<string>(),
      nowIso: "2026-05-29T00:00:00.000Z",
    });
    expect(panes).toEqual([
      { id: "man:tab-uuid:p0", cwd: "/repo", name: "console-1-1", status: "running", kind: "console" },
    ]);
    expect(sessions[0].paneId).toBe("man:tab-uuid:p0");
  });

  it("derives a kind for an extra pane that doesn't carry one, keeps an explicit one", () => {
    const { panes } = buildPanePayload({
      tabs: [],
      paneNames: {},
      paneCwds: {},
      paneStatuses: {},
      disabledPanes: {},
      awaiting: new Set<string>(),
      nowIso: "2026-05-29T00:00:00.000Z",
      extraPanes: [
        { id: "planning_proj", cwd: "/hub/proj", name: "Planner", status: "running" },
        { id: "design-studio:designer", cwd: "/design-studio", name: "Design Studio", status: "running", kind: "designer" },
      ],
    });
    expect(panes[0].kind).toBe("planner");   // derived from the planning_ grammar
    expect(panes[1].kind).toBe("designer");  // explicit kind wins (the id parses as worker)
  });
});
