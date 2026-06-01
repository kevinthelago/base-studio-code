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

/** Pane status as the mobile client models it (`PaneStatus`). */
export type PaneStatus = "running" | "idle" | "awaiting_input" | "error";

/** One mirrored pane in the list the mobile client renders (`pane_list`). */
export interface PaneDescriptor {
  id: string;
  cwd: string;
  name: string;
  status: PaneStatus;
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
  raw: "run" | "on" | "idle" | undefined,
  awaiting: boolean,
): PaneStatus {
  if (raw === "run") return "running";
  if (awaiting) return "awaiting_input";
  return "idle";
}

export interface PanePayloadInput {
  tabs: { layout: string }[];
  paneNames: Record<number, Record<number, string>>;
  paneCwds: Record<string, string>;
  paneStatuses: Record<string, "run" | "on" | "idle">;
  disabledPanes: Record<string, boolean>;
  /** paneIds (`t{t}p{p}`) currently awaiting user input (from the focus queue). */
  awaiting: ReadonlySet<string>;
  /** ISO timestamp stamped onto every session (injected for deterministic tests). */
  nowIso: string;
}

/** Pure transform: store pane state → the `{ panes, sessions }` the tunnel pushes
 *  down. Disabled panes (PTY killed) are omitted entirely. */
export function buildPanePayload(
  input: PanePayloadInput,
): { panes: PaneDescriptor[]; sessions: SessionMeta[] } {
  const panes: PaneDescriptor[] = [];
  const sessions: SessionMeta[] = [];

  input.tabs.forEach((tab, tabIdx) => {
    const count = paneCountForLayout(tab.layout);
    for (let paneIdx = 0; paneIdx < count; paneIdx++) {
      const id = `t${tabIdx}p${paneIdx}`;
      if (input.disabledPanes[id]) continue;
      const name = input.paneNames[tabIdx]?.[paneIdx] ?? `console-${tabIdx + 1}-${paneIdx + 1}`;
      const cwd = input.paneCwds[id] ?? "";
      const status = mapStatus(input.paneStatuses[id], input.awaiting.has(id));
      panes.push({ id, cwd, name, status });
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

  return { panes, sessions };
}
