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
| `auth`            | `token`, `fcmToken?`                     | First frame inside the Noise session. `fcmToken` is the device's FCM registration token, persisted as the push target for `user_request` notifications (see [FCM push](#fcm-push-user_request), #846). |
| `set_fcm_token`   | `fcmToken`                               | Refreshed FCM registration token (tokens rotate). Updates the stored push target mid-session; allowed even while view-only. |
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
| `pane_size`      | `paneId`, `cols`, `rows`                                      | The PTY grid size `pane_output` is rendered for. The client must size its terminal to these `cols`/`rows` so the stream's baked line-wrapping + cursor positioning line up. Replayed on connect + sent whenever the desktop PTY resizes. |
| `session_state`  | `paneId`, `status`, `currentTask`, `lastActivity`, `prompt`   | Per-pane agent state. `prompt` set when `status == "awaiting_input"`. |
| `user_request`   | `paneId`, `prompt`                                           | A pane newly needs input. |

`status` ∈ `running | idle | awaiting_input | error` (`PaneStatus`).

## Connection lifecycle

1. Desktop dials the relay, registers a `room` (as host), and shows the QR.
2. Mobile scans the QR, dials the same relay/room (as guest).
3. The two peers complete the **Noise IK** handshake through the relay (the relay only
   forwards ciphertext). The desktop authenticates the `auth` frame inside the session.
4. Desktop sends `pane_list`, a `session_state` per known pane, then a `pane_size` per known pane.
5. Mobile focuses a pane (`pane_focus` / `pane_set_state: streaming`); desktop streams
   that pane's `pane_output`. Output for non-focused panes is not sent.
6. Mobile sends `pane_input` / `pane_resize`; desktop routes them to the PTY.
7. Either side reconnects to the relay with backoff on a transient drop; a fresh Noise
   handshake re-establishes the session.

## FCM push (`user_request`)

The relay session only reaches a phone whose app is **foregrounded** — when MSC is
backgrounded or quit, it drops its relay connection, so a `user_request` sent over the
tunnel never arrives. To reach the phone anyway, the desktop also pushes the
`user_request` out-of-band via **Firebase Cloud Messaging** (#846, `src-tauri/src/fcm.rs`).

- **Trigger.** Exactly one push per `awaiting_input` transition per pane — fired from
  `tunnel_set_sessions` alongside the relay `user_request` broadcast, debounced by the same
  `!was_awaiting` guard (repeated state syncs while a pane stays awaiting don't re-push).
- **Target.** The device's FCM registration token, captured from the `auth` handshake
  (`fcmToken`) and updated by `set_fcm_token` refreshes. Stored in-memory per desktop
  session; dropped automatically when FCM reports it `UNREGISTERED` / `INVALID_ARGUMENT`.
- **Message (FCM HTTP v1, combined notification + data).** iOS shows the banner itself
  when MSC is backgrounded/quit (no on-device background handler), and the `data` block
  rides along for tap-routing. Fixed contract the mobile app parses:
  - `notification = { title: <pane/session name>, body: <prompt summary> }`
  - `data = { type: "user_request", paneId, prompt }` — **all values are strings**
  - `apns.headers["apns-priority"] = "10"`, `apns.payload.aps = { sound: "default", "mutable-content": 1 }`
    (deliberately **no** `content-available` — this is a visible alert, not a silent push).

### Configuration

| Setting | Value |
|---|---|
| Firebase project | The `project_id` inside the service-account key — use a key from the **same** Firebase project as the app's `GoogleService-Info.plist`. |
| Service-account key | A Firebase service-account JSON key. Path = env **`BSC_FCM_SERVICE_ACCOUNT`**, else `~/.base-studio-code/fcm-service-account.json`. |
| Auth | RS256-signed JWT assertion → OAuth2 access token (scope `https://www.googleapis.com/auth/firebase.messaging`), cached until ~60s before expiry. |

If no key is present, FCM push is silently disabled — the tunnel still broadcasts
`user_request` to any foregrounded client. The key is a secret: keep it out of the repo
(generate it in the Firebase console → Project settings → Service accounts → *Generate new
private key*, and place it at the path above).

## Desktop bridge

Pane *metadata* (names, cwds, statuses) lives in the frontend Zustand store; the pure
transform that maps it into `pane_list` / `session_state` shapes is
[`buildPanePayload`](../src/lib/tunnel.ts). PTY bytes are teed from the existing emitter
thread in `src-tauri/src/lib.rs` into the tunnel's in-process bus (a no-op while nobody
is connected) and drained by the relay transport (#242). Inbound input/resize is routed
back into the PTY.

## Relay test / health probe (`tunnel_check_relay`)

The Settings card can probe any relay URL for liveness via the `tunnelCheckRelay` Tauri
command (T3b, `src-tauri/src/tunnel.rs`). The command GETs `<relayUrl>/health` with a 5 s
timeout and returns a `RelayDiag`:

| Field | Meaning |
|---|---|
| `reachable` | `true` when the relay responded with HTTP 200. |
| `service`, `version` | Fields from the relay's `/health` JSON body. |
| `latencyMs` | Round-trip time for the probe. |
| `error` | Error message when the probe failed (`null` on success). |
| `hostConnected` | Whether the desktop's own relay WebSocket (host leg) is open. |
| `clientCount` | Number of paired mobile clients (guest legs) right now. |

## Relay idle / TTL recovery (T5)

The relay's Durable Object closes rooms after `IDLE_TIMEOUT_MS` (5 min) of no traffic and
after `ROOM_TTL_MS` (1 h) regardless of activity (`relay/src/room.ts`). When the desktop
receives a close frame with reason `"room idle timeout"` or `"room lifetime exceeded"` it:

1. Emits `tunnel://room-expired` to the frontend (for UI prompt to re-scan).
2. Returns a clean exit from the session, resetting the reconnect backoff.
3. Re-dials the relay on the **same** room id — the DO resets after TTL so the same id
   creates a fresh session; the existing QR is still valid for re-pairing.

## Status

- **#240** landed the transport-agnostic contract: the wire types, the pure store→wire
  transforms, the shared fixture, and this doc.
- **#241** landed the relay Worker (`relay/`): the Cloudflare Worker + Durable Object
  blind pipe.
- **#242** landed the desktop side: the protocol serde + Noise IK crypto (#242a) and the
  relay dial-out client transport — `tunnel_start`/`tunnel_stop`, the responder
  handshake, auth, replay, and the bus pump (#242b). The desktop connects to a relay and
  serves a paired mobile client end-to-end.
- **#243** landed the pairing QR generation and Settings relay section; `tunnelClient.ts`
  exposes all Tauri commands. The **mobile** client (relay initiator + Noise + scan-to-pair)
  lives in `mobile-studio-code`. See #197 for the full architecture.
- **T3b** added the `tunnel_check_relay` / `tunnelCheckRelay` diagnostic command: relay
  reachability + per-leg (host/guest) connection state in a single call.
- **T5** added relay idle/TTL close detection: `tunnel://room-expired` event and clean-exit
  reconnect so the backoff resets after a normal room expiry.
- **T6** added FCM out-of-band push for `user_request` transitions so a backgrounded phone
  receives the notification even when off the relay (`src-tauri/src/fcm.rs`).
- **T2b** wired all Rust commands into `tunnelClient.ts`, including the previously missing
  `tunnelAckPlanPush`.
