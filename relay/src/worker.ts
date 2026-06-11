// msc-tunnel-relay — Cloudflare Worker entry (#241).
//
// A zero-knowledge relay for the mobile tunnel: it forwards opaque Noise-encrypted
// frames between a desktop and its phone, both of which dial OUT to it (solving NAT
// traversal with no port-forwarding). It can never read terminal data, so it's safe to
// deploy into the user's OWN Cloudflare account (BYO). See ../docs/tunnel-protocol.md.

import { parseConnect } from "./protocol";
import { RelayRoom, type Env } from "./room";
import { checkRateLimit, DEFAULT_RATE_LIMIT } from "./rateLimit";

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

      // Per-IP rate limit — only active when RATE_LIMIT_KV is bound (opt-in for
      // multi-tenant / public relays). The default zero-binding BYO deploy is always
      // open; checkRateLimit no-ops immediately when the binding is absent.
      const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
      const rl = await checkRateLimit(env.RATE_LIMIT_KV, ip);
      if (!rl.allowed) {
        const retryAfter = Math.max(0, rl.resetAt - Math.floor(Date.now() / 1000));
        return new Response("rate limit exceeded", {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(DEFAULT_RATE_LIMIT.maxConnections),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(rl.resetAt),
          },
        });
      }

      // Both peers with the same room id resolve to the SAME Durable Object.
      const parsed = parseConnect(url);
      if (!parsed.ok) {
        return new Response(parsed.error, { status: 400 });
      }
      const stub = env.ROOMS.get(env.ROOMS.idFromName(parsed.target.room));
      return stub.fetch(req);
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
