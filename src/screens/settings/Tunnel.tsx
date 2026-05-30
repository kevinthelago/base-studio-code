import { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "../../store";
import { pairingPayload, type TunnelStatus } from "../../lib/tunnel";
import { tunnelStart, tunnelStop, tunnelStatus } from "../../lib/tunnelClient";

// A "Deploy to Cloudflare" link prefilled with the relay workspace, so a user can
// stand up their own zero-knowledge relay in their own account (BYO).
const DEPLOY_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/kevinthelago/base-studio-code/tree/main/relay";

export function TunnelSettings() {
  const tunnelRelayUrl = useAppStore((s) => s.tunnelRelayUrl);
  const setTunnelRelayUrl = useAppStore((s) => s.setTunnelRelayUrl);
  const setTunnelRunning = useAppStore((s) => s.setTunnelRunning);

  const [status, setStatus] = useState<TunnelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      tunnelStatus().then(sync).catch(() => { /* transient; keep last */ });
    }, 2000);
    return () => clearInterval(id);
  }, [running, sync]);

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
              onChange={(e) => setTunnelRelayUrl(e.target.value)}
            />
            <button className="btn" onClick={() => window.open(DEPLOY_URL, "_blank")}>
              deploy a relay →
            </button>
          </div>
          <div className="hint">
            Your own Cloudflare Worker (free tier is enough). Deploy once, paste the URL it prints.
          </div>
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
