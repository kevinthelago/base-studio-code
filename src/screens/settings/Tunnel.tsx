import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { QRCodeSVG } from "qrcode.react";
import { useAppStore } from "../../store";
import { pairingPayload, type TunnelStatus } from "../../lib/tunnel/tunnel";
import {
  tunnelStart,
  tunnelStop,
  tunnelStatus,
  tunnelSetInputGranted,
  tunnelUnpair,
} from "../../lib/tunnel/tunnelClient";

// A "Deploy to Cloudflare" link prefilled with the relay workspace, so a user can
// stand up their own zero-knowledge relay in their own account (BYO).
const DEPLOY_URL =
  "https://deploy.workers.cloudflare.com/?url=https://github.com/kevinthelago/base-studio-code/tree/main/relay";

/**
 * Map a user-entered relay URL (any of `http(s)://` / `ws(s)://`, with or without a
 * scheme or trailing slash) to its `https` `/health` probe endpoint. The relay serves
 * `/health` over plain HTTPS GET (the `wss://` form is only for the tunnel upgrade), so
 * the Test button normalizes to `https` before probing.
 */
export function relayHealthUrl(relayUrl: string): string {
  const trimmed = relayUrl.trim().replace(/\/+$/, "");
  const normalized = trimmed
    .replace(/^wss:\/\//i, "https://")
    .replace(/^ws:\/\//i, "http://");
  const withScheme = /^https?:\/\//i.test(normalized) ? normalized : `https://${normalized}`;
  return `${withScheme}/health`;
}

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

/** How long to wait for the relay's `/health` before calling the Test a failure. */
const TEST_TIMEOUT_MS = 6000;

type RelayTest =
  | { state: "idle" }
  | { state: "testing" }
  | { state: "ok"; version?: string }
  | { state: "fail"; detail: string };

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
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      tunnelStatus().then(sync).catch(() => { /* transient; keep last */ });
    }, 2000);
    return () => clearInterval(id);
  }, [running, sync]);

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

  // Probe the relay's /health to confirm it's reachable and is actually a tunnel relay,
  // before the user relies on it for pairing. A real round-trip (GET → JSON), bounded by
  // a timeout; failures surface the reason rather than silently doing nothing.
  const onTest = useCallback(async () => {
    const target = tunnelRelayUrl.trim();
    if (!target) return;
    setTest({ state: "testing" });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TEST_TIMEOUT_MS);
    try {
      const res = await fetch(relayHealthUrl(target), { signal: ctrl.signal });
      if (!res.ok) {
        setTest({ state: "fail", detail: `relay returned HTTP ${res.status}` });
        return;
      }
      const body = (await res.json().catch(() => null)) as
        | { service?: string; version?: string }
        | null;
      if (body?.service !== "msc-tunnel-relay") {
        setTest({ state: "fail", detail: "reachable, but not a tunnel relay" });
        return;
      }
      setTest({ state: "ok", version: body.version });
    } catch (e) {
      const aborted = e instanceof DOMException && e.name === "AbortError";
      setTest({ state: "fail", detail: aborted ? "timed out" : "could not reach relay" });
    } finally {
      clearTimeout(timer);
    }
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
              disabled={busy || running || test.state === "testing" || !canConnect}
              onClick={onTest}
            >
              {test.state === "testing" ? "testing…" : "test"}
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
          <div className="hint">
            {test.state === "ok" ? (
              <span style={{ color: "var(--success, #2ea043)" }}>
                ✓ relay reachable{test.version ? ` · v${test.version}` : ""}
              </span>
            ) : test.state === "fail" ? (
              <span style={{ color: "var(--danger)" }}>✗ {test.detail}</span>
            ) : (
              "Your own Cloudflare Worker (free tier is enough). Deploy once, paste the URL it prints."
            )}
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
