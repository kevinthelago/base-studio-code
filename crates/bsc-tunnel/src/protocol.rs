//! Tunnel wire protocol (#1300) — the serde DTOs the desktop mirrors to mobile-studio-code.
//! Conforms to the shipped mobile client (`mobile-studio-code/src/lib/types.ts`); the shared
//! `tunnelProtocol.fixtures.json` (resolved by name under `src/` via the test's `find_fixture`,
//! so the frontend reorg can move it freely) pins the exact byte shape (drift fails CI).

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

// ── Wire protocol ───────────────────────────────────────────────────────────────
// Conforms to the shipped mobile client (mobile-studio-code/src/lib/types.ts). The
// shared tunnelProtocol.fixtures.json (resolved by name via find_fixture) pins the exact
// byte shape; `shared_fixture_matches_serde` (below) fails CI on any drift (#46).

/// Tunnel wire-contract version (#2497). Carried by the mobile client in its `auth` frame
/// (`protocolVersion`, optional — a pre-v2 client omits it) and echoed by the desktop in
/// `auth_ok`, so each side knows exactly which contract the peer speaks.
///
/// **Mismatch policy: accept, but surface.** A version mismatch never rejects the session —
/// the desktop logs both versions and still replies `auth_ok` (carrying ITS version), so the
/// client can warn the user that some frames may be missing/ignored. Unknown inbound frame
/// types are already tolerated on both sides, which is what makes this policy safe.
///
/// v1 (implicit — no version on the wire) → v2: adds `store_state`, `auth.protocolVersion` /
/// `auth_ok.protocolVersion`, the optional `PaneDescriptor.kind`, and pins the plan_sync
/// frames to the Rust shapes.
///
/// Post-v2 additive changes ride WITHIN v2 (no bump — both sides ignore unknown fields /
/// frame types, so an optional-field or new-frame addition breaks neither peer):
/// `auth_ok.inputGranted` + the `input_grant_changed` frame (#2511).
pub const PROTOCOL_VERSION: u32 = 2;

/// The registered `store_state` domain vocabulary (#2497). The frame itself is fully
/// domain-agnostic (any string routes), so adding a domain is data, not a protocol change —
/// these constants only name the projections the desktop currently publishes so both repos
/// spell them identically.
pub mod store_domains {
    /// Glance graph model + links + faults.
    pub const GLANCE: &str = "glance";
    /// Plan projections (plan.db-derived).
    pub const PLAN: &str = "plan";
    /// Org graph (positions + relationships), incl. the team.
    pub const ORG: &str = "org";
    /// Blueprint library.
    pub const BLUEPRINTS: &str = "blueprints";
    /// Skills library + lessons.
    pub const SKILLS: &str = "skills";
    /// Component kits.
    pub const COMPONENTS: &str = "components";
    /// Kit themes.
    pub const THEMES: &str = "themes";
    /// Automations + hooks.
    pub const AUTOMATIONS: &str = "automations";
    /// MCP servers.
    pub const MCP: &str = "mcp";
    /// Alerts / notifications feed.
    pub const ALERTS: &str = "alerts";
    /// Least-privilege security picture: agent profiles + per-pane assignments + audit (#2530).
    pub const SECURITY: &str = "security";

    /// Every registered domain.
    pub const ALL: [&str; 11] = [
        GLANCE, PLAN, ORG, BLUEPRINTS, SKILLS, COMPONENTS, THEMES, AUTOMATIONS, MCP, ALERTS, SECURITY,
    ];
}

/// One mirrored pane as the mobile client lists it. Mirrors mobile `PaneDescriptor`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PaneDescriptor {
    pub id: String,
    pub cwd: String,
    pub name: String,
    /// One of `running | idle | awaiting_input | error` (mobile `PaneStatus`).
    pub status: String,
    /// What kind of session this pane is (#2497): `console | worker | planner | triage` plus one per
    /// app-owned studio — `designer | architect | librarian | soundDesigner | integrator` (#4023). The
    /// fleet director rides as `worker`.
    ///
    /// Deliberately an OPEN string, not an enum: the desktop grows a studio far more often than the
    /// protocol version turns, so a new kind must never be a breaking wire change. **Optional for
    /// backward compatibility** — a pre-v2 desktop omits it and a pre-v2 mobile ignores it; an absent
    /// OR UNRECOGNISED kind ⇒ treat as `console`, which is what lets an older mobile render a studio it
    /// has never heard of. Omitted from the wire when `None` so v1 fixtures stay byte-stable.
    ///
    /// (The list above is documentation, not validation — nothing parses against it. Keep it current
    /// with `PaneKind` in `src/features/tunnel/lib/tunnel.ts`; it had already drifted behind three
    /// studios before #4023.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// A pushed session-state snapshot from the frontend (camelCase on the wire).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub pane_id: String,
    pub status: String,
    pub current_task: String,
    /// ISO-8601 timestamp string (produced by the frontend).
    pub last_activity: String,
    /// Populated when `status == "awaiting_input"`.
    pub prompt: Option<String>,
}

/// One plan file in the canonical planner-sync representation.
/// Mirrors TS `CanonicalFile` in src/lib/plannerCore/types.ts.
/// Pinned wire shape in src/lib/plannerCore.fixtures.json (wireFrames.plan_sync_files).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanFile {
    pub relpath: String,
    pub content: String,
}

/// One chat turn in the live planning session projected to the phone (#934/#987).
/// Mirrors TS `PlanMessage` in src/lib/tunnel/tunnel.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanMessage {
    pub role: String,
    pub text: String,
    pub at: u64,
}

/// A pipeline run's live state projected to the phone (#220/#987). Mirrors TS
/// `PlanPipelineRun` in src/lib/tunnel/tunnel.ts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlanPipelineRun {
    pub id: String,
    pub stage: String,
    pub status: String,
}

// ── F2/A2/M2 wire payload types ────────────────────────────────────────────────

/// One agent session in the fleet roster (F2). Mobile renders a "who's running / blocked
/// / waiting" view. status ∈ "running"|"blocked"|"waiting"|"asking"|"idle".
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FleetSession {
    pub session: String,
    pub status: String,
    /// Ref keys this session is blocked on (non-empty when `status == "blocked"`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub blocked_on: Vec<String>,
    pub wait_reason: Option<String>,
    pub question: Option<String>,
    /// ms-epoch timestamp of the last status change.
    pub at: u64,
}

/// A read-only automation descriptor pushed to mobile (A2). Mobile shows the list and
/// can arm/disarm or trigger via `automation_arm` / `automation_run_now` inbound frames.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AutomationFrame {
    pub id: String,
    pub name: String,
    pub armed: bool,
    /// Human-readable schedule: "Every day at 09:00" or the raw cron expression.
    pub when_expr: String,
    pub last_run_at: Option<u64>,
    pub next_run_at: Option<u64>,
    /// "ok" | "fail" | "skipped" for the most recent run.
    pub last_status: Option<String>,
}

/// A read-only MCP server / hook descriptor pushed to mobile (M2). Read-only — mobile
/// can see but not modify extensions.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpExtFrame {
    pub id: String,
    /// "mcp" | "hook"
    pub kind: String,
    pub name: String,
    pub enabled: bool,
    /// "stdio" | "http" for MCP servers; None for hooks.
    pub transport: Option<String>,
    pub url: Option<String>,
}

// ── Hook telemetry (M3, #937) ────────────────────────────────────────────────────
// A read-only projection of the desktop's aggregated hook-fire analytics. The desktop
// parses + aggregates `~/.base-studio-code/hooks.log` frontend-side (aggregateHookTelemetry
// in src/features/mcp/lib/hookTelemetry.ts) and pushes the summary; mobile only displays it.
// There is NO inbound control frame — mobile can see the counts but cannot influence hooks.

/// One day's allow/block counts in the hook-telemetry projection. Mirrors TS `DayBucket`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HookDayBucket {
    /// Local `YYYY-MM-DD`.
    pub day: String,
    /// PreToolUse allows + non-gating fires ("allow" / "ok") that day.
    pub allows: u32,
    /// PreToolUse denials ("block") that day.
    pub blocks: u32,
}

/// Fires per hook in the projection. Mirrors TS `HookCount`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct HookCountFrame {
    pub hook: String,
    /// The event the hook fires on: `PreToolUse` | `PostToolUse` | `Stop` | …
    pub event: String,
    pub fires: u32,
}

/// Read-only aggregated hook-fire telemetry pushed to mobile (M3). Mirrors the TS
/// `HookAnalytics` shape (src/features/mcp/lib/hookTelemetry.ts): totals + the allow-rate,
/// the per-day allow/block series, and the per-hook fire counts. Read-only on mobile.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HookTelemetryFrame {
    /// Total fires in the window.
    pub total: u32,
    /// PreToolUse fires denied (`outcome == "block"`).
    pub blocks: u32,
    /// PreToolUse fires allowed (`outcome == "allow"`).
    pub allows: u32,
    /// `allows / (allows + blocks)`, 0–100; 100 when there were no PreToolUse decisions.
    pub allow_rate: u32,
    /// Per-day allow vs block counts, oldest→newest (stable window length).
    pub daily: Vec<HookDayBucket>,
    /// Fires per hook, descending.
    pub per_hook: Vec<HookCountFrame>,
}

/// Messages the desktop sends to the mobile client. Tagged by snake_case `type`.
/// `AuthOk` / `PaneOutput` are emitted by the relay transport (#242b); the rest are
/// emitted now by the metadata-push commands.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ServerMsg {
    /// Auth accepted. Echoes the desktop's [`PROTOCOL_VERSION`] (#2497) so the client can
    /// compare against its own and warn on a mismatch (the desktop never rejects on version —
    /// see the `PROTOCOL_VERSION` mismatch policy).
    #[serde(rename_all = "camelCase")]
    AuthOk {
        protocol_version: u32,
        /// Whether the desktop currently grants the paired phone input control (#2511 —
        /// the connect-time snapshot of the #B-wan-viewonly gate, so the phone can render
        /// its view-only state honestly instead of typing into silently-dropped frames).
        /// ALWAYS serialized: this is the current revision of the frame, and an older
        /// mobile ignores unknown fields. Only the mobile side treats it as optional (a
        /// pre-#2511 desktop omits it ⇒ grant unknown). An ADDITIVE optional-field change,
        /// so [`PROTOCOL_VERSION`] stays 2 — no version bump.
        input_granted: bool,
    },
    /// The desktop granted or revoked the paired phone's input control mid-session
    /// (#2511). Broadcast on every live toggle of the #B-wan-viewonly gate. NO replay
    /// entry on connect — `auth_ok.inputGranted` already carries the connect-time state,
    /// and the gate only changes through the broadcasting setter, so a replay frame would
    /// be pure duplication. Additive within v2 (an older mobile ignores unknown frames).
    InputGrantChanged {
        granted: bool,
    },
    PaneList {
        panes: Vec<PaneDescriptor>,
    },
    /// Generic store projection (#2497): the last-written state of one desktop store
    /// `domain` (see [`store_domains`]) as an opaque JSON string, with a monotonically
    /// increasing per-domain `rev` so the client can drop stale/out-of-order frames.
    /// Replayed on connect (last frame per domain) and broadcast on every change.
    ///
    /// MIGRATION POSTURE (#2497): this frame is the successor of the bespoke
    /// `fleet_roster` / `automation_list` / `mcp_list` / `hook_telemetry` pushes. Those
    /// stay on the wire, unchanged, for now — `store_state` ships ALONGSIDE them; retiring
    /// the bespoke frames is a follow-up once mobile consumes the store_state domains.
    StoreState {
        domain: String,
        rev: u64,
        json: String,
    },
    /// One fragment of an over-cap [`StoreState`] whose serialized JSON exceeds the Noise
    /// transport's per-message plaintext cap (~64 KB). The send side splits the domain's `json`
    /// on UTF-8 boundaries into `total` chunks (`seq` `0..total`) that each fit, and mobile buffers
    /// them keyed by `(domain, rev)` — once all `total` arrive it concatenates the `chunk`s into the
    /// full `json` and applies it exactly as a [`StoreState`]. A newer `rev` seen mid-reassembly
    /// drops the stale partial, so a lost/late chunk can't wedge the reassembler. Additive within v2
    /// (an older mobile ignores the unknown `type`): `store_state` is the only realistically over-cap
    /// frame — `pane_output` already chunks and every other frame is small. #3757.
    StoreStateChunk {
        domain: String,
        rev: u64,
        seq: u32,
        total: u32,
        chunk: String,
    },
    #[serde(rename_all = "camelCase")]
    PaneOutput {
        pane_id: String,
        data: String,
        coarse: bool,
    },
    /// The PTY grid size a pane's output is rendered for. Mobile sets its terminal to
    /// these cols/rows so the byte stream's baked line-wrapping + cursor positioning
    /// line up (otherwise a phone-width terminal garbles desktop-width output). Sent on
    /// pairing replay and whenever the desktop PTY resizes.
    #[serde(rename_all = "camelCase")]
    PaneSize {
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    #[serde(rename_all = "camelCase")]
    SessionState {
        pane_id: String,
        status: String,
        current_task: String,
        last_activity: String,
        prompt: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    UserRequest {
        pane_id: String,
        prompt: String,
    },
    // ── Planner sync (#588 / PT2) ────────────────────────────────────────────
    /// Desktop pushes its plan manifest (relpath → hex hash) to mobile.
    /// Also sent proactively on connect so mobile can start reconciling immediately.
    #[serde(rename_all = "camelCase")]
    PlanSyncManifest {
        project_id: String,
        /// relpath → lowercase 8-char hex FNV-1a 32-bit content hash.
        files: HashMap<String, String>,
    },
    /// Desktop sends requested plan files to mobile (response to PlanSyncPull).
    #[serde(rename_all = "camelCase")]
    PlanSyncFiles {
        project_id: String,
        files: Vec<PlanFile>,
    },
    /// Desktop acknowledges a plan push from mobile.
    #[serde(rename_all = "camelCase")]
    PlanSyncAck {
        project_id: String,
        applied: bool,
    },
    // ── Fleet / coordination (F2) ────────────────────────────────────────────
    /// Full fleet roster snapshot — all agent sessions and their states. Replayed on
    /// connect and re-pushed whenever the fleet state changes.
    FleetRoster {
        sessions: Vec<FleetSession>,
    },
    /// A single coordination event. Mobile shows a live activity feed.
    /// kind ∈ "blocked"|"satisfied"|"woken"|"waiting"|"asking"|"failed"
    #[serde(rename_all = "camelCase")]
    CoordEvent {
        kind: String,
        /// The pane id involved (None for global events).
        session: Option<String>,
        /// The ref key for blocked/satisfied events.
        ref_key: Option<String>,
        /// ms-epoch timestamp.
        at: u64,
    },
    // ── Automations (A2) ────────────────────────────────────────────────────
    /// Full automation list — replayed on connect and re-pushed on any change.
    AutomationList {
        automations: Vec<AutomationFrame>,
    },
    /// Notification that an automation fired (Ok/skipped/fail).
    #[serde(rename_all = "camelCase")]
    AutomationRan {
        id: String,
        at: u64,
        /// "ok" | "skipped" | "fail"
        status: String,
        note: String,
    },
    /// Notification that an automation failed (non-transient). Triggers an FCM push (A4)
    /// so the user is notified even when the mobile app is backgrounded.
    #[serde(rename_all = "camelCase")]
    AutomationFailed {
        id: String,
        at: u64,
        error: String,
    },
    // ── MCP extensions (M2) ─────────────────────────────────────────────────
    /// Full list of enabled MCP servers and hooks. Read-only on mobile. Replayed on connect
    /// and re-pushed whenever the Extensions store changes.
    McpList {
        extensions: Vec<McpExtFrame>,
    },
    // ── Hook telemetry (M3 / #937) ──────────────────────────────────────────
    /// Read-only aggregated hook-fire telemetry. Replayed on connect (last push) and
    /// re-pushed whenever the desktop refreshes the analytics. Read-only on mobile —
    /// there is no inbound counterpart.
    HookTelemetry {
        telemetry: HookTelemetryFrame,
    },
    // ── Live planning session (PT1 / #934 / #986) ───────────────────────────
    /// Full live planner snapshot. Replayed on connect (the last per-projectId payload), so a
    /// freshly-paired phone mirrors the session immediately. Distinct from `plan_sync_*`.
    #[serde(rename_all = "camelCase")]
    PlanState {
        project_id: String,
        current_stage: String,
        confirmed_sections: Vec<String>,
        files: Vec<PlanFile>,
        messages: Vec<PlanMessage>,
        pipeline_runs: Vec<PlanPipelineRun>,
    },
    /// A transient planning delta. Fire-and-forget — NOT replayed.
    #[serde(rename_all = "camelCase")]
    PlanEvent {
        project_id: String,
        kind: String,
        at: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        section: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        stage: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<PlanMessage>,
        #[serde(skip_serializing_if = "Option::is_none")]
        run: Option<PlanPipelineRun>,
    },
    /// Cheap header update (active stage + status). Replayed on connect.
    #[serde(rename_all = "camelCase")]
    PlanStatus {
        project_id: String,
        current_stage: String,
        status: String,
    },
}

/// Messages the mobile client sends to the desktop. Tagged by snake_case `type`.
/// (Consumed by the relay transport in #242b; retained here as the shared contract.)
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(dead_code)]
pub enum ClientMsg {
    #[serde(rename_all = "camelCase")]
    Auth {
        token: String,
        #[serde(default)]
        fcm_token: Option<String>,
        /// The client's tunnel contract version (#2497) — see [`PROTOCOL_VERSION`].
        /// Optional: a pre-v2 client omits it (`None` ⇒ treat as v1). The desktop accepts
        /// any version and echoes its own in `auth_ok`; a mismatch is logged, never fatal.
        #[serde(default)]
        protocol_version: Option<u32>,
    },
    /// Mobile pushes a refreshed FCM registration token mid-session (#846). The initial
    /// token rides in `Auth.fcmToken`; FCM tokens rotate, so the client re-sends here and
    /// the desktop updates its push target. Allowed even while view-only (it's not a
    /// PTY-mutating frame).
    #[serde(rename_all = "camelCase")]
    SetFcmToken { fcm_token: String },
    #[serde(rename_all = "camelCase")]
    PaneSetState { pane_id: String, state: String },
    #[serde(rename_all = "camelCase")]
    PaneFocus { pane_id: String },
    #[serde(rename_all = "camelCase")]
    PaneInput { pane_id: String, data: String },
    #[serde(rename_all = "camelCase")]
    PaneResize { pane_id: String, cols: u16, rows: u16 },
    // ── Planner sync (#588) ──────────────────────────────────────────────────
    /// Mobile requests the desktop's current plan manifest for a project.
    #[serde(rename_all = "camelCase")]
    PlanSyncManifestRequest { project_id: String },
    /// Mobile requests specific files from the desktop's plan.
    #[serde(rename_all = "camelCase")]
    PlanSyncPull {
        project_id: String,
        /// Relpaths of the files to retrieve.
        paths: Vec<String>,
    },
    /// Mobile pushes its merged plan state to the desktop (desktop is not the merge
    /// authority in v1 — it applies the push and acks; no conflict frames returned).
    #[serde(rename_all = "camelCase")]
    PlanSyncPush {
        project_id: String,
        files: Vec<PlanFile>,
    },
    // ── Fleet / coordination (F2) ────────────────────────────────────────────
    /// Mobile requests that a blocked/paused agent be woken (dep-blocked waiter).
    #[serde(rename_all = "camelCase")]
    CoordWake { session: String },
    /// Mobile approves a checkpoint/confirm-paused agent (waiting-for-user waiter).
    #[serde(rename_all = "camelCase")]
    CoordApprove { session: String },
    // ── Automations (A2) ────────────────────────────────────────────────────
    /// Mobile arms or disarms an automation (toggle the armed flag).
    #[serde(rename_all = "camelCase")]
    AutomationArm { id: String, armed: bool },
    /// Mobile triggers an automation to run immediately.
    #[serde(rename_all = "camelCase")]
    AutomationRunNow { id: String },
    // ── Live planning session — drive (PT1 / #934) ──────────────────────────
    /// Mobile advances (or jumps) the planner to a stage.
    #[serde(rename_all = "camelCase")]
    PlanAdvance { project_id: String, stage_key: String },
    /// Mobile confirms a plan section.
    #[serde(rename_all = "camelCase")]
    PlanConfirm { project_id: String, section: String },
    /// Mobile sends a chat message into the live planner session.
    #[serde(rename_all = "camelCase")]
    PlanChat { project_id: String, text: String },
}

/// One PTY output chunk fanned out to the relay transport (which filters per pane).
/// The fields are read by that transport (#242b). Internal bus type only — distinct from
/// the `ServerMsg::PaneOutput` wire variant (the mobile contract); this name must NOT leak
/// to the wire, hence the `Chunk` suffix to avoid colliding with that variant.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub struct PaneOutputChunk {
    pub pane_id: String,
    pub data: String,
}

/// Relay-shaped status for the "Mobile tunnel" settings card. Unlike the LAN design,
/// trust comes from Noise (the QR carries `hostPubKey`), not a pinned cert.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunnelStatus {
    pub running: bool,
    /// The relay Worker URL this desktop dials (set once a transport connects, #242b).
    pub relay_url: Option<String>,
    /// The room id allocated for the current pairing (#242b).
    pub room: Option<String>,
    /// base64 of the desktop's static Noise public key — goes into the pairing QR.
    pub host_pub_key: String,
    /// The pairing secret the mobile echoes in its `auth` frame — goes into the QR.
    /// Empty until `tunnel_start` mints it. Carried only inside the QR, never shown.
    pub psk: String,
    pub client_count: usize,
    /// Whether the desktop has granted the paired phone input control. A freshly paired
    /// phone is **view-only** (`false`): keystrokes/resizes are dropped until the desktop
    /// flips this with `tunnel_set_input_granted` (#B-wan-viewonly).
    pub input_granted: bool,
}
