import { useCallback, useEffect, useState } from "react";
import { usePoll } from "@/shared/hooks/usePoll";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "@/store";
import { pairingPayload, type TunnelStatus } from "./lib/tunnel";
import {
  tunnelStart,
  tunnelStop,
  tunnelStatus,
  tunnelSetInputGranted,
  tunnelUnpair,
} from "./lib/tunnelClient";
import {
  runRelayProbe,
  emptyLegs,
  freshRoomId,
  type ProbeLegs,
  type ProbeLeg,
  type MinimalSocket,
} from "./lib/relayProbe";

// `relayHealthUrl` now lives with the probe orchestration; re-exported here so existing
// importers (and tests) keep resolving it from this module.
export { relayHealthUrl } from "./lib/relayProbe";

// A "Deploy to Cloudflare" link prefilled with the relay workspace, so a user can
// stand up their own zero-knowledge relay in their own account (BYO).
const DEPLOY_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/kevinthelago/base-studio-code/tree/main/relay";

/**
 * Deep-link to the user's Cloudflare dashboard for their relay. Cloudflare resolves the `:account`
 * placeholder to whoever's logged in, so we never need their account id (which the app can't know).
 * When the relay is a `*.workers.dev` URL we extract the worker NAME (the first host label) and link
 * straight to that Worker; otherwise (custom domain, or no URL yet) we fall back to the Workers &
 * Pages list.
 */
export function cloudflareDashUrl(relayUrl: string): string {
  const base = "https://dash.cloudflare.com/?to=/:account";
  const trimmed = relayUrl.trim().replace(/^wss?:\/\//i, "https://");
  let host = "";
  try {
    host = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
  } catch { /* unparseable / empty → fall through to the generic Workers list */ }
  // `<worker>.<account-subdomain>.workers.dev` → the first label is the Worker's name.
  const m = host.match(/^([a-z0-9][a-z0-9-]*)\.[a-z0-9-]+\.workers\.dev$/i);
  return m ? `${base}/workers/services/view/${m[1]}/production` : `${base}/workers-and-pages`;
}

/** Per-leg deadline for the relay probe before that leg is called a failure. */
const TEST_TIMEOUT_MS = 6000;

type RelayTest =
  | { state: "idle" }
  | { state: "running"; legs: ProbeLegs; version?: string }
  | { state: "done"; legs: ProbeLegs; version?: string };

const LEG_LABELS: Array<{ key: keyof ProbeLegs; label: string }> = [
  { key: "reach", label: "Reachable" },
  { key: "join", label: "Room join" },
  { key: "relay", label: "Relay handshake" },
];

/** Glyph + color for a single probe leg's status. */
function legGlyph(status: ProbeLeg["status"]): { glyph: string; color: string } {
  switch (status) {
    case "ok": return { glyph: "✓", color: "var(--success, #2ea043)" };
    case "fail": return { glyph: "✗", color: "var(--danger)" };
    case "running": return { glyph: "◌", color: "var(--fg-muted)" };
    case "skip": return { glyph: "–", color: "var(--fg-muted)" };
    default: return { glyph: "·", color: "var(--fg-muted)" };
  }
}

export function TunnelSettings() {
  const tunnelRelayUrl = useAppStore((s) => s.tunnelRelayUrl);
  const setTunnelRelayUrl = useAppStore((s) => s.setTunnelRelayUrl);
  const setTunnelRunning = useAppStore((s) => s.setTunnelRunning);

  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Result of the "Test relay" probe (a /health round-trip), shown inline under the URL.
  const [test, setTest] = useState<RelayTest>({ state: "idle" });
  // Set when a view-only phone tries to send input, so the grant control is highlighted
  // until the desktop responds (#B-wan-viewonly). Cleared once input is granted/revoked.
  const [inputRequested, setInputRequested] = useState(false);

  // Mirror the Rust client's running state into the store so ConsoleScreen knows
  // whether to push live pane metadata.
  const sync = useCallback((s: TunnelStatus) => {
    setStatus(s);
    setTunnelRunning(s.running);
  }, [setTunnelRunning]);

  useEffect(() => {
    tunnelStatus().then(sync).catch((e) => setErr(String(e)));
  }, [sync]);

  // While connected, poll so the client count / pairing updates without interaction.
  // `sync` is stable (useCallback over the stable store setter), so this re-runs only
  // when the running state flips.
  const running = status?.running ?? false;
  usePoll(() => {
    if (!running) return;
    tunnelStatus().then(sync).catch(() => { /* transient; keep last */ });
  }, 2000, [running, sync], { immediate: false });

  // A view-only phone that tries to type fires this once; surface it so the desktop can
  // decide to grant input. The badge clears as soon as the desktop grants or revokes.
  useEffect(() => {
    if (!running) return;
    const unlisten = listen("tunnel://input-requested", () => setInputRequested(true));
    return () => { unlisten.then((off) => off()); };
  }, [running]);

  const onToggleInput = useCallback(async () => {
    const next = !(status?.inputGranted ?? false);
    setBusy(true);
    setErr(null);
    try {
      sync(await tunnelSetInputGranted(next));
      setInputRequested(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [status, sync]);

  const onUnpair = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      sync(await tunnelUnpair());
      setInputRequested(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [sync]);

  // Probe the relay across three distinct legs — reachability, room-join, and an
  // end-to-end relayed frame — so a failure points at WHICH layer is broken rather than a
  // single opaque pass/fail. Each leg updates inline as it resolves (via onLeg).
  const onTest = useCallback(async () => {
    const target = tunnelRelayUrl.trim();
    if (!target) return;
    setTest({ state: "running", legs: emptyLegs() });
    const result = await runRelayProbe(target, {
      fetchFn: fetch,
      // The browser WebSocket's strict DOM event types are wider than the minimal surface
      // the probe uses (onopen/onmessage/send/close); adapt it through the interface.
      makeSocket: (url) => new WebSocket(url) as unknown as MinimalSocket,
      timeoutMs: TEST_TIMEOUT_MS,
      genId: freshRoomId,
      onLeg: (legs) =>
        setTest((prev) => (prev.state === "running" ? { ...prev, legs } : prev)),
    });
    setTest({ state: "done", legs: result.legs, version: result.version });
  }, [tunnelRelayUrl]);

  const onConnect = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      sync(running ? await tunnelStop() : await tunnelStart(tunnelRelayUrl.trim()));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, [running, tunnelRelayUrl, sync]);

  const payload = status ? pairingPayload(status) : null;
  const qrValue = payload ? JSON.stringify(payload) : "";
  const clients = status?.clientCount ?? 0;
  const inputGranted = status?.inputGranted ?? false;
  const paired = clients > 0;
  const canConnect = tunnelRelayUrl.trim().length > 0;

  return (
    <div style={{ maxWidth: 820 }}>
      <h2 style={{ fontFamily: "var(--mono)", fontSize: 18, margin: "0 0 4px", fontWeight: 600 }}>Mobile tunnel</h2>
      <p style={{ color: "var(--fg-muted)", margin: "0 0 22px", fontSize: 12, lineHeight: 1.6 }}>
        Pair <code>mobile-studio-code</code> to mirror these consoles from your phone — from
        anywhere. Traffic flows through a <b>zero-knowledge relay</b> you deploy into your own
        Cloudflare account; it's end-to-end encrypted (Noise), so the relay never sees your
        terminal.
      </p>

      <div className="card">
        <div style={{ display: "flex", alignItems: "center", marginBottom: 14, gap: 12 }}>
          <h3 style={{ margin: 0 }}>Relay connection</h3>
          <span className={"tag " + (running ? "green" : "")}>
            {running ? (clients > 0 ? `● paired · ${clients} device${clients === 1 ? "" : "s"}` : "● waiting for a device") : "○ disconnected"}
          </span>
          <span style={{ flex: 1 }} />
          <button className="btn" disabled={busy || (!running && !canConnect)} onClick={onConnect}>
            {running ? "disconnect" : busy ? "connecting…" : "connect"}
          </button>
        </div>

        {err && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--danger)",
            background: "var(--bg-elev)", border: "1px solid var(--border-soft)",
            borderRadius: 6, padding: "8px 10px", marginBottom: 14,
          }}>{err}</div>
        )}

        <div className="field" style={{ marginBottom: running && payload ? 18 : 0 }}>
          <label>Relay URL</label>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              className="input"
              placeholder="https://msc-tunnel-relay.<you>.workers.dev"
              value={tunnelRelayUrl}
              disabled={running}
              onChange={(e) => {
                setTunnelRelayUrl(e.target.value);
                setTest({ state: "idle" }); // a fresh URL invalidates the last probe
              }}
            />
            <button
              className="btn"
              disabled={busy || running || test.state === "running" || !canConnect}
              onClick={onTest}
            >
              {test.state === "running" ? "testing…" : "test"}
            </button>
            <button className="btn" onClick={() => openUrl(DEPLOY_URL)}>
              deploy a relay →
            </button>
            <button
              className="btn"
              title="Open this relay's Worker in your Cloudflare dashboard"
              onClick={() => openUrl(cloudflareDashUrl(tunnelRelayUrl))}
            >
              manage in Cloudflare ↗
            </button>
          </div>
          {test.state === "idle" ? (
            <div className="hint">
              Your own Cloudflare Worker (free tier is enough). Deploy once, paste the URL it prints.
            </div>
          ) : (
            <div
              className="hint"
              style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 8 }}
              role="status"
              aria-live="polite"
            >
              {LEG_LABELS.map(({ key, label }) => {
                const leg = test.legs[key];
                const { glyph, color } = legGlyph(leg.status);
                return (
                  <div key={key} style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span style={{ color, fontFamily: "var(--mono)", width: 12, textAlign: "center" }}>{glyph}</span>
                    <span style={{ color: leg.status === "fail" ? "var(--danger)" : "var(--fg)", minWidth: 110 }}>{label}</span>
                    {leg.detail && <span style={{ color: "var(--fg-muted)" }}>{leg.detail}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {running && payload ? (
          <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: 20, alignItems: "start" }}>
            {/* QR — rendered on white for reliable scanning regardless of theme. */}
            <div style={{
              background: "#ffffff", padding: 12, borderRadius: 10,
              display: "flex", flexDirection: "column", alignItems: "center", gap: 8,
            }}>
              <QRCodeSVG value={qrValue} size={184} bgColor="#ffffff" fgColor="#000000" level="M" />
              <div style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "#666", letterSpacing: ".04em" }}>
                SCAN IN MOBILE-STUDIO-CODE
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 0 }}>
              <div className="field">
                <label>Room</label>
                <input className="input" readOnly value={status?.room ?? ""} style={{ fontSize: 11 }} />
                <div className="hint">A fresh, high-entropy room is allocated each time you connect.</div>
              </div>
              <div className="field">
                <label>Host key (Noise)</label>
                <input className="input" readOnly value={status?.hostPubKey ?? ""} style={{ fontSize: 10.5 }} />
                <div className="hint">
                  The phone pins this from the QR — it's how it knows it's talking to <i>your</i>
                  desktop, not the relay.
                </div>
              </div>
              <div className="field">
                <label>Input control</label>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span className={"tag " + (inputGranted ? "green" : "")}>
                    {inputGranted ? "● input granted" : "○ view-only"}
                  </span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn"
                    disabled={busy || !paired}
                    onClick={onToggleInput}
                    style={inputRequested && !inputGranted
                      ? { borderColor: "var(--accent)", color: "var(--accent)" }
                      : undefined}
                  >
                    {inputGranted ? "revoke input" : "grant input"}
                  </button>
                </div>
                <div className="hint">
                  {!paired
                    ? "A paired phone starts view-only — it mirrors these panes but cannot type."
                    : inputRequested && !inputGranted
                      ? "The paired phone is asking to send input. Grant it to let the phone drive a pane."
                      : inputGranted
                        ? "The paired phone can drive panes. Revoke to return it to view-only."
                        : "The phone is view-only — keystrokes are dropped until you grant input."}
                </div>
              </div>
              {paired && (
                <div className="field">
                  <label>Paired device</label>
                  <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                    <span style={{ flex: 1 }} />
                    <button className="btn" disabled={busy} onClick={onUnpair}>
                      unpair device
                    </button>
                  </div>
                  <div className="hint">
                    Drops the connected phone, rotates the room + pairing secret (the old QR
                    stops working), and shows a fresh QR to pair again.
                  </div>
                </div>
              )}
              <div className="hint" style={{ fontFamily: "var(--mono)", fontSize: 10.5 }}>
                The pairing secret is carried inside the QR only — never shown or logged.
              </div>
            </div>
          </div>
        ) : (
          <div className="hint" style={{ padding: "8px 0 0" }}>
            {running
              ? "Connecting to the relay…"
              : "Connect to allocate a room and generate a pairing QR."}
          </div>
        )}
      </div>
    </div>
  );
}
