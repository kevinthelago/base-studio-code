// RelayRoom — one Durable Object per `room` id; the coordination point both peers
// land on (via `idFromName`). It pipes opaque frames between a single host and up to
// MAX_GUESTS guests and uses the **WebSocket Hibernation API** so an idle room evicts
// from memory and costs ~nothing. It never inspects payloads (Noise ciphertext).

import { DurableObject } from "cloudflare:workers";
import { IDLE_TIMEOUT_MS, roleFor, tooLarge, type Role } from "./protocol";

export interface Env {
  ROOMS: DurableObjectNamespace<RelayRoom>;
}

/** Per-socket metadata stored via the hibernatable attachment (survives eviction). */
interface SocketMeta {
  role: Role;
  joinedAt: number;
}

export class RelayRoom extends DurableObject<Env> {
  /** Accept a peer's WebSocket upgrade, assigning host/guest by current occupancy. */
  override async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    const requested = new URL(req.url).searchParams.get("role") ?? "guest";
    const decision = roleFor(
      {
        hostCount: this.ctx.getWebSockets("host").length,
        guestCount: this.ctx.getWebSockets("guest").length,
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

    // (Re)arm the idle timeout — closes the room after IDLE_TIMEOUT_MS of silence.
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Forward each frame to every other peer in the room — the blind pipe. */
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const size = typeof message === "string" ? message.length : message.byteLength;
    if (tooLarge(size)) {
      ws.close(1009, "frame too large");
      return;
    }
    for (const peer of this.ctx.getWebSockets()) {
      if (peer === ws) continue;
      try {
        peer.send(message);
      } catch {
        // A peer mid-teardown; its close handler will clean it up.
      }
    }
    // Activity resets the idle timer.
    await this.ctx.storage.setAlarm(Date.now() + IDLE_TIMEOUT_MS);
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

  /** Idle timeout fired: tear the room down. */
  override async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, "room idle timeout");
      } catch {
        // Already gone.
      }
    }
  }
}
