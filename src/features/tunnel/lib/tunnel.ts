// Mobile tunnel — transport-agnostic protocol contract (#240, foundation of #210).
//
// The desktop owns the PTYs but not the pane *metadata* (names/cwds/statuses live in
// the Zustand store), so the frontend maps store state into the wire shapes the mobile
// client renders. This module is the pure contract + transforms; it has NO transport
// (the relay client lands in #242) and NO Tauri imports, so it's unit-testable.
//
// The wire schema is owned by the mobile client (`mobile-studio-code/src/lib/types.ts`)
// and carried unchanged inside the relay's Noise-encrypted envelope — the relay never
// sees these frames in plaintext. See `docs/tunnel-protocol.md`; the machine-readable
// contract is `tunnelProtocol.fixtures.json` (asserted in `src/__tests__/tunnel.test.ts`).

// The desktop's canonical per-pane status (#435), the input this module maps FROM.
import type { PaneStatus as DesktopPaneStatus } from "@/app/console/lib/paneStatus";
// Pane IDENTITY (#1176): the pane-id grammar + minting, a pure (React/Tauri-free) shell
// module. The roster keys panes by the SAME identity id the PTY/status/cwd are keyed by,
// so mobile's pane_input/pane_output target real PTY ids (#2497).
import { paneIdFor, parsePaneIdentity, isPlanningPaneId } from "@/app/console/lib/paneIdentity";
import type { CanonicalFile } from "@/features/planner";

/** The tunnel wire-contract version (#2497). Mirrors `bsc_tunnel::protocol::PROTOCOL_VERSION`
 *  (Rust owns the handshake; this constant exists TS-side for display/diagnostics only). */
export const TUNNEL_PROTOCOL_VERSION = 2;

/** Pane status as the mobile client models it (`PaneStatus`) — a distinct wire
 *  vocabulary the desktop's `DesktopPaneStatus` is mapped into by `mapStatus`. */
export type PaneStatus = "running" | "idle" | "awaiting_input" | "error";

/** What kind of session a mirrored pane is (#2497). The wire vocabulary is fixed —
 *  the fleet DIRECTOR rides as `worker` (a fleet session) and manual/positional console
 *  panes are `console`. Optional on the wire for backward compatibility (absent ⇒ console). */
// `soundDesigner` added #3369 (epic #3071 phase 4). ADDITIVE — no existing value changes meaning, so an
// older mobile build simply sees a kind it does not label rather than mis-labelling a session. Still a
// tunnel-contract change: mobile-studio-code should add the matching label in a follow-up.
export type PaneKind = "console" | "worker" | "planner" | "designer" | "architect" | "librarian" | "soundDesigner" | "integrator" | "triage";

/** One mirrored pane in the list the mobile client renders (`pane_list`). */
export interface PaneDescriptor {
  id: string;
  cwd: string;
  name: string;
  status: PaneStatus;
  /** Session kind (#2497); optional so a v1 peer's descriptor still parses. */
  kind?: PaneKind;
}

/** A per-pane session-state snapshot pushed to connected clients (`session_state`).
 *  Field names are camelCase on the wire to match the mobile client. */
export interface SessionMeta {
  paneId: string;
  status: PaneStatus;
  currentTask: string;
  lastActivity: string;
  prompt: string | null;
}

/** Live relay-tunnel status from the Rust client (relay-shaped — trust is via Noise,
 *  not a pinned cert). Mirrors `tunnel::TunnelStatus`. */
export interface TunnelStatus {
  running: boolean;
  /** The relay Worker URL this desktop dials (set once the transport connects). */
  relayUrl: string | null;
  /** The room id allocated for the current pairing. */
  room: string | null;
  /** base64 of the desktop's static Noise public key (mobile pins it via the QR). */
  hostPubKey: string;
  /** The pairing secret the mobile echoes to authenticate (carried only in the QR). */
  psk: string;
  clientCount: number;
  /** Whether the desktop has granted the paired phone input control. A freshly paired
   *  phone is view-only (`false`) until the desktop grants input (#B-wan-viewonly). */
  inputGranted: boolean;
}

/** The payload encoded into the pairing QR. The mobile dials `relayUrl`, joins `room`,
 *  authenticates the desktop by `hostPubKey` (Noise IK), and echoes `psk` to pair. */
export interface PairingPayload {
  relayUrl: string;
  room: string;
  hostPubKey: string;
  psk: string;
}

/** Build the QR/manual-entry payload from a status, or `null` if not yet pairable —
 *  the relay must be connected and a room + keys present. Pure (no transport). */
export function pairingPayload(s: TunnelStatus): PairingPayload | null {
  if (!s.running || !s.relayUrl || !s.room || !s.hostPubKey || !s.psk) return null;
  return { relayUrl: s.relayUrl, room: s.room, hostPubKey: s.hostPubKey, psk: s.psk };
}

// ── Planner-session frames (#934 / #985 / #986 / #987) ──────────────────────────
//
// The LIVE planning session projected to a paired phone, distinct from the async
// `plan_sync_*` file-reconciliation path (which stays as-is). The desktop is the single
// source of truth: it emits `plan_state` (full snapshot, replayed on connect), `plan_event`
// (transient deltas, fire-and-forget), and `plan_status` (cheap header, replayed); the phone
// mirrors them read-only and DRIVES via the inbound `plan_advance` / `plan_confirm` /
// `plan_chat` frames. Wire shapes are pinned in tunnelProtocol.fixtures.json and mirrored in
// mobile-studio-code; field names are camelCase, the `type` tag is snake_case.

/** One chat turn in the planning session, as the phone renders it. */
export interface PlanMessage {
  role: "user" | "assistant";
  text: string;
  /** Epoch ms. */
  at: number;
}

/** A pipeline run's live state (#220), projected to the phone. */
export interface PlanPipelineRun {
  id: string;
  stage: string;
  status: string;
}

/** Full live planning-session snapshot (server → phone). Replayed to a freshly-paired
 *  client, so it must stand alone. `files` is the canonical section set (via hubToCanonical). */
export interface PlanStateFrame {
  type: "plan_state";
  projectId: string;
  currentStage: string;
  confirmedSections: string[];
  files: CanonicalFile[];
  messages: PlanMessage[];
  pipelineRuns: PlanPipelineRun[];
}

export type PlanEventKind = "section_confirmed" | "stage_advanced" | "message_appended" | "pipeline_run";

/** A transient planning delta (server → phone). Fire-and-forget — NOT replayed (a late
 *  client gets the full picture from the replayed plan_state instead). The detail fields are
 *  populated per `kind`. */
export interface PlanEventFrame {
  type: "plan_event";
  projectId: string;
  kind: PlanEventKind;
  /** Epoch ms. */
  at: number;
  /** kind === "section_confirmed". */
  section?: string;
  /** kind === "stage_advanced". */
  stage?: string;
  /** kind === "message_appended". */
  message?: PlanMessage;
  /** kind === "pipeline_run". */
  run?: PlanPipelineRun;
}

/** Cheap header update (server → phone): the active stage + a short plan-status label.
 *  Replayed on connect. */
export interface PlanStatusFrame {
  type: "plan_status";
  projectId: string;
  currentStage: string;
  status: string;
}

/** Phone → desktop: advance to (or jump to) a stage. */
export interface PlanAdvanceFrame {
  type: "plan_advance";
  projectId: string;
  stageKey: string;
}

/** Phone → desktop: confirm a plan section. */
export interface PlanConfirmFrame {
  type: "plan_confirm";
  projectId: string;
  section: string;
}

/** Phone → desktop: send a chat message into the live planner session. */
export interface PlanChatFrame {
  type: "plan_chat";
  projectId: string;
  text: string;
}

// ── Store → wire mapping (pure) ─────────────────────────────────────────────────

/** Number of panes in a tab from its `"cols×rows"` layout string. */
export function paneCountForLayout(layout: string): number {
  const [cols, rows] = layout.split("×").map((n) => parseInt(n, 10));
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return 0;
  return cols * rows;
}

/** Map the desktop's per-pane status (`run|on|idle`) plus the awaiting-input set
 *  to the mobile `PaneStatus` vocabulary. A running pane stays `running` even if
 *  it is (also) flagged awaiting; otherwise an awaiting pane is `awaiting_input`. */
export function mapStatus(
  raw: DesktopPaneStatus | undefined,
  awaiting: boolean,
): PaneStatus {
  if (raw === "run") return "running";
  if (awaiting) return "awaiting_input";
  return "idle";
}

/** The tab fields the roster needs — the identity subset of the store's `Tab` (#1176):
 *  `paneIds` (minted fleet/triage identity ids), `kind` (app-created tab), `id` (manual tab). */
export interface RosterTab {
  layout: string;
  id?: string;
  kind?: "build" | "triage";
  paneIds?: string[];
}

/**
 * Session kind for a pane identity id (#2497) — maps the self-describing id grammar
 * (#1266) into the wire's fixed `kind` vocabulary. The fleet director rides as `worker`
 * (it's a fleet session; the wire vocabulary has no separate director slot); manual and
 * legacy positional console panes are `console`; the dedicated planner pane
 * (`planning_<key>`) is `planner`.
 */
export function paneKindFor(id: string): PaneKind {
  if (isPlanningPaneId(id)) return "planner";
  const parsed = parsePaneIdentity(id);
  switch (parsed?.kind) {
    case "worker":
    case "director":
      return "worker";
    case "triage":
      return "triage";
    default:
      return "console";
  }
}

export interface PanePayloadInput {
  tabs: RosterTab[];
  paneNames: Record<number, Record<number, string>>;
  paneCwds: Record<string, string>;
  paneStatuses: Record<string, DesktopPaneStatus>;
  disabledPanes: Record<string, boolean>;
  /** Identity pane ids currently awaiting user input (from the focus queue). */
  awaiting: ReadonlySet<string>;
  /** ISO timestamp stamped onto every session (injected for deterministic tests). */
  nowIso: string;
  /** Ad-hoc panes outside the Console tab grid (the planner's `planning_<key>` pane, the
   *  designer session, …), so they mirror over the relay too (#801/#2497). A disabled
   *  extra pane is omitted. An extra pane without an explicit `kind` gets one derived
   *  from its id grammar. */
  extraPanes?: PaneDescriptor[];
}

/** Pure transform: store pane state → the `{ panes, sessions }` the tunnel pushes down.
 *  Panes are keyed by their IDENTITY id (`paneIdFor`, #1176/#2497) — the same id the PTY,
 *  status, and cwd are keyed by — so mobile's `pane_input`/`pane_output` target real PTY
 *  ids for manual (`man:…`) and fleet (`<key>:<stream>`) panes, not just legacy positional
 *  tabs. Disabled panes (PTY killed) are omitted entirely. */
export function buildPanePayload(
  input: PanePayloadInput,
): { panes: PaneDescriptor[]; sessions: SessionMeta[] } {
  const panes: PaneDescriptor[] = [];
  const sessions: SessionMeta[] = [];

  input.tabs.forEach((tab, tabIdx) => {
    const count = paneCountForLayout(tab.layout);
    for (let paneIdx = 0; paneIdx < count; paneIdx++) {
      const id = paneIdFor(tab, tabIdx, paneIdx);
      if (input.disabledPanes[id]) continue;
      const name = input.paneNames[tabIdx]?.[paneIdx] ?? `console-${tabIdx + 1}-${paneIdx + 1}`;
      const cwd = input.paneCwds[id] ?? "";
      const status = mapStatus(input.paneStatuses[id], input.awaiting.has(id));
      panes.push({ id, cwd, name, status, kind: paneKindFor(id) });
      sessions.push({
        paneId: id,
        status,
        currentTask: name,
        lastActivity: input.nowIso,
        // The real prompt text isn't tracked desktop-side; mobile shows the
        // awaiting-input state without it. (user_request only fires with a prompt.)
        prompt: null,
      });
    }
  });

  for (const p of input.extraPanes ?? []) {
    if (input.disabledPanes[p.id]) continue;
    panes.push({ ...p, kind: p.kind ?? paneKindFor(p.id) });
    sessions.push({
      paneId: p.id,
      status: p.status,
      currentTask: p.name,
      lastActivity: input.nowIso,
      prompt: null,
    });
  }

  return { panes, sessions };
}
