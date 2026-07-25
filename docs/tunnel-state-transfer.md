# Desktop mobile-tunnel & state transfer

How the desktop projects its live state to the paired **mobile-studio-code** phone. The desktop is
authoritative; mobile is an optional, standalone client that tunnels in over a **zero-knowledge
Cloudflare relay** (Noise IK end-to-end — the relay only ever sees ciphertext), paired by QR.

## Architecture — two layers

### 1. `crates/bsc-tunnel/` — the wire contract + crypto (Tauri-free, shared with mobile-studio-code)

- **`protocol.rs`** — the serde wire types. This is the **cross-repo contract** (mirrors mobile's
  `src/lib/types.ts`), pinned byte-exact by `tunnelProtocol.fixtures.json`. `PROTOCOL_VERSION = 2`.
  - `ServerMsg` (desktop → mobile): `AuthOk`, `InputGrantChanged`, `PaneList`, **`StoreState`**,
    `PaneOutput`, `PaneSize`, `SessionState`, `UserRequest`, `PlanSyncManifest`/`Files`/`Ack`,
    `FleetRoster`, `CoordEvent`, `AutomationList`/`Ran`, `McpList`, `HookTelemetry`. (`FleetRoster` ·
    `McpList` · `AutomationRan` are now **constructor-less** — kept for mobile back-compat, senders
    removed #3749.)
  - `ClientMsg` (mobile → desktop): `Auth`, `SetFcmToken`, `PaneSetState`, `PaneFocus`, `PaneInput`,
    `PaneResize`, `PlanSyncManifestRequest`, `PlanSyncPull`.
- **`noise.rs`** — the `Noise_IK_25519_ChaChaPoly_BLAKE2s` responder handshake.

### 2. `src-tauri/src/mobile/tunnel/` — the desktop glue (depends on the crate)

- **`state.rs`** — `TunnelState`, the in-process bus. `set_and_broadcast(frame, |inner| …)` broadcasts to
  connected clients **and** stores the frame for **replay** to a freshly-paired phone.
- **`transport.rs`** — dials the relay over WebSocket, runs the Noise responder handshake, pumps the bus
  (PTY output + events) out, and routes inbound `ClientMsg` back. On connect it replays the last frame
  per store domain (+ the pane/session snapshots). Protocol-version mismatch is **logged, never rejected**.
- **`commands.rs`** — the `#[tauri::command]` surface the frontend calls: `tunnel_start`/`stop`/`status`/
  `unpair`, `tunnel_set_input_granted`, the per-domain **`tunnel_set_store_state`**, `tunnel_emit_alert`,
  the pane/session pushes, plan-sync, and the few live bespoke pushes (`tunnel_set_automations`,
  `tunnel_set_hook_telemetry`, `tunnel_emit_coord_event`). The dead fleet/mcp/automation-ran setters were
  removed in #3749.
- **`../fcm.rs`** — out-of-band FCM push for alerts to a **backgrounded/quit** phone (a foregrounded phone
  reads the inbox off the `alerts` store_state domain, replayed on connect).

## State transfer — the `store_state` pipeline (#2497 / #2498)

The generic, domain-agnostic path — the successor to the bespoke per-store frames:

```
useStoreProjector  (mounted once in App.tsx)
  → build<Domain>Payload   (src/features/tunnel/lib/storeProjections.ts — PURE builders)
  → publishTunnelDomain
  → domainPublisher        (dedups unchanged payloads · debounces · stamps monotonic per-domain rev)
  → tunnel_set_store_state (Rust; DOMAIN-AGNOSTIC: ServerMsg::StoreState { domain, rev, json })
  → set_and_broadcast → relay → mobile   (replayed last-frame-per-domain on connect)
```

- **Domains** (`bsc_tunnel::protocol::store_domains::ALL`, 11): `glance · plan · org · blueprints · skills ·
  components · themes · automations · mcp · alerts · security`. The frame is opaque JSON, so **adding a
  domain (or a field) is DATA, not a protocol change.**
- Each domain has a **pure builder** in `storeProjections.ts` with a colocated unit test. The projector
  (`useStoreProjector.ts`) feeds it live store slices; `plan` is pushed separately from the live planner
  (`usePlannerTunnelSync.ts`, since the stage/gate board only exists there); `alerts` rides the alert hub.
- Sources **self-load** while `tunnelRunning` (e.g. `useGlanceProjects(tunnelRunning)` fetches even when
  the desktop page is closed), so a domain pushes in the background.
- **Frame-size ceiling (#3756).** A single Noise transport message caps at **65535 bytes**. `send_msg`
  now **skips** (with a warning) any frame whose serialized JSON exceeds `MAX_NOISE_PLAINTEXT` (65519)
  instead of letting `snow` return `Error::Input` — which used to propagate out of `replay_state` and
  **tear down the whole session mid-replay**, blanking *every* domain, not just the big one (the "no data
  on mobile" bug: the `components` domain at ~63 KB died on the connect replay before `glance` was ever
  sent). Consequence: an over-cap domain is **not mirrored** until it's fragmented (open follow-up
  **#3757**); every fitting domain still gets through. **Keep projections small** — pare to summaries, cap
  lists (`SECURITY_AUDIT_CAP`, `AUTOMATION_RUNS_CAP`), drop bodies/secrets.

### Pane mirroring (separate from store_state)

PTY output → `ServerMsg::PaneOutput`; `PaneList` is the grid; `PaneSize` syncs cols/rows so the byte
stream's baked line-wrapping lines up; input rides `ClientMsg::PaneInput`, **gated by the input-grant
(view-only) flag** (`auth_ok.inputGranted` + the `InputGrantChanged` broadcast).

## Wire-contract discipline (read before touching the protocol)

- **Additive is safe — no coordinated PR.** New *optional fields* on an existing frame, or a new
  *store_state domain / JSON field*, do **not** bump `PROTOCOL_VERSION` — an older mobile ignores unknown
  fields, and the `store_state` JSON is opaque to the frame.
- **A new (or removed) `ServerMsg`/`ClientMsg` variant is a protocol change** — coordinate a PR in
  **mobile-studio-code** (a separate repo). Don't ship a *breaking* one one-sided.
- **Fixtures are byte-exact cross-repo contracts:** `src/features/tunnel/lib/tunnelProtocol.fixtures.json`
  (the wire *frames*) + `src/features/planner/session/plannerCore.fixtures.json`. The Rust tests resolve
  the frame fixtures **by filename** (`find_fixture` in `mobile/tunnel/mod.rs` — exactly one match under
  `src/`), so a fixture **rename** must update the Rust call + mobile in lockstep. Don't casually edit
  fixture bytes.
- **Per-domain PAYLOAD parity harness (#3762 / Mobile-Studio-Code#246).** Because `store_state.json` is
  opaque, per-domain shape drift crosses the wire unguarded (the glance `status`→`health`/`activity` split
  + the security invented-shape both shipped green). `src/features/tunnel/lib/storeProjections.fixtures.ts`
  exports `PROJECTION_INPUTS` — canonical inputs, each block `satisfies` its real model (a rename in
  `ProjectLite`/`AgentProfile`/`AuditDisplayRow`/`ConsoleSession` is a compile error here).
  `storePayloads.fixtures.json` is
  **generated** from the real `build*Payload`s over those inputs (byte-identical with mobile) — regenerate
  with `npm run fixtures:store`; the write is `UPDATE_STORE_FIXTURES`-gated so CI can't self-heal. Adding a
  domain ⇒ add its builder + a `PROJECTION_INPUTS` entry + regenerate. `plan` has no builder (planner-
  published) → `UNPROJECTED_DOMAINS` exemption (#3760).
- **Graph-parity rule (the #3743 trap):** when a `build<Domain>Payload` feeds a graph core mobile
  **re-runs vendored** (e.g. Glance's `buildGlanceData(projects, links, kitUsage, kits, libraryRefs)` — 5
  inputs), the payload **must carry every input that core takes**, or mobile silently loses a whole band.
  Audit any new graph dimension the same way. (`org` sends the full `Team` incl. positions + relationships;
  `blueprints` sends the active team graph — both complete.)

## Current state & open follow-ups

**Complete:** pairing/Noise, pane mirroring + input-grant, all 11 store_state domains projected +
replayed (each builder unit-tested + guarded by the `storePayloads.fixtures.json` parity harness, #3762),
the alert inbox + FCM, plan-sync. No known payload parity gaps (glance's kit + algorithm/sound bands were
the last, fixed by #3743).

**Open — the #2497 bespoke-frame retirement.** The bespoke frames split ways:

| Bespoke frame | Status | Retirement |
|---|---|---|
| `FleetRoster` · `McpList` · `AutomationRan` | **Dead senders REMOVED (#3749)** — the desktop no longer pushes them (migrated to the `glance.fleets` / `mcp` / `alerts` domains); their `tunnel_set_*` commands + `TunnelState` fields + replay are gone. The `ServerMsg` variants are **kept** (constructor-less, `pub` in `bsc-tunnel`) for mobile back-compat. | **Wire-type drop** — remove the variants once mobile stops decoding them → **needs a mobile-studio-code PR.** |
| `CoordEvent` | **Live** — `tunnel_emit_coord_event` still fires (the warden quarantine FCM push, `useWarden.ts`; agent-paused/asking pushes). NOT dead. | Keeps (or fold into the `alerts` domain later). |
| `AutomationList` | **Live dual-send** — still pushed alongside the `automations` domain (`useTunnelAutomations`). | Retire once mobile reads the `automations` domain → **needs a mobile-studio-code PR.** |
| `HookTelemetry` | **Live, correct** — no store_state twin (telemetry is deliberately out — "mobile is state + alerts, not dashboards"). | Keeps. |
| `SessionState` · `PaneList` | Live — the console **mirror**, not part of this migration. | Keeps. |

**Open — oversized-domain fragmentation (#3757).** A store_state domain over the Noise 65535-byte cap
(today: `components`) is skipped, not mirrored (#3756). Part 2 fragments it across `store_state_chunk`
frames that mobile reassembles — a coordinated base-studio-code + mobile-studio-code PR.

## Working on this subsystem

- **Frontend gate** (`src/` changed): `npm run typecheck` · `npm run lint` (0 errors) · `npm test`.
- **Rust gate** (`crates/bsc-tunnel/` changed): `cargo clippy -p bsc-tunnel --all-targets -- -D warnings`.
  The desktop glue in `src-tauri/src/mobile/tunnel/` lives in the heavy `base-studio-code` Tauri crate —
  prefer scoping to `bsc-tunnel` and reasoning about the thin glue over building the full app.
- The **pure seams** — the payload builders (`storeProjections.ts`) and the protocol types (`protocol.rs`)
  — are where new shapes get tested, from plain fixtures.
