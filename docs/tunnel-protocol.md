# Mobile tunnel — wire protocol (#240 / #46 / #197)

The tunnel lets **mobile-studio-code** connect to the desktop and mirror its terminal
panes (view + input) **from anywhere**, over a **zero-knowledge Cloudflare relay**.
This document is the shared reference for the wire schema; the machine-readable fixture
is [`src/lib/tunnelProtocol.fixtures.json`](../src/lib/tunnelProtocol.fixtures.json).

## Source of truth

The application schema is owned by the **mobile** client —
`mobile-studio-code/src/lib/types.ts` (`TunnelClientMessage` / `TunnelServerMessage`).
That client already ships, so the desktop (`src-tauri/src/tunnel.rs`) and frontend
(`src/lib/tunnel.ts`) **conform to it**. The TS tests (`src/__tests__/tunnel.test.ts`)
and (once it lands) the Rust transport assert against the shared fixture, so a drift
fails CI on the base side; a breaking change requires **coordinated PRs in both repos**.

> Note on #46: the issue originally proposed a versioned envelope
> `{ v, type, payload }`. The shipped mobile client uses the flat, type-tagged messages
> documented below, so we conform to it rather than introduce a schema it can't parse.
> A versioned envelope, if still wanted, is a future coordinated v2.

## Transport — relay-only

There is **no LAN/direct mode**. Exposing a WebSocket listener on the local network is
a footgun (a remote shell on a public interface), and a self-signed `wss://` failed to
hand-shake from iOS. Both peers instead **dial out** to a relay they trust:

```
   mobile ──wss (real TLS)──▶  CF Worker + Durable Object (room)  ◀──wss (real TLS)── desktop
      └──────────────────── Noise IK session (inside) ──────────────────────┘
                 relay forwards only opaque { room, ciphertext } frames
```

- **Relay = Cloudflare Worker + Durable Object** (one DO per `room` id; #241). It is a
  blind pipe: it copies `{ room, ciphertext }` frames between the two peers and can
  never read or inject terminal data. Hosting it on a third party therefore adds **no
  confidentiality trust** — it's deployed into the *user's own* Cloudflare account
  (BYO), so we don't run shared infrastructure either.
- **End-to-end encryption = Noise IK** between desktop and mobile (#242). The desktop
  holds a static keypair; the mobile learns the desktop's public key from the QR
  (out-of-band), giving mutual auth + forward secrecy + MITM resistance against a
  malicious relay. The application frames below are carried **inside** the Noise
  session — the relay sees only ciphertext.
- TLS to the relay is real (CA-signed `*.workers.dev`), so there is **no cert pinning**;
  trust is established by Noise, not by the transport.

### Pairing payload (QR contents / manual entry)

JSON, generated **only after** the desktop has connected to the relay and a room is
allocated (never show a QR for a relay we can't reach):

```json
{ "relayUrl": "wss://relay.<user>.workers.dev", "room": "<high-entropy-id>",
  "hostPubKey": "<base64 Noise static public key>", "psk": "<base64 pre-shared key>" }
```

## Framing (application layer, inside Noise)

Every message is a single JSON object on a text frame, tagged by a snake_case `type`.
Multi-word field names are **camelCase** (`paneId`, `currentTask`, `lastActivity`,
`fcmToken`).

### Client → server (`TunnelClientMessage`)

| `type`            | Fields                                  | Meaning |
|-------------------|-----------------------------------------|---------|
| `auth`            | `token`, `fcmToken?`                     | First frame inside the Noise session. `fcmToken` reserved for future push wake-ups. |
| `pane_set_state`  | `paneId`, `state` (`streaming`/`minimized`/`dormant`) | Mark a pane focused (`streaming`) or background. |
| `pane_focus`      | `paneId`                                 | Focus a pane (begin streaming its output). |
| `pane_input`      | `paneId`, `data`                         | Keystrokes → the pane's PTY. |
| `pane_resize`     | `paneId`, `cols`, `rows`                 | Resize the pane's PTY. |

### Server → client (`TunnelServerMessage`)

| `type`           | Fields                                                       | Meaning |
|------------------|--------------------------------------------------------------|---------|
| `auth_ok`        | —                                                            | Token accepted. Sent before any other frame. |
| `pane_list`      | `panes: [{ id, cwd, name, status }]`                          | Current panes. Replayed on connect + on change. |
| `pane_output`    | `paneId`, `data`, `coarse`                                    | PTY output for the client's focused pane. |
| `session_state`  | `paneId`, `status`, `currentTask`, `lastActivity`, `prompt`   | Per-pane agent state. `prompt` set when `status == "awaiting_input"`. |
| `user_request`   | `paneId`, `prompt`                                           | A pane newly needs input. |

`status` ∈ `running | idle | awaiting_input | error` (`PaneStatus`).

## Connection lifecycle

1. Desktop dials the relay, registers a `room` (as host), and shows the QR.
2. Mobile scans the QR, dials the same relay/room (as guest).
3. The two peers complete the **Noise IK** handshake through the relay (the relay only
   forwards ciphertext). The desktop authenticates the `auth` frame inside the session.
4. Desktop sends `pane_list`, then a `session_state` per known pane.
5. Mobile focuses a pane (`pane_focus` / `pane_set_state: streaming`); desktop streams
   that pane's `pane_output`. Output for non-focused panes is not sent.
6. Mobile sends `pane_input` / `pane_resize`; desktop routes them to the PTY.
7. Either side reconnects to the relay with backoff on a transient drop; a fresh Noise
   handshake re-establishes the session.

## Desktop bridge

Pane *metadata* (names, cwds, statuses) lives in the frontend Zustand store; the pure
transform that maps it into `pane_list` / `session_state` shapes is
[`buildPanePayload`](../src/lib/tunnel.ts). PTY bytes are teed from the existing emitter
thread in `src-tauri/src/lib.rs` into the tunnel's in-process bus (a no-op while nobody
is connected) and drained by the relay transport (#242). Inbound input/resize is routed
back into the PTY.

## Status

- **#240** landed the transport-agnostic contract: the wire types, the pure store→wire
  transforms, the shared fixture, and this doc.
- **#241** landed the relay Worker (`relay/`): the Cloudflare Worker + Durable Object
  blind pipe.
- **#242** landed the desktop side: the protocol serde + Noise IK crypto (#242a) and the
  relay dial-out client transport — `tunnel_start`/`tunnel_stop`, the responder
  handshake, auth, replay, and the bus pump (#242b). The desktop now connects to a relay
  and serves a paired mobile client end-to-end.
- **#243** (next) generates the pairing QR after the relay connects and adds the Settings
  relay section. The **mobile** client (relay initiator + Noise + scan-to-pair) lives in
  `mobile-studio-code`. See #197 for the full architecture.
