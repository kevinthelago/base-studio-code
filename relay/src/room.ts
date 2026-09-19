// RelayRoom — one Durable Object per `room` id; the coordination point both peers
// land on (via `idFromName`). It pipes opaque frames between a single host and up to
// MAX_GUESTS guests and uses the **WebSocket Hibernation API** so an idle room evicts
// from memory and costs ~nothing. It never inspects payloads (Noise ciphertext).

import { DurableObject } from "cloudflare:workers";
import {
  EVICTED_CLOSE_CODE, EVICTED_REASON, HEARTBEAT_PING, HEARTBEAT_PONG,
  guestsToEvict, lastSeenOf, nextAlarmAt, roleFor, roomLifetimeExceeded, tooLarge, type Role,
} from "./protocol";

export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>;
  /** Optional KV namespace for per-IP rate-limiting. Absent in the default BYO deploy. */
  RATE_LIMIT_KV?: KVNamespace;
}

/** Per-socket metadata stored via the hibernatable attachment (survives eviction). */
interface SocketMeta {
  role: Role;
  joinedAt: number;
  /** A guest's last frame (ms epoch). Tracked for guests only — they are who admission evicts. */
  lastFrameAt?: number;
}

/** Only sockets that can still carry traffic hold a slot — one already closing has given its up. */
const isOpen = (ws: WebSocket): boolean => ws.readyState === 1; // OPEN

export class RelayRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The heartbeat is answered by the RUNTIME, not by this object: it never wakes a hibernated room,
    // never reaches the other peer, and leaves a per-socket timestamp admission reads below.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HEARTBEAT_PING, HEARTBEAT_PONG));
  }

  /** When a guest last showed a sign of life: its join, its last frame, its last heartbeat. */
  private lastSeen(ws: WebSocket): number {
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
    return lastSeenOf(meta?.joinedAt ?? 0, meta?.lastFrameAt, pinged);
  }

  /** When this room first accepted a peer — the anchor for the absolute TTL. Cached in
   *  memory (the DO stays resident while sockets are live) and backed by storage so it
   *  survives hibernation; lazily (re)loaded by {@link ensureCreatedAt}. */
  private createdAt?: number;

  /** The room's birth time, persisted on first use so the absolute TTL is anchored even
   *  across hibernation. */
  private async ensureCreatedAt(): Promise<number> {
    if (this.createdAt !== undefined) return this.createdAt;
    let ts = await this.ctx.storage.get<number>("createdAt");
    if (ts === undefined) {
      ts = Date.now();
      await this.ctx.storage.put("createdAt", ts);
    }
    this.createdAt = ts;
    return ts;
  }

  /** Re-arm the teardown alarm at the earlier of the idle cutoff and the absolute TTL. */
  private async armAlarm(): Promise<void> {
    const createdAt = await this.ensureCreatedAt();
    await this.ctx.storage.setAlarm(nextAlarmAt(createdAt, Date.now()));
  }

  /** Accept a peer's WebSocket upgrade, assigning host/guest by current occupancy. */
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const requested = new URL(req.url).searchParams.get("role") ?? "guest";
    const guests = this.ctx.getWebSockets("guest").filter(isOpen);
    // A full room admits a new guest by pushing out the one silent longest — in practice a phone's own
    // socket that died in the background without closing (relay-evicts-the-silent-guest).
    const evict = requested === "guest" ? guestsToEvict(guests.map((ws) => ({ lastSeen: this.lastSeen(ws) }))) : [];
    for (const i of evict) {
      try {
        guests[i].close(EVICTED_CLOSE_CODE, EVICTED_REASON);
      } catch {
        // Already gone — the slot is free either way.
      }
    }
    const decision = roleFor(
      {
        hostCount: this.ctx.getWebSockets("host").filter(isOpen).length,
        guestCount: guests.length - evict.length,
      },
      requested,
    );
    if (!decision.ok) {
      return new Response(decision.error, { status: 409 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    // Tag with the role so getWebSockets("host"|"guest") can count/route, and stash
    // metadata that survives hibernation.
    this.ctx.acceptWebSocket(server, [decision.role]);
    const meta: SocketMeta = { role: decision.role, joinedAt: Date.now() };
    server.serializeAttachment(meta);

    // (Re)arm the teardown alarm (idle cutoff or absolute TTL, whichever is sooner).
    await this.armAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Forward each frame to every other peer in the room — the blind pipe. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (tooLarge(size)) {
      ws.close(1009, "frame too large");
      return;
    }
    const meta = ws.deserializeAttachment() as SocketMeta | null;
    if (meta?.role === "guest") ws.serializeAttachment({ ...meta, lastFrameAt: Date.now() } satisfies SocketMeta);
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(message);
      } catch {
        // A peer mid-teardown; its close handler will clean it up.
      }
    }
    // Activity resets the idle timer, but never past the absolute TTL.
    await this.armAlarm();
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // Acknowledge the close so the socket releases cleanly.
    try {
      ws.close(code, reason);
    } catch {
      // Already closing.
    }
  }

  override async webSocketError(_ws: WebSocket, _error: unknown): Promise<void> {
    // Hibernation surfaces socket errors here; nothing to do — the runtime drops it.
  }

  /** Teardown alarm fired — from either the idle cutoff or the absolute TTL. Close every
   *  peer and wipe the room's storage so a later reuse of this id starts a fresh lifetime. */
  override async alarm(): Promise<void> {
    const createdAt = (await this.ctx.storage.get<number>("createdAt")) ?? Date.now();
    const reason = roomLifetimeExceeded(createdAt, Date.now())
      ? "room lifetime exceeded"
      : "room idle timeout";
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, reason);
      } catch {
        // Already gone.
      }
    }
    this.createdAt = undefined;
    await this.ctx.storage.deleteAll();
  }
}
