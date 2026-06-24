import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runRelayProbe,
  relayHealthUrl,
  relayWsBase,
  relayConnectUrl,
  freshRoomId,
  type MinimalSocket,
  type ProbeLegs,
} from "./relayProbe";

// ── A fake relay: sockets that open on a microtask and forward frames between peers in
// the same room, so the probe's three legs run against a faithful loopback without a
// live network. Flags let a test break a specific leg.
class FakeRelay {
  rooms = new Map<string, FakeSocket[]>();
  failHostOpen = false;
  failGuestOpen = false;
  dropFrames = false;

  make = (url: string): MinimalSocket => {
    const u = new URL(url.replace(/^wss?:\/\//, "https://"));
    const room = u.searchParams.get("room") ?? "";
    const role = u.searchParams.get("role") ?? "guest";
    const sock = new FakeSocket(this, room);
    queueMicrotask(() => {
      if (sock.closed) return;
      const fail = (role === "host" && this.failHostOpen) || (role === "guest" && this.failGuestOpen);
      if (fail) {
        sock.onerror?.({});
        return;
      }
      const peers = this.rooms.get(room) ?? [];
      peers.push(sock);
      this.rooms.set(room, peers);
      sock.onopen?.({});
    });
    return sock;
  };

  broadcast(room: string, from: FakeSocket, data: string) {
    if (this.dropFrames) return;
    for (const s of this.rooms.get(room) ?? []) {
      if (s !== from) s.onmessage?.({ data });
    }
  }

  remove(room: string, sock: FakeSocket) {
    const peers = this.rooms.get(room);
    if (peers) this.rooms.set(room, peers.filter((s) => s !== sock));
  }
}

class FakeSocket implements MinimalSocket {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;
  constructor(private relay: FakeRelay, private room: string) {}
  send(data: string) { this.relay.broadcast(this.room, this, data); }
  close() { this.closed = true; this.relay.remove(this.room, this); }
}

function healthFetch(opts: { status?: number; service?: string; version?: string; reject?: boolean }): typeof fetch {
  return (async () => {
    if (opts.reject) throw new Error("network down");
    const body = JSON.stringify({ ok: true, service: opts.service ?? "msc-tunnel-relay", version: opts.version ?? "0.1.0" });
    return new Response(body, { status: opts.status ?? 200 });
  }) as unknown as typeof fetch;
}

// Deterministic ids so a test can predict the room/nonce pair (room first, nonce second).
function counterIds(): () => string {
  let n = 0;
  return () => `id${n++}`;
}

afterEach(() => vi.useRealTimers());

describe("relay URL helpers", () => {
  it("relayHealthUrl normalizes any scheme to the https /health probe", () => {
    expect(relayHealthUrl("wss://r.example/")).toBe("https://r.example/health");
    expect(relayHealthUrl("r.example")).toBe("https://r.example/health");
  });

  it("relayWsBase / relayConnectUrl produce a wss /connect upgrade URL", () => {
    expect(relayWsBase("https://r.example/")).toBe("wss://r.example");
    expect(relayConnectUrl("https://r.example", "rm", "host")).toBe("wss://r.example/connect?room=rm&role=host");
  });

  it("freshRoomId is a valid relay room id (base64url, 16–64 chars)", () => {
    for (let i = 0; i < 25; i++) {
      expect(freshRoomId()).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    }
  });
});

describe("runRelayProbe — three distinct legs", () => {
  it("passes all three when the relay is reachable, joinable, and forwards a frame", async () => {
    const relay = new FakeRelay();
    const result = await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({ version: "1.2.3" }),
      makeSocket: relay.make,
      timeoutMs: 5000,
      genId: counterIds(),
    });
    expect(result.legs.reach.status).toBe("ok");
    expect(result.legs.reach.detail).toBe("v1.2.3");
    expect(result.legs.join.status).toBe("ok");
    expect(result.legs.relay.status).toBe("ok");
    expect(result.version).toBe("1.2.3");
  });

  it("fails at reach and skips the rest when the relay is unreachable", async () => {
    const relay = new FakeRelay();
    const makeSocket = vi.fn(relay.make);
    const result = await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({ reject: true }),
      makeSocket,
      timeoutMs: 5000,
      genId: counterIds(),
    });
    expect(result.legs.reach.status).toBe("fail");
    expect(result.legs.reach.detail).toBe("could not reach relay");
    expect(result.legs.join.status).toBe("skip");
    expect(result.legs.relay.status).toBe("skip");
    expect(makeSocket).not.toHaveBeenCalled(); // never tried to open a socket
  });

  it("fails at reach when a 200 isn't a tunnel relay", async () => {
    const relay = new FakeRelay();
    const result = await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({ service: "some-other-worker" }),
      makeSocket: relay.make,
      timeoutMs: 5000,
      genId: counterIds(),
    });
    expect(result.legs.reach.status).toBe("fail");
    expect(result.legs.reach.detail).toMatch(/not a tunnel relay/);
    expect(result.legs.join.status).toBe("skip");
  });

  it("reports the HTTP status when /health is an error", async () => {
    const relay = new FakeRelay();
    const result = await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({ status: 502 }),
      makeSocket: relay.make,
      timeoutMs: 5000,
      genId: counterIds(),
    });
    expect(result.legs.reach).toEqual({ status: "fail", detail: "relay returned HTTP 502" });
  });

  it("reaches but fails at join when the upgrade is rejected", async () => {
    const relay = new FakeRelay();
    relay.failHostOpen = true;
    const result = await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({}),
      makeSocket: relay.make,
      timeoutMs: 5000,
      genId: counterIds(),
    });
    expect(result.legs.reach.status).toBe("ok");
    expect(result.legs.join.status).toBe("fail");
    expect(result.legs.relay.status).toBe("skip");
  });

  it("joins but fails at relay when frames aren't forwarded (times out)", async () => {
    vi.useFakeTimers();
    const relay = new FakeRelay();
    relay.dropFrames = true;
    const p = runRelayProbe("https://r.example", {
      fetchFn: healthFetch({}),
      makeSocket: relay.make,
      timeoutMs: 1000,
      genId: counterIds(),
    });
    await vi.advanceTimersByTimeAsync(1100);
    const result = await p;
    expect(result.legs.reach.status).toBe("ok");
    expect(result.legs.join.status).toBe("ok");
    expect(result.legs.relay.status).toBe("fail");
    expect(result.legs.relay.detail).toMatch(/timed out/);
  });

  it("joins but fails at relay when the second peer can't join", async () => {
    const relay = new FakeRelay();
    relay.failGuestOpen = true;
    const result = await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({}),
      makeSocket: relay.make,
      timeoutMs: 5000,
      genId: counterIds(),
    });
    expect(result.legs.join.status).toBe("ok");
    expect(result.legs.relay.status).toBe("fail");
    expect(result.legs.relay.detail).toMatch(/second peer/);
  });

  it("emits progressive leg updates as each resolves", async () => {
    const relay = new FakeRelay();
    const snapshots: ProbeLegs[] = [];
    await runRelayProbe("https://r.example", {
      fetchFn: healthFetch({}),
      makeSocket: relay.make,
      timeoutMs: 5000,
      genId: counterIds(),
      onLeg: (legs) => snapshots.push(legs),
    });
    // reach resolves before relay does — an intermediate snapshot has reach ok while
    // relay is still pending/running.
    expect(snapshots.some((s) => s.reach.status === "ok" && s.relay.status !== "ok")).toBe(true);
    expect(snapshots[snapshots.length - 1].relay.status).toBe("ok");
  });
});
