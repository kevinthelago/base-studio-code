import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { relayHealthUrl, TunnelSettings } from "./Tunnel";

// The card calls tunnelStatus() on mount; mock the client so it resolves a stable,
// not-running status (no QR, no polling) and the probe is the only network we drive.
vi.mock("../../lib/tunnel/tunnelClient", () => ({
  tunnelStart: vi.fn(),
  tunnelStop: vi.fn(),
  tunnelStatus: vi.fn().mockResolvedValue({
    running: false,
    relayUrl: null,
    room: null,
    hostPubKey: "",
    psk: "",
    clientCount: 0,
    inputGranted: false,
  }),
  tunnelSetInputGranted: vi.fn(),
  tunnelUnpair: vi.fn(),
}));

// `openUrl` is only invoked by the deploy button; stub the import so it never reaches a
// real Tauri bridge.
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

describe("relayHealthUrl", () => {
  it("appends /health to an https URL", () => {
    expect(relayHealthUrl("https://msc-tunnel-relay.me.workers.dev")).toBe(
      "https://msc-tunnel-relay.me.workers.dev/health",
    );
  });
  it("rewrites wss:// to https:// (the tunnel form to the probe form)", () => {
    expect(relayHealthUrl("wss://relay.me.workers.dev")).toBe(
      "https://relay.me.workers.dev/health",
    );
  });
  it("rewrites ws:// to http://", () => {
    expect(relayHealthUrl("ws://localhost:8787")).toBe("http://localhost:8787/health");
  });
  it("adds https:// when no scheme is given", () => {
    expect(relayHealthUrl("relay.me.workers.dev")).toBe("https://relay.me.workers.dev/health");
  });
  it("trims whitespace and a trailing slash", () => {
    expect(relayHealthUrl("  https://relay.me.workers.dev/  ")).toBe(
      "https://relay.me.workers.dev/health",
    );
  });
});

// A fake WebSocket for the join/relay legs: opens on a microtask and forwards frames
// between peers sharing a room, so the probe's later legs resolve without real network.
class FakeWS {
  static rooms = new Map<string, FakeWS[]>();
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  closed = false;
  private room: string;
  constructor(url: string) {
    const u = new URL(url.replace(/^wss?:\/\//, "https://"));
    this.room = u.searchParams.get("room") ?? "";
    queueMicrotask(() => {
      if (this.closed) return;
      const peers = FakeWS.rooms.get(this.room) ?? [];
      peers.push(this);
      FakeWS.rooms.set(this.room, peers);
      this.onopen?.({});
    });
  }
  send(data: string) {
    for (const s of FakeWS.rooms.get(this.room) ?? []) if (s !== this) s.onmessage?.({ data });
  }
  close() { this.closed = true; }
}

describe("TunnelSettings — Test relay button", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    FakeWS.rooms.clear();
    vi.stubGlobal("WebSocket", FakeWS);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const typeUrl = (url: string) => {
    const input = screen.getByPlaceholderText(/workers\.dev/i);
    fireEvent.change(input, { target: { value: url } });
  };

  it("runs all three legs when the relay is reachable, joinable, and forwards a frame", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true, service: "msc-tunnel-relay", version: "0.1.0" }),
      }),
    );
    render(<TunnelSettings />);
    typeUrl("https://relay.me.workers.dev");
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));
    // All three leg labels render; reachability surfaces the relay version.
    expect(screen.getByText("Reachable")).toBeInTheDocument();
    expect(screen.getByText("Room join")).toBeInTheDocument();
    expect(screen.getByText("Relay handshake")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/v0\.1\.0/)).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith(
      "https://relay.me.workers.dev/health",
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it("fails the reach leg and skips the rest when the host is unreachable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network error")));
    render(<TunnelSettings />);
    typeUrl("https://nope.me.workers.dev");
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/could not reach relay/i)).toBeInTheDocument());
    // The later legs are still listed (as skipped), not silently dropped.
    expect(screen.getByText("Room join")).toBeInTheDocument();
    expect(screen.getByText("Relay handshake")).toBeInTheDocument();
  });

  it("flags a reachable endpoint that is not a tunnel relay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ hello: "world" }) }),
    );
    render(<TunnelSettings />);
    typeUrl("https://example.com");
    fireEvent.click(screen.getByRole("button", { name: /^test$/i }));
    await waitFor(() => expect(screen.getByText(/not a tunnel relay/i)).toBeInTheDocument());
  });
});
