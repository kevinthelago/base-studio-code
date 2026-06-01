// msc-tunnel-relay — Cloudflare Worker entry (#241).
//
// A zero-knowledge relay for the mobile tunnel: it forwards opaque Noise-encrypted
// frames between a desktop and its phone, both of which dial OUT to it (solving NAT
// traversal with no port-forwarding). It can never read terminal data, so it's safe to
// deploy into the user's OWN Cloudflare account (BYO). See ../docs/tunnel-protocol.md.

import { parseConnect } from "./protocol";
import { RelayRoom, type Env } from "./room";

export { RelayRoom };

const VERSION = "0.1.0";

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // Liveness probe — never touches a room (cheap, content-free).
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "msc-tunnel-relay", version: VERSION });
    }

    // The pairing endpoint: a peer upgrades to a WebSocket on its room.
    if (url.pathname === "/connect") {
      if (req.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const parsed = parseConnect(url);
      if (!parsed.ok) {
        return new Response(parsed.error, { status: 400 });
      }
      // Both peers with the same room id resolve to the SAME Durable Object.
      const stub = env.ROOMS.get(env.ROOMS.idFromName(parsed.target.room));
      return stub.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
