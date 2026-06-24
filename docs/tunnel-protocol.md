# Mobile tunnel — wire protocol (#240 / #46 / #197)

The tunnel lets **mobile-studio-code** connect to the desktop and mirror its terminal
panes (view + input) **from anywhere**, over a **zero-knowledge Cloudflare relay**.
This document is the shared reference for the wire schema; the machine-readable fixture
is [`src/lib/tunnel/tunnelProtocol.fixtures.json`](../src/lib/tunnel/tunnelProtocol.fixtures.json).

## Source of truth

The application schema is owned by the **mobile** client —
`mobile-studio-code/src/lib/types.ts` (`TunnelClientMessage` / `TunnelServerMessage`).
That client already ships, so the desktop (`src-tauri/src/tunnel.rs`) and frontend
(`src/lib/tunnel/tunnel.ts`) **conform to it**. The TS tests (`src/lib/tunnel/tunnel.test.ts`)
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

| `type`                    | Fields                                  | Meaning |
|---------------------------|-----------------------------------------|---------|
| `auth`                    | `token`, `fcmToken?`                    | First frame inside the Noise session. `fcmToken` is the device's FCM registration token, persisted as the push target for notifications (see [FCM push](#fcm-push-out-of-band-notifications), #846). |
| `set_fcm_token`           | `fcmToken`                              | Refreshed FCM registration token (tokens rotate). Updates the stored push target mid-session; allowed even while view-only. |
| `pane_set_state`          | `paneId`, `state` (`streaming`/`minimized`/`dormant`) | Mark a pane focused (`streaming`) or background. |
| `pane_focus`              | `paneId`                                | Focus a pane (begin streaming its output). |
| `pane_input`              | `paneId`, `data`                        | Keystrokes → the pane's PTY. |
| `pane_resize`             | `paneId`, `cols`, `rows`                | Resize the pane's PTY. |
| `plan_sync_manifest_request` | `projectId`                          | Request the desktop's current plan manifest for a project. |
| `plan_sync_pull`          | `projectId`, `paths`                    | Request specific plan files from the desktop. |
| `plan_sync_push`          | `projectId`, `files`                    | Push mobile's merged plan state to the desktop. |
| `coord_wake`              | `session`                               | Ask the desktop to wake a dep-blocked waiter (F2). |
| `coord_approve`           | `session`                               | Approve a checkpoint/confirm-paused agent (F2). |
| `automation_arm`          | `id`, `armed`                           | Arm or disarm an automation on the desktop (A2). |
| `automation_run_now`      | `id`                                    | Trigger an automation to run immediately (A2). |
| `plan_advance`            | `projectId`, `stageKey`                 | Advance / jump the live planner to a stage. Honored only when the desktop has granted input (same gate as `pane_input`); dropped otherwise (PT1, #934). |
| `plan_confirm`            | `projectId`, `section`                  | Confirm a plan section in the live planner. Input-gated (PT1, #934). |
| `plan_chat`               | `projectId`, `text`                     | Send a chat turn into the live planner session. Input-gated (PT1, #934). |

### Server → client (`TunnelServerMessage`)

| `type`                | Fields                                                         | Meaning |
|-----------------------|----------------------------------------------------------------|---------|
| `auth_ok`             | —                                                              | Token accepted. Sent before any other frame. |
| `pane_list`           | `panes: [{ id, cwd, name, status }]`                           | Current panes. Replayed on connect + on change. |
| `pane_output`         | `paneId`, `data`, `coarse`                                     | PTY output for the client's focused pane. |
| `pane_size`           | `paneId`, `cols`, `rows`                                       | The PTY grid size `pane_output` is rendered for. Replayed on connect + sent whenever the desktop PTY resizes. |
| `session_state`       | `paneId`, `status`, `currentTask`, `lastActivity`, `prompt`    | Per-pane agent state. `prompt` set when `status == "awaiting_input"`. |
| `user_request`        | `paneId`, `prompt`                                             | A pane newly needs input. |
| `plan_sync_manifest`  | `projectId`, `files: Record<relpath, hash>`                    | Plan manifest (relpath → FNV-1a hash). Replayed on connect + on change (#588). |
| `plan_sync_files`     | `projectId`, `files: [{ relpath, content }]`                   | Plan file contents in response to `plan_sync_pull`. |
| `plan_sync_ack`       | `projectId`, `applied`                                         | Desktop ack after applying a `plan_sync_push`. |
| `fleet_roster`        | `sessions: FleetSession[]`                                     | Full fleet snapshot. Replayed on connect + on every fleet state change (F2). |
| `coord_event`         | `kind`, `session?`, `refKey?`, `at`                            | Single coordination event (blocked / satisfied / woken / waiting / asking / failed). kind ∈ those values (F2). |
| `automation_list`     | `automations: AutomationFrame[]`                               | Full automation list. Replayed on connect + on every change (A2). |
| `automation_ran`      | `id`, `at`, `status`, `note`                                   | Informational: automation fired. status ∈ "ok"/"skipped"/"fail" (A2). |
| `automation_failed`   | `id`, `at`, `error`                                            | Non-transient automation failure; also triggers an FCM push (A4). |
| `mcp_list`            | `extensions: McpExtFrame[]`                                    | Full MCP server / hook list (read-only on mobile). Replayed on connect + on every change (M2). |
| `plan_state`          | `projectId`, `currentStage`, `confirmedSections: string[]`, `files: PlanFile[]`, `messages: PlanMessage[]`, `pipelineRuns: PlanPipelineRun[]` | Full snapshot of the **live planning session** (distinct from the async `plan_sync_*` file path). Replayed on connect (last per-`projectId` payload) and replaces prior state wholesale (PT1, #934). |
| `plan_event`          | `projectId`, `kind`, `at`, `section?`, `stage?`, `message?`, `run?`            | Transient planner delta — **fire-and-forget, not replayed**. `kind` ∈ `section_confirmed` / `stage_advanced` / `message_appended` / `pipeline_run`; the detail field is set per `kind` (PT1, #934). |
| `plan_status`         | `projectId`, `currentStage`, `status`                          | Cheap planner header update (active stage + status label). Replayed on connect (PT1, #934). |

`status` ∈ `running | idle | awaiting_input | error` (`PaneStatus`).

#### `FleetSession` shape (F2)

```json
{ "session": "t0p1", "status": "blocked", "blockedOn": ["#42"], "waitReason": null, "question": null, "at": 1750000000000 }
```

`status` ∈ `running | blocked | waiting | asking | idle`. `blockedOn` is omitted when empty. `waitReason` is set when `status == "waiting"`; `question` when `status == "asking"`.

#### `AutomationFrame` shape (A2)

```json
{ "id": "sched-1", "name": "Nightly build", "armed": true, "whenExpr": "0 2 * * *", "lastRunAt": 1750000000000, "nextRunAt": 1750086400000, "lastStatus": "ok" }
```

#### `McpExtFrame` shape (M2)

```json
{ "id": "m1", "kind": "mcp", "name": "Postgres", "enabled": true, "transport": "stdio", "url": null }
```

`kind` ∈ `"mcp" | "hook"`. `transport` ∈ `"stdio" | "http"` (null for hooks).

#### `plan_state` shapes (PT1, #934)

The live planning session — what the planner is doing *right now* — as opposed to the async file
reconciliation carried by `plan_sync_*` (which is unchanged). The desktop is the single source of
truth; the phone mirrors `plan_state` / `plan_status` (read-only) and steers via the input-gated
`plan_advance` / `plan_confirm` / `plan_chat` drive frames. `messages` is the planner conversation
(user/assistant **text** turns only — tool blocks are dropped desktop-side, read from the Claude
transcript). `pipelineRuns` is currently always `[]` (the planner runs no pipelines) but is part of
the contract — render an empty list gracefully.

```json
{ "relpath": "goal.md", "content": "# Goal\n…" }                         // PlanFile
{ "role": "assistant", "text": "Here's the goal.", "at": 1750000000000 } // PlanMessage (role ∈ "user" | "assistant")
{ "id": "build", "stage": "test", "status": "running" }                  // PlanPipelineRun
```

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

## FCM push (out-of-band notifications)

The relay session only reaches a phone whose app is **foregrounded** — when MSC is
backgrounded or quit, it drops its relay connection. To reach the phone anyway, the desktop
pushes out-of-band via **Firebase Cloud Messaging** (#846, `src-tauri/src/fcm.rs`).

Three FCM message types are currently sent:

| `data.type`     | Trigger                                        | Issue |
|-----------------|------------------------------------------------|-------|
| `user_request`  | Pane enters `awaiting_input` (new prompt)      | T6    |
| `coord_wait`    | Agent enters `waiting` or `asking` state       | F4    |
| `autom_failed`  | Non-transient automation failure               | A4    |

**Common properties:**
- **Target.** The device's FCM registration token, captured from the `auth` handshake
  (`fcmToken`) and updated by `set_fcm_token` refreshes. Stored in-memory per desktop
  session; dropped automatically when FCM reports it `UNREGISTERED` / `INVALID_ARGUMENT`.
- **Message format (FCM HTTP v1, combined notification + data).** iOS shows the banner
  itself when MSC is backgrounded/quit; the `data` block rides along for tap-routing. All
  `data` values are strings (FCM requirement).
  - `apns.headers["apns-priority"] = "10"`, `apns.payload.aps = { sound: "default", "mutable-content": 1 }`
    (deliberately **no** `content-available` — these are visible alerts, not silent pushes).

**`user_request` debouncing:** exactly one push per `awaiting_input` transition per pane —
fired from `tunnel_set_sessions`, debounced by the `!was_awaiting` guard (repeated syncs
while a pane stays awaiting don't re-push).

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
[`buildPanePayload`](../src/lib/tunnel/tunnel.ts). PTY bytes are teed from the existing emitter
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
- **T1b / #928** asserts the desktop's snow responder against a **frozen shared Noise IK
  vector**, `src-tauri/tests/noise_vectors.json` (empty prologue, fixed static + ephemeral
  keys, byte-exact ciphertext for the IK handshake + a transport message each way). The
  test is **active** — `noise_ik_matches_shared_test_vector` fails CI on any byte
  divergence. This flips the original T1a dependency: snow (reference-grade) produces the
  canonical vector and base vendors it; mobile-studio-code pins the same file and asserts
  the noble side against it, so any snow ↔ noble mismatch fails a test on at least one side.
- **T8** refreshed this doc to cover all landed protocol additions (F2/A2/M2/PT2).
- **PT1** (#934/#985/#986/#987) added the **live planning session** surface, distinct from the
  `plan_sync_*` file path: `PlanState` + `PlanEvent` + `PlanStatus` ServerMsg and the input-gated
  `PlanAdvance` + `PlanConfirm` + `PlanChat` ClientMsg (`src-tauri/src/tunnel.rs`); `plan_state` /
  `plan_status` are replayed on connect, `plan_event` is fire-and-forget. `messages` come from
  `tokens::read_pane_messages` (the Claude transcript). The TS frame types + fixtures moved under
  `src/lib/tunnel/`. Mobile counterpart: #1245.
- **PT2** wired plan_sync message flow: `tunnel_set_plan_state`, `tunnel_ack_plan_push`,
  `tunnelSetPlanState`, `tunnelAckPlanPush` TS bindings; `PlanSyncManifest`, `PlanSyncFiles`,
  `PlanSyncAck` ServerMsg; `PlanSyncManifestRequest`, `PlanSyncPull`, `PlanSyncPush`
  ClientMsg; manifest replay on connect.
- **F2** added fleet/coordination wire frames: `FleetRoster` + `CoordEvent` ServerMsg;
  `CoordWake` + `CoordApprove` ClientMsg; `tunnel_set_fleet_state` / `tunnel_emit_coord_event`
  Tauri commands; `fleetLive.ts` pure CoordState → FleetSession[] projection; replay on connect.
- **F4** added FCM `coord_wait` push when `tunnel_emit_coord_event` kind is "waiting" or
  "asking", so a backgrounded phone is notified when an agent needs attention.
- **A2** added automation wire frames: `AutomationList` + `AutomationRan` + `AutomationFailed`
  ServerMsg; `AutomationArm` + `AutomationRunNow` ClientMsg; `tunnel_set_automations`,
  `tunnel_automation_ran`, `tunnel_automation_failed` Tauri commands; replay on connect.
- **A4** added FCM `autom_failed` push when `tunnel_automation_failed` is called.
- **M2** added MCP extension wire frame: `McpList` ServerMsg; `tunnel_set_mcp_state` Tauri
  command; read-only on mobile; replay on connect.
