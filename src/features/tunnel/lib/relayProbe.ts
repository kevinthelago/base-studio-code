// Relay self-test — the "Test relay" probe behind Settings → Mobile tunnel (#930).
//
// Pairing depends on three independent things working, and a single pass/fail hides
// WHICH one is broken. So the probe runs three distinct legs and reports each:
//   1. reach — the relay answers `GET /health` and identifies itself (DNS/TLS/HTTP +
//      "is this actually a tunnel relay?").
//   2. join  — a WebSocket upgrade to `/connect` is accepted into a room (the Durable
//      Object path, not just the static health endpoint).
//   3. relay — two peers in the same room can exchange a frame end-to-end (the blind
//      pipe the Noise handshake itself rides on). We can't run a real Noise IK handshake
//      solo — that needs the phone — so we loopback a nonce host→guest, which exercises
//      exactly the forwarding path the handshake uses.
//
// Transport-free: `fetch` and the WebSocket factory are injected, so the orchestration
// is unit-testable without a live relay (see relayProbe.test.ts).

/**
 * Map a user-entered relay URL (any of `http(s)://` / `ws(s)://`, with or without a
 * scheme or trailing slash) to its `https` `/health` probe endpoint. The relay serves
 * `/health` over plain HTTPS GET (the `wss://` form is only for the tunnel upgrade), so
 * the Test button normalizes to `https` before probing.
 */
export function relayHealthUrl(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, "");
  const normalized = trimmed
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  const withScheme = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
  return `${withScheme}/health`;
}

/** Normalize a relay URL to its `wss`/`ws` base (no path) for the `/connect` upgrade. */
export function relayWsBase(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, "");
  const normalized = trimmed
    .replace(/^https:\/\//i, "wss://")
    .replace(/^http:\/\//i, "ws://");
  return /^wss?:\/\//i.test(normalized) ? normalized : `wss://${normalized}`;
}

/** Build a `/connect?room=&role=` upgrade URL for a probe peer. */
export function relayConnectUrl(relayUrl: string, room: string, role: "host" | "guest"): string {
  return `${relayWsBase(relayUrl)}/connect?room=${encodeURIComponent(room)}&role=${role}`;
}

/**
 * A throwaway, well-formed room id (base64url, within the relay's 16–64 char window).
 * High-entropy so the probe never collides with a live pairing room; the room idle-times
 * out on its own and we close our sockets immediately, so it leaves nothing behind.
 */
export function freshRoomId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type LegStatus = "pending" | "running" | "ok" | "fail" | "skip";
export interface ProbeLeg {
  status: LegStatus;
  detail?: string;
}
export interface ProbeLegs {
  reach: ProbeLeg;
  join: ProbeLeg;
  relay: ProbeLeg;
}
export interface ProbeResult {
  legs: ProbeLegs;
  /** Relay version reported by `/health`, when reachable. */
  version?: string;
}

/** The legs at the moment the probe starts: reachability running, the rest queued. */
export function emptyLegs(): ProbeLegs {
  return { reach: { status: "running" }, join: { status: "pending" }, relay: { status: "pending" } };
}

/** The minimal WebSocket surface the probe uses — the browser `WebSocket` satisfies it. */
export interface MinimalSocket {
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface ProbeDeps {
  fetchFn: typeof fetch;
  makeSocket: (url: string) => MinimalSocket;
  /** Per-leg deadline. */
  timeoutMs: number;
  /** Override for tests; defaults to {@link freshRoomId}. */
  genId?: () => string;
  /** Fired after every leg-status change so the UI can update progressively. */
  onLeg?: (legs: ProbeLegs) => void;
}

const SERVICE_ID = "msc-tunnel-relay";

/**
 * Run the three-leg relay probe against `target`. Resolves once a leg fails (skipping the
 * rest) or all three pass; never rejects — every failure is reported as a leg detail.
 */
export async function runRelayProbe(target: string, deps: ProbeDeps): Promise<ProbeResult> {
  const genId = deps.genId ?? freshRoomId;
  const legs = emptyLegs();
  const emit = () => deps.onLeg?.({ reach: { ...legs.reach }, join: { ...legs.join }, relay: { ...legs.relay } });

  // Leg 1 — reachability + identity via /health.
  let version: string | undefined;
  const reachOk = await (async (): Promise<boolean> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deps.timeoutMs);
    try {
      const res = await deps.fetchFn(relayHealthUrl(target), { signal: ctrl.signal });
      if (!res.ok) {
        legs.reach = { status: "fail", detail: `relay returned HTTP ${res.status}` };
        return false;
      }
      const body = (await res.json().catch(() => null)) as { service?: string; version?: string } | null;
      if (body?.service !== SERVICE_ID) {
        legs.reach = { status: "fail", detail: "reachable, but not a tunnel relay" };
        return false;
      }
      version = body.version;
      legs.reach = { status: "ok", detail: version ? `v${version}` : undefined };
      return true;
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      legs.reach = { status: "fail", detail: aborted ? "timed out" : "could not reach relay" };
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  emit();
  if (!reachOk) {
    legs.join = { status: "skip" };
    legs.relay = { status: "skip" };
    emit();
    return { legs, version };
  }

  // Legs 2 & 3 — open a host socket (join), then a guest socket in the same room and
  // loopback a nonce through the relay (relay). Both sockets are closed when we settle.
  legs.join = { status: "running" };
  emit();
  await new Promise<void>((resolve) => {
    const room = genId();
    const nonce = genId();
    const host = deps.makeSocket(relayConnectUrl(target, room, "host"));
    let guest: MinimalSocket | null = null;
    let done = false;

    const timer = setTimeout(() => {
      if (legs.join.status === "running") {
        legs.join = { status: "fail", detail: "room join timed out" };
        legs.relay = { status: "skip" };
      } else if (legs.relay.status === "running") {
        legs.relay = { status: "fail", detail: "no relayed frame (timed out)" };
      }
      settle();
    }, deps.timeoutMs);

    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { host.close(1000); } catch { /* already closing */ }
      try { guest?.close(1000); } catch { /* already closing */ }
      emit();
      resolve();
    };

    host.onerror = () => {
      if (legs.join.status === "running") {
        legs.join = { status: "fail", detail: "room join failed" };
        legs.relay = { status: "skip" };
      }
      settle();
    };
    host.onopen = () => {
      legs.join = { status: "ok" };
      legs.relay = { status: "running" };
      emit();
      guest = deps.makeSocket(relayConnectUrl(target, room, "guest"));
      guest.onerror = () => {
        legs.relay = { status: "fail", detail: "second peer couldn't join the room" };
        settle();
      };
      guest.onmessage = (ev) => {
        if (typeof ev.data === "string" && ev.data === nonce) {
          legs.relay = { status: "ok" };
          settle();
        }
      };
      guest.onopen = () => {
        try {
          host.send(nonce);
        } catch {
          legs.relay = { status: "fail", detail: "could not send a probe frame" };
          settle();
        }
      };
    };
  });

  return { legs, version };
}
